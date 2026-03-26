import type { Env, ReviewMessage } from '../types/env';
import type { ReviewFinding, SynthesizerInput } from '../types/review';
import { MAX_CHUNK_CHARS, MAX_LLM_CHUNKS, MAX_SYNTHESIZER_INPUT_CHARS } from '../config/constants';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    postPRComment,
    updateCheckRun,
} from '../lib/github';
import { getInstallationToken } from '../lib/github-auth';
import { callChunkReview, callSynthesizer } from '../lib/llm/index';

/** Maximum time (ms) to wait for a single LLM call before aborting. */
const LLM_TIMEOUT_MS = 120_000;

/**
 * Wraps an async function with a timeout guard.
 * If it doesn't resolve within `timeoutMs`, the promise rejects.
 */
async function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const result = await Promise.race([
            fn(controller.signal),
            new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () =>
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
                );
            }),
        ]);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Builds the JSON payload string for the synthesizer (Reduce phase).
 * Includes PR metadata and all findings from the Map phase.
 */
function buildSynthesizerPayload(
    prTitle: string,
    allFiles: string[],
    skippedCount: number,
    allFindings: ReviewFinding[],
    totalChunks: number,
    failedChunks: number
): string {
    const input: SynthesizerInput = {
        prTitle,
        allFiles,
        skippedCount,
        findings: allFindings,
        totalChunks,
        failedChunks,
    };

    let payload = JSON.stringify(input, null, 2);

    // Guard against massive payloads that would blow the LLM context window
    if (payload.length > MAX_SYNTHESIZER_INPUT_CHARS) {
        console.warn(`[queue] Synthesizer payload too large (${payload.length} chars), truncating findings`);

        // Sort findings: critical > high > medium > low, then truncate
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const sorted = [...allFindings].sort(
            (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
        );

        // Binary search for how many findings fit
        let lo = 1, hi = sorted.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const test: SynthesizerInput = { ...input, findings: sorted.slice(0, mid) };
            if (JSON.stringify(test).length <= MAX_SYNTHESIZER_INPUT_CHARS) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        const truncated: SynthesizerInput = {
            ...input,
            findings: sorted.slice(0, lo),
        };
        payload = JSON.stringify(truncated, null, 2);
        console.log(`[queue] Truncated to ${lo}/${allFindings.length} findings (prioritized by severity)`);
    }

    return payload;
}

/**
 * Generates a fallback markdown review from raw findings when the synthesizer fails.
 * This ensures we always post something useful, even if the Reduce phase crashes.
 */
function buildFallbackReview(
    findings: ReviewFinding[],
    totalChunks: number,
    failedChunks: number
): string {
    const severityEmoji: Record<string, string> = {
        critical: '🔴 CRITICAL',
        high: '🟠 HIGH',
        medium: '🟡 MEDIUM',
        low: '🟢 LOW',
    };

    let md = `> ⚠️ **Notice:** The AI synthesizer was unable to produce a cohesive review. `;
    md += `Below are the raw findings from ${totalChunks} review chunks`;
    if (failedChunks > 0) md += ` (${failedChunks} chunks failed)`;
    md += `.\n\n---\n\n`;

    if (findings.length === 0) {
        md += `## ✅ No Issues Found\n\nThe automated inspectors found no actionable issues in this PR.\n\n`;
        md += `Overall verdict: **Approve**\n`;
        return md;
    }

    // Group by file
    const byFile = new Map<string, ReviewFinding[]>();
    for (const f of findings) {
        const existing = byFile.get(f.file) ?? [];
        existing.push(f);
        byFile.set(f.file, existing);
    }

    md += `## 🐛 Findings\n\n`;
    for (const [file, fileFindings] of byFile) {
        for (const f of fileFindings) {
            md += `### [${severityEmoji[f.severity] ?? f.severity}] File: \`${file}\` — ${f.title}\n\n`;
            md += `**Issue:** ${f.issue}\n\n`;
            if (f.currentCode) {
                md += `**Current:**\n\`\`\`tsx\n${f.currentCode}\n\`\`\`\n\n`;
            }
            if (f.suggestedCode) {
                md += `**Suggested:**\n\`\`\`tsx\n${f.suggestedCode}\n\`\`\`\n\n`;
            }
            md += `---\n\n`;
        }
    }

    // Summary table
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
        if (f.severity in counts) counts[f.severity as keyof typeof counts]++;
    }

    md += `## ✅ Summary\n`;
    md += `| Category | Count |\n|---|---|\n`;
    md += `| 🔴 Critical | ${counts.critical} |\n`;
    md += `| 🟠 High | ${counts.high} |\n`;
    md += `| 🟡 Medium | ${counts.medium} |\n`;
    md += `| 🟢 Low | ${counts.low} |\n\n`;

    const verdict = (counts.critical > 0 || counts.high > 0) ? '**Request Changes**' : '**Approve**';
    md += `Overall verdict: ${verdict}\n`;

    return md;
}

/**
 * Background Queue Consumer Handler.
 * Implements a Map-Reduce pipeline:
 *   Step 1-4: Fetch files, classify, build chunks (unchanged)
 *   Step 5: MAP — Each chunk → LLM → structured JSON findings
 *   Step 6: Flatten & deduplicate findings
 *   Step 7: REDUCE — All findings → LLM → final cohesive markdown
 *   Step 8: Post to GitHub & update Check Run
 */
export async function queueHandler(
    batch: MessageBatch<ReviewMessage>,
    env: Env,
    _ctx: ExecutionContext
): Promise<void> {
    for (const message of batch.messages) {
        const { prNumber, title, diffUrl, repoFullName, headSha, checkRunId } = message.body;

        console.log(
            `[queue] Processing PR #${prNumber}: "${title}" (${repoFullName}) at commit ${headSha}`
        );

        // ── Step 1: Get a fresh installation token ──
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Auth failed — cannot get installation token: ${errMsg}`);
            message.ack();
            return;
        }

        try {
            // ── Step 2: Fetch ALL changed files (paginated) ──
            console.log(`[queue] Fetching changed files for PR #${prNumber}...`);
            const allFiles = await fetchChangedFiles(repoFullName, prNumber, token);
            console.log(`[queue] ✓ Fetched ${allFiles.length} changed files (after pagination)`);

            if (allFiles.length === 0) {
                console.log(`[queue] ⚠️ No changed files found for PR #${prNumber}, skipping review`);
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        '## No Files to Review\n\nThis PR has no reviewable file changes.');
                }
                message.ack();
                return;
            }

            // ── Step 3: Classify files into tiers ──
            const classified = classifyFiles(allFiles);
            console.log(
                `[queue] ✓ Classified: ${classified.tier1.length} tier1 (full), ` +
                `${classified.tier2.length} tier2 (diff-only), ` +
                `${classified.skipped.length} skipped (noise)`
            );

            if (classified.tier1.length === 0 && classified.tier2.length === 0) {
                console.log(`[queue] ⚠️ All ${allFiles.length} files were classified as noise, skipping review`);
                if (checkRunId) {
                    await updateCheckRun(repoFullName, checkRunId, token, 'neutral',
                        `## No Reviewable Files\n\nAll ${allFiles.length} files in this PR are auto-generated, vendor, or noise files.\n\n` +
                        `Skipped: ${classified.skipped.slice(0, 20).join(', ')}${classified.skipped.length > 20 ? '...' : ''}`);
                }
                message.ack();
                return;
            }

            // ── Step 4: Build size-limited chunks with global context ──
            console.log(`[queue] Building review chunks (max ${MAX_CHUNK_CHARS} chars each)...`);
            const { chunks: rawChunks, globalContext, allFiles: reviewableFiles } =
                await buildReviewChunks(classified, token, MAX_CHUNK_CHARS);

            let chunks = rawChunks;
            console.log(`[queue] ✓ Generated ${chunks.length} chunk(s) for review (global context: ${globalContext.length} chars)`);

            // Apply Hard Cap to prevent 50-subrequest limit exhaustion
            // Budget: chunks × 1 (Map) + 1 (Reduce) + file fetches + auth ≤ 50
            if (chunks.length > MAX_LLM_CHUNKS) {
                console.log(`[queue] ⚠️ Truncating chunks from ${chunks.length} to ${MAX_LLM_CHUNKS} to prevent subrequest limit`);
                chunks = chunks.slice(0, MAX_LLM_CHUNKS);
            }

            // ══════════════════════════════════════════════════════════════
            // Step 5: MAP PHASE — Review each chunk, collect JSON findings
            // ══════════════════════════════════════════════════════════════
            console.log(`[queue] ═══ MAP PHASE: Processing ${chunks.length} chunks ═══`);

            const allFindings: ReviewFinding[] = [];
            let failedChunks = 0;

            for (let i = 0; i < chunks.length; i++) {
                const chunkContent = chunks[i];
                const chunkLabel = `${i + 1}/${chunks.length}`;

                console.log(`[queue] [MAP] Chunk ${chunkLabel} (${chunkContent.length} chars) → LLM...`);

                try {
                    const findings = await withTimeout(
                        (signal) => callChunkReview(chunkContent, title, chunkLabel, env, signal),
                        LLM_TIMEOUT_MS,
                        `Chunk ${chunkLabel}`
                    );

                    console.log(`[queue] [MAP] ✓ Chunk ${chunkLabel}: ${findings.length} findings`);
                    allFindings.push(...findings);
                } catch (error) {
                    failedChunks++;
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] [MAP] ⚠️ Chunk ${chunkLabel} failed: ${errMsg}`);
                    // Continue processing remaining chunks — graceful degradation
                }
            }

            console.log(
                `[queue] ═══ MAP COMPLETE: ${allFindings.length} total findings, ` +
                `${failedChunks}/${chunks.length} chunks failed ═══`
            );

            // ══════════════════════════════════════════════════════════════
            // Step 6: Deduplicate findings (simple: same file + same title)
            // ══════════════════════════════════════════════════════════════
            const seen = new Set<string>();
            const deduplicated: ReviewFinding[] = [];
            for (const f of allFindings) {
                const key = `${f.file}::${f.title.toLowerCase().trim()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    deduplicated.push(f);
                }
            }

            if (deduplicated.length < allFindings.length) {
                console.log(`[queue] Deduplicated: ${allFindings.length} → ${deduplicated.length} findings`);
            }

            // ══════════════════════════════════════════════════════════════
            // Step 7: REDUCE PHASE — Synthesize final review
            // ══════════════════════════════════════════════════════════════
            console.log(`[queue] ═══ REDUCE PHASE: Synthesizing ${deduplicated.length} findings ═══`);

            let finalReview: string;

            const synthesizerPayload = buildSynthesizerPayload(
                title,
                reviewableFiles,
                classified.skipped.length,
                deduplicated,
                chunks.length,
                failedChunks
            );

            try {
                finalReview = await withTimeout(
                    (signal) => callSynthesizer(synthesizerPayload, env, signal),
                    LLM_TIMEOUT_MS,
                    'Synthesizer'
                );
                console.log(`[queue] [REDUCE] ✓ Synthesized review: ${finalReview.length} chars`);
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[queue] [REDUCE] ⚠️ Synthesizer failed: ${errMsg}`);
                console.log(`[queue] [REDUCE] Falling back to raw findings markdown...`);

                // Graceful fallback: build a basic markdown directly from findings
                finalReview = buildFallbackReview(deduplicated, chunks.length, failedChunks);
            }

            // Add metadata banner for multi-chunk reviews
            if (chunks.length > 1 || failedChunks > 0) {
                const banner = `> ℹ️ **Review Pipeline:** ${chunks.length} chunks processed` +
                    `${failedChunks > 0 ? ` (${failedChunks} failed)` : ''}, ` +
                    `${deduplicated.length} findings synthesized from ` +
                    `${classified.tier1.length} full-context + ${classified.tier2.length} diff-only files.\n\n`;
                finalReview = banner + finalReview;
            }

            console.log(`[queue] ✓ Final review: ${finalReview.length} chars, posting to PR...`);

            // ── Step 8: Post review comment to PR ──
            try {
                await postPRComment(repoFullName, prNumber, finalReview, token);
                console.log(`[queue] ✓ Review comment posted to PR #${prNumber}`);
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[queue] ⚠️ Failed to post review comment: ${errMsg}`);
            }

            // ── Step 9: Determine conclusion and update Check Run ──
            const allChunksFailed = failedChunks === chunks.length && chunks.length > 0;
            const hasRequestedChanges = finalReview.includes('**Request Changes**');
            const conclusion = allChunksFailed ? 'failure' : hasRequestedChanges ? 'failure' : 'success';

            if (checkRunId) {
                try {
                    await updateCheckRun(repoFullName, checkRunId, token, conclusion, finalReview);
                    console.log(`[queue] ✓ Check run #${checkRunId} updated → ${conclusion}`);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[queue] ⚠️ Failed to update Check Run #${checkRunId}: ${errMsg}`);
                }
            } else {
                console.log(`[queue] ⚠️ No checkRunId available, skipping Check Run update`);
            }

            console.log(`[queue] ✅ Pipeline complete for PR #${prNumber} (conclusion: ${conclusion})`);
            message.ack();

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[queue] ❌ Pipeline failed for PR #${prNumber}: ${errMsg}`);

            try {
                await postPRComment(
                    repoFullName,
                    prNumber,
                    `> ⚠️ **Code Reviewer Agent Error**\n` +
                    `> The automated review failed unexpectedly.\n\n` +
                    `**Error:** \`${errMsg}\`\n\n` +
                    `> You can trigger another review by closing and reopening this PR.`,
                    token
                );
            } catch {
                console.error('[queue] ⚠️ Could not post error comment to PR');
            }

            if (checkRunId) {
                try {
                    await updateCheckRun(
                        repoFullName,
                        checkRunId,
                        token,
                        'failure',
                        `## ❌ Review Pipeline Error\n\n**Error:** \`${errMsg}\`\n\n` +
                        `You can trigger another review by closing and reopening this PR.`
                    );
                } catch {
                    console.error('[queue] ⚠️ Could not update Check Run with error status');
                }
            }

            message.ack();
        }
    }
}
