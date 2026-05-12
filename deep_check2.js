const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const connections = JSON.parse(row.connections);
  const nodeMap = {};
  for (const n of nodes) nodeMap[n.name] = n;
  
  // n8n builds a graph from connections. checkReadyForExecution iterates
  // over the graph and accesses node.disabled. If a connection refers to 
  // a node not in nodeMap, accessing .disabled on undefined crashes.
  
  // Let's check: connections that target nodes not in the map
  for (const [src, outputs] of Object.entries(connections)) {
    if (!nodeMap[src]) {
      console.log(`SRC MISSING: "${src}"`);
      continue;
    }
    for (const [type, indices] of Object.entries(outputs)) {
      for (const conns of indices) {
        for (const c of conns) {
          if (!nodeMap[c.node]) {
            console.log(`TARGET MISSING: "${c.node}" from "${src}"`);
          }
        }
      }
    }
  }
  
  // Also check: nodes that are referenced inside other nodes' expressions
  // but more importantly, check if any node's parameters reference deleted nodes
  
  // Most likely: some node's credential references are broken
  // Or: the errorTrigger or noOp node references
  
  // Let me just dump all node names and types
  for (const n of nodes) {
    const creds = n.credentials ? JSON.stringify(n.credentials) : 'none';
    if (n.type === 'n8n-nodes-base.errorTrigger') {
      console.log(`ERROR TRIGGER: "${n.name}" id="${n.id}"`);
    }
  }
  
  // Check if there's a "Manager Trigger (Sheets)" that has no target
  const managerNode = nodeMap["Manager Trigger (Sheets)"];
  if (managerNode) {
    console.log(`Manager Trigger exists: type=${managerNode.type}`);
    const managerConns = connections["Manager Trigger (Sheets)"];
    if (managerConns) {
      console.log(`Manager Trigger connections: ${JSON.stringify(managerConns)}`);
    } else {
      console.log('Manager Trigger has no outgoing connections');
    }
  }
  
  console.log(`\nTotal nodes: ${nodes.length}`);
  console.log('Done');
  db.close();
});
