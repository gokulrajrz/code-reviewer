import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { CHUNK_REVIEWER_PROMPT, SYNTHESIZER_PROMPT } from '../../../config/system-prompt';
import { MODELS } from '../../../config/constants';
import { logger } from '../../logger';
import { handleLLMErrorResponse } from '../error-handler';
import type { TokenUsage } from '../../../types/usage';

/**
 * Anthropic Claude LLM Provider Adapter
 * Implements the adapter pattern for Anthropic's Claude API.
 */
export class ClaudeAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? MODELS.claude;
        this.maxTokens = config.maxTokens ?? 4096;
        this.temperature = config.temperature ?? 0.1;
    }

    getProviderName(): string {
        return 'anthropic';
    }

    getModelName(): string {
        return this.model;
    }

    async reviewChunk(request: ChunkReviewRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const { chunkContent, prTitle, chunkLabel } = request;

        const userPrompt = `Pull Request Title: "${prTitle}"

Chunk ${chunkLabel}:
\`\`\`
${chunkContent}
\`\`\`

Analyze this code chunk for issues. Return findings as JSON array.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
                system: request.systemPrompt
                    ? `${CHUNK_REVIEWER_PROMPT}\n\n---\n\nADDITIONAL REVIEW CONTEXT:\n${request.systemPrompt}`
                    : CHUNK_REVIEWER_PROMPT,
                messages: [{ role: 'user', content: userPrompt }],
            }),
            signal,
        });

        if (!response.ok) {
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

        logger.debug('Claude chunk review completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            chunkLabel,
        });

        return { content, usage };
    }

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const { payload } = request;
        const outputBudget = request.maxTokens ?? this.maxTokens;

        const userPrompt = `Synthesize these code review findings into a final markdown report following the EXACT format in your system instructions:

${payload}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: outputBudget,
                temperature: this.temperature,
                system: request.systemPrompt
                    ? `${SYNTHESIZER_PROMPT}\n\n---\n\nADDITIONAL REVIEW CONTEXT:\n${request.systemPrompt}`
                    : SYNTHESIZER_PROMPT,
                messages: [{ role: 'user', content: userPrompt }],
            }),
            signal,
        });

        if (!response.ok) {
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
