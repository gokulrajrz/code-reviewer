import type { AIProvider, Env } from '../../types/env';
import { DEFAULT_AI_PROVIDER } from '../../config/constants';
import { reviewWithClaude } from './claude';
import { reviewWithGemini } from './gemini';

/**
 * Unified LLM dispatcher.
 * Reads AI_PROVIDER from env (defaults to "claude") and calls the appropriate adapter.
 *
 * To switch to Gemini, set: AI_PROVIDER=gemini in wrangler.jsonc vars or via wrangler deploy --var
 */
export async function callLLM(
    reviewContext: string,
    prTitle: string,
    env: Env
): Promise<string> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;

    switch (provider) {
        case 'gemini':
            return reviewWithGemini(reviewContext, prTitle, env.GEMINI_API_KEY);

        case 'claude':
        default:
            return reviewWithClaude(reviewContext, prTitle, env.ANTHROPIC_API_KEY);
    }
}
