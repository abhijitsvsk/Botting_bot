const fs = require('fs');

const inFile = './restaurant_bot_V5_CONFIRM_FLOW.json';
const outFile = './restaurant_bot_V6_HARDENED.json';

const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
wf.name = "WhatsApp Restaurant Bot - V6 HARDENED";

// ─────────────────────────────────────────────────────────────────────────────
// 1. STATUS RENAME: Replace every 'pending_payment' string in node code/params
// ─────────────────────────────────────────────────────────────────────────────
const renameStatus = (str) => str.replace(/pending_payment/g, 'order_received');

wf.nodes = wf.nodes.map(node => {
    const nodeStr = renameStatus(JSON.stringify(node));
    return JSON.parse(nodeStr);
});
const connStr = renameStatus(JSON.stringify(wf.connections));
wf.connections = JSON.parse(connStr);
console.log('  [1] Status rename: pending_payment → order_received');

// ─────────────────────────────────────────────────────────────────────────────
// 2. ENV VALIDATION: Add new required vars
// ─────────────────────────────────────────────────────────────────────────────
const envNode = wf.nodes.find(n => n.name === 'Validate Environment');
if (envNode && envNode.parameters.jsCode) {
    envNode.parameters.jsCode = envNode.parameters.jsCode.replace(
        /const required = \[([^\]]+)\];/,
        `const required = [$1, 'OPENING_TIME', 'CLOSING_TIME', 'TIMEZONE', 'ALLERGEN_KEYWORDS', 'PRIVACY_POLICY_VERSION'];`
    );
    console.log('  [2] Env validation updated with new required vars');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OPERATING HOURS CHECK (with timezone — placed as first node after webhook)
// Bug in all previous versions: used raw NOW() which is UTC, not local time.
// ─────────────────────────────────────────────────────────────────────────────
const operatingHoursNode = {
    parameters: {
        jsCode: `
const tz = $env.TIMEZONE || 'Asia/Kolkata';
const now = new Date().toLocaleString('en-US', { timeZone: tz });
const localNow = new Date(now);
const currentMins = localNow.getHours() * 60 + localNow.getMinutes();

const parseTime = (t) => {
    const [h, m] = (t || '09:00').split(':').map(Number);
    return h * 60 + (m || 0);
};

const openMins = parseTime($env.OPENING_TIME);
const closeMins = parseTime($env.CLOSING_TIME);

const isOpen = closeMins > openMins
    ? currentMins >= openMins && currentMins < closeMins
    : currentMins >= openMins || currentMins < closeMins; // handles midnight crossover e.g. 22:00-02:00

return [{ json: { ...$input.first().json, kitchen_is_open: isOpen, current_time_tz: now } }];
`
    },
    id: "check_operating_hours",
    name: "Check Operating Hours",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [350, 350]
};

const kitchenClosedResponseNode = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.kitchen_is_open }}", rightValue: false, operator: { type: "boolean", operation: "equals" } }]
        }
    },
    id: "if_kitchen_closed",
    name: "If Kitchen Closed",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [550, 350]
};

const sendClosedMessageNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "text", "text": {"body": "🕐 We're currently closed.\\n\\nWe're open {{ $env.OPENING_TIME }} – {{ $env.CLOSING_TIME }} ({{ $env.TIMEZONE }}).\\n\\nFeel free to browse our menu when we reopen! Send MENU anytime."}}`
    },
    id: "send_closed_message",
    name: "Send Closed Message",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [750, 250],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(operatingHoursNode, kitchenClosedResponseNode, sendClosedMessageNode);
wf.connections['Check Operating Hours'] = { main: [[{ node: "If Kitchen Closed", type: "main", index: 0 }]] };
wf.connections['If Kitchen Closed'] = {
    main: [
        [{ node: "Send Closed Message", type: "main", index: 0 }], // true = closed
        [{ node: "Sanitize Input", type: "main", index: 0 }]        // false = open → proceed
    ]
};
console.log('  [3] Operating hours check added (timezone-aware via Asia/Kolkata)');

// ─────────────────────────────────────────────────────────────────────────────
// 4. GDPR / DPDP CONSENT (correct sequence: don't write to DB until AGREE)
// Bug in v1 plan: phone was written to DB before consent.
// Now: first message from unknown phone triggers consent flow, NOTHING stored yet.
// ─────────────────────────────────────────────────────────────────────────────
const gdprConsentCheckNode = {
    parameters: {
        jsCode: `
const from = $json.from;
// Check if consent record exists BEFORE touching user_sessions
return [{ json: { ...$json, _consent_check_phone: from } }];
`
    },
    id: "gdpr_consent_prepare",
    name: "GDPR Consent Prepare",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [950, 350]
};

const checkConsentDbNode = {
    parameters: {
        operation: "executeQuery",
        query: "SELECT consent_given_at, opt_out, policy_version FROM user_sessions WHERE phone = $1 LIMIT 1",
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } }
    },
    id: "check_consent_db",
    name: "Check Consent DB",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1100, 350],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const ifNeedsConsentNode = {
    parameters: {
        conditions: {
            conditions: [{ leftValue: "={{ $json.consent_given_at }}", operator: { type: "string", operation: "isEmpty" } }]
        }
    },
    id: "if_needs_consent",
    name: "If Needs Consent",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1300, 350]
};

const sendConsentMessageNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('GDPR Consent Prepare').item.json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "👋 Welcome to {{ $env.RESTAURANT_NAME }}!\\n\\nBefore you order, we need your consent to store your phone number and order details to process your request.\\n\\n📋 We store: phone number, orders placed, table number.\\n❌ We never share your data with third parties.\\n🗑️ Text DELETE MY DATA anytime to erase your information.\\n\\nBy tapping Agree you consent to our data policy (v{{ $env.PRIVACY_POLICY_VERSION }})."}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CMD_GDPR_AGREE", "title": "✅ I Agree"}}, {"type": "reply", "reply": {"id": "CMD_GDPR_DECLINE", "title": "❌ No Thanks"}}]}}}`
    },
    id: "send_consent_message",
    name: "Send Consent Message",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1500, 250],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

const writeConsentToDbNode = {
    parameters: {
        operation: "executeQuery",
        // Only NOW do we write the phone number to user_sessions — after consent
        query: `INSERT INTO user_sessions (phone, consent_given_at, policy_version, cart)
                VALUES ($1, NOW(), $2, '[]'::jsonb)
                ON CONFLICT (phone) DO UPDATE
                SET consent_given_at = NOW(), policy_version = $2`,
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $('GDPR Consent Prepare').item.json.from }}" },
            { column: "$2", value: "={{ $env.PRIVACY_POLICY_VERSION }}" }
        ]}}
    },
    id: "write_consent_db",
    name: "Write Consent to DB",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1700, 250],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const sendConsentDeclinedNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('GDPR Consent Prepare').item.json.from }}", "type": "text", "text": {"body": "No problem! We haven't stored any of your data. You won't be able to use the ordering system without consent. Feel free to come back anytime if you change your mind. 🙂"}}`
    },
    id: "send_consent_declined",
    name: "Send Consent Declined",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1500, 450],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(gdprConsentCheckNode, checkConsentDbNode, ifNeedsConsentNode, sendConsentMessageNode, writeConsentToDbNode, sendConsentDeclinedNode);

wf.connections['GDPR Consent Prepare'] = { main: [[{ node: "Check Consent DB", type: "main", index: 0 }]] };
wf.connections['Check Consent DB'] = { main: [[{ node: "If Needs Consent", type: "main", index: 0 }]] };
wf.connections['If Needs Consent'] = {
    main: [
        [{ node: "Send Consent Message", type: "main", index: 0 }],  // true = no consent
        [{ node: "Route Action", type: "main", index: 0 }]           // false = consented → proceed
    ]
};
wf.connections['Write Consent to DB'] = { main: [[]] }; // terminal

// Route CMD_GDPR_AGREE/DECLINE through Route Action
const routeNode = wf.nodes.find(n => n.name === 'Route Action');
if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push(
        {
            conditions: { conditions: [{ leftValue: "={{ $json.action }}", rightValue: "CMD_GDPR_AGREE", operator: { type: "string", operation: "equals" } }] },
            renameOutput: true, outputKey: "gdpr_agree"
        },
        {
            conditions: { conditions: [{ leftValue: "={{ $json.action }}", rightValue: "CMD_GDPR_DECLINE", operator: { type: "string", operation: "equals" } }] },
            renameOutput: true, outputKey: "gdpr_decline"
        }
    );
    rules.values.push(fallback);

    const main = wf.connections['Route Action'].main;
    const agreeIdx = rules.values.length - 3;
    const declineIdx = rules.values.length - 2;
    main[agreeIdx] = [{ node: "Write Consent to DB", type: "main", index: 0 }];
    main[declineIdx] = [{ node: "Send Consent Declined", type: "main", index: 0 }];
}
console.log('  [4] GDPR consent flow added (correct sequence: DB write AFTER agree)');

// ─────────────────────────────────────────────────────────────────────────────
// 5. ALLERGEN PRE-SCAN (runs before Groq to flag orders)
// ─────────────────────────────────────────────────────────────────────────────
const allergenScanNode = {
    parameters: {
        jsCode: `
const text = ($json.text || '').toLowerCase();
const keywords = ($env.ALLERGEN_KEYWORDS || 'nut,peanut,gluten,dairy,egg,shellfish,soy,wheat,sesame,fish').split(',');
const found = keywords.filter(k => text.includes(k.trim().toLowerCase()));
const hasAllergen = found.length > 0;
return [{ json: { ...$json, allergen_alert: hasAllergen, allergen_text: found.join(', ') } }];
`
    },
    id: "allergen_scan",
    name: "Allergen Pre-Scan",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1600, 650]
};

// Wire allergen scan before Groq parser
const groqNode = wf.nodes.find(n => n.name === 'Groq AI Parser');
if (groqNode) {
    wf.nodes.push(allergenScanNode);
    // Reroute whatever pointed at Groq to go through allergen scan first
    Object.keys(wf.connections).forEach(nodeName => {
        const conns = wf.connections[nodeName];
        if (conns && conns.main) {
            conns.main.forEach(branch => {
                if (branch) branch.forEach(c => {
                    if (c.node === 'Groq AI Parser') c.node = 'Allergen Pre-Scan';
                });
            });
        }
    });
    if (!wf.connections['Allergen Pre-Scan']) wf.connections['Allergen Pre-Scan'] = { main: [[]] };
    wf.connections['Allergen Pre-Scan'].main[0] = [{ node: 'Groq AI Parser', type: 'main', index: 0 }];
    console.log('  [5] Allergen pre-scan node injected before Groq parser');
} else {
    console.warn('  [5] WARN: Groq AI Parser not found — allergen scan not wired');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. IDEMPOTENCY KEY: Store on user_sessions at checkout, clear after window
// Fix: v1 cleared it immediately — should keep for amendment_window + 10m
// ─────────────────────────────────────────────────────────────────────────────
const idempotencyNode = {
    parameters: {
        jsCode: `
const { v4: uuidv4 } = require('crypto');
// Use crypto.randomUUID() which is available in Node 14.17+
const key = $json.session && $json.session.idempotency_key
    ? $json.session.idempotency_key
    : require('crypto').randomUUID();
return [{ json: { ...$json, idempotency_key: key } }];
`
    },
    id: "generate_idempotency_key",
    name: "Generate Idempotency Key",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [2000, 550]
};

const storeIdempotencyKeyNode = {
    parameters: {
        operation: "executeQuery",
        query: "UPDATE user_sessions SET idempotency_key = $1 WHERE phone = $2",
        additionalFields: { values: { values: [
            { column: "$1", value: "={{ $json.idempotency_key }}" },
            { column: "$2", value: "={{ $json.from }}" }
        ]}}
    },
    id: "store_idempotency_key",
    name: "Store Idempotency Key",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2200, 550],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

wf.nodes.push(idempotencyNode, storeIdempotencyKeyNode);
wf.connections['Generate Idempotency Key'] = { main: [[{ node: "Store Idempotency Key", type: "main", index: 0 }]] };
wf.connections['Store Idempotency Key'] = { main: [[{ node: "Send Cart Review", type: "main", index: 0 }]] };

// Wire Format Cart Review → Idempotency → Cart Review (instead of straight to cart review)
if (wf.connections['If Empty Cart']) {
    const falseOutput = wf.connections['If Empty Cart'].main[1];
    if (falseOutput) {
        wf.connections['If Empty Cart'].main[1] = [{ node: "Generate Idempotency Key", type: "main", index: 0 }];
    }
}
console.log('  [6] Idempotency key generation wired before checkout review');

// ─────────────────────────────────────────────────────────────────────────────
// 7. SAVE ORDER: Use idempotency_key as UNIQUE constraint guard, store allergen
// ─────────────────────────────────────────────────────────────────────────────
const saveOrderNode = wf.nodes.find(n => n.name === 'Save Order to DB' || n.name === 'Prepare Order');
if (saveOrderNode && saveOrderNode.parameters) {
    const oldQuery = saveOrderNode.parameters.query || '';
    if (oldQuery.includes('INSERT INTO orders')) {
        saveOrderNode.parameters.query = oldQuery
            .replace(
                /INSERT INTO orders \(([^)]+)\)/,
                'INSERT INTO orders ($1, allergen_alert, allergen_text, tax_rate, tax_amount, idempotency_key, source, confirmed_at)'
            )
            .replace(
                /VALUES \(([^)]+)\)/,
                "VALUES ($1, $allergen_alert, $allergen_text, $tax_rate, $tax_amount, $idempotency_key, 'whatsapp', NOW())"
            );
    }
    console.log('  [7] Save Order node updated with allergen + idempotency columns');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 86 MECHANISM: Filter menu to available=true only when fetching menu items
// ─────────────────────────────────────────────────────────────────────────────
wf.nodes.forEach(node => {
    if (node.parameters && node.parameters.query) {
        if (node.parameters.query.includes('FROM menu_items') && !node.parameters.query.includes('available')) {
            node.parameters.query = node.parameters.query.replace(
                /FROM menu_items/g,
                'FROM menu_items WHERE available = true'
            ).replace(
                /WHERE available = true AND/g,
                'WHERE available = true AND'
            );
        }
    }
});
console.log('  [8] 86 mechanism applied: menu queries now filter WHERE available = true');

// ─────────────────────────────────────────────────────────────────────────────
// 9. DELETE MY DATA keyword handler
// ─────────────────────────────────────────────────────────────────────────────
const deleteDataNode = {
    parameters: {
        operation: "executeQuery",
        query: `
UPDATE orders
SET phone = encode(digest(phone, 'sha256'), 'hex')
WHERE phone = $1;

DELETE FROM user_sessions WHERE phone = $1;
`,
        additionalFields: { values: { values: [{ column: "$1", value: "={{ $json.from }}" }] } }
    },
    id: "delete_user_data",
    name: "Delete User Data",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [3200, 350],
    credentials: { postgres: { id: "postgres_main", name: "Restaurant DB" } }
};

const sendDeleteConfirmNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Route Action').item.json.from }}", "type": "text", "text": {"body": "✅ Done. Your phone number and personal data have been securely erased from our system. Historical order records have been anonymised.\\n\\nThank you for using {{ $env.RESTAURANT_NAME }}!"}}`
    },
    id: "send_delete_confirm",
    name: "Send Delete Confirm",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [3400, 350],
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(deleteDataNode, sendDeleteConfirmNode);
wf.connections['Delete User Data'] = { main: [[{ node: "Send Delete Confirm", type: "main", index: 0 }]] };

// Wire DELETE MY DATA through Route Action
if (routeNode && routeNode.parameters.rules) {
    const rules = routeNode.parameters.rules;
    const fallback = rules.values.pop();
    rules.values.push({
        conditions: { conditions: [{ leftValue: "={{ $json.action }}", rightValue: "DELETE MY DATA", operator: { type: "string", operation: "contains" } }] },
        renameOutput: true, outputKey: "delete_data"
    });
    rules.values.push(fallback);
    const main = wf.connections['Route Action'].main;
    main[rules.values.length - 2] = [{ node: "Delete User Data", type: "main", index: 0 }];
}
console.log('  [9] DELETE MY DATA handler wired');

// ─────────────────────────────────────────────────────────────────────────────
// FINALIZE
// ─────────────────────────────────────────────────────────────────────────────
fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('\n✅ V6 HARDENED workflow saved to', outFile);
