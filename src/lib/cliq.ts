import { logger } from './logger';
import type { FindingSeverity } from '../types/review';

/**
 * Defines the strict expected payload structure for Zoho Cliq Bot API.
 * Ensures we don't send malformed data that could cause silent drops.
 *
 * Reference: https://www.zoho.com/cliq/help/restapi/v2/#Post_message_to_a_bot
 */
interface CliqBotPayload {
    text: string;
    card: {
        title: string;
        theme: string;
    };
    slides: Array<{
        type: string;
        data: Record<string, string>[];
    }>;
    buttons: Array<{
        label: string;
        type: string;
        action: {
            type: string;
            data: { web: string };
        };
    }>;
    /** Comma-separated user IDs or emails for targeted Bot subscriber messaging */
    userids?: string;
    /** Whether to display bot message synchronously */
    sync_message?: boolean;
}

/**
 * Validates and fetches a fresh, short-lived OAuth access token from Zoho
 * using the permanent refresh token. 
 */
async function getZohoAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
    const url = 'https://accounts.zoho.in/oauth/v2/token';
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to refresh Zoho token: ${response.status} ${errText}`);
    }

    const data = await response.json() as { access_token: string };
    if (!data.access_token) {
        throw new Error('Zoho token response did not contain access_token');
    }

    return data.access_token;
}

/**
 * Maps a standardized GitHub conclusion to a human-readable Client Chat verdict label.
 */
function getVerdictLabel(conclusion: string): string {
    const verdictMap: Record<string, string> = {
        'success': '✅ Approved',
        'failure': '❌ Changes Requested',
        'neutral': '🤔 Needs Discussion',
    };
    return verdictMap[conclusion] || '🤔 Needs Discussion';
}

/**
 * Posts a concise PR review summary to Zoho Cliq via the REST API v2.
 *
 * Authentication: OAuth token passed as `Authorization: Zoho-oauthtoken {token}`
 */
export async function postToCliq(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    botName: string,
    targetId: string,
    repoFullName: string,
    prNumber: number,
    prTitle: string,
    prAuthor: string,
    conclusion: string,
    severityCounts: Record<FindingSeverity, number>
): Promise<void> {
    if (!clientId || !clientSecret || !refreshToken || !botName || !targetId) {
        logger.warn('Skipping Cliq notification: Client ID, Secret, Refresh Token, Bot Name, or Target ID is missing');
        return;
    }

    const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;

    // Safety check: Empty Severity Counts Handling
    const counts = {
        critical: severityCounts?.critical ?? 0,
        high: severityCounts?.high ?? 0,
        medium: severityCounts?.medium ?? 0,
        low: severityCounts?.low ?? 0,
    };
    const totalFindings = counts.critical + counts.high + counts.medium + counts.low;

    const verdictLabel = getVerdictLabel(conclusion);

    // Strictly typed payload (API Contract)
    const payload: CliqBotPayload = {
        text: `AI Code Review completed for **${repoFullName}#${prNumber}**`,
        card: {
            title: `PR #${prNumber}: ${prTitle}`,
            theme: 'modern-inline',
        },
        slides: [
            {
                type: 'label',
                data: [
                    { 'Repository': repoFullName },
                    { 'Author': `@${prAuthor}` },
                    { 'Verdict': verdictLabel },
                    { 'Total Findings': String(totalFindings) },
                ],
            },
            {
                type: 'label',
                data: [
                    { '🔴 Critical': String(counts.critical) },
                    { '🟠 High': String(counts.high) },
                    { '🟡 Medium': String(counts.medium) },
                    { '🟢 Low': String(counts.low) },
                ],
            },
        ],
        buttons: [
            {
                label: 'View on GitHub',
                type: '+',
                action: {
                    type: 'open.url',
                    data: { web: prUrl },
                },
            },
        ],
    };

    // ── Dynamic API Routing (Enforcing Bot Identity & Target Classification) ──
    const zohoApiBase = 'https://cliq.zoho.in/api/v2';
    const encBotName = encodeURIComponent(botName);
    const encTarget = encodeURIComponent(targetId);
    let endpoint: string;

    if (targetId.startsWith('ch_')) {
        // Post to a Channel by numeric/hash ID, explicitly retaining Bot Identity
        // Ref: https://www.zoho.com/cliq/help/restapi/v2/#Post_message_in_a_channel
        endpoint = `${zohoApiBase}/channels/${targetId}/message?bot_unique_name=${encBotName}`;
    } else if (targetId.includes('@') || /^\d+$/.test(targetId)) {
        // Direct messages (DMs) to an email or numeric ZUID from the Bot using 'userids' payload
        endpoint = `${zohoApiBase}/bots/${encBotName}/message`;
        payload.userids = targetId;
        payload.sync_message = true;
    } else {
        // Fallback: Assume targetId is a Channel Unique Name (e.g. "engineering")
        // Zoho API path routing violently rejects uppercase letters. Sanitize before encoding.
        const safeChannelName = encodeURIComponent(targetId.toLowerCase());
        endpoint = `${zohoApiBase}/channelsbyname/${safeChannelName}/message?bot_unique_name=${encBotName}`;
    }

    try {
        // Step 1: Execute Auto-Refresh OAuth flow
        logger.info('Exchanging Zoho Refresh Token for Access Token', { prNumber, repoFullName });
        const accessToken = await getZohoAccessToken(clientId, clientSecret, refreshToken);

        // Step 2: Proceed with the Notification Dispatch (Hard 10s Timeout)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Zoho Cliq REST API v2 dictates this exact header casing semantics
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 429) {
                    logger.warn('Zoho Cliq API rate limit exceeded. Notification dropped.');
                    return;
                }
                if (response.status === 401 || response.status === 403) {
                    logger.error('Zoho Cliq API authentication failed. The integration may be unauthorized or scopes are missing.');
                    return;
                }

                const errText = await response.text();
                throw new Error(`Cliq API error at ${endpoint} (${response.status}): ${errText}`);
            }

            logger.info('Successfully posted review summary to Zoho Cliq', { prNumber, repoFullName, routeType: targetId.startsWith('ch_') ? 'channel' : 'other' });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            throw fetchError;
        }

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.warn('Zoho Cliq API request timed out (10s limit)', { prNumber, repoFullName });
            return;
        }

        // Non-fatal: a Cliq failure must never break the GitHub review pipeline
        logger.error('Failed to post to Zoho Cliq Bot', error instanceof Error ? error : undefined, {
            prNumber,
            repoFullName,
        });
    }
}
