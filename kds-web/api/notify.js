// kds-web/api/notify.js  — Vercel Serverless Function
// FIX INFRA-8b: Fire-and-forget pattern (no more 10s timeout 504s)
// FIX SEC-5a: JWKS cache retry on key rotation failure
// Auth: Validates Supabase JWT against JWKS, checks staff table for allowed roles.

import { createRemoteJWKSet, jwtVerify } from 'jose';

// SEC-5a: JWKS with aggressive cache refresh on verification failure
const jwksUrl = process.env.PROXY_SUPABASE_JWKS_URL;
let JWKS = null;

function getJWKS() {
    if (!jwksUrl) return null;
    if (!JWKS) {
        JWKS = createRemoteJWKSet(new URL(jwksUrl), {
            cooldownDuration: 30000,   // 30s min between re-fetches
            cacheMaxAge: 300000,       // 5 min cache max
        });
    }
    return JWKS;
}

// SEC-5a: Verify JWT with retry on key rotation
async function verifyJwtWithRetry(token) {
    const jwks = getJWKS();
    if (!jwks) throw new Error('JWKS not configured');

    try {
        const result = await jwtVerify(token, jwks);
        return result.payload;
    } catch (err) {
        if (err.code === 'ERR_JWKS_NO_MATCHING_KEY' || err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
            // Key rotation likely — force re-fetch JWKS
            JWKS = createRemoteJWKSet(new URL(jwksUrl), {
                cooldownDuration: 30000,
                cacheMaxAge: 0,  // force fresh fetch
            });
            // Retry once with fresh keys
            const result = await jwtVerify(token, JWKS);
            return result.payload;
        }
        throw err;
    }
}

// INFRA-8b: Set max duration to 5s — only auth validation, no waiting for n8n
export const config = { maxDuration: 5 };

export default async function handler(req, res) {
    // ── CORS ────────────────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // ── AUTH: Extract JWT ───────────────────────────────────────────────
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized — missing or invalid Authorization header' });
        }
        const token = authHeader.split(' ')[1];

        // ── AUTH: Validate JWT Signature using JWKS (with rotation retry) ───
        if (!jwksUrl) {
            console.error('PROXY_SUPABASE_JWKS_URL missing from server env');
            return res.status(500).json({ error: 'Server misconfigured' });
        }

        let payload;
        try {
            payload = await verifyJwtWithRetry(token);
        } catch (err) {
            console.error('JWT verification failed after retry:', err.code);
            return res.status(401).json({ error: 'Unauthorized — invalid JWT signature or expired token' });
        }

        const userId = payload.sub;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized — invalid JWT payload' });
        }

        // ── AUTH: Look up caller's role in 'staff' table ────────────────────
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const allowedRoles = (process.env.PROXY_ALLOWED_ROLES || 'manager,owner').split(',');

        if (!supabaseUrl || !supabaseServiceKey) {
            console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from server env');
            return res.status(500).json({ error: 'Server misconfigured' });
        }

        const staffRes = await fetch(`${supabaseUrl}/rest/v1/staff?id=eq.${userId}&select=role`, {
            headers: {
                'apikey': supabaseServiceKey,
                'Authorization': `Bearer ${supabaseServiceKey}`
            }
        });

        if (!staffRes.ok) {
            return res.status(500).json({ error: 'Failed to lookup staff role' });
        }

        const staffData = await staffRes.json();
        if (staffData.length === 0) {
            return res.status(403).json({ error: 'Forbidden — user not found in staff table' });
        }

        const userRole = staffData[0].role;
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
        }

        // ── FORWARD to n8n — FIRE AND FORGET ────────────────────────────────
        // INFRA-8b: Do NOT await the n8n response. Return 202 immediately.
        const webhookUrl = process.env.N8N_INTERNAL_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
        if (!webhookUrl) {
            return res.status(500).json({ error: 'N8N_INTERNAL_WEBHOOK_URL not configured' });
        }

        const body = req.body;
        const safeAllowedStatuses = ['preparing', 'ready_for_pickup', 'completed', 'cancelled'];
        if (body.status && !safeAllowedStatuses.includes(body.status)) {
            return res.status(400).json({ error: `Invalid status transition: ${body.status}` });
        }

        // Inject staff identity into forwarded payload
        const enrichedBody = {
            ...body,
            _staff_id: userId,
            _staff_role: userRole,
            _timestamp: Date.now()
        };

        // Fire and forget — intentionally not awaiting
        fetch(`${webhookUrl.replace(/\/+$/, '')}/status-update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enrichedBody)
        }).catch(err => {
            // Log but don't fail — n8n handles its own retry
            console.error('n8n forward error (non-blocking):', err.message);
        });

        // Return 202 Accepted immediately — Manager Portal gets instant feedback
        return res.status(202).json({
            accepted: true,
            message: 'Action queued for processing',
            staff_id: userId
        });

    } catch (err) {
        console.error('Proxy error:', err);
        return res.status(502).json({ error: 'Failed to process proxy request', detail: err.message });
    }
}
