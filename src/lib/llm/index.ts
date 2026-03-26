import type { AIProvider, Env } from '../../types/env';
import type { ReviewFinding } from '../../types/review';
import type { TokenUsage } from '../../types/usage';
import { DEFAULT_AI_PROVIDER } from '../../config/constants';
import { parseFindings } from './parse-findings';
import { retryWithBackoff, circuitBreakers } from '../retry';
import { logger } from '../logger';

// Import adapters (registers them with the factory)
import './adapters/claude';
import './adapters/gemini';
import { LLMProviderFactory, type LLMProviderConfig } from './adapter';

// ---------------------------------------------------------------------------
// Phase 1: Chunk Review (Map) — returns structured findings
// ---------------------------------------------------------------------------

export interface ChunkReviewResult {
    findings: ReviewFinding[];
    usage: TokenUsage;
}

/**
 * Dispatches a code chunk to the configured LLM for inspection.
 * Returns parsed, validated ReviewFinding[] (never raw text) and usage data.
 *
 * This is the Map phase of our Map-Reduce pipeline.
 * Includes retry logic with exponential backoff for resilience.
 */
export async function callChunkReview(
    chunkContent: string,
    prTitle: string,
    chunkLabel: string,
    env: Env,
    signal?: AbortSignal
): Promise<ChunkReviewResult> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    // Check circuit breaker before attempting
    const breaker = provider === 'gemini' ? circuitBreakers.gemini : circuitBreakers.anthropic;
    if (!breaker.canExecute()) {
        throw new Error(`LLM circuit breaker for ${provider} is OPEN - too many failures`);
    }

    // Create provider adapter using factory
    const config: LLMProviderConfig = {
        apiKey: provider === 'gemini' ? env.GEMINI_API_KEY! : env.ANTHROPIC_API_KEY!,
    };
    const adapter = LLMProviderFactory.createProvider(provider, config);

    const executeReview = async (): Promise<ChunkReviewResult> => {
        const result = await adapter.reviewChunk(
            { chunkContent, prTitle, chunkLabel },
            signal
        );
        const findings = parseFindings(result.content);
        return { findings, usage: result.usage };
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeReview,
            `LLM chunk review (${provider})`,
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        // Record success for circuit breaker
        breaker.recordSuccess();

        if (attempts > 1) {
            logger.info(`Chunk review succeeded after ${attempts} attempts`, {
                chunkLabel,
                attempts,
                totalDelayMs,
                provider,
            });
        }

        return result;
    } catch (error) {
        // Record failure for circuit breaker
        breaker.recordFailure();
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis (Reduce) — returns final markdown
// ---------------------------------------------------------------------------

export interface SynthesisResult {
    review: string;
    usage: TokenUsage;
}

/**
 * Dispatches the aggregated findings to the configured LLM for synthesis.
 * Returns the final, cohesive markdown review and usage data.
 *
 * This is the Reduce phase of our Map-Reduce pipeline.
 * Includes retry logic with exponential backoff for resilience.
 */
export async function callSynthesizer(
    synthesizerPayload: string,
    env: Env,
    signal?: AbortSignal
): Promise<SynthesisResult> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    // Check circuit breaker before attempting
    const breaker = provider === 'gemini' ? circuitBreakers.gemini : circuitBreakers.anthropic;
    if (!breaker.canExecute()) {
        throw new Error(`LLM circuit breaker for ${provider} is OPEN - too many failures`);
    }

    // Create provider adapter using factory
    const config: LLMProviderConfig = {
        apiKey: provider === 'gemini' ? env.GEMINI_API_KEY! : env.ANTHROPIC_API_KEY!,
    };
    const adapter = LLMProviderFactory.createProvider(provider, config);

    const executeSynthesis = async (): Promise<SynthesisResult> => {
        const result = await adapter.synthesize({ payload: synthesizerPayload }, signal);
        return { review: result.content, usage: result.usage };
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeSynthesis,
            `LLM synthesis (${provider})`,
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        // Record success for circuit breaker
        breaker.recordSuccess();

        if (attempts > 1) {
            logger.info(`Synthesis succeeded after ${attempts} attempts`, {
                attempts,
                totalDelayMs,
                provider,
            });
        }

        return result;
    } catch (error) {
        // Record failure for circuit breaker
        breaker.recordFailure();
        throw error;
    }
}

/**
 * Get the model name for the current provider
 */
export function getModelName(provider: AIProvider): string {
    // Use factory to get adapter and query its model name
    const config: LLMProviderConfig = { apiKey: 'dummy' };
    try {
        const adapter = LLMProviderFactory.createProvider(provider, config);
        return adapter.getModelName();
    } catch {
        // Fallback to default models if adapter not found
        return provider === 'gemini' ? 'gemini-1.5-flash' : 'claude-3-sonnet-20240229';
    }
}

/**
 * Get list of available LLM providers.
 */
export function getAvailableProviders(): string[] {
    return LLMProviderFactory.getAvailableProviders();
}

