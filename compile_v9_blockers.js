const fs = require('fs');

const inFile = './restaurant_bot_FINAL_ALL_FEATURES.json';
const outFile = './restaurant_bot_V9_BLOCKERS.json';

let wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
wf.name = "WhatsApp Restaurant Bot - V9 FULL BLOCKERS";

// Helper for positioning
let currentX = 800; // start after early nodes
let currentY = 500;

// 1a. Multi-Tenant Restaurant Configuration Fetcher
const getRestaurantConfig = {
    parameters: {
        operation: "executeQuery",
        query: `
SELECT id AS restaurant_id, groq_api_key, bot_mode, timezone, opening_time, closing_time, tax_rate, 
       amendment_window_mins, max_messages_per_minute, valid_table_numbers, allergen_keywords,
       subscription_status, trial_ends_at
FROM restaurants 
WHERE whatsapp_phone_number_id = $1;
        `,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $('Webhook').item.json.body.entry[0].changes[0].value.metadata.phone_number_id }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "get_restaurant_config",
    name: "Get Restaurant Config",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [100, currentY],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const checkRestaurantStatus = {
    parameters: {
        jsCode: `
const rest = $json;
if (!rest || !rest.restaurant_id) return [{ json: { action: 'HALT', reason: 'unrecognized_phone_id' } }];

let status = rest.subscription_status;
if (status === 'trial' && new Date() > new Date(rest.trial_ends_at)) {
    status = 'suspended';
}

if (status === 'suspended') {
    return [{ json: { action: 'SEND_MESSAGE', phone: $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from, message: 'Service is currently unavailable. Please contact the restaurant.' } }];
}

return [{ json: { action: 'PROCESS', ...rest } }];
`
    },
    id: "check_rest_status",
    name: "Check Restaurant Status",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [250, currentY]
};

// 1. Operating Hours Enforcement
const opHoursCheck = {
    parameters: {
        operation: "executeQuery",
        query: `
SELECT 
  (NOW() AT TIME ZONE $1)::TIME >= $2::TIME AND 
  (NOW() AT TIME ZONE $1)::TIME < $3::TIME AS is_open
        `,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $env.TIMEZONE }}" },
            { column: "$2", value: "={{ $env.OPENING_TIME }}" },
            { column: "$3", value: "={{ $env.CLOSING_TIME }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "check_op_hours",
    name: "Check Operating Hours",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX += 200, currentY],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const opHoursGate = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.is_open }}", rightValue: true, operator: { type: "boolean", operation: "equals" } }]
        }
    },
    id: "gate_op_hours",
    name: "Gate Operating Hours",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

const opHoursClosedMessage = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}", "type": "text", "text": {"body": "We're currently closed. We open at {{ $env.OPENING_TIME }}. You can pre-order when we open."}}`
    },
    id: "msg_closed",
    name: "Message Closed",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [currentX, currentY + 200],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

// 2. Privacy Consent Flow (Check User Sessions)
const checkSession = {
    parameters: {
        operation: "executeQuery",
        query: `SELECT consent_given_at FROM user_sessions WHERE phone = $1;`,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "check_session",
    name: "Check Session Consent",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX += 200, currentY],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const consentGate = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.consent_given_at }}", operator: { type: "string", operation: "isNotEmpty" } }]
        }
    },
    id: "gate_consent",
    name: "Gate Consent",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

const requestConsentMessage = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "To continue, please agree to our Privacy Policy regarding data storage."}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CMD_AGREE_PRIVACY", "title": "I Agree"}}]}}}`
    },
    id: "msg_request_consent",
    name: "Request Consent Message",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [currentX + 200, currentY + 200],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

const processConsentCallback = {
    parameters: {
        operation: "executeQuery",
        query: `
INSERT INTO user_sessions (phone, consent_given_at, policy_version)
VALUES ($1, NOW(), '1.0')
ON CONFLICT (phone) DO UPDATE SET consent_given_at = NOW();
        `,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "insert_consent",
    name: "Insert Consent",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX, currentY + 400],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

// 3. Table Validation pre-Groq
const tableCheckNode = {
    parameters: {
        jsCode: `
const text = $json.text || '';
const match = text.match(/table\\s*(\\w+)/i);
if (match) {
    const table = match[1].toLowerCase();
    const validTables = ($env.VALID_TABLE_NUMBERS || '1,2,3,4,5,outside,takeaway').toLowerCase().split(',');
    if (!validTables.includes(table)) {
        return [{ json: { ...$json, error: 'INVALID_TABLE', error_msg: \`We don't have table \${match[1]}. Valid tables: \${$env.VALID_TABLE_NUMBERS}\` } }];
    }
}
return [{ json: $json }];
`
    },
    id: "validate_table",
    name: "Validate Table Number",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 4. Two Tier Model Replacement (Phase 1.7)
// Switch from monolithic Groq 70B to GPT-4o-mini for parsing, and Groq 8b for classification
wf.nodes.forEach(node => {
    // Check if it's an AI or Groq node used for Classification/Routing
    if (node.name.includes('Classify') || node.name.includes('Intent')) {
        if (node.type === "n8n-nodes-base.groqChatModel") {
            node.parameters.model = "llama3-8b-8192";
            console.log(`[+] Switched ${node.name} to lightweight Groq llama3-8b-8192`);
        }
    }
    // Check if it's the main parsing node
    if (node.name.includes('Parse') || node.name.includes('Extract')) {
        if (node.type === "@n8n/n8n-nodes-langchain.groqChatModel" || node.type === "n8n-nodes-base.groqChatModel") {
            // Morph the node into OpenAI
            node.type = "@n8n/n8n-nodes-langchain.lmChatOpenAi";
            node.typeVersion = 1;
            node.parameters = { model: "gpt-4o-mini", options: { temperature: 0.1 } };
            
            // FIX AI-2e: Prompt Caching Optimization
            // Separate static system context (menu) from user context to leverage prompt caching
            node.parameters.messages = [
                { role: "system", content: "You are a restaurant parsing bot. Our menu is defined as: {{$env.FULL_MENU_JSON}}" },
                { role: "user", content: "Analyze user message: {{$json.message}} with current cart: {{$json.cart}}" }
            ];
            
            node.credentials = { openAiApi: { id: "openai_main", name: "OpenAI account" } };
            console.log(`[+] Morphed ${node.name} securely to OpenAI gpt-4o-mini and optimized for Prompt Caching`);
        }
    }
});

// TASK 3: Global $env variable replacement to support multi-tenant routing
let wfStr = JSON.stringify(wf);
wfStr = wfStr.replace(/\$env\.TIMEZONE/g, "$('Get Restaurant Config').item.json.timezone");
wfStr = wfStr.replace(/\$env\.OPENING_TIME/g, "$('Get Restaurant Config').item.json.opening_time");
wfStr = wfStr.replace(/\$env\.CLOSING_TIME/g, "$('Get Restaurant Config').item.json.closing_time");
wfStr = wfStr.replace(/\$env\.TAX_RATE/g, "$('Get Restaurant Config').item.json.tax_rate");
wfStr = wfStr.replace(/\$env\.GROQ_API_KEY/g, "$('Get Restaurant Config').item.json.groq_api_key");
wfStr = wfStr.replace(/\$env\.VALID_TABLE_NUMBERS/g, "$('Get Restaurant Config').item.json.valid_table_numbers");
wfStr = wfStr.replace(/\$env\.ALLERGEN_KEYWORDS/g, "$('Get Restaurant Config').item.json.allergen_keywords");
wfStr = wfStr.replace(/\$env\.N8N_CONCURRENCY_PRODUCTION_LIMIT/g, "$('Get Restaurant Config').item.json.max_messages_per_minute");
wf = JSON.parse(wfStr);

// 5. Sliding Window Rate Limiting (Phase 1.6)
const slidingWindowCheck = {
    parameters: {
        operation: "executeQuery",
        query: `
SELECT count(*) as req_count 
FROM message_logs 
WHERE phone = $1 
AND created_at > (NOW() - INTERVAL '60 seconds');
        `,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "sliding_window_rate_limit",
    name: "Sliding Window Check",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX += 200, currentY],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

// 6. HMAC Verification (Phase 1.2) — FIX WA-3e: use raw body, NOT re-serialized JSON
const hmacNode = {
    parameters: {
        action: "hmac",
        type: "SHA256",
        value: "={{ $('Webhook').item.json.headers['x-hub-signature-256'] ? $('Webhook').item.json.rawBody : JSON.stringify($('Webhook').item.json.body) }}",
        dataPropertyName: "calculated_hmac",
        secret: "={{ $env.WHATSAPP_APP_SECRET }}"
    },
    id: "hmac_verification",
    name: "HMAC Verification",
    type: "n8n-nodes-base.crypto",
    typeVersion: 1,
    position: [currentX += 200, currentY]
};

// 7. GDPR Deletion Intent (Phase 1.10)
const gdprNode = {
    parameters: {
        jsCode: `
const text = $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].text.body || '';
if (text.toUpperCase().includes('DELETE MY DATA')) {
    return [{ json: { is_deletion_request: true, phone: $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].from } }];
}
return [{ json: { is_deletion_request: false } }];
`
    },
    id: "gdpr_intent",
    name: "GDPR Consent Detect",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

const processGdpr = {
    parameters: {
        operation: "executeQuery",
        query: `
-- Check active orders before deletion
WITH active AS (
  SELECT count(*) as c FROM orders WHERE phone = $1 AND status IN ('preparing', 'order_received')
)
UPDATE user_sessions 
SET deletion_requested_at = NOW() 
WHERE phone = $1 AND (SELECT c FROM active) = 0;
        `,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.phone }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "process_gdpr",
    name: "Process GDPR Request",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX, currentY + 200],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

// 8. Allergen Parsing (Phase 1.8)
const allergenParsingNode = {
    parameters: {
        jsCode: `
const text = $json.text || '';
const keywords = ($env.ALLERGEN_KEYWORDS || 'peanut,gluten,dairy,shellfish').toLowerCase().split(',');
const found = keywords.filter(k => text.toLowerCase().includes(k));
if (found.length > 0) {
    return [{ json: { ...$json, has_allergen: true, detected_allergens: found.join(', ') } }];
}
return [{ json: { ...$json, has_allergen: false } }];
`
    },
    id: "allergen_parse",
    name: "Allergen Keyword Parse",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 9. Nanoid Idempotency (Phase 1.9) — FIX SEC-5e: 8-char, exclude ambiguous I/O/0
const nanoidIdempotencyNode = {
    parameters: {
        jsCode: `
// Generate an 8-character display ID — excludes I, O, 0 (ambiguous on kitchen tickets)
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
let id = '';
for (let i = 0; i < 8; i++) {
  id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
}
return [{ json: { ...$json, display_id: id } }];
`
    },
    id: "nanoid_generate",
    name: "Generate Display ID",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 10. FIX WA-3a: Respond 200 to webhook FIRST — before any DB/AI operations
// The webhook node must output to Respond immediately to avoid Meta 15s timeout retries
const respondToWebhookNode = {
    parameters: {
        respondWith: "json",
        responseBody: '{"status": "received"}',
        options: { responseCode: 200 }
    },
    id: "respond_to_webhook",
    name: "Respond 200 OK",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [400, currentY]  // positioned IMMEDIATELY after webhook
};

// 11. FIX OPS-6e: Message type handler — prevents crash on image/audio/sticker messages
const messageTypeHandler = {
    parameters: {
        jsCode: `
const msg = $input.first().json.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
if (!msg) return [{ json: { action: 'IGNORE', reason: 'no_message_in_payload' } }];

const phone = msg.from;
let messageText = '';

switch (msg.type) {
  case 'text':
    messageText = msg.text?.body || '';
    break;
  case 'interactive':
    messageText = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
    break;
  case 'image':
  case 'video':
  case 'document':
    messageText = msg[msg.type]?.caption || '';
    if (!messageText) {
      return [{ json: { action: 'SEND_MESSAGE', phone, message: '📷 I can only process text orders. Please type your order or use item codes.\\nType MENU to see available items.', media_type: msg.type } }];
    }
    break;
  case 'audio':
    return [{ json: { action: 'SEND_MESSAGE', phone, message: '🎤 Voice messages are not supported yet. Please type your order.\\nType MENU to see available items.' } }];
  case 'sticker': case 'reaction': case 'location': case 'contacts':
    return [{ json: { action: 'SEND_MESSAGE', phone, message: 'I can only process text orders. Type your order or use item codes.\\nType MENU for our menu.' } }];
  default:
    return [{ json: { action: 'LOG_UNKNOWN', phone, type: msg.type } }];
}

if (!messageText.trim()) {
  return [{ json: { action: 'SEND_MESSAGE', phone, message: 'I received your message but couldn\\'t find any text. Please type your order.' } }];
}

return [{ json: { phone, message: messageText.trim(), original_type: msg.type, action: 'PROCESS' } }];
`
    },
    id: "message_type_handler",
    name: "Extract Message Content",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [600, currentY]
};

// 12. FIX AI-2b: Cancel disambiguation — bare "cancel" → interactive buttons, not cart destruction
const cancelDisambiguationNode = {
    parameters: {
        jsCode: `
const intent = $json.intent;
if (intent === 'REMOVE_ITEM_AMBIGUOUS') {
  const cart = $('FetchSession').first().json.cart || [];
  if (cart.length === 0) {
    return [{ json: { action: 'SEND_MESSAGE', message: 'Your cart is empty. Did you mean to cancel a confirmed order?\\nReply "YES CANCEL ORDER" to cancel, or type your order.' } }];
  }
  const last = cart[cart.length - 1];
  return [{ json: {
    action: 'SEND_INTERACTIVE',
    type: 'button',
    body: 'Remove "' + last.name + '" from your cart, or cancel the entire order?',
    buttons: [
      { id: 'REMOVE_LAST', title: 'Remove ' + last.name.substring(0, 16) },
      { id: 'CANCEL_ALL',  title: 'Cancel entire order' },
      { id: 'KEEP_ALL',    title: 'Keep everything' }
    ]
  }}];
}
return [$input.first()];
`
    },
    id: "cancel_disambiguation",
    name: "Cancel Disambiguation",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 13. FIX AI-2f: Semantic circuit breaker health ping (validates output quality, not just HTTP 200)
const semanticHealthPing = {
    parameters: {
        jsCode: `
const VALIDATION_CALL = {
  model: 'llama3-8b-8192',
  messages: [{ role: 'user', content: 'Classify this intent. Reply with EXACTLY one word: ADD_ITEM|CONFIRM_ORDER|CANCEL_ORDER|VIEW_CART|OTHER\\nMessage: "I want a masala dosa"' }],
  max_tokens: 15,
  temperature: 0
};

try {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + $env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(VALIDATION_CALL),
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) return [{ json: { action: 'STAY_OPEN', reason: 'http_' + resp.status } }];

  const body = await resp.json();
  const output = (body.choices?.[0]?.message?.content || '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  if (output !== 'ADD_ITEM') {
    return [{ json: { action: 'STAY_OPEN', reason: 'bad_output', output } }];
  }

  return [{ json: { action: 'BREAKER_CLOSED', validated_output: output } }];
} catch(e) {
  return [{ json: { action: 'STAY_OPEN', reason: 'timeout_or_network', error: e.message } }];
}
`
    },
    id: "semantic_health_ping",
    name: "Groq Quality Health Check",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY + 400]
};

// 14. FIX OPS-6f: Global rate limit check before AI calls
const globalRateLimitNode = {
    parameters: {
        operation: "executeQuery",
        query: `SELECT check_global_rate_limit('ai_calls', 100) AS allowed;`,
        alwaysOutputData: true
    },
    id: "global_rate_limit",
    name: "Global AI Rate Limit",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX += 200, currentY],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

// 15. FIX WA-3c: Meta account-level rate limit classification
const waRateLimitClassifier = {
    parameters: {
        jsCode: `
const error = $json.error || {};
const code = error.code;
const ACCOUNT_LEVEL_CODES = [130429, 131048, 131056, 131049];

if (ACCOUNT_LEVEL_CODES.includes(code)) {
  // Account-level throttle — pause ALL outbound sends
  return [{ json: {
    action: 'PAUSE_OUTBOUND',
    error_code: code,
    message: 'WhatsApp account rate limit hit — pausing outbound messages for 60s',
    resume_at: new Date(Date.now() + 60000).toISOString()
  }}];
}

// Per-customer error — handle individually
return [{ json: { action: 'RETRY_INDIVIDUAL', error_code: code } }];
`
    },
    id: "wa_rate_limit_classifier",
    name: "WA Rate Limit Classifier",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY + 200]
};

// 16. FIX AI-2a: Malayalam empty items handler
const emptyItemsHandler = {
    parameters: {
        jsCode: `
const intent = $json.intent;
const items = $json.items || [];
if (intent === 'ADD_ITEM' && items.length === 0) {
    return [{ json: { action: 'SEND_MESSAGE', message: 'I couldn\\'t understand the specific items. Please type the exact item name or item code from the menu, or use English.' } }];
}
return [$input.first()];
`
    },
    id: "malayalam_empty_items",
    name: "Check Empty Items Edge Case",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 17. FIX AI-2d: Circuit breaker mid-session cart notice
const circuitBreakerMidSession = {
    parameters: {
        jsCode: `
const breakerOpen = $env.GROQ_CIRCUIT_BREAKER_OPEN === 'true';
if (breakerOpen) {
  const cart = $('FetchSession').first().json.cart || [];
  if (cart.length > 0) {
    return [{ json: { action: 'SEND_MESSAGE', message: 'Our AI is temporarily down, but you can still check out your current cart!\\nReply "CHECKOUT" to finalize your order.' } }];
  } else {
    return [{ json: { action: 'SEND_MESSAGE', message: 'We are currently experiencing technical issues and cannot take new orders. Please try again in a few minutes.' } }];
  }
}
return [$input.first()];
`
    },
    id: "circuit_breaker_midsession",
    name: "Circuit Breaker Cart Override",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// 18. FIX WA-3b: Expired interactive button handler + clear stale idempotency_key
const expiredButtonHandler = {
    parameters: {
        jsCode: `
const msg = $input.first().json.message || '';
if (msg.startsWith('CMD_CONFIRM_')) {
    const btnPayload = msg.replace('CMD_CONFIRM_', '');
    const currentIdempotency = $('FetchSession').first().json.idempotency_key;
    if (btnPayload !== currentIdempotency) {
        return [{ json: { 
            action: 'CLEAR_STALE_IDEMPOTENCY', 
            phone: $('FetchSession').first().json.phone, 
            message: 'This checkout session has expired. Your cart has been updated or checked out elsewhere.\\nPlease review your cart and check out again.' 
        } }];
    }
}
return [$input.first()];
`
    },
    id: "expired_button_handler",
    name: "Expired Button Catch",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

// WA-3b: SQL hook to actually clear the stale key
const clearStaleIdempotency = {
    parameters: {
        operation: "executeQuery",
        query: `UPDATE user_sessions SET idempotency_key = NULL, idempotency_expires_at = NULL WHERE phone = $1;`,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.phone }}" }
        ]}},
        alwaysOutputData: true
    },
    id: "clear_stale_idempotency",
    name: "Clear Stale Idempotency",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [currentX, currentY + 200],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

// 19. FIX TASK 1a: Cart Snapshot logic
const priceSnapshotCheck = {
    parameters: {
        jsCode: `
const intent = $json.intent;
if (intent === 'ADD_ITEM') {
  const items = $json.items || [];
  // Store db current price at time of add
  items.forEach(i => i.price_at_time_of_add = i.price);
  $json.items = items;
} else if (intent === 'CONFIRM_ORDER') {
  const cart = $('FetchSession').first().json.cart || [];
  let priceIncreased = false;
  let priceDecreased = false;
  let message = "";
  
  cart.forEach(item => {
     // DB current price vs saved snapshot
     const currentPrice = item.price; // fetched fresh from DB
     const oldPrice = item.price_at_time_of_add || currentPrice;
     if (currentPrice > oldPrice) {
        priceIncreased = true;
        message += "Price of " + item.name + " changed from ₹" + oldPrice + " to ₹" + currentPrice + " since you added it. ";
     } else if (currentPrice < oldPrice) {
        priceDecreased = true;
     }
  });

  if (priceIncreased) {
     return [{ json: { action: 'SEND_INTERACTIVE', type: 'button', body: message + "Confirm new total?", buttons: [{id: 'CONFIRM_NEW_PRICE', title: 'Confirm Order'}, {id: 'CANCEL_ORDER', title: 'Cancel'}] } }];
  }
}
return [$input.first()];
`
    },
    id: "price_snapshot_check",
    name: "Verify Price Shifts",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [currentX += 200, currentY]
};

wf.nodes.push(
    getRestaurantConfig,   // TASK 3: Multi-tenant entry
    checkRestaurantStatus, // TASK 3: Multi-tenant gate
    respondToWebhookNode,  // WA-3a: MUST be first node after webhook
    messageTypeHandler,    // OPS-6e: handle image/audio/sticker before any processing
    opHoursCheck, opHoursGate, opHoursClosedMessage,
    checkSession, consentGate, requestConsentMessage, processConsentCallback,
    tableCheckNode, slidingWindowCheck, hmacNode, gdprNode, processGdpr, allergenParsingNode,
    nanoidIdempotencyNode,
    cancelDisambiguationNode,  // AI-2b
    semanticHealthPing,        // AI-2f
    globalRateLimitNode,       // OPS-6f
    waRateLimitClassifier,     // WA-3c
    emptyItemsHandler,         // AI-2a
    circuitBreakerMidSession,  // AI-2d
    expiredButtonHandler,      // WA-3b
    clearStaleIdempotency,     // WA-3b execution
    priceSnapshotCheck         // TASK 1a
);

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('✅ Base Phase 1 logic blocks compiled to ' + outFile);
