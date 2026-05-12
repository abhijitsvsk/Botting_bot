const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.name === 'Check If Agree Callback') {
    node.parameters.conditions.string[0].value1 = "={{ $('WhatsApp Webhook').first().json.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id || '' }}";
    console.log('Fixed Check If Agree Callback leftValue');
  }
}
fs.writeFileSync(file, JSON.stringify(json, null, 2));
