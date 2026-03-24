import type { ReviewFinding, TelemetryData } from '../types/review';

// ---------------------------------------------------------------------------
// The Agent State — flows through the entire DAG
// ---------------------------------------------------------------------------

export type ReviewStatus = 'pending' | 'needs_human_review' | 'approved' | 'failed';

export interface AgentState {
    // ── Inputs (set by IngestContextNode) ──
    prNumber: number;
    prTitle: string;
    repoFullName: string;
    headSha: string;
    checkRunId: number;
    isOverride?: boolean;

    /** Global repo context: README.md, package.json, .eslintrc etc. */
    globalContext: string;
    /** The PR diff/file chunks to review */
    fileChunks: string[];

    // ── Agent Outputs (set by Fan-out Nodes) ──
    securityFindings: ReviewFinding[];
    performanceFindings: ReviewFinding[];
    cleanCodeFindings: ReviewFinding[];

    // ── Final Outputs (set by AggregatorNode) ──
    aggregatedFindings: ReviewFinding[];
    reviewStatus: ReviewStatus;
    finalMarkdown: string;

    // ── Telemetry ──
    telemetry: TelemetryData[];

    // ── Error tracking ──
    errors: string[];
}

/**
 * Creates a fresh AgentState with sensible defaults.
 */
export function createInitialState(params: {
    prNumber: number;
    prTitle: string;
    repoFullName: string;
    headSha: string;
    checkRunId: number;
    isOverride?: boolean;
}): AgentState {
    return {
        ...params,
        globalContext: '',
        fileChunks: [],
        securityFindings: [],
        performanceFindings: [],
        cleanCodeFindings: [],
        aggregatedFindings: [],
        reviewStatus: 'pending',
        finalMarkdown: '',
        telemetry: [],
        errors: [],
    };
}
