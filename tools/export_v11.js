const sqlite3 = require('sqlite3');
const dbPath = process.env.USERPROFILE + '\\.n8n\\database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT * FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
    if (err) throw err;
    const wf = {
        id: row.id,
        name: row.name,
        active: true,
        nodes: JSON.parse(row.nodes),
        connections: JSON.parse(row.connections),
        settings: JSON.parse(row.settings),
        versionId: row.versionId
    };
    require('fs').writeFileSync('V11.json', JSON.stringify(wf, null, 2));
    console.log('Exported V11');
    db.close();
});
