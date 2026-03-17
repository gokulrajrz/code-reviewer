import type { GitHubPRFile } from '../types/github';
import { MAX_CONTEXT_FILES, MAX_FILE_SIZE_BYTES } from '../config/constants';

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
// PR Data Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches the raw unified diff for a Pull Request.
 */
export async function fetchPRDiff(diffUrl: string, token: string): Promise<string> {
    const response = await fetch(diffUrl, {
        headers: {
            ...githubHeaders(token),
            Accept: 'application/vnd.github.diff',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}`);
    }

    return response.text();
}

/**
 * Fetches the list of files changed in a Pull Request.
 * Returns up to MAX_CONTEXT_FILES non-deleted files.
 */
export async function fetchChangedFiles(
    repoFullName: string,
    prNumber: number,
    token: string
): Promise<GitHubPRFile[]> {
    // GitHub paginates at 30 by default; we request up to 100
    const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`;
    const response = await fetch(url, { headers: githubHeaders(token) });

    if (!response.ok) {
        throw new Error(`Failed to fetch PR files: ${response.status} ${response.statusText}`);
    }

    const files: GitHubPRFile[] = await response.json();

    // Filter out deleted files (they have no content to review) and limit count
    return files
        .filter((f) => f.status !== 'removed')
        .slice(0, MAX_CONTEXT_FILES);
}

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

/**
 * Builds a rich context string for the LLM by assembling the diff +
 * full content of the most important changed files.
 */
export async function buildReviewContext(
    diff: string,
    files: GitHubPRFile[],
    token: string,
    maxDiffChars: number
): Promise<string> {
    const truncatedDiff =
        diff.length > maxDiffChars
            ? diff.slice(0, maxDiffChars) + '\n\n[... diff truncated due to size ...]'
            : diff;

    const parts: string[] = [
        '## PULL REQUEST DIFF\n```diff\n' + truncatedDiff + '\n```',
    ];

    // Fetch and append full file contents for richer context
    const fileContexts = await Promise.all(
        files.map(async (file) => {
            const content = await fetchFileContent(file.raw_url, token);
            if (!content) return null;
            const ext = file.filename.split('.').pop() ?? '';
            return `## FULL FILE: \`${file.filename}\` (${file.status})\n\`\`\`${ext}\n${content}\n\`\`\``;
        })
    );

    for (const ctx of fileContexts) {
        if (ctx) parts.push(ctx);
    }

    return parts.join('\n\n---\n\n');
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
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            ...githubHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
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
