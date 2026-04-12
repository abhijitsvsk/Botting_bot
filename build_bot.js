const fs = require('fs');
const { execSync } = require('child_process');

console.log("Compiling Bot: V1 (Production Ready)...");
execSync('node update_workflow.js', { stdio: 'inherit' });

console.log("Compiling Bot: V2 (AI Edition)...");
execSync('node compile_v2.js', { stdio: 'inherit' });

console.log("Compiling Bot: V3 (Ultimate)...");
execSync('node compile_v3.js', { stdio: 'inherit' });

console.log("Compiling Bot: V4 (Edge Cases)...");
execSync('node compile_v4.js', { stdio: 'inherit' });

console.log('Compiling Bot: V5 (Interactive Confirm Flow)...');
execSync('node compile_v5.js', { stdio: 'inherit' });

console.log('Compiling Bot: V6 (Hardened: timezone, GDPR, allergen, 86-mechanism)...');
execSync('node compile_v6.js', { stdio: 'inherit' });

console.log('Compiling Bot: V7 (Full: rate-limiting, promo, voice, amendment, repeat-order)...');
execSync('node compile_v7.js', { stdio: 'inherit' });

console.log('Compiling Bot: V8 (Resilience Rearch: deduplication, pg_advisory_xact_lock, DB strict check)...');
execSync('node compile_v8_rearch.js', { stdio: 'inherit' });

console.log('Compiling Bot: V9 (Blockers: consent, hours, idempotency, HMAC, GDPR)...');
execSync('node compile_v9_blockers.js', { stdio: 'inherit' });

console.log('Compiling Bot: V10 (AST Connections Wiring)...');
execSync('node compile_v10_wiring.js', { stdio: 'inherit' });

// Rename final output to accurately reflect its supreme completion status
fs.copyFileSync('./restaurant_bot_FINAL_WIRED.json', './restaurant_bot_ENDGAME_VERSION.json');
console.log('✅ Compilation Complete! Import restaurant_bot_ENDGAME_VERSION.json into n8n.');


