/**
 * Comprehensive tests for the Web Search Grounding integration.
 *
 * Tests cover:
 * 1. Configuration (isWebSearchEnabled)
 * 2. Gemini grounding metadata extraction
 * 3. Claude web search metadata extraction
 * 4. Claude text content extraction from multi-block responses
 * 5. Source formatting and deduplication
 * 6. Prompt composer web search injection
 * 7. Adapter config threading
 */

import { describe, it, expect } from 'vitest';

import {
    isWebSearchEnabled,
    extractGeminiGroundingMetadata,
    extractClaudeSearchMetadata,
    extractClaudeTextContent,
    formatSearchSources,
    CLAUDE_WEB_SEARCH_MAX_USES,
    CLAUDE_WEB_SEARCH_TOOL_VERSION,
    type GeminiGroundingMetadata,
    type ClaudeContentBlock,
    type WebSearchMetadata,
} from '../src/lib/web-search';

import { composeChunkPrompt, composeSynthesizerPrompt } from '../src/config/prompts/composer';
import type { TechStackProfile } from '../src/types/stack';
import type { Env } from '../src/types/env';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Minimal Env stub with web search enabled. */
function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
        ANTHROPIC_API_KEY: 'test-key',
        GEMINI_API_KEY: 'test-key',
        GITHUB_APP_ID: 'test-id',
        GITHUB_APP_PRIVATE_KEY: 'test-pk',
        GITHUB_APP_INSTALLATION_ID: 'test-inst',
        GITHUB_WEBHOOK_SECRET: 'test-secret',
        ENABLE_WEB_SEARCH: 'true',
        ...overrides,
    } as unknown as Env;
}

/** Minimal TechStackProfile for prompt composition tests. */
const MINIMAL_PROFILE: TechStackProfile = {
    languages: ['typescript'],
    frameworks: [],
    stateManagement: [],
    dataFetching: [],
    styling: [],
    architecture: [],
    forms: [],
    validation: [],
    testing: [],
    confidence: 'low',
    source: 'file-extensions',
};

/** Realistic Gemini groundingMetadata fixture. */
const GEMINI_GROUNDING_METADATA: GeminiGroundingMetadata = {
    webSearchQueries: [
        'React useEffect cleanup best practices 2025',
        'CVE lodash prototype pollution',
    ],
    searchEntryPoint: { renderedContent: '<!-- search widget HTML -->' },
    groundingChunks: [
        { web: { uri: 'https://react.dev/reference/react/useEffect', title: 'useEffect – React' } },
        { web: { uri: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337', title: 'CVE-2021-23337' } },
        { web: { uri: 'https://github.com/advisories/GHSA-xxxx', title: 'lodash advisory' } },
    ],
    groundingSupports: [
        {
            segment: { startIndex: 0, endIndex: 120, text: 'useEffect requires cleanup...' },
            groundingChunkIndices: [0],
        },
        {
            segment: { startIndex: 121, endIndex: 250, text: 'lodash has known CVE...' },
            groundingChunkIndices: [1, 2],
        },
    ],
};

/** Realistic Claude web search response content blocks. */
const CLAUDE_SEARCH_CONTENT_BLOCKS: ClaudeContentBlock[] = [
    {
        type: 'text',
        text: "I'll search for the latest React best practices and lodash security advisories.",
    },
    {
        type: 'server_tool_use',
        id: 'srvtoolu_01ABC',
        name: 'web_search',
        input: { query: 'React useEffect cleanup pattern 2025' },
    },
    {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_01ABC',
        content: [
            {
                type: 'web_search_result',
                url: 'https://react.dev/reference/react/useEffect',
                title: 'useEffect – React',
                encrypted_content: 'encrypted...',
                page_age: 'April 2025',
            },
            {
                type: 'web_search_result',
                url: 'https://react.dev/learn/synchronizing-with-effects',
                title: 'Synchronizing with Effects – React',
            },
        ],
    },
    {
        type: 'server_tool_use',
        id: 'srvtoolu_02DEF',
        name: 'web_search',
        input: { query: 'lodash CVE prototype pollution 2024' },
    },
    {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_02DEF',
        content: [
            {
                type: 'web_search_result',
                url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337',
                title: 'CVE-2021-23337 Detail',
            },
        ],
    },
    {
        type: 'text',
        text: '{"findings":[{"severity":"high","file":"src/utils.ts","title":"Lodash prototype pollution CVE","issue":"lodash@4.17.15 has CVE-2021-23337","category":"security"}]}',
    },
];

// ---------------------------------------------------------------------------
// 1. Configuration: isWebSearchEnabled
// ---------------------------------------------------------------------------

describe('isWebSearchEnabled', () => {
    it('returns true when ENABLE_WEB_SEARCH is "true"', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: 'true' }))).toBe(true);
    });

    it('returns true when ENABLE_WEB_SEARCH is "TRUE" (case-insensitive)', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: 'TRUE' }))).toBe(true);
    });

    it('returns true when ENABLE_WEB_SEARCH is "1"', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: '1' }))).toBe(true);
    });

    it('returns false when ENABLE_WEB_SEARCH is "false"', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: 'false' }))).toBe(false);
    });

    it('returns false when ENABLE_WEB_SEARCH is undefined', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: undefined }))).toBe(false);
    });

    it('returns false when ENABLE_WEB_SEARCH is empty string', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: '' }))).toBe(false);
    });

    it('returns false for random string value', () => {
        expect(isWebSearchEnabled(makeEnv({ ENABLE_WEB_SEARCH: 'maybe' }))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. Gemini Grounding Metadata Extraction
// ---------------------------------------------------------------------------

describe('extractGeminiGroundingMetadata', () => {
    it('extracts search queries from grounding metadata', () => {
        const result = extractGeminiGroundingMetadata(GEMINI_GROUNDING_METADATA);
        expect(result.searchQueries).toHaveLength(2);
        expect(result.searchQueries[0]).toContain('React useEffect');
        expect(result.searchQueries[1]).toContain('CVE lodash');
    });

    it('extracts web sources with URLs and titles', () => {
        const result = extractGeminiGroundingMetadata(GEMINI_GROUNDING_METADATA);
        expect(result.sources).toHaveLength(3);
        expect(result.sources[0]).toEqual({
            url: 'https://react.dev/reference/react/useEffect',
            title: 'useEffect – React',
        });
        expect(result.sources[2]).toEqual({
            url: 'https://github.com/advisories/GHSA-xxxx',
            title: 'lodash advisory',
        });
    });

    it('counts search requests correctly', () => {
        const result = extractGeminiGroundingMetadata(GEMINI_GROUNDING_METADATA);
        expect(result.searchRequestCount).toBe(2);
    });

    it('returns empty metadata when groundingMetadata is undefined', () => {
        const result = extractGeminiGroundingMetadata(undefined);
        expect(result).toEqual({
            searchQueries: [],
            sources: [],
            searchRequestCount: 0,
        });
    });

    it('handles grounding metadata with empty arrays', () => {
        const result = extractGeminiGroundingMetadata({
            webSearchQueries: [],
            groundingChunks: [],
        });
        expect(result.searchQueries).toHaveLength(0);
        expect(result.sources).toHaveLength(0);
        expect(result.searchRequestCount).toBe(0);
    });

    it('handles grounding chunks without web property', () => {
        const result = extractGeminiGroundingMetadata({
            webSearchQueries: ['test query'],
            groundingChunks: [
                { web: undefined } as any,
                { web: { uri: 'https://example.com', title: 'Example' } },
            ],
        });
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].url).toBe('https://example.com');
    });

    it('handles metadata with only webSearchQueries (no chunks)', () => {
        const result = extractGeminiGroundingMetadata({
            webSearchQueries: ['query 1', 'query 2'],
        });
        expect(result.searchQueries).toHaveLength(2);
        expect(result.sources).toHaveLength(0);
        expect(result.searchRequestCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 3. Claude Web Search Metadata Extraction
// ---------------------------------------------------------------------------

describe('extractClaudeSearchMetadata', () => {
    it('extracts search queries from server_tool_use blocks', () => {
        const result = extractClaudeSearchMetadata(CLAUDE_SEARCH_CONTENT_BLOCKS);
        expect(result.searchQueries).toHaveLength(2);
        expect(result.searchQueries[0]).toContain('React useEffect');
        expect(result.searchQueries[1]).toContain('lodash CVE');
    });

    it('extracts sources from web_search_tool_result blocks', () => {
        const result = extractClaudeSearchMetadata(CLAUDE_SEARCH_CONTENT_BLOCKS);
        expect(result.sources).toHaveLength(3);
        expect(result.sources[0]).toEqual({
            url: 'https://react.dev/reference/react/useEffect',
            title: 'useEffect – React',
        });
    });

    it('counts search requests correctly', () => {
        const result = extractClaudeSearchMetadata(CLAUDE_SEARCH_CONTENT_BLOCKS);
        expect(result.searchRequestCount).toBe(2);
    });

    it('returns empty metadata for content with no search blocks', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'text', text: 'Just a regular response' },
        ];
        const result = extractClaudeSearchMetadata(blocks);
        expect(result).toEqual({
            searchQueries: [],
            sources: [],
            searchRequestCount: 0,
        });
    });

    it('handles empty content array', () => {
        const result = extractClaudeSearchMetadata([]);
        expect(result.searchRequestCount).toBe(0);
        expect(result.sources).toHaveLength(0);
    });

    it('handles server_tool_use without input.query', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'server_tool_use', name: 'web_search', input: {} },
        ];
        const result = extractClaudeSearchMetadata(blocks);
        expect(result.searchRequestCount).toBe(1);
        expect(result.searchQueries).toHaveLength(0); // no query extracted
    });

    it('handles web_search_tool_result with error content', () => {
        const blocks: ClaudeContentBlock[] = [
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_err',
                content: [
                    { type: 'web_search_tool_result_error' } as any,
                ],
            },
        ];
        const result = extractClaudeSearchMetadata(blocks);
        expect(result.sources).toHaveLength(0); // error entries skipped
    });
});

// ---------------------------------------------------------------------------
// 4. Claude Text Content Extraction
// ---------------------------------------------------------------------------

describe('extractClaudeTextContent', () => {
    it('concatenates all text blocks from a multi-block response', () => {
        const content = extractClaudeTextContent(CLAUDE_SEARCH_CONTENT_BLOCKS);
        // Should contain both text blocks joined by newline
        expect(content).toContain("I'll search for the latest");
        expect(content).toContain('"findings"');
    });

    it('filters out non-text blocks', () => {
        const content = extractClaudeTextContent(CLAUDE_SEARCH_CONTENT_BLOCKS);
        expect(content).not.toContain('server_tool_use');
        expect(content).not.toContain('web_search_tool_result');
    });

    it('returns empty string when no text blocks exist', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'server_tool_use', name: 'web_search', input: { query: 'test' } },
        ];
        expect(extractClaudeTextContent(blocks)).toBe('');
    });

    it('handles single text block', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'text', text: 'Hello world' },
        ];
        expect(extractClaudeTextContent(blocks)).toBe('Hello world');
    });

    it('handles text blocks with empty text', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'text', text: '' },
            { type: 'text', text: 'content' },
        ];
        // Empty text blocks should be filtered (text is falsy empty string)
        const content = extractClaudeTextContent(blocks);
        expect(content).toBe('content');
    });
});

// ---------------------------------------------------------------------------
// 5. Source Formatting
// ---------------------------------------------------------------------------

describe('formatSearchSources', () => {
    it('formats sources as a collapsible markdown section', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [
                { url: 'https://react.dev/docs', title: 'React Docs' },
                { url: 'https://nvd.nist.gov/vuln/CVE-123', title: 'CVE-123' },
            ],
            searchRequestCount: 1,
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('<details>');
        expect(result).toContain('🌐');
        expect(result).toContain('Web Sources Referenced (2)');
        expect(result).toContain('[React Docs](https://react.dev/docs)');
        expect(result).toContain('[CVE-123](https://nvd.nist.gov/vuln/CVE-123)');
        expect(result).toContain('</details>');
    });

    it('returns empty string when no sources', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: [],
            sources: [],
            searchRequestCount: 0,
        };
        expect(formatSearchSources(metadata)).toBe('');
    });

    it('deduplicates sources by URL', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [
                { url: 'https://example.com', title: 'Example 1' },
                { url: 'https://example.com', title: 'Example 2' }, // duplicate URL
                { url: 'https://other.com', title: 'Other' },
            ],
            searchRequestCount: 1,
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('Web Sources Referenced (2)');
        // Only the first occurrence should be kept
        expect(result).toContain('Example 1');
        expect(result).not.toContain('Example 2');
    });

    it('caps sources at 10 entries', () => {
        const sources = Array.from({ length: 15 }, (_, i) => ({
            url: `https://example.com/page${i}`,
            title: `Source ${i}`,
        }));
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources,
            searchRequestCount: 1,
        };

        const result = formatSearchSources(metadata);
        // Should show total count but only 10 links
        expect(result).toContain('Web Sources Referenced (15)');
        expect(result).toContain('Source 0');
        expect(result).toContain('Source 9');
        expect(result).not.toContain('Source 10');
    });

    it('uses "Source" as fallback title when title is empty', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [{ url: 'https://example.com', title: '' }],
            searchRequestCount: 1,
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('[Source](https://example.com)');
    });
});

// ---------------------------------------------------------------------------
// 6. Constants
// ---------------------------------------------------------------------------

describe('Web Search Constants', () => {
    it('Claude web search max uses is reasonable', () => {
        expect(CLAUDE_WEB_SEARCH_MAX_USES).toBeGreaterThan(0);
        expect(CLAUDE_WEB_SEARCH_MAX_USES).toBeLessThanOrEqual(10);
    });

    it('Claude web search tool version is a valid format', () => {
        expect(CLAUDE_WEB_SEARCH_TOOL_VERSION).toMatch(/^web_search_\d{8}$/);
    });
});

// ---------------------------------------------------------------------------
// 7. Prompt Composer Integration
// ---------------------------------------------------------------------------

describe('Prompt Composer: Web Search Integration', () => {
    it('includes web search prompt when webSearchEnabled is true', () => {
        const prompt = composeChunkPrompt(
            MINIMAL_PROFILE,
            ['src/app.ts'],
            undefined,
            true
        );
        expect(prompt).toContain('WEB SEARCH GROUNDING (ENABLED)');
        expect(prompt).toContain('WHEN TO SEARCH');
        expect(prompt).toContain('SEARCH GUIDELINES');
    });

    it('excludes web search prompt when webSearchEnabled is false', () => {
        const prompt = composeChunkPrompt(
            MINIMAL_PROFILE,
            ['src/app.ts'],
            undefined,
            false
        );
        expect(prompt).not.toContain('WEB SEARCH GROUNDING');
    });

    it('excludes web search prompt when webSearchEnabled is undefined', () => {
        const prompt = composeChunkPrompt(
            MINIMAL_PROFILE,
            ['src/app.ts'],
            undefined,
            undefined
        );
        expect(prompt).not.toContain('WEB SEARCH GROUNDING');
    });

    it('web search prompt appears AFTER the output format section', () => {
        const prompt = composeChunkPrompt(
            MINIMAL_PROFILE,
            ['src/app.ts'],
            undefined,
            true
        );
        const outputFormatIdx = prompt.indexOf('OUTPUT FORMAT');
        const webSearchIdx = prompt.indexOf('WEB SEARCH GROUNDING');
        expect(outputFormatIdx).toBeGreaterThan(-1);
        expect(webSearchIdx).toBeGreaterThan(-1);
        expect(webSearchIdx).toBeGreaterThan(outputFormatIdx);
    });

    it('synthesizer prompt includes web search note when enabled', () => {
        const prompt = composeSynthesizerPrompt(MINIMAL_PROFILE, true);
        expect(prompt).toContain('web search grounding');
    });

    it('synthesizer prompt excludes web search note when disabled', () => {
        const prompt = composeSynthesizerPrompt(MINIMAL_PROFILE, false);
        expect(prompt).not.toContain('web search grounding');
    });

    it('web search prompt coexists with custom rules', () => {
        const prompt = composeChunkPrompt(
            MINIMAL_PROFILE,
            ['src/app.ts'],
            'Always use strict TypeScript.',
            true
        );
        expect(prompt).toContain('Always use strict TypeScript');
        expect(prompt).toContain('WEB SEARCH GROUNDING');
    });
});

// ---------------------------------------------------------------------------
// 8. End-to-End: Full Gemini Metadata Pipeline
// ---------------------------------------------------------------------------

describe('End-to-End: Gemini Search Metadata → Formatted Output', () => {
    it('processes a full Gemini grounding response into formatted sources', () => {
        const metadata = extractGeminiGroundingMetadata(GEMINI_GROUNDING_METADATA);
        const formatted = formatSearchSources(metadata);

        // Validate metadata
        expect(metadata.searchRequestCount).toBe(2);
        expect(metadata.sources).toHaveLength(3);

        // Validate formatted output
        expect(formatted).toContain('useEffect – React');
        expect(formatted).toContain('CVE-2021-23337');
        expect(formatted).toContain('lodash advisory');
    });
});

// ---------------------------------------------------------------------------
// 9. End-to-End: Full Claude Metadata Pipeline
// ---------------------------------------------------------------------------

describe('End-to-End: Claude Search Response → Text + Metadata', () => {
    it('processes a full Claude web search response into text and metadata', () => {
        const text = extractClaudeTextContent(CLAUDE_SEARCH_CONTENT_BLOCKS);
        const metadata = extractClaudeSearchMetadata(CLAUDE_SEARCH_CONTENT_BLOCKS);

        // Validate text extraction
        expect(text).toContain("I'll search for the latest");
        expect(text).toContain('"findings"');

        // Validate metadata
        expect(metadata.searchRequestCount).toBe(2);
        expect(metadata.sources).toHaveLength(3);

        // Validate formatted output
        const formatted = formatSearchSources(metadata);
        expect(formatted).toContain('useEffect – React');
        expect(formatted).toContain('CVE-2021-23337');
    });

    it('extracted JSON is parseable from the concatenated text', () => {
        const text = extractClaudeTextContent(CLAUDE_SEARCH_CONTENT_BLOCKS);

        // The JSON findings should be extractable from the text
        // (same way parseFindings would do it)
        const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
        expect(jsonMatch).not.toBeNull();

        const parsed = JSON.parse(jsonMatch![0]);
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.findings[0].severity).toBe('high');
        expect(parsed.findings[0].title).toContain('Lodash');
    });
});
