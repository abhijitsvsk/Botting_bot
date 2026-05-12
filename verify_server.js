const http = require('http');
const https = require('https');
const url = require('url');

const VERIFY_TOKEN = 'my_secret_token_123';
const PORT = 5679;
const N8N_HOST = 'localhost';
const N8N_PORT = 5678;
const N8N_PATH = '/webhook/whatsapp-webhook';
const DEBUG_ENDPOINT = 'http://127.0.0.1:7433/ingest/17258ed5-46e3-44f7-89d3-c5410072c8bb';
const DEBUG_SESSION_ID = '1c00fe';

function sendDebugLog(runId, hypothesisId, message, data) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION_ID
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId,
      hypothesisId,
      location: 'verify_server.js',
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;

  // Handle Meta's webhook verification (GET request)
  if (req.method === 'GET' && query['hub.mode'] === 'subscribe') {
    if (query['hub.verify_token'] === VERIFY_TOKEN) {
      console.log('[OK] Meta verified the webhook! Challenge:', query['hub.challenge']);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(query['hub.challenge']);
    } else {
      console.log('[FAIL] Wrong verify token:', query['hub.verify_token']);
      res.writeHead(403);
      res.end('Forbidden');
    }
    return;
  }

  // Forward all other requests (POST messages) to n8n
  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);
    console.log(`[FORWARD] ${req.method} ${req.url} → n8n (${body.length} bytes)`);
    let parsedBody = {};
    try {
      parsedBody = JSON.parse(body.toString('utf8'));
    } catch {
      parsedBody = {};
    }
    const msg = parsedBody?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || {};
    const runId = `pre-fix-${Date.now()}`;
    sendDebugLog(runId, 'H1', 'Incoming webhook payload summary', {
      method: req.method,
      path: req.url,
      hasInteractive: !!msg.interactive,
      buttonReplyId: msg?.interactive?.button_reply?.id || null,
      listReplyId: msg?.interactive?.list_reply?.id || null,
      textBody: msg?.text?.body || null,
      from: msg?.from || null
    });

    const options = {
      hostname: N8N_HOST,
      port: N8N_PORT,
      path: N8N_PATH,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${N8N_HOST}:${N8N_PORT}`,
        'content-length': body.length
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      sendDebugLog(runId, 'H3', 'n8n webhook response status', {
        statusCode: proxyRes.statusCode,
        responseHeaders: proxyRes.headers
      });
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      sendDebugLog(runId, 'H5', 'Proxy request error', {
        error: err.message
      });
      console.error('[ERROR] Could not reach n8n:', err.message);
      res.writeHead(200); // Always return 200 to Meta to prevent retries
      res.end('OK');
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`GET  → Handles Meta verification directly`);
  console.log(`POST → Forwards to n8n on port ${N8N_PORT}`);
});
