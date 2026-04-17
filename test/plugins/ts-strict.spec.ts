/**
 * Unit tests for the TsStrictPlugin.
 *
 * Validates detection of @ts-ignore, explicit `any`, and `as any` patterns.
 * Also verifies that the plugin only scans .ts/.tsx files.
 */

import { describe, it, expect } from 'vitest';
import { TsStrictPlugin } from '../../src/lib/plugins/ts-strict';
import type { GitHubPRFile } from '../../src/types/github';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeFile(filename: string, addedLines: string[], startLine = 1): GitHubPRFile {
    const hunkHeader = `@@ -0,0 +${startLine},${addedLines.length} @@`;
    const patch = [hunkHeader, ...addedLines.map(l => `+${l}`)].join('\n');
    return {
        filename,
        status: 'added',
        additions: addedLines.length,
        deletions: 0,
        changes: addedLines.length,
        patch,
        raw_url: '',
        blob_url: '',
        contents_url: '',
    };
}

const plugin = new TsStrictPlugin();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TsStrictPlugin', () => {
    it('has the correct name', () => {
        expect(plugin.name).toBe('ts-strict');
    });

    // -----------------------------------------------------------------------
    // File type filtering
    // -----------------------------------------------------------------------

    describe('file type filtering', () => {
        it('scans .ts files', () => {
            const file = makeFile('utils.ts', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('scans .tsx files', () => {
            const file = makeFile('Component.tsx', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('does NOT scan .js files', () => {
            const file = makeFile('utils.js', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does NOT scan .json files', () => {
            const file = makeFile('config.json', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does NOT scan .css files', () => {
            const file = makeFile('styles.css', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // @ts-ignore detection
    // -----------------------------------------------------------------------

    describe('@ts-ignore detection', () => {
        it('flags @ts-ignore', () => {
            const file = makeFile('api.ts', ['// @ts-ignore']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toBe('Banned `@ts-ignore` directive');
            expect(findings[0].severity).toBe('high');
            expect(findings[0].category).toBe('type-safety');
        });

        it('flags @ts-ignore with a comment after it', () => {
            const file = makeFile('api.ts', ['// @ts-ignore -- broken types']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('does NOT flag @ts-expect-error', () => {
            const file = makeFile('api.ts', ['// @ts-expect-error intentional for test']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Explicit `any` type detection
    // -----------------------------------------------------------------------

    describe('explicit any detection', () => {
        it('flags `: any` type annotation', () => {
            const file = makeFile('handler.ts', ['function process(data: any) {']);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Use of `any` type')).toBe(true);
            expect(findings[0].severity).toBe('medium');
        });

        it('flags `: any[]` annotation', () => {
            const file = makeFile('handler.ts', ['const items: any[] = [];']);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Use of `any` type')).toBe(true);
        });

        it('does NOT flag the word "any" in a variable name', () => {
            const file = makeFile('handler.ts', ['const anything = "hello";']);
            const findings = plugin.run([file]);
            // "anything" does NOT match ": any\\b" because there's no colon
            expect(findings.filter(f => f.title === 'Use of `any` type')).toHaveLength(0);
        });

        it('does NOT flag `: unknown`', () => {
            const file = makeFile('handler.ts', ['function process(data: unknown) {']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // `as any` type assertion detection
    // -----------------------------------------------------------------------

    describe('as any detection', () => {
        it('flags `as any` type assertion', () => {
            const file = makeFile('cast.ts', ['const val = something as any;']);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Type assertion to `any`')).toBe(true);
            expect(findings[0].severity).toBe('medium');
        });

        it('does NOT flag `as unknown`', () => {
            const file = makeFile('cast.ts', ['const val = something as unknown;']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
        it('returns empty for removed .ts files', () => {
            const file: GitHubPRFile = {
                filename: 'old.ts',
                status: 'removed',
                additions: 0,
                deletions: 5,
                changes: 5,
                patch: '@@ -1,1 +0,0 @@\n-// @ts-ignore',
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('detects multiple violations in one file', () => {
            const file = makeFile('messy.ts', [
                '// @ts-ignore',
                'const data: any = {};',
                'const val = data as any;',
            ]);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(3);
        });

        it('reports correct line numbers', () => {
            const file = makeFile('code.ts', [
                'const safe = "hello";',
                '// @ts-ignore',
                'const x: any = 1;',
            ], 10);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(2);
            expect(findings[0].line).toBe(11); // @ts-ignore at line 11
            expect(findings[1].line).toBe(12); // any at line 12
        });
    });
});
