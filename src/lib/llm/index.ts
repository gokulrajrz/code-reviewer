import type { AIProvider, Env } from '../../types/env';
import type { ReviewFinding } from '../../types/review';
import { DEFAULT_AI_PROVIDER } from '../../config/constants';
import { chunkReviewWithClaude, synthesizeWithClaude, reviewWithClaude } from './claude';
import { chunkReviewWithGemini, synthesizeWithGemini, reviewWithGemini } from './gemini';
import { parseFindings } from './parse-findings';

// ---------------------------------------------------------------------------
// Phase 1: Chunk Review (Map) — returns structured findings
// ---------------------------------------------------------------------------

/**
 * Dispatches a code chunk to the configured LLM for inspection.
 * Returns parsed, validated ReviewFinding[] (never raw text).
 *
 * This is the Map phase of our Map-Reduce pipeline.
 */
export async function callChunkReview(
    chunkContent: string,
    prTitle: string,
    chunkLabel: string,
    env: Env,
    signal?: AbortSignal
): Promise<ReviewFinding[]> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    let rawJSON: string;

    switch (provider) {
        case 'gemini':
            rawJSON = await chunkReviewWithGemini(chunkContent, prTitle, chunkLabel, env.GEMINI_API_KEY, signal);
            break;
        case 'claude':
        default:
            rawJSON = await chunkReviewWithClaude(chunkContent, prTitle, chunkLabel, env.ANTHROPIC_API_KEY, signal);
            break;
    }

    return parseFindings(rawJSON);
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis (Reduce) — returns final markdown
// ---------------------------------------------------------------------------

/**
 * Dispatches the aggregated findings to the configured LLM for synthesis.
 * Returns the final, cohesive markdown review.
 *
 * This is the Reduce phase of our Map-Reduce pipeline.
 */
export async function callSynthesizer(
    synthesizerPayload: string,
    env: Env,
    signal?: AbortSignal
): Promise<string> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    switch (provider) {
        case 'gemini':
            return synthesizeWithGemini(synthesizerPayload, env.GEMINI_API_KEY, signal);
        case 'claude':
        default:
            return synthesizeWithClaude(synthesizerPayload, env.ANTHROPIC_API_KEY, signal);
    }
}

// ---------------------------------------------------------------------------
// Legacy Dispatcher (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use callChunkReview + callSynthesizer instead.
 * Kept for any code paths that haven't been migrated yet.
 */
export async function callLLM(
    reviewContext: string,
    prTitle: string,
    env: Env,
    signal?: AbortSignal
): Promise<string> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    switch (provider) {
        case 'gemini':
            return reviewWithGemini(reviewContext, prTitle, env.GEMINI_API_KEY, signal);
        case 'claude':
        default:
            return reviewWithClaude(reviewContext, prTitle, env.ANTHROPIC_API_KEY, signal);
    }
}
