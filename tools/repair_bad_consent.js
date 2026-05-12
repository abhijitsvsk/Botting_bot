const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { createClient } = require('@supabase/supabase-js');

const apply = process.argv.includes('--apply');
const executionIdArg = process.argv.find((arg) => arg.startsWith('--execution='));
const executionId = executionIdArg ? Number(executionIdArg.split('=')[1]) : 117;
const dbPath = path.join(os.homedir(), '.n8n', 'database.sqlite');
const startScriptPath = path.join(__dirname, 'start_n8n.ps1');

function readPowerShellEnv(name) {
  const script = fs.readFileSync(startScriptPath, 'utf8');
  const match = script.match(new RegExp(`\\$env:${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`Missing ${name} in start_n8n.ps1`);
  return match[1];
}

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

function getBadConsentFromExecution() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.get('SELECT data FROM execution_data WHERE executionId = ?', [executionId], (err, row) => {
      db.close();
      if (err) return reject(err);
      if (!row) return reject(new Error(`Execution ${executionId} not found`));
      const data = unflatten(JSON.parse(row.data));
      const webhook = data.resultData.runData['WhatsApp Webhook']?.[0]?.data?.main?.[0]?.[0]?.json;
      const message = webhook?.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const consent = data.resultData.runData['Check Session Consent']?.[0]?.data?.main?.[0]?.[0]?.json;
      if (!message?.from || !consent?.consent_given_at) {
        return reject(new Error('Could not derive bad consent phone/timestamp from execution'));
      }
      resolve({ phone: message.from, consentGivenAt: consent.consent_given_at });
    });
  });
}

(async () => {
  const { phone, consentGivenAt } = await getBadConsentFromExecution();
  const supabase = createClient(
    readPowerShellEnv('SUPABASE_URL'),
    readPowerShellEnv('SUPABASE_SERVICE_ROLE_KEY'),
  );

  const { data: session, error: selectError } = await supabase
    .from('user_sessions')
    .select('phone, consent_given_at')
    .eq('phone', phone)
    .maybeSingle();

  if (selectError) throw selectError;
  console.log(`Phone: ${phone}`);
  console.log(`Bad execution consent timestamp: ${consentGivenAt}`);
  console.log(`Current DB consent timestamp: ${session?.consent_given_at || 'none'}`);

  const currentTime = session?.consent_given_at
    ? new Date(session.consent_given_at).getTime()
    : null;
  const badTime = new Date(consentGivenAt).getTime();
  const matchesBadExecution = currentTime === badTime;

  if (!matchesBadExecution) {
    console.log('No repair applied: current timestamp does not match the bad execution exactly.');
    return;
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to clear this consent timestamp.');
    return;
  }

  const { error: updateError } = await supabase
    .from('user_sessions')
    .update({ consent_given_at: null })
    .eq('phone', phone);

  if (updateError) throw updateError;
  console.log('Cleared the bad consent timestamp.');
})();
