const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get(`SELECT data FROM execution_data WHERE executionId = 444`, (err, row) => {
  const parsed = JSON.parse(row.data);
  // Just print the raw structure keys
  if (Array.isArray(parsed)) {
    console.log('Data is array with', parsed.length, 'items');
    console.log('First item type:', typeof parsed[0]);
    console.log('First item:', JSON.stringify(parsed[0]).substring(0, 500));
  } else {
    console.log('Keys:', Object.keys(parsed));
    console.log('resultData keys:', Object.keys(parsed.resultData || {}));
    console.log('runData keys:', Object.keys(parsed.resultData?.runData || {}));
  }
  db.close();
});
