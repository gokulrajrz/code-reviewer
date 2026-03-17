export type AIProvider = 'claude' | 'gemini';

/**
 * Cloudflare Worker environment bindings.
 * Secrets set via: wrangler secret put <KEY>
 * Vars set via: wrangler.jsonc vars block or wrangler deploy --var
 */
export interface Env {
  // --- Secrets (never committed, set via wrangler secret put) ---
  /** Anthropic API key for Claude */
  ANTHROPIC_API_KEY: string;
  /** Google AI API key for Gemini */
  GEMINI_API_KEY: string;
  /** GitHub Personal Access Token (Fine-grained: Pull Requests: Read & Write) */
  GITHUB_TOKEN: string;
  /** GitHub Webhook Secret (configured in repo webhook settings) */
  GITHUB_WEBHOOK_SECRET: string;

  // --- Vars (non-secret, safe to set in wrangler.jsonc) ---
  /** Which LLM provider to use. Defaults to "claude". */
  AI_PROVIDER: AIProvider;
  /** Comma-separated list of target branches to review (e.g., "dev,main"). If unset, all branches are reviewed. */
  ALLOWED_TARGET_BRANCHES?: string;

  // --- Queues ---
  /** The Queue responsible for processing reviews in the background */
  REVIEW_QUEUE: Queue<ReviewMessage>;
}

/**
 * The message payload sent from the HTTP webhook handler to the Queue Consumer
 */
export interface ReviewMessage {
  prNumber: number;
  title: string;
  diffUrl: string;
  repoFullName: string;
  headSha: string;
}
