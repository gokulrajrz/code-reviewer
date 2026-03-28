/**
 * Unit tests for the fallback markdown formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatFindingsAsMarkdown } from '../src/lib/review-formatter';
import { clusterFindings } from '../src/lib/finding-clusters';
import type { ReviewFinding } from '../src/types/review';
import type { FormatterOptions } from '../src/lib/review-formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(opts: Partial<ReviewFinding> & { file: string; category: ReviewFinding['category'] }): ReviewFinding {
    return {
        severity: 'medium',
        title: 'Default title',
        issue: 'Default issue',
        ...opts,
    };
}

const defaultOptions: FormatterOptions = {
    prTitle: 'Test PR',
    totalChunks: 2,
    failedChunks: 0,
    droppedFindingsCount: 0,
    failedChunkFiles: [],
    isFallback: false,
};

// ---------------------------------------------------------------------------
// Basic formatting
// ---------------------------------------------------------------------------

describe('formatFindingsAsMarkdown', () => {
    it('produces a complete review for findings', () => {
        const findings: ReviewFinding[] = [
            makeFinding({
                file: 'src/App.tsx',
                category: 'react',
                severity: 'high',
                title: 'Missing error boundary',
                issue: 'Main component lacks error boundary.',
                currentCode: '<App />',
                suggestedCode: '<ErrorBoundary><App /></ErrorBoundary>',
            }),
            makeFinding({
                file: 'src/utils.ts',
                category: 'typescript',
                severity: 'low',
                title: 'Unused variable',
                issue: 'Variable x is never used.',
            }),
        ];

        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('## 🔍 PR Summary');
        expect(md).toContain('## 🐛 Findings');
        expect(md).toContain('## ✅ Summary');
        expect(md).toContain('Missing error boundary');
        expect(md).toContain('Unused variable');
        expect(md).toContain('🔴 Critical | 0');
        expect(md).toContain('🟠 High | 1');
        expect(md).toContain('🟢 Low | 1');
        expect(md).toContain('**Request Changes**');
    });

    it('produces approval message for empty findings', () => {
        const clusters = clusterFindings([]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('No Issues Found');
        expect(md).toContain('**Approve**');
    });

    it('includes fallback banner when isFallback is true', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ];
        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, { ...defaultOptions, isFallback: true });

        expect(md).toContain('Fallback Mode');
        expect(md).toContain('Both AI providers were unavailable');
    });

    it('does NOT include fallback banner when isFallback is false', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ];
        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).not.toContain('Fallback Mode');
    });
});

// ---------------------------------------------------------------------------
// Truncation & coverage metadata
// ---------------------------------------------------------------------------

describe('Metadata reporting', () => {
    it('reports dropped findings count', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, {
            ...defaultOptions,
            droppedFindingsCount: 5,
        });

        expect(md).toContain('5 low-priority findings omitted');
    });

    it('reports failed chunk files', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, {
            ...defaultOptions,
            failedChunkFiles: ['src/broken.ts', 'src/missing.ts'],
        });

        expect(md).toContain('Incomplete Coverage');
        expect(md).toContain('src/broken.ts');
        expect(md).toContain('src/missing.ts');
    });

    it('reports pipeline metadata for multi-chunk reviews', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, {
            ...defaultOptions,
            totalChunks: 5,
            failedChunks: 1,
        });

        expect(md).toContain('5 chunks processed');
        expect(md).toContain('1 failed');
    });
});

// ---------------------------------------------------------------------------
// Verdict derivation
// ---------------------------------------------------------------------------

describe('Verdict in output', () => {
    it('includes Request Changes for critical findings', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'security', severity: 'critical', title: 'SQL injection' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('**Request Changes**');
    });

    it('includes Approve for only low/medium findings', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', severity: 'low', title: 'Minor' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('**Approve**');
    });
});
