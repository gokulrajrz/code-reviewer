/**
 * GRACEFUL DEGRADATION SYSTEM
 * 
 * Provides 5 levels of service degradation to maintain availability
 * under adverse conditions (high error rates, budget exhaustion, rate limits).
 * 
 * Based on patterns from:
 * - Netflix Hystrix fallback strategies
 * - AWS throttling and backpressure
 * - Google SRE graceful degradation
 * 
 * Key Features:
 * - 5 degradation levels (full → minimal → disabled)
 * - Automatic level selection based on system health
 * - Manual override per repository
 * - Clear communication to users about degraded service
 */

import { logger } from './logger';
import type { Env } from '../types/env';

/**
 * Degradation levels from full service to disabled.
 */
export enum DegradationLevel {
    /** Full review: all chunks, synthesis, inline comments */
    LEVEL_0_FULL = 0,
    
    /** Reduced chunks: skip low-priority files (tests, configs) */
    LEVEL_1_REDUCED = 1,
    
    /** Fast review: no synthesis, basic findings only */
    LEVEL_2_FAST = 2,
    
    /** Minimal review: critical issues only (security, bugs) */
    LEVEL_3_MINIMAL = 3,
    
    /** Disabled: return cached or empty review */
    LEVEL_4_DISABLED = 4,
}

export interface DegradationConfig {
    /** Current degradation level */
    level: DegradationLevel;
    /** Reason for degradation */
    reason: string;
    /** Automatic recovery enabled */
    autoRecover: boolean;
    /** Time when degradation was triggered */
    triggeredAt: number;
}

export interface SystemHealth {
    /** Error rate (0-1) */
    errorRate: number;
    /** Rate limit utilization (0-1) */
    rateLimitUtilization: number;
    /** Cost budget utilization (0-1) */
    costBudgetUtilization: number;
    /** Container success rate (0-1) */
    containerSuccessRate: number;
}

/**
 * Determine appropriate degradation level based on system health.
 */
export function selectDegradationLevel(health: SystemHealth): DegradationLevel {
    // Level 4: Disabled (critical failure)
    if (health.errorRate > 0.5 || health.costBudgetUtilization >= 1.0) {
        return DegradationLevel.LEVEL_4_DISABLED;
    }

    // Level 3: Minimal (severe degradation)
    if (
        health.errorRate > 0.3 ||
        health.costBudgetUtilization > 0.95 ||
        health.rateLimitUtilization > 0.95
    ) {
        return DegradationLevel.LEVEL_3_MINIMAL;
    }

    // Level 2: Fast (moderate degradation)
    if (
        health.errorRate > 0.15 ||
        health.costBudgetUtilization > 0.85 ||
        health.rateLimitUtilization > 0.85 ||
        health.containerSuccessRate < 0.5
    ) {
        return DegradationLevel.LEVEL_2_FAST;
    }

    // Level 1: Reduced (light degradation)
    if (
        health.errorRate > 0.05 ||
        health.costBudgetUtilization > 0.75 ||
        health.rateLimitUtilization > 0.75 ||
        health.containerSuccessRate < 0.8
    ) {
        return DegradationLevel.LEVEL_1_REDUCED;
    }

    // Level 0: Full service
    return DegradationLevel.LEVEL_0_FULL;
}

/**
 * Get degradation configuration for a repository.
 * Checks for manual overrides in KV.
 */
export async function getDegradationConfig(
    env: Env,
    repoFullName: string,
    health: SystemHealth
): Promise<DegradationConfig> {
    // Check for manual override
    const overrideKey = `degradation:override:${repoFullName}`;
    const override = await env.CACHE_KV.get(overrideKey);

    if (override) {
        const config = JSON.parse(override) as DegradationConfig;
        logger.info('[Degradation] Using manual override', {
            repo: repoFullName,
            level: config.level,
            reason: config.reason,
        });
        return config;
    }

    // Check for global degradation
    const globalKey = 'degradation:global';
    const global = await env.CACHE_KV.get(globalKey);

    if (global) {
        const config = JSON.parse(global) as DegradationConfig;
        logger.info('[Degradation] Using global degradation', {
            level: config.level,
            reason: config.reason,
        });
        return config;
    }

    // Automatic level selection based on health
    const level = selectDegradationLevel(health);

    return {
        level,
        reason: getDegradationReason(level, health),
        autoRecover: true,
        triggeredAt: Date.now(),
    };
}

/**
 * Set manual degradation override for a repository.
 */
export async function setDegradationOverride(
    env: Env,
    repoFullName: string,
    level: DegradationLevel,
    reason: string,
    durationSeconds: number = 3600
): Promise<void> {
    const config: DegradationConfig = {
        level,
        reason,
        autoRecover: false,
        triggeredAt: Date.now(),
    };

    const key = `degradation:override:${repoFullName}`;
    await env.CACHE_KV.put(key, JSON.stringify(config), {
        expirationTtl: durationSeconds,
    });

    logger.warn('[Degradation] Manual override set', {
        repo: repoFullName,
        level,
        reason,
        durationSeconds,
    });
}

/**
 * Set global degradation for all repositories.
 */
export async function setGlobalDegradation(
    env: Env,
    level: DegradationLevel,
    reason: string,
    durationSeconds: number = 3600
): Promise<void> {
    const config: DegradationConfig = {
        level,
        reason,
        autoRecover: false,
        triggeredAt: Date.now(),
    };

    await env.CACHE_KV.put('degradation:global', JSON.stringify(config), {
        expirationTtl: durationSeconds,
    });

    logger.error('[Degradation] Global degradation activated', undefined, {
        level,
        reason,
        durationSeconds,
    });
}

/**
 * Clear degradation override.
 */
export async function clearDegradationOverride(
    env: Env,
    repoFullName?: string
): Promise<void> {
    if (repoFullName) {
        await env.CACHE_KV.delete(`degradation:override:${repoFullName}`);
        logger.info('[Degradation] Override cleared', { repo: repoFullName });
    } else {
        await env.CACHE_KV.delete('degradation:global');
        logger.info('[Degradation] Global degradation cleared');
    }
}

/**
 * Apply degradation level to review configuration.
 */
export function applyDegradation(
    level: DegradationLevel,
    config: {
        maxChunks: number;
        maxFilesPerChunk: number;
        skipSynthesis: boolean;
        skipInlineComments: boolean;
        priorityFilesOnly: boolean;
    }
): typeof config {
    switch (level) {
        case DegradationLevel.LEVEL_0_FULL:
            // No changes - full service
            return config;

        case DegradationLevel.LEVEL_1_REDUCED:
            // Skip low-priority files (tests, configs, docs)
            return {
                ...config,
                maxChunks: Math.ceil(config.maxChunks * 0.7), // 70% of chunks
                priorityFilesOnly: true,
            };

        case DegradationLevel.LEVEL_2_FAST:
            // No synthesis, fewer chunks
            return {
                ...config,
                maxChunks: Math.ceil(config.maxChunks * 0.5), // 50% of chunks
                skipSynthesis: true,
                priorityFilesOnly: true,
            };

        case DegradationLevel.LEVEL_3_MINIMAL:
            // Critical issues only, no inline comments
            return {
                ...config,
                maxChunks: Math.ceil(config.maxChunks * 0.3), // 30% of chunks
                skipSynthesis: true,
                skipInlineComments: true,
                priorityFilesOnly: true,
            };

        case DegradationLevel.LEVEL_4_DISABLED:
            // Return empty/cached review
            return {
                ...config,
                maxChunks: 0,
                skipSynthesis: true,
                skipInlineComments: true,
                priorityFilesOnly: true,
            };
    }
}

/**
 * Get user-facing message for degradation level.
 */
export function getDegradationMessage(config: DegradationConfig): string {
    const levelNames = {
        [DegradationLevel.LEVEL_0_FULL]: 'Full Review',
        [DegradationLevel.LEVEL_1_REDUCED]: 'Reduced Review',
        [DegradationLevel.LEVEL_2_FAST]: 'Fast Review',
        [DegradationLevel.LEVEL_3_MINIMAL]: 'Minimal Review',
        [DegradationLevel.LEVEL_4_DISABLED]: 'Review Disabled',
    };

    const levelDescriptions = {
        [DegradationLevel.LEVEL_0_FULL]: 'All files reviewed with full analysis and synthesis.',
        [DegradationLevel.LEVEL_1_REDUCED]: 'Priority files only (skipping tests, configs, docs).',
        [DegradationLevel.LEVEL_2_FAST]: 'Quick review without synthesis. Basic findings only.',
        [DegradationLevel.LEVEL_3_MINIMAL]: 'Critical issues only (security, bugs). No inline comments.',
        [DegradationLevel.LEVEL_4_DISABLED]: 'Code review temporarily unavailable.',
    };

    const emoji = {
        [DegradationLevel.LEVEL_0_FULL]: '✅',
        [DegradationLevel.LEVEL_1_REDUCED]: '⚠️',
        [DegradationLevel.LEVEL_2_FAST]: '⚠️',
        [DegradationLevel.LEVEL_3_MINIMAL]: '🚨',
        [DegradationLevel.LEVEL_4_DISABLED]: '❌',
    };

    return `${emoji[config.level]} **${levelNames[config.level]}**

${levelDescriptions[config.level]}

**Reason**: ${config.reason}

${config.autoRecover ? '_Service will automatically recover when conditions improve._' : '_Manual intervention required to restore full service._'}`;
}

/**
 * Get reason for automatic degradation.
 */
function getDegradationReason(level: DegradationLevel, health: SystemHealth): string {
    const reasons: string[] = [];

    if (health.errorRate > 0.3) {
        reasons.push(`High error rate (${(health.errorRate * 100).toFixed(0)}%)`);
    }

    if (health.costBudgetUtilization > 0.85) {
        reasons.push(`Cost budget pressure (${(health.costBudgetUtilization * 100).toFixed(0)}%)`);
    }

    if (health.rateLimitUtilization > 0.85) {
        reasons.push(`Rate limit pressure (${(health.rateLimitUtilization * 100).toFixed(0)}%)`);
    }

    if (health.containerSuccessRate < 0.8) {
        reasons.push(`Container instability (${(health.containerSuccessRate * 100).toFixed(0)}% success)`);
    }

    if (reasons.length === 0) {
        return 'System operating normally';
    }

    return reasons.join(', ');
}

/**
 * Check if priority file (should be reviewed even in degraded mode).
 */
export function isPriorityFile(filename: string): boolean {
    const lowPriorityPatterns = [
        /\.test\.(ts|tsx|js|jsx)$/,
        /\.spec\.(ts|tsx|js|jsx)$/,
        /__tests__\//,
        /\.config\.(ts|js|json)$/,
        /\.md$/,
        /\.txt$/,
        /\.yml$/,
        /\.yaml$/,
        /package-lock\.json$/,
        /yarn\.lock$/,
        /pnpm-lock\.yaml$/,
        /\.gitignore$/,
        /\.prettierrc$/,
        /\.eslintrc/,
    ];

    return !lowPriorityPatterns.some(pattern => pattern.test(filename));
}
