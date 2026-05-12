const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  for (const n of nodes) {
    if (n.type && n.type.includes('respondTo')) {
      console.log(`FOUND: name="${n.name}" type="${n.type}" id="${n.id}"`);
    }
  }
  console.log('Total nodes:', nodes.length);
  db.close();
});
