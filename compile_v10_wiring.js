const fs = require('fs');

const inFile = './restaurant_bot_V9_BLOCKERS.json';
const outFile = './restaurant_bot_FINAL_WIRED.json';

const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
wf.name = "WhatsApp Restaurant Bot - V10 FINAL WIRED DEMO";

function findNode(nameIncludes) {
    return wf.nodes.find(n => n.name.toLowerCase().includes(nameIncludes.toLowerCase()));
}

// Ensure connections object exists
if (!wf.connections) wf.connections = {};

const webhook = findNode('Webhook');
const dedupNode = findNode('Message Deduplicate');
const dedupCheck = findNode('Dedup Check');
const hmacNode = findNode('HMAC Verification');
const checkSession = findNode('Check Session Consent');
const gateConsent = findNode('Gate Consent');
const requestConsentMessage = findNode('Request Consent Message');
const checkOpHours = findNode('Check Operating Hours');
const gateOpHours = findNode('Gate Operating Hours');
const msgClosed = findNode('Message Closed');
const readSettings = findNode('Read Global Settings');
const mapSettings = findNode('Map Global Settings');
const early200 = findNode('Early 200 OK (Webhook Received)'); // from v8 rearch

// Identify old main flow start
// Before v8/v9, Webhook went straight to some processing node or settings node.
// In V8 we wired Webhook -> Message Deduplicate. Let's rebuild the chain from scratch.
const originalMainStartNode = findNode('Gate Message Type') || findNode('Parse');

// Define connection chains
const wire = (from, to, outIndex = 0, toIndex = 0) => {
    if (!wf.connections[from]) wf.connections[from] = { main: [] };
    while (wf.connections[from].main.length <= outIndex) wf.connections[from].main.push([]);
    wf.connections[from].main[outIndex].push({ node: to, type: "main", index: toIndex });
};

// 1. Clear all Webhook output connections and all proxy connections we injected
if (webhook) wf.connections[webhook.name] = { main: [[]] };
if (dedupNode) wf.connections[dedupNode.name] = { main: [[]] };
if (dedupCheck) wf.connections[dedupCheck.name] = { main: [[], []] };
if (hmacNode) wf.connections[hmacNode.name] = { main: [[]] };
if (checkSession) wf.connections[checkSession.name] = { main: [[]] };
if (gateConsent) wf.connections[gateConsent.name] = { main: [[], []] };
if (checkOpHours) wf.connections[checkOpHours.name] = { main: [[]] };
if (gateOpHours) wf.connections[gateOpHours.name] = { main: [[], []] };
if (readSettings) wf.connections[readSettings.name] = { main: [[]] };
if (mapSettings) wf.connections[mapSettings.name] = { main: [[]] };

// 2. Add an IF node to intercept [I AGREE] Privacy Callback Interactive payload
const interceptAgreeNode = {
    parameters: {
        conditions: {
            conditions: [{
                leftValue: "={{ $('Webhook').item.json.body.entry[0].changes[0].value.messages[0].interactive.button_reply.id }}",
                rightValue: "CMD_AGREE_PRIVACY",
                operator: { type: "string", operation: "equals" }
            }]
        }
    },
    id: "gate_agree_callback",
    name: "Check If Agree Callback",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [600, 300]
};

const insertConsent = findNode('Insert Consent');
wf.nodes.push(interceptAgreeNode);

// 3. Build the strict sequence
if (webhook) {
    // Webhook -> Deduplication
    wire(webhook.name, dedupNode.name);
    
    // Deduplication -> IF Dup
    wire(dedupNode.name, dedupCheck.name);
    
    // Dedup Check -> False (Duplicate found, abort)
    wire(dedupCheck.name, "Early 200 OK (Duplicate)", 1); // We added this in V8
    
    // Dedup Check -> True (New message)
    wire(dedupCheck.name, interceptAgreeNode.name, 0);

    // Filter Agree Button press
    wire(interceptAgreeNode.name, insertConsent.name, 0); // TRUE: It's the Agree button!
    wire(insertConsent.name, "Early 200 OK (Webhook Received)", 0); // End flow for this callback

    wire(interceptAgreeNode.name, hmacNode.name, 1); // FALSE: Proceed to normal HMAC
    
    // HMAC -> Check Session Consent
    wire(hmacNode.name, checkSession.name);
    
    // Session Consent -> Gate Consent
    wire(checkSession.name, gateConsent.name);
    
    // Gate Consent -> False (No consent yet) -> Request Consent Message -> Null
    wire(gateConsent.name, requestConsentMessage.name, 1);
    
    // Gate Consent -> True (Consent found) -> Check Op Hours
    wire(gateConsent.name, checkOpHours.name, 0);
    
    // Check Op Hours -> Gate Op Hours
    wire(checkOpHours.name, gateOpHours.name);
    
    // Gate Op Hours -> False (Closed) -> Msg Closed
    wire(gateOpHours.name, msgClosed.name, 1);
    
    // Gate Op Hours -> True (Open) -> Read Settings
    wire(gateOpHours.name, readSettings.name, 0);
    
    // Read Settings -> Map Settings
    wire(readSettings.name, mapSettings.name);
    
    // Map Settings -> Original Main Workflow
    if (originalMainStartNode) {
        wire(mapSettings.name, originalMainStartNode.name);
    }
}

// 4. Update Idempotency Nanoid Generator to use Retry Logic visually representation
const nanoidNode = findNode('Generate Nanoid');
if (nanoidNode) {
    nanoidNode.parameters.jsCode = `
// NOTE: Realistic nanoid retry loops in n8n are usually built with
// the Loop node circling back to a Postgres INSERT node checking for conflict,
// but for this JS snippet we'll output 5 proposed random IDs sequentially.
// The downstream DB node should do: INSERT ... ON CONFLICT DO NOTHING RETURNING id; 
// and break after first success.
const out = [];
for (let attempt = 0; attempt < 5; attempt++) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    out.push({ json: { ...$json, display_id: id, attempt } });
}
return out;
`;
    console.log("[+] Nanoid generator upgraded to 5-attempt retry pattern");
}

fs.writeFileSync(outFile, JSON.stringify(wf, null, 2));
console.log('✅ Flow successfully wired and compiled to ' + outFile);
