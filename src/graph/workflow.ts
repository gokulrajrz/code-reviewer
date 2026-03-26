/**
 * Multi-Agent Workflow Orchestrator
 *
 * A lightweight state-machine DAG that replaces LangGraph
 * (which has heavy Node.js deps incompatible with Cloudflare Workers).
 *
 * The pipeline:
 *   IngestContext → [Security | Performance | CleanCode] (parallel) → Aggregate → Gate → Publish
 */

import type { Env, AIProvider } from '../types/env';
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
import { getInstallationToken } from '../lib/github-auth';
import {
    fetchChangedFiles,
    classifyFiles,
    buildReviewChunks,
    fetchRepoContext,
} from '../lib/github';
import {
    getChunkSize,
    MAX_LLM_CHUNKS,
    DEFAULT_AI_PROVIDER,
    MODELS,
} from '../config/constants';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Pipeline Nodes
// ---------------------------------------------------------------------------

async function ingestContextNode(state: AgentState, env: Env): Promise<AgentState> {
    const token = await getInstallationToken(env);
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;
    const model = MODELS[provider];
    const maxChunkChars = getChunkSize(provider);

    console.log(
        `[workflow] Ingesting context for PR #${state.prNumber}`,
        `(model: ${model}, chunk size: ${maxChunkChars.toLocaleString()} chars)...`
    );

    // Fetch global repo context (README, package.json, etc.)
    const globalContext = await fetchRepoContext(state.repoFullName, token);
    console.log(`[workflow] ✓ Global context fetched (${globalContext.length.toLocaleString()} chars)`);

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

    let chunks = await buildReviewChunks(classified, token, maxChunkChars);

    // Apply hard cap to stay within Cloudflare Workers subrequest limits
    if (chunks.length > MAX_LLM_CHUNKS) {
        console.log(`[workflow] ⚠️ Truncating chunks from ${chunks.length} to ${MAX_LLM_CHUNKS}`);
        chunks = chunks.slice(0, MAX_LLM_CHUNKS);
    }

    return { ...state, globalContext, fileChunks: chunks };
}

// ---------------------------------------------------------------------------
// Expert Agent Runner
// ---------------------------------------------------------------------------

async function runAgentNode(
    agentName: string,
    systemPrompt: string,
    state: AgentState,
    env: Env
): Promise<{ findings: AgentState['securityFindings']; summary: string; telemetry: TelemetryData; errors: string[] }> {
    const allFindings: AgentState['securityFindings'] = [];
    let combinedSummary = '';
    let combinedTelemetry: TelemetryData | null = null;
    const errors: string[] = [];

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
            combinedSummary = result.output.summary;

            // Accumulate telemetry across chunks
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
            errors.push(`[${agentName}] Chunk ${i + 1} failed: ${errMsg}`);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        findings: allFindings,
        summary: combinedSummary || `${agentName} agent did not produce a summary.`,
        telemetry: combinedTelemetry ?? {
            provider: 'unknown',
            model: 'unknown',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            success: false,
            retryCount: 0,
            error: 'No chunks processed',
        },
        errors,
    };
}

// ---------------------------------------------------------------------------
// Aggregator & Gate Nodes
// ---------------------------------------------------------------------------

function aggregatorNode(state: AgentState): AgentState {
    console.log('[workflow:aggregator] Aggregating findings...');

    const result = aggregateFindings(
        state.securityFindings,
        state.performanceFindings,
        state.cleanCodeFindings
    );

    console.log(
        `[workflow:aggregator] ✓ ${result.findings.length} findings ` +
        `(${result.reviewStatus}, verdict: ${result.verdict})`
    );

    return {
        ...state,
        aggregatedFindings: result.findings,
        reviewStatus: result.reviewStatus,
    };
}

function humanGateNode(state: AgentState): AgentState {
    if (state.reviewStatus === 'needs_human_review') {
        if (state.isOverride) {
            console.log('[workflow:gate] 🔓 Critical findings present, but bypassing gate due to manual /override-ai');
            return {
                ...state,
                reviewStatus: 'approved',
            };
        }
        console.log('[workflow:gate] 🚨 Critical findings detected — halting for human review');
        return state;
    }

    console.log('[workflow:gate] ✓ No critical findings — auto-publishing');
    return state;
}

// ---------------------------------------------------------------------------
// Main Workflow Orchestrator
// ---------------------------------------------------------------------------

export interface WorkflowResult {
    state: AgentState;
    agentSummaries: {
        security: string;
        performance: string;
        cleanCode: string;
    };
}

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

    // Step 1: Ingest Context
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

    // Step 2-4: Fan-out — Run 3 Expert Agents in Parallel
    console.log('[workflow] Launching 3 expert agents in parallel...');

    const [securityResult, performanceResult, cleanCodeResult] = await Promise.allSettled([
        runAgentNode('security', SECURITY_AGENT_PROMPT, state, env),
        runAgentNode('performance', PERFORMANCE_AGENT_PROMPT, state, env),
        runAgentNode('clean-code', CLEAN_CODE_AGENT_PROMPT, state, env),
    ]);

    const security = securityResult.status === 'fulfilled' ? securityResult.value : null;
    const performance = performanceResult.status === 'fulfilled' ? performanceResult.value : null;
    const cleanCode = cleanCodeResult.status === 'fulfilled' ? cleanCodeResult.value : null;

    if (securityResult.status === 'rejected') state.errors.push(`[security] Agent rejected: ${String(securityResult.reason)}`);
    if (performanceResult.status === 'rejected') state.errors.push(`[performance] Agent rejected: ${String(performanceResult.reason)}`);
    if (cleanCodeResult.status === 'rejected') state.errors.push(`[clean-code] Agent rejected: ${String(cleanCodeResult.reason)}`);

    if (security?.errors) state.errors.push(...security.errors);
    if (performance?.errors) state.errors.push(...performance.errors);
    if (cleanCode?.errors) state.errors.push(...cleanCode.errors);

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

    if (state.errors.length > 0) {
        console.error(`[workflow] ❌ Agents failed with errors:\n${state.errors.join('\n')}`);
        state.reviewStatus = 'failed';
        throw new Error(state.errors.join('\n'));
    }

    // Step 5: Aggregate
    state = aggregatorNode(state);

    // Step 6: Human Gate
    state = humanGateNode(state);

    // Build agent summaries
    const agentSummaries = {
        security: security?.summary ?? 'Agent failed to execute.',
        performance: performance?.summary ?? 'Agent failed to execute.',
        cleanCode: cleanCode?.summary ?? 'Agent failed to execute.',
    };

    // Build final markdown
    const totalInputTokens = state.telemetry.reduce((sum, t) => sum + t.inputTokens, 0);
    const totalOutputTokens = state.telemetry.reduce((sum, t) => sum + t.outputTokens, 0);
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

    // Emit Telemetry
    const severityCounts = state.aggregatedFindings.reduce(
        (acc, f) => {
            acc[f.severity.toLowerCase() as 'critical' | 'high' | 'medium' | 'low']++;
            return acc;
        },
        { critical: 0, high: 0, medium: 0, low: 0 }
    );

    const telemetryEvent = buildTelemetryEvent({
        prNumber: state.prNumber,
        repoFullName: state.repoFullName,
        headSha: state.headSha,
        securityTelemetry: security?.telemetry ?? null,
        performanceTelemetry: performance?.telemetry ?? null,
        cleanCodeTelemetry: cleanCode?.telemetry ?? null,
        totalFindings: state.aggregatedFindings.length,
        criticalCount: severityCounts.critical,
        highCount: severityCounts.high,
        mediumCount: severityCounts.medium,
        lowCount: severityCounts.low,
        verdict: state.reviewStatus === 'needs_human_review' ? 'RequestChanges' : 'Approve',
        reviewStatus: state.reviewStatus,
    });
    emitTelemetry(telemetryEvent);

    console.log(`[workflow] ═══════════════════════════════════════════════════`);
    console.log(`[workflow] Pipeline complete — ${state.aggregatedFindings.length} findings, status: ${state.reviewStatus}`);
    console.log(`[workflow] ═══════════════════════════════════════════════════`);

    return { state, agentSummaries };
}
