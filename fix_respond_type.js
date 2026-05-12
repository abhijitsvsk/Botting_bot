const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  let fixed = 0;
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.respondToWhatsApp Webhook') {
      n.type = 'n8n-nodes-base.respondToWebhook';
      console.log(`Fixed: ${n.name}`);
      fixed++;
    }
  }
  if (fixed > 0) {
    const nodesStr = JSON.stringify(nodes);
    db.run("UPDATE workflow_entity SET nodes = ? WHERE id = 'WXtzFB4sV7Qjlhhk'", [nodesStr], (err2) => {
      if (err2) console.log('DB error:', err2);
      else console.log(`Fixed ${fixed} nodes in DB`);
      db.close();
    });
  } else {
    console.log('No corrupted nodes found');
    db.close();
  }
});
