/**
 * Webhook signature verification using HMAC-SHA256.
 * Uses the Web Crypto API available natively in Cloudflare Workers — no external deps needed.
 */

/**
 * Verifies that an incoming GitHub webhook request was signed with the correct secret.
 *
 * GitHub signs the request body with HMAC-SHA256 and puts the result in the
 * `X-Hub-Signature-256` header as: `sha256=<hex-digest>`
 *
 * @param request  The incoming Request object (body must not have been consumed yet).
 * @param rawBody  The raw request body string (we read it once and pass both here and to the handler).
 * @param secret   The GITHUB_WEBHOOK_SECRET environment variable.
 * @returns        `true` if the signature is valid, `false` otherwise.
 */
export async function verifyWebhookSignature(
    request: Request,
    rawBody: string,
    secret: string
): Promise<boolean> {
    const signature = request.headers.get('X-Hub-Signature-256');
    if (!signature || !signature.startsWith('sha256=')) {
        return false;
    }

    const expectedHex = signature.slice('sha256='.length);

    // Import the secret as a CryptoKey
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    // Sign the raw body
    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(rawBody)
    );

    // Convert to hex string
    const computedHex = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(computedHex, expectedHex);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
