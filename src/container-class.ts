import { Container } from '@cloudflare/containers';

/**
 * Worker-side Container class definition.
 *
 * This does NOT run inside the Docker container. It runs inside the V8 Worker isolate
 * and tells Cloudflare how to manage the associated Docker container:
 * - Which port to proxy to
 * - When to sleep the container
 * - Whether to allow outbound internet
 *
 * The actual review logic lives in the `container/` directory as a separate Node.js app.
 */
export class ReviewContainer extends Container {
	/** The HTTP port the container's Hono server listens on. */
	defaultPort = 3000;

	/**
	 * Sleep the container after 5 minutes of inactivity.
	 * This saves cost while keeping the container warm for burst PR activity.
	 * On next request, the container wakes in ~1-3 seconds.
	 */
	sleepAfter = '5m';

	/**
	 * MUST be true. The container needs outbound internet for:
	 * 1. `git clone` from GitHub
	 * 2. Anthropic/Google LLM API calls
	 * 3. (No GitHub API calls — posting is done by the Worker)
	 */
	enableInternet = true;

	override onStart(): void {
		console.log('[ReviewContainer] Container instance started');
	}

	override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
		console.log('[ReviewContainer] Container instance stopped', { exitCode, reason });
	}

	override onError(error: unknown): void {
		console.error('[ReviewContainer] Container instance error', error);
		throw error; // Re-throw so the caller (queue handler) sees the failure
	}
}
