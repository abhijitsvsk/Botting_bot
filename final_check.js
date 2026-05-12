const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const connections = JSON.parse(row.connections);
  const nodeNames = new Set(nodes.map(n => n.name));
  
  // Final integrity check
  let issues = 0;
  for (const [src, outputs] of Object.entries(connections)) {
    if (!nodeNames.has(src)) {
      console.log(`MISSING SRC: "${src}"`);
      issues++;
    }
    for (const [type, indices] of Object.entries(outputs)) {
      for (const conns of indices) {
        for (const c of conns) {
          if (!nodeNames.has(c.node)) {
            console.log(`MISSING TARGET: "${c.node}" from "${src}"`);
            issues++;
          }
        }
      }
    }
  }
  
  // Check for duplicates
  const nameCount = {};
  for (const n of nodes) {
    nameCount[n.name] = (nameCount[n.name] || 0) + 1;
  }
  for (const [name, count] of Object.entries(nameCount)) {
    if (count > 1) {
      console.log(`DUPLICATE: "${name}" x${count}`);
      issues++;
    }
  }
  
  if (issues === 0) console.log('ALL CLEAN - no issues found');
  console.log(`Nodes: ${nodes.length}, Connection sources: ${Object.keys(connections).length}`);
  db.close();
});
