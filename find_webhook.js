const sqlite3 = require('sqlite3');
const os = require('os');
const db = new sqlite3.Database(os.homedir() + '/.n8n/database.sqlite');
db.all("SELECT id, name, nodes FROM workflow_entity WHERE id='WXtzFB4sV7Qjlhhk'", (err, rows) => {
    const nodes = JSON.parse(rows[0].nodes);
    let found = false;
    nodes.forEach(n => {
        if (JSON.stringify(n).includes("$('Webhook')")) {
            console.log("Broken Node:", n.name);
            found = true;
        }
    });
    if (!found) console.log("No broken nodes found!");
});
