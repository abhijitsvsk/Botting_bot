const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes, connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const conns = JSON.parse(row.connections);
  
  const n = nodes.find(n => n.name === 'Check Sanitization Error');
  console.log('Check Sanitization Error params:', JSON.stringify(n.parameters, null, 2));
  console.log('Type version:', n.typeVersion);
  console.log('Connections:', JSON.stringify(conns['Check Sanitization Error'], null, 2));
  db.close();
});
