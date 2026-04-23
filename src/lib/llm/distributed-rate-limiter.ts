/**
 * INDUSTRIAL-GRADE DISTRIBUTED RATE LIMITER
 * 
 * Uses Durable Objects for global coordination across all Worker instances.
 * Implements token bucket algorithm with distributed state persistence.
 * 
 * Based on patterns from:
 * - AWS SDK Adaptive Retry Mode
 * - Stripe API Client Rate Limiting
 * - Cloudflare Workers Best Practices
 * 
 * Key Features:
 * - Global rate limiting across all edge nodes
 * - Survives Worker cold starts
 * - Adaptive rate adjustment based on 429/529 responses
 * - Request queuing with timeout
 * - Metrics for observability
 */

// Use global Cloudflare types (no import needed)
// DurableObjectNamespace and DurableObjectState are available globally

export interface DistributedRateLimitConfig {
    /** Provider name (claude, gemini) */
    provider: string;
    /** Maximum requests per minute */
    requestsPerMinute: number;
    /** Maximum input tokens per minute */
    inputTokensPerMinute: number;
    /** Maximum output tokens per minute */
    outputTokensPerMinute: number;
    /** Enable adaptive rate adjustment */
    adaptive: boolean;
}

export interface RateLimitRequest {
    /** Estimated input tokens */
    estimatedInputTokens: number;
    /** Estimated output tokens */
    estimatedOutputTokens: number;
    /** Request timeout in ms */
    timeoutMs?: number;
}

export interface RateLimitResponse {
    /** Whether request was allowed */
    allowed: boolean;
    /** Time waited in queue (ms) */
    waitTimeMs: number;
    /** Current rate limit utilization (0-1) */
    utilization: number;
    /** Retry after (ms) if not allowed */
    retryAfterMs?: number;
}

/**
 * Client for distributed rate limiter.
 * Communicates with RateLimiterDO via Durable Object stub.
 */
export class DistributedRateLimiter {
    constructor(
        private readonly namespace: DurableObjectNamespace,
        private readonly config: DistributedRateLimitConfig
    ) {}

    /**
     * Acquire capacity for a request.
     * Blocks until capacity is available or timeout is reached.
     */
    async acquire(request: RateLimitRequest): Promise<RateLimitResponse> {
        const id = this.namespace.idFromName(this.config.provider);
        const stub = this.namespace.get(id);

        const startTime = Date.now();
        const timeoutMs = request.timeoutMs ?? 30000; // 30s default

        const response = await stub.fetch('https://rate-limiter/acquire', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config: this.config,
                request,
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            throw new Error(`Rate limiter error: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as RateLimitResponse;
        data.waitTimeMs = Date.now() - startTime;

        return data;
    }

    /**
     * Release unused tokens after actual API response.
     */
    async release(actual: { inputTokens: number; outputTokens: number }): Promise<void> {
        const id = this.namespace.idFromName(this.config.provider);
        const stub = this.namespace.get(id);

        await stub.fetch('https://rate-limiter/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(actual),
        });
    }

    /**
     * Report API error for adaptive rate adjustment.
     */
    async reportError(statusCode: number): Promise<void> {
        const id = this.namespace.idFromName(this.config.provider);
        const stub = this.namespace.get(id);

        await stub.fetch('https://rate-limiter/error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statusCode }),
        });
    }

    /**
     * Get current rate limiter metrics.
     */
    async getMetrics(): Promise<RateLimiterMetrics> {
        const id = this.namespace.idFromName(this.config.provider);
        const stub = this.namespace.get(id);

        const response = await stub.fetch('https://rate-limiter/metrics');
        return await response.json() as RateLimiterMetrics;
    }
}

export interface RateLimiterMetrics {
    provider: string;
    requestsPerMinute: number;
    inputTokensPerMinute: number;
    outputTokensPerMinute: number;
    currentUtilization: number;
    queueLength: number;
    totalRequests: number;
    totalErrors: number;
    adaptiveMultiplier: number;
}

/**
 * Durable Object implementation for distributed rate limiting.
 * One instance per provider (claude, gemini).
 */
export class RateLimiterDO {
    private state: DurableObjectState;
    private requestBucket!: TokenBucket;  // Initialized in blockConcurrencyWhile
    private inputTokenBucket!: TokenBucket;
    private outputTokenBucket!: TokenBucket;
    private queue: Array<QueuedRequest> = [];
    private metrics: RateLimiterMetrics;
    private adaptiveMultiplier = 1.0; // Reduces rate on errors
    private lastErrorTime = 0;
    private errorCount = 0;

    constructor(state: DurableObjectState) {
        this.state = state;
        
        // Initialize metrics
        this.metrics = {
            provider: '',
            requestsPerMinute: 0,
            inputTokensPerMinute: 0,
            outputTokensPerMinute: 0,
            currentUtilization: 0,
            queueLength: 0,
            totalRequests: 0,
            totalErrors: 0,
            adaptiveMultiplier: 1.0,
        };

        // Load state from storage on construction
        this.state.blockConcurrencyWhile(async () => {
            const stored = await this.state.storage.get<{
                config?: DistributedRateLimitConfig;
                tokens?: { request: number; input: number; output: number };
                lastRefill?: number;
            }>('state');
            
            if (stored?.config) {
                this.initializeBuckets(stored.config);
                
                // Restore token state
                if (stored.tokens && stored.lastRefill) {
                    this.requestBucket.restoreState(stored.tokens.request, stored.lastRefill);
                    this.inputTokenBucket.restoreState(stored.tokens.input, stored.lastRefill);
                    this.outputTokenBucket.restoreState(stored.tokens.output, stored.lastRefill);
                }
            }
        });
    }

    /**
     * Durable Object alarm handler - processes queue when items are waiting.
     * Only reschedules if queue has items (event-driven, not polling).
     */
    async alarm(): Promise<void> {
        // Process queue
        this.processQueue();
        
        // Only reschedule alarm if queue still has items
        if (this.queue.length > 0) {
            await this.state.storage.setAlarm(Date.now() + 1000); // 1 second, not 100ms
        }
    }
    
    /**
     * Persist state to storage for hibernation recovery.
     */
    private async persistState(): Promise<void> {
        if (!this.requestBucket) return;
        
        await this.state.storage.put('state', {
            config: {
                provider: this.metrics.provider,
                requestsPerMinute: this.metrics.requestsPerMinute,
                inputTokensPerMinute: this.metrics.inputTokensPerMinute,
                outputTokensPerMinute: this.metrics.outputTokensPerMinute,
                adaptive: true,
            },
            tokens: {
                request: this.requestBucket.available(),
                input: this.inputTokenBucket.available(),
                output: this.outputTokenBucket.available(),
            },
            lastRefill: Date.now(),
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/acquire' && request.method === 'POST') {
            return await this.handleAcquire(request);
        }

        if (url.pathname === '/release' && request.method === 'POST') {
            return await this.handleRelease(request);
        }

        if (url.pathname === '/error' && request.method === 'POST') {
            return await this.handleError(request);
        }

        if (url.pathname === '/metrics' && request.method === 'GET') {
            return new Response(JSON.stringify(this.metrics), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response('Not Found', { status: 404 });
    }

    private async handleAcquire(request: Request): Promise<Response> {
        const body = await request.json() as {
            config: DistributedRateLimitConfig;
            request: RateLimitRequest;
        };

        // Initialize buckets on first request
        if (!this.requestBucket) {
            this.initializeBuckets(body.config);
        }

        const { estimatedInputTokens, estimatedOutputTokens } = body.request;

        // Check if we have immediate capacity
        const hasCapacity = 
            this.requestBucket.hasCapacity(1) &&
            this.inputTokenBucket.hasCapacity(estimatedInputTokens) &&
            this.outputTokenBucket.hasCapacity(estimatedOutputTokens);

        if (hasCapacity) {
            // Acquire immediately
            this.requestBucket.acquire(1);
            this.inputTokenBucket.acquire(estimatedInputTokens);
            this.outputTokenBucket.acquire(estimatedOutputTokens);

            this.metrics.totalRequests++;
            
            // Persist state after acquisition
            await this.persistState();

            return new Response(JSON.stringify({
                allowed: true,
                waitTimeMs: 0,
                utilization: this.calculateUtilization(),
            } as RateLimitResponse), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Queue the request
        return new Promise<Response>((resolve) => {
            const queuedRequest: QueuedRequest = {
                estimatedInputTokens,
                estimatedOutputTokens,
                resolve,
                timestamp: Date.now(),
            };

            this.queue.push(queuedRequest);
            this.metrics.queueLength = this.queue.length;
            
            // Schedule alarm to process queue (event-driven)
            this.state.storage.setAlarm(Date.now() + 100);

            // Timeout after 30s
            setTimeout(() => {
                const index = this.queue.indexOf(queuedRequest);
                if (index !== -1) {
                    this.queue.splice(index, 1);
                    this.metrics.queueLength = this.queue.length;
                    
                    resolve(new Response(JSON.stringify({
                        allowed: false,
                        waitTimeMs: Date.now() - queuedRequest.timestamp,
                        utilization: this.calculateUtilization(),
                        retryAfterMs: 5000,
                    } as RateLimitResponse), {
                        headers: { 'Content-Type': 'application/json' },
                    }));
                }
            }, 30000);
        });
    }

    private async handleRelease(request: Request): Promise<Response> {
        const body = await request.json() as { inputTokens: number; outputTokens: number };

        // Return unused tokens to buckets
        this.inputTokenBucket.release(body.inputTokens);
        this.outputTokenBucket.release(body.outputTokens);

        // Process queue in case waiting requests can now proceed
        this.processQueue();

        return new Response('OK');
    }

    private async handleError(request: Request): Promise<Response> {
        const body = await request.json() as { statusCode: number };

        this.metrics.totalErrors++;
        this.errorCount++;
        this.lastErrorTime = Date.now();

        // Adaptive rate reduction on 429/529 errors
        if (body.statusCode === 429 || body.statusCode === 529) {
            // Multiplicative decrease: reduce rate by 50%
            this.adaptiveMultiplier = Math.max(0.1, this.adaptiveMultiplier * 0.5);
            this.metrics.adaptiveMultiplier = this.adaptiveMultiplier;

            console.log(`[RateLimiter] Adaptive rate reduced to ${(this.adaptiveMultiplier * 100).toFixed(0)}% due to ${body.statusCode}`);

            // Adjust bucket capacities
            this.adjustBucketCapacities();
        }

        // Additive increase: slowly recover rate after 60s of no errors
        setTimeout(() => {
            if (Date.now() - this.lastErrorTime >= 60000) {
                this.adaptiveMultiplier = Math.min(1.0, this.adaptiveMultiplier + 0.1);
                this.metrics.adaptiveMultiplier = this.adaptiveMultiplier;
                this.adjustBucketCapacities();
                
                console.log(`[RateLimiter] Adaptive rate increased to ${(this.adaptiveMultiplier * 100).toFixed(0)}%`);
            }
        }, 60000);

        return new Response('OK');
    }

    private initializeBuckets(config: DistributedRateLimitConfig): void {
        this.metrics.provider = config.provider;
        this.metrics.requestsPerMinute = config.requestsPerMinute;
        this.metrics.inputTokensPerMinute = config.inputTokensPerMinute;
        this.metrics.outputTokensPerMinute = config.outputTokensPerMinute;

        this.requestBucket = new TokenBucket(
            config.requestsPerMinute,
            60000,
            this.adaptiveMultiplier
        );

        this.inputTokenBucket = new TokenBucket(
            config.inputTokensPerMinute,
            60000,
            this.adaptiveMultiplier
        );

        this.outputTokenBucket = new TokenBucket(
            config.outputTokensPerMinute,
            60000,
            this.adaptiveMultiplier
        );
    }

    private adjustBucketCapacities(): void {
        if (this.requestBucket) {
            this.requestBucket.setMultiplier(this.adaptiveMultiplier);
            this.inputTokenBucket.setMultiplier(this.adaptiveMultiplier);
            this.outputTokenBucket.setMultiplier(this.adaptiveMultiplier);
        }
    }

    private processQueue(): void {
        let processed = 0;
        
        while (this.queue.length > 0) {
            const next = this.queue[0];

            const hasCapacity =
                this.requestBucket.hasCapacity(1) &&
                this.inputTokenBucket.hasCapacity(next.estimatedInputTokens) &&
                this.outputTokenBucket.hasCapacity(next.estimatedOutputTokens);

            if (!hasCapacity) {
                break;
            }

            // Acquire capacity
            this.requestBucket.acquire(1);
            this.inputTokenBucket.acquire(next.estimatedInputTokens);
            this.outputTokenBucket.acquire(next.estimatedOutputTokens);

            // Remove from queue
            this.queue.shift();
            this.metrics.queueLength = this.queue.length;
            this.metrics.totalRequests++;
            processed++;

            // Resolve the waiting request
            next.resolve(new Response(JSON.stringify({
                allowed: true,
                waitTimeMs: Date.now() - next.timestamp,
                utilization: this.calculateUtilization(),
            } as RateLimitResponse), {
                headers: { 'Content-Type': 'application/json' },
            }));
        }
        
        // Persist state after processing queue
        if (processed > 0) {
            this.persistState();
        }
    }

    private calculateUtilization(): number {
        if (!this.requestBucket) return 0;

        const requestUtil = 1 - (this.requestBucket.available() / this.requestBucket.capacity());
        const inputUtil = 1 - (this.inputTokenBucket.available() / this.inputTokenBucket.capacity());
        const outputUtil = 1 - (this.outputTokenBucket.available() / this.outputTokenBucket.capacity());

        return Math.max(requestUtil, inputUtil, outputUtil);
    }
}

interface QueuedRequest {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    resolve: (response: Response) => void;
    timestamp: number;
}

/**
 * Token bucket with refill rate and adaptive multiplier.
 * Refills on-demand (no background timer) to avoid race conditions.
 * Supports state persistence for Durable Object hibernation.
 */
class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private multiplier: number;

    constructor(
        private readonly baseCapacity: number,
        private readonly refillWindowMs: number,
        multiplier: number = 1.0
    ) {
        this.multiplier = multiplier;
        this.tokens = this.capacity();
        this.lastRefill = Date.now();
        // No setInterval - refill on-demand only to avoid race conditions
    }

    capacity(): number {
        return Math.floor(this.baseCapacity * this.multiplier);
    }

    available(): number {
        return this.tokens;
    }
    
    /**
     * Restore state from storage (for hibernation recovery).
     */
    restoreState(tokens: number, lastRefill: number): void {
        this.tokens = Math.min(this.capacity(), tokens);
        this.lastRefill = lastRefill;
    }

    hasCapacity(tokens: number): boolean {
        this.refill();
        return this.tokens >= tokens;
    }

    acquire(tokens: number): void {
        this.refill();
        if (this.tokens < tokens) {
            throw new Error('Insufficient tokens');
        }
        this.tokens -= tokens;
    }

    release(tokens: number): void {
        this.tokens = Math.min(this.capacity(), this.tokens + tokens);
    }

    setMultiplier(multiplier: number): void {
        this.multiplier = multiplier;
        // Adjust current tokens proportionally
        this.tokens = Math.min(this.capacity(), this.tokens);
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        
        // Don't refill more than once per second to avoid excessive calculations
        if (elapsed < 1000) {
            return;
        }

        const tokensToAdd = (elapsed / this.refillWindowMs) * this.capacity();

        if (tokensToAdd >= 1) {
            this.tokens = Math.min(this.capacity(), this.tokens + Math.floor(tokensToAdd));
            this.lastRefill = now;
        }
    }
}
