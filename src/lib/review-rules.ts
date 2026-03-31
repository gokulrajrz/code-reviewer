/**
 * Custom Review Rules and Prompts System
 * 
 * Allows repositories to define custom review rules, severity configurations,
 * and prompt templates that override the defaults.
 */

/** Canonical ReviewType definition — re-exported for use across the codebase */
export type ReviewType = 'general' | 'security' | 'performance' | 'style' | 'accessibility';

export interface ReviewRule {
    id: string;
    name: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    enabled: boolean;
    patterns?: string[]; // Regex patterns to match
    fileExtensions?: string[]; // Which file types this applies to
    customPrompt?: string; // Custom prompt for this rule
}

export interface ReviewConfig {
    version: string;
    reviewTypes: ReviewType[];
    globalRules: ReviewRule[];
    severityOverrides: Record<string, 'critical' | 'high' | 'medium' | 'low'>;
    excludePatterns: string[];
    includePatterns: string[];
    maxFindingsPerFile: number;
    maxFindingsTotal: number;
    customPrompts: Partial<Record<ReviewType, string>>;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
    version: '1.0.0',
    reviewTypes: ['general'],
    globalRules: [],
    severityOverrides: {},
    excludePatterns: [],
    includePatterns: [],
    maxFindingsPerFile: 10,
    maxFindingsTotal: 50,
    customPrompts: {},
};

// Predefined rule sets for different review types
export const PREDEFINED_RULES: Record<ReviewType, ReviewRule[]> = {
    general: [
        {
            id: 'security-hardcoded-secrets',
            name: 'Hardcoded Secrets',
            description: 'Detects hardcoded API keys, passwords, tokens in code',
            severity: 'critical',
            enabled: true,
            patterns: [
                '(password|passwd|pwd)\\s*=\\s*["\'][^"\']+["\']',
                '(api[_-]?key|apikey)\\s*=\\s*["\'][^"\']+["\']',
                '(secret[_-]?key|secretkey)\\s*=\\s*["\'][^"\']+["\']',
                '(token|access[_-]?token)\\s*=\\s*["\'][^"\']+["\']',
            ],
        },
        {
            id: 'code-complexity',
            name: 'High Cyclomatic Complexity',
            description: 'Functions with excessive branching logic',
            severity: 'medium',
            enabled: true,
        },
        {
            id: 'error-handling',
            name: 'Missing Error Handling',
            description: 'Async operations without try/catch',
            severity: 'high',
            enabled: true,
        },
    ],
    security: [
        {
            id: 'sql-injection',
            name: 'SQL Injection Risk',
            description: 'String concatenation in SQL queries',
            severity: 'critical',
            enabled: true,
            patterns: [
                'query\\s*\\+\\s*',
                'exec\\s*\\(\\s*["\'].*\\$\\{',
            ],
        },
        {
            id: 'xss-risk',
            name: 'XSS Vulnerability',
            description: 'Unescaped user input in HTML/DOM',
            severity: 'critical',
            enabled: true,
        },
        {
            id: 'insecure-dependencies',
            name: 'Insecure Dependencies',
            description: 'Known vulnerable package versions',
            severity: 'high',
            enabled: true,
        },
    ],
    performance: [
        {
            id: 'n-plus-one',
            name: 'N+1 Query Problem',
            description: 'Database queries inside loops',
            severity: 'high',
            enabled: true,
        },
        {
            id: 'memory-leak',
            name: 'Potential Memory Leak',
            description: 'Event listeners not cleaned up',
            severity: 'medium',
            enabled: true,
        },
        {
            id: 'inefficient-loop',
            name: 'Inefficient Loop',
            description: 'Repeated calculations in loops',
            severity: 'low',
            enabled: true,
        },
    ],
    style: [
        {
            id: 'naming-convention',
            name: 'Naming Convention',
            description: 'Variables not following team conventions',
            severity: 'low',
            enabled: true,
        },
        {
            id: 'magic-numbers',
            name: 'Magic Numbers',
            description: 'Unnamed numeric constants',
            severity: 'low',
            enabled: true,
        },
        {
            id: 'commented-code',
            name: 'Commented Code',
            description: 'Dead code left in comments',
            severity: 'low',
            enabled: true,
        },
    ],
    accessibility: [
        {
            id: 'missing-alt',
            name: 'Missing Alt Text',
            description: 'Images without alt attributes',
            severity: 'medium',
            enabled: true,
        },
        {
            id: 'low-contrast',
            name: 'Low Color Contrast',
            description: 'Text may not meet WCAG contrast standards',
            severity: 'medium',
            enabled: true,
        },
        {
            id: 'missing-labels',
            name: 'Missing Form Labels',
            description: 'Form inputs without associated labels',
            severity: 'high',
            enabled: true,
        },
    ],
};

// Custom prompts for different review types
export const CUSTOM_PROMPTS: Record<ReviewType, string> = {
    general: `You are a senior software engineer conducting a code review.
Focus on: bugs, security issues, performance problems, and maintainability.
Be specific and actionable in your feedback.`,

    security: `You are a security engineer performing a security audit.
Focus on: injection vulnerabilities, authentication issues, data exposure, 
 cryptographic weaknesses, and OWASP Top 10.
Flag any potential security risk with specific CVE references where applicable.`,

    performance: `You are a performance engineer analyzing code efficiency.
Focus on: algorithmic complexity, database query optimization, 
 memory usage, caching opportunities, and async patterns.
Provide specific performance metrics where possible.`,

    style: `You are enforcing team coding standards and style guidelines.
Focus on: naming conventions, code organization, documentation,
 test coverage, and consistency with existing codebase.
Reference specific style guide rules.`,

    accessibility: `You are an a11y specialist reviewing for accessibility compliance.
Focus on: WCAG 2.1 AA compliance, screen reader compatibility,
 keyboard navigation, color contrast, and semantic HTML.
Reference specific WCAG success criteria.`,
};

/**
 * Load review configuration from various sources.
 * Priority: 1) Repo config file, 2) Environment variable, 3) Defaults
 */
export async function loadReviewConfig(
    repoFullName: string,
    getConfigFn?: (key: string) => Promise<string | null>
): Promise<ReviewConfig> {
    const config: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG };

    // Try to load from KV/storage if function provided
    if (getConfigFn) {
        try {
            const stored = await getConfigFn(`review-config:${repoFullName}`);
            if (stored) {
                const parsed = JSON.parse(stored) as Partial<ReviewConfig>;
                return mergeConfig(config, parsed);
            }
        } catch {
            // Fall through to defaults
        }
    }

    return config;
}

/**
 * Merge partial config with defaults.
 */
function mergeConfig(base: ReviewConfig, override: Partial<ReviewConfig>): ReviewConfig {
    return {
        ...base,
        ...override,
        // Deep merge arrays
        reviewTypes: override.reviewTypes ?? base.reviewTypes,
        globalRules: [...base.globalRules, ...(override.globalRules ?? [])],
        excludePatterns: [...base.excludePatterns, ...(override.excludePatterns ?? [])],
        includePatterns: override.includePatterns?.length
            ? override.includePatterns
            : base.includePatterns,
        severityOverrides: { ...base.severityOverrides, ...override.severityOverrides },
        customPrompts: { ...base.customPrompts, ...override.customPrompts },
    };
}

/**
 * Build a custom system prompt based on review configuration.
 */
export function buildCustomPrompt(config: ReviewConfig): string {
    const parts: string[] = [];

    // Base prompt from review types
    for (const reviewType of config.reviewTypes) {
        if (CUSTOM_PROMPTS[reviewType]) {
            parts.push(CUSTOM_PROMPTS[reviewType]);
        }
    }

    // Add custom prompts
    for (const [type, prompt] of Object.entries(config.customPrompts)) {
        if (prompt && !parts.includes(prompt)) {
            parts.push(`\nAdditional ${type} focus:\n${prompt}`);
        }
    }

    // Add rule instructions
    const enabledRules = config.globalRules.filter(r => r.enabled);
    if (enabledRules.length > 0) {
        parts.push('\n\nSpecific rules to enforce:\n' +
            enabledRules.map(r => `- ${r.name} (${r.severity}): ${r.description}`).join('\n')
        );
    }

    // Add constraints
    parts.push(`\n\nConstraints:\n` +
        `- Maximum ${config.maxFindingsPerFile} findings per file\n` +
        `- Maximum ${config.maxFindingsTotal} total findings\n` +
        (config.excludePatterns.length > 0
            ? `- Exclude: ${config.excludePatterns.join(', ')}\n`
            : '')
    );

    return parts.join('\n\n---\n\n');
}

/**
 * Validate a review configuration.
 */
export function validateReviewConfig(config: unknown): config is ReviewConfig {
    if (!config || typeof config !== 'object') return false;

    const c = config as Partial<ReviewConfig>;

    // Required fields
    if (!c.version || typeof c.version !== 'string') return false;
    if (!Array.isArray(c.reviewTypes)) return false;

    // Validate review types
    const validTypes: ReviewType[] = ['general', 'security', 'performance', 'style', 'accessibility'];
    for (const type of c.reviewTypes) {
        if (!validTypes.includes(type as ReviewType)) return false;
    }

    return true;
}
