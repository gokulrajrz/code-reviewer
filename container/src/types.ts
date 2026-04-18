/**
 * Review request payload sent from the Cloudflare Worker queue handler
 * to the container's POST /review endpoint.
 */
export interface ReviewRequest {
	repoFullName: string;
	prNumber: number;
	headSha: string;
	title: string;
	prAuthor: string;
	prDescription?: string;
	installationToken: string;
	aiProvider: 'claude' | 'gemini';
	anthropicApiKey: string;
	geminiApiKey: string;
	/** Worker-generated request ID for distributed tracing */
	requestId?: string;
	checkRunId?: number;
}

/**
 * A single code review finding produced by the Review Agent.
 */
export interface ReviewFinding {
	title: string;
	description: string;
	severity: 'critical' | 'high' | 'medium' | 'low';
	file: string;
	line?: number;
	category: string;
	suggestion?: string;
}

/**
 * Static analysis finding from oxlint, biome, or semgrep.
 */
export interface StaticFinding {
	tool: 'oxlint' | 'biome' | 'semgrep';
	rule: string;
	message: string;
	file: string;
	line: number;
	column?: number;
	severity: 'error' | 'warning' | 'info';
}

/**
 * The blast radius output from the AST graph analyzer.
 */
export interface BlastRadius {
	/** Files directly modified in the PR */
	changedFiles: string[];
	/** Files that import/depend on changed files (transitive) */
	impactedFiles: string[];
	/** Symbols (functions, classes, interfaces) that were modified */
	changedSymbols: SymbolInfo[];
	/** Symbols that reference the changed symbols */
	impactedSymbols: SymbolInfo[];
}

export interface SymbolInfo {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum';
	file: string;
	startLine: number;
	endLine: number;
}

/**
 * Response payload returned by the container to the Worker.
 */
export interface ReviewResponse {
	findings: ReviewFinding[];
	staticFindings: StaticFinding[];
	blastRadius: BlastRadius;
	metrics: ReviewMetrics;
	verdict: 'approve' | 'request_changes' | 'needs_discussion';
	/** True if the Verification Agent ran successfully */
	verified: boolean;
}

export interface ReviewMetrics {
	cloneTimeMs: number;
	parseTimeMs: number;
	staticAnalysisTimeMs: number;
	reviewAgentTimeMs: number;
	verificationAgentTimeMs: number;
	totalTimeMs: number;
	filesAnalyzed: number;
	symbolsTracked: number;
	llmInputTokens: number;
	llmOutputTokens: number;
}
