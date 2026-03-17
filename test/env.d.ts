import type { Env as WorkerEnv } from '../src/types/env';

declare module 'cloudflare:test' {
	// Make the test `env` match our full Env interface (secrets + vars)
	interface ProvidedEnv extends WorkerEnv { }
}
