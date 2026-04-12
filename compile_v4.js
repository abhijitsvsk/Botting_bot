const fs = require('fs');
const inFile = './restaurant_bot_V3_ULTIMATE.json';
const outFile = './restaurant_bot_V4_EDGE_CASES.json';

const raw = fs.readFileSync(inFile, 'utf8');
const wf = JSON.parse(raw);

wf.name = "WhatsApp Restaurant Bot - V4 EDGE CASES (Cancellation)";

// 1. Add CANCEL route
const routeNode = wf.nodes.find(n => n.name === 'Route Action');
if (routeNode) {
    const rules = routeNode.parameters.rules;
    const fallbackRule = rules.values.pop();
    rules.values.push({
        conditions: {
            conditions: [
                { leftValue: "={{ $json.action || $json.text }}", rightValue: "CANCEL", operator: { type: "string", operation: "equals" } },
                { leftValue: "={{ $json.text.toUpperCase() }}", rightValue: "CANCEL ORDER", operator: { type: "string", operation: "equals" } }
            ],
            combinator: "or"
        },
        renameOutput: true,
        outputKey: "cancel"
    });
    rules.values.push(fallbackRule);
}

// 2. Add Cancel Logic Nodes
const checkCancelEligibilityNode = {
    parameters: {
        authentication: "genericCredentialType",
        genericAuthType: "postgresApi",
        operation: "executeQuery",
        query: "SELECT order_id, status, created_at FROM orders WHERE phone = $1 AND status = 'pending_payment' AND created_at >= NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1",
        additionalFields: {
            values: { values: [{"column": "$1", "value": "={{ $json.from }}"}] }
        }
    },
    id: "check_cancel_eligibility",
    name: "Check Cancel Eligibility",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1300, 1000],
    alwaysOutputData: true,
    credentials: {"postgres": {"id": "postgres_main", "name": "Restaurant DB"}}
};

const ifEligibleNode = {
    parameters: {
        conditions: { string: [{"value1": "={{ $json.order_id }}", "operation": "isNotEmpty"}] }
    },
    id: "if_cancel_eligible",
    name: "If Cancel Eligible",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1500, 1000]
};

const sendCancelFailNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Route Action').item.json.from }}", "type": "text", "text": {"body": "❌ We couldn't find a recent order that can be cancelled.\\n\\nIf your order is already being prepared, please speak to the restaurant staff."}}`
    },
    id: "send_cancel_fail",
    name: "Send Cancel Fail",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1700, 1150],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

const executeCancelNode = {
    parameters: {
        authentication: "genericCredentialType",
        genericAuthType: "postgresApi",
        operation: "executeQuery",
        query: "UPDATE orders SET status = 'cancelled' WHERE order_id = $1 RETURNING *",
        additionalFields: {
            values: { values: [{"column": "$1", "value": "={{ $json.order_id }}"}] }
        }
    },
    id: "execute_cancel",
    name: "Execute Cancel in DB",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1700, 1000],
    credentials: {"postgres": {"id": "postgres_main", "name": "Restaurant DB"}}
};

const sendCancelSuccessNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Route Action').item.json.from }}", "type": "text", "text": {"body": "✅ Your order {{ $json.order_id }} has been successfully cancelled!"}}`
    },
    id: "send_cancel_success",
    name: "Send Cancel Success",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1900, 1000],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

wf.nodes.push(checkCancelEligibilityNode, ifEligibleNode, sendCancelFailNode, executeCancelNode, sendCancelSuccessNode);

// 3. Update connections seamlessly
if (wf.connections['Route Action'] && wf.connections['Route Action'].main) {
    const oldFallback = wf.connections['Route Action'].main[5];
    wf.connections['Route Action'].main[6] = oldFallback;
    wf.connections['Route Action'].main[5] = [{node: "Check Cancel Eligibility", type: "main", index: 0}];
}

wf.connections['Check Cancel Eligibility'] = { main: [[{node: "If Cancel Eligible", type: "main", index: 0}]]};
wf.connections['If Cancel Eligible'] = { main: [[{node: "Execute Cancel in DB", type: "main", index: 0}], [{node: "Send Cancel Fail", type: "main", index: 0}]] };
wf.connections['Execute Cancel in DB'] = { main: [[{node: "Send Cancel Success", type: "main", index: 0}]]};

// 4. Update the "Send Order Confirmation" node
const sendOrderConfirmNode = wf.nodes.find(n => n.name === 'Send Order Confirmation');
if (sendOrderConfirmNode) {
    sendOrderConfirmNode.parameters.jsonBody = `={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "✅ *ORDER CREATED!*\\n\\n📋 Order ID: {{ $json.order.order_id }}\\n🪑 Table: {{ $json.order.table_number }}\\n💰 Total: ₹{{ $json.order.total }}\\n\\n━━━━━━━━━\\n💳 *PAYMENT REQUIRED*\\n━━━━━━━━━\\n\\nPlease pay at the counter and show this order ID to staff.\\n\\n⚠️ Order prepared ONLY after payment.\\n📞 Support: {{ $env.SUPPORT_PHONE }}"}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CANCEL", "title": "❌ Cancel Order"}}]}}}`;
}

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('Saved V4 EDGE CASES workflow to', outFile);
