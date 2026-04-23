/**
 * ADAPTIVE CONCURRENCY CONTROLLER
 * 
 * Implements AIMD (Additive Increase, Multiplicative Decrease) algorithm
 * to dynamically adjust concurrency based on success/error rates.
 * 
 * Based on patterns from:
 * - AWS SDK Adaptive Retry Mode
 * - Netflix Concurrency Limits
 * - TCP Congestion Control (AIMD)
 * 
 * Key Features:
 * - Automatic concurrency adjustment based on error rates
 * - Gradual increase on success (additive)
 * - Rapid decrease on errors (multiplicative)
 * - Min/max bounds to prevent extremes
 * - Per-provider concurrency tracking
 */

import { logger } from './logger';

export interface AdaptiveConcurrencyConfig {
    /** Initial concurrency level */
    initialConcurrency: number;
    /** Minimum concurrency (never go below) */
    minConcurrency: number;
    /** Maximum concurrency (never go above) */
    maxConcurrency: number;
    /** Additive increase amount on success */
    additiveIncrease: number;
    /** Multiplicative decrease factor on error (0-1) */
    multiplicativeDecrease: number;
    /** Error rate threshold to trigger decrease (0-1) */
    errorThreshold: number;
    /** Time window for error rate calculation (ms) */
    errorWindowMs: number;
}

export interface ConcurrencyMetrics {
    currentConcurrency: number;
    successCount: number;
    errorCount: number;
    errorRate: number;
    totalAdjustments: number;
    lastAdjustmentTime: number;
    lastAdjustmentReason: string;
}

const DEFAULT_CONFIG: AdaptiveConcurrencyConfig = {
    initialConcurrency: 2,
    minConcurrency: 1,
    maxConcurrency: 10,
    additiveIncrease: 1,
    multiplicativeDecrease: 0.5,
    errorThreshold: 0.1, // 10% error rate triggers decrease
    errorWindowMs: 60000, // 1 minute window
};

/**
 * Adaptive concurrency controller using AIMD algorithm.
 * 
 * Algorithm:
 * 1. Start with initial concurrency
 * 2. On success: increase by +1 (additive increase)
 * 3. On error: decrease by *0.5 (multiplicative decrease)
 * 4. Respect min/max bounds
 * 5. Calculate error rate over sliding window
 */
export class AdaptiveConcurrencyController {
    private currentConcurrency: number;
    private successCount = 0;
    private errorCount = 0;
    private totalAdjustments = 0;
    private lastAdjustmentTime = Date.now();
    private lastAdjustmentReason = 'initialization';
    
    // Sliding window for error rate calculation
    private recentResults: Array<{ success: boolean; timestamp: number }> = [];
    
    // Consecutive successes counter to prevent too-aggressive increases
    private consecutiveSuccesses = 0;
    private readonly successesBeforeIncrease = 10;  // Require 10 consecutive successes before increase
    
    constructor(
        private readonly name: string,
        private readonly config: AdaptiveConcurrencyConfig = DEFAULT_CONFIG
    ) {
        this.currentConcurrency = config.initialConcurrency;
        
        logger.info(`[AdaptiveConcurrency] Initialized controller`, {
            name,
            initialConcurrency: this.currentConcurrency,
            minConcurrency: config.minConcurrency,
            maxConcurrency: config.maxConcurrency,
            successesBeforeIncrease: this.successesBeforeIncrease,
        });
    }

    /**
     * Get current concurrency level.
     */
    getConcurrency(): number {
        return Math.floor(this.currentConcurrency);
    }

    /**
     * Record a successful operation.
     * Only triggers additive increase after N consecutive successes.
     */
    recordSuccess(): void {
        this.successCount++;
        this.recentResults.push({ success: true, timestamp: Date.now() });
        this.cleanupOldResults();
        this.consecutiveSuccesses++;

        // Additive increase: only after N consecutive successes
        const errorRate = this.calculateErrorRate();
        
        if (errorRate < this.config.errorThreshold && 
            this.consecutiveSuccesses >= this.successesBeforeIncrease) {
            
            const oldConcurrency = this.currentConcurrency;
            this.currentConcurrency = Math.min(
                this.config.maxConcurrency,
                this.currentConcurrency + this.config.additiveIncrease
            );

            if (this.currentConcurrency !== oldConcurrency) {
                this.consecutiveSuccesses = 0;  // Reset counter after increase
                this.totalAdjustments++;
                this.lastAdjustmentTime = Date.now();
                this.lastAdjustmentReason = 'additive_increase';

                logger.info(`[AdaptiveConcurrency] Increased concurrency`, {
                    name: this.name,
                    oldConcurrency: Math.floor(oldConcurrency),
                    newConcurrency: Math.floor(this.currentConcurrency),
                    errorRate: (errorRate * 100).toFixed(1) + '%',
                    successCount: this.successCount,
                    consecutiveSuccesses: this.successesBeforeIncrease,
                });
            }
        }
    }

    /**
     * Record a failed operation.
     * Triggers multiplicative decrease and resets consecutive success counter.
     */
    recordError(errorType?: string): void {
        this.consecutiveSuccesses = 0;  // Reset on error
        this.errorCount++;
        this.recentResults.push({ success: false, timestamp: Date.now() });
        this.cleanupOldResults();

        const errorRate = this.calculateErrorRate();

        // Multiplicative decrease: rapidly decrease concurrency on errors
        if (errorRate >= this.config.errorThreshold) {
            const oldConcurrency = this.currentConcurrency;
            this.currentConcurrency = Math.max(
                this.config.minConcurrency,
                this.currentConcurrency * this.config.multiplicativeDecrease
            );

            this.totalAdjustments++;
            this.lastAdjustmentTime = Date.now();
            this.lastAdjustmentReason = `multiplicative_decrease:${errorType || 'unknown'}`;

            logger.warn(`[AdaptiveConcurrency] Decreased concurrency`, {
                name: this.name,
                oldConcurrency: Math.floor(oldConcurrency),
                newConcurrency: Math.floor(this.currentConcurrency),
                errorRate: (errorRate * 100).toFixed(1) + '%',
                errorCount: this.errorCount,
                errorType,
            });
        }
    }

    /**
     * Record a timeout (treated as error with immediate decrease).
     */
    recordTimeout(): void {
        this.recordError('timeout');
        
        // Timeouts are especially bad - decrease more aggressively
        const oldConcurrency = this.currentConcurrency;
        this.currentConcurrency = Math.max(
            this.config.minConcurrency,
            this.currentConcurrency * 0.3 // 70% decrease on timeout
        );

        if (this.currentConcurrency !== oldConcurrency) {
            logger.error(`[AdaptiveConcurrency] Aggressive decrease due to timeout`, undefined, {
                name: this.name,
                oldConcurrency: Math.floor(oldConcurrency),
                newConcurrency: Math.floor(this.currentConcurrency),
            });
        }
    }

    /**
     * Get current metrics for monitoring.
     */
    getMetrics(): ConcurrencyMetrics {
        return {
            currentConcurrency: Math.floor(this.currentConcurrency),
            successCount: this.successCount,
            errorCount: this.errorCount,
            errorRate: this.calculateErrorRate(),
            totalAdjustments: this.totalAdjustments,
            lastAdjustmentTime: this.lastAdjustmentTime,
            lastAdjustmentReason: this.lastAdjustmentReason,
        };
    }

    /**
     * Reset metrics (useful for testing or manual intervention).
     */
    reset(): void {
        this.currentConcurrency = this.config.initialConcurrency;
        this.successCount = 0;
        this.errorCount = 0;
        this.totalAdjustments = 0;
        this.recentResults = [];
        this.lastAdjustmentReason = 'manual_reset';

        logger.info(`[AdaptiveConcurrency] Controller reset`, {
            name: this.name,
            concurrency: this.currentConcurrency,
        });
    }

    /**
     * Manually set concurrency (for emergency overrides).
     */
    setConcurrency(value: number): void {
        const oldConcurrency = this.currentConcurrency;
        this.currentConcurrency = Math.max(
            this.config.minConcurrency,
            Math.min(this.config.maxConcurrency, value)
        );

        this.lastAdjustmentReason = 'manual_override';

        logger.warn(`[AdaptiveConcurrency] Manual concurrency override`, {
            name: this.name,
            oldConcurrency: Math.floor(oldConcurrency),
            newConcurrency: Math.floor(this.currentConcurrency),
        });
    }

    /**
     * Calculate error rate over sliding window.
     */
    private calculateErrorRate(): number {
        this.cleanupOldResults();

        if (this.recentResults.length === 0) {
            return 0;
        }

        const errors = this.recentResults.filter(r => !r.success).length;
        return errors / this.recentResults.length;
    }

    /**
     * Remove results outside the time window.
     */
    private cleanupOldResults(): void {
        const cutoff = Date.now() - this.config.errorWindowMs;
        this.recentResults = this.recentResults.filter(r => r.timestamp > cutoff);
    }
}

/**
 * Global adaptive concurrency controllers per operation type.
 */
export const adaptiveConcurrency = {
    chunkReview: new AdaptiveConcurrencyController('chunk-review', {
        initialConcurrency: 2,
        minConcurrency: 1,
        maxConcurrency: 5,
        additiveIncrease: 1,
        multiplicativeDecrease: 0.5,
        errorThreshold: 0.15, // 15% error rate
        errorWindowMs: 60000,
    }),
    
    synthesis: new AdaptiveConcurrencyController('synthesis', {
        initialConcurrency: 1,
        minConcurrency: 1,
        maxConcurrency: 2,
        additiveIncrease: 1,
        multiplicativeDecrease: 0.5,
        errorThreshold: 0.2, // 20% error rate
        errorWindowMs: 60000,
    }),
};

/**
 * Get all concurrency metrics for monitoring dashboard.
 */
export function getAllConcurrencyMetrics(): Record<string, ConcurrencyMetrics> {
    return {
        chunkReview: adaptiveConcurrency.chunkReview.getMetrics(),
        synthesis: adaptiveConcurrency.synthesis.getMetrics(),
    };
}
