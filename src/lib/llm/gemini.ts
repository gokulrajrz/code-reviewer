import { GoogleGenerativeAI } from '@google/generative-ai';
import { MODELS } from '../../config/constants';
import { SYSTEM_PROMPT } from '../../config/system-prompt';

/**
 * Sends the PR diff + file context to Gemini and returns the markdown review.
 * Gemini 1.5 Pro has a 2M token context window — ideal for large PRs with full file content.
 */
export async function reviewWithGemini(
    reviewContext: string,
    prTitle: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('[llm:gemini] GEMINI_API_KEY is missing or empty. Set it via `wrangler secret put GEMINI_API_KEY`.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
        model: MODELS.gemini,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.2, // Low temperature for consistent, factual code review
        },
    });

    const userMessage = `
Please review the following Pull Request.

**PR Title:** ${prTitle}

${reviewContext}
`.trim();

    let result;
    try {
        result = await model.generateContent(userMessage, { signal });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`[llm:gemini] API call failed: ${errMsg}`);
    }

    const response = result.response;
    const text = response.text();
    if (!text) {
        throw new Error('[llm:gemini] Gemini returned an empty response — the model may have refused or hit a safety filter.');
    }

    return text;
}
