const fs = require('fs');
const path = require('path');
const os = require('os');

// In n8n, the SQLite database is usually at ~/.n8n/database.sqlite
const dbPath = path.join(os.homedir(), '.n8n', 'database.sqlite');

if (!fs.existsSync(dbPath)) {
    console.error('Could not find n8n database at', dbPath);
    process.exit(1);
}

// We use sqlite3 if available
try {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(dbPath);
    
    console.log('--- FETCHING LAST 2 EXECUTIONS ---');
    db.all(`SELECT id, status, waitTill, data, startedAt, stoppedAt FROM execution_entity ORDER BY id DESC LIMIT 2`, (err, rows) => {
        if (err) {
            console.error('Error reading db:', err);
            return;
        }
        
        if (rows.length === 0) {
            console.log('No executions found in the database.');
        } else {
            rows.forEach(row => {
                console.log(`\nExecution ID: ${row.id}`);
                console.log(`Status: ${row.status}`);
                console.log(`Started: ${new Date(Number(row.startedAt)).toLocaleString()}`);
                console.log(`Stopped: ${new Date(Number(row.stoppedAt)).toLocaleString()}`);
                
                if (row.error) {
                    try {
                        const errorObj = JSON.parse(row.error);
                        console.log(`\nERROR DETAILS:`);
                        console.log(JSON.stringify(errorObj, null, 2));
                    } catch (e) {
                        console.log(`\nERROR DETAILS: ${row.error}`);
                    }
                }
            });
        }
        db.close();
    });
} catch (e) {
    console.error('sqlite3 module not found. Please run: npm install sqlite3');
}
