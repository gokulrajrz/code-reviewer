import type { Env } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS } from '../config/constants';
import { verifyWebhookSignature } from '../lib/security';
import { getInstallationToken } from '../lib/github-auth';
import { createCheckRun } from '../lib/github';
import { checkPayloadSize } from '../lib/payload-limit';
import { isDuplicateWebhook } from '../lib/webhook-dedup';
import { createSecureJsonResponse } from '../lib/security-headers';
import { logger } from '../lib/logger';
import { getRequestId } from '../lib/request-context';

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
    // — 0. Check payload size limit (before reading body) —
    const sizeCheck = checkPayloadSize(request, { maxBytes: 5 * 1024 * 1024 }); // 5MB
    if (sizeCheck) {
        logger.warn('Webhook rejected: payload too large', {
            size: request.headers.get('Content-Length'),
            path: new URL(request.url).pathname,
        });
        return sizeCheck;
    }

    // — Read body once (needed for signature verification) —
    const rawBody = await request.text();

    // 1. Verify webhook signature FIRST (security: prevent cache pollution)
    const isValid = await verifyWebhookSignature(request, rawBody, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
        logger.error('Invalid webhook signature — request rejected');
        return createSecureJsonResponse(
            { error: 'Invalid signature' },
            401
        );
    }

    // 2. Check for duplicate webhook delivery (after signature verification)
    const isDuplicate = await isDuplicateWebhook(request, env);
    if (isDuplicate) {
        logger.info('Duplicate webhook detected, returning 200 to acknowledge');
        return createSecureJsonResponse(
            { message: 'Duplicate delivery ID - already processed' },
            200
        );
    }

    // 3. Check this is a pull_request event
    const githubEvent = request.headers.get('X-GitHub-Event');
    if (githubEvent !== 'pull_request') {
        return createSecureJsonResponse(
            { message: `Ignored event: ${githubEvent}` },
            200
        );
    }

    // 4. Parse payload
    let payload: PullRequestWebhookPayload;
    try {
        payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
    } catch {
        logger.error('Failed to parse webhook JSON payload');
        return createSecureJsonResponse(
            { error: 'Invalid JSON payload' },
            400
        );
    }

    // 4. Only process reviewable actions
    if (!REVIEWABLE_ACTIONS.has(payload.action)) {
        return createSecureJsonResponse(
            { message: `Ignored PR action: ${payload.action}` },
            200
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
        logger.error('GitHub App auth failed', error instanceof Error ? error : undefined);
        return createSecureJsonResponse(
            { error: 'GitHub App authentication failed', detail: errMsg },
            500
        );
    }

    // 6. Filter by allowed target branches (if configured)
    if (env.ALLOWED_TARGET_BRANCHES) {
        const allowedBranches = env.ALLOWED_TARGET_BRANCHES.split(',').map(b => b.trim());
        if (!allowedBranches.includes(pr.base.ref)) {
            logger.info(`Ignored PR #${pr.number} — target branch not in ALLOWED_TARGET_BRANCHES`, {
                prNumber: pr.number,
                targetBranch: pr.base.ref,
            });

            // Create a completed Check Run with "skipped" conclusion (grey badge!)
            try {
                await createCheckRun(repository.full_name, headSha, token, {
                    status: 'completed',
                    conclusion: 'skipped',
                    summary: `Review skipped — target branch \`${pr.base.ref}\` is not in the allowed list (\`${env.ALLOWED_TARGET_BRANCHES}\`).`,
                });
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.warn('Failed to create skipped Check Run', { error: errMsg });
                // Non-fatal: we still return the ignore response
            }

            return createSecureJsonResponse(
                { message: `Ignored: PR target branch "${pr.base.ref}" not allowed` },
                200
            );
        }
    }

    logger.info('Webhook received for PR — sending to queue', {
        prNumber: pr.number,
        title: pr.title,
        repo: repository.full_name,
    });

    // 7. Create a Check Run with status "in_progress" (blocks merge)
    let checkRunId: number | null = null;
    try {
        checkRunId = await createCheckRun(repository.full_name, headSha, token, {
            status: 'in_progress',
            summary: 'AI Code Review is in progress. The LLM is analyzing your changes...',
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to create in_progress Check Run', { error: errMsg });
        // Non-fatal: the queue consumer will still process the review
    }

    // 8. Send ReviewMessage to the Queue (include checkRunId for the consumer to update)
    // Pass the requestId for distributed tracing
    try {
        await env.REVIEW_QUEUE.send({
            prNumber: pr.number,
            title: pr.title,
            diffUrl: pr.diff_url,
            repoFullName: repository.full_name,
            headSha,
            checkRunId: checkRunId ?? 0,
            requestId: getRequestId(),
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('Failed to enqueue review', error instanceof Error ? error : undefined);
        return createSecureJsonResponse(
            { error: 'Failed to enqueue review job', detail: errMsg },
            500
        );
    }

    // 9. Respond immediately with 202 Accepted
    return createSecureJsonResponse(
        {
            message: 'Review queued in the background worker',
            pr: pr.number,
            repo: repository.full_name,
            sha: headSha,
            checkRunId,
        },
        202
    );
}
