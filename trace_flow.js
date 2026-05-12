const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const conns = JSON.parse(row.connections);
  
  // Trace the full path from WhatsApp Webhook
  function trace(node, visited = new Set(), depth = 0) {
    if (visited.has(node) || depth > 20) return;
    visited.add(node);
    const c = conns[node];
    if (!c?.main) return;
    for (let i = 0; i < c.main.length; i++) {
      for (const t of c.main[i]) {
        const label = c.main.length > 1 ? `[out${i}]` : '';
        console.log('  '.repeat(depth) + `${node} ${label}→ ${t.node}`);
        trace(t.node, visited, depth + 1);
      }
    }
  }
  
  console.log('=== MAIN FLOW FROM WEBHOOK ===');
  trace('WhatsApp Webhook');
  
  db.close();
});
