import type { Env, ReviewMessage } from './types/env';
import { WORKER_VERSION } from './config/constants';
import { handlePRWebhook } from './handlers/webhook';
import { queueHandler } from './handlers/queue';
import { 
    getLatestPRUsageMetrics, 
    getPRUsageMetrics, 
    listRepoUsageMetrics, 
    getRepoUsageStats 
} from './lib/usage-tracker';
import { isUsageTrackingError, normalizeError, AuthenticationError } from './lib/errors';
import { validateRepoIdentifier, validatePRNumber, validateCommitSha, validateLimit } from './lib/validation';
import { logger } from './lib/logger';
import { getSecurityHeaders, createSecureJsonResponse } from './lib/security-headers';
import { isCorsPreflight, createCorsPreflightResponse, createCorsJsonResponse } from './lib/cors';
import { checkRateLimitDistributed, getRateLimitHeaders, createRateLimitResponse } from './lib/rate-limit';
import { extractOrGenerateRequestId, runWithContextAsync, getRequestId } from './lib/request-context';
import { setRequestContextGetter } from './lib/logger';
import { performHealthCheck, getHealthStatusCode } from './lib/health-check';
import { getOperationalMetrics, getPrometheusMetrics, recordRequestMetrics } from './lib/metrics';

// Worker start time for uptime calculation
const workerStartTime = Date.now();

/**
 * HARDCODED DASHBOARD CREDENTIALS
 * Change these to your preferred username/password
 * Format: username:password (both plain text for simplicity)
 */
const DASHBOARD_USERNAME = 'admin';
const DASHBOARD_PASSWORD = 'admin123';
const DASHBOARD_SESSION_COOKIE = 'dashboard_session';
const SESSION_SECRET = 'change-this-secret-in-production-2024';

/**
 * Simple session token generator
 */
function generateSessionToken(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);
    return `${timestamp}-${random}`;
}

/**
 * Verify session cookie
 */
function isAuthenticated(request: Request): boolean {
    const cookie = request.headers.get('Cookie');
    if (!cookie) return false;
    
    const sessionMatch = cookie.match(new RegExp(`${DASHBOARD_SESSION_COOKIE}=([^;]+)`));
    if (!sessionMatch) return false;
    
    // Simple validation - in production, verify signature or use JWT
    const token = sessionMatch[1];
    return !!token && token.length > 10;
}

/**
 * Create session cookie response header
 */
function createSessionCookie(): string {
    const token = generateSessionToken();
    const maxAge = 8 * 60 * 60; // 8 hours
    return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/dashboard`;
}

/**
 * Clear session cookie
 */
function clearSessionCookie(): string {
    return `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/dashboard`;
}

/**
 * Optional authentication for usage endpoints
 * Set USAGE_API_KEY secret to enable
 */
function authenticateUsageRequest(request: Request, env: Env): void {
    // Skip auth if USAGE_API_KEY is not configured
    if (!env.USAGE_API_KEY) {
        return;
    }

    const authHeader = request.headers.get('Authorization');
    const expectedAuth = `Bearer ${env.USAGE_API_KEY}`;

    if (authHeader !== expectedAuth) {
        throw new AuthenticationError('Invalid or missing API key');
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = extractOrGenerateRequestId(request.headers);
        const context = {
            requestId,
            startTime: Date.now(),
            path: new URL(request.url).pathname,
            method: request.method,
        };

        return runWithContextAsync(context, async () => {
            const requestStartTime = Date.now();
            const { method, url } = request;
            const { pathname, searchParams } = new URL(url);

            let response: Response = createSecureJsonResponse(
                { error: 'Not Found', message: 'The requested endpoint does not exist' },
                404
            );

            // — Simple Health Check (backward compatible) —
            if (method === 'GET' && pathname === '/') {
                const health = await performHealthCheck(env, WORKER_VERSION, workerStartTime);
                const statusCode = getHealthStatusCode(health);
                
                response = createSecureJsonResponse(
                    {
                        status: health.status === 'healthy' ? 'ok' : health.status,
                        service: health.service,
                        version: health.version,
                        provider: env.AI_PROVIDER ?? 'claude',
                    },
                    statusCode
                );
            }

            // — Detailed Health Check with Dependencies —
            else if (method === 'GET' && pathname === '/health') {
                const health = await performHealthCheck(env, WORKER_VERSION, workerStartTime);
                const statusCode = getHealthStatusCode(health);
                
                response = createSecureJsonResponse(health, statusCode);
            }

            // — Operational Metrics Endpoint —
            else if (method === 'GET' && pathname === '/metrics') {
                const format = searchParams.get('format') || 'json';
                const period = (searchParams.get('period') as '1h' | '24h' | '7d') || '24h';
                
                const metrics = await getOperationalMetrics(env, period);
                
                if (format === 'prometheus') {
                    response = new Response(getPrometheusMetrics(metrics), {
                        status: 200,
                        headers: {
                            'Content-Type': 'text/plain; version=0.0.4',
                            ...getSecurityHeaders(),
                        },
                    });
                } else {
                    response = createSecureJsonResponse(metrics, 200);
                }
            }

            // — Usage Metrics Endpoints (with CORS and Rate Limiting) —
            else if (method === 'GET' && pathname.startsWith('/usage/')) {
                try {
                    // Handle CORS preflight
                    if (isCorsPreflight(request)) {
                        response = createCorsPreflightResponse(request, { allowedOrigins: '*' });
                    } else {

                    // Check rate limit (skip if authenticated with API key)
                    const rateLimitResult = await checkRateLimitDistributed(request, env, {
                        maxRequests: 100,
                        windowSeconds: 60,
                        burstCapacity: 20,
                    });

                    if (!rateLimitResult.allowed) {
                        logger.warn('Rate limit exceeded', {
                            path: pathname,
                            client: request.headers.get('CF-Connecting-IP') || 'unknown',
                        });
                        response = createRateLimitResponse(rateLimitResult);
                    } else {

                    // Optional authentication
                    authenticateUsageRequest(request, env);

                    // GET /usage/{owner}/{repo}/pr/{prNumber}
                    // Returns latest usage for a specific PR
                    const prMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)\/pr\/(\d+)$/);
                    if (prMatch) {
                        const [, owner, repo, prNum] = prMatch;
                        const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;
                        const prNumber = validatePRNumber(parseInt(prNum, 10));

                        const sha = searchParams.get('sha');
                        const metrics = sha
                            ? await getPRUsageMetrics(repoFullName, prNumber, validateCommitSha(sha), env)
                            : await getLatestPRUsageMetrics(repoFullName, prNumber, env);

                        if (!metrics) {
                            response = createCorsJsonResponse(
                                request,
                                {
                                    error: 'No usage data found for this PR',
                                    code: 'NOT_FOUND'
                                },
                                404,
                                { allowedOrigins: '*' },
                                getRateLimitHeaders(rateLimitResult)
                            );
                        } else {
                            response = createCorsJsonResponse(
                                request,
                                metrics,
                                200,
                                { allowedOrigins: '*' },
                                getRateLimitHeaders(rateLimitResult)
                            );
                        }
                    }

                    // GET /usage/{owner}/{repo}/stats
                    // Returns aggregate statistics for a repository
                    else {
                        const statsMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)\/stats$/);
                        if (statsMatch) {
                            const [, owner, repo] = statsMatch;
                            const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;

                            const stats = await getRepoUsageStats(repoFullName, env);

                            response = createCorsJsonResponse(
                                request,
                                stats,
                                200,
                                { allowedOrigins: '*' },
                                getRateLimitHeaders(rateLimitResult)
                            );
                        }

                        // GET /usage/{owner}/{repo}
                        // Returns list of all usage metrics for a repository
                        else {
                            const listMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)$/);
                            if (listMatch) {
                                const [, owner, repo] = listMatch;
                                const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;
                                const limit = validateLimit(searchParams.get('limit'));

                                const metrics = await listRepoUsageMetrics(repoFullName, env, limit);

                                response = createCorsJsonResponse(
                                    request,
                                    metrics,
                                    200,
                                    { allowedOrigins: '*' },
                                    getRateLimitHeaders(rateLimitResult)
                                );
                            }

                            else {
                                response = createCorsJsonResponse(
                                    request,
                                    { 
                                        error: 'Invalid usage endpoint',
                                        code: 'INVALID_ENDPOINT'
                                    },
                                    404,
                                    { allowedOrigins: '*' },
                                    getRateLimitHeaders(rateLimitResult)
                                );
                            }
                        }
                    }
                    } // Close rate limit else
                    } // Close CORS preflight else
                } catch (error) {
                    const normalizedError = normalizeError(error);
                    
                    logger.error('Usage endpoint error', error instanceof Error ? error : undefined, {
                        pathname,
                        errorCode: normalizedError.code,
                    });

                    response = createCorsJsonResponse(
                        request,
                        {
                            error: normalizedError.message,
                            code: normalizedError.code,
                            ...(normalizedError.context && { context: normalizedError.context }),
                        },
                        normalizedError.statusCode,
                        { allowedOrigins: '*' }
                    );
                }
            }

            // — Dashboard UI with Hardcoded Login —
            else if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
                if (method === 'POST' && pathname === '/dashboard/login') {
                    const formData = await request.formData();
                    const username = formData.get('username')?.toString() || '';
                    const password = formData.get('password')?.toString() || '';
                    
                    if (username === DASHBOARD_USERNAME && password === DASHBOARD_PASSWORD) {
                        response = new Response(dashboardHtml, {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html',
                                'Set-Cookie': createSessionCookie(),
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    } else {
                        response = new Response(loginHtml('Invalid username or password'), {
                            status: 401,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    }
                }
                else if (method === 'POST' && pathname === '/dashboard/logout') {
                    response = new Response(loginHtml('Logged out successfully'), {
                        status: 200,
                        headers: {
                            'Content-Type': 'text/html',
                            'Set-Cookie': clearSessionCookie(),
                            ...getSecurityHeaders({
                                contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                            }),
                        },
                    });
                }
                else if (method === 'GET') {
                    if (isAuthenticated(request)) {
                        response = new Response(dashboardHtml, {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    } else {
                        response = new Response(loginHtml(), {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    }
                }
                else {
                    response = new Response('Method not allowed', { status: 405 });
                }
            }
            // — GitHub Webhook Entry Point —
            else if (method === 'POST' && pathname === '/') {
                try {
                    response = await handlePRWebhook(request, env);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    logger.error('Unhandled webhook error', error instanceof Error ? error : undefined);
                    response = createSecureJsonResponse(
                        { error: 'Internal server error', detail: errMsg },
                        500
                    );
                }
            }

            // — Method Not Allowed —
            else {
                response = createSecureJsonResponse(
                    { error: 'Method not allowed' },
                    405,
                    { Allow: 'GET, POST' }
                );
            }

            // Record request metrics after response is determined
            recordRequestMetrics(method, response.status, Date.now() - requestStartTime);

            return response;
        });
    },

    /**
     * Background Queue Consumer Handler
     * Delegates to queueHandler which manages per-message request context.
     */
    async queue(batch: MessageBatch<ReviewMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
        try {
            await queueHandler(batch, env, ctx);
        } catch (error) {
            logger.error('Unhandled queue error', error instanceof Error ? error : undefined);
        }
    }
} satisfies ExportedHandler<Env, ReviewMessage>;

// — Dashboard HTML Templates —

function loginHtml(error?: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Reviewer - Login</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-card {
            background: #1e293b;
            padding: 2.5rem;
            border-radius: 12px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            width: 100%;
            max-width: 400px;
            border: 1px solid #334155;
        }
        h1 {
            color: #60a5fa;
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
            text-align: center;
        }
        .subtitle {
            color: #94a3b8;
            text-align: center;
            margin-bottom: 2rem;
            font-size: 0.875rem;
        }
        .error {
            background: #7f1d1d;
            color: #fca5a5;
            padding: 0.75rem;
            border-radius: 6px;
            margin-bottom: 1rem;
            font-size: 0.875rem;
        }
        .form-group {
            margin-bottom: 1.25rem;
        }
        label {
            display: block;
            color: #e2e8f0;
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
            font-weight: 500;
        }
        input[type="text"],
        input[type="password"] {
            width: 100%;
            padding: 0.75rem;
            background: #0f172a;
            border: 1px solid #475569;
            border-radius: 6px;
            color: #e2e8f0;
            font-size: 1rem;
            transition: border-color 0.2s;
        }
        input:focus {
            outline: none;
            border-color: #3b82f6;
        }
        button {
            width: 100%;
            padding: 0.875rem;
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover {
            background: #2563eb;
        }
        .hint {
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid #334155;
            color: #64748b;
            font-size: 0.75rem;
            text-align: center;
        }
        code {
            background: #334155;
            padding: 0.125rem 0.375rem;
            border-radius: 4px;
            font-family: 'Monaco', 'Consolas', monospace;
        }
    </style>
</head>
<body>
    <div class="login-card">
        <h1>🔐 Code Reviewer</h1>
        <p class="subtitle">Dashboard Login</p>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <form method="POST" action="/dashboard/login">
            <div class="form-group">
                <label for="username">Username</label>
                <input type="text" id="username" name="username" required autofocus>
            </div>
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required>
            </div>
            <button type="submit">Sign In</button>
        </form>
        <div class="hint">
            Default credentials:<br>
            <code>${DASHBOARD_USERNAME}</code> / <code>${DASHBOARD_PASSWORD}</code>
        </div>
    </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    const div = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => div[m as keyof typeof div]);
}

const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Code Reviewer Usage Dashboard - Monitor LLM usage and costs">
    <title>Code Reviewer - Usage Dashboard</title>
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-tertiary: #334155;
            --bg-input: #0f172a;
            --border-color: #475569;
            --text-primary: #f1f5f9;
            --text-secondary: #e2e8f0;
            --text-muted: #94a3b8;
            --text-dim: #64748b;
            --accent-blue: #3b82f6;
            --accent-blue-hover: #2563eb;
            --accent-green: #10b981;
            --accent-amber: #f59e0b;
            --accent-purple: #8b5cf6;
            --accent-red: #ef4444;
            --accent-red-bg: #7f1d1d;
            --accent-red-text: #fca5a5;
            --shadow-lg: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            --radius-sm: 4px;
            --radius-md: 6px;
            --radius-lg: 8px;
            --radius-xl: 12px;
            --transition-fast: 150ms ease;
            --transition-normal: 200ms ease;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        html {
            scroll-behavior: smooth;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: var(--bg-primary);
            color: var(--text-secondary);
            min-height: 100vh;
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        
        /* Header */
        .header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        
        .header-left {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        
        .header h1 {
            color: #60a5fa;
            font-size: 1.25rem;
            font-weight: 600;
        }
        
        .keyboard-hint {
            color: var(--text-dim);
            font-size: 0.75rem;
            padding: 0.25rem 0.5rem;
            background: var(--bg-tertiary);
            border-radius: var(--radius-sm);
            font-family: 'Monaco', 'Consolas', monospace;
        }
        
        .header-right {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        
        .auto-refresh-toggle {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--text-muted);
            font-size: 0.875rem;
            cursor: pointer;
            padding: 0.5rem;
            border-radius: var(--radius-md);
            transition: background var(--transition-fast);
        }
        
        .auto-refresh-toggle:hover {
            background: var(--bg-tertiary);
        }
        
        .auto-refresh-toggle input {
            cursor: pointer;
        }
        
        .btn {
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            padding: 0.5rem 1rem;
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 0.875rem;
            font-weight: 500;
            transition: all var(--transition-fast);
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .btn:hover {
            background: var(--border-color);
            border-color: var(--text-muted);
        }
        
        .btn-primary {
            background: var(--accent-blue);
            border-color: var(--accent-blue);
            color: white;
        }
        
        .btn-primary:hover {
            background: var(--accent-blue-hover);
            border-color: var(--accent-blue-hover);
        }
        
        .btn-icon {
            padding: 0.5rem;
            font-size: 1rem;
        }
        
        /* Container */
        .container {
            max-width: 1600px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        /* Config Panel */
        .config-panel {
            background: var(--bg-secondary);
            border-radius: var(--radius-lg);
            margin-bottom: 1.5rem;
            overflow: hidden;
        }
        
        .config-header {
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .config-title {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .config-body {
            padding: 1.5rem;
        }
        
        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
        }
        
        .config-group {
            display: flex;
            flex-direction: column;
            gap: 0.375rem;
        }
        
        .config-group label {
            font-size: 0.75rem;
            color: var(--text-muted);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .config-group input,
        .config-group select {
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 0.625rem;
            border-radius: var(--radius-md);
            font-size: 0.875rem;
            transition: border-color var(--transition-fast);
            min-width: 0;
        }
        
        .config-group input:focus,
        .config-group select:focus {
            outline: none;
            border-color: var(--accent-blue);
        }
        
        .config-actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border-color);
            flex-wrap: wrap;
        }
        
        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 1rem;
            margin-bottom: 1.5rem;
        }
        
        .stat-card {
            background: var(--bg-secondary);
            padding: 1.5rem;
            border-radius: var(--radius-lg);
            border-left: 4px solid var(--accent-blue);
            transition: transform var(--transition-normal), box-shadow var(--transition-normal);
            cursor: pointer;
        }
        
        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-lg);
        }
        
        .stat-card.green { border-left-color: var(--accent-green); }
        .stat-card.amber { border-left-color: var(--accent-amber); }
        .stat-card.purple { border-left-color: var(--accent-purple); }
        .stat-card.red { border-left-color: var(--accent-red); }
        
        .stat-label {
            color: var(--text-muted);
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--text-primary);
            line-height: 1;
        }
        
        .stat-sub {
            color: var(--text-dim);
            font-size: 0.75rem;
            margin-top: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .stat-trend {
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            font-weight: 500;
        }
        
        .stat-trend.up { color: var(--accent-green); }
        .stat-trend.down { color: var(--accent-red); }
        
        /* Content Layout */
        .content-grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 1.5rem;
        }
        
        @media (max-width: 1200px) {
            .content-grid { grid-template-columns: 1fr; }
        }
        
        /* Panel */
        .panel {
            background: var(--bg-secondary);
            border-radius: var(--radius-lg);
            overflow: hidden;
        }
        
        .panel-header {
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .panel-title {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 1rem;
        }
        
        .panel-actions {
            display: flex;
            gap: 0.5rem;
        }
        
        .panel-body {
            padding: 1.5rem;
        }
        
        /* Search & Filter Bar */
        .filter-bar {
            display: flex;
            gap: 1rem;
            margin-bottom: 1rem;
            flex-wrap: wrap;
        }
        
        .search-input {
            flex: 1;
            min-width: 200px;
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 0.625rem 1rem;
            border-radius: var(--radius-md);
            font-size: 0.875rem;
            transition: border-color var(--transition-fast);
        }
        
        .search-input:focus {
            outline: none;
            border-color: var(--accent-blue);
        }
        
        .search-input::placeholder {
            color: var(--text-dim);
        }
        
        /* Review List */
        .review-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }
        
        .review-item {
            background: var(--bg-input);
            padding: 1rem;
            border-radius: var(--radius-md);
            border-left: 3px solid var(--accent-green);
            transition: all var(--transition-fast);
            cursor: pointer;
        }
        
        .review-item:hover {
            background: var(--bg-tertiary);
            transform: translateX(4px);
        }
        
        .review-item.partial { border-left-color: var(--accent-amber); }
        .review-item.failed { border-left-color: var(--accent-red); }
        .review-item.pending { border-left-color: var(--text-muted); }
        
        .review-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 0.5rem;
            gap: 1rem;
        }
        
        .review-title {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.9375rem;
            word-break: break-all;
        }
        
        .review-title a {
            color: #60a5fa;
            text-decoration: none;
            transition: color var(--transition-fast);
        }
        
        .review-title a:hover {
            color: #93c5fd;
            text-decoration: underline;
        }
        
        .review-cost {
            color: var(--accent-green);
            font-weight: 600;
            font-size: 0.9375rem;
            white-space: nowrap;
        }
        
        .review-meta {
            color: var(--text-dim);
            font-size: 0.75rem;
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            align-items: center;
        }
        
        .review-meta span {
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
        }
        
        /* Provider Badge */
        .provider-badge {
            display: inline-flex;
            align-items: center;
            padding: 0.25rem 0.75rem;
            background: var(--bg-tertiary);
            border-radius: 9999px;
            font-size: 0.75rem;
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        /* Provider Stats */
        .provider-stats-list {
            display: flex;
            flex-direction: column;
        }
        
        .provider-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.875rem 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .provider-row:last-child { border-bottom: none; }
        
        .provider-info {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
        }
        
        .provider-name {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.875rem;
        }
        
        .provider-bar {
            width: 100px;
            height: 4px;
            background: var(--bg-tertiary);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 0.25rem;
        }
        
        .provider-bar-fill {
            height: 100%;
            background: var(--accent-blue);
            border-radius: 2px;
            transition: width var(--transition-normal);
        }
        
        .provider-numbers {
            text-align: right;
            color: var(--text-muted);
            font-size: 0.75rem;
        }
        
        .provider-cost {
            color: var(--text-primary);
            font-weight: 600;
            font-size: 0.875rem;
        }
        
        /* Chart Container */
        .chart-container {
            height: 250px;
            margin-bottom: 1.5rem;
            background: var(--bg-input);
            border-radius: var(--radius-md);
            padding: 1rem;
            position: relative;
            overflow: hidden;
        }
        
        .chart-svg {
            width: 100%;
            height: 100%;
        }
        
        .chart-bar {
            fill: var(--accent-blue);
            opacity: 0.8;
            transition: opacity var(--transition-fast);
            cursor: pointer;
        }
        
        .chart-bar:hover {
            opacity: 1;
        }
        
        .chart-line {
            fill: none;
            stroke: var(--accent-green);
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        
        .chart-dot {
            fill: var(--accent-green);
            stroke: var(--bg-input);
            stroke-width: 2;
            r: 4;
            cursor: pointer;
            transition: r var(--transition-fast);
        }
        
        .chart-dot:hover {
            r: 6;
        }
        
        .chart-axis {
            stroke: var(--border-color);
            stroke-width: 1;
        }
        
        .chart-axis-text {
            fill: var(--text-dim);
            font-size: 10px;
            font-family: inherit;
        }
        
        .chart-grid {
            stroke: var(--bg-tertiary);
            stroke-width: 1;
            stroke-dasharray: 4;
        }
        
        /* Loading Skeleton */
        .skeleton {
            background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--border-color) 50%, var(--bg-tertiary) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
            border-radius: var(--radius-md);
        }
        
        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        
        .skeleton-text {
            height: 1em;
            margin-bottom: 0.5rem;
        }
        
        .skeleton-title {
            height: 1.25em;
            width: 60%;
            margin-bottom: 1rem;
        }
        
        /* Toast Notifications */
        .toast-container {
            position: fixed;
            top: 1rem;
            right: 1rem;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        
        .toast {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-left: 3px solid var(--accent-blue);
            border-radius: var(--radius-md);
            padding: 1rem 1.5rem;
            box-shadow: var(--shadow-lg);
            color: var(--text-secondary);
            font-size: 0.875rem;
            min-width: 300px;
            max-width: 400px;
            animation: slideIn 300ms ease;
        }
        
        .toast.success { border-left-color: var(--accent-green); }
        .toast.error { border-left-color: var(--accent-red); }
        .toast.warning { border-left-color: var(--accent-amber); }
        
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        .toast-exit {
            animation: slideOut 300ms ease forwards;
        }
        
        @keyframes slideOut {
            to {
                transform: translateX(100%);
                opacity: 0;
            }
        }
        
        /* Error State */
        .error-state {
            background: var(--accent-red-bg);
            color: var(--accent-red-text);
            padding: 1rem;
            border-radius: var(--radius-md);
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        
        .error-state button {
            margin-left: auto;
            background: var(--accent-red);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 0.875rem;
        }
        
        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 3rem;
            color: var(--text-dim);
        }
        
        .empty-state-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            opacity: 0.5;
        }
        
        /* Loading State */
        .loading-state {
            text-align: center;
            padding: 3rem;
            color: var(--text-dim);
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--bg-tertiary);
            border-top-color: var(--accent-blue);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1rem;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        /* Modal */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(15, 23, 42, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            opacity: 0;
            visibility: hidden;
            transition: all var(--transition-normal);
        }
        
        .modal-overlay.active {
            opacity: 1;
            visibility: visible;
        }
        
        .modal {
            background: var(--bg-secondary);
            border-radius: var(--radius-xl);
            width: 90%;
            max-width: 800px;
            max-height: 90vh;
            overflow: hidden;
            transform: scale(0.95);
            transition: transform var(--transition-normal);
        }
        
        .modal-overlay.active .modal {
            transform: scale(1);
        }
        
        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .modal-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .modal-close {
            background: none;
            border: none;
            color: var(--text-muted);
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0.25rem;
            line-height: 1;
            transition: color var(--transition-fast);
        }
        
        .modal-close:hover {
            color: var(--text-primary);
        }
        
        .modal-body {
            padding: 1.5rem;
            overflow-y: auto;
            max-height: calc(90vh - 80px);
        }
        
        /* Pagination */
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 0.5rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border-color);
        }
        
        .pagination-btn {
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 0.5rem 0.75rem;
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 0.875rem;
            min-width: 36px;
            transition: all var(--transition-fast);
        }
        
        .pagination-btn:hover:not(:disabled) {
            background: var(--bg-tertiary);
            border-color: var(--text-muted);
        }
        
        .pagination-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .pagination-btn.active {
            background: var(--accent-blue);
            border-color: var(--accent-blue);
            color: white;
        }
        
        /* Help Modal Content */
        .help-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
        }
        
        .help-section h3 {
            color: var(--text-primary);
            font-size: 0.875rem;
            margin-bottom: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .help-item {
            display: flex;
            justify-content: space-between;
            padding: 0.5rem 0;
            border-bottom: 1px solid var(--border-color);
            font-size: 0.875rem;
        }
        
        .help-item:last-child {
            border-bottom: none;
        }
        
        .help-key {
            font-family: 'Monaco', 'Consolas', monospace;
            background: var(--bg-tertiary);
            padding: 0.125rem 0.5rem;
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
        }
        
        /* Responsive */
        @media (max-width: 768px) {
            .header {
                padding: 1rem;
            }
            
            .header h1 {
                font-size: 1rem;
            }
            
            .keyboard-hint,
            .auto-refresh-toggle {
                display: none;
            }
            
            .container {
                padding: 1rem;
            }
            
            .config-grid {
                grid-template-columns: 1fr;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .stat-value {
                font-size: 1.5rem;
            }
            
            .content-grid {
                grid-template-columns: 1fr;
            }
            
            .review-header {
                flex-direction: column;
                gap: 0.5rem;
            }
        }
        
        @media (max-width: 480px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
        }
        
        /* Print Styles */
        @media print {
            .header,
            .config-panel,
            .panel-actions,
            .toast-container,
            .modal-overlay {
                display: none !important;
            }
            
            body {
                background: white;
                color: black;
            }
            
            .panel {
                break-inside: avoid;
                border: 1px solid #ddd;
            }
        }
    </style>
</head>
<body>
    <header class="header" role="banner">
        <div class="header-left">
            <h1>📊 Code Reviewer Dashboard</h1>
            <span class="keyboard-hint">Press ? for help</span>
        </div>
        <div class="header-right">
            <label class="auto-refresh-toggle" title="Toggle auto-refresh">
                <input type="checkbox" id="autoRefresh" checked>
                <span>Auto-refresh</span>
            </label>
            <button class="btn btn-icon" onclick="showHelpModal()" title="Help (?)">❓</button>
            <form method="POST" action="/dashboard/logout">
                <button type="submit" class="btn">Logout</button>
            </form>
        </div>
    </header>

    <main class="container">
        <!-- Configuration Panel -->
        <section class="config-panel" aria-labelledby="config-title">
            <div class="config-header">
                <span class="config-title" id="config-title">Configuration</span>
            </div>
            <div class="config-body">
                <div class="config-grid">
                    <div class="config-group">
                        <label for="owner">Repository Owner</label>
                        <input type="text" id="owner" placeholder="e.g., facebook" autocomplete="off">
                    </div>
                    <div class="config-group">
                        <label for="repo">Repository Name</label>
                        <input type="text" id="repo" placeholder="e.g., react" autocomplete="off">
                    </div>
                    <div class="config-group">
                        <label for="startDate">Start Date</label>
                        <input type="date" id="startDate">
                    </div>
                    <div class="config-group">
                        <label for="endDate">End Date</label>
                        <input type="date" id="endDate">
                    </div>
                    <div class="config-group">
                        <label for="limit">Reviews Limit</label>
                        <select id="limit">
                            <option value="10">10</option>
                            <option value="20" selected>20</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                        </select>
                    </div>
                    <div class="config-group">
                        <label for="sortBy">Sort By</label>
                        <select id="sortBy">
                            <option value="newest">Newest First</option>
                            <option value="oldest">Oldest First</option>
                            <option value="cost-desc">Cost (High to Low)</option>
                            <option value="cost-asc">Cost (Low to High)</option>
                            <option value="tokens-desc">Tokens (High to Low)</option>
                        </select>
                    </div>
                </div>
                <div class="config-actions">
                    <button class="btn btn-primary" onclick="loadData()">
                        🔄 Load Data
                    </button>
                    <button class="btn" onclick="exportData('csv')">
                        📥 Export CSV
                    </button>
                    <button class="btn" onclick="exportData('json')">
                        📄 Export JSON
                    </button>
                    <button class="btn" onclick="clearFilters()">
                        ❌ Clear
                    </button>
                </div>
            </div>
        </section>

        <!-- Error Container -->
        <div id="errorContainer"></div>

        <!-- Loading State -->
        <div id="loadingState" class="loading-state" style="display: none;">
            <div class="spinner"></div>
            <p>Loading usage data...</p>
        </div>

        <!-- Stats Grid -->
        <div id="statsSection" style="display: none;">
            <div class="stats-grid" id="statsGrid"></div>

            <div class="content-grid">
                <!-- Main Content -->
                <section class="panel" aria-labelledby="reviews-title">
                    <div class="panel-header">
                        <h2 class="panel-title" id="reviews-title">Reviews</h2>
                        <div class="panel-actions">
                            <input 
                                type="text" 
                                class="search-input" 
                                id="searchInput" 
                                placeholder="🔍 Search PRs..."
                                autocomplete="off"
                            >
                        </div>
                    </div>
                    <div class="panel-body">
                        <div class="chart-container" id="costChart">
                            <svg class="chart-svg" id="costChartSvg"></svg>
                        </div>
                        <div id="reviewsList" class="review-list"></div>
                        <div class="pagination" id="pagination"></div>
                    </div>
                </section>

                <!-- Sidebar -->
                <aside class="panel" aria-labelledby="sidebar-title">
                    <div class="panel-header">
                        <h2 class="panel-title" id="sidebar-title">Overview</h2>
                    </div>
                    <div class="panel-body">
                        <div class="chart-container" id="providerChart" style="height: 180px;">
                            <svg class="chart-svg" id="providerChartSvg"></svg>
                        </div>
                        <div id="byProvider" class="provider-stats-list"></div>
                    </div>
                </aside>
            </div>
        </div>

        <!-- Empty State -->
        <div id="emptyState" class="empty-state" style="display: none;">
            <div class="empty-state-icon">📊</div>
            <p>Enter a repository owner and name to view usage data</p>
        </div>
    </main>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Help Modal -->
    <div class="modal-overlay" id="helpModal" onclick="hideHelpModal(event)">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2 class="modal-title">⌨️ Keyboard Shortcuts</h2>
                <button class="modal-close" onclick="hideHelpModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="help-grid">
                    <div class="help-section">
                        <h3>Navigation</h3>
                        <div class="help-item">
                            <span>Show this help</span>
                            <kbd class="help-key">?</kbd>
                        </div>
                        <div class="help-item">
                            <span>Focus search</span>
                            <kbd class="help-key">/</kbd>
                        </div>
                        <div class="help-item">
                            <span>Load data</span>
                            <kbd class="help-key">Ctrl + Enter</kbd>
                        </div>
                    </div>
                    <div class="help-section">
                        <h3>Actions</h3>
                        <div class="help-item">
                            <span>Export CSV</span>
                            <kbd class="help-key">Ctrl + S</kbd>
                        </div>
                        <div class="help-item">
                            <span>Clear filters</span>
                            <kbd class="help-key">Esc</kbd>
                        </div>
                        <div class="help-item">
                            <span>Toggle auto-refresh</span>
                            <kbd class="help-key">R</kbd>
                        </div>
                    </div>
                    <div class="help-section">
                        <h3>Review List</h3>
                        <div class="help-item">
                            <span>Next page</span>
                            <kbd class="help-key">j</kbd>
                        </div>
                        <div class="help-item">
                            <span>Previous page</span>
                            <kbd class="help-key">k</kbd>
                        </div>
                        <div class="help-item">
                            <span>First page</span>
                            <kbd class="help-key">g + g</kbd>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Detail Modal -->
    <div class="modal-overlay" id="detailModal" onclick="hideDetailModal(event)">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2 class="modal-title" id="detailTitle">Review Details</h2>
                <button class="modal-close" onclick="hideDetailModal()">&times;</button>
            </div>
            <div class="modal-body" id="detailContent"></div>
        </div>
    </div>

    <script>
        /**
         * Dashboard State Management
         */
        const state = {
            reviews: [],
            filteredReviews: [],
            stats: null,
            currentPage: 1,
            pageSize: 10,
            autoRefresh: true,
            refreshInterval: null,
            isLoading: false,
            lastLoadTime: null,
            chartData: null
        };

        const CONFIG = {
            REFRESH_INTERVAL: 60000, // 60 seconds
            DEBOUNCE_DELAY: 300,
            MAX_PAGES_SHOWN: 5
        };

        /**
         * Initialize Dashboard
         */
        document.addEventListener('DOMContentLoaded', () => {
            initializeDates();
            setupEventListeners();
            setupKeyboardShortcuts();
            
            // Load from URL params if present
            loadFromUrlParams();
        });

        function initializeDates() {
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);
            
            document.getElementById('endDate').value = formatDateForInput(endDate);
            document.getElementById('startDate').value = formatDateForInput(startDate);
        }

        function formatDateForInput(date) {
            return date.toISOString().split('T')[0];
        }

        function setupEventListeners() {
            // Auto-refresh toggle
            document.getElementById('autoRefresh').addEventListener('change', (e) => {
                state.autoRefresh = e.target.checked;
                if (state.autoRefresh) {
                    startAutoRefresh();
                } else {
                    stopAutoRefresh();
                }
            });

            // Search with debounce
            const searchInput = document.getElementById('searchInput');
            let debounceTimer;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    filterReviews(e.target.value);
                }, CONFIG.DEBOUNCE_DELAY);
            });

            // Enter to load
            document.getElementById('owner').addEventListener('keypress', handleEnter);
            document.getElementById('repo').addEventListener('keypress', handleEnter);
        }

        function handleEnter(e) {
            if (e.key === 'Enter') {
                loadData();
            }
        }

        function setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Ignore if in input
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
                    if (e.key === 'Escape') {
                        e.target.blur();
                    }
                    return;
                }

                switch (e.key) {
                    case '?':
                        e.preventDefault();
                        showHelpModal();
                        break;
                    case '/':
                        e.preventDefault();
                        document.getElementById('searchInput').focus();
                        break;
                    case 'r':
                    case 'R':
                        const checkbox = document.getElementById('autoRefresh');
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                        showToast('Auto-refresh ' + (checkbox.checked ? 'enabled' : 'disabled'), 'info');
                        break;
                    case 'j':
                        nextPage();
                        break;
                    case 'k':
                        prevPage();
                        break;
                    case 'Escape':
                        hideHelpModal();
                        hideDetailModal();
                        break;
                }

                // Ctrl/Cmd shortcuts
                if (e.ctrlKey || e.metaKey) {
                    switch (e.key) {
                        case 'Enter':
                            e.preventDefault();
                            loadData();
                            break;
                        case 's':
                            e.preventDefault();
                            exportData('csv');
                            break;
                    }
                }
            });
        }

        function loadFromUrlParams() {
            const params = new URLSearchParams(window.location.search);
            const owner = params.get('owner');
            const repo = params.get('repo');
            
            if (owner && repo) {
                document.getElementById('owner').value = owner;
                document.getElementById('repo').value = repo;
                loadData();
            }
        }

        /**
         * Data Loading
         */
        async function loadData() {
            const owner = document.getElementById('owner').value.trim();
            const repo = document.getElementById('repo').value.trim();
            
            if (!owner || !repo) {
                showToast('Please enter repository owner and name', 'warning');
                return;
            }

            // Update URL
            const url = new URL(window.location);
            url.searchParams.set('owner', owner);
            url.searchParams.set('repo', repo);
            window.history.replaceState({}, '', url);

            state.isLoading = true;
            showLoading(true);
            hideError();

            try {
                const limit = document.getElementById('limit').value;
                const [stats, reviews] = await Promise.all([
                    fetchWithErrorHandling(\`/usage/\${owner}/\${repo}/stats\`),
                    fetchWithErrorHandling(\`/usage/\${owner}/\${repo}?limit=\${limit}\`)
                ]);

                state.stats = stats;
                state.reviews = reviews;
                state.filteredReviews = filterByDateRange(reviews);
                state.currentPage = 1;
                state.lastLoadTime = new Date();

                applySorting();
                displayStats(stats);
                displayReviews();
                renderCharts();
                
                showLoading(false);
                document.getElementById('statsSection').style.display = 'block';
                document.getElementById('emptyState').style.display = 'none';

                // Start auto-refresh
                if (state.autoRefresh) {
                    startAutoRefresh();
                }

                showToast(\`Loaded \${reviews.length} reviews\`, 'success');
            } catch (err) {
                showLoading(false);
                showError('Failed to load data: ' + err.message);
                showToast('Error loading data', 'error');
            } finally {
                state.isLoading = false;
            }
        }

        function filterByDateRange(reviews) {
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            
            if (!startDate && !endDate) return reviews;
            
            const start = startDate ? new Date(startDate) : new Date(0);
            const end = endDate ? new Date(endDate) : new Date();
            end.setHours(23, 59, 59, 999);
            
            return reviews.filter(r => {
                const reviewDate = new Date(r.startTime);
                return reviewDate >= start && reviewDate <= end;
            });
        }

        function applySorting() {
            const sortBy = document.getElementById('sortBy').value;
            
            state.filteredReviews.sort((a, b) => {
                switch (sortBy) {
                    case 'newest':
                        return new Date(b.startTime) - new Date(a.startTime);
                    case 'oldest':
                        return new Date(a.startTime) - new Date(b.startTime);
                    case 'cost-desc':
                        return b.estimatedCost - a.estimatedCost;
                    case 'cost-asc':
                        return a.estimatedCost - b.estimatedCost;
                    case 'tokens-desc':
                        return b.totalTokens - a.totalTokens;
                    default:
                        return 0;
                }
            });
        }

        /**
         * Display Functions
         */
        function displayStats(stats) {
            const grid = document.getElementById('statsGrid');
            const totalCost = stats.totalCost || 0;
            const avgCost = stats.avgCostPerReview || 0;
            const totalTokens = stats.totalTokens || 0;
            const avgTokens = stats.avgTokensPerReview || 0;
            
            grid.innerHTML = \`
                <div class="stat-card" onclick="scrollToReviews()">
                    <div class="stat-label">📋 Total Reviews</div>
                    <div class="stat-value">\${formatNumber(stats.totalReviews || 0)}</div>
                    <div class="stat-sub">Across all providers</div>
                </div>
                <div class="stat-card amber">
                    <div class="stat-label">💰 Total Cost</div>
                    <div class="stat-value">$\${totalCost.toFixed(2)}</div>
                    <div class="stat-sub">Avg $\${avgCost.toFixed(4)}/review</div>
                </div>
                <div class="stat-card green">
                    <div class="stat-label">🪙 Total Tokens</div>
                    <div class="stat-value">\${formatNumber(totalTokens)}</div>
                    <div class="stat-sub">Avg \${formatNumber(Math.round(avgTokens))}/review</div>
                </div>
                <div class="stat-card purple">
                    <div class="stat-label">⏱️ Avg Duration</div>
                    <div class="stat-value">\${formatDuration(stats.avgDurationMs)}</div>
                    <div class="stat-sub">Per review</div>
                </div>
            \`;
        }

        function displayReviews() {
            const container = document.getElementById('reviewsList');
            const start = (state.currentPage - 1) * state.pageSize;
            const end = start + state.pageSize;
            const pageReviews = state.filteredReviews.slice(start, end);
            
            if (pageReviews.length === 0) {
                container.innerHTML = '<div class="empty-state">No reviews found</div>';
                renderPagination(0);
                return;
            }
            
            container.innerHTML = pageReviews.map(review => renderReviewItem(review)).join('');
            renderPagination(state.filteredReviews.length);
        }

        function renderReviewItem(review) {
            const date = new Date(review.startTime).toLocaleString();
            const duration = formatDuration(review.durationMs);
            
            return \`
                <article class="review-item \${review.status}" onclick="showReviewDetail('\${review.prNumber}')">
                    <div class="review-header">
                        <div class="review-title">
                            <a href="https://github.com/\${review.repository}/pull/\${review.prNumber}" 
                               target="_blank" 
                               rel="noopener noreferrer"
                               onclick="event.stopPropagation()">
                                PR #\${review.prNumber}
                            </a>
                        </div>
                        <div class="review-cost">$\${review.estimatedCost.toFixed(4)}</div>
                    </div>
                    <div class="review-meta">
                        <span>📅 \${date}</span>
                        <span>⏱️ \${duration}</span>
                        <span>🪙 \${formatNumber(review.totalTokens)} tokens</span>
                        <span>📁 \${review.filesReviewed} files</span>
                        <span>📝 \${review.findingsCount} findings</span>
                        <span class="provider-badge">\${review.provider}</span>
                    </div>
                </article>
            \`;
        }

        function renderPagination(totalItems) {
            const totalPages = Math.ceil(totalItems / state.pageSize);
            const container = document.getElementById('pagination');
            
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }
            
            let html = '';
            
            // Prev button
            html += \`<button class="pagination-btn" onclick="goToPage(\${state.currentPage - 1})" \${state.currentPage === 1 ? 'disabled' : ''}>←</button>\`;
            
            // Page numbers
            let startPage = Math.max(1, state.currentPage - Math.floor(CONFIG.MAX_PAGES_SHOWN / 2));
            let endPage = Math.min(totalPages, startPage + CONFIG.MAX_PAGES_SHOWN - 1);
            
            if (endPage - startPage < CONFIG.MAX_PAGES_SHOWN - 1) {
                startPage = Math.max(1, endPage - CONFIG.MAX_PAGES_SHOWN + 1);
            }
            
            if (startPage > 1) {
                html += '<button class="pagination-btn" onclick="goToPage(1)">1</button>';
                if (startPage > 2) html += '<span>...</span>';
            }
            
            for (let i = startPage; i <= endPage; i++) {
                html += \`<button class="pagination-btn \${i === state.currentPage ? 'active' : ''}" onclick="goToPage(\${i})">\${i}</button>\`;
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) html += '<span>...</span>';
                html += \`<button class="pagination-btn" onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
            }
            
            // Next button
            html += \`<button class="pagination-btn" onclick="goToPage(\${state.currentPage + 1})" \${state.currentPage === totalPages ? 'disabled' : ''}>→</button>\`;
            
            container.innerHTML = html;
        }

        function goToPage(page) {
            const totalPages = Math.ceil(state.filteredReviews.length / state.pageSize);
            if (page < 1 || page > totalPages) return;
            
            state.currentPage = page;
            displayReviews();
            document.getElementById('reviewsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function nextPage() {
            goToPage(state.currentPage + 1);
        }

        function prevPage() {
            goToPage(state.currentPage - 1);
        }

        /**
         * Chart Rendering (SVG)
         */
        function renderCharts() {
            renderCostChart();
            renderProviderChart();
        }

        function renderCostChart() {
            const svg = document.getElementById('costChartSvg');
            const width = svg.clientWidth || 600;
            const height = svg.clientHeight || 250;
            const padding = { top: 20, right: 30, bottom: 40, left: 50 };
            
            // Prepare data - group by date
            const data = state.filteredReviews.reduce((acc, review) => {
                const date = new Date(review.startTime).toLocaleDateString();
                acc[date] = (acc[date] || 0) + review.estimatedCost;
                return acc;
            }, {});
            
            const entries = Object.entries(data).sort((a, b) => new Date(a[0]) - new Date(b[0]));
            if (entries.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#64748b">No data available</text>';
                return;
            }
            
            const maxCost = Math.max(...entries.map(e => e[1]));
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;
            
            const barWidth = Math.max(10, chartWidth / entries.length - 2);
            
            let html = '';
            
            // Grid lines
            for (let i = 0; i <= 5; i++) {
                const y = padding.top + (chartHeight * i / 5);
                html += \`<line class="chart-grid" x1="\${padding.left}" y1="\${y}" x2="\${width - padding.right}" y2="\${y}" />\`;
                html += \`<text class="chart-axis-text" x="\${padding.left - 10}" y="\${y + 3}" text-anchor="end">\$\${(maxCost * (5 - i) / 5).toFixed(1)}</text>\`;
            }
            
            // Bars
            entries.forEach((entry, i) => {
                const [date, cost] = entry;
                const x = padding.left + i * (chartWidth / entries.length) + (chartWidth / entries.length - barWidth) / 2;
                const barHeight = (cost / maxCost) * chartHeight;
                const y = padding.top + chartHeight - barHeight;
                
                html += \`<rect class="chart-bar" x="\${x}" y="\${y}" width="\${barWidth}" height="\${barHeight}" data-date="\${date}" data-cost="\${cost.toFixed(2)}" />\`;
            });
            
            // X-axis labels (show every nth label if many)
            const labelInterval = Math.ceil(entries.length / 10);
            entries.forEach((entry, i) => {
                if (i % labelInterval === 0) {
                    const x = padding.left + i * (chartWidth / entries.length) + chartWidth / entries.length / 2;
                    const date = new Date(entry[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    html += \`<text class="chart-axis-text" x="\${x}" y="\${height - 10}" text-anchor="middle" transform="rotate(-45, \${x}, \${height - 10})">\${date}</text>\`;
                }
            });
            
            svg.innerHTML = html;
        }

        function renderProviderChart() {
            const container = document.getElementById('byProvider');
            const stats = state.stats;
            
            if (!stats || !stats.byProvider) {
                container.innerHTML = '<div class="empty-state">No provider data</div>';
                return;
            }
            
            const providers = Object.entries(stats.byProvider);
            const maxCost = Math.max(...providers.map(([, data]) => data.cost));
            
            container.innerHTML = providers.map(([name, data]) => {
                const percentage = (data.cost / maxCost) * 100;
                
                return \`
                    <div class="provider-row">
                        <div class="provider-info">
                            <span class="provider-name">\${name}</span>
                            <div class="provider-bar">
                                <div class="provider-bar-fill" style="width: \${percentage}%"></div>
                            </div>
                        </div>
                        <div class="provider-numbers">
                            <div class="provider-cost">$\${data.cost.toFixed(2)}</div>
                            <div>\${data.reviews} reviews</div>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        /**
         * Filtering & Search
         */
        function filterReviews(query) {
            if (!query) {
                state.filteredReviews = filterByDateRange(state.reviews);
            } else {
                const lowerQuery = query.toLowerCase();
                state.filteredReviews = state.reviews.filter(r => {
                    return r.prNumber.toString().includes(lowerQuery) ||
                           r.repository?.toLowerCase().includes(lowerQuery) ||
                           r.provider?.toLowerCase().includes(lowerQuery);
                });
                state.filteredReviews = filterByDateRange(state.filteredReviews);
            }
            
            state.currentPage = 1;
            applySorting();
            displayReviews();
        }

        function clearFilters() {
            document.getElementById('owner').value = '';
            document.getElementById('repo').value = '';
            document.getElementById('searchInput').value = '';
            initializeDates();
            
            document.getElementById('statsSection').style.display = 'none';
            document.getElementById('emptyState').style.display = 'block';
            
            // Clear URL params
            window.history.replaceState({}, '', window.location.pathname);
            
            stopAutoRefresh();
            showToast('Filters cleared', 'info');
        }

        /**
         * Auto-refresh
         */
        function startAutoRefresh() {
            stopAutoRefresh();
            if (state.autoRefresh && state.stats) {
                state.refreshInterval = setInterval(() => {
                    if (!state.isLoading) {
                        loadData();
                    }
                }, CONFIG.REFRESH_INTERVAL);
            }
        }

        function stopAutoRefresh() {
            if (state.refreshInterval) {
                clearInterval(state.refreshInterval);
                state.refreshInterval = null;
            }
        }

        /**
         * Data Export
         */
        function exportData(format) {
            if (!state.reviews || state.reviews.length === 0) {
                showToast('No data to export', 'warning');
                return;
            }
            
            const data = state.filteredReviews;
            const timestamp = new Date().toISOString().split('T')[0];
            const filename = \`code-reviewer-\${document.getElementById('owner').value}-\${document.getElementById('repo').value}-\${timestamp}\`;
            
            if (format === 'csv') {
                exportCSV(data, filename);
            } else if (format === 'json') {
                exportJSON(data, filename);
            }
        }

        function exportCSV(data, filename) {
            const headers = ['PR Number', 'Date', 'Provider', 'Cost', 'Tokens', 'Files', 'Findings', 'Duration (ms)', 'Status'];
            const rows = data.map(r => [
                r.prNumber,
                new Date(r.startTime).toISOString(),
                r.provider,
                r.estimatedCost.toFixed(4),
                r.totalTokens,
                r.filesReviewed,
                r.findingsCount,
                r.durationMs,
                r.status
            ]);
            
            const csv = [headers, ...rows]
                .map(row => row.map(cell => \`"\${cell}"\`).join(','))
                .join('\\n');
            
            downloadFile(csv, \`\${filename}.csv\`, 'text/csv');
            showToast(\`Exported \${data.length} reviews to CSV\`, 'success');
        }

        function exportJSON(data, filename) {
            const json = JSON.stringify(data, null, 2);
            downloadFile(json, \`\${filename}.json\`, 'application/json');
            showToast(\`Exported \${data.length} reviews to JSON\`, 'success');
        }

        function downloadFile(content, filename, type) {
            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        /**
         * Detail Modal
         */
        function showReviewDetail(prNumber) {
            const review = state.reviews.find(r => r.prNumber.toString() === prNumber);
            if (!review) return;
            
            const content = document.getElementById('detailContent');
            const title = document.getElementById('detailTitle');
            
            title.textContent = \`PR #\${review.prNumber} Details\`;
            content.innerHTML = \`
                <div style="display: grid; gap: 1rem;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                        <div>
                            <strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Repository</strong>
                            <p>\${review.repository}</p>
                        </div>
                        <div>
                            <strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Provider</strong>
                            <p>\${review.provider}</p>
                        </div>
                        <div>
                            <strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Status</strong>
                            <p><span class="provider-badge">\${review.status}</span></p>
                        </div>
                        <div>
                            <strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Cost</strong>
                            <p style="color: var(--accent-green); font-weight: 600;">$\${review.estimatedCost.toFixed(4)}</p>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; padding: 1rem; background: var(--bg-primary); border-radius: var(--radius-md);">
                        <div style="text-align: center;">
                            <div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">\${formatNumber(review.totalTokens)}</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted);">Tokens</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">\${review.filesReviewed}</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted);">Files</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">\${review.findingsCount}</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted);">Findings</div>
                        </div>
                    </div>
                    <div>
                        <strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Timeline</strong>
                        <p>Started: \${new Date(review.startTime).toLocaleString()}</p>
                        <p>Duration: \${formatDuration(review.durationMs)}</p>
                    </div>
                    <div>
                        <a href="https://github.com/\${review.repository}/pull/\${review.prNumber}" 
                           target="_blank" 
                           class="btn btn-primary"
                           style="display: inline-flex; text-decoration: none;">
                            🔗 Open on GitHub
                        </a>
                    </div>
                </div>
            \`;
            
            document.getElementById('detailModal').classList.add('active');
        }

        function hideDetailModal(e) {
            if (!e || e.target.id === 'detailModal') {
                document.getElementById('detailModal').classList.remove('active');
            }
        }

        /**
         * Help Modal
         */
        function showHelpModal() {
            document.getElementById('helpModal').classList.add('active');
        }

        function hideHelpModal(e) {
            if (!e || e.target.id === 'helpModal') {
                document.getElementById('helpModal').classList.remove('active');
            }
        }

        /**
         * Toast Notifications
         */
        function showToast(message, type = 'info', duration = 3000) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = \`toast \${type}\`;
            toast.textContent = message;
            container.appendChild(toast);
            
            setTimeout(() => {
                toast.classList.add('toast-exit');
                toast.addEventListener('animationend', () => {
                    toast.remove();
                });
            }, duration);
        }

        /**
         * Error Handling
         */
        function showError(message) {
            const container = document.getElementById('errorContainer');
            container.innerHTML = \`
                <div class="error-state" role="alert">
                    <span>⚠️ \${escapeHtml(message)}</span>
                    <button onclick="retryLoad()">🔄 Retry</button>
                </div>
            \`;
        }

        function hideError() {
            document.getElementById('errorContainer').innerHTML = '';
        }

        function retryLoad() {
            hideError();
            loadData();
        }

        function showLoading(show) {
            document.getElementById('loadingState').style.display = show ? 'block' : 'none';
        }

        /**
         * Utilities
         */
        function formatNumber(num) {
            if (!num) return '0';
            return num.toLocaleString();
        }

        function formatDuration(ms) {
            if (!ms) return '-';
            const seconds = Math.round(ms / 1000);
            if (seconds < 60) return seconds + 's';
            const minutes = Math.floor(seconds / 60);
            const remaining = seconds % 60;
            return remaining > 0 ? \`\${minutes}m \${remaining}s\` : \`\${minutes}m\`;
        }

        function scrollToReviews() {
            document.getElementById('reviews-title').scrollIntoView({ behavior: 'smooth' });
        }

        /**
         * XSS Protection - Escape HTML entities
         */
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        /**
         * Page Visibility API - Pause auto-refresh when tab hidden
         */
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopAutoRefresh();
            } else if (state.autoRefresh && state.stats) {
                startAutoRefresh();
                // Refresh data if tab was hidden for > 5 minutes
                if (state.lastLoadTime && Date.now() - state.lastLoadTime > 300000) {
                    loadData();
                }
            }
        });

        /**
         * Handle fetch errors with specific HTTP codes
         */
        async function fetchWithErrorHandling(url) {
            const response = await fetch(url);
            
            if (!response.ok) {
                let message = 'Failed to load data';
                switch (response.status) {
                    case 401:
                        message = 'Unauthorized - Invalid API key';
                        break;
                    case 403:
                        message = 'Forbidden - Access denied';
                        break;
                    case 404:
                        message = 'No data found for this repository';
                        break;
                    case 429:
                        const retryAfter = response.headers.get('Retry-After') || '60';
                        message = 'Rate limited - Retry after ' + retryAfter + 's';
                        break;
                    case 500:
                    case 502:
                    case 503:
                        message = 'Server error - Please try again later';
                        break;
                }
                throw new Error(message);
            }
            
            return response.json();
        }
    </script>
</body>
</html>`;
