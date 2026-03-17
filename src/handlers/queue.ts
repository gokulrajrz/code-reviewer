import type { Env, ReviewMessage } from '../types/env';
import { MAX_DIFF_CHARS } from '../config/constants';
import {
    fetchPRDiff,
    fetchChangedFiles,
    buildReviewContext,
    postPRComment,
    setCommitStatus,
} from '../lib/github';
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
        const { prNumber, title, diffUrl, repoFullName, headSha } = message.body;

        console.log(
            `[queue] Processing PR #${prNumber}: "${title}" (${repoFullName}) at commit ${headSha}`
        );

        try {
            // 1. Fetch PR diff
            const diff = await fetchPRDiff(diffUrl, env.GITHUB_TOKEN);

            // 2. Fetch list of changed files for richer context
            const changedFiles = await fetchChangedFiles(repoFullName, prNumber, env.GITHUB_TOKEN);

            console.log(
                `[queue] Fetched diff (${diff.length} chars) and ${changedFiles.length} changed files`
            );

            // 3. Build assembled context (diff + full file contents)
            const reviewContext = await buildReviewContext(diff, changedFiles, env.GITHUB_TOKEN, MAX_DIFF_CHARS);

            // 4. Call the configured LLM (this can safely take > 30 seconds now!)
            console.log(`[queue] Calling LLM (${env.AI_PROVIDER ?? 'claude'})...`);
            const review = await callLLM(reviewContext, title, env);

            console.log(`[queue] Review generated (${review.length} chars), posting to PR...`);

            // 5. Post the review as a PR comment
            await postPRComment(repoFullName, prNumber, review, env.GITHUB_TOKEN);

            // 6. Determine status check success/failure using the LLM's required output format
            // The prompt mandates: "Overall verdict: **Approve** / **Request Changes** / **Needs Discussion**"
            const hasRequestedChanges = review.includes('**Request Changes**') || review.includes('Request Changes');
            const state = hasRequestedChanges ? 'failure' : 'success';
            const description = hasRequestedChanges ? 'AI Code Review: Changes requested' : 'AI Code Review: Approved';

            await setCommitStatus(
                repoFullName,
                headSha,
                state,
                description,
                env.GITHUB_TOKEN
            );

            console.log(`[queue] ✅ Review posted to PR #${prNumber} and status set to ${state}`);

            // 7. Explicitly acknowledge the message so it isn't retried
            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Pipeline failed for PR #${prNumber}: ${errMsg}`);

            try {
                await postPRComment(
                    repoFullName,
                    prNumber,
                    `> ⚠️ **Code Reviewer Agent Error**\n> The automated background review failed: \`${errMsg}\`\n> You can trigger another review by closing and reopening this PR.`,
                    env.GITHUB_TOKEN
                );

                // Update commit status to error
                await setCommitStatus(
                    repoFullName,
                    headSha,
                    'error',
                    'AI Code Review failed due to an error',
                    env.GITHUB_TOKEN
                );
            } catch {
                console.error('[queue] Could not post error comment or set status on PR');
            }

            // We explicitly DO NOT ack() the message here if we want it to retry,
            // but since we posted an error comment, we should end the cycle so we don't spam the PR
            // with repeated error comments on implicit retry.
            message.ack();
        }
    }
}
