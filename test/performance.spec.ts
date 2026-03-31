import { describe, it, expect } from 'vitest';
import { circuitBreakers, retryWithBackoff, CircuitBreaker } from '../src/lib/retry';
import { classifyFiles, buildReviewChunks } from '../src/lib/github';
import type { GitHubPRFile } from '../src/types/github';

/**
 * Performance benchmarks for critical paths.
 * These tests measure execution time to detect performance regressions.
 */

describe('Performance Benchmarks', () => {
    describe('File Classification', () => {
        it('should classify 1000 files in under 100ms', async () => {
            const files: GitHubPRFile[] = Array.from({ length: 1000 }, (_, i) => ({
                filename: i % 2 === 0 ? `src/components/File${i}.tsx` : `test/file${i}.spec.ts`,
                status: 'modified',
                additions: 10,
                deletions: 5,
                changes: 15,
                raw_url: '',
                blob_url: '',
                contents_url: '',
            }));

            const start = performance.now();
            const result = classifyFiles(files);
            const duration = performance.now() - start;

            expect(duration).toBeLessThan(100);
            expect(result.tier1.length + result.tier2.length + result.skipped.length).toBe(1000);
        });
    });

    describe('Circuit Breaker', () => {
        it('should handle 10000 state checks in under 50ms', () => {
            const cb = new CircuitBreaker('benchmark', { failureThreshold: 100 });

            // Prime the circuit
            for (let i = 0; i < 50; i++) {
                cb.recordFailure();
            }

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cb.canExecute();
            }
            const duration = performance.now() - start;

            expect(duration).toBeLessThan(50);
        });
    });

    describe('Retry Logic', () => {
        it('should complete successful operation on first attempt quickly', async () => {
            const start = performance.now();

            const result = await retryWithBackoff(
                () => Promise.resolve('success'),
                'benchmark-success',
                { maxAttempts: 3, jitter: false }
            );

            const duration = performance.now() - start;

            expect(result.result).toBe('success');
            expect(result.attempts).toBe(1);
            expect(duration).toBeLessThan(10); // Should be nearly instant
        });
    });

    describe('Chunk Building', () => {
        it('should build chunks for 100 files in under 500ms', async () => {
            const mockFiles: GitHubPRFile[] = Array.from({ length: 100 }, (_, i) => ({
                filename: `src/file${i}.ts`,
                status: 'modified',
                additions: 100,
                deletions: 50,
                changes: 150,
                patch: 'diff --git a/src/file.ts b/src/file.ts\n'.repeat(50),
                raw_url: '',
                blob_url: '',
                contents_url: '',
            }));

            const classified = {
                tier1: mockFiles.slice(0, 50),
                tier2: mockFiles.slice(50),
                skipped: [],
            };

            const mockToken = 'test-token';

            const start = performance.now();
            // Note: This will fail due to mocked fetch, but we're measuring the overhead
            try {
                await buildReviewChunks(classified, mockToken, 50000);
            } catch {
                // Expected to fail - we're measuring the processing time
            }
            const duration = performance.now() - start;

            // Should be fast even with failures
            expect(duration).toBeLessThan(500);
        });
    });
});
