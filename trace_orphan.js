const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const conns = JSON.parse(row.connections);
  
  const targets = ['Validate Environment', 'DB Strict Check', 'Sliding Window Check',
    'Early 200 OK (WhatsApp Webhook Received)'];
  
  for (const target of targets) {
    const sources = [];
    for (const [src, outputs] of Object.entries(conns)) {
      for (const indices of Object.values(outputs)) {
        for (const arr of indices) {
          for (const c of arr) {
            if (c.node === target) sources.push(src);
          }
        }
      }
    }
    const outTo = conns[target]?.main?.map((arr, i) => arr.map(x => x.node).join(',') || '(empty)').join(' | ') || 'none';
    console.log(`"${target}"`);
    console.log(`  ← fed by: ${sources.join(', ') || 'ORPHAN'}`);
    console.log(`  → outputs: ${outTo}`);
  }
  db.close();
});
