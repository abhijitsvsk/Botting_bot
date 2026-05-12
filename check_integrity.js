const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const connections = JSON.parse(row.connections);
  
  const nodeNames = new Set(nodes.map(n => n.name));
  
  // Check: connections referencing non-existent nodes
  for (const [srcNode, outputs] of Object.entries(connections)) {
    if (!nodeNames.has(srcNode)) {
      console.log(`CONNECTION FROM MISSING NODE: "${srcNode}"`);
    }
    for (const outputType of Object.keys(outputs)) {
      for (const outputIndex of outputs[outputType]) {
        for (const conn of outputIndex) {
          if (!nodeNames.has(conn.node)) {
            console.log(`CONNECTION TO MISSING NODE: "${conn.node}" (from "${srcNode}")`);
          }
        }
      }
    }
  }
  
  // Check: postgres nodes missing credentials
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.postgres' && (!n.credentials || Object.keys(n.credentials).length === 0)) {
      console.log(`POSTGRES NODE WITHOUT CREDENTIALS: "${n.name}"`);
    }
  }
  
  // Check: nodes with disabled property undefined
  for (const n of nodes) {
    if (n.disabled === undefined) {
      // This is normal, disabled defaults to false
    }
  }
  
  console.log('Check complete');
  db.close();
});
