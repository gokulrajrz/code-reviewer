// ---------------------------------------------------------------------------
// Map-Reduce Review Types
// ---------------------------------------------------------------------------



/**
 * Severity levels for review findings.
 * Maps directly to the emoji tags in the final markdown output.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Categories for classifying the domain of each finding.
 * Used by the synthesizer to group and deduplicate findings.
 */
export type FindingCategory =
    | 'fsd'
    | 'react'
    | 'typescript'
    | 'security'
    | 'performance'
    | 'accessibility'
    | 'zustand'
    | 'tanstack-query'
    | 'tailwind'
    | 'forms'
    | 'clean-code';

/**
 * A single structured finding produced by a chunk reviewer (Map phase).
 */
export interface ReviewFinding {
    /** Severity classification */
    severity: FindingSeverity;
    /** File path relative to repo root */
    file: string;
    /** Approximate line number (if identifiable from the diff) */
    line?: number;
    /** Short, descriptive title */
    title: string;
    /** One sentence describing the problem */
    issue: string;
    /** The problematic code snippet */
    currentCode?: string;
    /** The corrected code snippet */
    suggestedCode?: string;
    /** Domain category for grouping */
    category: FindingCategory;
}

/**
 * A finding enriched with cluster-derived annotations for the synthesizer.
 * This is what the LLM receives — a FLAT list, not nested clusters.
 */
export interface AnnotatedFinding extends ReviewFinding {
    /** Inline annotations from cluster analysis (similar patterns, etc.) */
    annotations?: string[];
}

/**
 * The payload sent to the synthesizer LLM (Reduce phase).
 *
 * Findings are presented as a FLAT, severity-sorted array — not nested
 * inside clusters. This prevents the LLM from consolidating similar
 * findings into a single discussion block.
 *
 * Cluster metadata (similar patterns) is preserved as
 * inline annotations on individual findings.
 */
export interface SynthesizerInput {
    /** PR title from GitHub */
    prTitle: string;
    /** Complete list of all files in the PR (for cross-file analysis) */
    allFiles: string[];
    /** Number of files skipped as noise */
    skippedCount: number;
    /** All findings, flattened and sorted by severity (critical first) */
    findings: AnnotatedFinding[];
    /** Total number of unique findings (before any payload truncation) */
    totalFindingsCount: number;
    /** Total chunks processed */
    totalChunks: number;
    /** Number of chunks that failed */
    failedChunks: number;
    /** Number of findings dropped due to payload size limits */
    droppedFindingsCount: number;
    /** Files that were in failed chunks (no coverage) */
    failedChunkFiles: string[];
}
