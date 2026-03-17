import type { Env } from '../types/env';

const GITHUB_API_BASE = 'https://api.github.com';

// ---------------------------------------------------------------------------
// PEM → CryptoKey (RS256 / PKCS8)
// ---------------------------------------------------------------------------

/**
 * Parses a PEM-encoded RSA private key into a CryptoKey suitable for RS256 signing.
 * Works natively in Cloudflare Workers via the Web Crypto API (no Node deps).
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
    // Strip PEM armor and whitespace
    const stripped = pem
        .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
        .replace(/-----END RSA PRIVATE KEY-----/g, '')
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s+/g, '');

    if (!stripped) {
        throw new Error(
            '[github-auth] GITHUB_APP_PRIVATE_KEY is empty or malformed. ' +
            'Make sure the full PEM key (including newlines) is set as a Cloudflare secret.'
        );
    }

    let binaryDer: Uint8Array;
    try {
        binaryDer = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
    } catch {
        throw new Error(
            '[github-auth] GITHUB_APP_PRIVATE_KEY contains invalid Base64. ' +
            'Ensure the PEM key is not truncated or corrupted.'
        );
    }

    try {
        return await crypto.subtle.importKey(
            'pkcs8',
            binaryDer.buffer as ArrayBuffer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign']
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
            `[github-auth] Failed to import private key — the key format may be unsupported. ` +
            `Ensure it is a PKCS8-encoded RSA key. Detail: ${errMsg}`
        );
    }
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64url(input: string): string {
    return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// JWT Generation (RS256)
// ---------------------------------------------------------------------------

/**
 * Generates a short-lived JWT for GitHub App authentication (max 10 minutes).
 * Uses the Web Crypto API for RS256 signing — zero external dependencies.
 */
export async function generateAppJWT(appId: string, privateKeyPem: string): Promise<string> {
    if (!appId || !appId.trim()) {
        throw new Error('[github-auth] GITHUB_APP_ID is missing or empty. Set it via `wrangler secret put GITHUB_APP_ID`.');
    }
    if (!privateKeyPem || !privateKeyPem.trim()) {
        throw new Error('[github-auth] GITHUB_APP_PRIVATE_KEY is missing or empty. Set it via `wrangler secret put GITHUB_APP_PRIVATE_KEY`.');
    }

    const now = Math.floor(Date.now() / 1000);

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
        JSON.stringify({
            iat: now - 60,        // Issued at: 60 seconds in the past to handle clock drift
            exp: now + 10 * 60,   // Expiration: 10 minutes (GitHub maximum)
            iss: appId,           // Issuer: the App ID
        })
    );

    const signingInput = `${header}.${payload}`;
    const key = await importPrivateKey(privateKeyPem);

    let signatureBuffer: ArrayBuffer;
    try {
        signatureBuffer = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            new TextEncoder().encode(signingInput)
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`[github-auth] JWT signing failed: ${errMsg}`);
    }

    return `${signingInput}.${base64urlFromBuffer(signatureBuffer)}`;
}

// ---------------------------------------------------------------------------
// Installation Token
// ---------------------------------------------------------------------------

interface InstallationTokenResponse {
    token: string;
    expires_at: string;
}

/**
 * Exchanges a GitHub App JWT for a short-lived installation access token.
 * This token is used for all subsequent GitHub API calls and expires after 1 hour.
 */
export async function getInstallationToken(env: Env): Promise<string> {
    if (!env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_INSTALLATION_ID.trim()) {
        throw new Error(
            '[github-auth] GITHUB_APP_INSTALLATION_ID is missing. ' +
            'Set it via `wrangler secret put GITHUB_APP_INSTALLATION_ID`.'
        );
    }

    const jwt = await generateAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

    let response: Response;
    try {
        response = await fetch(
            `${GITHUB_API_BASE}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'code-reviewer-agent/1.0',
                },
            }
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
            `[github-auth] Network error while requesting installation token: ${errMsg}`
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `[github-auth] GitHub rejected the installation token request ` +
            `(HTTP ${response.status}): ${errorText}`
        );
    }

    const data: InstallationTokenResponse = await response.json();
    console.log(`[github-auth] ✓ Installation token obtained, expires at ${data.expires_at}`);
    return data.token;
}
