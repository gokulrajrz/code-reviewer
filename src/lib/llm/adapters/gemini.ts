import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { CHUNK_REVIEWER_PROMPT, SYNTHESIZER_PROMPT } from '../../../config/system-prompt';
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
        const { chunkContent, prTitle, chunkLabel } = request;

        const userPrompt = `Pull Request Title: "${prTitle}"

Chunk ${chunkLabel}:
\`\`\`
${chunkContent}
\`\`\`

Analyze this code chunk for issues. Return findings as JSON array.`;

        // Note: Google's Gemini API requires the key in the URL query string
        // This is intentional by their design, not a security flaw on our part.
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.config.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    // Use systemInstruction for proper system prompt handling
                    systemInstruction: {
                        parts: [{ text: request.systemPrompt || CHUNK_REVIEWER_PROMPT }],
                    },
                    contents: [
                        { role: 'user', parts: [{ text: userPrompt }] },
                    ],
                    generationConfig: {
                        maxOutputTokens: this.maxTokens,
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
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        const content = data.candidates[0]?.content?.parts[0]?.text ?? '';

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
        const { payload } = request;

        const userPrompt = `Synthesize these code review findings into a cohesive markdown report:

${payload}`;

        // Note: Google's Gemini API requires the key in the URL query string
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.config.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: request.systemPrompt || SYNTHESIZER_PROMPT }],
                    },
                    contents: [
                        { role: 'user', parts: [{ text: userPrompt }] },
                    ],
                    generationConfig: {
                        maxOutputTokens: this.maxTokens,
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
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        const content = data.candidates[0]?.content?.parts[0]?.text ?? '';

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
