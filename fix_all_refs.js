const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  // Do a raw string replacement on both nodes and connections
  let nodesStr = row.nodes.replace(/WhatsApp WhatsApp Webhook/g, 'WhatsApp Webhook');
  let connsStr = row.connections.replace(/WhatsApp WhatsApp Webhook/g, 'WhatsApp Webhook');
  
  db.run("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [nodesStr, connsStr], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Fixed all "WhatsApp WhatsApp Webhook" references in DB');
      db.close();
    });
});
