const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.name === 'Message Deduplicate') {
    node.parameters.options = {
      queryReplacement: "={{ .body.entry[0].changes[0].value.messages[0].id }},={{ .body.entry[0].changes[0].value.messages[0].from }}"
    };
    delete node.parameters.additionalFields;
  }
  if (node.name === 'Load Session from DB') {
    node.parameters.options = {
      queryReplacement: "={{ .from }}"
    };
    delete node.parameters.additionalFields;
  }
  if (node.name === 'Update Session Table' || node.name === 'Save Table to DB' || node.name === 'Update Cart in DB') {
     // Wait, let's check ALL executeQuery postgres nodes
  }
}

for (const node of json.nodes) {
    if (node.type === 'n8n-nodes-base.postgres' && node.parameters.operation === 'executeQuery' && node.parameters.additionalFields?.values?.values) {
        const values = node.parameters.additionalFields.values.values;
        const replacements = values.map(v => v.value).join(',');
        node.parameters.options = node.parameters.options || {};
        node.parameters.options.queryReplacement = replacements;
        delete node.parameters.additionalFields;
        console.log('Fixed node: ' + node.name);
    }
}

fs.writeFileSync(file, JSON.stringify(json, null, 2));
