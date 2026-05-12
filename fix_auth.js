const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  
  // Remove authentication/genericAuthType from all postgres nodes
  // and ensure queryReplacement is properly set
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.postgres') {
      delete n.parameters.authentication;
      delete n.parameters.genericAuthType;
      
      // Ensure options.queryReplacement exists if query has $1/$2
      if (n.parameters.query && n.parameters.query.includes('$1') && 
          (!n.parameters.options || !n.parameters.options.queryReplacement)) {
        console.log(`WARNING: "${n.name}" has $1 but no queryReplacement`);
      }
    }
  }
  
  db.run("UPDATE workflow_entity SET nodes = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(nodes)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Removed auth fields from all postgres nodes');
      db.close();
    });
});
