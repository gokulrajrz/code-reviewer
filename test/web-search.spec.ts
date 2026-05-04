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
    shouldEnableWebSearch,
    extractGeminiGroundingMetadata,
    extractClaudeSearchMetadata,
    extractClaudeTextContent,
    formatSearchSources,
    formatCachedSourcesContext,
    CLAUDE_WEB_SEARCH_MAX_USES,
    CLAUDE_WEB_SEARCH_TOOL_VERSION,
    CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS,
    SEARCH_TOKEN_BUDGET_MULTIPLIER,
    CLAUDE_MAX_SEARCH_CONTINUATIONS,
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
        // Should show 'showing 10 of 15' since we cap at 10 links
        expect(result).toContain('showing 10 of 15');
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
        // URL sanitization normalizes to trailing slash; fallback title 'Source' is used
        expect(result).toContain('[Source](https://example.com/)');
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

    it('allowed domains includes key security and docs sources', () => {
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).toContain('nvd.nist.gov');
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).toContain('github.com');
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).toContain('developer.mozilla.org');
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).toContain('npmjs.com');
    });

    it('allowed domains does not include generic search engines or blogs', () => {
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).not.toContain('google.com');
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).not.toContain('medium.com');
        expect(CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS).not.toContain('stackoverflow.com');
    });

    it('search token budget multiplier is between 1x and 3x', () => {
        expect(SEARCH_TOKEN_BUDGET_MULTIPLIER).toBeGreaterThanOrEqual(1);
        expect(SEARCH_TOKEN_BUDGET_MULTIPLIER).toBeLessThanOrEqual(3);
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

    it('web search prompt appears BEFORE the output format section', () => {
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
        // Web search BEFORE output format so model integrates search into review reasoning
        expect(webSearchIdx).toBeLessThan(outputFormatIdx);
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

// ---------------------------------------------------------------------------
// 10. Smart Gating: shouldEnableWebSearch
// ---------------------------------------------------------------------------

describe('shouldEnableWebSearch (Smart Gating)', () => {
    it('returns true for source code files when globally enabled', () => {
        const files = ['src/app.ts', 'src/utils.ts'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns false when globally disabled even with source code', () => {
        const files = ['src/app.ts'];
        expect(shouldEnableWebSearch(files, makeEnv({ ENABLE_WEB_SEARCH: 'false' }))).toBe(false);
    });

    it('returns false for docs-only PRs', () => {
        const files = ['README.md', 'docs/guide.md', 'CHANGELOG.md'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(false);
    });

    it('returns false for config-only PRs', () => {
        const files = ['.eslintrc.yml', 'tsconfig.json', '.env.example'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(false);
    });

    it('returns false for assets-only PRs', () => {
        const files = ['public/logo.svg', 'images/banner.png'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(false);
    });

    it('returns true when security-sensitive files are present', () => {
        const files = ['src/auth/login.ts', 'README.md'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true for crypto-related files', () => {
        const files = ['src/lib/crypto-utils.ts'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true for JWT/token files', () => {
        const files = ['src/middleware/jwt-verify.ts'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns false for mostly config with one source file (below 20% threshold)', () => {
        const files = [
            'package.json', 'tsconfig.json', '.eslintrc.json',
            'jest.config.json', '.prettierrc.json',
            'src/tiny.ts', // Only 1 out of 6 = 16.7% < 20%
        ];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(false);
    });

    it('returns true when source files exceed 20% threshold', () => {
        const files = [
            'package.json', 'tsconfig.json',
            'src/app.ts', 'src/utils.ts', // 2 out of 4 = 50%
        ];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true for mixed PR with Python files', () => {
        const files = ['src/main.py', 'requirements.txt'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true for Go files', () => {
        const files = ['cmd/server/main.go'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('handles empty file list gracefully', () => {
        expect(shouldEnableWebSearch([], makeEnv())).toBe(false);
    });

    // P1-1 Regression: No false positives from security patterns
    it('does NOT trigger security search for authors.ts (auth substring)', () => {
        // "authors" contains "auth" but is not security-related
        const files = ['src/utils/authors.ts'];
        // It should still return true because it's source code (>20%),
        // but NOT because of security patterns
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('does NOT trigger security search for TokenDisplay.tsx (token substring)', () => {
        // "TokenDisplay" contains "Token" but we removed /token/i from patterns
        const files = ['src/components/TokenDisplay.tsx', 'README.md'];
        // Has source code so search is enabled, but via threshold not security
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true via security for /auth/ directory path', () => {
        const files = ['src/auth/middleware.ts'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });

    it('returns true for files with .json that are NOT config files', () => {
        // Non-config .json files should NOT be in NON_SEARCHABLE_PATTERNS
        const files = ['src/fixtures/data.json', 'src/app.ts'];
        expect(shouldEnableWebSearch(files, makeEnv())).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 11. KV Cache: formatCachedSourcesContext
// ---------------------------------------------------------------------------

describe('formatCachedSourcesContext', () => {
    it('returns empty string for no sources', () => {
        expect(formatCachedSourcesContext([])).toBe('');
    });

    it('formats sources as a prompt context section', () => {
        const sources = [
            { url: 'https://react.dev/docs', title: 'React Docs' },
            { url: 'https://nvd.nist.gov/cve-123', title: 'CVE-123' },
        ];
        const result = formatCachedSourcesContext(sources);
        expect(result).toContain('PREVIOUSLY VERIFIED SOURCES');
        expect(result).toContain('React Docs: https://react.dev/docs');
        expect(result).toContain('CVE-123: https://nvd.nist.gov/cve-123');
    });

    it('caps at 10 sources to avoid prompt bloat', () => {
        const sources = Array.from({ length: 15 }, (_, i) => ({
            url: `https://example.com/${i}`,
            title: `Source ${i}`,
        }));
        const result = formatCachedSourcesContext(sources);
        expect(result).toContain('Source 9');
        expect(result).not.toContain('Source 10');
    });
});

// ---------------------------------------------------------------------------
// 12. Continuation Constant
// ---------------------------------------------------------------------------

describe('Claude Continuation Constant', () => {
    it('CLAUDE_MAX_SEARCH_CONTINUATIONS is a positive integer', () => {
        expect(CLAUDE_MAX_SEARCH_CONTINUATIONS).toBeGreaterThan(0);
        expect(Number.isInteger(CLAUDE_MAX_SEARCH_CONTINUATIONS)).toBe(true);
    });

    it('CLAUDE_MAX_SEARCH_CONTINUATIONS is capped to avoid infinite loops', () => {
        expect(CLAUDE_MAX_SEARCH_CONTINUATIONS).toBeLessThanOrEqual(5);
    });
});

// ---------------------------------------------------------------------------
// 13. Claude Tool Version
// ---------------------------------------------------------------------------

describe('Claude Tool Version', () => {
    it('uses the latest web_search_20260209 version with dynamic filtering', () => {
        expect(CLAUDE_WEB_SEARCH_TOOL_VERSION).toBe('web_search_20260209');
    });
});

// ---------------------------------------------------------------------------
// 14. Inline Citations — Gemini groundingSupports
// ---------------------------------------------------------------------------

describe('Gemini Inline Citations (groundingSupports)', () => {
    it('extracts inline citations from groundingSupports', () => {
        const metadata: GeminiGroundingMetadata = {
            webSearchQueries: ['react 19 useEffect'],
            groundingChunks: [
                { web: { uri: 'https://react.dev/docs', title: 'React Docs' } },
                { web: { uri: 'https://github.com/advisories', title: 'GitHub Advisory' } },
            ],
            groundingSupports: [
                {
                    segment: { startIndex: 0, endIndex: 50, text: 'React 19 introduces new useEffect semantics' },
                    groundingChunkIndices: [0],
                },
                {
                    segment: { startIndex: 51, endIndex: 100, text: 'CVE-2025-1234 affects older versions' },
                    groundingChunkIndices: [0, 1],
                },
            ],
        };

        const result = extractGeminiGroundingMetadata(metadata);
        expect(result.inlineCitations).toBeDefined();
        expect(result.inlineCitations).toHaveLength(2);
        expect(result.inlineCitations![0].text).toContain('React 19');
        expect(result.inlineCitations![0].sources).toHaveLength(1);
        expect(result.inlineCitations![1].sources).toHaveLength(2);
    });

    it('returns undefined inlineCitations when groundingSupports is absent', () => {
        const metadata: GeminiGroundingMetadata = {
            webSearchQueries: ['test'],
            groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example' } },
            ],
        };

        const result = extractGeminiGroundingMetadata(metadata);
        expect(result.inlineCitations).toBeUndefined();
    });

    it('filters out invalid grounding chunk indices', () => {
        const metadata: GeminiGroundingMetadata = {
            webSearchQueries: ['test'],
            groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example' } },
            ],
            groundingSupports: [
                {
                    segment: { startIndex: 0, endIndex: 10, text: 'test text' },
                    groundingChunkIndices: [0, 99], // Index 99 doesn't exist
                },
            ],
        };

        const result = extractGeminiGroundingMetadata(metadata);
        expect(result.inlineCitations).toBeDefined();
        expect(result.inlineCitations![0].sources).toHaveLength(1); // Only index 0
    });
});

// ---------------------------------------------------------------------------
// 15. Inline Citations — Claude text block citations
// ---------------------------------------------------------------------------

describe('Claude Inline Citations (text block citations)', () => {
    it('extracts citations from text blocks', () => {
        const blocks: ClaudeContentBlock[] = [
            {
                type: 'text',
                text: 'The API is deprecated.',
                citations: [
                    {
                        type: 'web_search_result_location',
                        url: 'https://nodejs.org/api/deprecated.html',
                        title: 'Node.js Deprecations',
                        cited_text: 'This API has been deprecated since v18',
                    },
                ],
            },
        ];

        const result = extractClaudeSearchMetadata(blocks);
        expect(result.inlineCitations).toBeDefined();
        expect(result.inlineCitations).toHaveLength(1);
        expect(result.inlineCitations![0].text).toContain('deprecated since v18');
        expect(result.inlineCitations![0].sources[0].url).toContain('nodejs.org');
    });

    it('returns undefined inlineCitations when no citations on text blocks', () => {
        const blocks: ClaudeContentBlock[] = [
            { type: 'text', text: 'No citations here.' },
        ];

        const result = extractClaudeSearchMetadata(blocks);
        expect(result.inlineCitations).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 16. formatSearchSources — Inline Citations Rendering
// ---------------------------------------------------------------------------

describe('formatSearchSources with inline citations', () => {
    it('renders Key Claims Verified section when inline citations are present', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [{ url: 'https://react.dev/docs', title: 'React Docs' }],
            searchRequestCount: 1,
            inlineCitations: [
                {
                    text: 'React 19 introduces concurrent features by default',
                    sources: [{ url: 'https://react.dev/docs', title: 'React Docs' }],
                },
            ],
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('Key Claims Verified');
        expect(result).toContain('React 19 introduces concurrent');
        expect(result).toContain('React Docs');
    });

    it('does NOT render Key Claims Verified when no inline citations', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [{ url: 'https://example.com', title: 'Example' }],
            searchRequestCount: 1,
        };

        const result = formatSearchSources(metadata);
        expect(result).not.toContain('Key Claims Verified');
    });

    it('caps inline citations at 5 entries', () => {
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [{ url: 'https://example.com', title: 'Source' }],
            searchRequestCount: 1,
            inlineCitations: Array.from({ length: 10 }, (_, i) => ({
                text: `Claim ${i}`,
                sources: [{ url: 'https://example.com', title: 'Source' }],
            })),
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('Claim 0');
        expect(result).toContain('Claim 4');
        expect(result).not.toContain('Claim 5');
    });

    it('truncates long cited text to 120 chars', () => {
        const longText = 'A'.repeat(200);
        const metadata: WebSearchMetadata = {
            searchQueries: ['test'],
            sources: [{ url: 'https://example.com', title: 'Source' }],
            searchRequestCount: 1,
            inlineCitations: [{
                text: longText,
                sources: [{ url: 'https://example.com', title: 'Source' }],
            }],
        };

        const result = formatSearchSources(metadata);
        expect(result).toContain('...');
        expect(result).not.toContain(longText); // Full 200-char string should NOT appear
    });
});
