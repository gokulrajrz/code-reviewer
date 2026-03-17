import type { AIProvider } from '../types/env';

export const DEFAULT_AI_PROVIDER: AIProvider = 'claude';

export const MODELS = {
    claude: 'claude-3-5-sonnet-20240620',
    gemini: 'gemini-1.5-pro',
} as const satisfies Record<AIProvider, string>;

/** Maximum characters of diff/file content to send to the LLM. Guards against huge PRs. */
export const MAX_DIFF_CHARS = 80_000;

/** Maximum number of changed files whose full content we fetch for extra context. */
export const MAX_CONTEXT_FILES = 10;

/** Only fetch full content for files below this byte size (100KB). */
export const MAX_FILE_SIZE_BYTES = 100_000;

/** PR actions that should trigger a review. */
export const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

/** Worker version — bump on deploy. */
export const WORKER_VERSION = '1.0.0';
