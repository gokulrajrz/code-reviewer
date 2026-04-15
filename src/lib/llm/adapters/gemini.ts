import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { MODELS } from '../../../config/constants';
import { logger } from '../../logger';
import { handleLLMErrorResponse } from '../error-handler';
import type { TokenUsage } from '../../../types/usage';

/**
 * Google Gemini LLM Provider Adapter
 * Implements the adapter pattern for Google's Gemini API.
 * 
 * Uses the `systemInstruction` field for proper system prompt handling
 * instead of faking it as a conversation turn.
 */
export class GeminiAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? MODELS.gemini;
        this.maxTokens = config.maxTokens ?? 4096;
        this.temperature = config.temperature ?? 0.1;
    }

    getProviderName(): string {
        return 'gemini';
    }

    getModelName(): string {
        return this.model;
    }

    async reviewChunk(request: ChunkReviewRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Gemini reviewChunk requires a composed systemPrompt — use composeChunkPrompt()');
        }
        const { chunkContent, prTitle, chunkLabel } = request;

        const userPrompt = `Pull Request Title: "${prTitle}"

Chunk ${chunkLabel}:
\`\`\`
${chunkContent}
\`\`\`

Analyze this code chunk for issues. Return findings as JSON array.`;

        // Use x-goog-api-key header instead of URL query param to avoid key in logs
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-goog-api-key': this.config.apiKey,
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: request.systemPrompt }],
                    },
                    contents: [
                        { role: 'user', parts: [{ text: userPrompt }] },
                    ],
                    generationConfig: {
                        maxOutputTokens: this.maxTokens,
                        temperature: this.temperature,
                        responseMimeType: 'application/json',
                    },
                }),
                signal,
            }
        );

        if (!response.ok) {
            await handleLLMErrorResponse(response, 'Gemini');
        }

        const data = await response.json() as {
            candidates: Array<{
                content: { parts: Array<{ text: string }> };
                finishReason?: string;
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        let content = data.candidates[0]?.content?.parts[0]?.text ?? '';

        if (data.candidates[0]?.finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini MAP chunk generation truncated by max_tokens', { chunkLabel });
        }

        const usage: TokenUsage = {
            inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0),
        };

        logger.debug('Gemini chunk review completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            chunkLabel,
        });

        return { content, usage };
    }

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Gemini synthesize requires a composed systemPrompt — use composeSynthesizerPrompt()');
        }
        const { payload } = request;
        const outputBudget = request.maxTokens ?? this.maxTokens;

        const userPrompt = `Synthesize these code review findings into a final markdown report following the EXACT format in your system instructions:

${payload}`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-goog-api-key': this.config.apiKey,
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: request.systemPrompt }],
                    },
                    contents: [
                        { role: 'user', parts: [{ text: userPrompt }] },
                    ],
                    generationConfig: {
                        maxOutputTokens: outputBudget,
                        temperature: this.temperature,
                    },
                }),
                signal,
            }
        );

        if (!response.ok) {
            await handleLLMErrorResponse(response, 'Gemini');
        }

        const data = await response.json() as {
            candidates: Array<{
                content: { parts: Array<{ text: string }> };
                finishReason?: string;
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        let content = data.candidates[0]?.content?.parts[0]?.text ?? '';

        if (data.candidates[0]?.finishReason === 'MAX_TOKENS') {
            const openFences = (content.match(/```/g) || []).length;
            const needsClose = openFences % 2 !== 0;
            content += (needsClose ? '\n```\n' : '\n') + '\n---\n\n> ⚠️ **AI Generation Truncated** — The model reached its maximum output token limit (`max_tokens`). The remainder of the review has been abruptly cut off. Consider reviewing the raw findings data or breaking the PR into smaller chunks.';
        }

        const usage: TokenUsage = {
            inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0),
        };

        logger.debug('Gemini synthesis completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
        });

        return { content, usage };
    }
}

// Register the adapter
import { LLMProviderFactory } from '../adapter';
LLMProviderFactory.registerProvider('gemini', GeminiAdapter);
