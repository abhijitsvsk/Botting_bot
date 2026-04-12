const fs = require('fs');

const inFile = './restaurant_bot_V6_HARDENED.json';
const outFile = './restaurant_bot_V7_FULL.json';

const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
wf.name = "WhatsApp Restaurant Bot - V7 FULL";

// ─────────────────────────────────────────────────────────────────────────────
// 1. SLIDING WINDOW RATE LIMITING (replaces fixed-bucket approach from v1)
// ─────────────────────────────────────────────────────────────────────────────
const rateLimitDbNode = {
    parameters: {
        operation: "executeQuery",
        query: `
INSERT INTO message_logs (phone, direction, status, created_at)
VALUES ($1, 'inbound', 'received', NOW());

SELECT COUNT(*) AS msg_count
FROM message_logs
WHERE phone = $1 AND direction = 'inbound' AND created_at > NOW() - INTERVAL '60 seconds';
`,
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } },
        alwaysOutputData: true
    },
    id: "rate_limit_check",
    name: "Rate Limit Check",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [250, 550],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const rateLimitGateNode = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.msg_count }}", rightValue: 10, operator: { type: "number", operation: "gt" } }]
        }
    },
    id: "rate_limit_gate",
    name: "Rate Limit Gate",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [450, 550]
};

const sendRateLimitMsgNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Rate Limit Check').item.json.from }}", "type": "text", "text": {"body": "⏳ You're sending messages too quickly. Please wait a moment and try again."}}`
    },
    id: "send_rate_limit_msg",
    name: "Send Rate Limit Msg",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [650, 450],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(rateLimitDbNode, rateLimitGateNode, sendRateLimitMsgNode);
wf.connections['Rate Limit Check'] = { main: [[{ node: "Rate Limit Gate", type: "main", index: 0 }]] };
wf.connections['Rate Limit Gate'] = {
    main: [
        [{ node: "Send Rate Limit Msg", type: "main", index: 0 }], // true = rate limited
        [{ node: "Check Operating Hours", type: "main", index: 0 }] // false = proceed
    ]
};
console.log('  [1] Sliding window rate limiter injected (60s / 10 messages)');

// ─────────────────────────────────────────────────────────────────────────────
// 2. BOT MODE SWITCHER (reads from settings table, bypasses Groq in code-only mode)
// ─────────────────────────────────────────────────────────────────────────────
const checkBotModeNode = {
    parameters: {
        operation: "executeQuery",
        query: "SELECT value AS bot_mode FROM settings WHERE key = 'bot_mode' LIMIT 1",
        alwaysOutputData: true
    },
    id: "check_bot_mode",
    name: "Check Bot Mode",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1150, 750],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const menuCodeOnlyParserNode = {
    parameters: {
        jsCode: `
// menu_code_only mode: bypass Groq, parse structured codes like "A2 x2, B4"
const text = $json.text || '';
const matches = [...text.matchAll(/([A-Z][0-9]+)(?:\\s*x\\s*(\\d+))?/gi)];
const parsed_items = matches.map(m => ({ code: m[1].toUpperCase(), quantity: parseInt(m[2]) || 1 }));

if (parsed_items.length === 0) {
  return [{ json: { ...$json, error: 'NO_ITEMS', error_msg: '🔧 Bot is in code-only mode. Please use codes like A2, B4 x2' } }];
}
return [{ json: { ...$json, parsed_items } }];
`
    },
    id: "menu_code_parser",
    name: "Menu Code Only Parser",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1350, 850]
};

wf.nodes.push(checkBotModeNode, menuCodeOnlyParserNode);
wf.connections['Check Bot Mode'] = { main: [[{ node: "Allergen Pre-Scan", type: "main", index: 0 }]] };
wf.connections['Menu Code Only Parser'] = { main: [[{ node: "Check Parse Error", type: "main", index: 0 }]] };
console.log('  [2] Bot mode switcher added (ai / menu_code_only)');

// ─────────────────────────────────────────────────────────────────────────────
// 3. UPDATE_ITEM ACTION in Route Action rules
// ─────────────────────────────────────────────────────────────────────────────
const updateItemDbNode = {
    parameters: {
        operation: "executeQuery",
        query: `
WITH cart AS (
  SELECT cart FROM user_sessions WHERE phone = $1
),
item_idx AS (
  SELECT pos - 1 AS idx
  FROM user_sessions, jsonb_array_elements(cart) WITH ORDINALITY arr(item, pos)
  WHERE phone = $1 AND item->>'code' = $2
  LIMIT 1
)
UPDATE user_sessions
SET cart = CASE
  WHEN (SELECT idx FROM item_idx) IS NULL THEN cart  -- item not in cart, skip
  WHEN $3::int <= 0 THEN                              -- remove if qty 0 or negative
    cart - (SELECT idx FROM item_idx)::int
  ELSE                                                -- update quantity
    jsonb_set(cart, ARRAY[(SELECT idx FROM item_idx)::text, 'quantity'], to_jsonb($3::int))
END
WHERE phone = $1
RETURNING cart;`,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.from }}" },
            { column: "$2", value: "={{ $json.update_item_code }}" },
            { column: "$3", value: "={{ $json.update_item_qty }}" }
        ]}}
    },
    id: "update_item_db",
    name: "Update Item DB",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2800, 500],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const extractUpdateItemNode = {
    parameters: {
        jsCode: `
const data = $input.item.json;
// Parse UPDATE_ITEM: "UPDATE_ITEM A2 1" or Groq action JSON
const text = $('Route Action').item.json.text || '';
const match = text.match(/(?:UPDATE|CHANGE|SET)\\s+([A-Z][0-9]+)\\s+(?:TO\\s+)?(\\d+)/i)
    || text.match(/([A-Z][0-9]+)\\s+(?:to|=|x)\\s*(\\d+)/i);

const code = match ? match[1].toUpperCase() : null;
const qty = match ? parseInt(match[2]) : null;

if (!code) return [{ json: { ...$json, error: 'PARSE_ERROR', error_msg: 'Could not understand which item to change. Try: "Set A2 to 2"' } }];
return [{ json: { ...$json, update_item_code: code, update_item_qty: qty } }];
`
    },
    id: "extract_update_item",
    name: "Extract Update Item",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [2600, 500]
};

wf.nodes.push(extractUpdateItemNode, updateItemDbNode);
wf.connections['Extract Update Item'] = { main: [[{ node: "Update Item DB", type: "main", index: 0 }]] };
wf.connections['Update Item DB'] = { main: [[{ node: "Format Cart", type: "main", index: 0 }]] };

const routeNode = wf.nodes.find(n => n.name === 'Route Action');
if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push({
        conditions: { conditions: [
            { leftValue: "={{ $json.text }}", rightValue: "UPDATE", operator: { type: "string", operation: "contains" } }
        ]},
        renameOutput: true, outputKey: "update_item"
    });
    rules.values.push(fallback);
    const main = wf.connections['Route Action'].main;
    main[rules.values.length - 2] = [{ node: "Extract Update Item", type: "main", index: 0 }];
}
console.log('  [3] UPDATE_ITEM cart action with safe jsonb_set index lookup added');

// ─────────────────────────────────────────────────────────────────────────────
// 4. REORDER LAST MEAL ("REPEAT" keyword)
// ─────────────────────────────────────────────────────────────────────────────
const repeatLastOrderNode = {
    parameters: {
        operation: "executeQuery",
        query: `
-- Reload last_order ONLY if all items are still available=true
WITH last = (SELECT last_order FROM user_sessions WHERE phone = $1),
unavailable AS (
  SELECT item->>'name' AS name
  FROM jsonb_array_elements((SELECT last_order FROM user_sessions WHERE phone=$1)) AS item
  LEFT JOIN menu_items m ON m.code = item->>'code'
  WHERE m.available = false OR m.code IS NULL
)
UPDATE user_sessions
SET cart = CASE
  WHEN (SELECT COUNT(*) FROM unavailable) = 0 THEN last_order
  ELSE cart  -- don't overwrite if some items are 86'd
END
WHERE phone = $1
RETURNING cart, (SELECT json_agg(name) FROM unavailable) AS unavailable_items;`,
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } }
    },
    id: "repeat_last_order",
    name: "Repeat Last Order",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2800, 650],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

wf.nodes.push(repeatLastOrderNode);
wf.connections['Repeat Last Order'] = { main: [[{ node: "Format Cart Review", type: "main", index: 0 }]] };

if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push({
        conditions: { conditions: [
            { leftValue: "={{ $json.text }}", rightValue: "REPEAT", operator: { type: "string", operation: "contains" } }
        ]},
        renameOutput: true, outputKey: "repeat_order"
    });
    rules.values.push(fallback);
    const main = wf.connections['Route Action'].main;
    main[rules.values.length - 2] = [{ node: "Repeat Last Order", type: "main", index: 0 }];
}
console.log('  [4] Repeat last order (REPEAT keyword) added with 86 check');

// ─────────────────────────────────────────────────────────────────────────────
// 5. AMENDMENT WINDOW with SELECT FOR UPDATE (race condition safe)
// ─────────────────────────────────────────────────────────────────────────────
const amendmentCheckNode = {
    parameters: {
        operation: "executeQuery",
        query: `
BEGIN;
SELECT order_id, status, confirmed_at
FROM orders
WHERE phone = $1
  AND status IN ('order_received', 'preparing')
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE NOWAIT;  -- NOWAIT: fail immediately if someone else has the lock (cook already bumped)
`,
        alwaysOutputData: true,
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } }
    },
    id: "amendment_check",
    name: "Amendment Check",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2800, 800],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const amendmentWindowLogicNode = {
    parameters: {
        jsCode: `
const from = $('Route Action').item.json.from;
const data = $input.item.json;
const AMENDMENT_MINS = parseInt($env.AMENDMENT_WINDOW_MINS || '2');

if (!data.order_id) {
  return [{ json: { ...data, error: 'NO_ORDER', error_msg: "You don't have an active order to edit." } }];
}

if (data.status === 'preparing') {
  return [{ json: { ...data, error: 'TOO_LATE', error_msg: "⚠️ Your order is already being prepared. Please speak to our staff for changes." } }];
}

const confirmedAt = new Date(data.confirmed_at);
const nowMs = Date.now();
const windowMs = AMENDMENT_MINS * 60 * 1000;

if ((nowMs - confirmedAt.getTime()) > windowMs) {
  return [{ json: { ...data, error: 'WINDOW_CLOSED', error_msg: \`⚠️ Your \${AMENDMENT_MINS}-minute edit window has closed. Please speak to staff.\` } }];
}

// Within window — reload order items into cart and reset order
return [{ json: { ...data, amendment_allowed: true } }];
`
    },
    id: "amendment_window_logic",
    name: "Amendment Window Logic",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [3000, 800]
};

const executeAmendmentNode = {
    parameters: {
        operation: "executeQuery",
        query: `
UPDATE orders SET status = 'order_received' WHERE order_id = $1;
UPDATE user_sessions SET cart = (SELECT items FROM orders WHERE order_id = $1) WHERE phone = $2;
INSERT INTO order_amendments (order_id, before_state, after_state, amended_at)
VALUES ($1, (SELECT items FROM orders WHERE order_id = $1), NULL, NOW());
COMMIT;`,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.order_id }}" },
            { column: "$2", value: "={{ $('Route Action').item.json.from }}" }
        ]}}
    },
    id: "execute_amendment",
    name: "Execute Amendment",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [3200, 800],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

wf.nodes.push(amendmentCheckNode, amendmentWindowLogicNode, executeAmendmentNode);
wf.connections['Amendment Check'] = { main: [[{ node: "Amendment Window Logic", type: "main", index: 0 }]] };
wf.connections['Amendment Window Logic'] = { main: [[{ node: "Execute Amendment", type: "main", index: 0 }]] };
wf.connections['Execute Amendment'] = { main: [[{ node: "Format Cart", type: "main", index: 0 }]] };

if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push({
        conditions: { conditions: [
            { leftValue: "={{ $json.text }}", rightValue: "EDIT ORDER", operator: { type: "string", operation: "contains" } }
        ]},
        renameOutput: true, outputKey: "edit_order"
    });
    rules.values.push(fallback);
    const main = wf.connections['Route Action'].main;
    main[rules.values.length - 2] = [{ node: "Amendment Check", type: "main", index: 0 }];
}
console.log('  [5] Amendment window with SELECT FOR UPDATE NOWAIT race condition guard added');

// ─────────────────────────────────────────────────────────────────────────────
// 6. PREP TIME ESTIMATION in order confirmation message
// ─────────────────────────────────────────────────────────────────────────────
const prepTimeNode = {
    parameters: {
        operation: "executeQuery",
        query: `
SELECT
  (SELECT COUNT(*) FROM orders WHERE status = 'preparing') AS queue_depth,
  (SELECT value::int FROM settings WHERE key = 'avg_prep_minutes') AS avg_prep
`,
        alwaysOutputData: true
    },
    id: "get_prep_time",
    name: "Get Prep Time",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [3000, 550],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

wf.nodes.push(prepTimeNode);
// Wire Prepare Order → Get Prep Time → Send Confirmation (existing connection modified below)
const saveOrderNode = wf.nodes.find(n => n.name === 'Prepare Order' || n.name === 'Save Order to DB');
if (saveOrderNode && wf.connections[saveOrderNode.name]) {
    const oldNext = wf.connections[saveOrderNode.name].main[0];
    wf.connections[saveOrderNode.name].main[0] = [{ node: "Get Prep Time", type: "main", index: 0 }];
    wf.connections['Get Prep Time'] = { main: [oldNext || []] };
}
console.log('  [6] Prep time estimation query added after order save');

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROMO CODE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const validatePromoNode = {
    parameters: {
        operation: "executeQuery",
        query: `
SELECT code, type, discount, valid_hours_start, valid_hours_end, valid_days, expiry
FROM promotions
WHERE code = UPPER($1)
  AND active = true
  AND (expiry IS NULL OR expiry >= CURRENT_DATE)
  AND (valid_days IS NULL OR TO_CHAR(NOW() AT TIME ZONE $2, 'Dy') = ANY(valid_days))
  AND (valid_hours_start IS NULL OR
       (NOW() AT TIME ZONE $2)::TIME BETWEEN valid_hours_start AND valid_hours_end)
LIMIT 1`,
        alwaysOutputData: true,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.promo_code }}" },
            { column: "$2", value: "={{ $env.TIMEZONE }}" }
        ]}}
    },
    id: "validate_promo",
    name: "Validate Promo",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2800, 950],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const applyPromoNode = {
    parameters: {
        jsCode: `
const promo = $input.item.json;
const session = $('Route Action').item.json.session;
const from = $('Route Action').item.json.from;

if (!promo.code) {
  return [{ json: { error: 'INVALID_PROMO', error_msg: "❌ That promo code is invalid, expired, or not valid right now." } }];
}

const subtotal = (session.cart || []).reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
const discount = promo.type === 'percentage'
  ? Math.round(subtotal * promo.discount / 100)
  : promo.discount;

return [{ json: { promo_applied: promo.code, discount_amount: discount, original_subtotal: subtotal } }];
`
    },
    id: "apply_promo",
    name: "Apply Promo",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [3000, 950]
};

wf.nodes.push(validatePromoNode, applyPromoNode);
wf.connections['Validate Promo'] = { main: [[{ node: "Apply Promo", type: "main", index: 0 }]] };
wf.connections['Apply Promo'] = { main: [[{ node: "Format Cart Review", type: "main", index: 0 }]] };

const extractPromoNode = {
    parameters: {
        jsCode: `
const text = $json.text || '';
const match = text.match(/(?:PROMO|DISCOUNT|CODE)\\s*[:\\s]?\\s*([A-Z0-9]+)/i);
const code = match ? match[1].toUpperCase() : null;
if (!code) return [{ json: { ...$json, error: 'NO_CODE', error_msg: 'Please send your promo code like: PROMO SAVE20' } }];
return [{ json: { ...$json, promo_code: code } }];
`
    },
    id: "extract_promo",
    name: "Extract Promo Code",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [2600, 950]
};

wf.nodes.push(extractPromoNode);
wf.connections['Extract Promo Code'] = { main: [[{ node: "Validate Promo", type: "main", index: 0 }]] };

if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push({
        conditions: { conditions: [
            { leftValue: "={{ $json.text }}", rightValue: "PROMO", operator: { type: "string", operation: "contains" } }
        ]},
        renameOutput: true, outputKey: "promo"
    });
    rules.values.push(fallback);
    const main = wf.connections['Route Action'].main;
    main[rules.values.length - 2] = [{ node: "Extract Promo Code", type: "main", index: 0 }];
}
console.log('  [7] Promo code engine with time/day/expiry validation added');

// ─────────────────────────────────────────────────────────────────────────────
// 8. VOICE NOTE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
const voiceTypeCheckNode = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.message_type }}", rightValue: "audio", operator: { type: "string", operation: "equals" } }]
        }
    },
    id: "voice_type_check",
    name: "Voice Type Check",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [700, 650]
};

const downloadVoiceNode = {
    parameters: {
        method: "GET",
        url: "=https://graph.facebook.com/v21.0/{{ $json.media_id }}",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
    },
    id: "download_voice",
    name: "Download Voice",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [900, 550],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

const transcribeVoiceNode = {
    parameters: {
        method: "POST",
        url: "https://api.groq.com/openai/v1/audio/transcriptions",
        sendHeaders: true,
        headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $env.GROQ_API_KEY }}" }] },
        sendBody: true,
        contentType: "multipart-form-data",
        bodyParameters: {
            parameters: [
                { name: "model", value: "whisper-large-v3" },
                { name: "file", value: "={{ $json.url }}" }
            ]
        }
    },
    id: "transcribe_voice",
    name: "Transcribe Voice",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1100, 550],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

const voiceConfirmNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "🎙️ Got your voice note!\\n\\nHere's what I heard:\\n\\"{{ $json.transcript }}\\"\\n\\nIs this correct?"}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CMD_VOICE_YES", "title": "✅ Yes, proceed"}}, {"type": "reply", "reply": {"id": "CMD_VOICE_NO", "title": "❌ No, retype"}}]}}}`
    },
    id: "voice_confirm",
    name: "Voice Confirm",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1300, 550],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(voiceTypeCheckNode, downloadVoiceNode, transcribeVoiceNode, voiceConfirmNode);
wf.connections['Voice Type Check'] = {
    main: [
        [{ node: "Download Voice", type: "main", index: 0 }],    // audio
        [{ node: "GDPR Consent Prepare", type: "main", index: 0 }] // text → normal flow
    ]
};
wf.connections['Download Voice'] = { main: [[{ node: "Transcribe Voice", type: "main", index: 0 }]] };
wf.connections['Transcribe Voice'] = { main: [[{ node: "Voice Confirm", type: "main", index: 0 }]] };
console.log('  [8] Voice note handler with Groq Whisper transcription added');

// ─────────────────────────────────────────────────────────────────────────────
// 9. LAST INBOUND TIMESTAMP update (fixes COALESCE null issue)
// ─────────────────────────────────────────────────────────────────────────────
wf.nodes.forEach(node => {
    if (node.parameters && node.parameters.query) {
        if (node.parameters.query.includes('INSERT INTO user_sessions') && node.parameters.query.includes('ON CONFLICT')) {
            node.parameters.query += '\nDO UPDATE SET last_inbound_at = NOW();';
        }
    }
});
// Also inject update to last_inbound_at on every message receipt
const updateLastInboundNode = {
    parameters: {
        operation: "executeQuery",
        query: "UPDATE user_sessions SET last_inbound_at = NOW() WHERE phone = $1",
        alwaysOutputData: true,
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } }
    },
    id: "update_last_inbound",
    name: "Update Last Inbound",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [800, 750],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};
wf.nodes.push(updateLastInboundNode);
console.log('  [9] last_inbound_at timestamp maintained per message (fixes COALESCE null)');

// ─────────────────────────────────────────────────────────────────────────────
// FINALIZE
// ─────────────────────────────────────────────────────────────────────────────
fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('\n✅ V7 FULL workflow saved to', outFile);
