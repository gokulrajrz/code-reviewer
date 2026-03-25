import { defineConfig } from 'vitest/config';

/**
 * Vitest config for E2E tests.
 *
 * These tests run OUTSIDE the worker runtime and send real HTTP requests
 * to the deployed Cloudflare Worker. They do NOT use the Workers pool.
 *
 * Usage:
 *   GITHUB_WEBHOOK_SECRET="<secret>" npx vitest run --config vitest.e2e.config.mts
 */
export default defineConfig({
    test: {
        include: ['tests/e2e/**/*.test.ts'],
        testTimeout: 30_000,
        hookTimeout: 10_000,
    },
});
