import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../../config/constants';
import { SYSTEM_PROMPT } from '../../config/system-prompt';

/**
 * Sends the PR diff + file context to Claude and returns the markdown review.
 */
export async function reviewWithClaude(
    reviewContext: string,
    prTitle: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('[llm:claude] ANTHROPIC_API_KEY is missing or empty. Set it via `wrangler secret put ANTHROPIC_API_KEY`.');
    }

    const client = new Anthropic({ apiKey });

    const userMessage = `
Please review the following Pull Request.

**PR Title:** ${prTitle}

${reviewContext}
`.trim();

    let message: Anthropic.Message;
    try {
        message = await client.messages.create({
            model: MODELS.claude,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
        }, { signal });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`[llm:claude] API call failed: ${errMsg}`);
    }

    // Extract text from the response
    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('[llm:claude] Claude returned no text content in response — the model may have refused or hit a safety filter.');
    }

    return textBlock.text;
}
