import type { AnalyzerPlugin, AnalysisContext, AnalysisResult } from '../plugin-system';
import type { ReviewFinding } from '../../types/review';

/**
 * Secret Scanner Plugin
 * 
 * Performs fast, deterministic regex-based scanning for hardcoded secrets,
 * API keys, and tokens *before* the LLM reviews the code.
 */
export class SecretScannerPlugin implements AnalyzerPlugin {
    id = 'core-secret-scanner';
    name = 'Secret Scanner';
    description = 'Detects hardcoded secrets, API keys, and tokens';
    fileExtensions = []; // Runs on all files

    private readonly secretPatterns: Array<{ name: string; regex: RegExp }> = [
        // AWS
        { name: 'AWS Access Key ID', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g },
        // Generic secrets and tokens
        { name: 'Generic Secret Key', regex: /(?:secret|api[_]?key|access[_]?token|password|passwd|pwd)\s*(?:=|:)\s*['"]([a-zA-Z0-9_\-]{16,})['"]/gi },
        // GitHub Personal Access Token
        { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g },
    ];

    async analyze(context: AnalysisContext): Promise<AnalysisResult> {
        const startTime = Date.now();
        const findings: ReviewFinding[] = [];

        let match;
        const lines = context.content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            for (const pattern of this.secretPatterns) {
                // Reset regex state since we use 'g' flag
                pattern.regex.lastIndex = 0;

                while ((match = pattern.regex.exec(line)) !== null) {
                    const lineNumber = i + 1;

                    // Diff-aware: skip secrets on lines NOT in the diff
                    if (context.diffLines && context.diffLines.size > 0 && !context.diffLines.has(lineNumber)) {
                        continue;
                    }

                    findings.push({
                        file: context.filename,
                        line: lineNumber,
                        severity: 'critical',
                        category: 'security',
                        title: `Hardcoded Secret: ${pattern.name}`,
                        issue: `Detected a potential hardcoded ${pattern.name}. Secrets must never be committed to source control. Please use environment variables or a secret manager.`,
                        currentCode: line.trim(),
                        suggestedCode: `// Remove the hardcoded secret and load it dynamically (e.g., process.env.SECRET_VAR)`,
                    });
                }
            }
        }

        return {
            findings,
            metrics: {
                linesAnalyzed: lines.length,
                timeMs: Date.now() - startTime,
            }
        };
    }
}
