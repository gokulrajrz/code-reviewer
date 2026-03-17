import type { Env } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS } from '../config/constants';
import { verifyWebhookSignature } from '../lib/security';
import { getInstallationToken } from '../lib/github-auth';
import { createCheckRun } from '../lib/github';

/**
 * Core webhook handler — called for every POST / request.
 *
 * Flow:
 * 1. Read body once (needed for both signature check and parsing)
 * 2. Verify HMAC-SHA256 signature
 * 3. Check X-GitHub-Event header and payload action
 * 4. Get a GitHub App installation token
 * 5. Create a Check Run (skipped for ignored branches, in_progress for allowed)
 * 6. Push to Cloudflare Queues for background LLM processing
 * 7. Return 202 immediately so GitHub doesn't time out
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

    // 2. Check this is a pull_request event
    const githubEvent = request.headers.get('X-GitHub-Event');
    if (githubEvent !== 'pull_request') {
        return new Response(JSON.stringify({ message: `Ignored event: ${githubEvent}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 3. Parse payload
    let payload: PullRequestWebhookPayload;
    try {
        payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
    } catch {
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
    const token = await getInstallationToken(env);

    // 6. Filter by allowed target branches (if configured)
    if (env.ALLOWED_TARGET_BRANCHES) {
        const allowedBranches = env.ALLOWED_TARGET_BRANCHES.split(',').map(b => b.trim());
        if (!allowedBranches.includes(pr.base.ref)) {
            console.log(`[code-reviewer] Ignored PR #${pr.number} — target branch "${pr.base.ref}" is not in ALLOWED_TARGET_BRANCHES`);

            // Create a completed Check Run with "skipped" conclusion (grey badge!)
            await createCheckRun(repository.full_name, headSha, token, {
                status: 'completed',
                conclusion: 'skipped',
                summary: `Review skipped — target branch \`${pr.base.ref}\` is not in the allowed list (\`${env.ALLOWED_TARGET_BRANCHES}\`).`,
            });

            return new Response(
                JSON.stringify({ message: `Ignored: PR target branch "${pr.base.ref}" not allowed` }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }

    console.log(
        `[code-reviewer] Webhook received for PR #${pr.number}: "${pr.title}" (${repository.full_name}) — sending to queue...`
    );

    // 7. Create a Check Run with status "in_progress" (blocks merge)
    const checkRunId = await createCheckRun(repository.full_name, headSha, token, {
        status: 'in_progress',
        summary: 'AI Code Review is in progress. The LLM is analyzing your changes...',
    });

    // 8. Send ReviewMessage to the Queue (include checkRunId for the consumer to update)
    await env.REVIEW_QUEUE.send({
        prNumber: pr.number,
        title: pr.title,
        diffUrl: pr.diff_url,
        repoFullName: repository.full_name,
        headSha,
        checkRunId,
    });

    // 9. Respond immediately with 202 Accepted
    return new Response(
        JSON.stringify({
            message: 'Review queued in the background worker',
            pr: pr.number,
            repo: repository.full_name,
            sha: headSha,
            checkRunId,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
}
