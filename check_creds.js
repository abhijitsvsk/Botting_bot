const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  
  // Check for nodes with credentials that reference a non-existent credential type
  for (const n of nodes) {
    if (n.credentials) {
      for (const [credType, credRef] of Object.entries(n.credentials)) {
        if (!credRef || !credRef.id) {
          console.log(`BAD CRED: node="${n.name}" type="${credType}" ref=${JSON.stringify(credRef)}`);
        }
      }
    }
    
    // Check for webhook nodes with specific webhookId  
    if (n.type === 'n8n-nodes-base.webhook') {
      console.log(`WEBHOOK: name="${n.name}" webhookId="${n.webhookId}" path="${n.parameters?.path}"`);
    }
  }
  
  // Look specifically at postgres nodes 
  const pgNodes = nodes.filter(n => n.type === 'n8n-nodes-base.postgres');
  console.log(`\nPostgres nodes (${pgNodes.length}):`);
  for (const n of pgNodes) {
    const creds = n.credentials || {};
    console.log(`  "${n.name}" creds=${JSON.stringify(creds)}`);
  }
  
  db.close();
});
