const fs = require('fs');
const inFile = './restaurant_bot_PRODUCTION_READY.json';
const outFile = './restaurant_bot_V2_AI_EDITION.json';

const raw = fs.readFileSync(inFile, 'utf8');
const wf = JSON.parse(raw);

wf.name = "WhatsApp Restaurant Bot - V2 AI EDITION";

// 1. Env validation for GROQ_API_KEY
const envNode = wf.nodes.find(n => n.name === 'Validate Environment');
if (envNode) {
    envNode.parameters.jsCode = envNode.parameters.jsCode.replace(
        "const required = ['WHATSAPP_PHONE_ID', 'UPI_ID', 'RESTAURANT_NAME', 'MAX_TABLES', 'TAX_RATE', 'WHATSAPP_APP_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE', 'KITCHEN_PHONE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE'];",
        "const required = ['WHATSAPP_PHONE_ID', 'UPI_ID', 'RESTAURANT_NAME', 'MAX_TABLES', 'TAX_RATE', 'WHATSAPP_APP_SECRET', 'GROQ_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE', 'KITCHEN_PHONE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE'];"
    );
}

// 2. Smart Session (Loyalty)
const procSessNode = wf.nodes.find(n => n.name === 'Process Session');
if (procSessNode) {
    procSessNode.parameters.jsCode = procSessNode.parameters.jsCode.replace(
        "return [{json: {...inputData.json, session, is_new_session: !dbResult.json || !dbResult.json.phone}}];",
        "session.is_returning = (dbResult.json && parseInt(dbResult.json.total_orders) > 0);\nreturn [{json: {...inputData.json, session, is_new_session: !dbResult.json || !dbResult.json.phone}}];"
    );
}

const askTableNode = wf.nodes.find(n => n.name === 'Ask Table Number');
if (askTableNode) {
    askTableNode.parameters.jsonBody = '={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "text", "text": {"body": "🍽️ Welcome to {{ $env.RESTAURANT_NAME }}!\\n\\n👋 Hi {{ $json.contact_name }}! {{ $json.session.is_returning ? \'Welcome back! Ready for your usual?\' : \'\' }}\\n\\nPlease enter your table number (1-{{ $env.MAX_TABLES }})\\n\\nExample: Table 5 or just 5"}}';
}

// 3. Interactive List Menus
const formatMenuNode = wf.nodes.find(n => n.name === 'Format Menu');
if (formatMenuNode) {
    formatMenuNode.parameters.jsCode = `
const inputData = $input.first().json;
const menuItems = $input.all().slice(1);
if (!menuItems || menuItems.length === 0) return [{json: {...inputData, error: 'NO_MENU', error_msg: '❌ Menu not available'}}];

let rows = [];
menuItems.forEach(item => {
    rows.push({
        id: "CMD_ADD_" + item.json.code, 
        title: item.json.name.substring(0, 24), 
        description: ('₹' + item.json.price + ' - ' + item.json.category).substring(0, 72)
    });
});

rows = rows.slice(0, 10); // WA Limit

const interactive = {
    type: "list",
    header: {type: "text", text: "📋 Live Menu"},
    body: {text: "Select an item to add to your cart or type your order.\\nExample: '2 B1s and a D2'"},
    action: {
        button: "View Items",
        sections: [{title: "Popular Items", rows}]
    }
};

return [{json: {...inputData, interactive}}];
`;
}

const sendMenuNode = wf.nodes.find(n => n.name === 'Send Menu');
if (sendMenuNode) {
    sendMenuNode.parameters.jsonBody = '={"messaging_product": "whatsapp", "to": "{{ $json.from }}", "type": "interactive", "interactive": {{ JSON.stringify($json.interactive) }}}';
}

// Add handling for the new ID "CMD_ADD_XX" in the Sanitize node
const sanitizeNode = wf.nodes.find(n => n.name === 'Sanitize Input');
if (sanitizeNode) {
    sanitizeNode.parameters.jsCode = sanitizeNode.parameters.jsCode.replace(
        "const text = raw.replace(/[^A-Z0-9\\s]/g, ' ').replace(/\\s+/g, ' ').trim();",
        "let text = raw.replace(/[^A-Z0-9_\\s]/g, ' ').replace(/\\s+/g, ' ').trim();"
    ).replace(
        "return [{json:",
        "if (action && action.startsWith('CMD_ADD_')) text = action.replace('CMD_ADD_', '') + ' ' + text;\\nreturn [{json:"
    );
}

// 4. Groq LLM Parsing Node replacement
const parseNodeIdx = wf.nodes.findIndex(n => n.name === 'Parse Item Codes');
if (parseNodeIdx > -1) {
    const groqNode = {
        parameters: {
            method: "POST",
            url: "https://api.groq.com/openai/v1/chat/completions",
            sendHeaders: true,
            headerParameters: {
                parameters: [
                    { name: "Authorization", value: "=Bearer {{ $env.GROQ_API_KEY }}" },
                    { name: "Content-Type", value: "application/json" }
                ]
            },
            sendBody: true,
            specifyBody: "json",
            jsonBody: '={"model": "llama3-70b-8192", "messages": [{"role": "system", "content": "You extract food item codes and quantities from user orders. Return ONLY a valid JSON array of objects. Example: [{\\"code\\": \\"B1\\", \\"quantity\\": 2}]. If none found, return []."}, {"role": "user", "content": "{{ $json.text }}"}], "temperature": 0}'
        },
        id: "groq_ai_parser",
        name: "Groq AI Parser",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        position: [1400, 650]
    };

    const extractGroqNode = {
        parameters: {
            jsCode: `
const data = $input.item.json;
let parsed_items = [];
try {
    const content = data.choices[0].message.content;
    const arrayMatch = content.match(/\\[.*\\]/s);
    if (arrayMatch) {
       parsed_items = JSON.parse(arrayMatch[0]);
    } else {
       parsed_items = JSON.parse(content);
    }
} catch (e) {
    return [{json: {...data, error: 'AI_PARSE_ERROR', error_msg: '❌ We had trouble understanding your order.\\n\\nTry sending codes like: B10, A5'}}];
}

if (!Array.isArray(parsed_items) || parsed_items.length === 0) {
    return [{json: {...data, error: 'NO_ITEMS', error_msg: '❌ No items found in your message.\\n\\nTry sending codes like: B10, A5'}}];
}

parsed_items = parsed_items.map(i => ({...i, quantity: parseInt(i.quantity) || 1}));

return [{json: {...data, parsed_items}}];
`
        },
        id: "extract_groq_json",
        name: "Extract Groq Output",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [1450, 650]
    };

    wf.nodes.splice(parseNodeIdx, 1, groqNode, extractGroqNode);

    const routeConn = wf.connections['Route Action'];
    if (routeConn && routeConn.main && routeConn.main[4]) {
        routeConn.main[4] = routeConn.main[4].map(c => c.node === 'Parse Item Codes' ? {node: 'Groq AI Parser', type: 'main', index: 0} : c);
    }

    if (!wf.connections['Groq AI Parser']) wf.connections['Groq AI Parser'] = { main: [[]] };
    wf.connections['Groq AI Parser'].main[0].push({ node: 'Extract Groq Output', type: 'main', index: 0 });

    if (!wf.connections['Extract Groq Output']) wf.connections['Extract Groq Output'] = { main: [[]] };
    wf.connections['Extract Groq Output'].main[0].push({ node: 'Check Parse Error', type: 'main', index: 0 });
    
    delete wf.connections['Parse Item Codes'];
}

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('Saved V2 AI Edition workflow to', outFile);
