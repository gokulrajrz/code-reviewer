import type { Env, ReviewMessage } from '../types/env';
import { MAX_DIFF_CHARS } from '../config/constants';
import {
    fetchPRDiff,
    fetchChangedFiles,
    buildReviewContext,
    postPRComment,
    updateCheckRun,
} from '../lib/github';
import { getInstallationToken } from '../lib/github-auth';
import { callLLM } from '../lib/llm/index';

/**
 * Background Queue Consumer Handler.
 * This function processes messages from Cloudflare Queues.
 * It is not bound by the 30-second webhook CPU limit. On the free tier,
 * a queue consumer can run for up to 15 minutes!
 */
export async function queueHandler(
    batch: MessageBatch<ReviewMessage>,
    env: Env,
    ctx: ExecutionContext
): Promise<void> {
    for (const message of batch.messages) {
        const { prNumber, title, diffUrl, repoFullName, headSha, checkRunId } = message.body;

        console.log(
            `[queue] Processing PR #${prNumber}: "${title}" (${repoFullName}) at commit ${headSha}`
        );

        // Get a fresh installation token for this queue run
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Failed to get installation token: ${errMsg}`);
            message.ack(); // Don't retry if auth fails
            return;
        }

        try {
            // 1. Fetch PR diff
            const diff = await fetchPRDiff(diffUrl, token);

            // 2. Fetch list of changed files for richer context
            const changedFiles = await fetchChangedFiles(repoFullName, prNumber, token);

            console.log(
                `[queue] Fetched diff (${diff.length} chars) and ${changedFiles.length} changed files`
            );

            // 3. Build assembled context (diff + full file contents)
            const reviewContext = await buildReviewContext(diff, changedFiles, token, MAX_DIFF_CHARS);

            // 4. Call the configured LLM (this can safely take > 30 seconds now!)
            console.log(`[queue] Calling LLM (${env.AI_PROVIDER ?? 'claude'})...`);
            const review = await callLLM(reviewContext, title, env);

            console.log(`[queue] Review generated (${review.length} chars), posting to PR...`);

            // 5. Post the review as a PR comment
            await postPRComment(repoFullName, prNumber, review, token);

            // 6. Determine Check Run conclusion based on the LLM's verdict
            const hasRequestedChanges = review.includes('**Request Changes**') || review.includes('Request Changes');
            const conclusion = hasRequestedChanges ? 'failure' : 'success';

            // 7. Update the Check Run with the final conclusion and review summary
            await updateCheckRun(
                repoFullName,
                checkRunId,
                token,
                conclusion,
                review
            );

            console.log(`[queue] ✅ Review posted to PR #${prNumber} and check run set to ${conclusion}`);

            // 8. Explicitly acknowledge the message so it isn't retried
            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Pipeline failed for PR #${prNumber}: ${errMsg}`);

            try {
                await postPRComment(
                    repoFullName,
                    prNumber,
                    `> ⚠️ **Code Reviewer Agent Error**\n> The automated background review failed: \`${errMsg}\`\n> You can trigger another review by closing and reopening this PR.`,
                    token
                );

                // Update the Check Run to failure with the error message
                await updateCheckRun(
                    repoFullName,
                    checkRunId,
                    token,
                    'failure',
                    `## ❌ Review Pipeline Error\n\nThe automated review failed with the following error:\n\n\`\`\`\n${errMsg}\n\`\`\`\n\nYou can trigger another review by closing and reopening this PR.`
                );
            } catch {
                console.error('[queue] Could not post error comment or update check run on PR');
            }

            // Ack to prevent spamming the PR with repeated error comments
            message.ack();
        }
    }
}
