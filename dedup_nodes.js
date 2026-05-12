const fs = require('fs');
const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';

// Fix the JSON source first
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

const seen = new Set();
const uniqueNodes = [];
let removed = 0;
for (const node of json.nodes) {
  if (seen.has(node.name)) {
    removed++;
    continue;
  }
  seen.add(node.name);
  uniqueNodes.push(node);
}
json.nodes = uniqueNodes;
console.log(`Removed ${removed} duplicate nodes. ${uniqueNodes.length} unique nodes remain.`);

fs.writeFileSync(file, JSON.stringify(json, null, 2));

// Now inject into DB
const db = new sqlite3.Database(dbPath);
const nodesStr = JSON.stringify(json.nodes);
const connsStr = JSON.stringify(json.connections);
db.run("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
  [nodesStr, connsStr], (err) => {
    if (err) console.log('DB error:', err);
    else console.log('Injected deduplicated workflow into DB');
    db.close();
  });
