const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const conns = JSON.parse(row.connections);
  
  // Swap Check Sanitization Error outputs
  const cse = conns['Check Sanitization Error'];
  console.log('BEFORE:', JSON.stringify(cse));
  const tmp = cse.main[0];
  cse.main[0] = cse.main[1];
  cse.main[1] = tmp;
  console.log('AFTER:', JSON.stringify(cse));
  
  db.run("UPDATE workflow_entity SET connections = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(conns)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Swapped Check Sanitization Error outputs');
      db.close();
    });
});
