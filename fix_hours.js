const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';
const db = new sqlite3.Database(dbPath);
db.get("SELECT nodes FROM workflow_entity WHERE id = 'WXtzFB4sV7Qjlhhk'", (err, row) => {
  const nodes = JSON.parse(row.nodes);
  const n = nodes.find(n => n.name === 'Check Operating Hours');
  
  // Replace $('Get Restaurant Config') references with $env
  n.parameters.jsCode = `
const tz = $env.TIMEZONE || 'Asia/Kolkata';
const now = new Date().toLocaleString('en-US', { timeZone: tz });
const localNow = new Date(now);
const currentMins = localNow.getHours() * 60 + localNow.getMinutes();

const parseTime = (t) => {
    const [h, m] = (t || '09:00').split(':').map(Number);
    return h * 60 + (m || 0);
};

const openMins = parseTime($env.OPENING_TIME || '09:00');
const closeMins = parseTime($env.CLOSING_TIME || '23:00');

const isOpen = closeMins > openMins
    ? currentMins >= openMins && currentMins < closeMins
    : currentMins >= openMins || currentMins < closeMins;

return [{ json: { ...$input.first().json, kitchen_is_open: isOpen, current_time_tz: now } }];
`;
  
  db.run("UPDATE workflow_entity SET nodes = ? WHERE id = 'WXtzFB4sV7Qjlhhk'",
    [JSON.stringify(nodes)], (err2) => {
      if (err2) console.log('Error:', err2);
      else console.log('Fixed Check Operating Hours to use $env');
      db.close();
    });
});
