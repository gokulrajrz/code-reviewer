import { GoogleGenerativeAI } from '@google/generative-ai';
import { MODELS } from '../../config/constants';
import { CHUNK_REVIEWER_PROMPT, SYNTHESIZER_PROMPT } from '../../config/system-prompt';

// ---------------------------------------------------------------------------
// Phase 1: Chunk Review (Map)
// ---------------------------------------------------------------------------

/**
 * Sends a code chunk to Gemini for inspection. Returns raw JSON string.
 * Gemini supports native JSON mode via responseMimeType, which is far more
 * reliable than prompt-only enforcement.
 */
export async function chunkReviewWithGemini(
    chunkContent: string,
    prTitle: string,
    chunkLabel: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey?.trim()) {
        throw new Error('[llm:gemini] GEMINI_API_KEY is missing or empty.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
        model: MODELS.gemini,
        systemInstruction: CHUNK_REVIEWER_PROMPT,
        generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.1, // Very low for deterministic code analysis
            responseMimeType: 'application/json', // Native JSON mode
        },
    });

    const userMessage = `
You are reviewing chunk ${chunkLabel} of Pull Request: "${prTitle}"

${chunkContent}
`.trim();

    const result = await model.generateContent(userMessage, { signal });

    const text = result.response.text();
    if (!text) {
        throw new Error('[llm:gemini] Gemini returned an empty response in chunk review.');
    }

    return text;
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis (Reduce)
// ---------------------------------------------------------------------------

/**
 * Sends the aggregated findings payload to Gemini for final markdown synthesis.
 * Note: we deliberately do NOT use JSON mode here — the output is markdown.
 */
export async function synthesizeWithGemini(
    synthesizerPayload: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey?.trim()) {
        throw new Error('[llm:gemini] GEMINI_API_KEY is missing or empty.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
        model: MODELS.gemini,
        systemInstruction: SYNTHESIZER_PROMPT,
        generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.2,
        },
    });

    const userMessage = `
Here is the complete review data for synthesis. Produce the final markdown review.

${synthesizerPayload}
`.trim();

    const result = await model.generateContent(userMessage, { signal });

    const text = result.response.text();
    if (!text) {
        throw new Error('[llm:gemini] Gemini returned an empty response in synthesis.');
    }

    return text;
}

