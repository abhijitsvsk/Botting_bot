const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  let connections = JSON.parse(row.connections);
  
  // Fix 1: Rename "WhatsApp WhatsApp Webhook" back to "WhatsApp Webhook"
  for (const n of nodes) {
    if (n.name === 'WhatsApp WhatsApp Webhook') {
      n.name = 'WhatsApp Webhook';
      console.log('Fixed webhook node name');
    }
  }
  
  // Fix 2: Update connections 
  const connStr = JSON.stringify(connections);
  const fixedConnStr = connStr.replace(/WhatsApp WhatsApp Webhook/g, 'WhatsApp Webhook');
  connections = JSON.parse(fixedConnStr);
  
  // Check for any other double-name issues
  for (const n of nodes) {
    if (n.name.includes('WhatsApp WhatsApp')) {
      console.log(`Still doubled: "${n.name}"`);
    }
  }
  
  db.run("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(nodes), JSON.stringify(connections)], (err2) => {
      if (err2) console.log('DB error:', err2);
      else console.log('Fixed in DB');
      db.close();
    });
});
