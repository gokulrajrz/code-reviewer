/**
 * Telemetry Logger
 *
 * Emits structured JSON logs for every review cycle.
 * Designed for consumption by Cloudflare Workers Observability,
 * or any log aggregator (Datadog, Grafana, etc.).
 */

import type { TelemetryData } from '../types/review';

export interface ReviewTelemetryEvent {
    event: 'review_completed';
    timestamp: string;
    pr: {
        number: number;
        repo: string;
        sha: string;
    };
    agents: {
        security: TelemetryData | null;
        performance: TelemetryData | null;
        cleanCode: TelemetryData | null;
    };
    aggregated: {
        totalFindings: number;
        criticalCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        verdict: string;
        reviewStatus: string;
    };
    totals: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalLatencyMs: number;
        totalRetries: number;
        allSucceeded: boolean;
    };
}

/**
 * Constructs a structured telemetry event from the agent state data.
 */
export function buildTelemetryEvent(params: {
    prNumber: number;
    repoFullName: string;
    headSha: string;
    securityTelemetry: TelemetryData | null;
    performanceTelemetry: TelemetryData | null;
    cleanCodeTelemetry: TelemetryData | null;
    totalFindings: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    verdict: string;
    reviewStatus: string;
}): ReviewTelemetryEvent {
    const allTelemetry = [
        params.securityTelemetry,
        params.performanceTelemetry,
        params.cleanCodeTelemetry,
    ].filter((t): t is TelemetryData => t !== null);

    return {
        event: 'review_completed',
        timestamp: new Date().toISOString(),
        pr: {
            number: params.prNumber,
            repo: params.repoFullName,
            sha: params.headSha,
        },
        agents: {
            security: params.securityTelemetry,
            performance: params.performanceTelemetry,
            cleanCode: params.cleanCodeTelemetry,
        },
        aggregated: {
            totalFindings: params.totalFindings,
            criticalCount: params.criticalCount,
            highCount: params.highCount,
            mediumCount: params.mediumCount,
            lowCount: params.lowCount,
            verdict: params.verdict,
            reviewStatus: params.reviewStatus,
        },
        totals: {
            totalInputTokens: allTelemetry.reduce((sum, t) => sum + t.inputTokens, 0),
            totalOutputTokens: allTelemetry.reduce((sum, t) => sum + t.outputTokens, 0),
            totalLatencyMs: Math.max(...allTelemetry.map((t) => t.latencyMs), 0),
            totalRetries: allTelemetry.reduce((sum, t) => sum + t.retryCount, 0),
            allSucceeded: allTelemetry.every((t) => t.success),
        },
    };
}

/**
 * Emits the telemetry event as a structured JSON log line.
 */
export function emitTelemetry(event: ReviewTelemetryEvent): void {
    console.log(JSON.stringify(event));
}
