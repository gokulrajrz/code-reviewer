import type { Env, ReviewMessage } from '../types/env';
import type { ReviewFinding, SynthesizerInput, AnnotatedFinding } from '../types/review';
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
import { postToCliq } from '../lib/cliq';
import { buildPRUsageMetrics, storePRUsageMetrics } from '../lib/usage-tracker';
import { logger } from '../lib/logger';
import { runWithContextAsync } from '../lib/request-context';
import { loadReviewConfig, buildCustomPrompt } from '../lib/review-rules';
import { clusterFindings, flattenClusters } from '../lib/finding-clusters';
import type { FindingCluster } from '../lib/finding-clusters';
import { deriveVerdict, verdictToConclusion, countBySeverity } from '../lib/verdict';
import { formatFindingsAsMarkdown } from '../lib/review-formatter';

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
 * Severity sort order (lower = more severe).
 */
const SEVERITY_SORT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Convert clustered findings into a FLAT, severity-sorted array of AnnotatedFinding[].
 *
 * Cluster metadata (similar patterns) is preserved as inline
 * annotations on each finding — the LLM sees individual findings, not groups.
 * This prevents the LLM from consolidating similar findings into one block.
 */
function flattenClustersToAnnotated(clusters: FindingCluster[]): AnnotatedFinding[] {
    const annotated: AnnotatedFinding[] = [];

    for (const cluster of clusters) {
        const isMultiFile = new Set(cluster.findings.map(f => f.file)).size > 1;
        const fileCount = new Set(cluster.findings.map(f => f.file)).size;

        for (let i = 0; i < cluster.findings.length; i++) {
            const f = cluster.findings[i];
            const notes: string[] = [];


            // Similar-pattern annotations (only on the first finding to avoid noise)
            if (cluster.groupReason === 'similar-pattern' && isMultiFile && i === 0) {
                notes.push(`🔄 This pattern repeats across ${fileCount} files — consider a systematic fix`);
            }

            annotated.push({
                ...f,
                ...(notes.length > 0 ? { annotations: notes } : {}),
            });
        }
    }

    // Sort by severity (critical first), then by file for consistent ordering
    annotated.sort((a, b) => {
        const sevDiff = (SEVERITY_SORT[a.severity] ?? 3) - (SEVERITY_SORT[b.severity] ?? 3);
        if (sevDiff !== 0) return sevDiff;
        return a.file.localeCompare(b.file);
    });

    return annotated;
}

/**
 * Builds the JSON payload for the synthesizer LLM.
 *
 * Findings are FLAT and severity-sorted — not nested in clusters.
 * This prevents the LLM from consolidating similar findings.
 * Uses compact JSON to save tokens.
 */
function buildSynthesizerPayload(
    prTitle: string,
    allFiles: string[],
    skippedCount: number,
    clusters: FindingCluster[],
    totalChunks: number,
    failedChunks: number,
    failedChunkFiles: string[]
): { payload: string; droppedFindingsCount: number } {
    const allAnnotated = flattenClustersToAnnotated(clusters);
    const totalFindingsCount = allAnnotated.length;

    const input: SynthesizerInput = {
        prTitle,
        allFiles,
        skippedCount,
        findings: allAnnotated,
        totalFindingsCount,
        totalChunks,
        failedChunks,
        droppedFindingsCount: 0,
        failedChunkFiles,
    };

    // Compact JSON — saves ~30% tokens vs pretty-printed
    let payload = JSON.stringify(input);
    let droppedFindingsCount = 0;

    // Guard against massive payloads that would blow the LLM context window
    if (payload.length > MAX_SYNTHESIZER_INPUT_CHARS) {
        logger.warn('Synthesizer payload too large, truncating findings by severity', {
            originalLength: payload.length,
            maxAllowed: MAX_SYNTHESIZER_INPUT_CHARS,
            totalFindings: totalFindingsCount,
        });

        // Binary search for how many findings fit (they're already severity-sorted)
        let lo = 1, hi = allAnnotated.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const test: SynthesizerInput = {
                ...input,
                findings: allAnnotated.slice(0, mid),
                droppedFindingsCount: totalFindingsCount - mid,
            };
            if (JSON.stringify(test).length <= MAX_SYNTHESIZER_INPUT_CHARS) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        droppedFindingsCount = totalFindingsCount - lo;
        const truncated: SynthesizerInput = {
            ...input,
            findings: allAnnotated.slice(0, lo),
            droppedFindingsCount,
        };
        payload = JSON.stringify(truncated);
        logger.info('Truncated findings by severity', {
            keptFindings: lo,
            totalFindings: totalFindingsCount,
            droppedFindings: droppedFindingsCount,
        });
    }

    return { payload, droppedFindingsCount };
}

/**
 * Improved deduplication using composite key:
 * file + normalized title + line number.
 * Prevents merging genuinely different findings with similar titles.
 */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const seen = new Set<string>();
    const deduplicated: ReviewFinding[] = [];
    for (const f of findings) {
        const normalizedTitle = f.title.toLowerCase().trim().replace(/\s+/g, ' ');
        const key = `${f.file}::${normalizedTitle}::${f.line ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(f);
        }
    }
    return deduplicated;
}


/**
 * Background Queue Consumer Handler.
 * Implements a Map-Reduce pipeline:
 *   Step 1-4: Fetch files, classify, build chunks (unchanged)
 *   Step 5: MAP — Each chunk → LLM → structured JSON findings
 *   Step 6: Deduplicate findings (composite key)
 *   Step 7: Cluster findings (category-file, similarity)
 *   Step 8: REDUCE — Clustered findings → LLM → final markdown (tiered fallback)
 *   Step 9: Post to GitHub & update Check Run (data-driven verdict)
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
    const { prNumber, title, repoFullName, headSha, checkRunId, prAuthor } = message.body;

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
        // ── Step 1.5: Load Custom Review Rules ──
        logger.info('Loading review configuration', { repoFullName });
        const reviewConfig = await loadReviewConfig(repoFullName);
        const customSystemPrompt = buildCustomPrompt(reviewConfig);

        // ── Step 2: Fetch ALL changed files (paginated) ──
        logger.info('Fetching changed files', { prNumber });
        const allFiles = await fetchChangedFiles(repoFullName, prNumber, token, env);
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
        const { chunks: rawChunks, globalContext, allFiles: reviewableFiles, pluginFindings } =
            await buildReviewChunks(classified, token, MAX_CHUNK_CHARS, env, {
                title,
                repoFullName,
                prNumber
            });

        let chunks = rawChunks;
        logger.info('Generated chunks', {
            prNumber,
            chunkCount: chunks.length,
            globalContextLength: globalContext.length,
        });

        // Apply Hard Cap to prevent 50-subrequest limit exhaustion
        // Budget: chunks × 1 (Map) + 1-2 (Reduce with fallback) + file fetches + auth ≤ 50
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

        const allFindings: ReviewFinding[] = [...pluginFindings];
        let failedChunks = 0;
        const failedChunkFiles: string[] = []; // Track which files lacked coverage

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
                    (signal) => callChunkReview(chunkContent, title, chunkLabel, env, signal, customSystemPrompt),
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

                // Extract file paths from the chunk content for coverage tracking
                const fileMatches = chunkContent.match(/(?:File|---)\s*[:`]\s*([^\s`\n]+\.\w+)/g);
                if (fileMatches) {
                    for (const match of fileMatches) {
                        const filePath = match.replace(/(?:File|---)\s*[:`]\s*/, '').trim();
                        if (filePath && !failedChunkFiles.includes(filePath)) {
                            failedChunkFiles.push(filePath);
                        }
                    }
                }
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
        // Step 6: Deduplicate findings (composite key with line numbers)
        // ══════════════════════════════════════════════════════════════
        const deduplicated = deduplicateFindings(allFindings);

        if (deduplicated.length < allFindings.length) {
            logger.info('Deduplicated findings', {
                prNumber,
                before: allFindings.length,
                after: deduplicated.length,
            });
        }

        // ══════════════════════════════════════════════════════════════
        // Step 7: Cluster findings (category, similarity)
        // ══════════════════════════════════════════════════════════════
        const clusters = clusterFindings(deduplicated);
        logger.info('Clustered findings', {
            prNumber,
            findingsCount: deduplicated.length,
            clusterCount: clusters.length,
        });

        // ══════════════════════════════════════════════════════════════
        // Step 8: REDUCE PHASE — Synthesize final review (tiered fallback)
        // ══════════════════════════════════════════════════════════════
        const allChunksFailed = failedChunks === chunks.length && chunks.length > 0;

        // Derive verdict from data BEFORE synthesis — this is deterministic
        const verdict = deriveVerdict(deduplicated, allChunksFailed);
        const conclusion = verdictToConclusion(verdict);
        const severityCounts = countBySeverity(deduplicated);

        logger.info('Starting REDUCE phase', {
            prNumber,
            findingsCount: deduplicated.length,
            clusterCount: clusters.length,
            verdict,
        });

        let finalReview: string;
        let isFallback = false;

        // Guard: all chunks failed with no findings → skip synthesizer entirely
        if (allChunksFailed && deduplicated.length === 0) {
            logger.warn('All chunks failed with no findings, using error review', { prNumber });
            finalReview =
                `## ❌ Review Pipeline Error\n\n` +
                `All ${chunks.length} review chunks failed to process. ` +
                `The AI reviewer could not analyze this PR.\n\n` +
                `> You can trigger another review by closing and reopening this PR.\n\n` +
                `Overall verdict: **Request Changes**`;
        } else if (deduplicated.length === 0) {
            // No findings from successful chunks — clean approval, skip LLM call
            logger.info('Zero findings from successful chunks, producing direct approval', { prNumber });
            finalReview = formatFindingsAsMarkdown(clusters, {
                allFiles: reviewableFiles,
                prTitle: title,
                totalChunks: chunks.length,
                failedChunks,
                droppedFindingsCount: 0,
                failedChunkFiles,
                isFallback: false,
            });
        } else {
            // Scale output budget based on finding count.
            // Claude Sonnet 4 supports up to 16384 output tokens.
            // Each cluster with code blocks needs ~300 tokens for proper rendering.
            const dynamicMaxTokens = Math.min(16384, 3000 + clusters.length * 300);
            const { payload: synthesizerPayload, droppedFindingsCount } = buildSynthesizerPayload(
                title,
                reviewableFiles,
                classified.skipped.length,
                clusters,
                chunks.length,
                failedChunks,
                failedChunkFiles
            );

            try {
                // Tiered fallback: primary → alternate → formatter
                const result = await withTimeout(
                    (signal) => callSynthesizer(
                        synthesizerPayload, env, signal, customSystemPrompt, dynamicMaxTokens
                    ),
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
                // Both LLM providers failed — use fallback formatter
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error('All synthesizer providers failed, using fallback formatter',
                    error instanceof Error ? error : undefined, { prNumber });

                isFallback = true;
                finalReview = formatFindingsAsMarkdown(clusters, {
                    allFiles: reviewableFiles,
                    prTitle: title,
                    totalChunks: chunks.length,
                    failedChunks,
                    droppedFindingsCount,
                    failedChunkFiles,
                    isFallback: true,
                });
            }
        }

        // Add metadata banner for multi-chunk reviews
        if ((chunks.length > 1 || failedChunks > 0) && !isFallback) {
            const banner = `> ℹ️ **Review Pipeline:** ${chunks.length} chunks processed` +
                `${failedChunks > 0 ? ` (${failedChunks} failed)` : ''}, ` +
                `${deduplicated.length} findings in ${clusters.length} clusters from ` +
                `${classified.tier1.length} full-context + ${classified.tier2.length} diff-only files.\n\n`;
            finalReview = banner + finalReview;
        }

        logger.info('Final review ready, posting to PR', {
            prNumber,
            reviewLength: finalReview.length,
            isFallback,
        });

        // ── Step 9: Post review comment to PR ──
        try {
            await postPRComment(repoFullName, prNumber, finalReview, token);
            logger.info('Review comment posted', { prNumber });
        } catch (error) {
            logger.error('Failed to post review comment', error instanceof Error ? error : undefined, {
                prNumber,
            });
        }

        // ── Step 10: Update Check Run with data-driven verdict ──
        if (checkRunId) {
            try {
                await updateCheckRun(repoFullName, checkRunId, token, conclusion, finalReview);
                logger.info('Check run updated', {
                    prNumber,
                    checkRunId,
                    conclusion,
                    verdict,
                    severityCounts,
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
            verdict,
            isFallback,
        });

        // ── Step 10.5: Post notification to Zoho Cliq Bot ──
        if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
            await postToCliq(
                env.CLIQ_CLIENT_ID,
                env.CLIQ_CLIENT_SECRET,
                env.CLIQ_REFRESH_TOKEN,
                env.CLIQ_BOT_NAME,
                env.CLIQ_CHANNEL_ID,
                repoFullName,
                prNumber,
                title,
                prAuthor ?? 'unknown',
                conclusion,
                severityCounts,
                env.CLIQ_DB_NAME
            );
        }

        // ── Step 11: Store usage metrics ──
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
