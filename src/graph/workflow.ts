/**
 * Multi-Agent Workflow Orchestrator
 *
 * A lightweight state-machine DAG that replaces LangGraph
 * (which has heavy Node.js deps incompatible with Cloudflare Workers).
 *
 * The pipeline:
 *   IngestContext → [Security | Performance | CleanCode] (parallel) → Aggregate → Gate → Publish
 */

import type { Env } from '../types/env';
import type { AgentState } from './state';
import type { TelemetryData } from '../types/review';
import { createInitialState } from './state';
import { SECURITY_AGENT_PROMPT } from '../agents/security';
import { PERFORMANCE_AGENT_PROMPT } from '../agents/performance';
import { CLEAN_CODE_AGENT_PROMPT } from '../agents/clean-code';
import { aggregateFindings } from '../agents/aggregator';
import { callStructuredLLM } from '../lib/llm/structured';
import { renderMarkdownReview } from '../lib/formatter';
import { buildTelemetryEvent, emitTelemetry } from '../lib/telemetry';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    postPRComment,
    updateCheckRun,
    fetchRepoContext,
} from '../lib/github';
import { getInstallationToken } from '../lib/github-auth';
import { MAX_CHUNK_CHARS, MAX_LLM_CHUNKS } from '../config/constants';

/** Maximum time (ms) to wait for a single LLM agent call. */
const AGENT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Node 1: Ingest Context
// ---------------------------------------------------------------------------

async function ingestContextNode(state: AgentState, env: Env): Promise<AgentState> {
    const token = await getInstallationToken(env);

    console.log(`[workflow] Ingesting context for PR #${state.prNumber}...`);

    // Fetch global repo context (README, package.json, etc.)
    const globalContext = await fetchRepoContext(state.repoFullName, token);
    console.log(`[workflow] ✓ Global context fetched (${globalContext.length} chars)`);

    // Fetch changed files
    const allFiles = await fetchChangedFiles(state.repoFullName, state.prNumber, token);
    console.log(`[workflow] ✓ Fetched ${allFiles.length} changed files`);

    if (allFiles.length === 0) {
        return {
            ...state,
            globalContext,
            fileChunks: [],
            reviewStatus: 'approved',
            finalMarkdown: '## No Files to Review\n\nThis PR has no reviewable file changes.',
        };
    }

    // Classify and build chunks
    const classified = classifyFiles(allFiles);
    console.log(
        `[workflow] ✓ Classified: ${classified.tier1.length} tier1, ` +
        `${classified.tier2.length} tier2, ${classified.skipped.length} skipped`
    );

    let chunks = await buildReviewChunks(classified, token, MAX_CHUNK_CHARS);

    // Apply hard cap
    if (chunks.length > MAX_LLM_CHUNKS) {
        console.log(`[workflow] ⚠️ Truncating chunks from ${chunks.length} to ${MAX_LLM_CHUNKS}`);
        chunks = chunks.slice(0, MAX_LLM_CHUNKS);
    }

    return { ...state, globalContext, fileChunks: chunks };
}

// ---------------------------------------------------------------------------
// Node 2-4: Expert Agent Nodes (Fan-out, run in parallel)
// ---------------------------------------------------------------------------

async function runAgentNode(
    agentName: string,
    systemPrompt: string,
    state: AgentState,
    env: Env
): Promise<{ findings: AgentState['securityFindings']; summary: string; telemetry: TelemetryData }> {
    const allFindings: AgentState['securityFindings'] = [];
    let combinedSummary = '';
    let combinedTelemetry: TelemetryData | null = null;

    for (let i = 0; i < state.fileChunks.length; i++) {
        const chunkLabel = state.fileChunks.length > 1 ? ` (Part ${i + 1}/${state.fileChunks.length})` : '';
        console.log(`[workflow:${agentName}] Processing chunk ${i + 1}/${state.fileChunks.length}...`);

        const userMessage = `
Please review the following Pull Request${chunkLabel}.

**PR Title:** ${state.prTitle}

## PROJECT CONTEXT
${state.globalContext}

## CODE CHANGES
${state.fileChunks[i]}
`.trim();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

        try {
            const result = await callStructuredLLM(systemPrompt, userMessage, env, controller.signal);
            allFindings.push(...result.output.findings);
            combinedSummary = result.output.summary; // Use the last chunk's summary

            // Accumulate telemetry
            if (!combinedTelemetry) {
                combinedTelemetry = { ...result.telemetry };
            } else {
                combinedTelemetry.inputTokens += result.telemetry.inputTokens;
                combinedTelemetry.outputTokens += result.telemetry.outputTokens;
                combinedTelemetry.latencyMs += result.telemetry.latencyMs;
                combinedTelemetry.retryCount += result.telemetry.retryCount;
                if (!result.telemetry.success) combinedTelemetry.success = false;
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[workflow:${agentName}] ⚠️ Chunk ${i + 1} failed: ${errMsg}`);
        } finally {
            clearTimeout(timer);
        }
    }

    const fallbackTelemetry: TelemetryData = combinedTelemetry ?? {
        provider: 'unknown',
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        success: false,
        retryCount: 0,
        error: 'No chunks processed',
    };

    return {
        findings: allFindings,
        summary: combinedSummary || `${agentName} agent did not produce a summary.`,
        telemetry: fallbackTelemetry,
    };
}

// ---------------------------------------------------------------------------
// Node 5: Aggregator
// ---------------------------------------------------------------------------

function aggregatorNode(state: AgentState): AgentState {
    console.log('[workflow:aggregator] Aggregating findings...');

    const result = aggregateFindings(
        state.securityFindings,
        state.performanceFindings,
        state.cleanCodeFindings
    );

    console.log(
        `[workflow:aggregator] ✓ ${result.findings.length} findings (${result.reviewStatus}, verdict: ${result.verdict})`
    );

    return {
        ...state,
        aggregatedFindings: result.findings,
        reviewStatus: result.reviewStatus,
    };
}

// ---------------------------------------------------------------------------
// Node 6: Human-in-the-Loop Gate
// ---------------------------------------------------------------------------

function humanGateNode(state: AgentState): AgentState {
    if (state.reviewStatus === 'needs_human_review') {
        if (state.isOverride) {
            console.log('[workflow:gate] 🔓 Critical findings present, but bypassing gate due to manual /override-ai');
            state.reviewStatus = 'approved';
            return state;
        }
        console.log('[workflow:gate] 🚨 Critical findings detected — halting for human review');
        return state;
    }

    console.log('[workflow:gate] ✓ No critical findings — auto-publishing');
    return state;
}

// ---------------------------------------------------------------------------
// The Full Pipeline
// ---------------------------------------------------------------------------

export interface WorkflowResult {
    state: AgentState;
    agentSummaries: {
        security: string;
        performance: string;
        cleanCode: string;
    };
}

/**
 * Executes the full multi-agent review pipeline.
 */
export async function executeWorkflow(params: {
    prNumber: number;
    prTitle: string;
    repoFullName: string;
    headSha: string;
    checkRunId: number;
    isOverride?: boolean;
    env: Env;
}): Promise<WorkflowResult> {
    const { env, ...stateParams } = params;
    let state = createInitialState(stateParams);

    console.log(`[workflow] ═══════════════════════════════════════════════════`);
    console.log(`[workflow] Starting Multi-Agent Pipeline for PR #${state.prNumber}`);
    console.log(`[workflow] ═══════════════════════════════════════════════════`);

    // ── Step 1: Ingest Context ──
    state = await ingestContextNode(state, env);

    if (state.fileChunks.length === 0) {
        console.log('[workflow] No reviewable chunks — skipping agents');
        return {
            state,
            agentSummaries: {
                security: 'N/A',
                performance: 'N/A',
                cleanCode: 'N/A',
            },
        };
    }

    // ── Step 2-4: Fan-out — Run 3 Expert Agents in Parallel ──
    console.log('[workflow] Launching 3 expert agents in parallel...');

    const [securityResult, performanceResult, cleanCodeResult] = await Promise.allSettled([
        runAgentNode('security', SECURITY_AGENT_PROMPT, state, env),
        runAgentNode('performance', PERFORMANCE_AGENT_PROMPT, state, env),
        runAgentNode('clean-code', CLEAN_CODE_AGENT_PROMPT, state, env),
    ]);

    // Extract results (handle rejections gracefully)
    const security = securityResult.status === 'fulfilled' ? securityResult.value : null;
    const performance = performanceResult.status === 'fulfilled' ? performanceResult.value : null;
    const cleanCode = cleanCodeResult.status === 'fulfilled' ? cleanCodeResult.value : null;

    state.securityFindings = security?.findings ?? [];
    state.performanceFindings = performance?.findings ?? [];
    state.cleanCodeFindings = cleanCode?.findings ?? [];

    // Collect telemetry
    if (security?.telemetry) state.telemetry.push(security.telemetry);
    if (performance?.telemetry) state.telemetry.push(performance.telemetry);
    if (cleanCode?.telemetry) state.telemetry.push(cleanCode.telemetry);

    console.log(
        `[workflow] ✓ Agents completed: ` +
        `Security=${state.securityFindings.length}, ` +
        `Performance=${state.performanceFindings.length}, ` +
        `CleanCode=${state.cleanCodeFindings.length} findings`
    );

    // ── Step 5: Aggregate ──
    state = aggregatorNode(state);

    // ── Step 6: Human Gate ──
    state = humanGateNode(state);

    // ── Build agent summaries ──
    const agentSummaries = {
        security: security?.summary ?? 'Agent failed to execute.',
        performance: performance?.summary ?? 'Agent failed to execute.',
        cleanCode: cleanCode?.summary ?? 'Agent failed to execute.',
    };

    // ── Build final markdown ──
    const totalInputTokens = state.telemetry.reduce((s, t) => s + t.inputTokens, 0);
    const totalOutputTokens = state.telemetry.reduce((s, t) => s + t.outputTokens, 0);
    const maxLatency = Math.max(...state.telemetry.map((t) => t.latencyMs), 0);

    state.finalMarkdown = renderMarkdownReview({
        prTitle: state.prTitle,
        findings: state.aggregatedFindings,
        verdict: state.aggregatedFindings.length === 0
            ? 'Approve'
            : state.aggregatedFindings.some((f) => f.severity === 'Critical' || f.severity === 'High')
                ? 'RequestChanges'
                : 'NeedsDiscussion',
        agentSummaries,
        tokenUsage: {
            totalInput: totalInputTokens,
            totalOutput: totalOutputTokens,
            latencyMs: maxLatency,
        },
    });

    // ── Emit Telemetry ──
    const telemetryEvent = buildTelemetryEvent({
        prNumber: state.prNumber,
        repoFullName: state.repoFullName,
        headSha: state.headSha,
        securityTelemetry: security?.telemetry ?? null,
        performanceTelemetry: performance?.telemetry ?? null,
        cleanCodeTelemetry: cleanCode?.telemetry ?? null,
        totalFindings: state.aggregatedFindings.length,
        criticalCount: state.aggregatedFindings.filter((f) => f.severity === 'Critical').length,
        highCount: state.aggregatedFindings.filter((f) => f.severity === 'High').length,
        mediumCount: state.aggregatedFindings.filter((f) => f.severity === 'Medium').length,
        lowCount: state.aggregatedFindings.filter((f) => f.severity === 'Low').length,
        verdict: state.reviewStatus === 'needs_human_review' ? 'RequestChanges' : 'Approve',
        reviewStatus: state.reviewStatus,
    });
    emitTelemetry(telemetryEvent);

    console.log(`[workflow] ═══════════════════════════════════════════════════`);
    console.log(`[workflow] Pipeline complete — ${state.aggregatedFindings.length} findings, status: ${state.reviewStatus}`);
    console.log(`[workflow] ═══════════════════════════════════════════════════`);

    return { state, agentSummaries };
}
