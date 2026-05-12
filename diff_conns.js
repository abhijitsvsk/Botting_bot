const fs = require('fs');
const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';

// Load old working workflow
const old = JSON.parse(fs.readFileSync('restaurant_bot_FIXED.json', 'utf8'));
const oldConns = old.connections;

// Load current DB workflow
const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const curConns = JSON.parse(row.connections);
  
  // Key nodes to trace
  const traceNodes = [
    'Map Global Settings', 'Gate Operating Hours', 'Read Global Settings',
    'Sanitize Input', 'Extract Message Data', 'Load Session from DB',
    'Process Session', 'Save Session to DB', 'Restore Session After Save',
    'Check Table Set', 'Parse & Validate Table', 'Route Action',
    'Gate Consent', 'Check Operating Hours', 'If Kitchen Closed'
  ];
  
  for (const node of traceNodes) {
    const oldOut = oldConns[node];
    const curOut = curConns[node];
    
    const getTargets = (c) => {
      if (!c?.main) return [];
      return c.main.map((arr, i) => arr.map(x => x.node).join(', ') || '(empty)');
    };
    
    const oldTargets = getTargets(oldOut);
    const curTargets = getTargets(curOut);
    
    const oldStr = oldTargets.join(' | ');
    const curStr = curTargets.join(' | ');
    
    if (oldStr !== curStr) {
      console.log(`\nDIFF: "${node}"`);
      console.log(`  OLD: ${oldStr || '(none)'}`);
      console.log(`  CUR: ${curStr || '(none)'}`);
    }
  }
  
  db.close();
});
