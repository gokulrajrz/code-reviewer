/**
 * Structured Output LLM Wrapper
 *
 * Enforces Zod-validated JSON output from Claude and Gemini.
 * Implements a self-correction loop: if the LLM returns malformed JSON,
 * it retries with a correction prompt up to MAX_RETRIES.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { AgentReviewOutputSchema, type AgentReviewOutput, type TelemetryData } from '../../types/review';
import { MODELS } from '../../config/constants';
import type { AIProvider, Env } from '../../types/env';

const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// JSON Extraction Helper
// ---------------------------------------------------------------------------

/**
 * Extracts JSON from a raw LLM response.
 * Handles cases where the LLM wraps JSON in markdown code fences.
 */
function extractJSON(raw: string): string {
    // Try to find JSON in a code fence
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Try to find a raw JSON object
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0].trim();

    return raw.trim();
}

// ---------------------------------------------------------------------------
// Self-Correction Prompt
// ---------------------------------------------------------------------------

function buildCorrectionPrompt(malformedOutput: string, error: string): string {
    return `
Your previous response was not valid JSON. Here is the error:
${error}

Here is your malformed output:
\`\`\`
${malformedOutput.slice(0, 3000)}
\`\`\`

Please fix the JSON and return a VALID JSON object matching this exact schema:
{
  "findings": [{ "file": "string", "severity": "Low|Medium|High|Critical", "category": "string", "issue": "string", "currentCode": "string", "suggestedCode": "string" }],
  "summary": "string",
  "verdict": "Approve|RequestChanges|NeedsDiscussion"
}

Return ONLY the corrected JSON, no other text.
`.trim();
}

async function callClaude(
    systemPrompt: string,
    userMessage: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
        model: MODELS.claude,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [
            {
                name: 'record_review_findings',
                description: 'Record the structured findings of the code review. You must use this tool.',
                input_schema: {
                    type: 'object',
                    properties: {
                        findings: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    file: { type: 'string' },
                                    line: { type: 'number' },
                                    severity: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
                                    category: { type: 'string', enum: ['Security', 'Performance', 'Maintainability', 'Style', 'HumanReviewNeeded'] },
                                    issue: { type: 'string' },
                                    currentCode: { type: 'string' },
                                    suggestedCode: { type: 'string' }
                                },
                                required: ['file', 'severity', 'category', 'issue', 'currentCode', 'suggestedCode']
                            }
                        },
                        summary: { type: 'string' },
                        verdict: { type: 'string', enum: ['Approve', 'RequestChanges', 'NeedsDiscussion'] }
                    },
                    required: ['findings', 'summary', 'verdict']
                }
            }
        ],
        tool_choice: { type: 'tool', name: 'record_review_findings' }
    }, { signal });

    const toolBlock = message.content.find((block) => block.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
        throw new Error('[llm] Claude did not return the requested tool call');
    }

    return {
        text: JSON.stringify(toolBlock.input),
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Gemini Structured Call
// ---------------------------------------------------------------------------

async function callGemini(
    systemPrompt: string,
    userMessage: string,
    apiKey: string,
    signal?: AbortSignal
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
        model: MODELS.gemini,
        systemInstruction: systemPrompt,
        generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: {
                type: SchemaType.OBJECT,
                properties: {
                    findings: {
                        type: SchemaType.ARRAY,
                        items: {
                            type: SchemaType.OBJECT,
                            properties: {
                                file: { type: SchemaType.STRING },
                                line: { type: SchemaType.NUMBER },
                                severity: { type: SchemaType.STRING, format: 'enum', enum: ['Low', 'Medium', 'High', 'Critical'] },
                                category: { type: SchemaType.STRING, format: 'enum', enum: ['Security', 'Performance', 'Maintainability', 'Style', 'HumanReviewNeeded'] },
                                issue: { type: SchemaType.STRING },
                                currentCode: { type: SchemaType.STRING },
                                suggestedCode: { type: SchemaType.STRING },
                            },
                            required: ['file', 'severity', 'category', 'issue', 'currentCode', 'suggestedCode'],
                        },
                    },
                    summary: { type: SchemaType.STRING },
                    verdict: { type: SchemaType.STRING, format: 'enum', enum: ['Approve', 'RequestChanges', 'NeedsDiscussion'] },
                },
                required: ['findings', 'summary', 'verdict'],
            },
        },
    });

    const result = await model.generateContent(userMessage, { signal });
    const response = result.response;
    const text = response.text();

    // Extract token usage from Gemini response metadata
    const usageMetadata = response.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;

    if (!text) {
        throw new Error('[llm] Gemini returned an empty response');
    }

    return { text, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Unified Structured LLM Call
// ---------------------------------------------------------------------------

export interface StructuredLLMResult {
    output: AgentReviewOutput;
    telemetry: TelemetryData;
}

/**
 * Calls the LLM with a specific persona prompt and returns Zod-validated structured output.
 * Implements self-correction: if JSON parsing/validation fails, retries with a correction prompt.
 */
export async function callStructuredLLM(
    systemPrompt: string,
    userMessage: string,
    env: Env,
    signal?: AbortSignal
): Promise<StructuredLLMResult> {
    const provider: AIProvider = (env.AI_PROVIDER ?? 'claude') as AIProvider;
    const apiKey = provider === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;

    if (!apiKey?.trim()) {
        throw new Error(`[llm] ${provider.toUpperCase()} API key is missing or empty`);
    }

    const callFn = provider === 'gemini' ? callGemini : callClaude;
    const startTime = performance.now();

    let lastError = '';
    let lastRawText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let retryCount = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const currentMessage = attempt === 0
            ? userMessage
            : buildCorrectionPrompt(lastRawText, lastError);

        try {
            const response = await callFn(systemPrompt, currentMessage, apiKey, signal);
            totalInputTokens += response.inputTokens;
            totalOutputTokens += response.outputTokens;

            const jsonText = extractJSON(response.text);
            const parsed = JSON.parse(jsonText);
            const validated = AgentReviewOutputSchema.parse(parsed);

            const latencyMs = performance.now() - startTime;

            return {
                output: validated,
                telemetry: {
                    provider,
                    model: MODELS[provider],
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                    latencyMs,
                    success: true,
                    retryCount,
                },
            };
        } catch (error) {
            retryCount++;
            lastError = error instanceof Error ? error.message : String(error);
            lastRawText = lastRawText || 'Unable to capture raw output';

            console.error(`[llm] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`);

            if (attempt === MAX_RETRIES) {
                const latencyMs = performance.now() - startTime;
                return {
                    output: {
                        findings: [],
                        summary: `LLM failed to produce valid output after ${MAX_RETRIES + 1} attempts. Error: ${lastError}`,
                        verdict: 'NeedsDiscussion',
                    },
                    telemetry: {
                        provider,
                        model: MODELS[provider],
                        inputTokens: totalInputTokens,
                        outputTokens: totalOutputTokens,
                        latencyMs,
                        success: false,
                        retryCount,
                        error: lastError,
                    },
                };
            }
        }
    }

    // TypeScript requires this, but it's unreachable
    throw new Error('[llm] Unreachable');
}
