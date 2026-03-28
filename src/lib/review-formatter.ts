/**
 * Fallback Markdown Formatter.
 *
 * Converts FindingCluster[] into a PR-ready markdown review when
 * the synthesizer LLM is unavailable (both providers failed).
 * Zero LLM calls — pure string formatting.
 *
 * Output format: severity-grouped (🔴 Critical → 🟠 High → 🟡 Medium → 🟢 Low)
 * with dependency/similarity annotations from cluster metadata.
 *
 * Produces a `⚠️ Fallback Mode` banner so reviewers know the
 * LLM synthesis is missing.
 */

import type { ReviewFinding, FindingSeverity } from '../types/review';
import type { FindingCluster } from './finding-clusters';
import { countBySeverity, deriveVerdict, verdictToConclusion } from './verdict';
import { flattenClusters } from './finding-clusters';

// ---------------------------------------------------------------------------
// Severity Configuration
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

const SEVERITY_SECTION: Record<FindingSeverity, { emoji: string; label: string }> = {
    critical: { emoji: '🔴', label: 'Critical Issues' },
    high: { emoji: '🟠', label: 'High Issues' },
    medium: { emoji: '🟡', label: 'Medium Issues' },
    low: { emoji: '🟢', label: 'Low Issues' },
};

const SEVERITY_EMOJI_INLINE: Record<FindingSeverity, string> = {
    critical: '🔴 CRITICAL',
    high: '🟠 HIGH',
    medium: '🟡 MEDIUM',
    low: '🟢 LOW',
};

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export interface FormatterOptions {
    /** PR title for the summary section. */
    prTitle: string;
    /** Total chunks that were processed. */
    totalChunks: number;
    /** Chunks that failed during Map phase. */
    failedChunks: number;
    /** Number of findings dropped due to payload truncation. */
    droppedFindingsCount: number;
    /** Files that were in failed chunks (no coverage). */
    failedChunkFiles: string[];
    /** Was the fallback triggered because BOTH LLMs failed? */
    isFallback: boolean;
}


/**
 * Build a lookup of similar-pattern annotations.
 * Key: `file::title`, Value: annotation string.
 */
function buildSimilarPatternAnnotations(
    clusters: ReadonlyArray<FindingCluster>
): Map<string, string> {
    const annotations = new Map<string, string>();

    for (const cluster of clusters) {
        if (cluster.groupReason !== 'similar-pattern' || cluster.findings.length <= 1) continue;

        const fileCount = new Set(cluster.findings.map(f => f.file)).size;
        if (fileCount <= 1) continue;

        const note = `\n> 🔄 This pattern appears across ${fileCount} files — consider a systematic fix.`;
        // Only annotate the first finding in the cluster
        const first = cluster.findings[0];
        const key = `${first.file}::${first.title}`;
        annotations.set(key, note);
    }

    return annotations;
}

/**
 * Format clustered findings into a complete severity-grouped markdown review.
 *
 * Output groups findings under 4 severity sections:
 * 🔴 Critical → 🟠 High → 🟡 Medium → 🟢 Low
 *
 * Cluster metadata (dependencies, similar patterns) is surfaced
 * as inline annotations within the severity sections.
 */
export function formatFindingsAsMarkdown(
    clusters: ReadonlyArray<FindingCluster>,
    options: FormatterOptions
): string {
    const allFindings = flattenClusters(clusters);
    const counts = countBySeverity(allFindings);
    const verdict = deriveVerdict(allFindings, options.failedChunks === options.totalChunks && options.totalChunks > 0);

    const sections: string[] = [];

    // ── Fallback Banner ──
    if (options.isFallback) {
        sections.push(
            '> ⚠️ **Fallback Mode** — Both AI providers were unavailable. ' +
            'This review was generated from structured findings without LLM synthesis. ' +
            'Cross-file analysis and prose commentary are not included.\n'
        );
    }

    // ── Pipeline Metadata ──
    if (options.totalChunks > 1 || options.failedChunks > 0 || options.droppedFindingsCount > 0) {
        const parts = [`${options.totalChunks} chunks processed`];
        if (options.failedChunks > 0) {
            parts.push(`${options.failedChunks} failed`);
        }
        if (options.droppedFindingsCount > 0) {
            parts.push(`${options.droppedFindingsCount} low-priority findings omitted`);
        }
        sections.push(`> ℹ️ **Review Pipeline:** ${parts.join(', ')}\n`);
    }

    // ── PR Summary ──
    sections.push(`## 🔍 PR Summary\n`);
    sections.push(
        `> Review of **"${options.prTitle}"** — ` +
        `${allFindings.length} finding${allFindings.length !== 1 ? 's' : ''} detected.\n`
    );

    // ── Failed Chunk Coverage ──
    if (options.failedChunkFiles.length > 0) {
        sections.push(`---\n`);
        sections.push(`## ⚠️ Incomplete Coverage\n`);
        sections.push(
            `The following files were in chunks that failed to process:\n` +
            options.failedChunkFiles.map(f => `- \`${f}\``).join('\n') + '\n'
        );
    }

    sections.push(`---\n`);

    // ── Findings by Severity ──
    if (allFindings.length === 0) {
        sections.push(`## ✅ No Issues Found\n`);
        sections.push(`This PR passed automated inspection with no actionable findings.\n`);
    } else {
        sections.push(`## 🐛 Findings\n`);

        // Build annotation lookups from cluster metadata
        const similarAnnotations = buildSimilarPatternAnnotations(clusters);

        // Group findings by severity
        const bySeverity = new Map<FindingSeverity, ReviewFinding[]>();
        for (const sev of SEVERITY_ORDER) {
            bySeverity.set(sev, []);
        }
        for (const finding of allFindings) {
            bySeverity.get(finding.severity)!.push(finding);
        }

        // Render each severity section
        for (const severity of SEVERITY_ORDER) {
            const findings = bySeverity.get(severity)!;
            if (findings.length === 0) continue;

            const { emoji, label } = SEVERITY_SECTION[severity];
            sections.push(`### ${emoji} ${label}\n`);

            // Sort by file for consistent ordering within severity
            findings.sort((a, b) => a.file.localeCompare(b.file));

            for (const finding of findings) {
                sections.push(
                    `#### File: \`${finding.file}\`${finding.line ? `:${finding.line}` : ''} — ${finding.title}\n`
                );
                sections.push(`**Issue:** ${finding.issue}\n`);

                // Inject similar-pattern annotations
                const findingKey = `${finding.file}::${finding.title}`;
                const simNote = similarAnnotations.get(findingKey);
                if (simNote) {
                    sections.push(`${simNote}\n`);
                }

                if (finding.currentCode) {
                    sections.push(`**Current:**\n\`\`\`\n${finding.currentCode}\n\`\`\`\n`);
                }
                if (finding.suggestedCode) {
                    sections.push(`**Suggested:**\n\`\`\`\n${finding.suggestedCode}\n\`\`\`\n`);
                }
            }

            sections.push(`---\n`);
        }
    }

    // ── Summary Table ──
    sections.push(`## ✅ Summary\n`);
    sections.push(
        `| Category | Count |\n` +
        `|---|---|\n` +
        `| 🔴 Critical | ${counts.critical} |\n` +
        `| 🟠 High | ${counts.high} |\n` +
        `| 🟡 Medium | ${counts.medium} |\n` +
        `| 🟢 Low | ${counts.low} |\n`
    );

    // ── Verdict ──
    const verdictLabel = verdict === 'approve'
        ? '**Approve**'
        : verdict === 'request_changes'
            ? '**Request Changes**'
            : '**Needs Discussion**';

    sections.push(`\nOverall verdict: ${verdictLabel}\n`);

    return sections.join('\n');
}
