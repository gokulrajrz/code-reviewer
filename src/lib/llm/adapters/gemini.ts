import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { CHUNK_REVIEWER_PROMPT, SYNTHESIZER_PROMPT } from '../../../config/system-prompt';
import { logger } from '../../logger';
import type { TokenUsage } from '../../../types/usage';

/**
 * Google Gemini LLM Provider Adapter
 * Implements the adapter pattern for Google's Gemini API.
 */
export class GeminiAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? 'gemini-1.5-flash';
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

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.config.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [
                        { role: 'user', parts: [{ text: CHUNK_REVIEWER_PROMPT }] },
                        { role: 'model', parts: [{ text: 'I understand. I will analyze code chunks and return findings as JSON.' }] },
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
            const errorText = await response.text();
            // Sanitize error message to prevent potential API key leaks
            const sanitizedError = errorText
                .replace(/key[=:]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi, 'key=[REDACTED]')
                .replace(/api[_-]?key['"]?\s*[=:]\s*['"]?[^'"\s]+['"]?/gi, 'api_key=[REDACTED]')
                .substring(0, 500); // Limit error text length
            throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${sanitizedError}`);
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

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.config.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [
                        { role: 'user', parts: [{ text: SYNTHESIZER_PROMPT }] },
                        { role: 'model', parts: [{ text: 'I understand. I will synthesize code review findings into markdown.' }] },
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
            const errorText = await response.text();
            // Sanitize error message to prevent potential API key leaks
            const sanitizedError = errorText
                .replace(/key[=:]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi, 'key=[REDACTED]')
                .replace(/api[_-]?key['"]?\s*[=:]\s*['"]?[^'"\s]+['"]?/gi, 'api_key=[REDACTED]')
                .substring(0, 500); // Limit error text length
            throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${sanitizedError}`);
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
