/**
 * Unit tests for the static plugin runner (runStaticPlugins).
 *
 * Verifies that the runner aggregates findings from all plugins
 * and gracefully handles plugin crashes without killing the pipeline.
 */

import { describe, it, expect } from 'vitest';
import { runStaticPlugins, plugins } from '../../src/lib/plugins/index';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runStaticPlugins', () => {
    it('returns empty array for clean files', () => {
        const files = [makeFile('clean.ts', ['const x = 1;'])];
        const findings = runStaticPlugins(files);
        expect(findings).toHaveLength(0);
    });

    it('aggregates findings from multiple plugins', () => {
        // This file triggers suspicious (console.log) AND ts-strict (@ts-ignore)
        const file = makeFile('messy.ts', [
            'console.log("debug");',
            '// @ts-ignore',
        ]);
        const findings = runStaticPlugins([file]);
        // At minimum: console.log from suspicious + @ts-ignore from ts-strict
        expect(findings.length).toBeGreaterThanOrEqual(2);

        const categories = new Set(findings.map(f => f.category));
        expect(categories.has('clean-code')).toBe(true);   // from suspicious
        expect(categories.has('type-safety')).toBe(true);   // from ts-strict
    });

    it('all three plugins are registered', () => {
        const names = plugins.map(p => p.name);
        expect(names).toContain('suspicious-patterns');
        expect(names).toContain('ts-strict');
        expect(names).toContain('secret-scanner');
    });

    it('returns findings with correct structure', () => {
        const file = makeFile('app.ts', ['debugger;']);
        const findings = runStaticPlugins([file]);
        expect(findings).toHaveLength(1);

        const f = findings[0];
        expect(f).toHaveProperty('file');
        expect(f).toHaveProperty('line');
        expect(f).toHaveProperty('severity');
        expect(f).toHaveProperty('title');
        expect(f).toHaveProperty('issue');
        expect(f).toHaveProperty('category');
    });

    it('does not crash on files with no patch', () => {
        const file: GitHubPRFile = {
            filename: 'binary.wasm',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
            raw_url: '',
            blob_url: '',
            contents_url: '',
        };
        const findings = runStaticPlugins([file]);
        expect(findings).toHaveLength(0);
    });
});
