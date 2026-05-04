/**
 * SIMPLIFIED SERVICE LEVELS
 * 
 * Replaces 5-level degradation with simpler 3-level system.
 * Follows YAGNI principle - You Aren't Gonna Need It.
 * 
 * Based on patterns from:
 * - Netflix Hystrix (simple fallbacks)
 * - AWS throttling (on/off/degraded)
 * - Google SRE (simple is better)
 * 
 * Key Features:
 * - 3 levels: FULL, DEGRADED, DISABLED
 * - Simple thresholds
 * - Easy to understand and test
 * - Clear user messaging
 */

import { logger } from './logger';
import type { Env } from '../types/env';

/**
 * Service levels from full to disabled.
 */
export enum ServiceLevel {
    /** Full review: all chunks, synthesis, inline comments */
    FULL = 'full',
    
    /** Degraded review: reduced chunks, no synthesis */
    DEGRADED = 'degraded',
    
    /** Disabled: return error or cached review */
    DISABLED = 'disabled',
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

export interface ServiceLevelConfig {
    /** Current service level */
    level: ServiceLevel;
    /** Reason for degradation */
    reason: string;
    /** Automatic recovery enabled */
    autoRecover: boolean;
    /** Time when degradation was triggered */
    triggeredAt: number;
}

/**
 * Determine appropriate service level based on system health.
 * Simple thresholds - easy to understand and tune.
 */
export function selectServiceLevel(health: SystemHealth): ServiceLevel {
    // DISABLED: Critical failure
    if (health.errorRate > 0.5 || health.costBudgetUtilization >= 1.0) {
        return ServiceLevel.DISABLED;
    }

    // DEGRADED: Moderate issues
    if (
        health.errorRate > 0.2 ||
        health.costBudgetUtilization > 0.9 ||
        health.rateLimitUtilization > 0.9 ||
        health.containerSuccessRate < 0.5
    ) {
        return ServiceLevel.DEGRADED;
    }

    // FULL: Everything working
    return ServiceLevel.FULL;
}

/**
 * Get service level configuration for a repository.
 * Checks for manual overrides in KV.
 */
export async function getServiceLevelConfig(
    env: Env,
    repoFullName: string,
    health: SystemHealth
): Promise<ServiceLevelConfig> {
    // Check for manual override
    const overrideKey = `service-level:override:${repoFullName}`;
    const override = await env.CACHE_KV.get(overrideKey);

    if (override) {
        const config = JSON.parse(override) as ServiceLevelConfig;
        logger.info('[ServiceLevel] Using manual override', {
            repo: repoFullName,
            level: config.level,
            reason: config.reason,
        });
        return config;
    }

    // Check for global override
    const globalKey = 'service-level:global';
    const global = await env.CACHE_KV.get(globalKey);

    if (global) {
        const config = JSON.parse(global) as ServiceLevelConfig;
        logger.info('[ServiceLevel] Using global override', {
            level: config.level,
            reason: config.reason,
        });
        return config;
    }

    // Automatic level selection based on health
    const level = selectServiceLevel(health);

    return {
        level,
        reason: getServiceLevelReason(level, health),
        autoRecover: true,
        triggeredAt: Date.now(),
    };
}

/**
 * Set manual service level override for a repository.
 */
export async function setServiceLevelOverride(
    env: Env,
    repoFullName: string,
    level: ServiceLevel,
    reason: string,
    durationSeconds: number = 3600
): Promise<void> {
    const config: ServiceLevelConfig = {
        level,
        reason,
        autoRecover: false,
        triggeredAt: Date.now(),
    };

    const key = `service-level:override:${repoFullName}`;
    await env.CACHE_KV.put(key, JSON.stringify(config), {
        expirationTtl: durationSeconds,
    });

    logger.warn('[ServiceLevel] Manual override set', {
        repo: repoFullName,
        level,
        reason,
        durationSeconds,
    });
}

/**
 * Set global service level for all repositories.
 */
export async function setGlobalServiceLevel(
    env: Env,
    level: ServiceLevel,
    reason: string,
    durationSeconds: number = 3600
): Promise<void> {
    const config: ServiceLevelConfig = {
        level,
        reason,
        autoRecover: false,
        triggeredAt: Date.now(),
    };

    await env.CACHE_KV.put('service-level:global', JSON.stringify(config), {
        expirationTtl: durationSeconds,
    });

    logger.error('[ServiceLevel] Global service level set', undefined, {
        level,
        reason,
        durationSeconds,
    });
}

/**
 * Clear service level override.
 */
export async function clearServiceLevelOverride(
    env: Env,
    repoFullName?: string
): Promise<void> {
    if (repoFullName) {
        await env.CACHE_KV.delete(`service-level:override:${repoFullName}`);
        logger.info('[ServiceLevel] Override cleared', { repo: repoFullName });
    } else {
        await env.CACHE_KV.delete('service-level:global');
        logger.info('[ServiceLevel] Global override cleared');
    }
}

/**
 * Apply service level to review configuration.
 */
export function applyServiceLevel(
    level: ServiceLevel,
    config: {
        maxChunks: number;
        skipSynthesis: boolean;
        skipInlineComments: boolean;
    }
): typeof config {
    switch (level) {
        case ServiceLevel.FULL:
            // No changes - full service
            return config;

        case ServiceLevel.DEGRADED:
            // Reduce chunks, skip synthesis
            return {
                ...config,
                maxChunks: Math.ceil(config.maxChunks * 0.5), // 50% of chunks
                skipSynthesis: true,
            };

        case ServiceLevel.DISABLED:
            // Return empty/cached review
            return {
                ...config,
                maxChunks: 0,
                skipSynthesis: true,
                skipInlineComments: true,
            };
    }
}

/**
 * Get user-facing message for service level.
 */
export function getServiceLevelMessage(config: ServiceLevelConfig): string {
    const levelNames = {
        [ServiceLevel.FULL]: 'Full Review',
        [ServiceLevel.DEGRADED]: 'Degraded Review',
        [ServiceLevel.DISABLED]: 'Review Disabled',
    };

    const levelDescriptions = {
        [ServiceLevel.FULL]: 'All files reviewed with full analysis and synthesis.',
        [ServiceLevel.DEGRADED]: 'Quick review with reduced chunks. No synthesis.',
        [ServiceLevel.DISABLED]: 'Code review temporarily unavailable.',
    };

    const emoji = {
        [ServiceLevel.FULL]: '✅',
        [ServiceLevel.DEGRADED]: '⚠️',
        [ServiceLevel.DISABLED]: '❌',
    };

    return `${emoji[config.level]} **${levelNames[config.level]}**

${levelDescriptions[config.level]}

**Reason**: ${config.reason}

${config.autoRecover ? '_Service will automatically recover when conditions improve._' : '_Manual intervention required to restore full service._'}`;
}

/**
 * Get reason for automatic service level selection.
 */
function getServiceLevelReason(level: ServiceLevel, health: SystemHealth): string {
    const reasons: string[] = [];

    if (health.errorRate > 0.2) {
        reasons.push(`High error rate (${(health.errorRate * 100).toFixed(0)}%)`);
    }

    if (health.costBudgetUtilization > 0.9) {
        reasons.push(`Cost budget pressure (${(health.costBudgetUtilization * 100).toFixed(0)}%)`);
    }

    if (health.rateLimitUtilization > 0.9) {
        reasons.push(`Rate limit pressure (${(health.rateLimitUtilization * 100).toFixed(0)}%)`);
    }

    if (health.containerSuccessRate < 0.5) {
        reasons.push(`Container instability (${(health.containerSuccessRate * 100).toFixed(0)}% success)`);
    }

    if (reasons.length === 0) {
        return 'System operating normally';
    }

    return reasons.join(', ');
}
