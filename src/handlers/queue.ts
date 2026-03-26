import type { Env, ReviewMessage } from '../types/env';
import type { ReviewFinding, SynthesizerInput } from '../types/review';
import type { LLMCallUsage } from '../types/usage';
import { MAX_CHUNK_CHARS, MAX_LLM_CHUNKS, MAX_SYNTHESIZER_INPUT_CHARS, DEFAULT_AI_PROVIDER } from '../config/constants';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    postPRComment,
    updateCheckRun,
} from '../lib/github';
import { getInstallationToken } from '../lib/github-auth';
import { callChunkReview, callSynthesizer, getModelName } from '../lib/llm/index';
import { buildPRUsageMetrics, storePRUsageMetrics } from '../lib/usage-tracker';
import { logger } from '../lib/logger';
import { runWithContextAsync } from '../lib/request-context';

/** Maximum time (ms) to wait for a single LLM call before aborting. */
const LLM_TIMEOUT_MS = 120_000;

/**
 * Wraps an async function with a timeout guard.
 * If it doesn't resolve within `timeoutMs`, the promise rejects.
 */
async function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const result = await Promise.race([
            fn(controller.signal),
            new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () =>
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
                );
            }),
        ]);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Builds the JSON payload string for the synthesizer (Reduce phase).
 * Includes PR metadata and all findings from the Map phase.
 */
function buildSynthesizerPayload(
    prTitle: string,
    allFiles: string[],
    skippedCount: number,
    allFindings: ReviewFinding[],
    totalChunks: number,
    failedChunks: number
): string {
    const input: SynthesizerInput = {
        prTitle,
        allFiles,
        skippedCount,
        findings: allFindings,
        totalChunks,
        failedChunks,
    };

    let payload = JSON.stringify(input, null, 2);

    // Guard against massive payloads that would blow the LLM context window
    if (payload.length > MAX_SYNTHESIZER_INPUT_CHARS) {
        logger.warn('Synthesizer payload too large, truncating findings', {
            originalLength: payload.length,
            maxAllowed: MAX_SYNTHESIZER_INPUT_CHARS,
        });

        // Sort findings: critical > high > medium > low, then truncate
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const sorted = [...allFindings].sort(
            (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
        );

        // Binary search for how many findings fit
        let lo = 1, hi = sorted.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const test: SynthesizerInput = { ...input, findings: sorted.slice(0, mid) };
            if (JSON.stringify(test).length <= MAX_SYNTHESIZER_INPUT_CHARS) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        const truncated: SynthesizerInput = {
            ...input,
            findings: sorted.slice(0, lo),
        };
        payload = JSON.stringify(truncated, null, 2);
        logger.info('Truncated findings by severity', {
            kept: lo,
            total: allFindings.length,
        });
    }

    return payload;
}



/**
 * Background Queue Consumer Handler.
 * Implements a Map-Reduce pipeline:
 *   Step 1-4: Fetch files, classify, build chunks (unchanged)
 *   Step 5: MAP — Each chunk → LLM → structured JSON findings
 *   Step 6: Flatten & deduplicate findings
 *   Step 7: REDUCE — All findings → LLM → final cohesive markdown
 *   Step 8: Post to GitHub & update Check Run
 */
export async function queueHandler(
    batch: MessageBatch<ReviewMessage>,
    env: Env,
    _ctx: ExecutionContext
): Promise<void> {
    // Process each message with its own request context for distributed tracing
    const processingPromises = batch.messages.map(async (message) => {
        const { prNumber, title, repoFullName, headSha, requestId } = message.body;

        // Create request context for this message
        const context = {
            requestId: requestId || `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            startTime: Date.now(),
            prNumber,
            repoFullName,
        };

        return runWithContextAsync(context, async () => processMessage(message, env));
    });

    await Promise.all(processingPromises);
}

/**
 * Process a single queue message.
 * Separated to enable per-message request context.
 */
async function processMessage(
    message: Message<ReviewMessage>,
    env: Env
): Promise<void> {
    const { prNumber, title, repoFullName, headSha, checkRunId } = message.body;

    logger.info('Processing PR', {
        prNumber,
        title,
        repoFullName,
        headSha,
    });

        // Track usage metrics
        const startTime = new Date().toISOString();
        const llmCalls: LLMCallUsage[] = [];
        const provider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER);
        const modelName = getModelName(provider);

        // ── Step 1: Get a fresh installation token ──
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Auth failed - cannot get installation token', error instanceof Error ? error : undefined, {
                prNumber,
            });
            message.ack();
            return;
        }

        try {
            // ── Step 2: Fetch ALL changed files (paginated) ──
            logger.info('Fetching changed files', { prNumber });
            const allFiles = await fetchChangedFiles(repoFullName, prNumber, token);
            logger.info('Fetched changed files', { prNumber, count: allFiles.length });

            if (allFiles.length === 0) {
                logger.warn('No changed files found, skipping review', { prNumber });
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        '## No Files to Review\n\nThis PR has no reviewable file changes.');
                }
                message.ack();
                return;
            }

            // ── Step 3: Classify files into tiers ──
            const classified = classifyFiles(allFiles);
            logger.info('Classified files', {
                prNumber,
                tier1: classified.tier1.length,
                tier2: classified.tier2.length,
                skipped: classified.skipped.length,
            });

            if (classified.tier1.length === 0 && classified.tier2.length === 0) {
                logger.warn('All files classified as noise, skipping review', {
                    prNumber,
                    totalFiles: allFiles.length,
                });
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        `## No Reviewable Files\n\nAll ${allFiles.length} files in this PR are auto-generated, vendor, or noise files.\n\n` +
                        `Skipped: ${classified.skipped.slice(0, 20).join(', ')}${classified.skipped.length > 20 ? '...' : ''}`);
                }
                message.ack();
                return;
            }

            // ── Step 4: Build size-limited chunks with global context ──
            logger.info('Building review chunks', {
                prNumber,
                maxChunkChars: MAX_CHUNK_CHARS,
            });
            const { chunks: rawChunks, globalContext, allFiles: reviewableFiles } =
                await buildReviewChunks(classified, token, MAX_CHUNK_CHARS);

            let chunks = rawChunks;
            logger.info('Generated chunks', {
                prNumber,
                chunkCount: chunks.length,
                globalContextLength: globalContext.length,
            });

            // Apply Hard Cap to prevent 50-subrequest limit exhaustion
            // Budget: chunks × 1 (Map) + 1 (Reduce) + file fetches + auth ≤ 50
            if (chunks.length > MAX_LLM_CHUNKS) {
                logger.warn('Truncating chunks to prevent subrequest limit', {
                    prNumber,
                    original: chunks.length,
                    max: MAX_LLM_CHUNKS,
                });
                chunks = chunks.slice(0, MAX_LLM_CHUNKS);
            }

            // ══════════════════════════════════════════════════════════════
            // Step 5: MAP PHASE — Review each chunk, collect JSON findings
            // ══════════════════════════════════════════════════════════════
            logger.info('Starting MAP phase', {
                prNumber,
                chunkCount: chunks.length,
            });

            const allFindings: ReviewFinding[] = [];
            let failedChunks = 0;

            for (let i = 0; i < chunks.length; i++) {
                const chunkContent = chunks[i];
                const chunkLabel = `${i + 1}/${chunks.length}`;

                logger.info('Processing chunk', {
                    prNumber,
                    chunk: chunkLabel,
                    size: chunkContent.length,
                });

                try {
                    const result = await withTimeout(
                        (signal) => callChunkReview(chunkContent, title, chunkLabel, env, signal),
                        LLM_TIMEOUT_MS,
                        `Chunk ${chunkLabel}`
                    );

                    logger.info('Chunk processed', {
                        prNumber,
                        chunk: chunkLabel,
                        findings: result.findings.length,
                        tokens: result.usage.totalTokens,
                    });
                    allFindings.push(...result.findings);

                    // Track usage
                    llmCalls.push({
                        phase: 'map',
                        chunkLabel,
                        model: modelName,
                        usage: result.usage,
                        timestamp: new Date().toISOString(),
                    });
                } catch (error) {
                    failedChunks++;
                    logger.warn('Chunk failed, continuing with remaining', {
                        prNumber,
                        chunk: chunkLabel,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Continue processing remaining chunks — graceful degradation
                }
            }

            logger.info('MAP phase complete', {
                prNumber,
                totalFindings: allFindings.length,
                failedChunks,
                totalChunks: chunks.length,
            });

            // ══════════════════════════════════════════════════════════════
            // Step 6: Deduplicate findings (simple: same file + same title)
            // ══════════════════════════════════════════════════════════════
            const seen = new Set<string>();
            const deduplicated: ReviewFinding[] = [];
            for (const f of allFindings) {
                const key = `${f.file}::${f.title.toLowerCase().trim()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    deduplicated.push(f);
                }
            }

            if (deduplicated.length < allFindings.length) {
                logger.info('Deduplicated findings', {
                    prNumber,
                    before: allFindings.length,
                    after: deduplicated.length,
                });
            }

            // ══════════════════════════════════════════════════════════════
            // Step 7: REDUCE PHASE — Synthesize final review
            // ══════════════════════════════════════════════════════════════
            logger.info('Starting REDUCE phase', {
                prNumber,
                findingsCount: deduplicated.length,
            });

            let finalReview: string;

            const synthesizerPayload = buildSynthesizerPayload(
                title,
                reviewableFiles,
                classified.skipped.length,
                deduplicated,
                chunks.length,
                failedChunks
            );

            try {
                const result = await withTimeout(
                    (signal) => callSynthesizer(synthesizerPayload, env, signal),
                    LLM_TIMEOUT_MS,
                    'Synthesizer'
                );
                finalReview = result.review;
                logger.info('Synthesized review', {
                    prNumber,
                    reviewLength: finalReview.length,
                    tokens: result.usage.totalTokens,
                });

                // Track usage
                llmCalls.push({
                    phase: 'reduce',
                    model: modelName,
                    usage: result.usage,
                    timestamp: new Date().toISOString(),
                });
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error('Synthesizer failed', error instanceof Error ? error : undefined, {
                    prNumber,
                });
                throw new Error(`Synthesizer failed to generate review: ${errMsg}`);
            }

            // Add metadata banner for multi-chunk reviews
            if (chunks.length > 1 || failedChunks > 0) {
                const banner = `> ℹ️ **Review Pipeline:** ${chunks.length} chunks processed` +
                    `${failedChunks > 0 ? ` (${failedChunks} failed)` : ''}, ` +
                    `${deduplicated.length} findings synthesized from ` +
                    `${classified.tier1.length} full-context + ${classified.tier2.length} diff-only files.\n\n`;
                finalReview = banner + finalReview;
            }

            logger.info('Final review ready, posting to PR', {
                prNumber,
                reviewLength: finalReview.length,
            });

            // ── Step 8: Post review comment to PR ──
            try {
                await postPRComment(repoFullName, prNumber, finalReview, token);
                logger.info('Review comment posted', { prNumber });
            } catch (error) {
                logger.error('Failed to post review comment', error instanceof Error ? error : undefined, {
                    prNumber,
                });
            }

            // ── Step 9: Determine conclusion and update Check Run ──
            const allChunksFailed = failedChunks === chunks.length && chunks.length > 0;
            const hasRequestedChanges = finalReview.includes('**Request Changes**');
            const conclusion = allChunksFailed ? 'failure' : hasRequestedChanges ? 'failure' : 'success';

            if (checkRunId) {
                try {
                    await updateCheckRun(repoFullName, checkRunId, token, conclusion, finalReview);
                    logger.info('Check run updated', {
                        prNumber,
                        checkRunId,
                        conclusion,
                    });
                } catch (error) {
                    logger.error('Failed to update Check Run', error instanceof Error ? error : undefined, {
                        prNumber,
                        checkRunId,
                    });
                }
            } else {
                logger.warn('No checkRunId available, skipping Check Run update', { prNumber });
            }

            logger.info('Pipeline complete', {
                prNumber,
                conclusion,
            });

            // ── Step 10: Store usage metrics ──
            try {
                const usageMetrics = buildPRUsageMetrics(
                    prNumber,
                    repoFullName,
                    headSha,
                    provider,
                    startTime,
                    llmCalls,
                    reviewableFiles.length,
                    chunks.length,
                    deduplicated.length,
                    allChunksFailed ? 'failed' : failedChunks > 0 ? 'partial' : 'success'
                );
                await storePRUsageMetrics(usageMetrics, env);
            } catch (error) {
                logger.error('Failed to store usage metrics', error instanceof Error ? error : undefined, {
                    prNumber,
                });
                // Non-fatal: don't fail the entire review
            }

            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Pipeline failed', error instanceof Error ? error : undefined, {
                prNumber,
            });

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
                logger.error('Could not post error comment to PR', undefined, { prNumber });
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
                    logger.error('Could not update Check Run with error status', undefined, {
                        prNumber,
                        checkRunId,
                    });
                }
            }

            message.ack();
        }
    }
