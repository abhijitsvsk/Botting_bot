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
db.get('SELECT data FROM execution_data WHERE executionId = 444', (err, row) => {
  if (err) { console.log('Error:', err); return; }
  if (!row) { console.log('No data for execution 444 yet'); return; }
  const data = unflatten(JSON.parse(row.data));
  const runData = data.resultData?.runData || {};
  for (const [name, runs] of Object.entries(runData)) {
    const r = runs[0];
    const hasError = r.error ? ' ERROR: ' + r.error.message : '';
    const outputCount = r.data?.main?.[0]?.length || 0;
    console.log(`${name}: ${r.executionStatus || 'unknown'}${hasError} (${outputCount} items)`);
  }
});
