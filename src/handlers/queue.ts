import type { Env, ReviewMessage } from '../types/env';
import { MAX_CHUNK_CHARS, MAX_LLM_CHUNKS } from '../config/constants';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    postPRComment,
    updateCheckRun,
} from '../lib/github';
import { getInstallationToken } from '../lib/github-auth';
import { callLLM } from '../lib/llm/index';

/** Maximum time (ms) to wait for a single LLM call before aborting. */
const LLM_TIMEOUT_MS = 120_000;

/**
 * Wraps an LLM call with a timeout guard.
 * If the LLM doesn't respond within `timeoutMs`, the promise rejects.
 */
async function callLLMWithTimeout(
    context: string,
    title: string,
    env: Env,
    timeoutMs: number
): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const result = await Promise.race([
            callLLM(context, title, env, controller.signal),
            new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () =>
                    reject(new Error(`LLM call timed out after ${timeoutMs / 1000}s`))
                );
            }),
        ]);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Background Queue Consumer Handler.
 * This function processes messages from Cloudflare Queues.
 * It is not bound by the 30-second webhook CPU limit. On the free tier,
 * a queue consumer can run for up to 15 minutes!
 */
export async function queueHandler(
    batch: MessageBatch<ReviewMessage>,
    env: Env,
    _ctx: ExecutionContext
): Promise<void> {
    for (const message of batch.messages) {
        const { prNumber, title, diffUrl, repoFullName, headSha, checkRunId } = message.body;

        console.log(
            `[queue] Processing PR #${prNumber}: "${title}" (${repoFullName}) at commit ${headSha}`
        );

        // ── Step 1: Get a fresh installation token ──
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Auth failed — cannot get installation token: ${errMsg}`);
            message.ack();
            return;
        }

        try {
            // ── Step 2: Fetch ALL changed files (paginated) ──
            console.log(`[queue] Fetching changed files for PR #${prNumber}...`);
            const allFiles = await fetchChangedFiles(repoFullName, prNumber, token);
            console.log(`[queue] ✓ Fetched ${allFiles.length} changed files (after pagination)`);

            if (allFiles.length === 0) {
                console.log(`[queue] ⚠️ No changed files found for PR #${prNumber}, skipping review`);
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        '## No Files to Review\n\nThis PR has no reviewable file changes.');
                }
                message.ack();
                return;
            }

            // ── Step 3: Classify files into tiers ──
            const classified = classifyFiles(allFiles);
            console.log(
                `[queue] ✓ Classified: ${classified.tier1.length} tier1 (full), ` +
                `${classified.tier2.length} tier2 (diff-only), ` +
                `${classified.skipped.length} skipped (noise)`
            );

            if (classified.tier1.length === 0 && classified.tier2.length === 0) {
                console.log(`[queue] ⚠️ All ${allFiles.length} files were classified as noise, skipping review`);
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        `## No Reviewable Files\n\nAll ${allFiles.length} files in this PR are auto-generated, vendor, or noise files.\n\n` +
                        `Skipped: ${classified.skipped.slice(0, 20).join(', ')}${classified.skipped.length > 20 ? '...' : ''}`);
                }
                message.ack();
                return;
            }

            // ── Step 4: Build size-limited chunks ──
            console.log(`[queue] Building review chunks (max ${MAX_CHUNK_CHARS} chars each)...`);
            let chunks = await buildReviewChunks(classified, token, MAX_CHUNK_CHARS);
            console.log(`[queue] ✓ Generated ${chunks.length} chunk(s) for review`);

            // Apply Hard Cap to prevent 50-subrequest limit exhaustion
            if (chunks.length > MAX_LLM_CHUNKS) {
                console.log(`[queue] ⚠️ Truncating chunks to ${MAX_LLM_CHUNKS} to prevent subrequest limit errors`);
                chunks = chunks.slice(0, MAX_LLM_CHUNKS);
                chunks[chunks.length - 1] += `\n\n> ⚠️ **Notice:** This Pull Request is extremely large. The AI review has been truncated to ${MAX_LLM_CHUNKS} parts to prevent execution limits from terminating the workflow. Consider breaking this PR into smaller, more focused pieces.`;
            }

            // ── Step 5: Process each chunk sequentially with per-chunk error recovery ──
            const reviews: string[] = [];
            let failedChunks = 0;

            for (let i = 0; i < chunks.length; i++) {
                const chunkContext = chunks[i];
                const chunkLabel = chunks.length > 1 ? `(Part ${i + 1}/${chunks.length})` : '';
                const chunkTitle = chunks.length > 1 ? `${title} ${chunkLabel}` : title;

                console.log(`[queue] Calling LLM for chunk ${i + 1}/${chunks.length} (${chunkContext.length} chars)...`);

                try {
                    const chunkReview = await callLLMWithTimeout(chunkContext, chunkTitle, env, LLM_TIMEOUT_MS);
                    console.log(`[queue] ✓ Chunk ${i + 1}/${chunks.length} review received (${chunkReview.length} chars)`);
                    reviews.push(chunkReview);
                } catch (error) {
                    failedChunks++;
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] ⚠️ Chunk ${i + 1}/${chunks.length} failed: ${errMsg}`);
                    reviews.push(
                        `## ⚠️ Review Part ${i + 1} Failed\n\n` +
                        `The LLM was unable to review this section of the PR.\n\n` +
                        `**Error:** \`${errMsg}\`\n\n` +
                        `**Files in this chunk:**\n${chunkContext.slice(0, 500)}...\n`
                    );
                }
            }

            // ── Step 6: Aggregate the reviews ──
            let finalReview: string;
            if (reviews.length === 0) {
                finalReview = '## ❌ Review Failed\n\nAll review chunks failed. Please re-trigger the review by closing and reopening this PR.';
            } else if (chunks.length > 1) {
                finalReview = `> ℹ️ **Notice:** This PR was reviewed in **${chunks.length} parts** ` +
                    `(${classified.tier1.length} files with full context, ${classified.tier2.length} diff-only` +
                    `${failedChunks > 0 ? `, ${failedChunks} chunk(s) failed` : ''}).\n\n` +
                    reviews.join('\n\n---\n\n');
            } else {
                finalReview = reviews[0];
            }

            console.log(`[queue] ✓ Review aggregation complete (${finalReview.length} chars), posting to PR...`);

            // ── Step 7: Post review comment to PR ──
            try {
                await postPRComment(repoFullName, prNumber, finalReview, token);
                console.log(`[queue] ✓ Review comment posted to PR #${prNumber}`);
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[queue] ⚠️ Failed to post review comment: ${errMsg}`);
            }

            // ── Step 8: Determine conclusion and update Check Run ──
            const allChunksFailed = failedChunks === chunks.length;
            const hasRequestedChanges = finalReview.includes('**Request Changes**') || finalReview.includes('Request Changes');
            const conclusion = allChunksFailed ? 'failure' : hasRequestedChanges ? 'failure' : 'success';

            if (checkRunId) {
                try {
                    await updateCheckRun(repoFullName, checkRunId, token, conclusion, finalReview);
                    console.log(`[queue] ✓ Check run #${checkRunId} updated → ${conclusion}`);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] ⚠️ Failed to update Check Run #${checkRunId}: ${errMsg}`);
                }
            } else {
                console.log(`[queue] ⚠️ No checkRunId available, skipping Check Run update`);
            }

            console.log(`[queue] ✅ Pipeline complete for PR #${prNumber} (conclusion: ${conclusion})`);
            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Pipeline failed for PR #${prNumber}: ${errMsg}`);

            try {
                await postPRComment(
                    repoFullName,
                    prNumber,
                    `> ⚠️ **Code Reviewer Agent Error**\n` +
                    `> The automated review failed unexpectedly.\n\n` +
                    `**Error:** \`${errMsg}\`\n\n` +
                    `> You can trigger another review by closing and reopening this PR.`,
                    token
                );
            } catch {
                console.error('[queue] ⚠️ Could not post error comment to PR');
            }

            if (checkRunId) {
                try {
                    await updateCheckRun(
                        repoFullName,
                        checkRunId,
                        token,
                        'failure',
                        `## ❌ Review Pipeline Error\n\n**Error:** \`${errMsg}\`\n\n` +
                        `You can trigger another review by closing and reopening this PR.`
                    );
                } catch {
                    console.error('[queue] ⚠️ Could not update Check Run with error status');
                }
            }

            message.ack();
        }
    }
}
