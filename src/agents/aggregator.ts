/**
 * Aggregator Agent
 *
 * Persona: The Lead Reviewer.
 * Takes findings from the 3 Expert Personas, deduplicates,
 * resolves overlaps, and produces the final unified review.
 */

import type { ReviewFinding } from '../types/review';
import type { ReviewStatus } from '../graph/state';

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Two findings are considered duplicates if they target the same file
 * and their issue descriptions have high textual overlap.
 */
function areDuplicates(a: ReviewFinding, b: ReviewFinding): boolean {
    if (a.file !== b.file) return false;

    // Simple: normalize and compare. If >80% of words overlap, deduplicate.
    const wordsA = new Set(a.issue.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.issue.toLowerCase().split(/\s+/));

    let overlap = 0;
    for (const word of wordsA) {
        if (wordsB.has(word)) overlap++;
    }

    const similarity = overlap / Math.max(wordsA.size, wordsB.size);
    return similarity > 0.8;
}

/**
 * Removes duplicate findings across agents.
 * When duplicates are found, keeps the one with the higher severity.
 */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const severityRank: Record<string, number> = {
        Critical: 4,
        High: 3,
        Medium: 2,
        Low: 1,
    };

    const result: ReviewFinding[] = [];

    for (const finding of findings) {
        const duplicateIndex = result.findIndex((existing) => areDuplicates(existing, finding));

        if (duplicateIndex === -1) {
            result.push(finding);
        } else {
            // Keep the higher-severity one
            const existing = result[duplicateIndex];
            const existingRank = severityRank[existing.severity] ?? 0;
            const newRank = severityRank[finding.severity] ?? 0;
            if (newRank > existingRank) {
                result[duplicateIndex] = finding;
            }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sorts findings: Critical first, then High, Medium, Low.
 * Within the same severity, Security > Performance > Maintainability > Style.
 */
function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const severityRank: Record<string, number> = {
        Critical: 4,
        High: 3,
        Medium: 2,
        Low: 1,
    };
    const categoryRank: Record<string, number> = {
        Security: 4,
        Performance: 3,
        Maintainability: 2,
        Style: 1,
        HumanReviewNeeded: 5, // Always surfaces to top
    };

    return [...findings].sort((a, b) => {
        const sevDiff = (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
        if (sevDiff !== 0) return sevDiff;
        return (categoryRank[b.category] ?? 0) - (categoryRank[a.category] ?? 0);
    });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregationResult {
    findings: ReviewFinding[];
    reviewStatus: ReviewStatus;
    verdict: 'Approve' | 'RequestChanges' | 'NeedsDiscussion';
}

/**
 * Aggregates findings from all 3 personas.
 * Deduplicates, sorts, and determines if human review is needed.
 */
export function aggregateFindings(
    securityFindings: ReviewFinding[],
    performanceFindings: ReviewFinding[],
    cleanCodeFindings: ReviewFinding[]
): AggregationResult {
    // Tag each finding with its source
    const taggedSecurity = securityFindings.map((f) => ({ ...f, identifiedBy: 'Security' as const }));
    const taggedPerformance = performanceFindings.map((f) => ({ ...f, identifiedBy: 'Performance' as const }));
    const taggedCleanCode = cleanCodeFindings.map((f) => ({ ...f, identifiedBy: 'CleanCode' as const }));

    // Merge all findings
    const allFindings = [...taggedSecurity, ...taggedPerformance, ...taggedCleanCode];

    // Deduplicate
    const deduplicated = deduplicateFindings(allFindings);

    // Sort by severity (Critical first)
    const sorted = sortFindings(deduplicated);

    // Determine review status
    const hasCritical = sorted.some((f) => f.severity === 'Critical');
    const hasHigh = sorted.some((f) => f.severity === 'High');
    const hasHumanReview = sorted.some((f) => f.category === 'HumanReviewNeeded');

    let reviewStatus: ReviewStatus;
    let verdict: 'Approve' | 'RequestChanges' | 'NeedsDiscussion';

    if (hasCritical) {
        reviewStatus = 'needs_human_review';
        verdict = 'RequestChanges';
    } else if (hasHigh || hasHumanReview) {
        reviewStatus = 'approved'; // Can auto-post, but request changes
        verdict = 'RequestChanges';
    } else if (sorted.length > 0) {
        reviewStatus = 'approved';
        verdict = 'NeedsDiscussion';
    } else {
        reviewStatus = 'approved';
        verdict = 'Approve';
    }

    return { findings: sorted, reviewStatus, verdict };
}
