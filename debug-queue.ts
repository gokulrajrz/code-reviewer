import { executeWorkflow } from './src/graph/workflow';
import { postPRComment, createCheckRun } from './src/lib/github';
import { getInstallationToken } from './src/lib/github-auth';
import * as fs from 'fs';

async function main() {
    const devVars = fs.readFileSync('.dev.vars', 'utf-8');
    const getVar = (key: string) => devVars.match(new RegExp(`^${key}=["']?([^"'\n\r]+)["']?`, 'm'))?.[1] || process.env[key] || '';

    const env = {
        GITHUB_WEBHOOK_SECRET: getVar('GITHUB_WEBHOOK_SECRET'),
        GITHUB_APP_ID: getVar('GITHUB_APP_ID'),
        GITHUB_APP_PRIVATE_KEY: devVars.match(/GITHUB_APP_PRIVATE_KEY="([\s\S]+?)"/)?.[1]?.replace(/\\n/g, '\n') || '',
        GITHUB_APP_INSTALLATION_ID: getVar('GITHUB_APP_INSTALLATION_ID'),
        GEMINI_API_KEY: getVar('GEMINI_API_KEY'),
        ANTHROPIC_API_KEY: '',
        AI_PROVIDER: 'gemini',
        ALLOWED_TARGET_BRANCHES: 'dev',
        REVIEW_QUEUE: {} as any
    };

    console.log("Starting local queue debug...");

    try {
        const { state } = await executeWorkflow({
            prNumber: 5,
            prTitle: "test",
            repoFullName: "Rareminds-eym/embedding-worker",
            headSha: "834b018e2fbf859ff7585906625dcaebdb843bed",
            checkRunId: 0,
            isOverride: false,
            env: env as any
        });

        console.log("Workflow completed! Getting token...");
        const token = await getInstallationToken(env as any);

        console.log("Posting comment...");
        await postPRComment(state.repoFullName, state.prNumber, state.finalMarkdown, token);
        console.log("Comment posted successfully!");

    } catch (error) {
        console.error("FATAL ERROR:", error);
    }
}

main().catch(console.error);
