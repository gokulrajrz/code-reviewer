/**
 * Unit tests for the SecretsScannerPlugin.
 *
 * Validates that every secret pattern fires on real-world examples
 * and does NOT fire on safe content (false positive guards).
 */

import { describe, it, expect } from 'vitest';
import { SecretsScannerPlugin } from '../../src/lib/plugins/secrets';
import type { GitHubPRFile } from '../../src/types/github';

// ---------------------------------------------------------------------------
// Helper: create a minimal GitHubPRFile with a unified diff patch
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

const plugin = new SecretsScannerPlugin();

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

describe('SecretsScannerPlugin', () => {
    it('has the correct name', () => {
        expect(plugin.name).toBe('secret-scanner');
    });

    // -----------------------------------------------------------------------
    // True Positives — each pattern MUST fire
    // -----------------------------------------------------------------------

    describe('true positives', () => {
        it('detects hardcoded generic API keys', () => {
            const file = makeFile('config.ts', [
                'const apiKey = "sk_live_abcdefghijk1234567890";',
            ]);
            const findings = plugin.run([file]);
            expect(findings.length).toBeGreaterThanOrEqual(1);
            expect(findings[0].severity).toBe('critical');
            expect(findings[0].category).toBe('security');
            expect(findings[0].file).toBe('config.ts');
            expect(findings[0].line).toBe(1);
        });

        it('detects GitHub personal access tokens (ghp_)', () => {
            const token = 'ghp_' + 'A'.repeat(36);
            const file = makeFile('auth.ts', [`const token = "${token}";`]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'GitHub Token Detected')).toBe(true);
        });

        it('detects GitHub OAuth tokens (gho_)', () => {
            const token = 'gho_' + 'B'.repeat(36);
            const file = makeFile('auth.ts', [`const t = "${token}";`]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'GitHub Token Detected')).toBe(true);
        });

        it('detects hardcoded JWTs', () => {
            // Real JWT structure: header.payload.signature (all base64url)
            const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
            const file = makeFile('middleware.ts', [`const token = "${jwt}";`]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Hardcoded JWT Detected')).toBe(true);
        });

        it('detects Google API keys', () => {
            const key = 'AIza' + 'X'.repeat(35);
            const file = makeFile('google.ts', [`const key = "${key}";`]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Google API Key Detected')).toBe(true);
        });

        it('detects OpenAI API keys', () => {
            const key = 'sk-' + 'a'.repeat(48);
            const file = makeFile('llm.ts', [`const OPENAI_KEY = "${key}";`]);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'OpenAI API Key Detected')).toBe(true);
        });

        it('detects RSA private keys', () => {
            const file = makeFile('cert.pem', ['-----BEGIN RSA PRIVATE KEY-----']);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Private Key Detected')).toBe(true);
        });

        it('detects generic private keys', () => {
            const file = makeFile('key.pem', ['-----BEGIN PRIVATE KEY-----']);
            const findings = plugin.run([file]);
            expect(findings.some(f => f.title === 'Private Key Detected')).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // False Positive Guards — these MUST NOT fire
    // -----------------------------------------------------------------------

    describe('false positives', () => {
        it('does not flag normal variable assignments', () => {
            const file = makeFile('utils.ts', [
                'const greeting = "hello world";',
                'const count = 42;',
            ]);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does not flag environment variable references', () => {
            const file = makeFile('config.ts', [
                'const apiKey = process.env.API_KEY;',
                'const secret = env.GITHUB_WEBHOOK_SECRET;',
            ]);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does not scan deleted files', () => {
            const file: GitHubPRFile = {
                filename: 'old-secrets.ts',
                status: 'removed',
                additions: 0,
                deletions: 5,
                changes: 5,
                patch: '@@ -1,1 +0,0 @@\n-const key = "ghp_' + 'A'.repeat(36) + '";',
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });

        it('does not scan deleted lines (prefixed with -)', () => {
            const patch = '@@ -1,2 +1,1 @@\n-const old = "ghp_' + 'A'.repeat(36) + '";\n+const safe = process.env.TOKEN;';
            const file: GitHubPRFile = {
                filename: 'auth.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                changes: 2,
                patch,
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(0);
        });
    });

    // -----------------------------------------------------------------------
    // Line number accuracy
    // -----------------------------------------------------------------------

    describe('line number tracking', () => {
        it('reports correct line numbers from hunk headers', () => {
            const file = makeFile('config.ts', [
                'const safe = true;',
                'const key = "ghp_' + 'A'.repeat(36) + '";',
            ], 10);
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].line).toBe(11); // starts at 10, line 1 is safe, line 2 is the secret
        });

        it('handles multiple hunk headers correctly', () => {
            const patch = [
                '@@ -0,0 +5,1 @@',
                '+const safe = "hello";',
                '@@ -0,0 +20,1 @@',
                '+const key = "ghp_' + 'A'.repeat(36) + '";',
            ].join('\n');
            const file: GitHubPRFile = {
                filename: 'multi.ts',
                status: 'modified',
                additions: 2,
                deletions: 0,
                changes: 2,
                patch,
                raw_url: '',
                blob_url: '',
                contents_url: '',
            };
            const findings = plugin.run([file]);
            expect(findings).toHaveLength(1);
            expect(findings[0].line).toBe(20);
        });
    });

    // -----------------------------------------------------------------------
    // Multi-file scanning
    // -----------------------------------------------------------------------

    describe('multi-file scanning', () => {
        it('aggregates findings across multiple files', () => {
            const files = [
                makeFile('a.ts', ['const key = "ghp_' + 'A'.repeat(36) + '";']),
                makeFile('b.ts', ['-----BEGIN PRIVATE KEY-----']),
                makeFile('c.ts', ['const safe = true;']),
            ];
            const findings = plugin.run(files);
            expect(findings).toHaveLength(2);
            expect(findings.map(f => f.file)).toContain('a.ts');
            expect(findings.map(f => f.file)).toContain('b.ts');
        });

        it('returns empty findings for clean files', () => {
            const files = [
                makeFile('clean1.ts', ['const x = 1;']),
                makeFile('clean2.ts', ['export default {};']),
            ];
            const findings = plugin.run(files);
            expect(findings).toHaveLength(0);
        });
    });
});
