/**
 * Evals Runner
 *
 * Runs the multi-agent code reviewer against 5 "Gold Standard" samples
 * and calculates a Precision Score.
 *
 * Precision = TP / (TP + FP)
 *
 * Usage: npx tsx evals/runner.ts
 *
 * Requires API keys set as environment variables:
 *   ANTHROPIC_API_KEY or GEMINI_API_KEY
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { callStructuredLLM } from '../src/lib/llm/structured';
import { SECURITY_AGENT_PROMPT } from '../src/agents/security';
import { PERFORMANCE_AGENT_PROMPT } from '../src/agents/performance';
import { CLEAN_CODE_AGENT_PROMPT } from '../src/agents/clean-code';
import { aggregateFindings } from '../src/agents/aggregator';
import type { Env } from '../src/types/env';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExpectedFinding {
    file: string;
    severity: string;
    category: string;
    issue: string;
}

interface ExpectedSample {
    description: string;
    expectedFindings: ExpectedFinding[];
}

interface EvalResult {
    sample: string;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    details: string[];
}

// ---------------------------------------------------------------------------
// Matching Logic
// ---------------------------------------------------------------------------

/**
 * Determines if a generated finding matches an expected finding.
 * Uses fuzzy matching on file path and issue description keywords.
 */
function isMatch(generated: ExpectedFinding | Record<string, unknown>, expected: ExpectedFinding): boolean {
    const getField = (obj: any, field: string) => String(obj[field] ?? '');

    const genFile = getField(generated, 'file').toLowerCase();
    const expFile = expected.file.toLowerCase();

    // File must match (at least the basename)
    const genBasename = genFile.split('/').pop() ?? '';
    const expBasename = expFile.split('/').pop() ?? '';
    if (genBasename !== expBasename) return false;

    // Category must match
    if (getField(generated, 'category').toLowerCase() !== expected.category.toLowerCase()) return false;

    // Issue must have keyword overlap
    const genIssue = getField(generated, 'issue').toLowerCase();
    const expKeywords = expected.issue.toLowerCase().split(/\s+/);
    const matchingKeywords = expKeywords.filter((kw) => genIssue.includes(kw));
    const keywordOverlap = matchingKeywords.length / expKeywords.length;

    return keywordOverlap >= 0.4; // At least 40% keyword overlap
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runEvals(): Promise<void> {
    console.log('═══════════════════════════════════════════════');
    console.log('  AI Code Reviewer — Evaluation Suite');
    console.log('═══════════════════════════════════════════════\n');

    // Load expected findings
    const expectedPath = join(import.meta.dirname ?? __dirname, 'expected.json');
    const expectedData: Record<string, ExpectedSample> = JSON.parse(readFileSync(expectedPath, 'utf-8'));

    const samplesDir = join(import.meta.dirname ?? __dirname, 'samples');
    const sampleNames = readdirSync(samplesDir).filter((name) => {
        return expectedData[name] !== undefined;
    });

    console.log(`Found ${sampleNames.length} eval sample(s): ${sampleNames.join(', ')}\n`);

    const results: EvalResult[] = [];

    for (const sampleName of sampleNames) {
        const diffPath = join(samplesDir, sampleName, 'diff.md');
        const diff = readFileSync(diffPath, 'utf-8');
        const expected = expectedData[sampleName];

        console.log(`─── Evaluating: ${sampleName} ───`);
        console.log(`  Description: ${expected.description}`);
        console.log(`  Expected findings: ${expected.expectedFindings.length}`);

        let runFindings: ExpectedFinding[] = [];

        if (process.env.RUN_LLM === 'true') {
            const env = {
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
                GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
                AI_PROVIDER: process.env.AI_PROVIDER || 'gemini',
            } as Env;

            const userMessage = `
Please review the following Pull Request.

**PR Title:** Eval Sample - ${sampleName}

## PROJECT CONTEXT
_No project context files found._

## CODE CHANGES
${diff}
`.trim();

            console.log(`  Executing 3 expert agents...`);
            const [secResult, perfResult, cleanResult] = await Promise.all([
                callStructuredLLM(SECURITY_AGENT_PROMPT, userMessage, env),
                callStructuredLLM(PERFORMANCE_AGENT_PROMPT, userMessage, env),
                callStructuredLLM(CLEAN_CODE_AGENT_PROMPT, userMessage, env)
            ]);

            const aggregated = aggregateFindings(
                secResult.output.findings,
                perfResult.output.findings,
                cleanResult.output.findings
            );

            runFindings = aggregated.findings.map(f => ({
                file: f.file,
                severity: f.severity,
                category: f.category,
                issue: f.issue
            }));

            console.log(`  Agent findings: ${runFindings.length}\n`);
        } else {
            console.log(`  ⚠️  LLM execution skipped (scaffold mode). Set RUN_LLM=true to execute.\n`);
        }

        // Calculate precision/recall
        let truePositives = 0;
        let falsePositives = 0;

        for (const gen of runFindings) {
            const isMatched = expected.expectedFindings.some(exp => isMatch(gen, exp));
            if (isMatched) {
                truePositives++;
            } else {
                falsePositives++;
            }
        }

        let falseNegatives = 0;
        for (const exp of expected.expectedFindings) {
            const isMatched = runFindings.some(gen => isMatch(gen, exp));
            if (!isMatched) {
                falseNegatives++;
            }
        }

        const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
        const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;

        results.push({
            sample: sampleName,
            truePositives,
            falsePositives,
            falseNegatives,
            precision,
            recall,
            details: process.env.RUN_LLM === 'true' ? runFindings.map(f => `[${f.severity}] ${f.file}: ${f.issue}`) : ['Scaffold mode'],
        });
    }

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════════');
    console.log('  RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════\n');

    let totalTP = 0;
    let totalFP = 0;
    let totalFN = 0;

    for (const r of results) {
        totalTP += r.truePositives;
        totalFP += r.falsePositives;
        totalFN += r.falseNegatives;

        console.log(`  ${r.sample}:`);
        console.log(`    TP=${r.truePositives} FP=${r.falsePositives} FN=${r.falseNegatives}`);
        console.log(`    Precision=${r.precision.toFixed(2)} Recall=${r.recall.toFixed(2)}`);
    }

    const overallPrecision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0;
    const overallRecall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0;

    console.log(`\n  ════════════════════════════════`);
    console.log(`  Overall Precision: ${overallPrecision.toFixed(2)}`);
    console.log(`  Overall Recall:    ${overallRecall.toFixed(2)}`);
    console.log(`  Goal: Precision > 0.90`);
    console.log(`  ════════════════════════════════\n`);
}

runEvals().catch(console.error);
