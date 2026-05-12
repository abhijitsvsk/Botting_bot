const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const agree = nodes.find(n => n.name === 'Check If Agree Callback');
  console.log('Parameters:', JSON.stringify(agree.parameters, null, 2));
  
  // Also check what the webhook node's actual name is
  const wh = nodes.find(n => n.type === 'n8n-nodes-base.webhook' && n.parameters?.path === 'whatsapp-webhook' && n.parameters?.httpMethod === 'POST');
  console.log('\nWebhook node name:', wh?.name);
  db.close();
});
