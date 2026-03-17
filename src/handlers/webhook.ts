import type { Env } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS } from '../config/constants';
import { verifyWebhookSignature } from '../lib/security';

/**
 * Core webhook handler — called for every POST / request.
 *
 * Flow:
 * 1. Read body once (needed for both signature check and parsing)
 * 2. Verify HMAC-SHA256 signature
 * 3. Check X-GitHub-Event header and payload action
 * 4. Instead of processing here, we immediately push to Cloudflare Queues
 * 5. Return 202 immediately so GitHub doesn't time out
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

    console.log(
        `[code-reviewer] Webhook received for PR #${pr.number}: "${pr.title}" (${repository.full_name}) — sending to queue...`
    );

    // 5. Send ReviewMessage to the Queue
    await env.REVIEW_QUEUE.send({
        prNumber: pr.number,
        title: pr.title,
        diffUrl: pr.diff_url,
        repoFullName: repository.full_name
    });

    // 6. Respond immediately with 202 Accepted. The LLM handles the rest asynchronously.
    return new Response(
        JSON.stringify({
            message: 'Review queued in the background worker',
            pr: pr.number,
            repo: repository.full_name,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
}
