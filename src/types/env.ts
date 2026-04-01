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
  /** Which LLM provider to use. Defaults to "claude". */
  AI_PROVIDER: AIProvider;
  /** Comma-separated list of target branches to review (e.g., "dev,main"). If unset, all branches are reviewed. */
  ALLOWED_TARGET_BRANCHES?: string;
  /** Optional API key for usage endpoints. If set, requires Bearer token authentication. */
  USAGE_API_KEY?: string;
  /** Dashboard username (set via wrangler secret). Defaults to 'admin' if not set. */
  DASHBOARD_USERNAME?: string;
  /** Dashboard password (set via wrangler secret). Required for dashboard login. */
  DASHBOARD_PASSWORD?: string;
  /** Zoho OAuth Client ID */
  CLIQ_CLIENT_ID?: string;
  /** Zoho OAuth Client Secret */
  CLIQ_CLIENT_SECRET?: string;
  /** Zoho OAuth Refresh Token */
  CLIQ_REFRESH_TOKEN?: string;
  /** Zoho Cliq unique Bot Name */
  CLIQ_BOT_NAME?: string;
  /** Zoho Cliq Target ID (Channel ID, Chat ID, or User ID) to route reviews to */
  CLIQ_CHANNEL_ID?: string;

  // --- Queues ---
  /** The Queue responsible for processing reviews in the background */
  REVIEW_QUEUE: Queue<ReviewMessage>;

  // --- KV Namespaces ---
  /** KV namespace for storing usage metrics and cost tracking */
  USAGE_METRICS: KVNamespace;
}

/**
 * The message payload sent from the HTTP webhook handler to the Queue Consumer
 */
export interface ReviewMessage {
  prNumber: number;
  title: string;
  repoFullName: string;
  headSha: string;
  /** The Check Run ID created by the webhook, so the queue consumer can update it */
  checkRunId?: number;
  /** GitHub username of the PR author */
  prAuthor: string;
  /** Request ID for distributed tracing across webhook → queue → LLM calls */
  requestId?: string;
}
