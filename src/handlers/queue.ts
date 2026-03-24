import type { Env, ReviewMessage } from '../types/env';
import { executeWorkflow } from '../graph/workflow';
import { getInstallationToken } from '../lib/github-auth';
import { postPRComment, updateCheckRun } from '../lib/github';

/**
 * Background Queue Consumer Handler (Multi-Agent Pipeline).
 *
 * This function processes messages from Cloudflare Queues.
 * It is not bound by the 30-second webhook CPU limit. On the free tier,
 * a queue consumer can run for up to 15 minutes.
 *
 * It orchestrates the full multi-agent review pipeline:
 *   IngestContext → [Security | Performance | CleanCode] → Aggregate → Gate → Publish
 */
export async function queueHandler(
    batch: MessageBatch<ReviewMessage>,
    env: Env,
    _ctx: ExecutionContext
): Promise<void> {
    for (const message of batch.messages) {
        const { prNumber, title, repoFullName, headSha, checkRunId, isOverride } = message.body;

        console.log(
            `[queue] Processing PR #${prNumber}: "${title}" (${repoFullName}) at commit ${headSha}`
        );

        try {
            // ── Execute the Multi-Agent Workflow ──
            const { state } = await executeWorkflow({
                prNumber,
                prTitle: title,
                repoFullName,
                headSha,
                checkRunId,
                isOverride,
                env,
            });

            // ── Get a fresh token for posting results ──
            let token: string;
            try {
                token = await getInstallationToken(env);
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[queue] ❌ Auth failed — cannot get installation token: ${errMsg}`);
                message.ack();
                return;
            }

            // ── Handle Human-in-the-Loop Gate ──
            if (state.reviewStatus === 'needs_human_review') {
                console.log(`[queue] 🚨 Critical findings — posting blocked comment`);

                const blockedComment =
                    `> 🚨 **Critical Security Issue Detected**\n` +
                    `> The AI Code Reviewer has identified **Critical** severity findings.\n` +
                    `> This review is **halted** pending manual approval.\n\n` +
                    `A maintainer must comment \`/override-ai\` to publish the full review, ` +
                    `or \`/dismiss-ai\` to reject it.\n\n` +
                    `---\n\n` +
                    `<details>\n<summary>🔍 Preview of Critical Findings</summary>\n\n` +
                    state.aggregatedFindings
                        .filter((f) => f.severity === 'Critical')
                        .map((f) => `- **\`${f.file}\`**: ${f.issue}`)
                        .join('\n') +
                    `\n\n</details>`;

                try {
                    await postPRComment(repoFullName, prNumber, blockedComment, token);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] ⚠️ Failed to post blocked comment: ${errMsg}`);
                }

                // Update Check Run to action_required
                if (checkRunId) {
                    try {
                        await updateCheckRun(repoFullName, checkRunId, token, 'action_required',
                            '## 🚨 Critical Findings — Human Review Required\n\n' +
                            'The AI review pipeline detected Critical severity issues. ' +
                            'A maintainer must comment `/override-ai` to proceed.');
                    } catch (error) {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        console.error(`[queue] ⚠️ Failed to update Check Run: ${errMsg}`);
                    }
                }
            } else {
                // ── Auto-Publish: Post the full review ──
                console.log(`[queue] Publishing review to PR #${prNumber}...`);

                try {
                    await postPRComment(repoFullName, prNumber, state.finalMarkdown, token);
                    console.log(`[queue] ✓ Review comment posted to PR #${prNumber}`);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] ⚠️ Failed to post review comment: ${errMsg}`);
                }

                // ── Determine conclusion and update Check Run ──
                const hasRequestedChanges = state.aggregatedFindings.some(
                    (f) => f.severity === 'High' || f.severity === 'Critical'
                );
                const conclusion = hasRequestedChanges ? 'failure' : 'success';

                if (checkRunId) {
                    try {
                        await updateCheckRun(repoFullName, checkRunId, token, conclusion, state.finalMarkdown);
                        console.log(`[queue] ✓ Check run #${checkRunId} updated → ${conclusion}`);
                    } catch (error) {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        console.error(`[queue] ⚠️ Failed to update Check Run: ${errMsg}`);
                    }
                }
            }

            console.log(`[queue] ✅ Pipeline complete for PR #${prNumber} (status: ${state.reviewStatus})`);
            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Pipeline failed for PR #${prNumber}: ${errMsg}`);

            // Attempt to post error comment
            try {
                const token = await getInstallationToken(env);
                await postPRComment(
                    repoFullName,
                    prNumber,
                    `> ⚠️ **Code Reviewer Agent Error**\n` +
                    `> The multi-agent review pipeline failed unexpectedly.\n\n` +
                    `**Error:** \`${errMsg}\`\n\n` +
                    `> You can trigger another review by closing and reopening this PR.`,
                    token
                );

                if (checkRunId) {
                    await updateCheckRun(
                        repoFullName,
                        checkRunId,
                        token,
                        'failure',
                        `## ❌ Review Pipeline Error\n\n**Error:** \`${errMsg}\`\n\n` +
                        `You can trigger another review by closing and reopening this PR.`
                    );
                }
            } catch {
                console.error('[queue] ⚠️ Could not post error comment to PR');
            }

            message.ack();
        }
    }
}
