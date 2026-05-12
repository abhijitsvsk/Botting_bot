const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const node of json.nodes) {
  if (node.type === 'n8n-nodes-base.if' && node.parameters.conditions && node.parameters.conditions.conditions) {
    const oldConds = node.parameters.conditions.conditions;
    const newConds = {};
    for (const c of oldConds) {
       const opType = c.operator ? c.operator.type : 'string';
       const op = c.operator ? c.operator.operation : 'equals';
       const val1 = c.leftValue;
       const val2 = c.rightValue;
       
       if (!newConds[opType]) newConds[opType] = [];
       const newOp = op === 'equals' ? 'equal' : op; // n8n v2 uses equal, not equals
       
       if (val2 !== undefined) {
         newConds[opType].push({ value1: val1, value2: val2, operation: newOp });
       } else {
         newConds[opType].push({ value1: val1, operation: newOp });
       }
    }
    node.parameters.conditions = newConds;
    console.log('Fixed IF node: ' + node.name);
  }
}
fs.writeFileSync(file, JSON.stringify(json, null, 2));
