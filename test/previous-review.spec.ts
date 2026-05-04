import { describe, it, expect } from 'vitest';
import { formatPreviousReviewContext, type PreviousReviewSummary } from '../src/lib/previous-review';

// ---------------------------------------------------------------------------
// formatPreviousReviewContext — Prompt Formatting
// ---------------------------------------------------------------------------

describe('formatPreviousReviewContext', () => {
    const baseSummary: PreviousReviewSummary = {
        findings: [
            { file: 'src/utils.ts', title: 'Missing error handling', severity: 'high' },
            { file: 'src/api.ts', title: 'Unhandled promise rejection', severity: 'medium' },
            { file: 'src/auth.ts', title: 'Hardcoded secret', severity: 'critical' },
        ],
        reviewCount: 2,
        lastVerdict: 'changes_requested',
    };

    it('returns empty string when no findings', () => {
        const empty: PreviousReviewSummary = { findings: [], reviewCount: 0, lastVerdict: 'unknown' };
        expect(formatPreviousReviewContext(empty)).toBe('');
    });

    it('includes all findings when no chunk files filter', () => {
        const result = formatPreviousReviewContext(baseSummary);
        expect(result).toContain('src/utils.ts: Missing error handling');
        expect(result).toContain('src/api.ts: Unhandled promise rejection');
        expect(result).toContain('src/auth.ts: Hardcoded secret');
        expect(result).toContain('2 prior review(s)');
        expect(result).toContain('Last verdict: changes_requested');
    });

    it('filters to chunk-relevant findings only', () => {
        const result = formatPreviousReviewContext(baseSummary, ['src/utils.ts']);
        expect(result).toContain('src/utils.ts: Missing error handling');
        expect(result).not.toContain('src/api.ts');
        expect(result).not.toContain('src/auth.ts');
    });

    it('returns empty string when chunk files have no matching findings', () => {
        const result = formatPreviousReviewContext(baseSummary, ['src/unrelated.ts']);
        expect(result).toBe('');
    });

    it('includes anti-circular rules', () => {
        const result = formatPreviousReviewContext(baseSummary);
        expect(result).toContain('Do NOT re-raise these if the developer has fixed them');
        expect(result).toContain('DO re-raise ONLY if the fix introduced a NEW regression');
    });

    it('includes force-push disclaimer', () => {
        const result = formatPreviousReviewContext(baseSummary);
        expect(result).toContain('file or line no longer exists');
    });

    it('formats each finding as a bullet point', () => {
        const result = formatPreviousReviewContext(baseSummary);
        const bulletCount = (result.match(/^• /gm) || []).length;
        expect(bulletCount).toBe(3);
    });
});
