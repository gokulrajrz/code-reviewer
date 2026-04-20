import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { runReviewPipeline } from './pipeline.js';
import type { ReviewRequest, ReviewResponse } from './types.js';

const app = new Hono();

// ── Middleware ──
app.use('*', honoLogger());

// ── Health check (required by Cloudflare Container readiness detection) ──
app.get('/ping', (c) => c.text('pong'));

// ── Main review endpoint ──
app.post('/review', async (c) => {
	const startTime = Date.now();
	let request: ReviewRequest;

	try {
		request = await c.req.json<ReviewRequest>();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields
	if (!request.repoFullName || !request.prNumber || !request.installationToken) {
		return c.json({ error: 'Missing required fields: repoFullName, prNumber, installationToken' }, 400);
	}

	const requestId = request.requestId || `container-${Date.now()}`;
	console.log(`[${requestId}] Starting review for ${request.repoFullName}#${request.prNumber}`);

	try {
		const response: ReviewResponse = await runReviewPipeline(request, requestId);

		console.log(`[${requestId}] Review completed in ${Date.now() - startTime}ms`, {
			staticFindings: response.staticFindings.length,
		});

		return c.json(response);
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		console.error(`[${requestId}] Pipeline failed:`, errMsg);

		return c.json({
			error: 'Review pipeline failed',
			message: errMsg,
			requestId,
		}, 500);
	}
});


// ── Start server ──
import { serve } from '@hono/node-server';

const port = parseInt(process.env.PORT || '3000', 10);

console.log(`[ReviewContainer] Starting Node.js HTTP server on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
