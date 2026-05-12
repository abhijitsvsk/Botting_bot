const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const connections = JSON.parse(row.connections);
  const nodeNames = new Set(nodes.map(n => n.name));
  const nodeIds = new Set(nodes.map(n => n.id));
  
  // Check all connections
  let issues = 0;
  for (const [srcNode, outputs] of Object.entries(connections)) {
    if (!nodeNames.has(srcNode)) {
      console.log(`MISSING SRC: "${srcNode}"`);
      issues++;
    }
    for (const [outputType, outputIndices] of Object.entries(outputs)) {
      for (let oi = 0; oi < outputIndices.length; oi++) {
        for (const conn of outputIndices[oi]) {
          if (!nodeNames.has(conn.node)) {
            console.log(`MISSING TARGET: "${conn.node}" (from "${srcNode}" output ${oi})`);
            issues++;
          }
        }
      }
    }
  }
  
  // Check for duplicate node names
  const nameCount = {};
  for (const n of nodes) {
    nameCount[n.name] = (nameCount[n.name] || 0) + 1;
  }
  for (const [name, count] of Object.entries(nameCount)) {
    if (count > 1) console.log(`DUPLICATE NODE: "${name}" appears ${count} times`);
  }
  
  if (issues === 0) console.log('No dangling connections found');
  console.log(`Total nodes: ${nodes.length}, Total connection sources: ${Object.keys(connections).length}`);
  db.close();
});
