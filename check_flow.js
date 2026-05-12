const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT connections FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const conns = JSON.parse(row.connections);
  
  // Where does Get Restaurant Config connect FROM and TO?
  for (const [src, outputs] of Object.entries(conns)) {
    for (const indices of Object.values(outputs)) {
      for (const arr of indices) {
        for (const c of arr) {
          if (c.node === 'Get Restaurant Config') {
            console.log(`Get Restaurant Config fed by: "${src}"`);
          }
        }
      }
    }
  }
  
  const configConns = conns['Get Restaurant Config'];
  if (configConns) {
    console.log('Get Restaurant Config outputs to:', JSON.stringify(configConns, null, 2));
  } else {
    console.log('Get Restaurant Config has no outgoing connections');
  }
  
  // Also find Sanitize Input
  for (const [src, outputs] of Object.entries(conns)) {
    for (const indices of Object.values(outputs)) {
      for (const arr of indices) {
        for (const c of arr) {
          if (c.node === 'Sanitize Input') {
            console.log(`Sanitize Input fed by: "${src}"`);
          }
        }
      }
    }
  }
  
  db.close();
});
