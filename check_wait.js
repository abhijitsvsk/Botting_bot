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
db.get(`SELECT data FROM execution_data WHERE executionId = 444`, (err, row) => {
  const data = unflatten(JSON.parse(row.data));
  const runData = data.resultData.runData;
  
  if (!runData || Object.keys(runData).length === 0) {
    console.log('runData is empty — execution is still in progress, no nodes have completed yet.');
    console.log('executionData waitingExecution:', JSON.stringify(data.executionData?.waitingExecution)?.substring(0, 200));
    console.log('executionData nodeExecutionStack:', JSON.stringify(data.executionData?.nodeExecutionStack)?.substring(0, 500));
  } else {
    for (const [name, runs] of Object.entries(runData)) {
      console.log(name, JSON.stringify(runs[0]).substring(0, 200));
    }
  }
  db.close();
});
