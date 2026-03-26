import type { GitHubPRFile } from '../types/github';
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
 */
export async function fetchChangedFiles(
    repoFullName: string,
    prNumber: number,
    token: string
): Promise<GitHubPRFile[]> {
    const allFiles: GitHubPRFile[] = [];
    let page = 1;

    while (allFiles.length < MAX_TOTAL_FILES) {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`;
        const response = await fetch(url, { headers: githubHeaders(token) });

        if (!response.ok) {
            throw new Error(`Failed to fetch PR files (page ${page}): ${response.status} ${response.statusText}`);
        }

        const files: GitHubPRFile[] = await response.json();

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
 */
export async function fetchFileContent(rawUrl: string, token: string): Promise<string | null> {
    try {
        const response = await fetch(rawUrl, { headers: githubHeaders(token) });

        if (!response.ok) return null;

        // Guard against massive files
        const contentLength = response.headers.get('Content-Length');
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
            return `[File too large to include — ${contentLength} bytes. Review diff only.]`;
        }

        const text = await response.text();

        // Secondary size check on the body itself
        if (text.length > MAX_FILE_SIZE_BYTES) {
            return `[File too large to include — ${text.length} chars. Review diff only.]`;
        }

        return text;
    } catch {
        return null;
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
 */
async function buildTier1Block(file: GitHubPRFile, token: string): Promise<string> {
    let block = `## 🔍 FILE CHANGED: \`${file.filename}\` (${file.status}) — *Full Review*\n`;

    if (file.patch) {
        block += `### DIFF PATCH\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    } else {
        block += `_(No diff patch available)_\n`;
    }

    const content = await fetchFileContent(file.raw_url, token);
    if (content && !content.startsWith('[File too large')) {
        const ext = file.filename.split('.').pop() ?? '';
        block += `\n### FULL FILE CONTENT\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
    } else if (content) {
        block += `\n${content}\n`;
    }

    block += `\n---\n\n`;
    return block;
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
    maxChunkChars: number
): Promise<ReviewChunksResult> {
    const { tier1, tier2, skipped } = classified;
    const globalContext = buildGlobalContext(classified);
    const allFiles = [...tier1, ...tier2].map(f => f.filename);

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
        console.warn(`[github] Global context is very large (${globalContext.length} chars), reducing effective chunk size`);
    }

    // ── Process Tier 1 files (full content, uses subrequests) ──
    for (const file of tier1) {
        const fileBlock = await buildTier1Block(file, token);

        if (fileBlock.length > effectiveMax) {
            // File is larger than a single chunk — split it safely
            flushChunk();
            const parts = splitLargeFileBlock(file.filename, fileBlock, effectiveMax);
            for (const part of parts) {
                chunks.push(globalContext + part);
            }
        } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
            // Adding this file would exceed the chunk limit — start a new chunk
            flushChunk();
            currentChunkText = fileBlock;
        } else {
            currentChunkText += fileBlock;
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
    };
}

// ---------------------------------------------------------------------------
// PR Comments
// ---------------------------------------------------------------------------

/**
 * Posts a review comment on a GitHub Pull Request.
 */
export async function postPRComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    token: string
): Promise<void> {
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
        throw new Error(`Failed to post PR comment: ${response.status} — ${errorText}`);
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
        throw new Error(`Failed to create check run: ${response.status} — ${errorText}`);
    }

    const data: CheckRunResponse = await response.json();
    console.log(`[github] Created check run #${data.id} (status=${options.status}, conclusion=${options.conclusion ?? 'n/a'})`);
    return data.id;
}

/**
 * Updates an existing Check Run with the final conclusion and summary.
 */
export async function updateCheckRun(
    repoFullName: string,
    checkRunId: number,
    token: string,
    conclusion: CheckRunConclusion,
    summary: string,
): Promise<void> {
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
        console.error(`[github] Failed to update check run: ${response.status} — ${errorText}`);
    } else {
        console.log(`[github] Updated check run #${checkRunId} → conclusion=${conclusion}`);
    }
}
