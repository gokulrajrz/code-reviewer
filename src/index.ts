import type { Env } from './types/env';
import { WORKER_VERSION } from './config/constants';
import { handlePRWebhook } from './handlers/webhook';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
			return handlePRWebhook(request, env, ctx);
		}

		// — Method Not Allowed —
		return new Response(
			JSON.stringify({ error: 'Method not allowed' }),
			{ status: 405, headers: { 'Content-Type': 'application/json', Allow: 'GET, POST' } }
		);
	},
} satisfies ExportedHandler<Env>;
