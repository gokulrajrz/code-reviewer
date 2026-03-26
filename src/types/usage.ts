/**
 * Token usage data returned by LLM providers
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/**
 * Schema version for usage metrics
 * Increment when making breaking changes to enable migrations
 */
export const USAGE_METRICS_SCHEMA_VERSION = 1;

/**
 * Usage data for a single LLM call (chunk review or synthesis)
 */
export interface LLMCallUsage {
    phase: 'map' | 'reduce';
    chunkLabel?: string; // Only for map phase
    model: string;
    usage: TokenUsage;
    timestamp: string;
}

/**
 * Complete usage metrics for a PR review
 */
export interface PRUsageMetrics {
    /** Schema version for forward compatibility */
    schemaVersion: number;
    
    prNumber: number;
    repoFullName: string;
    headSha: string;
    provider: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    
    // LLM call details
    calls: LLMCallUsage[];
    
    // Aggregated token counts
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    
    // Cost estimation (in USD)
    estimatedCost: number;
    
    // Review metadata
    filesReviewed: number;
    chunksProcessed: number;
    findingsCount: number;
    status: 'success' | 'partial' | 'failed';
}

/**
 * Pricing per million tokens (as of March 2026)
 * Update these based on current provider pricing
 */
export const TOKEN_PRICING = {
    claude: {
        model: 'claude-sonnet-4-20250514',
        inputPer1M: 3.00,   // $3 per 1M input tokens
        outputPer1M: 15.00, // $15 per 1M output tokens
    },
    gemini: {
        model: 'gemini-3.1-pro-preview',
        inputPer1M: 1.25,   // $1.25 per 1M input tokens
        outputPer1M: 5.00,  // $5 per 1M output tokens
    },
} as const;

/**
 * Calculate cost based on token usage and provider
 */
export function calculateCost(
    provider: 'claude' | 'gemini',
    inputTokens: number,
    outputTokens: number
): number {
    const pricing = TOKEN_PRICING[provider];
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
    return inputCost + outputCost;
}
