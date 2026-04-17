import type { Env, ReviewMessage } from '../types/env';
import type { ReviewFinding, SynthesizerInput, AnnotatedFinding } from '../types/review';
import type { LLMCallUsage } from '../types/usage';
import { MAX_CHUNK_CHARS, MAX_LLM_CHUNKS, MAX_SYNTHESIZER_INPUT_CHARS, DEFAULT_AI_PROVIDER } from '../config/constants';
import { SubrequestBudget } from '../lib/subrequest-budget';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    postPRComment,
    postPRReview,
    updateCheckRun,
} from '../lib/github';
import type { InlineReviewComment } from '../lib/github';
import { getInstallationToken, invalidateInstallationToken } from '../lib/github-auth';
import { callChunkReview, callSynthesizer, getModelName } from '../lib/llm/index';
import { postToCliq } from '../lib/cliq';
import { buildPRUsageMetrics, storePRUsageMetrics } from '../lib/usage-tracker';
import { logger } from '../lib/logger';
import { runWithContextAsync } from '../lib/request-context';
import { clusterFindings } from '../lib/finding-clusters';
import type { FindingCluster } from '../lib/finding-clusters';
import { deriveVerdict, verdictToConclusion, countBySeverity } from '../lib/verdict';
import { formatFindingsAsMarkdown } from '../lib/review-formatter';
import { detectTechStack } from '../lib/stack-detector';
import { composeChunkPrompt, composeSynthesizerPrompt } from '../config/prompts/composer';
import { fetchRepoConfig, applyConfigOverrides, buildCustomRulesPrompt, shouldIgnore } from '../lib/repo-config';
import type { TechStackProfile } from '../types/stack';

/** Maximum time (ms) to wait for a single LLM call before aborting.
 * Increased to 5 minutes to accommodate rate limit (HTTP 429) retry-after sleep intervals. */
const LLM_TIMEOUT_MS = 300_000;

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
    failedChunkFiles: string[],
    verdict: 'approve' | 'request_changes' | 'needs_discussion',
    severityCounts: { critical: number; high: number; medium: number; low: number },
    conclusion: 'success' | 'failure' | 'neutral'
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
        verdict,
        severityCounts,
        conclusion,
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
    // Safety guard: reject batches > 1 to prevent subrequest budget explosion.
    // With max_batch_size: 1 in wrangler.jsonc this is a defensive assertion.
    if (batch.messages.length > 1) {
        logger.error('Queue batch size > 1 is not supported — would exceed subrequest limits', undefined, {
            batchSize: batch.messages.length,
        });
        // Ack all and bail — retrying won't change the batch size
        for (const msg of batch.messages) msg.ack();
        return;
    }

    // Process each message with its own request context for distributed tracing
    const processingPromises = batch.messages.map(async (message) => {
        const { prNumber, title, repoFullName, headSha, requestId, checkRunId } = message.body;

        // Create request context for this message
        const context = {
            requestId: requestId || `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            startTime: Date.now(),
            prNumber,
            repoFullName,
        };

        // ── Timeout Safety Net ──
        // If the main pipeline crashes (CPU/memory exceeded, unexpected deploy),
        // this background timer ensures the Check Run doesn't stay 'in_progress' forever.
        // It fires after 10 minutes and marks the Check Run as 'timed_out'.
        let timerId: ReturnType<typeof setTimeout> | undefined;
        let timeoutResolver: (() => void) | undefined;
        
        const safetyNet = new Promise<void>((resolve) => {
            timeoutResolver = resolve;
        });

        if (checkRunId) {
            const SAFETY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
            timerId = setTimeout(async () => {
                try {
                    const token = await getInstallationToken(env);
                    await updateCheckRun(
                        repoFullName,
                        checkRunId,
                        token,
                        'timed_out',
                        '⏰ The code review pipeline did not complete within 10 minutes. This is likely due to a transient infrastructure issue. Please re-push or re-open the PR to retry.'
                    );
                    logger.warn('Safety net timeout fired — marked Check Run as timed out', { prNumber, checkRunId });
                } catch {
                    // Best-effort — if this fails, the Check Run stays in_progress which is still visible
                } finally {
                    if (timeoutResolver) timeoutResolver();
                }
            }, SAFETY_TIMEOUT_MS);
            
            _ctx.waitUntil(safetyNet);
        }

        return runWithContextAsync(context, async () => {
            try {
                await processMessage(message, env);
            } finally {
                // Clear the timeout if the pipeline finishes successfully before 10 minutes
                if (timerId) clearTimeout(timerId);
                // Resolve the waitUntil promise so the worker doesn't stay alive unnecessarily
                if (timeoutResolver) timeoutResolver();
            }
        });
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
    const { prNumber, title, repoFullName, headSha, checkRunId, prAuthor, prDescription } = message.body;

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
            error: errMsg,
        });
        // RETRY instead of ACK: transient auth failures (KV race, GitHub blip) should be retried.
        // After max_retries (2), the message is dead-lettered and GitHub times out the Check Run.
        message.retry();
        return;
    }

    try {
        // ── Step 2: Fetch ALL changed files (paginated) ──
        logger.info('Fetching changed files', { prNumber });
        let allFiles;
        try {
            allFiles = await fetchChangedFiles(repoFullName, prNumber, token, env);
        } catch (fetchError) {
            // If the cached token is expired/invalid, GitHub returns 401.
            // Invalidate the cache, get a fresh token, and retry once.
            const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
            if (errMsg.includes('401')) {
                logger.warn('GitHub API returned 401, invalidating cached token and retrying', { prNumber });
                await invalidateInstallationToken(env);
                token = await getInstallationToken(env);
                allFiles = await fetchChangedFiles(repoFullName, prNumber, token, env);
            } else {
                throw fetchError;
            }
        }
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

        // ── Step 3.5: Detect tech stack ──
        logger.info('Detecting tech stack', { repoFullName });

        // Extract content snippets from diff patches (already fetched, zero cost)
        // to feed the stack detector's Tier 6 import scanner.
        const patchContents = allFiles
            .filter(f => f.patch && (f.status === 'added' || f.status === 'modified'))
            .slice(0, 20) // Cap to avoid excessive processing
            .map(f => ({
                filename: f.filename,
                // Extract added lines from the patch (lines starting with '+')
                content: f.patch!
                    .split('\n')
                    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
                    .map(line => line.slice(1)) // Remove the '+' prefix
                    .join('\n'),
            }))
            .filter(f => f.content.length > 0);

        const stackProfile: TechStackProfile = await detectTechStack({
            changedFiles: allFiles.map(f => f.filename),
            fileContents: patchContents.length > 0 ? patchContents : undefined,
            repoFullName,
            token,
            kvNamespace: env.CACHE_KV,
        });
        logger.info('Tech stack detected', {
            prNumber,
            languages: stackProfile.languages,
            frameworks: stackProfile.frameworks,
            architecture: stackProfile.architecture,
            confidence: stackProfile.confidence,
            source: stackProfile.source,
        });

        // ── Step 3.6: Fetch repo config (.codereview.yml) ──
        let activeProfile = stackProfile;
        let customRulesPrompt: string | undefined;
        const repoConfig = await fetchRepoConfig(repoFullName, token, env.CACHE_KV);
        if (repoConfig) {
            activeProfile = applyConfigOverrides(stackProfile, repoConfig);
            customRulesPrompt = buildCustomRulesPrompt(repoConfig);
            logger.info('Applied repo config overrides', {
                prNumber,
                hasStack: !!repoConfig.stack,
                rulesCount: repoConfig.rules?.length ?? 0,
                ignoreCount: repoConfig.ignore?.length ?? 0,
            });

            // Apply repo-specific ignores
            if (repoConfig.ignore && repoConfig.ignore.length > 0) {
                const preTier1 = classified.tier1.length;
                const preTier2 = classified.tier2.length;
                
                classified.tier1 = classified.tier1.filter(f => !shouldIgnore(f.filename, repoConfig.ignore));
                classified.tier2 = classified.tier2.filter(f => !shouldIgnore(f.filename, repoConfig.ignore));
                
                const ignored1 = preTier1 - classified.tier1.length;
                const ignored2 = preTier2 - classified.tier2.length;
                
                if (ignored1 > 0 || ignored2 > 0) {
                    logger.info('Applied repo-specific ignores', {
                        prNumber,
                        ignoredTier1: ignored1,
                        ignoredTier2: ignored2,
                    });
                }
            }
        }

        // ── Step 4: Build size-limited chunks with global context ──
        logger.info('Building review chunks', {
            prNumber,
            maxChunkChars: MAX_CHUNK_CHARS,
        });
        const { chunks: rawChunks, chunkFileMap, globalContext, allFiles: reviewableFiles, pluginFindings } =
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

        // ── Subrequest Budget: dynamically cap chunks based on remaining budget ──
        // Instead of blindly capping at MAX_LLM_CHUNKS, calculate how many
        // subrequests we can still afford for chunk reviews.
        const budget = new SubrequestBudget();
        // Account for what buildReviewChunks already consumed (Tier 1 file fetches)
        budget.use(classified.tier1.length); // 1 subrequest per Tier 1 file
        budget.use(2); // auth JWT + install token
        budget.use(2); // post review + update check run (reserved for end)
        budget.use(2); // Reduce LLM call with fallback

        const maxChunksFromBudget = Math.min(MAX_LLM_CHUNKS, budget.remaining());
        if (chunks.length > maxChunksFromBudget) {
            logger.warn('Truncating chunks based on subrequest budget', {
                prNumber,
                original: chunks.length,
                max: maxChunksFromBudget,
                budgetState: budget.getState(),
            });
            chunks = chunks.slice(0, maxChunksFromBudget);
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

        // Dynamic concurrency: Gemini has 2x higher RPM limits than Claude.
        // Claude Tier 1/2: 15 RPM → sequential only.
        // Gemini: 30 RPM → safe to run 3 concurrent.
        const provider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as import('../types/env').AIProvider;
        const CHUNK_CONCURRENCY = provider === 'gemini' ? 3 : 1;

        /**
         * Simple semaphore for bounded concurrency.
         * Processes items from a queue with at most `limit` running at once.
         */
        async function processWithConcurrency<T, R>(
            items: T[],
            limit: number,
            fn: (item: T, index: number) => Promise<R>
        ): Promise<(R | Error)[]> {
            const results: (R | Error)[] = new Array(items.length);
            let nextIndex = 0;

            async function worker(): Promise<void> {
                while (nextIndex < items.length) {
                    const idx = nextIndex++;
                    try {
                        results[idx] = await fn(items[idx], idx);
                    } catch (err) {
                        results[idx] = err instanceof Error ? err : new Error(String(err));
                    }
                }
            }

            // Spawn `limit` workers
            await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
            return results;
        }

        const chunkResults = await processWithConcurrency(
            chunks,
            CHUNK_CONCURRENCY,
            async (chunkContent: string, i: number) => {
                const chunkLabel = `${i + 1}/${chunks.length}`;

                // Per-chunk prompt composition: only include rules relevant to THIS chunk's files
                const chunkFiles = chunkFileMap[i] || [];
                const chunkSystemPrompt = composeChunkPrompt(activeProfile, chunkFiles, customRulesPrompt);

                // Prepend PR description for intent context (if available)
                const prContext = prDescription
                    ? `PR Description:\n${prDescription}\n\n`
                    : '';

                logger.info('Processing chunk', {
                    prNumber,
                    chunk: chunkLabel,
                    size: chunkContent.length,
                    chunkFiles: chunkFiles.slice(0, 5),
                });

                // Track subrequest consumption per Map call
                budget.use(1);

                try {
                    const result = await withTimeout(
                        (signal) => callChunkReview(
                            prContext + chunkContent, title, chunkLabel, env, signal, chunkSystemPrompt, reviewableFiles
                        ),
                        LLM_TIMEOUT_MS,
                        `Chunk ${chunkLabel}`
                    );

                    logger.info('Chunk processed', {
                        prNumber,
                        chunk: chunkLabel,
                        findings: result.findings.length,
                        tokens: result.usage.totalTokens,
                    });

                    return { result, chunkLabel, chunkContent };
                } catch (primaryError) {
                    // Mid-pipeline fallback: if primary provider's circuit breaker
                    // opened, try the alternate provider instead of failing the chunk.
                    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
                    if (errMsg.includes('circuit breaker') && errMsg.includes('OPEN')) {
                        const altProvider = provider === 'claude' ? 'gemini' : 'claude';
                        const altKey = altProvider === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;

                        if (altKey) {
                            logger.warn(`Primary provider circuit breaker open, falling back to ${altProvider} for chunk ${chunkLabel}`, {
                                prNumber,
                                chunk: chunkLabel,
                            });

                            // Create a temporary env override for the alternate provider
                            const fallbackEnv = { ...env, AI_PROVIDER: altProvider } as Env;
                            budget.use(1); // fallback costs a subrequest too

                            const result = await withTimeout(
                                (signal) => callChunkReview(
                                    prContext + chunkContent, title, chunkLabel, fallbackEnv, signal, chunkSystemPrompt, reviewableFiles
                                ),
                                LLM_TIMEOUT_MS,
                                `Chunk ${chunkLabel} (fallback:${altProvider})`
                            );

                            logger.info('Chunk processed via fallback provider', {
                                prNumber,
                                chunk: chunkLabel,
                                provider: altProvider,
                                findings: result.findings.length,
                            });

                            return { result, chunkLabel, chunkContent };
                        }
                    }
                    // No fallback available — rethrow for normal error handling
                    throw primaryError;
                }
            }
        );

        // Collect results from parallel processing
        const chunkErrors: string[] = []; // Track unique error reasons
        for (let i = 0; i < chunkResults.length; i++) {
            const outcome = chunkResults[i];
            if (outcome instanceof Error) {
                failedChunks++;
                const chunkLabel = `${i + 1}/${chunks.length}`;
                logger.warn('Chunk failed, continuing with remaining', {
                    prNumber,
                    chunk: chunkLabel,
                    error: outcome.message,
                });

                // Collect unique error reasons for surfacing in PR comment
                const errorReason = outcome.message || 'Unknown error';
                if (!chunkErrors.includes(errorReason)) {
                    chunkErrors.push(errorReason);
                }

                const filePaths = chunkFileMap[i] || [];
                for (const filePath of filePaths) {
                    if (!failedChunkFiles.includes(filePath)) {
                        failedChunkFiles.push(filePath);
                    }
                }
            } else {
                allFindings.push(...outcome.result.findings);
                llmCalls.push({
                    phase: 'map',
                    chunkLabel: outcome.chunkLabel,
                    model: modelName,
                    usage: outcome.result.usage,
                    timestamp: new Date().toISOString(),
                });
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
            logger.warn('All chunks failed with no findings, using error review', {
                prNumber,
                errors: chunkErrors,
            });

            // Build error details section
            const errorDetailsSection = chunkErrors.length > 0
                ? `### Error Details\n\n` +
                  chunkErrors.map((err, i) => `${i + 1}. \`${err}\``).join('\n') + '\n\n'
                : '';

            const affectedFilesSection = failedChunkFiles.length > 0
                ? `<details>\n<summary>📂 <b>Affected Files (${failedChunkFiles.length})</b></summary>\n\n` +
                  failedChunkFiles.map(f => `- \`${f}\``).join('\n') +
                  '\n\n</details>\n\n'
                : '';

            finalReview =
                `## ❌ Review Pipeline Error\n\n` +
                `All **${chunks.length}** review chunks failed to process. ` +
                `The AI reviewer could not analyze this PR.\n\n` +
                errorDetailsSection +
                affectedFilesSection +
                `> 💡 **Troubleshooting:**\n` +
                `> - Check if the AI provider API key is valid and has sufficient credits\n` +
                `> - Check if the model (\`${modelName}\`) is accessible\n` +
                `> - Check Cloudflare Worker logs for detailed stack traces\n` +
                `> - You can trigger another review by closing and reopening this PR.\n\n` +
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
                failedChunkFiles,
                verdict,
                severityCounts,
                conclusion
            );

            try {
                // Compose synthesizer prompt based on detected stack
                const synthesizerSystemPrompt = composeSynthesizerPrompt(activeProfile);

                // Tiered fallback: primary → alternate → formatter
                const result = await withTimeout(
                    (signal) => callSynthesizer(
                        synthesizerPayload, env, signal, synthesizerSystemPrompt, dynamicMaxTokens
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

                // Prepend degraded-mode warning so users know why the output looks different
                const fallbackBanner =
                    `> ⚠️ **Degraded Mode:** The AI synthesizer failed (\`${errMsg}\`). ` +
                    `This review was generated by the fallback formatter and may lack detailed analysis.\n\n`;
                finalReview = fallbackBanner + finalReview;

                if (!chunkErrors.includes(`Synthesizer: ${errMsg}`)) {
                    chunkErrors.push(`Synthesizer: ${errMsg}`);
                }
            }
        }

        // Add metadata banner for multi-chunk reviews
        if ((chunks.length > 1 || failedChunks > 0) && !isFallback) {
            let banner = `> ℹ️ **Review Pipeline:** ${chunks.length} chunks processed` +
                `${failedChunks > 0 ? ` (${failedChunks} failed)` : ''}, ` +
                `${deduplicated.length} findings in ${clusters.length} clusters from ` +
                `${classified.tier1.length} full-context + ${classified.tier2.length} diff-only files.\n\n`;

            // Surface chunk failure reasons in partial failure cases
            if (failedChunks > 0 && chunkErrors.length > 0) {
                banner += `> ⚠️ **Failed chunk errors:** ${chunkErrors.map(e => `\`${e}\``).join(', ')}\n\n`;
            }

            finalReview = banner + finalReview;
        }

        logger.info('Final review ready, posting to PR', {
            prNumber,
            reviewLength: finalReview.length,
            isFallback,
        });

        // ── Step 9: Post review with inline comments ──
        // Build inline comments for critical/high findings that have file + line
        const inlineComments: InlineReviewComment[] = [];
        const filePatchMap = new Map<string, string>();

        // Build patch map from classified files for diff position mapping
        for (const file of [...classified.tier1, ...classified.tier2]) {
            if (file.patch) {
                filePatchMap.set(file.filename, file.patch);
            }
        }

        // Only inline critical and high severity findings with valid file+line
        for (const finding of deduplicated) {
            if (
                (finding.severity === 'critical' || finding.severity === 'high') &&
                finding.file &&
                finding.line &&
                finding.line > 0 &&
                filePatchMap.has(finding.file)
            ) {
                const emoji = finding.severity === 'critical' ? '🔴' : '🟠';
                let commentBody = `${emoji} **${finding.severity.toUpperCase()}** — ${finding.title}\n\n${finding.issue}`;
                if (finding.suggestedCode) {
                    commentBody += `\n\n**Suggested fix:**\n\`\`\`\n${finding.suggestedCode}\n\`\`\``;
                }
                inlineComments.push({
                    path: finding.file,
                    line: finding.line,
                    body: commentBody,
                });
            }
        }

        // Post as a native GitHub Pull Request Review (inline comments + summary)
        const reviewEvent = verdict === 'approve'
            ? 'APPROVE' as const
            : verdict === 'request_changes'
                ? 'REQUEST_CHANGES' as const
                : 'COMMENT' as const;

        try {
            await postPRReview(
                repoFullName,
                prNumber,
                token,
                reviewEvent,
                finalReview,
                inlineComments,
                filePatchMap
            );
            logger.info('PR review posted with inline comments', {
                prNumber,
                inlineComments: inlineComments.length,
                event: reviewEvent,
            });
        } catch (error) {
            // Fallback: if the Reviews API fails, post as a regular issue comment
            logger.warn('PR review API failed, falling back to issue comment', {
                prNumber,
                error: error instanceof Error ? error.message : String(error),
            });
            try {
                await postPRComment(repoFullName, prNumber, finalReview, token);
                logger.info('Fallback review comment posted', { prNumber });
            } catch (commentError) {
                logger.error('Failed to post fallback review comment', commentError instanceof Error ? commentError : undefined, {
                    prNumber,
                });
            }
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
                env.CLIQ_DB_NAME,
                chunkErrors
            );
        }

        // ── Step 11: Store usage metrics ──
        if (llmCalls.length === 0) {
            logger.warn('No LLM calls recorded (all chunks failed), skipping usage metrics', { prNumber });
        } else {
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
        }

        message.ack();

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('Pipeline failed', error instanceof Error ? error : undefined, {
            prNumber,
        });

        // ── Step 12: Notification on Pipeline Crash ──
        if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
            try {
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
                    'failure',
                    { critical: 0, high: 0, medium: 0, low: 0 },
                    env.CLIQ_DB_NAME,
                    [errMsg]
                );
            } catch {
                logger.error('Could not post outer error to Cliq', undefined, { prNumber });
            }
        }

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

        message.retry();
    }
}
