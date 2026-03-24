/**
 * Markdown Formatter
 *
 * Transforms the aggregated ReviewFinding[] into a polished
 * markdown comment for posting on the GitHub PR.
 */

import type { ReviewFinding } from '../types/review';

// ---------------------------------------------------------------------------
// Severity Emoji Mapping
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI: Record<string, string> = {
    Critical: '🔴',
    High: '🟠',
    Medium: '🟡',
    Low: '🟢',
};

const CATEGORY_EMOJI: Record<string, string> = {
    Security: '🛡️',
    Performance: '⚡',
    Maintainability: '🏗',
    Style: '🧹',
    HumanReviewNeeded: '🧑‍💻',
};

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Renders the aggregated findings into a polished PR comment in markdown.
 */
export function renderMarkdownReview(params: {
    prTitle: string;
    findings: ReviewFinding[];
    verdict: 'Approve' | 'RequestChanges' | 'NeedsDiscussion';
    agentSummaries: {
        security: string;
        performance: string;
        cleanCode: string;
    };
    tokenUsage: {
        totalInput: number;
        totalOutput: number;
        latencyMs: number;
    };
}): string {
    const { prTitle, findings, verdict, agentSummaries, tokenUsage } = params;

    const lines: string[] = [];

    // Header
    lines.push(`# 🤖 AI Code Review — Multi-Agent Pipeline`);
    lines.push('');
    lines.push(`> **PR:** ${prTitle}`);
    lines.push(`> **Verdict:** ${formatVerdict(verdict)}`);
    lines.push('');

    // Agent Summaries
    lines.push('---');
    lines.push('');
    lines.push('## 📋 Agent Summaries');
    lines.push('');
    lines.push(`**🛡️ Security Architect:** ${agentSummaries.security}`);
    lines.push('');
    lines.push(`**⚡ Performance Engineer:** ${agentSummaries.performance}`);
    lines.push('');
    lines.push(`**🧹 Clean Code Advocate:** ${agentSummaries.cleanCode}`);
    lines.push('');

    // Findings
    if (findings.length === 0) {
        lines.push('---');
        lines.push('');
        lines.push('## ✅ No Issues Found');
        lines.push('');
        lines.push('All three expert agents reviewed this PR and found no actionable issues. Ship it! 🚀');
    } else {
        lines.push('---');
        lines.push('');
        lines.push('## 🐛 Findings');
        lines.push('');

        for (const finding of findings) {
            const sevEmoji = SEVERITY_EMOJI[finding.severity] ?? '⚪';
            const catEmoji = CATEGORY_EMOJI[finding.category] ?? '📝';

            lines.push(`### ${sevEmoji} [${finding.severity}] ${catEmoji} \`${finding.file}\`${finding.line ? ` L${finding.line}` : ''}`);
            lines.push('');
            lines.push(`**Issue:** ${finding.issue}`);
            lines.push('');

            if (finding.currentCode) {
                lines.push('**Current:**');
                lines.push('```');
                lines.push(finding.currentCode);
                lines.push('```');
                lines.push('');
            }

            if (finding.suggestedCode) {
                lines.push('**Suggested:**');
                lines.push('```');
                lines.push(finding.suggestedCode);
                lines.push('```');
                lines.push('');
            }

            lines.push(`_Identified by: ${finding.identifiedBy ?? 'Unknown'}_`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    // Summary Table
    lines.push('## 📊 Summary');
    lines.push('');

    const criticalCount = findings.filter((f) => f.severity === 'Critical').length;
    const highCount = findings.filter((f) => f.severity === 'High').length;
    const mediumCount = findings.filter((f) => f.severity === 'Medium').length;
    const lowCount = findings.filter((f) => f.severity === 'Low').length;

    lines.push('| Category | Count |');
    lines.push('|---|---|');
    lines.push(`| 🔴 Critical | ${criticalCount} |`);
    lines.push(`| 🟠 High | ${highCount} |`);
    lines.push(`| 🟡 Medium | ${mediumCount} |`);
    lines.push(`| 🟢 Low | ${lowCount} |`);
    lines.push(`| **Total** | **${findings.length}** |`);
    lines.push('');

    // Telemetry Footer
    lines.push('---');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>🔬 Telemetry</summary>');
    lines.push('');
    lines.push(`- **Tokens used:** ${tokenUsage.totalInput.toLocaleString()} input / ${tokenUsage.totalOutput.toLocaleString()} output`);
    lines.push(`- **Latency:** ${(tokenUsage.latencyMs / 1000).toFixed(1)}s`);
    lines.push(`- **Pipeline:** 3-Agent Multi-Expert (Security + Performance + CleanCode → Aggregator)`);
    lines.push('');
    lines.push('</details>');

    return lines.join('\n');
}

function formatVerdict(verdict: 'Approve' | 'RequestChanges' | 'NeedsDiscussion'): string {
    switch (verdict) {
        case 'Approve':
            return '✅ **Approve**';
        case 'RequestChanges':
            return '❌ **Request Changes**';
        case 'NeedsDiscussion':
            return '💬 **Needs Discussion**';
    }
}
