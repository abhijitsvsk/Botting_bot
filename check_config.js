const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const n = nodes.find(n => n.name === 'Get Restaurant Config');
  if (n) {
    console.log('Found Get Restaurant Config');
    console.log('Type:', n.type);
    console.log('Query:', n.parameters?.query?.substring(0, 200));
  } else {
    console.log('NOT FOUND: Get Restaurant Config');
  }
  
  // Check what nodes connect to Check Operating Hours
  db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err2, row2) => {
    const conns = JSON.parse(row2.connections);
    // Which node feeds into Check Operating Hours?
    for (const [src, outputs] of Object.entries(conns)) {
      for (const indices of Object.values(outputs)) {
        for (const arr of indices) {
          for (const c of arr) {
            if (c.node === 'Check Operating Hours') {
              console.log(`Check Operating Hours is fed by: "${src}"`);
            }
          }
        }
      }
    }
    db.close();
  });
});
