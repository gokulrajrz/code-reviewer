import { v4 as uuidv4 } from 'uuid';
import { cloneRepository, getChangedFiles, cleanup } from './git-ops.js';
import { buildBlastRadius } from './ast-graph.js';
import { runStaticAnalysis } from './static-analysis.js';
import { callReviewAgent } from './llm-client.js';
import { verifyFindings } from './verification-agent.js';
import type { ReviewRequest, ReviewResponse, ReviewMetrics, ReviewFinding } from './types.js';

/**
 * Updates the GitHub Check Run symmetrically mirroring the container's execution state.
 */
async function updateCheckRunProgress(
	repoFullName: string,
	checkRunId: number | undefined,
	token: string,
	summary: string
) {
	if (!checkRunId) return;

	try {
        console.log(`[CheckRun] Updating progress: ${summary}`);
		const res = await fetch(`https://api.github.com/repos/${repoFullName}/check-runs/${checkRunId}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'code-reviewer-container/1.0',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'AI Code Reviewer',
				status: 'in_progress',
				output: {
					title: 'Live Review Progress',
					summary,
				},
			}),
		});
		if (!res.ok) console.warn(`[CheckRun] Failed to update progress, status: ${res.status}`);
	} catch (err) {
		console.warn(`[CheckRun] Failed to update progress:`, err);
	}
}

/**
 * The core review pipeline. Orchestrates the full sequence:
 * 1. Clone repo (shallow)
 * 2. Get changed files from diff
 * 3. Build AST blast radius via tree-sitter
 * 4. Run static analyzers (oxlint, biome, semgrep)
 * 5. Call Review Agent (Claude/Gemini)
 * 6. Call Verification Agent to kill false positives
 * 7. Cleanup temp directory
 */
export async function runReviewPipeline(
	request: ReviewRequest,
	requestId: string
): Promise<ReviewResponse> {
	const workDir = `/tmp/review-${uuidv4()}`;
	const metrics: ReviewMetrics = {
		cloneTimeMs: 0,
		parseTimeMs: 0,
		staticAnalysisTimeMs: 0,
		reviewAgentTimeMs: 0,
		verificationAgentTimeMs: 0,
		totalTimeMs: 0,
		filesAnalyzed: 0,
		symbolsTracked: 0,
		llmInputTokens: 0,
		llmOutputTokens: 0,
	};

	const totalStart = Date.now();

	try {
		// ── Step 1: Clone ──
		console.log(`[${requestId}] Step 1: Cloning ${request.repoFullName}...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, request.installationToken, '📦 Cloning repository into isolated sandbox...');
		const cloneStart = Date.now();
		await cloneRepository(request.repoFullName, request.headSha, request.installationToken, workDir);
		metrics.cloneTimeMs = Date.now() - cloneStart;
		console.log(`[${requestId}] Clone completed in ${metrics.cloneTimeMs}ms`);

		// ── Step 2: Get changed files ──
		console.log(`[${requestId}] Step 2: Getting changed files...`);
		const changedFiles = await getChangedFiles(workDir);
		metrics.filesAnalyzed = changedFiles.length;
		console.log(`[${requestId}] Found ${changedFiles.length} changed files`);

		if (changedFiles.length === 0) {
			return {
				findings: [],
				staticFindings: [],
				blastRadius: { changedFiles: [], impactedFiles: [], changedSymbols: [], impactedSymbols: [] },
				metrics: { ...metrics, totalTimeMs: Date.now() - totalStart },
				verdict: 'approve',
				verified: true,
			};
		}

		// ── Step 3: AST Blast Radius ──
		console.log(`[${requestId}] Step 3: Building AST blast radius...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, request.installationToken, '🌳 Building Deep Dependency Graph via Tree-Sitter AST...');
		const parseStart = Date.now();
		const blastRadius = await buildBlastRadius(workDir, changedFiles);
		metrics.parseTimeMs = Date.now() - parseStart;
		metrics.symbolsTracked = blastRadius.changedSymbols.length + blastRadius.impactedSymbols.length;
		console.log(`[${requestId}] AST parsed in ${metrics.parseTimeMs}ms — ${metrics.symbolsTracked} symbols tracked`);

		// ── Step 4: Static Analysis ──
		console.log(`[${requestId}] Step 4: Running static analyzers...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, request.installationToken, '🛡️ Executing Ground-Truth Security & Linting Tools...');
		const staticStart = Date.now();
		const staticFindings = await runStaticAnalysis(workDir, changedFiles);
		metrics.staticAnalysisTimeMs = Date.now() - staticStart;
		console.log(`[${requestId}] Static analysis done in ${metrics.staticAnalysisTimeMs}ms — ${staticFindings.length} findings`);

		// ── Step 5: Review Agent ──
		console.log(`[${requestId}] Step 5: Calling Review Agent (${request.aiProvider})...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, request.installationToken, '🧠 Primary LLM Review Pass in progress...');
		const reviewStart = Date.now();
		const rawFindings = await callReviewAgent(request, workDir, changedFiles, blastRadius, staticFindings);
		metrics.reviewAgentTimeMs = Date.now() - reviewStart;
		console.log(`[${requestId}] Review Agent returned ${rawFindings.length} findings in ${metrics.reviewAgentTimeMs}ms`);

		// ── Step 6: Verification Agent ──
		console.log(`[${requestId}] Step 6: Running Verification Agent...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, request.installationToken, '🕵️ Verification LLM Pass: challenging findings against hallucinations...');
		const verifyStart = Date.now();
		let verifiedFindings: ReviewFinding[];
		let verified = false;

		try {
			verifiedFindings = await verifyFindings(request, rawFindings, workDir, changedFiles);
			verified = true;
			console.log(`[${requestId}] Verification Agent kept ${verifiedFindings.length}/${rawFindings.length} findings`);
		} catch (err) {
			// Verification is best-effort. If it fails, use unverified findings.
			console.error(`[${requestId}] Verification Agent failed, using raw findings:`, err);
			verifiedFindings = rawFindings;
		}

		metrics.verificationAgentTimeMs = Date.now() - verifyStart;

		// ── Derive verdict ──
		const verdict = deriveVerdict(verifiedFindings);
		metrics.totalTimeMs = Date.now() - totalStart;

		return {
			findings: verifiedFindings,
			staticFindings,
			blastRadius,
			metrics,
			verdict,
			verified,
		};
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(`[${requestId}] Pipeline critical failure:`, err);
		
		// Let the Check Run know exactly why the container blew up before we fall back
		await updateCheckRunProgress(
			request.repoFullName, 
			request.checkRunId, 
			request.installationToken, 
			`🚨 **Container Sandbox Failure:** \`${errMsg}\`\n\nFalling back to standard in-worker Map-Reduce architecture...`
		);
		
		// Rethrow so the HTTP endpoint yields 500 and the Worker gracefully catches it
		throw err;
	} finally {
		// ── Step 7: Cleanup ──
		await cleanup(workDir);
	}
}

/**
 * Derive a verdict from the findings list.
 */
function deriveVerdict(findings: ReviewFinding[]): 'approve' | 'request_changes' | 'needs_discussion' {
	const hasCritical = findings.some((f) => f.severity === 'critical');
	const hasHigh = findings.some((f) => f.severity === 'high');
	const highCount = findings.filter((f) => f.severity === 'high').length;

	if (hasCritical) return 'request_changes';
	if (hasHigh && highCount >= 2) return 'request_changes';
	if (hasHigh) return 'needs_discussion';
	return 'approve';
}
