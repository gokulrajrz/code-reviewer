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
 * The JSON schema that chunk reviewers (Map phase) must output.
 */
export interface ChunkReviewOutput {
    findings: ReviewFinding[];
}

/**
 * Result of processing a single chunk, including error recovery metadata.
 */
export interface ChunkReviewResult {
    /** Zero-based index of the chunk */
    chunkIndex: number;
    /** Parsed findings from the LLM */
    findings: ReviewFinding[];
    /** If the chunk failed, the error message */
    error?: string;
}

/**
 * The payload sent to the synthesizer LLM (Reduce phase).
 */
export interface SynthesizerInput {
    /** PR title from GitHub */
    prTitle: string;
    /** Complete list of all files in the PR (for cross-file analysis) */
    allFiles: string[];
    /** Number of files skipped as noise */
    skippedCount: number;
    /** All findings collected from Map phase */
    findings: ReviewFinding[];
    /** Total chunks processed */
    totalChunks: number;
    /** Number of chunks that failed */
    failedChunks: number;
}
