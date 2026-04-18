import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFileDiff } from './git-ops.js';
import type { ReviewRequest, ReviewFinding, BlastRadius, StaticFinding } from './types.js';

const MAX_FILE_CONTENT_CHARS = 8000;
const MAX_DIFF_CHARS = 4000;
const MAX_TOTAL_CONTEXT_CHARS = 100_000;

/**
 * Call the Review Agent (primary LLM) to perform the code review.
 * Provides the LLM with:
 * 1. PR metadata (title, description, author)
 * 2. File diffs
 * 3. AST blast radius (what symbols changed, what's impacted)
 * 4. Static analysis findings (ground truth from deterministic tools)
 */
export async function callReviewAgent(
	request: ReviewRequest,
	workDir: string,
	changedFiles: string[],
	blastRadius: BlastRadius,
	staticFindings: StaticFinding[]
): Promise<ReviewFinding[]> {
	// Build the context payload
	const context = await buildLLMContext(request, workDir, changedFiles, blastRadius, staticFindings);

	const systemPrompt = `You are an expert code reviewer for a ${detectLanguage(changedFiles)} codebase.

Your job is to find REAL, ACTIONABLE bugs and architectural issues. Do NOT report style preferences, minor naming suggestions, or nitpicks.

You have access to:
1. The exact file diffs (what changed)
2. AST analysis showing which symbols were modified and which files are impacted
3. Static analysis findings from deterministic tools (oxlint, biome, semgrep) — treat these as ground truth

RULES:
- Only report findings you are CONFIDENT about based on the code evidence
- Every finding MUST include the specific file and line number
- Every finding MUST include a concrete code-level suggestion
- Bugs > Security > Architecture > Performance
- If a static analysis tool already found an issue, you may reference it but focus on deeper insights the tools can't find
- Do NOT invent issues that aren't supported by the actual code

Return a JSON array of findings. Each finding must have:
{
  "title": "Short descriptive title",
  "description": "Detailed explanation with code evidence",
  "severity": "critical|high|medium|low",
  "file": "relative/path/to/file.ts",
  "line": 42,
  "category": "bug|security|architecture|performance|error-handling|type-safety",
  "suggestion": "Concrete code fix or approach"
}

Return ONLY the JSON array, no markdown fences, no extra text.`;

	if (request.aiProvider === 'claude') {
		return callClaude(request.anthropicApiKey, systemPrompt, context);
	} else {
		return callGemini(request.geminiApiKey, systemPrompt, context);
	}
}

async function callClaude(apiKey: string, systemPrompt: string, userContent: string): Promise<ReviewFinding[]> {
	const anthropic = new Anthropic({ apiKey });

	const response = await anthropic.messages.create({
		model: 'claude-sonnet-4-20250514',
		max_tokens: 8192,
		system: systemPrompt,
		messages: [{ role: 'user', content: userContent }],
	});

	const text = response.content
		.filter((block): block is Anthropic.TextBlock => block.type === 'text')
		.map((block) => block.text)
		.join('');

	return parseFindings(text);
}

async function callGemini(apiKey: string, systemPrompt: string, userContent: string): Promise<ReviewFinding[]> {
	const genAI = new GoogleGenerativeAI(apiKey);
	const model = genAI.getGenerativeModel({
		model: 'gemini-2.5-pro',
		systemInstruction: systemPrompt,
	});

	const result = await model.generateContent(userContent);
	const text = result.response.text();

	return parseFindings(text);
}

/**
 * Build the combined context string for the LLM.
 */
async function buildLLMContext(
	request: ReviewRequest,
	workDir: string,
	changedFiles: string[],
	blastRadius: BlastRadius,
	staticFindings: StaticFinding[]
): Promise<string> {
	const sections: string[] = [];
	let totalChars = 0;

	// Section 1: PR Metadata
	sections.push(`## PR: ${request.title} (#${request.prNumber})
Author: ${request.prAuthor}
Repo: ${request.repoFullName}
${request.prDescription ? `Description: ${request.prDescription.slice(0, 500)}` : ''}`);

	// Section 2: Blast Radius Summary
	sections.push(`## Blast Radius
Changed files: ${blastRadius.changedFiles.length}
Impacted files (downstream dependencies): ${blastRadius.impactedFiles.length}
Changed symbols: ${blastRadius.changedSymbols.map((s) => `${s.kind} ${s.name} (${s.file}:${s.startLine})`).join(', ')}
Impacted symbols: ${blastRadius.impactedSymbols.slice(0, 20).map((s) => `${s.kind} ${s.name} (${s.file}:${s.startLine})`).join(', ')}`);

	// Section 3: Static Analysis (ground truth)
	if (staticFindings.length > 0) {
		sections.push(`## Static Analysis Findings (Deterministic — Ground Truth)
${staticFindings.slice(0, 50).map((f) => `- [${f.tool}] ${f.severity}: ${f.message} (${f.file}:${f.line}) [${f.rule}]`).join('\n')}`);
	}

	// Section 4: File Diffs (main content)
	sections.push('## File Diffs');
	for (const file of changedFiles) {
		if (totalChars > MAX_TOTAL_CONTEXT_CHARS) {
			sections.push(`\n... (${changedFiles.length - changedFiles.indexOf(file)} more files truncated for context limits)`);
			break;
		}

		try {
			const diff = await getFileDiff(workDir, file);
			const truncatedDiff = diff.slice(0, MAX_DIFF_CHARS);

			// Also include the full file content for context
			const fullContent = await readFile(join(workDir, file), 'utf-8').catch(() => '');
			const truncatedContent = fullContent.slice(0, MAX_FILE_CONTENT_CHARS);

			const fileSection = `### ${file}
\`\`\`diff
${truncatedDiff}${diff.length > MAX_DIFF_CHARS ? '\n... (diff truncated)' : ''}
\`\`\`

Full file context:
\`\`\`
${truncatedContent}${fullContent.length > MAX_FILE_CONTENT_CHARS ? '\n... (file truncated)' : ''}
\`\`\``;

			totalChars += fileSection.length;
			sections.push(fileSection);
		} catch {
			sections.push(`### ${file}\n(Could not read file diff)`);
		}
	}

	return sections.join('\n\n');
}

function parseFindings(text: string): ReviewFinding[] {
	// Strip markdown code fences if present
	const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

	try {
		const parsed = JSON.parse(cleaned);
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(f: any) => f.title && f.description && f.severity && f.file && f.category
			);
		}
	} catch {
		// Try to extract JSON array from the text
		const match = cleaned.match(/\[[\s\S]*\]/);
		if (match) {
			try {
				const parsed = JSON.parse(match[0]);
				if (Array.isArray(parsed)) {
					return parsed.filter(
						(f: any) => f.title && f.description && f.severity && f.file && f.category
					);
				}
			} catch {
				// Give up
			}
		}
	}

	console.warn('[llm-client] Failed to parse LLM response as JSON findings');
	return [];
}

function detectLanguage(files: string[]): string {
	const ext = files.map((f) => f.split('.').pop()?.toLowerCase()).filter(Boolean);
	if (ext.includes('ts') || ext.includes('tsx')) return 'TypeScript';
	if (ext.includes('js') || ext.includes('jsx')) return 'JavaScript';
	if (ext.includes('py')) return 'Python';
	if (ext.includes('go')) return 'Go';
	if (ext.includes('rs')) return 'Rust';
	return 'mixed-language';
}
