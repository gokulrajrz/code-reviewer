import { z } from 'zod';

// ---------------------------------------------------------------------------
// Severity & Category Enums
// ---------------------------------------------------------------------------

export const Severity = z.enum(['Low', 'Medium', 'High', 'Critical']);
export type Severity = z.infer<typeof Severity>;

export const Category = z.enum([
    'Security',
    'Performance',
    'Maintainability',
    'Style',
    'HumanReviewNeeded',
]);
export type Category = z.infer<typeof Category>;

// ---------------------------------------------------------------------------
// A single review finding
// ---------------------------------------------------------------------------

export const ReviewFindingSchema = z.object({
    file: z.string().describe('The relative file path where the issue was found'),
    line: z.number().optional().describe('Optional line number'),
    severity: Severity,
    category: Category,
    issue: z.string().describe('One clear sentence describing the problem'),
    currentCode: z.string().describe('The problematic code snippet'),
    suggestedCode: z.string().describe('The corrected code snippet'),
    identifiedBy: z.enum(['Security', 'Performance', 'CleanCode', 'Aggregator']).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

// ---------------------------------------------------------------------------
// The structured output schema returned by each agent
// ---------------------------------------------------------------------------

export const AgentReviewOutputSchema = z.object({
    findings: z.array(ReviewFindingSchema),
    summary: z.string().describe('A one-paragraph summary of findings'),
    verdict: z.enum(['Approve', 'RequestChanges', 'NeedsDiscussion']),
});
export type AgentReviewOutput = z.infer<typeof AgentReviewOutputSchema>;

// ---------------------------------------------------------------------------
// Telemetry data collected per LLM call
// ---------------------------------------------------------------------------

export interface TelemetryData {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    success: boolean;
    retryCount: number;
    error?: string;
}
