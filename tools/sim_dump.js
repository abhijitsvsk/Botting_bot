const crypto = require('crypto');
const os = require('os');
const sqlite3 = require('sqlite3');

const dbPath = `${os.homedir()}/.n8n/database.sqlite`;
const workflowId = 'WXtzFB4sV7Qjlhhk';
const webhookUrl = 'http://localhost:5678/webhook/whatsapp-webhook';
const fromPhone = process.env.SIM_FROM || '918921027691';
const mode = process.env.SIM_MODE || 'hi';

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

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function latestExecutionId() {
  const row = await dbGet('SELECT COALESCE(MAX(id), 0) AS id FROM execution_entity');
  return row.id || 0;
}

async function waitForExecution(afterId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const row = await dbGet(
      `SELECT e.id, e.status, e.mode, e.startedAt, e.stoppedAt, d.data, d.workflowData
       FROM execution_entity e
       JOIN execution_data d ON d.executionId = e.id
       WHERE e.workflowId = ? AND e.mode = 'webhook' AND e.id > ?
       ORDER BY e.id DESC LIMIT 1`,
      [workflowId, afterId],
    );
    if (row?.stoppedAt || ['success', 'error'].includes(row?.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for webhook execution');
}

function makePayload() {
  const id = `wamid.SIM_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const message =
    mode === 'agree'
      ? {
          from: fromPhone,
          id,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: {
              id: 'CMD_AGREE_PRIVACY',
              title: 'I Agree',
            },
          },
        }
      : {
          from: fromPhone,
          id,
          timestamp: String(Math.floor(Date.now() / 1000)),
          text: { body: 'Hi' },
          type: 'text',
        };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1179390368582158',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15556304535',
                phone_number_id: '1025110937361529',
              },
              contacts: [
                {
                  profile: { name: 'Simulation' },
                  wa_id: fromPhone,
                },
              ],
              messages: [message],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function compact(value) {
  if (value == null) return value;
  const json = value.json || value;
  const message = json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message) {
    return {
      messageType: message.type,
      text: message.text?.body,
      buttonReplyId: message.interactive?.button_reply?.id,
      from: message.from,
      messageId: message.id,
    };
  }
  if (json.error || json.error_msg) {
    return { error: json.error, error_msg: json.error_msg, from: json.from };
  }
  if (json.consent_given_at !== undefined) return { consent_given_at: json.consent_given_at };
  if (json.is_open !== undefined) return { is_open: json.is_open };
  if (json.messages || json.contacts || json.messaging_product) return json;
  if (json.success !== undefined) return json;
  if (json.id !== undefined) return { id: json.id };
  return json;
}

function firstInputFor(nodeName, runData, run) {
  const source = run.source?.[0]?.previousNode;
  if (!source || !runData[source]?.[0]?.data?.main) return null;
  const sourceOutputs = runData[source][0].data.main;
  for (const output of sourceOutputs) {
    if (Array.isArray(output) && output[0]) return compact(output[0]);
  }
  return null;
}

function outputSummary(run) {
  return (run.data?.main || []).map((output, index) => ({
    index,
    count: Array.isArray(output) ? output.length : null,
    first: output?.[0] ? compact(output[0]) : null,
  }));
}

function checkExpected(nodeName, runData, output) {
  const count = (index) => output[index]?.count || 0;
  if (nodeName === 'WhatsApp Webhook') {
    const first = output[0]?.first;
    if (mode === 'agree') {
      return first?.messageType === 'interactive' && first?.buttonReplyId === 'CMD_AGREE_PRIVACY'
        ? 'OK: received simulated I Agree button response'
        : 'DIVERGED: webhook did not contain I Agree button response';
    }
    return first?.messageType === 'text' && first?.text === 'Hi'
      ? 'OK: received simulated text Hi'
      : 'DIVERGED: webhook did not contain text Hi';
  }
  if (nodeName === 'Dedup Check') {
    return count(0) === 1 && count(1) === 0
      ? 'OK: fresh message continued'
      : 'DIVERGED: message was treated as duplicate';
  }
  if (nodeName === 'Check If Agree Callback') {
    if (mode === 'agree') {
      return count(0) === 1 && count(1) === 0
        ? 'OK: agree callback routed to Insert Consent'
        : 'DIVERGED: agree callback did not route to Insert Consent';
    }
    return count(0) === 0 && count(1) === 1
      ? 'OK: plain text did not insert consent'
      : 'DIVERGED: plain text routed as agree callback';
  }
  if (nodeName === 'Check Session Consent') {
    return count(0) === 1
      ? 'OK: consent gate received one row'
      : 'DIVERGED: missing consent produced no row';
  }
  if (nodeName === 'Gate Consent') {
    if (mode === 'agree') {
      return count(0) === 1 && count(1) === 0
        ? 'OK: consent present after agree'
        : 'DIVERGED: consent was not present after agree';
    }
    return count(0) === 0 && count(1) === 1
      ? 'OK: missing consent routed to consent prompt'
      : 'DIVERGED: consent gate skipped prompt';
  }
  if (nodeName === 'Ask Table Number') {
    return count(0) === 1
      ? 'OK: outbound WhatsApp table prompt executed'
      : 'DIVERGED: table prompt did not return output';
  }
  if (nodeName === 'Request Consent Message') {
    return count(0) === 1
      ? 'OK: outbound WhatsApp consent reply executed'
      : 'DIVERGED: outbound WhatsApp consent reply did not return output';
  }
  return 'OK: executed';
}

async function main() {
  const before = await latestExecutionId();
  const payload = makePayload();
  const body = JSON.stringify(payload);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'facebookexternalua',
      'x-hub-signature-256': `sha256=${crypto.createHash('sha256').update(body).digest('hex')}`,
    },
    body,
  });

  const responseText = await response.text();
  const row = await waitForExecution(before);
  const data = unflatten(JSON.parse(row.data));
  const runData = data.resultData.runData;
  const trace = [];
  for (const [nodeName, runs] of Object.entries(runData)) {
    const run = runs[0];
    const output = outputSummary(run);
    trace.push({
      node: nodeName,
      source: run.source || [],
      input: firstInputFor(nodeName, runData, run),
      output,
      check: checkExpected(nodeName, runData, output),
    });
  }

  const result = {
    postedMessageId: payload.entry[0].changes[0].value.messages[0].id,
    webhookResponse: { status: response.status, body: responseText },
    execution: {
      id: row.id,
      status: row.status,
      mode: row.mode,
      lastNode: data.resultData.lastNodeExecuted,
      error: data.resultData.error
        ? {
            name: data.resultData.error.name,
            message: data.resultData.error.message,
            description: data.resultData.error.description,
            node: data.resultData.error.node?.name,
            httpCode: data.resultData.error.httpCode,
          }
        : null,
    },
    trace,
  };

  console.log("SANITIZE OUTPUT:", JSON.stringify(runData["Sanitize Input"][0].data.main[0], null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
