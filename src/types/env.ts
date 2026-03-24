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
  /** GitHub App ID (from GitHub Developer Settings → GitHub Apps) */
  GITHUB_APP_ID: string;
  /** GitHub App Private Key (PEM format, generated on the App settings page) */
  GITHUB_APP_PRIVATE_KEY: string;
  /** GitHub App Installation ID (from the URL after installing the App on a repo) */
  GITHUB_APP_INSTALLATION_ID: string;
  /** GitHub Webhook Secret (configured in the GitHub App webhook settings) */
  GITHUB_WEBHOOK_SECRET: string;

  // --- Vars (non-secret, safe to set in wrangler.jsonc) ---
  /** Which LLM provider to use. Defaults to "gemini". */
  AI_PROVIDER?: 'claude' | 'gemini';
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
  /** The Check Run ID created by the webhook, so the queue consumer can update it */
  checkRunId: number;
  /** True if this review was manually triggered by an /override-ai comment */
  isOverride?: boolean;
}
