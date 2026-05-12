const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.name === 'Check If Agree Callback') {
    node.parameters.conditions = {
      string: [
        {
          value1: "={{ WhatsApp Webhook.first().json.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id || '' }}",
          value2: "CMD_AGREE_PRIVACY",
          operation: "equal" // Actually, in typeVersion 2 it's usually "equal" or "equals"? Let's check Route Action or another node. Wait, Check Sanitization Error has "isNotEmpty".
        }
      ]
    };
    console.log('Fixed Check If Agree Callback parameter structure');
  }
}
fs.writeFileSync(file, JSON.stringify(json, null, 2));
