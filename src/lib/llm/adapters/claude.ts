import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { MODELS } from '../../../config/constants';
import { logger } from '../../logger';
import { handleLLMErrorResponse } from '../error-handler';
import type { TokenUsage } from '../../../types/usage';
import { DistributedRateLimiter } from '../distributed-rate-limiter';
import { CostCircuitBreaker } from '../../cost-circuit-breaker';
import { retryWithBackoff } from '../../retry-with-backoff';
import type { Env } from '../../../types/env';

/**
 * Anthropic Claude LLM Provider Adapter
 * Implements the adapter pattern for Anthropic's Claude API.
 * Integrated with rate limiter, cost breaker, and retry logic.
 */
export class ClaudeAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly rateLimiter?: DistributedRateLimiter;
    private readonly costBreaker?: CostCircuitBreaker;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? MODELS.claude;
        this.maxTokens = config.maxTokens ?? 4096;
        this.temperature = config.temperature ?? 0.1;
        
        // Initialize rate limiter if binding available
        if ((config as any).env?.RATE_LIMITER) {
            this.rateLimiter = new DistributedRateLimiter(
                (config as any).env.RATE_LIMITER,
                {
                    provider: 'claude',
                    requestsPerMinute: 50, // Claude Tier 1: 50 RPM
                    inputTokensPerMinute: 40000, // Claude Tier 1: 40K TPM
                    outputTokensPerMinute: 8000, // Claude Tier 1: 8K TPM
                    adaptive: true,
                }
            );
        }
        
        // Initialize cost breaker if env available
        if ((config as any).env) {
            this.costBreaker = new CostCircuitBreaker('claude', {
                hourlyLimit: 50.0,  // $50/hour
                dailyLimit: 500.0,  // $500/day
                warningThreshold: 0.8,
                criticalThreshold: 0.95,
            }, (config as any).env);
        }
    }

    /**
     * Dynamically scale output token budget based on chunk content size.
     * Larger chunks may produce more findings needing more output room.
     * Claude Sonnet 4 supports up to 16,384 output tokens.
     */
    private getChunkMaxTokens(chunkContent: string): number {
        return Math.min(8192, 2048 + Math.floor(chunkContent.length / 50));
    }

    getProviderName(): string {
        return 'anthropic';
    }

    getModelName(): string {
        return this.model;
    }

    async reviewChunk(request: ChunkReviewRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Claude reviewChunk requires a composed systemPrompt — use composeChunkPrompt()');
        }
        const { chunkContent, prTitle, chunkLabel } = request;

        const userPrompt = `Pull Request Title: "${prTitle}"

Chunk ${chunkLabel}:
\`\`\`
${chunkContent}
\`\`\`

Analyze this code chunk for issues. Return findings as JSON array.`;

        // Estimate tokens for rate limiter and cost breaker
        const estimatedInputTokens = Math.ceil((request.systemPrompt.length + userPrompt.length) / 4);
        const estimatedOutputTokens = this.getChunkMaxTokens(chunkContent);

        // Check rate limiter if available
        if (this.rateLimiter) {
            const rateLimitResult = await this.rateLimiter.acquire({
                estimatedInputTokens,
                estimatedOutputTokens,
                timeoutMs: 30000,
            });

            if (!rateLimitResult.allowed) {
                throw new Error(`Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`);
            }

            logger.debug('Rate limit acquired', {
                waitTimeMs: rateLimitResult.waitTimeMs,
                utilization: (rateLimitResult.utilization * 100).toFixed(1) + '%',
            });
        }

        // Check cost budget if available
        if (this.costBreaker) {
            const estimatedCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                estimatedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: estimatedOutputTokens,
                temperature: this.temperature,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            }),
            signal,
        });

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Claude');
        }

        const data = await response.json() as {
            content: Array<{ type: string; text: string }>;
            usage: { input_tokens: number; output_tokens: number };
            stop_reason?: string;
        };

        let content = data.content.find(c => c.type === 'text')?.text ?? '';

        if (data.stop_reason === 'max_tokens') {
            logger.warn('Claude MAP chunk generation truncated by max_tokens', { chunkLabel });
        }

        const usage: TokenUsage = {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        };

        // Release unused tokens to rate limiter
        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        // Record actual cost
        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        logger.debug('Claude chunk review completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            chunkLabel,
        });

        return { content, usage };
    }

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Claude synthesize requires a composed systemPrompt — use composeSynthesizerPrompt()');
        }
        const { payload } = request;
        const outputBudget = request.maxTokens ?? this.maxTokens;

        const userPrompt = `Synthesize these code review findings into a final markdown report following the EXACT format in your system instructions:

${payload}`;

        // Estimate tokens for rate limiter and cost breaker
        const estimatedInputTokens = Math.ceil((request.systemPrompt.length + userPrompt.length) / 4);
        const estimatedOutputTokens = outputBudget;

        // Check rate limiter if available
        if (this.rateLimiter) {
            const rateLimitResult = await this.rateLimiter.acquire({
                estimatedInputTokens,
                estimatedOutputTokens,
                timeoutMs: 30000,
            });

            if (!rateLimitResult.allowed) {
                throw new Error(`Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`);
            }

            logger.debug('Rate limit acquired for synthesis', {
                waitTimeMs: rateLimitResult.waitTimeMs,
                utilization: (rateLimitResult.utilization * 100).toFixed(1) + '%',
            });
        }

        // Check cost budget if available
        if (this.costBreaker) {
            const estimatedCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                estimatedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: outputBudget,
                temperature: this.temperature,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            }),
            signal,
        });

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Claude');
        }

        const data = await response.json() as {
            content: Array<{ type: string; text: string }>;
            usage: { input_tokens: number; output_tokens: number };
            stop_reason?: string;
        };

        let content = data.content.find(c => c.type === 'text')?.text ?? '';

        if (data.stop_reason === 'max_tokens') {
            const openFences = (content.match(/```/g) || []).length;
            const needsClose = openFences % 2 !== 0;
            content += (needsClose ? '\n```\n' : '\n') + '\n---\n\n> ⚠️ **AI Generation Truncated** — The model reached its maximum output token limit (`max_tokens`). The remainder of the review has been abruptly cut off. Consider reviewing the raw findings data or breaking the PR into smaller chunks.';
        }

        const usage: TokenUsage = {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        };

        // Release unused tokens to rate limiter
        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        // Record actual cost
        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        logger.debug('Claude synthesis completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
        });

        return { content, usage };
    }
}

// Register the adapter
import { LLMProviderFactory } from '../adapter';
LLMProviderFactory.registerProvider('claude', ClaudeAdapter);
