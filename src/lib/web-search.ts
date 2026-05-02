/**
 * Web Search Integration Module
 *
 * Provides web search grounding for LLM-based code reviews.
 * Both Gemini (Google Search grounding) and Claude (web_search server tool)
 * support native web search — zero extra subrequests from the Worker.
 *
 * This module handles:
 * - Configuration parsing from env vars
 * - Response metadata extraction (grounding sources, citations)
 * - Source formatting for PR review output
 */

import type { Env } from '../types/env';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** A web source returned by the LLM's search grounding. */
export interface WebSearchSource {
    url: string;
    title: string;
}

/** Aggregated web search metadata from an LLM response. */
export interface WebSearchMetadata {
    /** Search queries the LLM executed. */
    searchQueries: string[];
    /** Sources cited in the response. */
    sources: WebSearchSource[];
    /** Number of search requests made (for billing tracking). */
    searchRequestCount: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Check if web search is enabled for this environment.
 * Controlled by the ENABLE_WEB_SEARCH env var (default: false).
 */
export function isWebSearchEnabled(env: Env): boolean {
    const val = env.ENABLE_WEB_SEARCH;
    if (!val) return false;
    return val.toLowerCase() === 'true' || val === '1';
}

/** Max web searches Claude can execute per API call (controls cost). */
export const CLAUDE_WEB_SEARCH_MAX_USES = 3;

/** Claude web search tool version. */
export const CLAUDE_WEB_SEARCH_TOOL_VERSION = 'web_search_20250305';

// ---------------------------------------------------------------------------
// Gemini Grounding Metadata Extraction
// ---------------------------------------------------------------------------

/** Gemini groundingMetadata shape from the generateContent response. */
export interface GeminiGroundingMetadata {
    webSearchQueries?: string[];
    searchEntryPoint?: { renderedContent: string };
    groundingChunks?: Array<{
        web?: { uri: string; title: string };
    }>;
    groundingSupports?: Array<{
        segment?: { startIndex: number; endIndex: number; text: string };
        groundingChunkIndices?: number[];
    }>;
}

/**
 * Extract web search metadata from a Gemini grounding response.
 */
export function extractGeminiGroundingMetadata(
    groundingMetadata?: GeminiGroundingMetadata
): WebSearchMetadata {
    if (!groundingMetadata) {
        return { searchQueries: [], sources: [], searchRequestCount: 0 };
    }

    const sources: WebSearchSource[] = (groundingMetadata.groundingChunks ?? [])
        .filter((chunk): chunk is { web: { uri: string; title: string } } => !!chunk.web)
        .map(chunk => ({
            url: chunk.web.uri,
            title: chunk.web.title,
        }));

    return {
        searchQueries: groundingMetadata.webSearchQueries ?? [],
        sources,
        searchRequestCount: groundingMetadata.webSearchQueries?.length ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Claude Web Search Metadata Extraction
// ---------------------------------------------------------------------------

/** Claude content block types when web search is active. */
export interface ClaudeContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: { query?: string };
    tool_use_id?: string;
    content?: Array<{
        type: string;
        url?: string;
        title?: string;
        encrypted_content?: string;
        page_age?: string;
    }>;
    citations?: Array<{
        type: string;
        url: string;
        title: string;
        cited_text?: string;
    }>;
}

/**
 * Extract web search metadata from Claude's response content blocks.
 */
export function extractClaudeSearchMetadata(
    contentBlocks: ClaudeContentBlock[]
): WebSearchMetadata {
    const searchQueries: string[] = [];
    const sources: WebSearchSource[] = [];
    let searchRequestCount = 0;

    for (const block of contentBlocks) {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
            if (block.input?.query) searchQueries.push(block.input.query);
            searchRequestCount++;
        }

        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            for (const result of block.content) {
                if (result.type === 'web_search_result' && result.url) {
                    sources.push({
                        url: result.url,
                        title: result.title ?? '',
                    });
                }
            }
        }
    }

    return { searchQueries, sources, searchRequestCount };
}

/**
 * Extract the text content from Claude's response when web search is active.
 * With web search, multiple text blocks are interspersed with search blocks.
 * We concatenate only the text blocks to get the final output.
 */
export function extractClaudeTextContent(contentBlocks: ClaudeContentBlock[]): string {
    return contentBlocks
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n');
}

// ---------------------------------------------------------------------------
// Formatting for PR Output
// ---------------------------------------------------------------------------

/**
 * Format web search sources as a collapsible markdown section.
 * Appended to the final review when web search was used.
 */
export function formatSearchSources(metadata: WebSearchMetadata): string {
    if (metadata.sources.length === 0) return '';

    const unique = deduplicateSources(metadata.sources);
    const sourceLinks = unique
        .slice(0, 10) // Cap at 10 to avoid noise
        .map((s, i) => `${i + 1}. [${s.title || 'Source'}](${s.url})`)
        .join('\n');

    return (
        `\n\n<details>\n<summary>🌐 <b>Web Sources Referenced (${unique.length})</b></summary>\n\n` +
        `${sourceLinks}\n\n</details>`
    );
}

function deduplicateSources(sources: WebSearchSource[]): WebSearchSource[] {
    const seen = new Set<string>();
    return sources.filter(s => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
    });
}
