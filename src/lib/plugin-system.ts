/**
 * Plugin System for Custom Analyzers
 * 
 * Allows extending the code reviewer with custom analysis plugins
 * that can inspect code and report findings.
 */

import type { ReviewFinding } from '../types/review';
import { logger } from './logger';

export interface AnalysisContext {
    filename: string;
    content: string;
    prTitle: string;
    repoFullName: string;
    prNumber: number;
}

export interface AnalysisResult {
    findings: ReviewFinding[];
    metrics?: {
        linesAnalyzed: number;
        complexityScore?: number;
        timeMs: number;
    };
}

/**
 * Base interface for all analyzer plugins.
 */
export interface AnalyzerPlugin {
    /** Unique identifier for this analyzer */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what this analyzer does */
    description: string;
    /** File extensions this analyzer handles (empty = all) */
    fileExtensions: string[];
    /** Analyze a single file and return findings */
    analyze(context: AnalysisContext): Promise<AnalysisResult>;
}

/**
 * Plugin registry for managing analyzer plugins.
 */
export class PluginRegistry {
    private plugins = new Map<string, AnalyzerPlugin>();

    /**
     * Register a new analyzer plugin.
     */
    register(plugin: AnalyzerPlugin): void {
        if (this.plugins.has(plugin.id)) {
            throw new Error(`Plugin ${plugin.id} is already registered`);
        }
        this.plugins.set(plugin.id, plugin);
    }

    /**
     * Unregister a plugin.
     */
    unregister(pluginId: string): boolean {
        return this.plugins.delete(pluginId);
    }

    /**
     * Get a plugin by ID.
     */
    get(pluginId: string): AnalyzerPlugin | undefined {
        return this.plugins.get(pluginId);
    }

    /**
     * Get all registered plugins.
     */
    getAll(): AnalyzerPlugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * Find plugins that can handle a specific file.
     */
    findPluginsForFile(filename: string): AnalyzerPlugin[] {
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        return this.getAll().filter(p =>
            p.fileExtensions.length === 0 || p.fileExtensions.includes(ext)
        );
    }

    /**
     * Run all applicable analyzers on a file.
     */
    async analyzeFile(context: AnalysisContext): Promise<AnalysisResult> {
        const plugins = this.findPluginsForFile(context.filename);
        const allFindings: ReviewFinding[] = [];
        let totalLines = 0;
        let totalTime = 0;

        for (const plugin of plugins) {
            const startTime = Date.now();
            try {
                const result = await plugin.analyze(context);
                allFindings.push(...result.findings);
                if (result.metrics) {
                    totalLines += result.metrics.linesAnalyzed;
                    totalTime += result.metrics.timeMs;
                }
            } catch (error) {
                // Log but don't fail - other plugins should still run
                logger.error(`Plugin ${plugin.id} failed`, error instanceof Error ? error : undefined);
            }
        }

        return {
            findings: allFindings,
            metrics: {
                linesAnalyzed: totalLines,
                timeMs: totalTime,
            },
        };
    }
}

// Global plugin registry instance
export const pluginRegistry = new PluginRegistry();

/**
 * Example: Security Analyzer Plugin
 * Demonstrates how to create a custom analyzer.
 */
export class SecurityAnalyzerPlugin implements AnalyzerPlugin {
    id = 'builtin-security';
    name = 'Security Analyzer';
    description = 'Detects common security vulnerabilities';
    fileExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go'];

    async analyze(context: AnalysisContext): Promise<AnalysisResult> {
        const findings: ReviewFinding[] = [];
        const startTime = Date.now();

        // Simple regex-based security checks
        const securityPatterns = [
            {
                pattern: /eval\s*\(/,
                title: 'Dangerous eval() usage',
                severity: 'critical' as const,
            },
            {
                pattern: /innerHTML\s*=\s*[^;]+/,
                title: 'Potential XSS via innerHTML',
                severity: 'critical' as const,
            },
            {
                pattern: /document\.write\s*\(/,
                title: 'Dangerous document.write()',
                severity: 'high' as const,
            },
        ];

        for (const { pattern, title, severity } of securityPatterns) {
            if (pattern.test(context.content)) {
                findings.push({
                    file: context.filename,
                    line: this.findLineNumber(context.content, pattern),
                    title,
                    severity,
                    issue: `${title} detected in ${context.filename}`,
                    currentCode: this.extractCodeSnippet(context.content, pattern),
                    category: 'security',
                });
            }
        }

        return {
            findings,
            metrics: {
                linesAnalyzed: context.content.split('\n').length,
                timeMs: Date.now() - startTime,
            },
        };
    }

    private findLineNumber(content: string, pattern: RegExp): number {
        const match = pattern.exec(content);
        if (!match) return 0;
        return content.slice(0, match.index).split('\n').length;
    }

    private extractCodeSnippet(content: string, pattern: RegExp): string {
        const match = pattern.exec(content);
        if (!match) return '';
        // Extract line containing the match
        const lines = content.split('\n');
        const lineNum = this.findLineNumber(content, pattern);
        return lines[lineNum - 1] || '';
    }
}

/**
 * Example: Import/Dependency Analyzer
 */
export class DependencyAnalyzerPlugin implements AnalyzerPlugin {
    id = 'builtin-dependencies';
    name = 'Dependency Analyzer';
    description = 'Analyzes imports and dependencies';
    fileExtensions = ['.js', '.ts', '.jsx', '.tsx'];

    async analyze(context: AnalysisContext): Promise<AnalysisResult> {
        const findings: ReviewFinding[] = [];
        const startTime = Date.now();

        // Check for circular imports (simplified)
        const importMatches = context.content.matchAll(/import\s+.*\s+from\s+['"]([^'"]+)['"];?/g);
        const imports = Array.from(importMatches).map(m => m[1]);

        // Check for deep relative imports (../../../)
        const deepImports = imports.filter(i => i.startsWith('..') && i.split('/').length > 3);
        if (deepImports.length > 0) {
            findings.push({
                file: context.filename,
                line: 1,
                title: 'Deep relative imports detected',
                severity: 'low',
                issue: `Found ${deepImports.length} deep relative imports`,
                category: 'clean-code',
            });
        }

        return {
            findings,
            metrics: {
                linesAnalyzed: context.content.split('\n').length,
                timeMs: Date.now() - startTime,
            },
        };
    }
}

// Register built-in plugins
import { SecretScannerPlugin } from './plugins/secret-scanner.plugin';

pluginRegistry.register(new SecurityAnalyzerPlugin());
pluginRegistry.register(new DependencyAnalyzerPlugin());
pluginRegistry.register(new SecretScannerPlugin());
