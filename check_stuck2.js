const sqlite3 = require('sqlite3');
const os = require('os');
const dbPath = os.homedir() + '/.n8n/database.sqlite';

const num = /^[0-9]+$/;
function unflatten(items) {
  const seen = new Map();
  function revive(value) {
    if (typeof value === 'string' && num.test(value)) return reviveIndex(Number(value));
    return value;
  }
  function reviveIndex(index) {
    if (seen.has(index)) return seen.get(index);
    const value = items[index];
    if (Array.isArray(value)) {
      const output = [];
      seen.set(index, output);
      for (const item of value) output.push(revive(item));
      return output;
    }
    if (value && typeof value === 'object') {
      const output = {};
      seen.set(index, output);
      for (const [key, child] of Object.entries(value)) output[key] = revive(child);
      return output;
    }
    return value;
  }
  return reviveIndex(0);
}

const db = new sqlite3.Database(dbPath);
for (const id of [443, 444]) {
  db.get(`SELECT data FROM execution_data WHERE executionId = ${id}`, (err, row) => {
    if (err || !row) { console.log(`Exec ${id}: no data or error`); return; }
    try {
      const data = unflatten(JSON.parse(row.data));
      const runData = data.resultData?.runData || {};
      const nodes = Object.keys(runData);
      console.log(`\n=== Execution ${id} ===`);
      console.log(`Nodes ran: ${nodes.join(' -> ')}`);
      for (const [name, runs] of Object.entries(runData)) {
        const r = runs[0];
        const hasError = r.error ? ' ERROR: ' + r.error.message : '';
        const status = r.executionStatus || 'unknown';
        console.log(`  ${name}: status=${status}${hasError}`);
      }
      if (data.resultData?.error) {
        console.log(`  WORKFLOW ERROR: ${data.resultData.error.message}`);
      }
    } catch(e) {
      console.log(`Exec ${id}: parse error: ${e.message}`);
    }
  });
}
