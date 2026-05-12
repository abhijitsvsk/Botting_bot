const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.all("SELECT executionId, length(data) as dataLen FROM execution_data WHERE executionId IN (443, 444)", (err, rows) => {
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
