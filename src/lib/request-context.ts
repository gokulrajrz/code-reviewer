/**
 * Request context for distributed tracing.
 * Manages request ID propagation across async boundaries.
 * 
 * Note: Uses a Worker-compatible implementation instead of Node.js AsyncLocalStorage
 * since Cloudflare Workers doesn't support the node:async_hooks module.
 */

export interface RequestContext {
    /** Unique request ID for tracing */
    requestId: string;
    /** Timestamp when the request started */
    startTime: number;
    /** Additional context data */
    [key: string]: unknown;
}

// Worker-compatible context storage using explicit context passing
// We use a simple Map with request IDs since Workers are single-threaded per request
const contextStore = new Map<string, RequestContext>();

// Track the current request ID for the executing context
let currentRequestId: string | null = null;

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Extract request ID from HTTP headers or generate a new one
 */
export function extractOrGenerateRequestId(headers: Headers): string {
    // Check for common request ID headers
    const requestId = headers.get('x-request-id') ||
        headers.get('x-correlation-id') ||
        headers.get('cf-ray') || // Cloudflare Ray ID
        headers.get('x-github-delivery'); // GitHub webhook ID

    return requestId || generateRequestId();
}

/**
 * Run a function within a request context
 * Worker-compatible implementation using explicit context passing
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
    const previousRequestId = currentRequestId;
    currentRequestId = context.requestId;
    contextStore.set(context.requestId, context);
    
    try {
        return fn();
    } finally {
        // Cleanup
        contextStore.delete(context.requestId);
        currentRequestId = previousRequestId;
    }
}

/**
 * Run an async function within a request context
 * Worker-compatible implementation using explicit context passing
 */
export async function runWithContextAsync<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
    const previousRequestId = currentRequestId;
    currentRequestId = context.requestId;
    contextStore.set(context.requestId, context);
    
    try {
        return await fn();
    } finally {
        // Cleanup
        contextStore.delete(context.requestId);
        currentRequestId = previousRequestId;
    }
}

/**
 * Get the current request context
 */
export function getRequestContext(): RequestContext | undefined {
    if (currentRequestId) {
        return contextStore.get(currentRequestId);
    }
    return undefined;
}

/**
 * Get the current request ID
 */
export function getRequestId(): string | undefined {
    return currentRequestId || undefined;
}

/**
 * Add context to the current request context
 */
export function addToContext(key: string, value: unknown): void {
    if (currentRequestId) {
        const context = contextStore.get(currentRequestId);
        if (context) {
            context[key] = value;
        }
    }
}

/**
 * Create a child context for queue messages
 * Preserves the request ID while allowing additional context
 */
export function createChildContext(additionalContext: Omit<RequestContext, 'requestId'> = {}): RequestContext {
    const parentContext = currentRequestId ? contextStore.get(currentRequestId) : undefined;
    return {
        requestId: parentContext?.requestId || generateRequestId(),
        startTime: Date.now(),
        ...additionalContext,
    };
}
