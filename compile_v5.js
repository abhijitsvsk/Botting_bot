const fs = require('fs');

const inFile = './restaurant_bot_FINAL_ALL_FEATURES.json';
const outFile = './restaurant_bot_V5_CONFIRM_FLOW.json';

const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
wf.name = "WhatsApp Restaurant Bot - V5 CONFIRM FLOW";

// 1. Create Format Cart Review Node
const formatCartReviewNode = {
    parameters: {
        jsCode: `
const cart = $json.session.cart || [];
if (cart.length === 0) {
   return [{json: {...$json, empty_cart: true}}];
}
const subtotal = cart.reduce((sum, i) => sum + ((i.price || 0) * (i.quantity || 1)), 0);
const taxRate = parseFloat($env.TAX_RATE || '0') / 100;
const tax = Math.round(subtotal * taxRate);
const total = subtotal + tax;
return [{json: {...$json, subtotal, tax, total}}];
`
    },
    id: "format_cart_review",
    name: "Format Cart Review",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [2000, 350]
};

const checkIfEmptyNode = {
    parameters: {
        conditions: { string: [{"value1": "={{ $json.empty_cart }}", "operation": "isNotEmpty"}] }
    },
    id: "if_empty_cart",
    name: "If Empty Cart",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [2200, 350]
};

const sendEmptyCartNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "text", "text": {"body": "🛒 Your cart is currently empty! Send MENU to see what we have."}}`
    },
    id: "send_empty_cart",
    name: "Send Empty Cart",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [2400, 250],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

// 2. Create Send Cart Review Node
const sendCartReviewNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "🛒 *REVIEW YOUR CART*\\n\\n{{ $json.session.cart.map(c => c.quantity + 'x ' + c.name).join('\\\\n') }}\\n\\nSubtotal: ₹{{ $json.subtotal }}\\nTax: ₹{{ $json.tax }}\\n*Total: ₹{{ $json.total }}*"}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CMD_CONFIRM", "title": "✅ Confirm"}}, {"type": "reply", "reply": {"id": "CMD_CUSTOMISE", "title": "📝 Customise More"}}, {"type": "reply", "reply": {"id": "CMD_CLEAR_CART", "title": "🗑️ Clear Cart"}}]}}}`
    },
    id: "send_cart_review",
    name: "Send Cart Review",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [2400, 450],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

wf.nodes.push(formatCartReviewNode, checkIfEmptyNode, sendEmptyCartNode, sendCartReviewNode);

wf.connections['Format Cart Review'] = { main: [[{node: "If Empty Cart", type: "main", index: 0}]] };
wf.connections['If Empty Cart'] = { main: [[{node: "Send Empty Cart", type: "main", index: 0}], [{node: "Send Cart Review", type: "main", index: 0}]] }; // True -> Empty, False -> Review

// 3. Re-route 'checkout' and 'cart' to Format Cart Review instead of Prepare Order / Format Cart
if (wf.connections['Route Action'] && wf.connections['Route Action'].main) {
    const main = wf.connections['Route Action'].main;
    for (let i = 0; i < main.length; i++) {
        if (main[i] && main[i].length > 0) {
            main[i] = main[i].map(c => {
                if (c.node === 'Prepare Order' || c.node === 'Format Cart') {
                    return {node: "Format Cart Review", type: "main", index: 0};
                }
                return c;
            });
        }
    }
}

// 4. Create Clear Cart & Customise Nodes
const executeClearCartNode = {
    parameters: {
        authentication: "genericCredentialType",
        genericAuthType: "postgresApi",
        operation: "executeQuery",
        query: "UPDATE user_sessions SET cart = '[]'::jsonb WHERE phone = $1 RETURNING *",
        additionalFields: {
            values: { values: [{"column": "$1", "value": "={{ $json.from }}"}] }
        }
    },
    id: "execute_clear_cart",
    name: "Execute Clear Cart",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [2200, 700],
    credentials: {"postgres": {"id": "postgres_main", "name": "Restaurant DB"}}
};

const sendClearSuccessNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Route Action').item.json.from }}", "type": "text", "text": {"body": "🗑️ Your cart has been cleared! Send MENU to start over."}}`
    },
    id: "send_clear_success",
    name: "Send Clear Success",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [2400, 700],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

const sendCustomiseNode = {
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={"messaging_product": "whatsapp", "to": "{{ $('Route Action').item.json.from }}", "type": "text", "text": {"body": "📝 Great! Type out what else you'd like to add or remove."}}`
    },
    id: "send_customise_success",
    name: "Send Customise Success",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [2200, 850],
    credentials: {"whatsAppApi": {"id": "whatsapp_cred", "name": "WhatsApp API"}}
};

wf.nodes.push(executeClearCartNode, sendClearSuccessNode, sendCustomiseNode);
wf.connections['Execute Clear Cart'] = { main: [[{node: "Send Clear Success", type: "main", index: 0}]] };

// 5. Catch button payloads in Route Action
const routeNode = wf.nodes.find(n => n.name === 'Route Action');
if (routeNode) {
    const rules = routeNode.parameters.rules;
    const fallbackRule = rules.values.pop();
    
    rules.values.push({
        conditions: {
            conditions: [ { leftValue: "={{ $json.action }}", rightValue: "CMD_CONFIRM", operator: { type: "string", operation: "equals" } } ]
        },
        renameOutput: true,
        outputKey: "cmd_confirm"
    });
    rules.values.push({
        conditions: {
            conditions: [ { leftValue: "={{ $json.action }}", rightValue: "CMD_CUSTOMISE", operator: { type: "string", operation: "equals" } } ]
        },
        renameOutput: true,
        outputKey: "cmd_customise"
    });
    rules.values.push({
        conditions: {
            conditions: [ { leftValue: "={{ $json.action }}", rightValue: "CMD_CLEAR_CART", operator: { type: "string", operation: "equals" } } ]
        },
        renameOutput: true,
        outputKey: "cmd_clear_cart"
    });
    
    rules.values.push(fallbackRule);
}

// 6. Connect the new routes
if (wf.connections['Route Action'] && wf.connections['Route Action'].main) {
    const main = wf.connections['Route Action'].main;
    const ruleCount = routeNode.parameters.rules.values.length;
    const confirmIndex = ruleCount - 4;
    const customiseIndex = ruleCount - 3;
    const clearIndex = ruleCount - 2;
    const fallbackIndex = ruleCount - 1;
    
    const oldFallbackConns = main[fallbackIndex - 3] || [];
    
    main[confirmIndex] = [{node: "Prepare Order", type: "main", index: 0}]; // THIS IS IT! We route CONFIRM straight to Prepare Order
    main[customiseIndex] = [{node: "Send Customise Success", type: "main", index: 0}];
    main[clearIndex] = [{node: "Execute Clear Cart", type: "main", index: 0}];
    main[fallbackIndex] = oldFallbackConns;
}

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log("Created V5 Flow");
