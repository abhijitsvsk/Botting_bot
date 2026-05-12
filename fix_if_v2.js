const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  
  // Fix all IF v2 nodes that have old string format - convert to v2 conditions format
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.if' && n.typeVersion === 2 && n.parameters.conditions?.string) {
      const oldConds = n.parameters.conditions.string;
      const newConds = oldConds.map(c => {
        const result = {
          leftValue: c.value1,
          operator: { type: 'string', operation: c.operation }
        };
        if (c.value2 !== undefined) result.rightValue = c.value2;
        return result;
      });
      n.parameters.conditions = { conditions: newConds };
      console.log(`Converted IF node: "${n.name}" to v2 format`);
    }
  }
  
  db.run("UPDATE workflow_entity SET nodes = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(nodes)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Updated all IF nodes in DB');
      db.close();
    });
});
