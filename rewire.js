const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);

db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const conns = JSON.parse(row.connections);
  
  // FIX 1: Map Global Settings → Sanitize Input (instead of Parse & Validate Table)
  console.log('BEFORE Map Global Settings:', JSON.stringify(conns['Map Global Settings']));
  conns['Map Global Settings'] = {
    main: [[{ node: 'Sanitize Input', type: 'main', index: 0 }]]
  };
  console.log('AFTER  Map Global Settings:', JSON.stringify(conns['Map Global Settings']));
  
  // FIX 2: Remove Validate Environment as orphan entry point 
  // (Sanitize Input is now fed by both Extract Message Data AND Map Global Settings)
  // Actually, let's check: Sanitize Input already has two inputs. Map Global Settings 
  // will be the third. That should be fine - n8n merges inputs.
  
  // FIX 3: If Kitchen Closed already feeds Sanitize Input (from trace_session output).
  // That path is for re-entry when kitchen is closed. Keep it.
  
  // Verify: Parse & Validate Table should ONLY be fed by Ask Table Number
  // Let's check current feeders
  const pvtSources = [];
  for (const [src, outputs] of Object.entries(conns)) {
    if (!outputs.main) continue;
    for (const arr of outputs.main) {
      for (const c of arr) {
        if (c.node === 'Parse & Validate Table') pvtSources.push(src);
      }
    }
  }
  console.log('Parse & Validate Table fed by:', pvtSources.join(', '));
  
  db.run("UPDATE workflow_entity SET connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(conns)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Rewired: Map Global Settings → Sanitize Input');
      db.close();
    });
});
