const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const connections = JSON.parse(row.connections);
  const nodeNames = new Set(nodes.map(n => n.name));
  
  // Remove connections from/to missing nodes
  const cleanConnections = {};
  for (const [srcNode, outputs] of Object.entries(connections)) {
    if (!nodeNames.has(srcNode)) {
      console.log(`Removed connection FROM missing node: "${srcNode}"`);
      continue;
    }
    const cleanOutputs = {};
    for (const [outputType, outputIndices] of Object.entries(outputs)) {
      const cleanIndices = outputIndices.map(conns => 
        conns.filter(c => {
          if (!nodeNames.has(c.node)) {
            console.log(`Removed connection TO missing node: "${c.node}" (from "${srcNode}")`);
            return false;
          }
          return true;
        })
      );
      cleanOutputs[outputType] = cleanIndices;
    }
    cleanConnections[srcNode] = cleanOutputs;
  }
  
  const connStr = JSON.stringify(cleanConnections);
  db.run("UPDATE workflow_entity SET connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'", [connStr], (err2) => {
    if (err2) console.log('DB error:', err2);
    else console.log('Cleaned connections in DB');
    db.close();
  });
});
