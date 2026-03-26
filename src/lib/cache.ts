/**
 * Caching Layer for GitHub API Responses
 * 
 * Reduces API calls and improves performance by caching:
 * - File contents (TTL: 5 minutes during active review)
 * - PR file listings (TTL: 2 minutes)
 * - User/repo metadata (TTL: 1 hour)
 * 
 * Uses Cloudflare KV for distributed caching across worker instances.
 */

import type { Env } from '../types/env';
import { logger } from './logger';

export interface CacheConfig {
    /** Time-to-live in seconds */
    ttlSeconds: number;
    /** Whether to stale-while-revalidate (return stale, fetch in background) */
    staleWhileRevalidate: boolean;
    /** Tags for cache invalidation */
    tags?: string[];
}

export interface CacheEntry<T> {
    data: T;
    cachedAt: number;
    expiresAt: number;
    etag?: string;
}

// Default TTL configurations for different data types
export const CACHE_TTLS = {
    FILE_CONTENT: 300,      // 5 minutes - file content changes during review
    PR_FILES: 120,          // 2 minutes - PR files change as commits are added
    REPO_METADATA: 3600,    // 1 hour - repo info rarely changes
    USER_INFO: 3600,        // 1 hour - user info rarely changes
    CHECK_RUN: 60,          // 1 minute - check run status updates frequently
};

/**
 * Generate a cache key for a GitHub API request.
 */
export function generateCacheKey(
    type: 'file' | 'pr-files' | 'repo' | 'user' | 'check-run',
    identifier: string
): string {
    return `github:${type}:${identifier}`;
}

/**
 * Check if a cached entry is still fresh.
 */
export function isCacheFresh<T>(entry: CacheEntry<T>): boolean {
    return Date.now() < entry.expiresAt;
}

/**
 * Check if a cached entry can be used (fresh or stale-while-revalidate).
 * Stale data is allowed for 10% of the original TTL as a grace period.
 */
export function isCacheUsable<T>(entry: CacheEntry<T>, allowStale: boolean = true): boolean {
    if (isCacheFresh(entry)) return true;
    if (allowStale) {
        // Allow stale data for 10% of the original TTL (grace period)
        const ttl = entry.expiresAt - entry.cachedAt;
        const gracePeriod = Math.floor(ttl * 0.1); // 10% grace period
        return Date.now() < entry.expiresAt + gracePeriod;
    }
    return false;
}

/**
 * Get cached data from KV.
 */
export async function getCachedData<T>(
    env: Env,
    cacheKey: string,
    allowStale: boolean = true
): Promise<CacheEntry<T> | null> {
    try {
        const stored = await env.USAGE_METRICS.get(cacheKey);
        if (!stored) return null;

        const entry = JSON.parse(stored) as CacheEntry<T>;
        
        if (!isCacheUsable(entry, allowStale)) {
            // Entry expired and not in grace period
            return null;
        }

        logger.debug('Cache hit', { cacheKey, fresh: isCacheFresh(entry) });
        return entry;
    } catch (error) {
        logger.warn('Cache read error', { cacheKey, error: String(error) });
        return null;
    }
}

/**
 * Store data in cache.
 */
export async function setCachedData<T>(
    env: Env,
    cacheKey: string,
    data: T,
    ttlSeconds: number,
    etag?: string
): Promise<void> {
    const now = Date.now();
    const entry: CacheEntry<T> = {
        data,
        cachedAt: now,
        expiresAt: now + (ttlSeconds * 1000),
        etag,
    };

    try {
        await env.USAGE_METRICS.put(cacheKey, JSON.stringify(entry), {
            expirationTtl: ttlSeconds * 2, // Store for 2x TTL to enable stale-while-revalidate
        });
        
        logger.debug('Cache stored', { cacheKey, ttlSeconds });
    } catch (error) {
        logger.warn('Cache write error', { cacheKey, error: String(error) });
        // Non-fatal: continue without caching
    }
}

/**
 * Delete cached data (for invalidation).
 */
export async function invalidateCache(
    env: Env,
    pattern: string
): Promise<void> {
    try {
        // List keys matching pattern and delete them
        const keys = await env.USAGE_METRICS.list({ prefix: pattern });
        
        for (const key of keys.keys) {
            await env.USAGE_METRICS.delete(key.name);
        }
        
        logger.info('Cache invalidated', { pattern, count: keys.keys.length });
    } catch (error) {
        logger.error('Cache invalidation error', error instanceof Error ? error : undefined, {
            pattern,
        });
    }
}

/**
 * Wrapper for GitHub API calls with caching.
 */
export async function cachedGitHubFetch<T>(
    env: Env,
    url: string,
    init: RequestInit,
    cacheConfig: CacheConfig,
    fetchFn: (url: string, init: RequestInit) => Promise<Response>
): Promise<T> {
    const cacheKey = generateCacheKey(
        inferCacheType(url),
        `${init.method || 'GET'}:${url}`
    );

    // Try cache first
    const cached = await getCachedData<T>(env, cacheKey, cacheConfig.staleWhileRevalidate);
    
    if (cached && isCacheFresh(cached)) {
        // Fresh cache hit - return immediately
        return cached.data;
    }

    // Cache miss or stale - make the request
    try {
        // Add conditional request headers if we have an ETag
        const requestInit = { ...init };
        if (cached?.etag) {
            requestInit.headers = {
                ...requestInit.headers,
                'If-None-Match': cached.etag,
            };
        }

        const response = await fetchFn(url, requestInit);

        // Handle 304 Not Modified
        if (response.status === 304 && cached) {
            logger.debug('GitHub API 304 Not Modified, using cache', { url });
            // Refresh cache TTL
            await setCachedData(env, cacheKey, cached.data, cacheConfig.ttlSeconds, cached.etag);
            return cached.data;
        }

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as T;
        
        // Store in cache with ETag
        const etag = response.headers.get('ETag') || undefined;
        await setCachedData(env, cacheKey, data, cacheConfig.ttlSeconds, etag);

        // If we got fresh data but had stale cache, log the revalidation
        if (cached && !isCacheFresh(cached)) {
            logger.debug('Stale cache revalidated', { url });
        }

        return data;
    } catch (error) {
        // On error, try to return stale cache if available
        if (cached && cacheConfig.staleWhileRevalidate) {
            logger.warn('GitHub API failed, using stale cache', { url, error: String(error) });
            return cached.data;
        }
        throw error;
    }
}

/**
 * Infer cache type from URL.
 */
function inferCacheType(url: string): 'file' | 'pr-files' | 'repo' | 'user' | 'check-run' {
    if (url.includes('/contents/')) return 'file';
    if (url.includes('/pulls/') && url.includes('/files')) return 'pr-files';
    if (url.includes('/check-runs')) return 'check-run';
    if (url.includes('/users/')) return 'user';
    if (url.includes('/repos/')) return 'repo';
    return 'repo'; // Default
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
    totalKeys: number;
    byType: Record<string, number>;
    totalSize: number;
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(env: Env): Promise<CacheStats> {
    const stats: CacheStats = {
        totalKeys: 0,
        byType: {},
        totalSize: 0,
    };

    try {
        const keys = await env.USAGE_METRICS.list({ prefix: 'github:' });
        stats.totalKeys = keys.keys.length;

        for (const key of keys.keys) {
            const type = key.name.split(':')[1] || 'unknown';
            stats.byType[type] = (stats.byType[type] || 0) + 1;
        }
    } catch (error) {
        logger.error('Failed to get cache stats', error instanceof Error ? error : undefined);
    }

    return stats;
}
