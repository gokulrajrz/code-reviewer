import type { AIProvider } from '../types/env';

export const DEFAULT_AI_PROVIDER: AIProvider = 'claude';

export const MODELS = {
    claude: 'claude-sonnet-4-6',
    gemini: 'gemini-1.5-pro',
} as const satisfies Record<AIProvider, string>;

/** Maximum characters of diff/file content to send to the LLM. Guards against huge PRs. */
export const MAX_DIFF_CHARS = 200_000;

/** Maximum number of changed files whose full content we fetch for extra context. */
export const MAX_CONTEXT_FILES = 50;

/** Only fetch full content for files below this byte size (200KB). */
export const MAX_FILE_SIZE_BYTES = 200_000;

/** PR actions that should trigger a review. */
export const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

/** Worker version — update in sync with package.json on releases. */
export const WORKER_VERSION = '1.0.0';
