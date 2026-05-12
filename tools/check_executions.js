#!/usr/bin/env node
/**
 * Inspect n8n webhook executions (local SQLite).
 *
 * Usage:
 *   node check_executions.js                    # list recent runs + trace newest
 *   node check_executions.js --list             # list only (no trace)
 *   node check_executions.js --id 250           # full trace for execution 250
 *   node check_executions.js --last             # trace newest webhook id
 *   node check_executions.js --workflow WXtz   # filter by workflow id prefix (LIKE)
 *
 * Env:
 *   N8N_DB     default: ~/.n8n/database.sqlite
 *   WORKFLOW_ID default: WXtzFB4sV7Qjlhhk
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const WORKFLOW_ID = process.env.WORKFLOW_ID || 'WXtzFB4sV7Qjlhhk';
const dbPath =
  process.env.N8N_DB || path.join(process.env.USERPROFILE || process.env.HOME, '.n8n', 'database.sqlite');

const num = /^[0-9]+$/;
function unflatten(items) {
  const seen = new Map();
  function revive(v) {
    if (typeof v === 'string' && num.test(v)) return reviveIndex(Number(v));
    return v;
  }
  function reviveIndex(i) {
    if (seen.has(i)) return seen.get(i);
    const value = items[i];
    if (Array.isArray(value)) {
      const o = [];
      seen.set(i, o);
      for (const c of value) o.push(revive(c));
      return o;
    }
    if (value && typeof value === 'object') {
      const o = {};
      seen.set(i, o);
      for (const [k, c] of Object.entries(value)) o[k] = revive(c);
      return o;
    }
    return value;
  }
  return reviveIndex(0);
}

function summarizeJson(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {
    from: j.from,
    text: j.text,
    session_table: j.session?.table_number,
    table_number: j.table_number,
    error: j.error,
    contact_name: j.contact_name,
  };
  return out;
}

function traceNodes(data, names) {
  const rd = data.resultData?.runData || {};
  const lines = [];
  for (const n of names) {
    const runs = rd[n];
    if (!runs?.[0]) {
      lines.push({ node: n, ran: false });
      continue;
    }
    const run = runs[0];
    const j = run.data?.main?.[0]?.[0]?.json;
    lines.push({
      node: n,
      ran: true,
      ms: run.executionTime,
      nodeError: run.error?.message,
      summary: summarizeJson(j),
    });
  }
  return lines;
}

const TABLE_FLOW = [
  'WhatsApp Webhook',
  'Message Deduplicate',
  'Sanitize Input',
  'Load Session from DB',
  'Process Session',
  'Save Session to DB',
  'Restore Session After Save',
  'Check Table Set',
  'Ask Table Number',
  'Parse & Validate Table',
  'Check Table Error',
  'Update Session Table',
  'Save Table to DB',
  'Confirm Table',
  'Route Action',
];

function openDb() {
  if (!fs.existsSync(dbPath)) {
    console.error('n8n database not found:', dbPath);
    process.exit(1);
  }
  return new sqlite3.Database(dbPath);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let id = null;
  let last = false;
  let listOnly = false;
  let wf = WORKFLOW_ID;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id' && argv[i + 1]) {
      id = parseInt(argv[++i], 10);
    } else if (argv[i] === '--last') {
      last = true;
    } else if (argv[i] === '--list') {
      listOnly = true;
    } else if (argv[i] === '--workflow' && argv[i + 1]) {
      wf = argv[++i];
    }
  }
  return { id, last, listOnly, wf };
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function main() {
  const { id, last, listOnly, wf } = parseArgs();
  const db = openDb();

  const wfMatch =
    wf.includes('%') || wf.length < 32 ? wf : wf.length >= 8 ? `${wf}%` : wf;

  if (id != null && !Number.isNaN(id)) {
    const row = await dbGet(
      db,
      `SELECT e.id, e.status, e.mode, e.startedAt, d.data
       FROM execution_entity e
       JOIN execution_data d ON d.executionId = e.id
       WHERE e.id = ?`,
      [id],
    );
    if (!row) {
      console.error('No execution', id);
      db.close();
      process.exit(1);
    }
    const data = unflatten(JSON.parse(row.data));
    console.log(JSON.stringify({ id: row.id, status: row.status, mode: row.mode, startedAt: row.startedAt }, null, 2));
    console.log('lastNode:', data.resultData?.lastNodeExecuted);
    const err = data.resultData?.error;
    if (err) {
      console.log(
        'workflowError:',
        JSON.stringify(
          {
            name: err.name,
            message: err.message,
            node: err.node?.name,
            httpCode: err.httpCode,
          },
          null,
          2,
        ),
      );
    }
    console.log('\n--- table flow trace ---');
    console.log(JSON.stringify(traceNodes(data, TABLE_FLOW), null, 2));
    const allNames = Object.keys(data.resultData?.runData || {}).sort();
    console.log('\n--- all nodes executed (' + allNames.length + ') ---');
    console.log(allNames.join(', '));
    db.close();
    return;
  }

  let targetId = id;
  if (last || id == null) {
    const rows = await dbAll(
      db,
      `SELECT e.id, e.status, e.mode, e.startedAt
       FROM execution_entity e
       WHERE e.workflowId LIKE ? AND e.mode = 'webhook'
       ORDER BY e.id DESC
       LIMIT 12`,
      [wfMatch],
    );
    console.log('Recent webhook executions (' + dbPath + '):\n');
    console.table(rows);
    if (rows.length && !listOnly && (last || id == null)) {
      targetId = rows[0].id;
      console.log('\n--- newest webhook #' + targetId + ' (use --id for others, --list to skip trace) ---\n');
    }
  }

  if (listOnly) {
    db.close();
    return;
  }

  if (targetId != null && !Number.isNaN(targetId)) {
    const row = await dbGet(
      db,
      `SELECT e.id, e.status, e.mode, d.data FROM execution_entity e
       JOIN execution_data d ON d.executionId = e.id WHERE e.id = ?`,
      [targetId],
    );
    if (row?.data) {
      const data = unflatten(JSON.parse(row.data));
      console.log('lastNode:', data.resultData?.lastNodeExecuted);
      const err = data.resultData?.error;
      if (err) console.log('error:', err.message, '| node:', err.node?.name);
      console.log(JSON.stringify(traceNodes(data, TABLE_FLOW), null, 2));
    }
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
