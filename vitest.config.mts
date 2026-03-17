import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Provide dummy secrets for tests — no real API calls are made in unit tests
					bindings: {
						ANTHROPIC_API_KEY: 'test-anthropic-key',
						GEMINI_API_KEY: 'test-gemini-key',
						GITHUB_TOKEN: 'test-github-token',
						GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
						AI_PROVIDER: 'claude',
					},
				},
			},
		},
	},
});

