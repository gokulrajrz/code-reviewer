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
    apiKey: string
): Promise<string> {
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

    const result = await model.generateContent(userMessage);
    const response = result.response;

    const text = response.text();
    if (!text) {
        throw new Error('Gemini returned an empty response');
    }

    return text;
}
