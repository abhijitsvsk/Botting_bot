const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.name === 'Check If Agree Callback') {
    node.parameters.conditions.conditions[0].leftValue = "={{ WhatsApp Webhook.first().json.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id || '' }}";
    console.log('Fixed Check If Agree Callback');
  }
  if (node.name === 'Insert Consent') {
    node.parameters.options.queryReplacement = "={{ WhatsApp Webhook.first().json.entry[0].changes[0].value.messages[0].from }}";
    console.log('Fixed Insert Consent');
  }
  // Let's quickly check other postgres nodes that might refer to Webhook
  if (node.name === 'Message Deduplicate') {
    // Actually, Message Deduplicate is right after Webhook in parallel to Extract Data.
    // Wait, earlier I fixed Message Deduplicate to use .entry. But since they are parallel,  IS the webhook output. That's fine.
  }
}

fs.writeFileSync(file, JSON.stringify(json, null, 2));
