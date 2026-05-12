const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const fixedWorkflowPath = 'd:/Z_shared/BOT/restaurant_bot_ENDGAME_VERSION.json';
const fixedData = JSON.parse(fs.readFileSync(fixedWorkflowPath, 'utf8'));

// The n8n db path
const dbPath = process.env.USERPROFILE + '/.n8n/database.sqlite';

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  // Find the active workflow id
  db.get("SELECT id FROM workflow_entity WHERE active = 1;", (err, row) => {
    if (err || !row) {
      console.log('No active workflow found.');
      process.exit(1);
    }
    const activeId = row.id;
    console.log(`Found active workflow ID: ${activeId}`);

    const nodesJson = JSON.stringify(fixedData.nodes);
    const connectionsJson = JSON.stringify(fixedData.connections || {});

    db.run(
      'UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = ?',
      [nodesJson, connectionsJson, activeId],
      function (err) {
        if (err) {
          console.error(err.message);
          process.exit(1);
        }
        console.log(`Successfully injected nodes + connections into active workflow ${activeId}.`);
        db.close();
      },
    );
  });
});
