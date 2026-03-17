import type { Env, ReviewMessage } from './types/env';
import { WORKER_VERSION } from './config/constants';
import { handlePRWebhook } from './handlers/webhook';
import { queueHandler } from './handlers/queue';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { method, url } = request;
		const { pathname } = new URL(url);

		// — Health Check —
		if (method === 'GET' && pathname === '/') {
			return new Response(
				JSON.stringify({
					status: 'ok',
					service: 'code-reviewer-agent',
					version: WORKER_VERSION,
					provider: env.AI_PROVIDER ?? 'claude',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		}

		// — GitHub Webhook Entry Point —
		if (method === 'POST' && pathname === '/') {
			return handlePRWebhook(request, env);
		}

		// — Method Not Allowed —
		return new Response(
			JSON.stringify({ error: 'Method not allowed' }),
			{ status: 405, headers: { 'Content-Type': 'application/json', Allow: 'GET, POST' } }
		);
	},

	/**
	 * Background Queue Consumer Handler
	 * Extracts messages and routes them to the executor function.
	 */
	async queue(batch: MessageBatch<ReviewMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		await queueHandler(batch, env, ctx);
	}
} satisfies ExportedHandler<Env, ReviewMessage>;
