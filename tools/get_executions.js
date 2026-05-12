const sqlite3 = require('sqlite3');
const dbPath = process.env.USERPROFILE + '\\.n8n\\database.sqlite';
const db = new sqlite3.Database(dbPath);
db.all("SELECT id, startedAt, stoppedAt, status FROM execution_entity ORDER BY id DESC LIMIT 5", (err, rows) => {
    if (err) throw err;
    console.log(rows);
    db.close();
});
