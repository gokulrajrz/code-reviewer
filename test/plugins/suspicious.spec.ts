/**
 * Unit tests for the SuspiciousPatternsPlugin.
 *
 * Validates detection of debug artifacts, untracked TODOs,
 * hardcoded passwords, and debugger statements.
 */

import { describe, it, expect } from 'vitest';
import { SuspiciousPatternsPlugin } from '../../src/lib/plugins/suspicious';
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

const plugin = new SuspiciousPatternsPlugin();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SuspiciousPatternsPlugin', () => {
    it('has the correct name', () => {
        expect(plugin.name).toBe('suspicious-patterns');
    });

    // -----------------------------------------------------------------------
    // console.log detection
    // -----------------------------------------------------------------------

    describe('console.log detection', () => {
        it('flags console.log()', () => {
            const file = makeFile('app.ts', ['console.log("debug");']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toBe('Leftover debugging code');
            expect(findings[0].severity).toBe('low');
            expect(findings[0].category).toBe('clean-code');
        });

        it('flags console.debug()', () => {
            const file = makeFile('app.ts', ['console.debug(value);']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('flags console.trace()', () => {
            const file = makeFile('app.ts', ['console.trace();']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('flags console.dir()', () => {
            const file = makeFile('app.ts', ['console.dir(obj);']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
        });

        it('does NOT flag console.error()', () => {
            const file = makeFile('app.ts', ['console.error("legitimate error");']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does NOT flag console.warn()', () => {
            const file = makeFile('app.ts', ['console.warn("legitimate warning");']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // TODO detection
    // -----------------------------------------------------------------------

    describe('TODO detection', () => {
        it('flags untracked TODO without issue link', () => {
            const file = makeFile('app.ts', ['// TODO fix this later']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toBe('Untracked TODO comment');
        });

        it('does NOT flag TODO with a URL', () => {
            const file = makeFile('app.ts', ['// TODO https://github.com/issues/123']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does NOT flag TODO with an issue number reference', () => {
            const file = makeFile('app.ts', ['// TODO(#42) fix this']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // debugger statement detection
    // -----------------------------------------------------------------------

    describe('debugger statement detection', () => {
        it('flags debugger; statement', () => {
            const file = makeFile('handler.ts', ['debugger;']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toBe('Leftover debugger statement');
            expect(findings[0].severity).toBe('medium');
        });

        it('does NOT flag the word debugger in a comment', () => {
            // "debugger" without the semicolon is not matched
            const file = makeFile('handler.ts', ['// use the debugger tool']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Hardcoded password detection
    // -----------------------------------------------------------------------

    describe('hardcoded password detection', () => {
        it('flags password = "literal"', () => {
            const file = makeFile('auth.ts', ['const password = "super_secret_123";']);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toBe('Potential Hardcoded Password');
            expect(findings[0].severity).toBe('high');
        });

        it('flags PASSWORD = \'literal\' (case insensitive)', () => {
            const file = makeFile('auth.ts', ["const PASSWORD = 'admin123';"]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Potential Hardcoded Password')).toBe(true);
        });

        it('does NOT flag password from env', () => {
            const file = makeFile('auth.ts', ['const password = process.env.DB_PASSWORD;']);
            const findings = plugin.run([file]);
            // env ref doesn't have quotes around the value
            expect(findings.filter(f => f.title === 'Potential Hardcoded Password')).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
        it('returns empty findings for removed files', () => {
            const file: GitHubPRFile = {
                filename: 'old.ts',
                status: 'removed',
                additions: 0,
                deletions: 5,
                changes: 5,
                patch: '@@ -1,1 +0,0 @@\n-console.log("removed");',
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('returns empty findings for files without patches', () => {
            const file: GitHubPRFile = {
                filename: 'binary.png',
                status: 'added',
                additions: 0,
                deletions: 0,
                changes: 0,
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('can detect multiple violations in one file', () => {
            const file = makeFile('messy.ts', [
                'console.log("test");',
                'debugger;',
                '// TODO fix eventually',
            ]);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(3);
        });
    });
});
