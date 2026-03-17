import type { Env } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS, MAX_DIFF_CHARS } from '../config/constants';
import { verifyWebhookSignature } from '../lib/security';
import {
    fetchPRDiff,
    fetchChangedFiles,
    buildReviewContext,
    postPRComment,
} from '../lib/github';
import { callLLM } from '../lib/llm/index';

/**
 * Core webhook handler — called for every POST / request.
 *
 * Flow:
 * 1. Read body once (needed for both signature check and parsing)
 * 2. Verify HMAC-SHA256 signature
 * 3. Check X-GitHub-Event header and payload action
 * 4. Fetch PR diff + changed files
 * 5. Build review context
 * 6. In ctx.waitUntil(): call LLM + post comment asynchronously
 * 7. Return 202 immediately so GitHub doesn't time out
 */
export async function handlePRWebhook(
    request: Request,
    env: Env,
    ctx: ExecutionContext
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
        `[code-reviewer] Reviewing PR #${pr.number}: "${pr.title}" (${repository.full_name}) — action: ${payload.action}`
    );

    // 5. Kick off the async review pipeline without blocking the response
    ctx.waitUntil(runReviewPipeline(pr, repository, env));

    // 6. Respond immediately with 202 Accepted
    return new Response(
        JSON.stringify({
            message: 'Review queued',
            pr: pr.number,
            repo: repository.full_name,
            provider: env.AI_PROVIDER ?? 'claude',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
}

// ---------------------------------------------------------------------------
// Private: The actual review pipeline (runs asynchronously)
// ---------------------------------------------------------------------------

async function runReviewPipeline(
    pr: PullRequestWebhookPayload['pull_request'],
    repository: PullRequestWebhookPayload['repository'],
    env: Env
): Promise<void> {
    try {
        // Fetch PR diff
        const diff = await fetchPRDiff(pr.diff_url, env.GITHUB_TOKEN);

        // Fetch list of changed files for richer context
        const changedFiles = await fetchChangedFiles(repository.full_name, pr.number, env.GITHUB_TOKEN);

        console.log(
            `[code-reviewer] Fetched diff (${diff.length} chars) and ${changedFiles.length} changed files`
        );

        // Build assembled context (diff + full file contents)
        const reviewContext = await buildReviewContext(diff, changedFiles, env.GITHUB_TOKEN, MAX_DIFF_CHARS);

        // Call the configured LLM
        const review = await callLLM(reviewContext, pr.title, env);

        console.log(`[code-reviewer] Review generated (${review.length} chars), posting to PR...`);

        // Post the review as a PR comment
        await postPRComment(repository.full_name, pr.number, review, env.GITHUB_TOKEN);

        console.log(`[code-reviewer] ✅ Review posted to PR #${pr.number}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[code-reviewer] ❌ Review pipeline failed for PR #${pr.number}: ${message}`);

        // Attempt to post a failure notice back to the PR so developers aren't left guessing
        try {
            await postPRComment(
                repository.full_name,
                pr.number,
                `> ⚠️ **Code Reviewer Agent Error**\n> The automated review failed: \`${message}\`\n> Please review manually or check the worker logs.`,
                env.GITHUB_TOKEN
            );
        } catch {
            // If posting the error also fails, just log it — don't throw again
            console.error('[code-reviewer] Could not post error comment to PR');
        }
    }
}
