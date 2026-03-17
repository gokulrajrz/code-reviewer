import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../../config/constants';
import { SYSTEM_PROMPT } from '../../config/system-prompt';

/**
 * Sends the PR diff + file context to Claude and returns the markdown review.
 */
export async function reviewWithClaude(
    reviewContext: string,
    prTitle: string,
    apiKey: string
): Promise<string> {
    const client = new Anthropic({ apiKey });

    const userMessage = `
Please review the following Pull Request.

**PR Title:** ${prTitle}

${reviewContext}
`.trim();

    const message = await client.messages.create({
        model: MODELS.claude,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
    });

    // Extract text from the response
    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Claude returned no text content in response');
    }

    return textBlock.text;
}
