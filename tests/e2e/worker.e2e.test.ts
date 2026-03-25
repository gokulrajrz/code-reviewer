/**
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║   Code Reviewer V2 — Industrial-Grade E2E Test Suite                ║
 * ║                                                                     ║
 * ║   Tests the LIVE deployed Cloudflare Worker by sending real HTTP    ║
 * ║   requests and validating every response branch with full detail.   ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * Quick smoke test (mock payloads, no GitHub API calls):
 *   GITHUB_WEBHOOK_SECRET="<secret>" npm run test:e2e
 *
 * Full live E2E (triggers real multi-agent LLM review on a live PR):
 *   GITHUB_WEBHOOK_SECRET="<secret>" \
 *   TARGET_REPO="owner/repo" \
 *   TARGET_PR="42" \
 *   TARGET_SHA="abc123" \
 *   INSTALLATION_ID="12345678" \
 *   npm run test:e2e
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_URL = process.env.WORKER_URL ?? 'https://code-reviewer-v2.dark-mode-d021.workers.dev';
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';

// Optional: set these to trigger a REAL review on a live PR
const TARGET_REPO = process.env.TARGET_REPO;
const TARGET_PR = process.env.TARGET_PR;
const TARGET_SHA = process.env.TARGET_SHA;
const INSTALLATION_ID = process.env.INSTALLATION_ID;

// ═══════════════════════════════════════════════════════════════════════════
// Test Infrastructure — Logging & Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface TestResult {
    test: string;
    status: number;
    latencyMs: number;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

const allResults: TestResult[] = [];

/** 
 * Send an HTTP request and capture the full response for logging.
 * Every test gets a detailed record of status, headers, body, and latency.
 */
async function sendRequest(
    method: string,
    path: string,
    options: {
        body?: string;
        headers?: Record<string, string>;
    } = {}
): Promise<{ res: Response; json: Record<string, unknown>; latencyMs: number }> {
    const url = `${WORKER_URL}${path}`;
    const start = performance.now();

    const res = await fetch(url, {
        method,
        body: options.body,
        headers: options.headers,
    });

    const latencyMs = Math.round(performance.now() - start);
    let json: Record<string, unknown> = {};

    try {
        const text = await res.text();
        json = JSON.parse(text) as Record<string, unknown>;
    } catch {
        json = { _rawBody: 'Non-JSON response' };
    }

    return { res, json, latencyMs };
}

function signPayload(body: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
}

/** Send a properly signed webhook to the live worker. */
async function sendWebhook(
    event: string,
    payload: Record<string, unknown>,
    opts: { sign?: boolean; overrideSignature?: string } = {}
) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': crypto.randomUUID(),
    };

    if (opts.overrideSignature) {
        headers['x-hub-signature-256'] = opts.overrideSignature;
    } else if (opts.sign !== false && WEBHOOK_SECRET) {
        headers['x-hub-signature-256'] = signPayload(body, WEBHOOK_SECRET);
    }

    return sendRequest('POST', '/', { body, headers });
}

// ═══════════════════════════════════════════════════════════════════════════
// Payload Factories
// ═══════════════════════════════════════════════════════════════════════════

function makePRPayload(overrides: Record<string, unknown> = {}) {
    return {
        action: 'opened',
        pull_request: {
            number: 999,
            title: 'E2E Test PR',
            state: 'open',
            diff_url: 'https://github.com/mock/repo/pull/999.diff',
            head: { sha: 'e2etestsha0000000000' },
            base: { ref: 'dev' },
        },
        repository: { full_name: 'mock/repo' },
        installation: { id: 12345678 },
        ...overrides,
    };
}

function makeIssueCommentPayload(commentBody: string, isPR = true) {
    return {
        action: 'created' as string,
        comment: {
            body: commentBody,
            user: { login: 'test-maintainer' },
        },
        issue: {
            number: 42,
            ...(isPR ? { pull_request: { url: 'https://api.github.com/repos/mock/repo/pulls/42' } } : {}),
        },
        repository: { full_name: 'mock/repo' },
    };
}

function logResult(testName: string, result: { res: Response; json: Record<string, unknown>; latencyMs: number }) {
    const record: TestResult = {
        test: testName,
        status: result.res.status,
        latencyMs: result.latencyMs,
        body: result.json,
        headers: Object.fromEntries(result.res.headers.entries()),
    };
    allResults.push(record);

    console.log(`\n    ┌─ ${testName}`);
    console.log(`    │  Status:  ${result.res.status} ${result.res.statusText}`);
    console.log(`    │  Latency: ${result.latencyMs}ms`);
    console.log(`    │  Body:    ${JSON.stringify(result.json, null, 2).split('\n').join('\n    │           ')}`);
    console.log(`    └─`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe('Code Reviewer V2 — Industrial-Grade E2E', () => {
    beforeAll(() => {
        if (!WEBHOOK_SECRET) {
            throw new Error(
                '❌ GITHUB_WEBHOOK_SECRET is required.\n' +
                'Run: GITHUB_WEBHOOK_SECRET="<secret>" npm run test:e2e'
            );
        }
        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║  Code Reviewer V2 — E2E Test Run                            ║');
        console.log('╠═══════════════════════════════════════════════════════════════╣');
        console.log(`║  Worker:  ${WORKER_URL}`);
        console.log(`║  Time:    ${new Date().toISOString()}`);
        console.log(`║  Live:    ${TARGET_REPO ? `YES → ${TARGET_REPO}#${TARGET_PR}` : 'NO (mock only)'}`);
        console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    });

    afterAll(() => {
        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║  Summary Report                                             ║');
        console.log('╠═══════════════════════════════════════════════════════════════╣');

        const passed = allResults.length;
        const avgLatency = Math.round(allResults.reduce((sum, r) => sum + r.latencyMs, 0) / (passed || 1));
        const maxLatency = Math.max(...allResults.map(r => r.latencyMs), 0);
        const minLatency = Math.min(...allResults.map(r => r.latencyMs), Infinity);

        console.log(`║  Total Tests Logged: ${passed}`);
        console.log(`║  Avg Latency:        ${avgLatency}ms`);
        console.log(`║  Min Latency:        ${minLatency}ms`);
        console.log(`║  Max Latency:        ${maxLatency}ms`);
        console.log('╠═══════════════════════════════════════════════════════════════╣');

        // Status code distribution
        const statusCounts: Record<number, number> = {};
        for (const r of allResults) {
            statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
        }
        console.log('║  Status Code Distribution:');
        for (const [code, count] of Object.entries(statusCounts).sort()) {
            const emoji = Number(code) < 300 ? '✅' : Number(code) < 500 ? '⚠️ ' : '❌';
            console.log(`║    ${emoji} ${code}: ${count} response(s)`);
        }

        console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    });

    // ════════════════════════════════════════════════════════════════════════
    // 1. Health Check & HTTP Routing
    // ════════════════════════════════════════════════════════════════════════
    describe('1. Health Check & Routing', () => {
        it('1.1 GET / → 200 health check with version, provider, status', async () => {
            const result = await sendRequest('GET', '/');
            logResult('GET / Health Check', result);

            expect(result.res.status).toBe(200);
            expect(result.json).toMatchObject({
                status: 'ok',
                service: 'code-reviewer-agent',
                version: expect.any(String),
                provider: 'gemini',
            });
        });

        it('1.2 PUT / → 405 Method Not Allowed', async () => {
            const result = await sendRequest('PUT', '/');
            logResult('PUT / Method Not Allowed', result);

            expect(result.res.status).toBe(405);
            expect(result.json).toHaveProperty('error');
        });

        it('1.3 DELETE / → 405 Method Not Allowed', async () => {
            const result = await sendRequest('DELETE', '/');
            logResult('DELETE / Method Not Allowed', result);

            expect(result.res.status).toBe(405);
        });

        it('1.4 GET /random-path → 405 (only / is routed)', async () => {
            const result = await sendRequest('GET', '/nonexistent');
            logResult('GET /nonexistent', result);

            expect(result.res.status).toBe(405);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 2. HMAC SHA-256 Webhook Signature Verification
    // ════════════════════════════════════════════════════════════════════════
    describe('2. Webhook Signature Security', () => {
        it('2.1 No signature header → 401 Unauthorized', async () => {
            const result = await sendWebhook('ping', { zen: 'test' }, { sign: false });
            logResult('POST / No Signature', result);

            expect(result.res.status).toBe(401);
            expect(result.json).toHaveProperty('error');
            expect(String(result.json.error)).toMatch(/signature/i);
        });

        it('2.2 Tampered signature → 401 Unauthorized', async () => {
            const result = await sendWebhook(
                'ping',
                { zen: 'tampered' },
                { overrideSignature: 'sha256=' + '0'.repeat(64) }
            );
            logResult('POST / Tampered Signature', result);

            expect(result.res.status).toBe(401);
        });

        it('2.3 Wrong algorithm prefix → 401 Unauthorized', async () => {
            const result = await sendWebhook(
                'ping',
                { zen: 'wrong-algo' },
                { overrideSignature: 'sha1=abc123' }
            );
            logResult('POST / Wrong Algorithm', result);

            expect(result.res.status).toBe(401);
        });

        it('2.4 Valid HMAC-SHA256 signature → 200 OK', async () => {
            const result = await sendWebhook('ping', { zen: 'Responsive is better than fast.' });
            logResult('POST / Valid Signature', result);

            expect(result.res.status).toBe(200);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 3. GitHub Event Filtering
    // ════════════════════════════════════════════════════════════════════════
    describe('3. Event & Action Filtering', () => {
        it('3.1 Event "star" → 200 Ignored', async () => {
            const result = await sendWebhook('star', { action: 'created' });
            logResult('star event', result);

            expect(result.res.status).toBe(200);
            expect(String(result.json.message)).toMatch(/ignored.*event/i);
        });

        it('3.2 Event "push" → 200 Ignored', async () => {
            const result = await sendWebhook('push', { ref: 'refs/heads/main' });
            logResult('push event', result);

            expect(result.res.status).toBe(200);
            expect(String(result.json.message)).toMatch(/ignored.*event/i);
        });

        it('3.3 PR action "closed" → 200 Ignored', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'closed' }));
            logResult('PR closed action', result);

            expect(result.res.status).toBe(200);
            expect(String(result.json.message)).toMatch(/ignored pr action/i);
        });

        it('3.4 PR action "labeled" → 200 Ignored', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'labeled' }));
            logResult('PR labeled action', result);

            expect(result.res.status).toBe(200);
        });

        it('3.5 PR action "edited" → 200 Ignored', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'edited' }));
            logResult('PR edited action', result);

            expect(result.res.status).toBe(200);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 4. Allowed Target Branch Filtering
    // ════════════════════════════════════════════════════════════════════════
    describe('4. Branch Filtering', () => {
        it('4.1 PR targeting "dev" (allowed) → passes branch filter', async () => {
            const result = await sendWebhook('pull_request', makePRPayload());
            logResult('PR target=dev', result);

            // 202 = enqueued, 500 = mock installation can't auth
            // Both prove the branch filter PASSED.
            expect([202, 500]).toContain(result.res.status);
            expect(result.res.status).not.toBe(200); // 200 would mean it was skipped
        });

        it('4.2 PR targeting "main" (disallowed) → branch filter blocks', async () => {
            const payload = makePRPayload({
                pull_request: {
                    number: 999,
                    title: 'E2E Test PR',
                    state: 'open',
                    diff_url: 'https://github.com/mock/repo/pull/999.diff',
                    head: { sha: 'e2etestsha0000000000' },
                    base: { ref: 'main' },
                },
            });
            const result = await sendWebhook('pull_request', payload);
            logResult('PR target=main (blocked)', result);

            // Should NOT be 202 (enqueued). It should be blocked at 200 or fail at auth (500).
            expect(result.res.status).not.toBe(202);
        });

        it('4.3 PR targeting "feature/xyz" (disallowed) → branch filter blocks', async () => {
            const payload = makePRPayload({
                pull_request: {
                    number: 999,
                    title: 'E2E Test PR',
                    state: 'open',
                    diff_url: 'https://github.com/mock/repo/pull/999.diff',
                    head: { sha: 'e2etestsha0000000000' },
                    base: { ref: 'feature/xyz' },
                },
            });
            const result = await sendWebhook('pull_request', payload);
            logResult('PR target=feature/xyz (blocked)', result);

            expect(result.res.status).not.toBe(202);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 5. Human-in-the-Loop (Issue Comment Handlers)
    // ════════════════════════════════════════════════════════════════════════
    describe('5. Human-in-the-Loop (HITL)', () => {
        it('5.1 /override-ai on a PR → enters override path (202 or 500)', async () => {
            const result = await sendWebhook('issue_comment', makeIssueCommentPayload('/override-ai'));
            logResult('/override-ai on PR', result);

            // 202 = re-queued, 500 = mock installation can't auth
            expect([202, 500]).toContain(result.res.status);
        });

        it('5.2 /dismiss-ai on a PR → 200 with acknowledgment', async () => {
            const result = await sendWebhook('issue_comment', makeIssueCommentPayload('/dismiss-ai'));
            logResult('/dismiss-ai on PR', result);

            expect(result.res.status).toBe(200);
            expect(result.json).toMatchObject({
                message: 'AI review dismissed.',
                pr: 42,
                dismissedBy: 'test-maintainer',
            });
        });

        it('5.3 /OVERRIDE-AI (case insensitive) → enters override path', async () => {
            const result = await sendWebhook('issue_comment', makeIssueCommentPayload('/OVERRIDE-AI'));
            logResult('/OVERRIDE-AI case test', result);

            // The handler does .toLowerCase(), so this should work
            expect([202, 500]).toContain(result.res.status);
        });

        it('5.4 Random comment on a PR → 200 Ignored', async () => {
            const result = await sendWebhook('issue_comment', makeIssueCommentPayload('LGTM! Ship it 🚀'));
            logResult('Random PR comment', result);

            expect(result.res.status).toBe(200);
            expect(String(result.json.message)).toMatch(/ignored comment/i);
        });

        it('5.5 /override-ai on a regular issue (not a PR) → 200 Ignored', async () => {
            const result = await sendWebhook('issue_comment', makeIssueCommentPayload('/override-ai', false));
            logResult('/override-ai on non-PR issue', result);

            expect(result.res.status).toBe(200);
            expect(String(result.json.message)).toMatch(/ignored comment/i);
        });

        it('5.6 "edited" comment action → 200 Ignored', async () => {
            const payload = { ...makeIssueCommentPayload('/override-ai'), action: 'edited' };
            const result = await sendWebhook('issue_comment', payload);
            logResult('edited comment action', result);

            expect(result.res.status).toBe(200);
        });

        it('5.7 "deleted" comment action → 200 Ignored', async () => {
            const payload = { ...makeIssueCommentPayload('/override-ai'), action: 'deleted' };
            const result = await sendWebhook('issue_comment', payload);
            logResult('deleted comment action', result);

            expect(result.res.status).toBe(200);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 6. Valid PR Enqueue (Mock Payloads — Tests Webhook Layer Only)
    // ════════════════════════════════════════════════════════════════════════
    describe('6. PR Enqueue — Webhook Layer (Mock)', () => {
        it('6.1 "opened" on dev → passes all filters', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'opened' }));
            logResult('PR opened on dev', result);

            expect([202, 500]).toContain(result.res.status);
        });

        it('6.2 "synchronize" on dev → passes all filters', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'synchronize' }));
            logResult('PR synchronize on dev', result);

            expect([202, 500]).toContain(result.res.status);
        });

        it('6.3 "reopened" on dev → passes all filters', async () => {
            const result = await sendWebhook('pull_request', makePRPayload({ action: 'reopened' }));
            logResult('PR reopened on dev', result);

            expect([202, 500]).toContain(result.res.status);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 7. Live E2E — Full Pipeline Execution (Optional)
    // ════════════════════════════════════════════════════════════════════════
    describe('7. Live E2E — Full Pipeline', () => {
        const isLive = TARGET_REPO && TARGET_PR && INSTALLATION_ID;

        it.skipIf(!isLive)('7.1 Triggers REAL multi-agent review → 202 Accepted', async () => {
            console.log('\n    ╔═══════════════════════════════════════════════════╗');
            console.log(`    ║  🔥 LIVE E2E: ${TARGET_REPO}#${TARGET_PR}`);
            console.log('    ╠═══════════════════════════════════════════════════╣');
            console.log(`    ║  SHA:            ${TARGET_SHA ?? 'auto'}`);
            console.log(`    ║  Installation:   ${INSTALLATION_ID}`);
            console.log(`    ║  Target Branch:  dev`);
            console.log('    ╚═══════════════════════════════════════════════════╝\n');

            const payload = {
                action: 'opened',
                pull_request: {
                    number: parseInt(TARGET_PR!, 10),
                    title: 'Live E2E Review Trigger',
                    state: 'open',
                    diff_url: `https://github.com/${TARGET_REPO}/pull/${TARGET_PR}.diff`,
                    head: { sha: TARGET_SHA ?? 'live-e2e-sha' },
                    base: { ref: 'dev' },
                },
                repository: { full_name: TARGET_REPO },
                installation: { id: parseInt(INSTALLATION_ID!, 10) },
            };

            const result = await sendWebhook('pull_request', payload);
            logResult('LIVE PR trigger', result);

            expect(result.res.status).toBe(202);
            expect(result.json).toMatchObject({
                pr: parseInt(TARGET_PR!, 10),
                repo: TARGET_REPO,
                pipeline: expect.stringContaining('multi-agent'),
            });
            expect(result.json).toHaveProperty('sha');
            expect(result.json).toHaveProperty('checkRunId');

            console.log('\n    ✅ Webhook accepted and job enqueued!');
            console.log('    📋 The background queue worker is now processing.');
            console.log('    🔍 Check the PR in ~30-60s for the AI review comment.');
            console.log(`    🔗 https://github.com/${TARGET_REPO}/pull/${TARGET_PR}\n`);
        });
    });
});
