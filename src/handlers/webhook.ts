import type { Env } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS } from '../config/constants';
import { verifyWebhookSignature } from '../lib/security';
import { getInstallationToken } from '../lib/github-auth';
import { createCheckRun, getPullRequest } from '../lib/github';

// ---------------------------------------------------------------------------
// Issue Comment Payload (for Human-in-the-Loop)
// ---------------------------------------------------------------------------

interface IssueCommentPayload {
    action: 'created' | 'edited' | 'deleted';
    comment: {
        body: string;
        user: { login: string };
    };
    issue: {
        number: number;
        pull_request?: { url: string };
    };
    repository: {
        full_name: string;
    };
}

/**
 * Core webhook handler — called for every POST / request.
 *
 * Flow:
 * 1. Read body once (needed for both signature check and parsing)
 * 2. Verify HMAC-SHA256 signature
 * 3. Route by X-GitHub-Event:
 *    - `pull_request`: Standard PR review flow
 *    - `issue_comment`: Human-in-the-Loop `/override-ai` handler
 * 4. Return 202 immediately so GitHub doesn't time out
 */
export async function handlePRWebhook(
    request: Request,
    env: Env
): Promise<Response> {
    // — Read body once —
    const rawBody = await request.text();

    // 1. Verify webhook signature
    const isValid = await verifyWebhookSignature(request, rawBody, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
        console.error('[code-reviewer] Invalid webhook signature — request rejected');
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 2. Route by event type
    const githubEvent = request.headers.get('X-GitHub-Event');

    if (githubEvent === 'issue_comment') {
        return handleIssueComment(rawBody, env);
    }

    if (githubEvent !== 'pull_request') {
        return new Response(JSON.stringify({ message: `Ignored event: ${githubEvent}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 3. Parse pull_request payload
    let payload: PullRequestWebhookPayload;
    try {
        payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
    } catch {
        console.error('[code-reviewer] Failed to parse webhook JSON payload');
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 4. Only process reviewable actions
    if (!REVIEWABLE_ACTIONS.has(payload.action)) {
        return new Response(
            JSON.stringify({ message: `Ignored PR action: ${payload.action}` }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const { pull_request: pr, repository } = payload;
    const headSha = pr.head.sha;

    // 5. Get GitHub App installation token
    let token: string;
    try {
        token = await getInstallationToken(env);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[code-reviewer] ❌ GitHub App auth failed: ${errMsg}`);
        return new Response(
            JSON.stringify({ error: 'GitHub App authentication failed', detail: errMsg }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // 6. Filter by allowed target branches (if configured)
    if (env.ALLOWED_TARGET_BRANCHES) {
        const allowedBranches = env.ALLOWED_TARGET_BRANCHES.split(',').map(b => b.trim());
        if (!allowedBranches.includes(pr.base.ref)) {
            console.log(`[code-reviewer] Ignored PR #${pr.number} — target branch "${pr.base.ref}" is not in ALLOWED_TARGET_BRANCHES`);

            // Create a completed Check Run with "skipped" conclusion
            try {
                await createCheckRun(repository.full_name, headSha, token, {
                    status: 'completed',
                    conclusion: 'skipped',
                    summary: `Review skipped — target branch \`${pr.base.ref}\` is not in the allowed list (\`${env.ALLOWED_TARGET_BRANCHES}\`).`,
                });
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[code-reviewer] ⚠️ Failed to create skipped Check Run: ${errMsg}`);
            }

            return new Response(
                JSON.stringify({ message: `Ignored: PR target branch "${pr.base.ref}" not allowed` }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }

    console.log(
        `[code-reviewer] Webhook received for PR #${pr.number}: "${pr.title}" (${repository.full_name}) — sending to queue...`
    );

    // 7. Create a Check Run with status "in_progress"
    let checkRunId: number | null = null;
    try {
        checkRunId = await createCheckRun(repository.full_name, headSha, token, {
            status: 'in_progress',
            summary: '🤖 AI Multi-Agent Code Review is in progress. Three expert agents (Security, Performance, Clean Code) are analyzing your changes...',
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[code-reviewer] ⚠️ Failed to create in_progress Check Run: ${errMsg}`);
    }

    // 8. Send ReviewMessage to the Queue
    try {
        await env.REVIEW_QUEUE.send({
            prNumber: pr.number,
            title: pr.title,
            diffUrl: pr.diff_url,
            repoFullName: repository.full_name,
            headSha,
            checkRunId: checkRunId ?? 0,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[code-reviewer] ❌ Failed to enqueue review: ${errMsg}`);
        return new Response(
            JSON.stringify({ error: 'Failed to enqueue review job', detail: errMsg }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // 9. Respond immediately with 202 Accepted
    return new Response(
        JSON.stringify({
            message: 'Multi-agent review queued in the background worker',
            pr: pr.number,
            repo: repository.full_name,
            sha: headSha,
            checkRunId,
            pipeline: 'multi-agent (security + performance + clean-code)',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
}

// ---------------------------------------------------------------------------
// Human-in-the-Loop: /override-ai Comment Handler
// ---------------------------------------------------------------------------

/**
 * Handles `issue_comment` events for the Human-in-the-Loop gate.
 *
 * When a maintainer comments `/override-ai` on a PR where the agent
 * has halted due to Critical findings, this handler re-enqueues the
 * review for publication.
 */
async function handleIssueComment(
    rawBody: string,
    env: Env
): Promise<Response> {
    let payload: IssueCommentPayload;
    try {
        payload = JSON.parse(rawBody) as IssueCommentPayload;
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Only handle new comments on PRs
    if (payload.action !== 'created' || !payload.issue.pull_request) {
        return new Response(JSON.stringify({ message: 'Ignored comment event' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const commentBody = payload.comment.body.trim().toLowerCase();

    if (commentBody === '/override-ai') {
        console.log(
            `[code-reviewer] 🔓 /override-ai received from @${payload.comment.user.login} ` +
            `on PR #${payload.issue.number} (${payload.repository.full_name})`
        );

        // 1. Get auth token
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            console.error(`[code-reviewer] ❌ /override-ai auth failed:`, error);
            return new Response(JSON.stringify({ error: 'GitHub App auth failed' }), { status: 500 });
        }

        // 2. Fetch PR details (since issue_comment doesn't contain head.sha)
        let pr;
        try {
            pr = await getPullRequest(payload.repository.full_name, payload.issue.number, token);
        } catch (error) {
            console.error(`[code-reviewer] ❌ /override-ai PR fetch failed:`, error);
            return new Response(JSON.stringify({ error: 'Failed to fetch PR details' }), { status: 500 });
        }

        // 3. Create a new Check Run for the override review
        let checkRunId: number | null = null;
        try {
            checkRunId = await createCheckRun(payload.repository.full_name, pr.headSha, token, {
                status: 'in_progress',
                summary: `🤖 Manual Override by @${payload.comment.user.login}. Re-running review and forcing publish...`,
            });
        } catch (error) {
            console.error(`[code-reviewer] ⚠️ /override-ai Check Run failed:`, error);
        }

        // 4. Dispatch to queue with isOverride = true
        try {
            await env.REVIEW_QUEUE.send({
                prNumber: payload.issue.number,
                title: pr.title,
                diffUrl: pr.diffUrl,
                repoFullName: payload.repository.full_name,
                headSha: pr.headSha,
                checkRunId: checkRunId ?? 0,
                isOverride: true,
            });
        } catch (error) {
            console.error(`[code-reviewer] ❌ /override-ai queue dispatch failed:`, error);
            return new Response(JSON.stringify({ error: 'Failed to enqueue override' }), { status: 500 });
        }

        return new Response(
            JSON.stringify({
                message: 'Override acknowledged. Full review will be published.',
                pr: payload.issue.number,
                overriddenBy: payload.comment.user.login,
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (commentBody === '/dismiss-ai') {
        console.log(
            `[code-reviewer] ❌ /dismiss-ai received from @${payload.comment.user.login} ` +
            `on PR #${payload.issue.number} (${payload.repository.full_name})`
        );

        return new Response(
            JSON.stringify({
                message: 'AI review dismissed.',
                pr: payload.issue.number,
                dismissedBy: payload.comment.user.login,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    }

    return new Response(JSON.stringify({ message: 'Ignored comment' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
