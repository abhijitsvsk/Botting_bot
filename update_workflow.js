const fs = require('fs');

const inFile = './restaurant_bot_SECURE_FIXED.json';
const outFile = './restaurant_bot_PRODUCTION_READY.json';

const raw = fs.readFileSync(inFile, 'utf8');
const wf = JSON.parse(raw);

// 1. Webhook Signature Verification
wf.name = "WhatsApp Restaurant Bot - PRODUCTION READY";

const envNode = wf.nodes.find(n => n.name === 'Validate Environment');
if (envNode) {
    const originalCode = envNode.parameters.jsCode;
    // Replace the required env line to include WHATSAPP_APP_SECRET
    let newCode = originalCode.replace(
        "const required = ['WHATSAPP_PHONE_ID', 'UPI_ID', 'RESTAURANT_NAME', 'MAX_TABLES', 'TAX_RATE', 'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE', 'KITCHEN_PHONE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE'];",
        "const required = ['WHATSAPP_PHONE_ID', 'UPI_ID', 'RESTAURANT_NAME', 'MAX_TABLES', 'TAX_RATE', 'WHATSAPP_APP_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE', 'KITCHEN_PHONE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE'];"
    );
    
    // Insert crypto verification
    const verificationSnippet = `
const crypto = require('crypto');
// Verify WhatsApp Webhook Signature
try {
  const secret = $env.WHATSAPP_APP_SECRET || '';
  const headers = $request?.headers || {};
  const signature = headers['x-hub-signature-256'];
  
  if (signature && secret) {
      const payloadStr = JSON.stringify($input.item.json);
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
      
      if (signature !== expectedSig) {
          console.log('HMAC Error - Expected:', expectedSig, 'Got:', signature);
          throw new Error('Invalid Signature / Unauthorized Webhook Request');
      }
  }
} catch (e) {
  throw new Error('Validation failed: ' + e.message);
}
`;
    // We add it just before the payload check
    newCode = newCode.replace(
        "const entry = $input.item.json.entry?.[0];",
        verificationSnippet + "\nconst entry = $input.item.json.entry?.[0];"
    );
    envNode.parameters.jsCode = newCode;
}

// 2. Fix Route Action Fallback & Regex
const routeNode = wf.nodes.find(n => n.name === 'Route Action');
if (routeNode) {
    const rules = routeNode.parameters.rules;
    const itemsRule = rules.values.find(r => r.outputKey === 'items');
    if (itemsRule) {
        itemsRule.conditions.conditions[0].rightValue = "[A-Za-z]+\\s*\\d+"; // match any item code anywhere
    }
    // Convert to a more resilient matcher for items
    rules.values.push({
        conditions: {
            conditions: [
                {
                    leftValue: "true",
                    rightValue: "true",
                    operator: {
                        type: "boolean",
                        operation: "equals"
                    }
                }
            ]
        },
        renameOutput: true,
        outputKey: "fallback_help" // Route everything else to Help
    });
}

// Ensure the Route Action output connects correctly
if (wf.connections['Route Action'] && wf.connections['Route Action'].main) {
    // Determine the index for fallback output in connections, it's the 6th item (index 5)
    // Actually n8n requires sending to the correct node
    if (!wf.connections['Route Action'].main[5]) {
       wf.connections['Route Action'].main[5] = [];
    }
    wf.connections['Route Action'].main[5].push({
        node: "Send Help",
        type: "main",
        index: 0
    });
}

// 3. Centralize / DRY calculations by ensuring they handle missing values safely
const drifyCode = (nodeName) => {
    const node = wf.nodes.find(n => n.name === nodeName);
    if (!node) return;
    node.parameters.jsCode = node.parameters.jsCode.replace(
        /const subtotal = cart\.reduce.*\\nconst taxRate =.*\\nconst tax =.*\\nconst total = subtotal \+ tax;/s,
        `const subtotal = cart.reduce((sum, i) => sum + ((i.price || 0) * (i.quantity || 1)), 0);\nconst taxRate = parseFloat($env.TAX_RATE || '0') / 100;\nconst tax = Math.round(subtotal * taxRate);\nconst total = subtotal + tax;`
    );
};
drifyCode('Add to Cart');
drifyCode('Format Cart');
drifyCode('Prepare Order');

// 4. Global Error Catch Workflow snippet addition
const errorTriggerNode = {
    id: "global_error_trigger",
    name: "Error Trigger",
    type: "n8n-nodes-base.errorTrigger",
    typeVersion: 1,
    position: [200, 1000],
    parameters: {}
};

const sendErrorReportNode = {
    id: "send_error_report",
    name: "Send Global Error",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [400, 1000],
    parameters: {
        method: "POST",
        url: "=https://graph.facebook.com/v21.0/{{ $env.WHATSAPP_PHONE_ID }}/messages",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "whatsAppApi",
        sendBody: true,
        specifyBody: "json",
        jsonBody: '={"messaging_product": "whatsapp", "to": "{{ $json.execution.error.message ? $json.execution.error.message.split(\'||\')[1] || $env.SUPPORT_PHONE : $env.SUPPORT_PHONE }}", "type": "text", "text": {"body": "⚠️ Our highly trained monkeys encountered a technical issue! Please try again or contact support."}}'
    },
    credentials: { whatsAppApi: { id: "whatsapp_cred", name: "WhatsApp API" } }
};

wf.nodes.push(errorTriggerNode, sendErrorReportNode);
if (!wf.connections['Error Trigger']) wf.connections['Error Trigger'] = { main: [] };
wf.connections['Error Trigger'].main[0] = wf.connections['Error Trigger'].main[0] || [];
wf.connections['Error Trigger'].main[0].push({
    node: "Send Global Error",
    type: "main",
    index: 0
});

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('Saved updated workflow to', outFile);
