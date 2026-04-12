const fs = require('fs');
const inFile = './restaurant_bot_V2_AI_EDITION.json';
const outFile = './restaurant_bot_V3_ULTIMATE.json';

const raw = fs.readFileSync(inFile, 'utf8');
const wf = JSON.parse(raw);

wf.name = "WhatsApp Restaurant Bot - V3 ULTIMATE EDITION";

// 1. Context Injection for AI
// Create "Get Menu for AI context" node
const getMenuAiNode = {
    parameters: {
        authentication: "genericCredentialType",
        genericAuthType: "postgresApi",
        operation: "executeQuery",
        query: "SELECT code, name, is_available FROM menu_items"
    },
    id: "get_menu_ai_context",
    name: "Get Menu for AI context",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [1300, 650], // Before Groq which is at 1400
    credentials: {"postgres": {"id": "postgres_main", "name": "Restaurant DB"}}
};

// Insert the node
wf.nodes.push(getMenuAiNode);

// Modify Groq AI Parser
const groqNode = wf.nodes.find(n => n.name === 'Groq AI Parser');
if (groqNode) {
    groqNode.parameters.jsonBody = '={"model": "llama3-70b-8192", "messages": [{"role": "system", "content": "You extract food item codes and quantities from user orders. Here is the LIVE MENU DATABASE: {{ JSON.stringify($input.all().map(i => i.json)) }}. Return ONLY a valid JSON array of objects. Example: [{\\"code\\": \\"B1\\", \\"quantity\\": 2}]. Map their natural language requests perfectly to the menu codes. If they ask for an item that is is_available: false, STILL output its code."}, {"role": "user", "content": "{{ $(\'Sanitize Input\').item.json.text || $(\'Sanitize Input\').item.json.action }}"}], "temperature": 0}';
}

// Rewire Route Action -> Get Menu for AI context -> Groq AI Parser
const routeConn = wf.connections['Route Action'];
if (routeConn && routeConn.main && routeConn.main[4]) {
    // Index 4 was items
    routeConn.main[4] = [{node: 'Get Menu for AI context', type: 'main', index: 0}];
}

if (!wf.connections['Get Menu for AI context']) {
    wf.connections['Get Menu for AI context'] = { main: [[{node: 'Groq AI Parser', type: 'main', index: 0}]] };
}

// 2. Fix Add to Cart and Lookup Items in DB to handle Out of Stock properly
const lookupDbNode = wf.nodes.find(n => n.name === 'Lookup Items in DB');
if (lookupDbNode) {
    lookupDbNode.parameters.query = "SELECT code, name, price, category, is_available FROM menu_items WHERE code = ANY($1::text[])";
}

const addCartNode = wf.nodes.find(n => n.name === 'Add to Cart');
if (addCartNode) {
    addCartNode.parameters.jsCode = `
const inputData = $('Extract Groq Output').first().json;
const parsed_items = inputData.parsed_items || [];
const dbItems = $input.all().map(i => i.json);

if (!dbItems || dbItems.length === 0) return [{json: {...inputData, error: 'ITEMS_NOT_FOUND', error_msg: '❌ No valid items found\\n\\nType MENU to see available items'}}];

const session = inputData.session || {};
const cart = session.cart || [];
let outOfStock = [];
let itemsAdded = [];

dbItems.forEach(dbItem => {
  const requested = parsed_items.find(pi => pi.code === dbItem.code);
  const qty = requested ? requested.quantity : 1;
  
  if (!dbItem.is_available) {
     outOfStock.push(dbItem.name);
  } else {
     itemsAdded.push(qty + "x " + dbItem.name);
     const existing = cart.find(c => c.code === dbItem.code);
     if (existing) { existing.quantity += qty; } else {
        cart.push({...dbItem, quantity: qty, id: Date.now() + Math.random()});
     }
  }
});

session.cart = cart;

if (itemsAdded.length === 0 && outOfStock.length > 0) {
    return [{json: {...inputData, error: 'ALL_OUT_OF_STOCK', error_msg: '⚠️ Sorry, everything you requested (' + outOfStock.join(', ') + ') is currently sold out.'}}];
}

const subtotal = cart.reduce((sum, i) => sum + ((i.price || 0) * (i.quantity || 1)), 0);
const taxRate = parseFloat($env.TAX_RATE || '0') / 100;
const tax = Math.round(subtotal * taxRate);
const total = subtotal + tax;

return [{json: {...inputData, session, cart, subtotal, tax, total, items_added: itemsAdded, out_of_stock: outOfStock}}];
`;
}

// Modify Confirm Items Added to display out of stock warnings
const confirmAddNode = wf.nodes.find(n => n.name === 'Confirm Items Added');
if (confirmAddNode) {
    confirmAddNode.parameters.jsonBody = '={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "text", "text": {"body": "✅ Added to cart:\\n{{ $json.items_added.join(\'\\\\n\') }}\\n{{ $json.out_of_stock.length > 0 ? \'\\\\n⚠️ SOLD OUT (Not Added):\\\\n- \' + $json.out_of_stock.join(\'\\\\n- \') + \'\\\\n\' : \'\' }}\\n🛒 Total: ₹{{ $json.total }}\\n\\nType CART to review or send more items"}}';
}

// Add the ALL_OUT_OF_STOCK error check to Check Cart Error (Wait, Check Cart Error checks 'error' string, so it will just route to Send Error Message automatically because we added an error field!)
// The existing `Check Parse Error` works by checking if `error` isNotEmpty. Since `Add to Cart` creates `ALL_OUT_OF_STOCK`, we should add a `Check Add Error` node or just rely on the fallback structure.
// Actually `Update Cart in DB` -> `Confirm Items Added` is the flow. If `Add to Cart` creates an error, `Update Cart in DB` still runs, and `Confirm Items Added` sends the payload. But we want to send an error message instead!
// Let's insert an IF node after `Add to Cart`
const checkAddErrorNode = {
    parameters: {
        conditions: {
            string: [{"value1": "={{ $json.error }}", "operation": "isNotEmpty"}]
        }
    },
    id: "check_add_error",
    name: "Check Add Error",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1850, 650]
};

wf.nodes.push(checkAddErrorNode);

// Update connections for Add to Cart
if (wf.connections['Add to Cart'] && wf.connections['Add to Cart'].main) {
    wf.connections['Add to Cart'].main[0] = [{node: 'Check Add Error', type: 'main', index: 0}];
}
if (!wf.connections['Check Add Error']) wf.connections['Check Add Error'] = { main: [[], []] };
// True -> Send Error Message
wf.connections['Check Add Error'].main[0].push({node: 'Send Error Message', type: 'main', index: 0});
// False -> Update Cart in DB
wf.connections['Check Add Error'].main[1].push({node: 'Update Cart in DB', type: 'main', index: 0});


// 3. Google Sheets Manager Sync sub-workflow
const sheetsWebhook = {
    parameters: {
        httpMethod: "POST",
        path: "manager-sync",
        responseMode: "lastNode",
        options: {}
    },
    id: "manager_sync_webhook",
    name: "Manager Trigger (Sheets)",
    type: "n8n-nodes-base.webhook",
    typeVersion: 1.1,
    position: [200, -200],
    webhookId: "sync-trigger"
};

const sheetsNode = {
    parameters: {
        operation: "read",
        documentId: {"__rl": true, "value": "YOUR_SPREADSHEET_ID_HERE", "mode": "id"},
        sheetName: {"__rl": true, "value": "Sheet1", "mode": "name"},
        options: {}
    },
    id: "read_google_sheets",
    name: "Read Google Sheets",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.3,
    position: [400, -200],
    credentials: {"googleSheetsOAuth2Api": {"id": "google_oauth", "name": "Google Sheets account"}}
};

const postgresSyncNode = {
    parameters: {
        authentication: "genericCredentialType",
        genericAuthType: "postgresApi",
        operation: "executeQuery",
        query: "INSERT INTO menu_items (code, name, category, price, description, is_available) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price, description = EXCLUDED.description, is_available = EXCLUDED.is_available",
        additionalFields: {
            values: {
                values: [
                    {"column": "$1", "value": "={{ $json.code }}"},
                    {"column": "$2", "value": "={{ $json.name }}"},
                    {"column": "$3", "value": "={{ $json.category }}"},
                    {"column": "$4", "value": "={{ $json.price }}"},
                    {"column": "$5", "value": "={{ $json.description }}"},
                    {"column": "$6", "value": "={{ $json.is_available === 'TRUE' || $json.is_available === true }}"}
                ]
            }
        }
    },
    id: "sync_to_db",
    name: "Sync to DB",
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.4,
    position: [600, -200],
    credentials: {"postgres": {"id": "postgres_main", "name": "Restaurant DB"}}
};

const respondSyncNode = {
    parameters: {
        respondWith: "text",
        responseBody: "Sync Successful!"
    },
    id: "respond_webhook",
    name: "Respond to Webhook",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1,
    position: [800, -200]
};

wf.nodes.push(sheetsWebhook, sheetsNode, postgresSyncNode, respondSyncNode);

if (!wf.connections['Manager Trigger (Sheets)']) wf.connections['Manager Trigger (Sheets)'] = { main: [[{node: 'Read Google Sheets', type: 'main', index: 0}]] };
if (!wf.connections['Read Google Sheets']) wf.connections['Read Google Sheets'] = { main: [[{node: 'Sync to DB', type: 'main', index: 0}]] };
if (!wf.connections['Sync to DB']) wf.connections['Sync to DB'] = { main: [[{node: 'Respond to Webhook', type: 'main', index: 0}]] };

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('Saved V3 ULTIMATE workflow to', outFile);
