/**
 * Cloudflare Worker: Supabase ISP Block Bypass Proxy
 *
 * Indian ISPs (Jio, Airtel, ACT) blocked *.supabase.co under Section 69A.
 * This Worker sits on your own domain and forwards all traffic to Supabase.
 * Indian ISPs only see traffic to your domain — which they cannot block
 * without breaking the entire internet.
 *
 * n8n does NOT use this — n8n runs on a server outside India.
 * Only browser-facing React apps (KDS, Manager, POS, Reports) use this.
 *
 * Environment variables required:
 *   SUPABASE_REAL_URL  — your actual Supabase project URL
 *                        e.g. https://abcdefghijkl.supabase.co
 *   ALLOWED_ORIGIN     — your Vercel deployment URL (set after initial testing)
 *                        e.g. https://your-app.vercel.app
 *                        Leave unset during development to allow all origins (*)
 */

export default {
  async fetch(request, env) {
    const supabaseRealUrl = env.SUPABASE_REAL_URL;
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    if (!supabaseRealUrl) {
      return new Response(
        JSON.stringify({ error: 'SUPABASE_REAL_URL environment variable is not set on this Worker.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── CORS preflight — browsers send this before every real request ──────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders(allowedOrigin),
      });
    }

    // ── WebSocket upgrade — Supabase Realtime (used by KDS Kitchen.jsx) ───────
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleWebSocket(request, supabaseRealUrl);
    }

    // ── Standard HTTP request — REST API, Auth, Storage ───────────────────────
    return handleHttp(request, supabaseRealUrl, allowedOrigin);
  },
};

/**
 * Forwards a standard HTTP request to Supabase and adds CORS headers to the response.
 */
async function handleHttp(request, supabaseRealUrl, allowedOrigin) {
  const url = new URL(request.url);

  // Swap the Worker's hostname for the real Supabase hostname
  const realUrl = new URL(supabaseRealUrl);
  url.hostname = realUrl.hostname;
  url.protocol = realUrl.protocol;
  url.port = realUrl.port || '';

  // Forward the request with all original headers intact
  const modifiedRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'follow',
  });

  let response;
  try {
    response = await fetch(modifiedRequest);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Proxy failed to reach Supabase.', detail: err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(allowedOrigin) } }
    );
  }

  // Clone the response and inject CORS headers
  const newHeaders = new Headers(response.headers);
  const cors = corsHeaders(allowedOrigin);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Handles WebSocket upgrade requests for Supabase Realtime.
 * This is the most critical path — it keeps the Kitchen KDS live.
 * Cloudflare Workers natively support WebSocket proxying via the WebSocketPair API.
 */
async function handleWebSocket(request, supabaseRealUrl) {
  const url = new URL(request.url);

  // Convert https:// → wss:// and swap hostname to real Supabase
  const realUrl = new URL(supabaseRealUrl);
  url.hostname = realUrl.hostname;
  url.port = realUrl.port || '';
  url.protocol = 'wss:';

  // Upgrade the request to Supabase as a WebSocket client
  const supabaseResponse = await fetch(url.toString(), {
    headers: request.headers,
  });

  // If Supabase didn't return a WebSocket upgrade, return the error
  if (supabaseResponse.status !== 101) {
    return new Response('WebSocket upgrade to Supabase failed.', {
      status: supabaseResponse.status,
    });
  }

  // Create a WebSocket pair — one end for the browser, one end we hold
  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();

  // The serverSocket is what the browser connected to us with
  serverSocket.accept();

  // Pipe messages between browser ↔ Supabase in both directions
  const supabaseSocket = supabaseResponse.webSocket;
  supabaseSocket.accept();

  serverSocket.addEventListener('message', (event) => {
    try { supabaseSocket.send(event.data); } catch (_) {}
  });
  supabaseSocket.addEventListener('message', (event) => {
    try { serverSocket.send(event.data); } catch (_) {}
  });

  serverSocket.addEventListener('close', (event) => {
    try { supabaseSocket.close(event.code, event.reason); } catch (_) {}
  });
  supabaseSocket.addEventListener('close', (event) => {
    try { serverSocket.close(event.code, event.reason); } catch (_) {}
  });

  serverSocket.addEventListener('error', () => {
    try { supabaseSocket.close(1011, 'Client WebSocket error'); } catch (_) {}
  });
  supabaseSocket.addEventListener('error', () => {
    try { serverSocket.close(1011, 'Supabase WebSocket error'); } catch (_) {}
  });

  // Return the client end of the pair as the upgrade response
  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}

/**
 * Returns the CORS headers to attach to every response.
 * In production, ALLOWED_ORIGIN should be your exact Vercel URL.
 */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}
