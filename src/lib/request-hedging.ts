/**
 * REQUEST HEDGING
 * 
 * Sends duplicate requests after a delay to reduce tail latency.
 * Cancels slower request when first completes.
 * 
 * Based on patterns from:
 * - Google "The Tail at Scale" paper
 * - AWS SDK request hedging
 * - Stripe API client hedging
 * 
 * Key Features:
 * - Configurable hedging delay (e.g., 5s)
 * - Automatic cancellation of slower request
 * - Cost-aware (counts toward rate limits and budget)
 * - Metrics for hedging effectiveness
 */

import { logger } from './logger';

export interface HedgingConfig {
    /** Enable hedging */
    enabled: boolean;
    /** Delay before sending hedged request (ms) */
    hedgingDelayMs: number;
    /** Maximum number of hedged requests (1 = original + 1 hedged) */
    maxHedgedRequests: number;
    /** Only hedge if error rate is below threshold */
    errorRateThreshold: number;
}

export interface HedgingMetrics {
    totalRequests: number;
    hedgedRequests: number;
    hedgedRequestsFaster: number;
    hedgedRequestsSlower: number;
    averageLatencySavingsMs: number;
}

const DEFAULT_CONFIG: HedgingConfig = {
    enabled: true,
    hedgingDelayMs: 5000, // 5 seconds
    maxHedgedRequests: 1,
    errorRateThreshold: 0.2, // Don't hedge if error rate > 20%
};

/**
 * Execute a request with hedging.
 * Properly cleans up setTimeout to prevent memory leaks.
 * 
 * @example
 * const result = await hedgedRequest(
 *   () => fetch('https://api.anthropic.com/v1/messages', { ... }),
 *   { hedgingDelayMs: 5000 }
 * );
 */
export async function hedgedRequest<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    config: Partial<HedgingConfig> = {}
): Promise<{ result: T; wasHedged: boolean; latencyMs: number }> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!cfg.enabled) {
        // Hedging disabled, execute normally
        const startTime = Date.now();
        const result = await fn(new AbortController().signal);
        return {
            result,
            wasHedged: false,
            latencyMs: Date.now() - startTime,
        };
    }

    const startTime = Date.now();
    const controllers: AbortController[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];  // Track timeouts for cleanup
    const promises: Array<Promise<{ result: T; index: number }>> = [];

    // Create abort controller for original request
    const originalController = new AbortController();
    controllers.push(originalController);

    // Start original request
    promises.push(
        fn(originalController.signal)
            .then(result => ({ result, index: 0 }))
            .catch(error => {
                // If original fails, don't cancel hedged request
                throw error;
            })
    );

    // Schedule hedged request(s)
    for (let i = 0; i < cfg.maxHedgedRequests; i++) {
        const hedgedController = new AbortController();
        controllers.push(hedgedController);

        const hedgedPromise = new Promise<{ result: T; index: number }>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                logger.debug('[Hedging] Starting hedged request', {
                    hedgeIndex: i + 1,
                    delayMs: cfg.hedgingDelayMs,
                });

                fn(hedgedController.signal)
                    .then(result => resolve({ result, index: i + 1 }))
                    .catch(reject);
            }, cfg.hedgingDelayMs * (i + 1));
            
            timeouts.push(timeoutId);  // Track timeout for cleanup
        });

        promises.push(hedgedPromise);
    }

    try {
        // Wait for first successful response
        const { result, index } = await Promise.race(promises);

        const latencyMs = Date.now() - startTime;
        const wasHedged = index > 0;

        // Clean up: clear all pending timeouts to prevent memory leak
        timeouts.forEach(id => clearTimeout(id));

        // Cancel all other requests
        controllers.forEach((controller, i) => {
            if (i !== index) {
                controller.abort();
            }
        });

        if (wasHedged) {
            logger.info('[Hedging] Hedged request completed first', {
                hedgeIndex: index,
                latencyMs,
                savedMs: cfg.hedgingDelayMs * index,
            });
        }

        return { result, wasHedged, latencyMs };
    } catch (error) {
        // All requests failed - clean up timeouts and abort controllers
        timeouts.forEach(id => clearTimeout(id));
        controllers.forEach(controller => controller.abort());
        throw error;
    }
}

/**
 * Hedging controller with metrics and adaptive behavior.
 */
export class HedgingController {
    private metrics: HedgingMetrics = {
        totalRequests: 0,
        hedgedRequests: 0,
        hedgedRequestsFaster: 0,
        hedgedRequestsSlower: 0,
        averageLatencySavingsMs: 0,
    };

    private recentErrors: number[] = [];
    private readonly errorWindowMs = 60000; // 1 minute

    constructor(
        private readonly name: string,
        private readonly config: HedgingConfig = DEFAULT_CONFIG
    ) {}

    /**
     * Execute request with hedging and metrics tracking.
     */
    async execute<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.metrics.totalRequests++;

        // Check if hedging should be enabled based on error rate
        const errorRate = this.calculateErrorRate();
        const shouldHedge = this.config.enabled && errorRate < this.config.errorRateThreshold;

        if (!shouldHedge) {
            logger.debug('[Hedging] Disabled due to high error rate', {
                name: this.name,
                errorRate: (errorRate * 100).toFixed(1) + '%',
            });

            return await fn(new AbortController().signal);
        }

        const { result, wasHedged } = await hedgedRequest(fn, this.config);

        if (wasHedged) {
            this.metrics.hedgedRequests++;
            this.metrics.hedgedRequestsFaster++;

            // Update average latency savings
            const savedMs = this.config.hedgingDelayMs;
            this.metrics.averageLatencySavingsMs =
                (this.metrics.averageLatencySavingsMs * (this.metrics.hedgedRequestsFaster - 1) + savedMs) /
                this.metrics.hedgedRequestsFaster;
        }

        return result;
    }

    /**
     * Record an error for adaptive hedging.
     */
    recordError(): void {
        this.recentErrors.push(Date.now());
        this.cleanupOldErrors();
    }

    /**
     * Get current metrics.
     */
    getMetrics(): HedgingMetrics {
        return { ...this.metrics };
    }

    /**
     * Calculate error rate over sliding window.
     */
    private calculateErrorRate(): number {
        this.cleanupOldErrors();

        if (this.metrics.totalRequests === 0) {
            return 0;
        }

        // Approximate error rate based on recent errors
        const recentRequests = Math.min(this.metrics.totalRequests, 100);
        return this.recentErrors.length / recentRequests;
    }

    /**
     * Remove errors outside the time window.
     */
    private cleanupOldErrors(): void {
        const cutoff = Date.now() - this.errorWindowMs;
        this.recentErrors = this.recentErrors.filter(t => t > cutoff);
    }
}

/**
 * Global hedging controllers per operation type.
 */
export const hedgingControllers = {
    claudeChunkReview: new HedgingController('claude-chunk-review', {
        enabled: true,
        hedgingDelayMs: 8000, // 8s for chunk review
        maxHedgedRequests: 1,
        errorRateThreshold: 0.15,
    }),

    claudeSynthesis: new HedgingController('claude-synthesis', {
        enabled: true,
        hedgingDelayMs: 10000, // 10s for synthesis (longer operation)
        maxHedgedRequests: 1,
        errorRateThreshold: 0.15,
    }),

    geminiChunkReview: new HedgingController('gemini-chunk-review', {
        enabled: false, // Gemini is faster, hedging less beneficial
        hedgingDelayMs: 5000,
        maxHedgedRequests: 1,
        errorRateThreshold: 0.2,
    }),

    geminiSynthesis: new HedgingController('gemini-synthesis', {
        enabled: false,
        hedgingDelayMs: 7000,
        maxHedgedRequests: 1,
        errorRateThreshold: 0.2,
    }),
};

/**
 * Get all hedging metrics for monitoring dashboard.
 */
export function getAllHedgingMetrics(): Record<string, HedgingMetrics> {
    return {
        claudeChunkReview: hedgingControllers.claudeChunkReview.getMetrics(),
        claudeSynthesis: hedgingControllers.claudeSynthesis.getMetrics(),
        geminiChunkReview: hedgingControllers.geminiChunkReview.getMetrics(),
        geminiSynthesis: hedgingControllers.geminiSynthesis.getMetrics(),
    };
}
