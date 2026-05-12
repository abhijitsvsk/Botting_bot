const fs = require('fs');
const old = JSON.parse(fs.readFileSync('restaurant_bot_FIXED.json', 'utf8'));
const n = old.nodes.find(n => n.name === 'Check Sanitization Error');
console.log('OLD params:', JSON.stringify(n.parameters, null, 2));
console.log('OLD typeVersion:', n.typeVersion);
