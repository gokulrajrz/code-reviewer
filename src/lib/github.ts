import type { GitHubPRFile } from '../types/github';
import type { Env } from '../types/env';
import type { ReviewFinding } from '../types/review';
import { cachedGitHubFetch, CACHE_TTLS } from './cache';
import { createProgressiveChunks } from './progressive-chunking';
import { pluginRegistry } from './plugin-system';
import {
    MAX_FILE_SIZE_BYTES,
    MAX_TOTAL_FILES,
    TIER1_MAX_FILES,
    NOISE_EXTENSIONS,
    NOISE_FILENAMES,
    NOISE_DIRECTORIES,
    PRIORITY_EXTENSIONS,
    GLOBAL_CONTEXT_BUDGET_CHARS,
} from '../config/constants';
import { retryWithBackoff, circuitBreakers } from './retry';
import { logger } from './logger';
import { RateLimitError } from './errors';

const GITHUB_API_BASE = 'https://api.github.com';

function githubHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-reviewer-agent/1.0',
    };
}

// ---------------------------------------------------------------------------
// PR Data Fetching (with pagination)
// ---------------------------------------------------------------------------

/**
 * Fetches ALL files changed in a Pull Request, handling GitHub pagination.
 * GitHub returns max 100 files per page and max 3000 total.
 * We cap at MAX_TOTAL_FILES to stay practical.
 * Includes retry logic and circuit breaker protection.
 */
export async function fetchChangedFiles(
    repoFullName: string,
    prNumber: number,
    token: string,
    env: Env
): Promise<GitHubPRFile[]> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        throw new Error('GitHub API circuit breaker is OPEN - too many failures');
    }

    const executeFetch = async (): Promise<GitHubPRFile[]> => {
        const allFiles: GitHubPRFile[] = [];
        let page = 1;

        while (allFiles.length < MAX_TOTAL_FILES) {
            const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`;

            // Note: cachedGitHubFetch handles the 429 extraction automatically inside cache.ts
            const files = await cachedGitHubFetch<GitHubPRFile[]>(
                env,
                url,
                { headers: githubHeaders(token) },
                { ttlSeconds: CACHE_TTLS.PR_FILES, staleWhileRevalidate: true },
                async (u, i) => fetch(u, i)
            );

            if (files.length === 0) break; // No more pages

            allFiles.push(...files);
            page++;

            // GitHub caps at 3000 files; stop if we got fewer than 100 (last page)
            if (files.length < 100) break;
        }

        // Filter out deleted files (they have no content to review)
        return allFiles
            .filter((f) => f.status !== 'removed')
            .slice(0, MAX_TOTAL_FILES);
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeFetch,
            'GitHub fetch changed files',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`GitHub API call succeeded after ${attempts} attempts`, {
                operation: 'fetchChangedFiles',
                attempts,
                totalDelayMs,
            });
        }

        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Smart File Classification
// ---------------------------------------------------------------------------

/** The result of classifying PR files into review tiers. */
export interface ClassifiedFiles {
    /** Top priority files — get full content + diff patch */
    tier1: GitHubPRFile[];
    /** Remaining files — get diff patch only (no subrequest) */
    tier2: GitHubPRFile[];
    /** Filenames that were auto-skipped (noise) */
    skipped: string[];
}

/**
 * Returns true if the file should be auto-skipped (noise, generated, vendor, etc.)
 */
function isNoiseFile(file: GitHubPRFile): boolean {
    const filename = file.filename;
    const basename = filename.split('/').pop() ?? '';
    const ext = basename.includes('.') ? basename.split('.').pop()?.toLowerCase() ?? '' : '';

    // Check exact filename matches
    if (NOISE_FILENAMES.has(basename)) return true;

    // Check extension matches
    if (NOISE_EXTENSIONS.has(ext)) return true;

    // Check for compound extensions like .min.js, .chunk.css
    const lastTwoParts = basename.split('.').slice(-2).join('.');
    if (NOISE_EXTENSIONS.has(lastTwoParts)) return true;

    // Check directory prefix matches
    for (const dir of NOISE_DIRECTORIES) {
        if (filename.startsWith(dir) || filename.includes(`/${dir}`)) return true;
    }

    // Skip files with no patch AND no meaningful content (binary files)
    if (!file.patch && file.changes === 0) return true;

    return false;
}

/**
 * Calculates a priority score for a file.
 * Higher score = more important to review deeply.
 */
function filePriorityScore(file: GitHubPRFile): number {
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
    let score = file.additions + file.deletions; // Raw change volume

    // Bonus for source code files (business logic)
    if (PRIORITY_EXTENSIONS.has(ext)) {
        score *= 2;
    }

    // Bonus for new files (they need careful review)
    if (file.status === 'added') {
        score *= 1.5;
    }

    // Bonus for files in src/ or app/ directories (likely core code)
    if (file.filename.startsWith('src/') || file.filename.startsWith('app/')) {
        score *= 1.3;
    }

    return score;
}

/**
 * Classifies PR files into review tiers:
 * - **Tier 1** (top TIER1_MAX_FILES by priority): Full content + diff patch
 * - **Tier 2** (remaining reviewable files): Diff patch only
 * - **Skipped**: Noise files excluded from review entirely
 */
export function classifyFiles(files: GitHubPRFile[]): ClassifiedFiles {
    const skipped: string[] = [];
    const reviewable: GitHubPRFile[] = [];

    // Step 1: Separate noise from reviewable
    for (const file of files) {
        if (isNoiseFile(file)) {
            skipped.push(file.filename);
        } else {
            reviewable.push(file);
        }
    }

    // Step 2: Sort reviewable files by priority score (highest first)
    reviewable.sort((a, b) => filePriorityScore(b) - filePriorityScore(a));

    // Step 3: Split into Tier 1 (full context) and Tier 2 (diff only)
    const tier1 = reviewable.slice(0, TIER1_MAX_FILES);
    const tier2 = reviewable.slice(TIER1_MAX_FILES);

    return { tier1, tier2, skipped };
}

// ---------------------------------------------------------------------------
// File Content Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches the raw content of a file from its raw_url.
 * Returns null if the file is too large or the request fails.
 * Includes retry logic for transient failures.
 */
export async function fetchFileContent(rawUrl: string, token: string, env: Env): Promise<string | null> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping file content fetch');
        return null;
    }

    const executeFetch = async (): Promise<string | null> => {
        const text = await cachedGitHubFetch<string>(
            env,
            rawUrl,
            { headers: githubHeaders(token) },
            { ttlSeconds: CACHE_TTLS.FILE_CONTENT, staleWhileRevalidate: true },
            async (u, i) => {
                const response = await fetch(u, i);

                // Extra safety check during fetch before reading body
                const contentLength = response.headers.get('Content-Length');
                if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
                    // Fast abort for huge files
                    throw new Error(`FILE_TOO_LARGE:${contentLength}`);
                }
                return response;
            },
            'text'
        ).catch(err => {
            if (err.message.startsWith('FILE_TOO_LARGE:')) {
                const size = err.message.split(':')[1];
                return `[File too large to include — ${size} bytes. Review diff only.]`;
            }
            throw err;
        });

        // If it was already caught for size in the fast path, return it directly
        if (text && text.startsWith('[File too large to include')) {
            return text;
        }

        // Secondary size check on the body itself (sometimes Content-Length is missing)
        if (text.length > MAX_FILE_SIZE_BYTES) {
            return `[File too large to include — ${text.length} chars. Review diff only.]`;
        }

        return text;
    };

    try {
        const { result } = await retryWithBackoff(
            executeFetch,
            'GitHub fetch file content',
            {
                maxAttempts: 2, // Fewer retries for file content (not critical)
                initialDelayMs: 500,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();
        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        return null; // Fail gracefully - return null to use diff only
    }
}

// ---------------------------------------------------------------------------
// Global PR Context (prepended to EVERY chunk)
// ---------------------------------------------------------------------------

/**
 * Builds a global context string that gets prepended to every chunk.
 * This ensures every LLM call knows the full scope of the PR,
 * even if it only sees a subset of the files.
 */
export function buildGlobalContext(classified: ClassifiedFiles): string {
    const { tier1, tier2, skipped } = classified;
    const allReviewable = [...tier1, ...tier2];

    let ctx = `# Global PR Context\n\n`;
    ctx += `> This context appears in every review chunk so you understand the full PR scope.\n\n`;
    ctx += `## Files in This PR (${allReviewable.length} reviewable, ${skipped.length} skipped)\n\n`;

    // Table header
    ctx += `| Tier | File | Status | +/- |\n|---|---|---|---|\n`;

    for (const f of tier1) {
        ctx += `| 🔍 T1 | \`${f.filename}\` | ${f.status} | +${f.additions}/-${f.deletions} |\n`;
    }
    for (const f of tier2) {
        ctx += `| 📄 T2 | \`${f.filename}\` | ${f.status} | +${f.additions}/-${f.deletions} |\n`;
    }

    if (skipped.length > 0) {
        const preview = skipped.slice(0, 15).join(', ');
        ctx += `\n> _Skipped (noise):_ ${preview}${skipped.length > 15 ? ` ... +${skipped.length - 15} more` : ''}\n`;
    }

    ctx += `\n---\n\n`;

    // If the global context is too large (huge PRs), truncate the file list
    if (ctx.length > GLOBAL_CONTEXT_BUDGET_CHARS) {
        ctx = ctx.slice(0, GLOBAL_CONTEXT_BUDGET_CHARS - 100);
        ctx += `\n\n_[... file list truncated — ${allReviewable.length} total files]_\n\n---\n\n`;
    }

    return ctx;
}

// ---------------------------------------------------------------------------
// Safe File Splitting
// ---------------------------------------------------------------------------

/**
 * Splits a large file block into multiple parts at line boundaries.
 * Unlike the old approach, NO data is permanently lost.
 *
 * Each part is labeled: "Part 1 of N", "Part 2 of N", etc.
 * so the LLM knows a file continues across chunks.
 */
function splitLargeFileBlock(
    filename: string,
    fileBlock: string,
    maxChars: number
): string[] {
    const parts: string[] = [];
    let remaining = fileBlock;

    while (remaining.length > 0) {
        if (remaining.length <= maxChars) {
            parts.push(remaining);
            break;
        }

        // Find the last newline before maxChars to avoid cutting mid-line
        let splitPoint = remaining.lastIndexOf('\n', maxChars);
        if (splitPoint <= 0) {
            // No newline found? Force split at maxChars (extremely rare — binary or minified)
            splitPoint = maxChars;
        }

        parts.push(remaining.slice(0, splitPoint));
        remaining = remaining.slice(splitPoint);
    }

    // If we split, label each part
    if (parts.length > 1) {
        return parts.map((part, i) =>
            `## ⚠️ FILE: \`${filename}\` — Part ${i + 1} of ${parts.length}\n\n${part}\n\n---\n\n`
        );
    }

    return parts;
}

// ---------------------------------------------------------------------------
// Tiered Chunk Building (Fixed)
// ---------------------------------------------------------------------------

/**
 * Builds a file block for a Tier 1 file (full content + diff patch).
 * Uses progressive-chunking to safely split large files along AST boundaries
 * before formatting as markdown, ensuring code fences remain intact.
 */
async function buildTier1Block(
    file: GitHubPRFile,
    token: string,
    env: Env,
    prContext: { title: string; repoFullName: string; prNumber: number },
    effectiveMax: number
): Promise<{ blocks: string[]; findings: ReviewFinding[] }> {
    const findings: ReviewFinding[] = [];
    const content = await fetchFileContent(file.raw_url, token, env);

    // Run analyzer plugins on the full file content before chunking
    if (content && !content.startsWith('[File too large')) {
        try {
            const pluginResult = await pluginRegistry.analyzeFile({
                filename: file.filename,
                content: content,
                prTitle: prContext.title,
                repoFullName: prContext.repoFullName,
                prNumber: prContext.prNumber
            });
            findings.push(...pluginResult.findings);
        } catch (error) {
            logger.error('Plugin execution failed', error instanceof Error ? error : undefined, {
                filename: file.filename
            });
        }
    }

    // Determine how to chunk the file content
    const ext = file.filename.split('.').pop() ?? '';
    let contentChunks = [content || ''];

    if (content && !content.startsWith('[File too large')) {
        // Estimate the overhead of the wrapper (diff patch, headers, fences)
        const wrapperOverhead = (file.patch?.length || 0) + 500;
        const maxCodeChars = effectiveMax - wrapperOverhead;

        if (content.length > maxCodeChars && maxCodeChars > 1000) {
            // Use advanced progressive chunking
            contentChunks = createProgressiveChunks(content, maxCodeChars);
        }
    }

    // Wrap each content chunk in markdown
    const blocks: string[] = [];
    const isMultiPart = contentChunks.length > 1;

    for (let i = 0; i < contentChunks.length; i++) {
        const chunkContent = contentChunks[i];
        const partLabel = isMultiPart ? ` — Part ${i + 1} of ${contentChunks.length}` : '';
        let block = `## 🔍 FILE CHANGED: \`${file.filename}\` (${file.status})${partLabel} — *Full Review*\n`;

        if (file.patch) {
            block += `### DIFF PATCH\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
        } else {
            block += `_(No diff patch available)_\n`;
        }

        if (chunkContent && !chunkContent.startsWith('[File too large')) {
            block += `\n### FULL FILE CONTENT${partLabel}\n\`\`\`${ext}\n${chunkContent}\n\`\`\`\n`;
        } else if (chunkContent) {
            block += `\n${chunkContent}\n`;
        }

        block += `\n---\n\n`;
        blocks.push(block);
    }

    return { blocks, findings };
}

/**
 * Builds a file block for a Tier 2 file (diff patch only — no subrequest).
 */
function buildTier2Block(file: GitHubPRFile): string {
    let block = `## 📄 FILE CHANGED: \`${file.filename}\` (${file.status}) — *Diff Only*\n`;

    if (file.patch) {
        block += `### DIFF PATCH\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    } else {
        block += `_(No diff patch available — binary or empty change)_\n`;
    }

    block += `\n---\n\n`;
    return block;
}

/** Return type for buildReviewChunks — includes global context for the synthesizer. */
export interface ReviewChunksResult {
    /** The code chunks to send to chunk reviewers (Map phase) */
    chunks: string[];
    /** The global PR context string (for use in the Reduce phase) */
    globalContext: string;
    /** All reviewable filenames (for the synthesizer payload) */
    allFiles: string[];
    /** Findings generated by local plugins */
    pluginFindings: ReviewFinding[];
}

/**
 * Builds review chunks using the tiered classification system.
 *
 * Key improvements over the old implementation:
 * 1. Global context is prepended to EVERY chunk (not just the first)
 * 2. Large files are split at line boundaries (never permanently truncated)
 * 3. Returns structured metadata alongside chunks
 *
 * Chunks are split when they exceed `maxChunkChars`.
 */
export async function buildReviewChunks(
    classified: ClassifiedFiles,
    token: string,
    maxChunkChars: number,
    env: Env,
    prContext: { title: string; repoFullName: string; prNumber: number }
): Promise<ReviewChunksResult> {
    const { tier1, tier2, skipped } = classified;
    const globalContext = buildGlobalContext(classified);
    const allFiles = [...tier1, ...tier2].map(f => f.filename);
    const pluginFindings: ReviewFinding[] = [];

    const chunks: string[] = [];
    let currentChunkText = '';

    // Helper: flush current chunk text into the chunks array with global context
    const flushChunk = () => {
        if (currentChunkText) {
            chunks.push(globalContext + currentChunkText);
            currentChunkText = '';
        }
    };

    // Effective max for content (after global context is prepended)
    const effectiveMax = maxChunkChars - globalContext.length;
    if (effectiveMax < 10_000) {
        logger.warn('Global context is very large, reducing effective chunk size', {
            globalContextLength: globalContext.length,
            effectiveMax,
        });
    }

    // ── Process Tier 1 files (full content, uses subrequests) ──
    for (const file of tier1) {
        const { blocks, findings } = await buildTier1Block(file, token, env, prContext, effectiveMax);
        pluginFindings.push(...findings);

        for (const fileBlock of blocks) {
            if (fileBlock.length > effectiveMax) {
                // Failsafe: if still too large, flush current and put it alone
                flushChunk();
                chunks.push(globalContext + fileBlock);
            } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
                // Adding this file would exceed the chunk limit — start a new chunk
                flushChunk();
                currentChunkText = fileBlock;
            } else {
                currentChunkText += fileBlock;
            }
        }
    }

    // ── Process Tier 2 files (diff only, no subrequests) ──
    for (const file of tier2) {
        const fileBlock = buildTier2Block(file);

        if (fileBlock.length > effectiveMax) {
            flushChunk();
            const parts = splitLargeFileBlock(file.filename, fileBlock, effectiveMax);
            for (const part of parts) {
                chunks.push(globalContext + part);
            }
        } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
            flushChunk();
            currentChunkText = fileBlock;
        } else {
            currentChunkText += fileBlock;
        }
    }

    // Flush any remaining content
    flushChunk();

    const finalChunks = chunks.length > 0 ? chunks : [globalContext + 'No verifiable file changes found.'];

    return {
        chunks: finalChunks,
        globalContext,
        allFiles,
        pluginFindings,
    };
}

// ---------------------------------------------------------------------------
// PR Comments
// ---------------------------------------------------------------------------

/**
 * Posts a review comment on a GitHub Pull Request.
 * Includes retry logic for transient failures.
 */
export async function postPRComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    token: string
): Promise<void> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping PR comment');
        throw new Error('GitHub API circuit breaker is OPEN');
    }

    const executePost = async (): Promise<void> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/issues/${prNumber}/comments`;

        // GitHub limits the body field to 65536 characters
        const truncatedBody = body.length > 65000
            ? body.slice(0, 65000) + '\n\n_[Comment truncated due to GitHub length limits]_'
            : body;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body: truncatedBody }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to post PR comment: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }
    };

    try {
        const { attempts, totalDelayMs } = await retryWithBackoff(
            executePost,
            'GitHub post PR comment',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`PR comment posted after ${attempts} attempts`, {
                attempts,
                totalDelayMs,
            });
        }
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Check Runs API (requires GitHub App authentication)
// ---------------------------------------------------------------------------

type CheckRunConclusion =
    | 'action_required'
    | 'cancelled'
    | 'failure'
    | 'neutral'
    | 'success'
    | 'skipped'
    | 'timed_out';

interface CheckRunResponse {
    id: number;
    status: string;
    conclusion: string | null;
}

/**
 * Creates a new Check Run on a commit.
 * Returns the check run ID for later updates.
 * Includes retry logic and circuit breaker protection.
 */
export async function createCheckRun(
    repoFullName: string,
    headSha: string,
    token: string,
    options: {
        status: 'queued' | 'in_progress' | 'completed';
        conclusion?: CheckRunConclusion;
        summary?: string;
    }
): Promise<number> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        throw new Error('GitHub API circuit breaker is OPEN - too many failures');
    }

    const executeCreate = async (): Promise<number> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/check-runs`;

        const body: Record<string, unknown> = {
            name: 'AI Code Reviewer',
            head_sha: headSha,
            status: options.status,
        };

        if (options.conclusion) {
            body.conclusion = options.conclusion;
        }

        if (options.summary || options.conclusion) {
            body.output = {
                title: options.conclusion === 'skipped'
                    ? 'Review Skipped'
                    : options.conclusion === 'success'
                        ? 'Review Approved'
                        : options.conclusion === 'failure'
                            ? 'Changes Requested'
                            : 'AI Code Review',
                summary: options.summary ?? 'AI Code Review in progress...',
            };
        }

        // If completed, record the completion timestamp
        if (options.status === 'completed') {
            body.completed_at = new Date().toISOString();
        }
        body.started_at = new Date().toISOString();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to create check run: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }

        const data: CheckRunResponse = await response.json();
        return data.id;
    };

    try {
        const { result, attempts } = await retryWithBackoff(
            executeCreate,
            'GitHub create check run',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`Check run created after ${attempts} attempts`, {
                checkRunId: result,
                attempts,
            });
        }

        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

/**
 * Updates an existing Check Run with the final conclusion and summary.
 * Includes retry logic for transient failures.
 */
export async function updateCheckRun(
    repoFullName: string,
    checkRunId: number,
    token: string,
    conclusion: CheckRunConclusion,
    summary: string,
): Promise<void> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping check run update');
        return; // Non-critical: don't throw
    }

    const executeUpdate = async (): Promise<void> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/check-runs/${checkRunId}`;

        const title = conclusion === 'success'
            ? 'Review Approved'
            : conclusion === 'failure'
                ? 'Changes Requested'
                : 'AI Code Review';

        // GitHub limits the summary field to 65535 characters
        const truncatedSummary = summary.length > 65000
            ? summary.slice(0, 65000) + '\n\n_[Summary truncated due to length]_'
            : summary;

        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                status: 'completed',
                conclusion,
                completed_at: new Date().toISOString(),
                output: {
                    title,
                    summary: truncatedSummary,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to update check run: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }
    };

    try {
        const { attempts } = await retryWithBackoff(
            executeUpdate,
            'GitHub update check run',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`Check run updated after ${attempts} attempts`, {
                checkRunId,
                attempts,
            });
        }
    } catch (error) {
        circuitBreakers.github.recordFailure();
        logger.error('Failed to update check run', error instanceof Error ? error : undefined, {
            checkRunId,
        });
        // Non-critical: don't throw
    }
}
