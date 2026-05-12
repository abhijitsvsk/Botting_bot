const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.type === 'n8n-nodes-base.if' && node.parameters.conditions) {
    for (const key of Object.keys(node.parameters.conditions)) {
      const conds = node.parameters.conditions[key];
      for (const c of conds) {
        if (c.operation === 'equal') c.operation = 'equals';
      }
    }
  }
  if (node.name === 'Check If Agree Callback') {
    node.parameters.conditions.string[0].value1 = "={{ $('WhatsApp Webhook').first().json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id || '' }}";
  }
}
fs.writeFileSync(file, JSON.stringify(json, null, 2));
console.log('Fixed IF nodes operation and missing .body');
