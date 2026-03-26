import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../../config/constants';
import { CHUNK_REVIEWER_PROMPT, SYNTHESIZER_PROMPT } from '../../config/system-prompt';

// ---------------------------------------------------------------------------
// Phase 1: Chunk Review (Map)
// ---------------------------------------------------------------------------

/**
 * Sends a code chunk to Claude for inspection. Returns raw JSON string.
 * Claude doesn't have a native JSON mode, so we rely on strict prompt engineering
 * and parse defensively downstream.
 */
export async function chunkReviewWithClaude(
    chunkContent: string,
    prTitle: string,
    chunkLabel: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey?.trim()) {
        throw new Error('[llm:claude] ANTHROPIC_API_KEY is missing or empty.');
    }

    const client = new Anthropic({ apiKey });

    const userMessage = `
You are reviewing chunk ${chunkLabel} of Pull Request: "${prTitle}"

${chunkContent}

Remember: output ONLY raw JSON matching the schema. No markdown fences. No explanation.
`.trim();

    const message = await client.messages.create({
        model: MODELS.claude,
        max_tokens: 4096,
        system: CHUNK_REVIEWER_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
    }, { signal });

    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('[llm:claude] Claude returned no text content in chunk review response.');
    }

    return textBlock.text;
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis (Reduce)
// ---------------------------------------------------------------------------

/**
 * Sends the aggregated findings payload to Claude for final markdown synthesis.
 */
export async function synthesizeWithClaude(
    synthesizerPayload: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    if (!apiKey?.trim()) {
        throw new Error('[llm:claude] ANTHROPIC_API_KEY is missing or empty.');
    }

    const client = new Anthropic({ apiKey });

    const userMessage = `
Here is the complete review data for synthesis. Produce the final markdown review.

${synthesizerPayload}
`.trim();

    const message = await client.messages.create({
        model: MODELS.claude,
        max_tokens: 8192,
        system: SYNTHESIZER_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
    }, { signal });

    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('[llm:claude] Claude returned no text content in synthesis response.');
    }

    return textBlock.text;
}

// ---------------------------------------------------------------------------
// Legacy (kept for backward compatibility during migration)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use chunkReviewWithClaude + synthesizeWithClaude instead.
 */
export async function reviewWithClaude(
    reviewContext: string,
    prTitle: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<string> {
    return synthesizeWithClaude(
        `PR Title: ${prTitle}\n\n${reviewContext}`,
        apiKey,
        signal
    );
}
