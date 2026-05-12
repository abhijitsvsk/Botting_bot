const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  
  // Cast $json.from to string in queryReplacement
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.postgres' && n.parameters?.options?.queryReplacement) {
      if (n.parameters.options.queryReplacement === '={{ $json.from }}') {
        n.parameters.options.queryReplacement = '={{ String($json.from) }}';
        console.log(`Patched queryReplacement for: "${n.name}"`);
      }
    }
  }
  
  db.run("UPDATE workflow_entity SET nodes = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(nodes)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Updated postgres nodes with String casting');
      db.close();
    });
});
