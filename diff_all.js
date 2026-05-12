const fs = require('fs');
const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';

const old = JSON.parse(fs.readFileSync('restaurant_bot_FIXED.json', 'utf8'));
const oldConns = old.connections;

const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const curConns = JSON.parse(row.connections);
  
  const allKeys = new Set([...Object.keys(oldConns), ...Object.keys(curConns)]);
  
  const serialize = (c) => {
    if (!c?.main) return 'none';
    return c.main.map((arr, i) => `[${i}]:` + arr.map(x => x.node).join(',')).join(' | ');
  };
  
  let diffs = 0;
  for (const k of [...allKeys].sort()) {
    const o = serialize(oldConns[k]);
    const c = serialize(curConns[k]);
    if (o !== c) {
      console.log(`DIFF: "${k}"`);
      console.log(`  OLD: ${o}`);
      console.log(`  CUR: ${c}`);
      diffs++;
    }
  }
  if (diffs === 0) console.log('No connection diffs found');
  db.close();
});
