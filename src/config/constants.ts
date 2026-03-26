import type { AIProvider } from '../types/env';

// ---------------------------------------------------------------------------
// Application Metadata
// ---------------------------------------------------------------------------

export const WORKER_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// AI Model Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_AI_PROVIDER: AIProvider = 'gemini';

export const MODELS = {
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-3.1-pro-preview',
} as const satisfies Record<AIProvider, string>;

interface ModelConfig {
    contextWindow: number;
    chunkSize: number;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
    'claude-sonnet-4-20250514': {
        contextWindow: 1_000_000,  // 1M tokens
        chunkSize: 400_000,        // ~40% of context window for safety
    },
    'gemini-3.1-pro-preview': {
        contextWindow: 2_000_000,  // 2M tokens
        chunkSize: 500_000,        // ~25% of context window
    },
};

const DEFAULT_CHUNK_SIZE = 100_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export function getChunkSize(provider: AIProvider): number {
    const model = MODELS[provider];
    return MODEL_CONFIGS[model]?.chunkSize ?? DEFAULT_CHUNK_SIZE;
}

export function getContextWindow(provider: AIProvider): number {
    const model = MODELS[provider];
    return MODEL_CONFIGS[model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers Limits
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers has a 50 subrequest limit per request.
 * With 3 agents per chunk, 6 chunks = 18 LLM calls.
 * Plus GitHub API calls for files, we stay well under the limit.
 */
export const MAX_LLM_CHUNKS = 6;

/**
 * Maximum files to fetch full content for (Tier 1).
 * Each file costs 1 subrequest to GitHub's raw content API.
 */
export const TIER1_MAX_FILES = 8;

// ---------------------------------------------------------------------------
// GitHub PR Limits
// ---------------------------------------------------------------------------

/**
 * GitHub returns max 3000 files per PR, but we cap at a practical limit.
 */
export const MAX_TOTAL_FILES = 300;

/**
 * Skip fetching full content for files larger than 200KB.
 * Review diff patches only for large files.
 */
export const MAX_FILE_SIZE_BYTES = 200_000;

/**
 * PR actions that trigger automated review.
 */
export const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

// ---------------------------------------------------------------------------
// File Classification - Noise Filters
// ---------------------------------------------------------------------------

export const NOISE_EXTENSIONS = new Set([
    // Lock files
    'lock',
    // Images
    'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
    // Fonts
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    // Media
    'mp4', 'mp3', 'wav',
    // Documents & Archives
    'pdf', 'zip', 'tar', 'gz',
    // Build artifacts
    'map', 'snap', 'min.js', 'min.css', 'chunk.js', 'chunk.css',
    // Compiled files
    'DS_Store', 'pyc', 'class', 'o', 'so', 'dll', 'exe',
]);

export const NOISE_FILENAMES = new Set([
    // Package manager locks
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
    // Config files
    '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
    '.eslintignore', '.npmrc', '.nvmrc', '.node-version',
    // Legal
    'LICENSE', 'LICENSE.md', 'LICENSE.txt',
    // Changelogs
    'CHANGELOG.md', 'CHANGELOG',
]);

export const NOISE_DIRECTORIES = [
    'node_modules/', 'vendor/', 'dist/', 'build/', '.next/',
    'coverage/', '__snapshots__/', '.turbo/', '.cache/',
    'public/assets/', 'static/assets/',
];

// ---------------------------------------------------------------------------
// File Classification - Priority Files
// ---------------------------------------------------------------------------

/**
 * Source code extensions that get priority in review.
 * These files contain business logic and are most likely to have issues.
 */
export const PRIORITY_EXTENSIONS = new Set([
    // JavaScript/TypeScript
    'ts', 'tsx', 'js', 'jsx',
    // Backend languages
    'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs',
    // Mobile
    'swift', 'dart',
    // Frontend frameworks
    'vue', 'svelte',
]);
