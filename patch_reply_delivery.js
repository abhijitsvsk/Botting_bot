const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const workflowId = 'WXtzFB4sV7Qjlhhk';
const sourceExecutionId = 255;
const apply = process.argv.includes('--apply');
const dbPath = path.join(os.homedir(), '.n8n', 'database.sqlite');
const backupPath = path.join(
  __dirname,
  `database_backup_reply_delivery_${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
);

const nodeNamesToCopy = new Set([
  'Message Deduplicate',
  'Check If Agree Callback',
  'Insert Consent',
  'HMAC Verification',
  'Check Session Consent',
  'Gate Consent',
  'Check Operating Hours',
  'Request Consent Message',
  'Sanitize Input',
  'Check Sanitization Error',
  'Load Session from DB',
  'Process Session',
  'Save Session to DB',
  'Restore Session After Save',
  'Check Table Error',
]);

const connectionNamesToCopy = [
  'Message Deduplicate',
  'Dedup Check',
  'Check If Agree Callback',
  'Insert Consent',
  'HMAC Verification',
  'Check Session Consent',
  'Gate Consent',
  'Check Operating Hours',
  'Gate Operating Hours',
  'Read Global Settings',
  'Map Global Settings',
  'Sanitize Input',
  'Check Sanitization Error',
  'Load Session from DB',
  'Process Session',
  'Save Session to DB',
  'Restore Session After Save',
  'Check Table Set',
];

function byName(nodes) {
  return Object.fromEntries(nodes.map((node) => [node.name, node]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function patchWorkflow(liveRow, sourceWorkflow) {
  const liveNodes = JSON.parse(liveRow.nodes);
  const liveConnections = JSON.parse(liveRow.connections || '{}');
  const sourceNodes = byName(sourceWorkflow.nodes);
  const liveNodesByName = byName(liveNodes);
  const changes = [];

  for (const nodeName of nodeNamesToCopy) {
    const sourceNode = sourceNodes[nodeName];
    const liveNode = liveNodesByName[nodeName];
    if (!sourceNode) throw new Error(`Source workflow is missing node: ${nodeName}`);
    if (!liveNode) throw new Error(`Live workflow is missing node: ${nodeName}`);

    const before = JSON.stringify({
      type: liveNode.type,
      typeVersion: liveNode.typeVersion,
      parameters: liveNode.parameters,
      credentials: liveNode.credentials,
    });

    liveNode.type = sourceNode.type;
    if (sourceNode.typeVersion !== undefined) liveNode.typeVersion = sourceNode.typeVersion;
    liveNode.parameters = clone(sourceNode.parameters || {});
    if (sourceNode.credentials !== undefined) liveNode.credentials = clone(sourceNode.credentials);

    const after = JSON.stringify({
      type: liveNode.type,
      typeVersion: liveNode.typeVersion,
      parameters: liveNode.parameters,
      credentials: liveNode.credentials,
    });

    if (before !== after) changes.push(`Restored node: ${nodeName}`);
  }

  const messageDedupNode = liveNodesByName['Message Deduplicate'];
  if (!messageDedupNode) throw new Error('Live workflow is missing node: Message Deduplicate');
  const dedupBefore = JSON.stringify(messageDedupNode.parameters || {});
  messageDedupNode.parameters = messageDedupNode.parameters || {};
  messageDedupNode.parameters.query =
    "INSERT INTO message_logs (message_id, phone, direction, channel, created_at) SELECT $1, $2, 'inbound', 'whatsapp', NOW() WHERE NULLIF($1, '') IS NOT NULL AND NULLIF($2, '') IS NOT NULL ON CONFLICT (message_id) DO NOTHING RETURNING id;";
  messageDedupNode.parameters.options = {
    queryReplacement:
      "={{ $json.body.entry[0].changes[0].value.messages?.[0]?.id || '' }},={{ $json.body.entry[0].changes[0].value.messages?.[0]?.from || '' }}",
  };
  const dedupAfter = JSON.stringify(messageDedupNode.parameters);
  if (dedupBefore !== dedupAfter) {
    changes.push('Patched Message Deduplicate to ignore status-only webhooks cleanly');
  }

  const saveSessionNode = liveNodesByName['Save Session to DB'];
  if (!saveSessionNode) throw new Error('Live workflow is missing node: Save Session to DB');
  const saveSessionBefore = JSON.stringify(saveSessionNode.parameters || {});
  saveSessionNode.parameters = saveSessionNode.parameters || {};
  saveSessionNode.parameters.query =
    "INSERT INTO user_sessions (phone, table_number, cart, preferences, last_inbound_at) VALUES ($1, NULLIF($2, ''), $3::jsonb, $4::jsonb, NOW()) ON CONFLICT (phone) DO UPDATE SET table_number = COALESCE(NULLIF(EXCLUDED.table_number, ''), user_sessions.table_number), cart = EXCLUDED.cart, preferences = EXCLUDED.preferences, last_inbound_at = NOW() RETURNING *";
  saveSessionNode.parameters.options = {
    queryReplacement:
      "={{ $json.session.phone }},={{ $json.session.table_number || '' }},={{ JSON.stringify($json.session.cart || []) }},={{ JSON.stringify($json.session.preferences || {}) }}",
  };
  const saveSessionAfter = JSON.stringify(saveSessionNode.parameters);
  if (saveSessionBefore !== saveSessionAfter) {
    changes.push('Patched Save Session to DB to preserve an existing table number');
  }

  const dedupCheckNode = liveNodesByName['Dedup Check'];
  if (!dedupCheckNode) throw new Error('Live workflow is missing node: Dedup Check');
  const dedupCheckBefore = JSON.stringify(dedupCheckNode.parameters || {});
  dedupCheckNode.parameters = dedupCheckNode.parameters || {};
  dedupCheckNode.parameters.conditions = {
    options: {
      caseSensitive: true,
      leftValue: '',
      typeValidation: 'strict',
      version: 1,
    },
    conditions: [
      {
        id: 'dedup-has-insert-id',
        leftValue: "={{ $json.id === undefined || $json.id === null ? '' : String($json.id) }}",
        rightValue: '',
        operator: {
          type: 'string',
          operation: 'notEmpty',
          singleValue: true,
        },
      },
    ],
    combinator: 'and',
  };
  const dedupCheckAfter = JSON.stringify(dedupCheckNode.parameters);
  if (dedupCheckBefore !== dedupCheckAfter) {
    changes.push('Patched Dedup Check to ignore non-message webhook items');
  }

  const checkTableSetNode = liveNodesByName['Check Table Set'];
  if (!checkTableSetNode) throw new Error('Live workflow is missing node: Check Table Set');
  const checkTableSetBefore = JSON.stringify(checkTableSetNode.parameters || {});
  checkTableSetNode.parameters = checkTableSetNode.parameters || {};
  checkTableSetNode.parameters.conditions = {
    options: {
      caseSensitive: true,
      leftValue: '',
      typeValidation: 'strict',
      version: 1,
    },
    conditions: [
      {
        id: 'session-has-table',
        leftValue: '={{ $json.session.table_number }}',
        rightValue: '',
        operator: {
          type: 'string',
          operation: 'notEmpty',
          singleValue: true,
        },
      },
    ],
    combinator: 'and',
  };
  const checkTableSetAfter = JSON.stringify(checkTableSetNode.parameters);
  if (checkTableSetBefore !== checkTableSetAfter) {
    changes.push('Patched Check Table Set to recognize an existing table number');
  }

  const routeActionNode = liveNodesByName['Route Action'];
  if (!routeActionNode) throw new Error('Live workflow is missing node: Route Action');
  const routeActionBefore = JSON.stringify(routeActionNode.parameters || {});
  const stringCondition = (leftValue, rightValue, operation = 'equals') => ({
    leftValue,
    rightValue,
    operator: {
      type: 'string',
      operation,
    },
  });
  routeActionNode.parameters = {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || $json.text || '').trim().toUpperCase() }}", 'MENU')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'menu',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || $json.text || '').trim().toUpperCase() }}", 'CART')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'cart',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              stringCondition("={{ String($json.action || $json.text || '').trim().toUpperCase() }}", 'CONFIRM'),
              stringCondition("={{ String($json.action || '').trim().toUpperCase() }}", 'CMD_CONFIRM'),
            ],
            combinator: 'or',
          },
          renameOutput: true,
          outputKey: 'confirm',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || $json.text || '').trim().toUpperCase() }}", 'HELP')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'help',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || '').trim().toUpperCase() }}", 'CMD_CUSTOMISE')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'customise',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || '').trim().toUpperCase() }}", 'CMD_CLEAR_CART')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'clear_cart',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              stringCondition("={{ String($json.action || $json.text || '').trim().toUpperCase() }}", 'CANCEL'),
              stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'CANCEL ORDER'),
            ],
            combinator: 'or',
          },
          renameOutput: true,
          outputKey: 'cancel',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || '').trim().toUpperCase() }}", 'CMD_GDPR_AGREE')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'gdpr_agree',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.action || '').trim().toUpperCase() }}", 'CMD_GDPR_DECLINE')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'gdpr_decline',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'DELETE MY DATA', 'contains')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'delete_data',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'UPDATE', 'contains'),
              stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'CHANGE', 'contains'),
              stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'SET', 'contains'),
            ],
            combinator: 'or',
          },
          renameOutput: true,
          outputKey: 'update_item',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'REPEAT', 'contains')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'repeat_order',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'EDIT ORDER', 'contains')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'edit_order',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition("={{ String($json.text || '').trim().toUpperCase() }}", 'PROMO', 'contains')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'promo',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              {
                leftValue: "={{ String($json.text || '').trim() }}",
                rightValue: '',
                operator: {
                  type: 'string',
                  operation: 'notEmpty',
                  singleValue: true,
                },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'order_text',
        },
        {
          conditions: {
            options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [stringCondition('={{ "HELP" }}', 'HELP')],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'fallback_help',
        },
      ],
    },
    options: {
      fallbackOutput: 'none',
      ignoreCase: true,
      allMatchingOutputs: false,
    },
  };
  const routeActionAfter = JSON.stringify(routeActionNode.parameters);
  if (routeActionBefore !== routeActionAfter) {
    changes.push('Rebuilt Route Action with valid ordered rules for menu, cart, confirm, and ordering text');
  }

  const getRestaurantConfigNode = liveNodesByName['Get Restaurant Config'];
  if (getRestaurantConfigNode) {
    const before = JSON.stringify(getRestaurantConfigNode.parameters || {});
    getRestaurantConfigNode.parameters = getRestaurantConfigNode.parameters || {};
    getRestaurantConfigNode.parameters.options = {
      queryReplacement:
        "={{ $('WhatsApp Webhook').item.json.body.entry[0].changes[0].value.metadata?.phone_number_id || $env.WHATSAPP_PHONE_NUMBER_ID || $env.WHATSAPP_PHONE_ID || 'DEFAULT_PHONE_ID' }}",
    };
    const after = JSON.stringify(getRestaurantConfigNode.parameters);
    if (before !== after) {
      changes.push('Patched Get Restaurant Config to use the live WhatsApp phone number id');
    }
  }

  const checkOperatingHoursNode = liveNodesByName['Check Operating Hours'];
  if (checkOperatingHoursNode) {
    const before = JSON.stringify(checkOperatingHoursNode.parameters || {});
    checkOperatingHoursNode.parameters = checkOperatingHoursNode.parameters || {};
    checkOperatingHoursNode.parameters.jsCode = [
      "const config = $('Get Restaurant Config').item.json || {};",
      "const tz = config.timezone || $env.TIMEZONE || 'Asia/Kolkata';",
      "const now = new Date().toLocaleString('en-US', { timeZone: tz });",
      'const localNow = new Date(now);',
      'const currentMins = localNow.getHours() * 60 + localNow.getMinutes();',
      '',
      'const parseTime = (value, fallback) => {',
      "  const [h, m] = String(value || fallback).split(':').map(Number);",
      '  return h * 60 + (m || 0);',
      '};',
      '',
      "const openMins = parseTime(config.opening_time, $env.OPENING_TIME || '09:00');",
      "const closeMins = parseTime(config.closing_time, $env.CLOSING_TIME || '23:00');",
      'const isOpen = closeMins > openMins',
      '  ? currentMins >= openMins && currentMins < closeMins',
      '  : currentMins >= openMins || currentMins < closeMins;',
      '',
      "return [{ json: { ...$input.first().json, is_open: isOpen, kitchen_is_open: isOpen, current_time_tz: now } }];",
    ].join('\n');
    const after = JSON.stringify(checkOperatingHoursNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Operating Hours to emit the fields the gate expects');
    }
  }

  const gateOperatingHoursNode = liveNodesByName['Gate Operating Hours'];
  if (gateOperatingHoursNode) {
    const before = JSON.stringify(gateOperatingHoursNode.parameters || {});
    gateOperatingHoursNode.parameters = gateOperatingHoursNode.parameters || {};
    gateOperatingHoursNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'kitchen-open',
          leftValue: '={{ $json.kitchen_is_open ?? $json.is_open }}',
          rightValue: true,
          operator: {
            type: 'boolean',
            operation: 'equals',
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(gateOperatingHoursNode.parameters);
    if (before !== after) {
      changes.push('Patched Gate Operating Hours to read the live operating-hours flag');
    }
  }

  const sanitizeInputNode = liveNodesByName['Sanitize Input'];
  if (sanitizeInputNode) {
    const before = JSON.stringify(sanitizeInputNode.parameters || {});
    sanitizeInputNode.parameters = sanitizeInputNode.parameters || {};
    sanitizeInputNode.parameters.jsCode = [
      'const entry = $input.item.json.entry || $input.item.json.body?.entry;',
      'const message = entry?.[0]?.changes?.[0]?.value?.messages?.[0];',
      'if (!message) {',
      '  const json = { ...$input.item.json };',
      '  delete json.error;',
      '  return [{ json }];',
      '}',
      "const phone = String(message.from || '');",
      'const phoneRegex = /^[+0-9-]+$/;',
      'if (!phoneRegex.test(phone)) {',
      "  return [{ json: { ...$input.item.json, error: 'INVALID_PHONE', error_msg: 'Invalid phone format' } }];",
      '}',
      'if (phone.length > 20) {',
      "  return [{ json: { ...$input.item.json, error: 'PHONE_TOO_LONG', error_msg: 'Phone too long' } }];",
      '}',
      "let action = '';",
      "let raw = '';",
      "if (message.type === 'interactive') {",
      "  action = String(message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '').toUpperCase();",
      "} else if (message.type === 'text') {",
      "  raw = String(message.text?.body || '').toUpperCase();",
      '}',
      "let text = raw.replace(/[^A-Z0-9_]/g, ' ').replace(/ +/g, ' ').trim();",
      "if (action === 'CMD_AGREE_PRIVACY') {",
      "  text = 'HI';",
      '}',
      "if (action.startsWith('CMD_ADD_')) {",
      "  text = `1 ${action.replace('CMD_ADD_', '')}`;",
      '}',
      'const json = { ...$input.item.json, text, action, phone, from: phone, timestamp: Date.now() };',
      'delete json.error;',
      'return [{ json }];',
    ].join('\n');
    const after = JSON.stringify(sanitizeInputNode.parameters);
    if (before !== after) {
      changes.push('Patched Sanitize Input so menu selections become add-to-cart text');
    }
  }

  const messageClosedNode = liveNodesByName['Message Closed'];
  if (messageClosedNode) {
    const before = JSON.stringify(messageClosedNode.parameters || {});
    messageClosedNode.parameters = messageClosedNode.parameters || {};
    messageClosedNode.parameters.jsonBody =
      '={"messaging_product": "whatsapp", "to": "{{ $(\'WhatsApp Webhook\').item.json.body.entry[0].changes[0].value.messages[0].from }}", "type": "text", "text": {"body": "We\'re currently closed. We open at {{ $env.OPENING_TIME }}. You can pre-order when we open."}}';
    const after = JSON.stringify(messageClosedNode.parameters);
    if (before !== after) {
      changes.push('Patched Message Closed to reply to the current WhatsApp sender');
    }
  }

  const getMenuNode = liveNodesByName['Get Menu from DB'];
  if (!getMenuNode) throw new Error('Live workflow is missing node: Get Menu from DB');
  const getMenuBefore = JSON.stringify(getMenuNode.parameters || {});
  getMenuNode.parameters = getMenuNode.parameters || {};
  getMenuNode.parameters.query =
    "SELECT item_code AS code, name, category, price, description, available AS is_available FROM menu_items WHERE available = true UNION ALL SELECT NULL AS code, NULL AS name, NULL AS category, NULL AS price, NULL AS description, NULL AS is_available WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE available = true)";
  getMenuNode.parameters.alwaysOutputData = true;
  const getMenuAfter = JSON.stringify(getMenuNode.parameters);
  if (getMenuBefore !== getMenuAfter) {
    changes.push('Patched Get Menu from DB to the live menu_items schema');
  }

  const getMenuForAiNode = liveNodesByName['Get Menu for AI context'];
  if (!getMenuForAiNode) throw new Error('Live workflow is missing node: Get Menu for AI context');
  const getMenuForAiBefore = JSON.stringify(getMenuForAiNode.parameters || {});
  getMenuForAiNode.parameters = getMenuForAiNode.parameters || {};
  getMenuForAiNode.parameters.query =
    'SELECT item_code AS code, name, available AS is_available FROM menu_items';
  const getMenuForAiAfter = JSON.stringify(getMenuForAiNode.parameters);
  if (getMenuForAiBefore !== getMenuForAiAfter) {
    changes.push('Patched Get Menu for AI context to the live menu_items schema');
  }

  const lookupItemsNode = liveNodesByName['Lookup Items in DB'];
  if (!lookupItemsNode) throw new Error('Live workflow is missing node: Lookup Items in DB');
  const lookupItemsBefore = JSON.stringify(lookupItemsNode.parameters || {});
  lookupItemsNode.parameters = lookupItemsNode.parameters || {};
  lookupItemsNode.parameters.query =
    "SELECT item_code AS code, name, price, category, available AS is_available FROM menu_items WHERE item_code = ANY(string_to_array($1, ','))";
  lookupItemsNode.parameters.options = {
    queryReplacement:
      "={{ $json.parsed_items.map((i) => String(i.code || i.item_code || '').toUpperCase()).filter(Boolean).join(',') }}",
  };
  const lookupItemsAfter = JSON.stringify(lookupItemsNode.parameters);
  if (lookupItemsBefore !== lookupItemsAfter) {
    changes.push('Patched Lookup Items in DB to the live menu_items schema');
  }

  const allergenPreScanNode = liveNodesByName['Allergen Pre-Scan'];
  if (allergenPreScanNode) {
    const before = JSON.stringify(allergenPreScanNode.parameters || {});
    allergenPreScanNode.parameters = allergenPreScanNode.parameters || {};
    allergenPreScanNode.parameters.jsCode = [
      "const text = String($('Route Action').item.json.text || '').toLowerCase();",
      "const rawKeywords = String($env.ALLERGEN_KEYWORDS || 'nut,peanut,gluten,dairy,egg,shellfish,soy,wheat,sesame,fish');",
      "const keywords = rawKeywords.split(',').map((value) => value.trim()).filter(Boolean);",
      'const found = keywords.filter((keyword) => text.includes(keyword.toLowerCase()));',
      'return $input.all().map((item) => ({ json: { ...item.json, allergen_alert: found.length > 0, allergen_text: found.join(", ") } }));',
    ].join('\n');
    const after = JSON.stringify(allergenPreScanNode.parameters);
    if (before !== after) {
      changes.push('Patched Allergen Pre-Scan to use environment keywords without depending on an unexecuted node');
    }
  }

  const groqParserNode = liveNodesByName['Groq AI Parser'];
  if (groqParserNode) {
    const before = JSON.stringify(groqParserNode.parameters || {});
    groqParserNode.parameters = groqParserNode.parameters || {};
    groqParserNode.parameters.headerParameters = groqParserNode.parameters.headerParameters || {
      parameters: [],
    };
    groqParserNode.parameters.headerParameters.parameters = [
      {
        name: 'Authorization',
        value: '=Bearer {{$env.GROQ_API_KEY}}',
      },
      {
        name: 'Content-Type',
        value: 'application/json',
      },
    ];
    groqParserNode.parameters.jsonBody =
      '={{ JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [ { role: "system", content: "You extract food item codes and quantities from user orders. Here is the live menu database: " + JSON.stringify($input.all().map((item) => item.json)) + ". Return only a valid JSON array of objects like [{\\"code\\":\\"D01\\",\\"quantity\\":2}]. Map natural language requests to menu codes. If an item is unavailable, still output its code." }, { role: "user", content: $(\'Route Action\').item.json.text || $(\'Route Action\').item.json.action || "" } ], temperature: 0 }) }}';
    const after = JSON.stringify(groqParserNode.parameters);
    if (before !== after) {
      changes.push('Patched Groq AI Parser to fall back to the environment API key');
    }
  }

  const extractGroqOutputNode = liveNodesByName['Extract Groq Output'];
  if (extractGroqOutputNode) {
    const before = JSON.stringify(extractGroqOutputNode.parameters || {});
    extractGroqOutputNode.parameters = extractGroqOutputNode.parameters || {};
    extractGroqOutputNode.parameters.jsCode = [
      "const request = $('Route Action').item.json;",
      'const data = $input.item.json;',
      'let parsed_items = [];',
      'try {',
      '  const content = data.choices?.[0]?.message?.content || "[]";',
      '  const arrayMatch = content.match(/\\[.*\\]/s);',
      '  parsed_items = JSON.parse(arrayMatch ? arrayMatch[0] : content);',
      '} catch (error) {',
      "  return [{ json: { ...request, ...data, error: 'AI_PARSE_ERROR', error_msg: 'We had trouble understanding your order. Try sending item codes like D01 or M01.' } }];",
      '}',
      'if (!Array.isArray(parsed_items) || parsed_items.length === 0) {',
      "  return [{ json: { ...request, ...data, error: 'NO_ITEMS', error_msg: 'No items were found in your message. Try sending item codes like D01 or M01.' } }];",
      '}',
      'parsed_items = parsed_items.map((item) => ({ ...item, quantity: parseInt(item.quantity, 10) || 1 }));',
      'return [{ json: { ...request, ...data, parsed_items } }];',
    ].join('\n');
    const after = JSON.stringify(extractGroqOutputNode.parameters);
    if (before !== after) {
      changes.push('Patched Extract Groq Output to preserve the request context for cart updates and error replies');
    }
  }

  const checkParseErrorNode = liveNodesByName['Check Parse Error'];
  if (checkParseErrorNode) {
    const before = JSON.stringify(checkParseErrorNode.parameters || {});
    checkParseErrorNode.parameters = checkParseErrorNode.parameters || {};
    checkParseErrorNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'parse-error',
          leftValue: '={{ $json.error || "" }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(checkParseErrorNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Parse Error to valid IF-v2 condition syntax');
    }
  }

  const addToCartNode = liveNodesByName['Add to Cart'];
  if (addToCartNode) {
    const before = JSON.stringify(addToCartNode.parameters || {});
    addToCartNode.parameters = addToCartNode.parameters || {};
    addToCartNode.parameters.jsCode = [
      "const inputData = $('Extract Groq Output').first().json;",
      'const parsed_items = inputData.parsed_items || [];',
      'const dbItems = $input.all().map((item) => item.json);',
      '',
      'if (!dbItems.length) {',
      "  return [{ json: { ...inputData, error: 'ITEMS_NOT_FOUND', error_msg: 'No valid items found. Type MENU to see available items.' } }];",
      '}',
      '',
      'const session = inputData.session || {};',
      'const cart = Array.isArray(session.cart) ? session.cart : [];',
      'const outOfStock = [];',
      'const itemsAdded = [];',
      '',
      'for (const dbItem of dbItems) {',
      "  const itemCode = String(dbItem.item_code || dbItem.code || '').toUpperCase();",
      '  const requested = parsed_items.find((parsed) => String(parsed.code || parsed.item_code || "").toUpperCase() === itemCode);',
      '  const qty = requested ? Math.max(1, parseInt(requested.quantity, 10) || 1) : 1;',
      '',
      '  if (!dbItem.is_available) {',
      '    outOfStock.push(dbItem.name);',
      '    continue;',
      '  }',
      '',
      '  itemsAdded.push(`${qty}x ${dbItem.name}`);',
      '  const existing = cart.find((item) => String(item.item_code || item.code || "").toUpperCase() === itemCode);',
      '  if (existing) {',
      '    existing.quantity += qty;',
      '    existing.item_code = existing.item_code || itemCode;',
      '    existing.code = existing.code || itemCode;',
      '  } else {',
      '    cart.push({',
      '      item_code: itemCode,',
      '      code: itemCode,',
      '      name: dbItem.name,',
      '      price: dbItem.price,',
      '      category: dbItem.category,',
      '      quantity: qty,',
      '      id: Date.now() + Math.random(),',
      '    });',
      '  }',
      '}',
      '',
      'session.cart = cart;',
      '',
      'if (!itemsAdded.length && outOfStock.length) {',
      "  return [{ json: { ...inputData, error: 'ALL_OUT_OF_STOCK', error_msg: `Sorry, everything you requested (${outOfStock.join(', ')}) is currently sold out.` } }];",
      '}',
      '',
      'const subtotal = cart.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 1)), 0);',
      "const rawTaxRate = parseFloat($env.TAX_RATE || $('Get Restaurant Config').item.json.tax_rate || '0');",
      'const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate;',
      'const tax = Math.round(subtotal * taxRate);',
      'const total = subtotal + tax;',
      '',
      'return [{ json: { ...inputData, session, cart, subtotal, tax, total, items_added: itemsAdded, out_of_stock: outOfStock } }];',
    ].join('\n');
    const after = JSON.stringify(addToCartNode.parameters);
    if (before !== after) {
      changes.push('Patched Add to Cart to store stable item_code values in the session cart');
    }
  }

  const updateCartNode = liveNodesByName['Update Cart in DB'];
  if (updateCartNode) {
    const before = JSON.stringify(updateCartNode.parameters || {});
    updateCartNode.parameters = updateCartNode.parameters || {};
    updateCartNode.parameters.query =
      'WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($2::text))) UPDATE user_sessions SET cart = $1::jsonb, last_inbound_at = NOW() WHERE phone = $2 RETURNING *;';
    updateCartNode.parameters.options = {
      queryReplacement:
        '={{ JSON.stringify($json.session.cart || []) }},={{ $json.from }}',
    };
    const after = JSON.stringify(updateCartNode.parameters);
    if (before !== after) {
      changes.push('Patched Update Cart in DB to lock on phone and write last_inbound_at');
    }
  }

  const checkAddErrorNode = liveNodesByName['Check Add Error'];
  if (checkAddErrorNode) {
    const before = JSON.stringify(checkAddErrorNode.parameters || {});
    checkAddErrorNode.parameters = checkAddErrorNode.parameters || {};
    checkAddErrorNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'add-error',
          leftValue: '={{ $json.error || "" }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(checkAddErrorNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Add Error to valid IF-v2 condition syntax');
    }
  }

  const confirmItemsAddedNode = liveNodesByName['Confirm Items Added'];
  if (confirmItemsAddedNode) {
    const before = JSON.stringify(confirmItemsAddedNode.parameters || {});
    confirmItemsAddedNode.parameters = confirmItemsAddedNode.parameters || {};
    confirmItemsAddedNode.parameters.jsonBody =
      '={"messaging_product": "whatsapp", "to": "{{ $(\'Route Action\').item.json.from }}", "type": "text", "text": {"body": "Added to cart:\\n{{ $(\'Add to Cart\').item.json.items_added.join(\'\\\\n\') }}{{ $(\'Add to Cart\').item.json.out_of_stock.length > 0 ? \'\\\\n\\\\nSold out (not added):\\\\n- \' + $(\'Add to Cart\').item.json.out_of_stock.join(\'\\\\n- \') : \'\' }}\\n\\nCart total: Rs {{ $(\'Add to Cart\').item.json.total }}\\n\\nType CART to review or send more items."}}';
    const after = JSON.stringify(confirmItemsAddedNode.parameters);
    if (before !== after) {
      changes.push('Patched Confirm Items Added to use the add-to-cart context instead of the DB update row');
    }
  }

  const syncToDbNode = liveNodesByName['Sync to DB'];
  if (!syncToDbNode) throw new Error('Live workflow is missing node: Sync to DB');
  const syncToDbBefore = JSON.stringify(syncToDbNode.parameters || {});
  syncToDbNode.parameters = syncToDbNode.parameters || {};
  syncToDbNode.parameters.query =
    'INSERT INTO menu_items (item_code, name, category, price, description, available) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (item_code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price, description = EXCLUDED.description, available = EXCLUDED.available';
  const syncToDbAfter = JSON.stringify(syncToDbNode.parameters);
  if (syncToDbBefore !== syncToDbAfter) {
    changes.push('Patched Sync to DB to write to the live menu_items schema');
  }

  const repeatLastOrderNode = liveNodesByName['Repeat Last Order'];
  if (!repeatLastOrderNode) throw new Error('Live workflow is missing node: Repeat Last Order');
  const repeatLastOrderBefore = JSON.stringify(repeatLastOrderNode.parameters || {});
  repeatLastOrderNode.parameters = repeatLastOrderNode.parameters || {};
  repeatLastOrderNode.parameters.query =
    "WITH unavailable AS ( SELECT item->>'name' AS name FROM jsonb_array_elements((SELECT last_order FROM user_sessions WHERE phone = $1)) AS item LEFT JOIN menu_items m ON m.item_code = COALESCE(item->>'item_code', item->>'code') WHERE m.available = false OR m.item_code IS NULL ) UPDATE user_sessions SET cart = CASE WHEN (SELECT COUNT(*) FROM unavailable) = 0 THEN last_order ELSE cart END WHERE phone = $1 RETURNING cart, (SELECT json_agg(name) FROM unavailable) AS unavailable_items;";
  repeatLastOrderNode.parameters.options = {
    queryReplacement: '={{ $json.from }}',
  };
  const repeatLastOrderAfter = JSON.stringify(repeatLastOrderNode.parameters);
  if (repeatLastOrderBefore !== repeatLastOrderAfter) {
    changes.push('Patched Repeat Last Order to the live menu_items schema');
  }

  const formatMenuNode = liveNodesByName['Format Menu'];
  if (!formatMenuNode) throw new Error('Live workflow is missing node: Format Menu');
  const formatMenuBefore = JSON.stringify(formatMenuNode.parameters || {});
  formatMenuNode.parameters = formatMenuNode.parameters || {};
  formatMenuNode.parameters.jsCode = [
    "const request = $('Route Action').first().json;",
    'const menuItems = $input.all().map((item) => item.json).filter((item) => item && item.code);',
    'if (!menuItems.length) {',
    "  return [{ json: { ...request, whatsapp_payload: { messaging_product: 'whatsapp', to: request.from, type: 'text', text: { body: 'Menu is not available right now. Please try again in a few minutes.' } } } }];",
    '}',
    'const rows = menuItems.slice(0, 10).map((item) => ({',
    "  id: 'CMD_ADD_' + item.code,",
    "  title: String(item.name || 'Item').slice(0, 24),",
    "  description: (`Rs ${item.price} - ${item.category || 'Menu'}`).slice(0, 72),",
    '}));',
    "const interactive = { type: 'list', header: { type: 'text', text: 'Live Menu' }, body: { text: 'Select an item to add to your cart or type your order. Example: 2 B1 and 1 D2' }, action: { button: 'View Items', sections: [{ title: 'Available Items', rows }] } };",
    "return [{ json: { ...request, whatsapp_payload: { messaging_product: 'whatsapp', to: request.from, type: 'interactive', interactive } } }];",
  ].join('\n');
  const formatMenuAfter = JSON.stringify(formatMenuNode.parameters);
  if (formatMenuBefore !== formatMenuAfter) {
    changes.push('Patched Format Menu to preserve the request context and handle empty menus');
  }

  const sendMenuNode = liveNodesByName['Send Menu'];
  if (!sendMenuNode) throw new Error('Live workflow is missing node: Send Menu');
  const sendMenuBefore = JSON.stringify(sendMenuNode.parameters || {});
  sendMenuNode.parameters = sendMenuNode.parameters || {};
  sendMenuNode.parameters.jsonBody = '={{ JSON.stringify($json.whatsapp_payload) }}';
  const sendMenuAfter = JSON.stringify(sendMenuNode.parameters);
  if (sendMenuBefore !== sendMenuAfter) {
    changes.push('Patched Send Menu to send the payload built by Format Menu');
  }

  const saveTableNode = liveNodesByName['Save Table to DB'];
  if (!saveTableNode) throw new Error('Live workflow is missing node: Save Table to DB');
  const saveTableQuery =
    'UPDATE user_sessions SET table_number = $1, last_inbound_at = NOW() WHERE phone = $2 RETURNING *';
  const saveTableReplacement = '={{ $json.session.table_number }},={{ $json.from }}';
  const saveTableBefore = JSON.stringify(saveTableNode.parameters || {});
  saveTableNode.parameters = saveTableNode.parameters || {};
  saveTableNode.parameters.query = saveTableQuery;
  saveTableNode.parameters.options = { queryReplacement: saveTableReplacement };
  const saveTableAfter = JSON.stringify(saveTableNode.parameters);
  if (saveTableBefore !== saveTableAfter) changes.push('Patched Save Table to DB to use last_inbound_at');

  const confirmTableNode = liveNodesByName['Confirm Table'];
  if (!confirmTableNode) throw new Error('Live workflow is missing node: Confirm Table');
  const confirmBefore = JSON.stringify(confirmTableNode.parameters || {});
  confirmTableNode.parameters = confirmTableNode.parameters || {};
  confirmTableNode.parameters.jsonBody =
    '={"messaging_product": "whatsapp", "to": "{{ $json.phone || $json.from }}", "type": "text", "text": {"body": "✅ Table {{ $json.table_number || $json.session.table_number }} confirmed!\\n\\nType MENU to see our menu"}}';
  const confirmAfter = JSON.stringify(confirmTableNode.parameters);
  if (confirmBefore !== confirmAfter) {
    changes.push('Patched Confirm Table to use phone and table_number from the saved row');
  }

  const slidingWindowNode = liveNodesByName['Sliding Window Check'];
  if (slidingWindowNode) {
    const before = JSON.stringify(slidingWindowNode.parameters || {});
    slidingWindowNode.parameters = slidingWindowNode.parameters || {};
    slidingWindowNode.parameters.options = {
      queryReplacement:
        "={{ $('WhatsApp Webhook').item.json.body.entry[0].changes[0].value.messages[0].from }}",
    };
    const after = JSON.stringify(slidingWindowNode.parameters);
    if (before !== after) {
      changes.push('Patched Sliding Window Check to use the current WhatsApp sender');
    }
  }

  const gdprDetectNode = liveNodesByName['GDPR Consent Detect'];
  if (gdprDetectNode) {
    const before = JSON.stringify(gdprDetectNode.parameters || {});
    gdprDetectNode.parameters = gdprDetectNode.parameters || {};
    gdprDetectNode.parameters.jsCode = [
      "const message = $('WhatsApp Webhook').item.json.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || {};",
      "const text = message.text?.body || '';",
      "if (text.toUpperCase().includes('DELETE MY DATA')) {",
      "  return [{ json: { is_deletion_request: true, phone: message.from } }];",
      '}',
      'return [{ json: { is_deletion_request: false } }];',
    ].join('\n');
    const after = JSON.stringify(gdprDetectNode.parameters);
    if (before !== after) {
      changes.push('Patched GDPR Consent Detect to use the current WhatsApp payload');
    }
  }

  const checkRestaurantStatusNode = liveNodesByName['Check Restaurant Status'];
  if (checkRestaurantStatusNode) {
    const before = JSON.stringify(checkRestaurantStatusNode.parameters || {});
    checkRestaurantStatusNode.parameters = checkRestaurantStatusNode.parameters || {};
    checkRestaurantStatusNode.parameters.jsCode = [
      'const rest = $json;',
      "if (!rest || !rest.restaurant_id) return [{ json: { action: 'HALT', reason: 'unrecognized_phone_id' } }];",
      '',
      'let status = rest.subscription_status;',
      "if (status === 'trial' && new Date() > new Date(rest.trial_ends_at)) {",
      "  status = 'suspended';",
      '}',
      '',
      "if (status === 'suspended') {",
      "  return [{ json: { action: 'SEND_MESSAGE', phone: $('WhatsApp Webhook').item.json.body.entry[0].changes[0].value.messages[0].from, message: 'Service is currently unavailable. Please contact the restaurant.' } }];",
      '}',
      '',
      "return [{ json: { action: 'PROCESS', ...rest } }];",
    ].join('\n');
    const after = JSON.stringify(checkRestaurantStatusNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Restaurant Status to reference the live webhook node');
    }
  }

  const storeIdempotencyNode = liveNodesByName['Store Idempotency Key'];
  if (storeIdempotencyNode) {
    const before = JSON.stringify(storeIdempotencyNode.parameters || {});
    storeIdempotencyNode.parameters = storeIdempotencyNode.parameters || {};
    storeIdempotencyNode.parameters.query =
      'UPDATE user_sessions SET idempotency_key = $1 WHERE phone = $2 RETURNING *';
    storeIdempotencyNode.parameters.options = {
      queryReplacement: '={{ $json.idempotency_key }},={{ $json.from }}',
    };
    const after = JSON.stringify(storeIdempotencyNode.parameters);
    if (before !== after) {
      changes.push('Patched Store Idempotency Key to return a row so cart review keeps flowing');
    }
  }

  const ifEmptyCartNode = liveNodesByName['If Empty Cart'];
  if (ifEmptyCartNode) {
    const before = JSON.stringify(ifEmptyCartNode.parameters || {});
    ifEmptyCartNode.parameters = ifEmptyCartNode.parameters || {};
    ifEmptyCartNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'empty-cart',
          leftValue: '={{ !!$json.empty_cart }}',
          rightValue: true,
          operator: {
            type: 'boolean',
            operation: 'equals',
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(ifEmptyCartNode.parameters);
    if (before !== after) {
      changes.push('Patched If Empty Cart to valid IF-v2 condition syntax');
    }
  }

  const formatCartReviewNode = liveNodesByName['Format Cart Review'];
  if (formatCartReviewNode) {
    const before = JSON.stringify(formatCartReviewNode.parameters || {});
    formatCartReviewNode.parameters = formatCartReviewNode.parameters || {};
    formatCartReviewNode.parameters.jsCode = [
      'const cart = $json.session.cart || [];',
      'if (cart.length === 0) {',
      '  return [{ json: { ...$json, empty_cart: true } }];',
      '}',
      'const subtotal = cart.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 1)), 0);',
      "const rawTaxRate = parseFloat($env.TAX_RATE || $('Get Restaurant Config').item.json.tax_rate || '0');",
      'const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate;',
      'const tax = Math.round(subtotal * taxRate);',
      'const total = subtotal + tax;',
      'return [{ json: { ...$json, subtotal, tax, total } }];',
    ].join('\n');
    const after = JSON.stringify(formatCartReviewNode.parameters);
    if (before !== after) {
      changes.push('Patched Format Cart Review to use a safe tax-rate fallback');
    }
  }

  const sendCartReviewNode = liveNodesByName['Send Cart Review'];
  if (sendCartReviewNode) {
    const before = JSON.stringify(sendCartReviewNode.parameters || {});
    sendCartReviewNode.parameters = sendCartReviewNode.parameters || {};
    sendCartReviewNode.parameters.jsonBody =
      '={"messaging_product": "whatsapp", "to": "{{ $(\'Route Action\').item.json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "Review your cart\\n\\n{{ $(\'Format Cart Review\').item.json.session.cart.map(c => c.quantity + \'x \' + c.name).join(\'\\\\n\') }}\\n\\nSubtotal: Rs {{ $(\'Format Cart Review\').item.json.subtotal }}\\nTax: Rs {{ $(\'Format Cart Review\').item.json.tax }}\\nTotal: Rs {{ $(\'Format Cart Review\').item.json.total }}"}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CMD_CONFIRM", "title": "Confirm"}}, {"type": "reply", "reply": {"id": "CMD_CUSTOMISE", "title": "Customise"}}, {"type": "reply", "reply": {"id": "CMD_CLEAR_CART", "title": "Clear Cart"}}]}}}';
    const after = JSON.stringify(sendCartReviewNode.parameters);
    if (before !== after) {
      changes.push('Patched Send Cart Review to use the cart summary context instead of the DB update row');
    }
  }

  const checkOrderErrorNode = liveNodesByName['Check Order Error'];
  if (checkOrderErrorNode) {
    const before = JSON.stringify(checkOrderErrorNode.parameters || {});
    checkOrderErrorNode.parameters = checkOrderErrorNode.parameters || {};
    checkOrderErrorNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'order-error',
          leftValue: '={{ $json.error || "" }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(checkOrderErrorNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Order Error to valid IF-v2 condition syntax');
    }
  }

  const saveOrderNode = liveNodesByName['Save Order to DB'];
  if (saveOrderNode) {
    const before = JSON.stringify(saveOrderNode.parameters || {});
    saveOrderNode.parameters = saveOrderNode.parameters || {};
    saveOrderNode.parameters.options = {
      queryReplacement:
        '={{ $json.order.order_id }},={{ $json.order.table_number }},={{ $json.from }},={{ $json.order.customer_name }},={{ JSON.stringify($json.order.items) }},={{ $json.order.subtotal }},={{ $json.order.tax }},={{ $json.order.total }},order_received,={{ $json.upi_string }}',
    };
    const after = JSON.stringify(saveOrderNode.parameters);
    if (before !== after) {
      changes.push('Patched Save Order to DB to use stable query replacements');
    }
  }

  const prepareOrderNode = liveNodesByName['Prepare Order'];
  if (prepareOrderNode) {
    const before = JSON.stringify(prepareOrderNode.parameters || {});
    prepareOrderNode.parameters = prepareOrderNode.parameters || {};
    prepareOrderNode.parameters.jsCode = [
      'const session = $input.item.json.session || {};',
      'const cart = session.cart || [];',
      'if (cart.length === 0) return [{ json: { ...$input.item.json, error: \'EMPTY_CART\', error_msg: \'Cart is empty. Add items first.\' } }];',
      'if (!session.table_number) return [{ json: { ...$input.item.json, error: \'NO_TABLE\', error_msg: \'Table number not set. Please set your table first.\' } }];',
      'const subtotal = cart.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 1)), 0);',
      "const rawTaxRate = parseFloat($env.TAX_RATE || $('Get Restaurant Config').item.json.tax_rate || '0');",
      'const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate;',
      'const tax = Math.round(subtotal * taxRate);',
      'const total = subtotal + tax;',
      "const orderId = `ORD${Date.now()}`;",
      'const order = { order_id: orderId, table_number: session.table_number, items: cart, subtotal, tax, total, phone: $input.item.json.from, customer_name: session.customer_name };',
      "const upiString = `upi://pay?pa=${$env.UPI_ID}&pn=${encodeURIComponent($env.RESTAURANT_NAME)}&am=${total}&cu=INR&tn=Order%20${orderId}`;",
      'return [{ json: { ...$input.item.json, order, upi_string: upiString } }];',
    ].join('\n');
    const after = JSON.stringify(prepareOrderNode.parameters);
    if (before !== after) {
      changes.push('Patched Prepare Order to use a safe tax-rate fallback');
    }
  }

  const validatePromoNode = liveNodesByName['Validate Promo'];
  if (validatePromoNode) {
    const before = JSON.stringify(validatePromoNode.parameters || {});
    validatePromoNode.parameters = validatePromoNode.parameters || {};
    validatePromoNode.parameters.options = {
      queryReplacement: '={{ $json.promo_code }},={{ $env.TIMEZONE || "Asia/Kolkata" }}',
    };
    const after = JSON.stringify(validatePromoNode.parameters);
    if (before !== after) {
      changes.push('Patched Validate Promo to use a safe timezone fallback');
    }
  }

  const clearCartAfterOrderNode = liveNodesByName['Clear Cart After Order'];
  if (clearCartAfterOrderNode) {
    const before = JSON.stringify(clearCartAfterOrderNode.parameters || {});
    clearCartAfterOrderNode.parameters = clearCartAfterOrderNode.parameters || {};
    clearCartAfterOrderNode.parameters.query =
      "WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1::text))) UPDATE user_sessions SET cart = '[]'::jsonb, last_order = $2::jsonb, last_inbound_at = NOW() WHERE phone = $1 RETURNING *;";
    clearCartAfterOrderNode.parameters.options = {
      queryReplacement:
        '={{ $(\'Prepare Order\').item.json.from }},={{ JSON.stringify($(\'Prepare Order\').item.json.order.items || []) }}',
    };
    const after = JSON.stringify(clearCartAfterOrderNode.parameters);
    if (before !== after) {
      changes.push('Patched Clear Cart After Order to use last_inbound_at');
    }
  }

  const sendOrderConfirmationNode = liveNodesByName['Send Order Confirmation'];
  if (sendOrderConfirmationNode) {
    const before = JSON.stringify(sendOrderConfirmationNode.parameters || {});
    sendOrderConfirmationNode.parameters = sendOrderConfirmationNode.parameters || {};
    sendOrderConfirmationNode.parameters.jsonBody =
      '={"messaging_product": "whatsapp", "to": "{{ $(\'Route Action\').item.json.from }}", "type": "interactive", "interactive": {"type": "button", "body": {"text": "Order created!\\n\\nOrder ID: {{ $(\'Prepare Order\').item.json.order.order_id }}\\nTable: {{ $(\'Prepare Order\').item.json.order.table_number }}\\nTotal: Rs {{ $(\'Prepare Order\').item.json.order.total }}\\n\\nPlease pay at the counter and show this order ID to staff. The kitchen starts preparing the order after payment."}, "action": {"buttons": [{"type": "reply", "reply": {"id": "CANCEL", "title": "Cancel Order"}}]}}}';
    const after = JSON.stringify(sendOrderConfirmationNode.parameters);
    if (before !== after) {
      changes.push('Patched Send Order Confirmation to use the prepared order context instead of the cart-clear row');
    }
  }

  const checkCancelEligibilityNode = liveNodesByName['Check Cancel Eligibility'];
  if (checkCancelEligibilityNode) {
    const before = JSON.stringify(checkCancelEligibilityNode.parameters || {});
    checkCancelEligibilityNode.parameters = checkCancelEligibilityNode.parameters || {};
    checkCancelEligibilityNode.parameters.options = {
      queryReplacement: '={{ $json.from }}',
    };
    const after = JSON.stringify(checkCancelEligibilityNode.parameters);
    if (before !== after) {
      changes.push('Patched Check Cancel Eligibility to use stable query replacements');
    }
  }

  const ifCancelEligibleNode = liveNodesByName['If Cancel Eligible'];
  if (ifCancelEligibleNode) {
    const before = JSON.stringify(ifCancelEligibleNode.parameters || {});
    ifCancelEligibleNode.parameters = ifCancelEligibleNode.parameters || {};
    ifCancelEligibleNode.parameters.conditions = {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 1,
      },
      conditions: [
        {
          id: 'cancel-order-id',
          leftValue: '={{ $json.order_id || "" }}',
          rightValue: '',
          operator: {
            type: 'string',
            operation: 'notEmpty',
            singleValue: true,
          },
        },
      ],
      combinator: 'and',
    };
    const after = JSON.stringify(ifCancelEligibleNode.parameters);
    if (before !== after) {
      changes.push('Patched If Cancel Eligible to valid IF-v2 condition syntax');
    }
  }

  const executeCancelNode = liveNodesByName['Execute Cancel in DB'];
  if (executeCancelNode) {
    const before = JSON.stringify(executeCancelNode.parameters || {});
    executeCancelNode.parameters = executeCancelNode.parameters || {};
    executeCancelNode.parameters.options = {
      queryReplacement: '={{ $json.order_id }}',
    };
    const after = JSON.stringify(executeCancelNode.parameters);
    if (before !== after) {
      changes.push('Patched Execute Cancel in DB to use stable query replacements');
    }
  }

  const executeClearCartNode = liveNodesByName['Execute Clear Cart'];
  if (executeClearCartNode) {
    const before = JSON.stringify(executeClearCartNode.parameters || {});
    executeClearCartNode.parameters = executeClearCartNode.parameters || {};
    executeClearCartNode.parameters.query =
      "WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1::text))) UPDATE user_sessions SET cart = '[]'::jsonb, last_inbound_at = NOW() WHERE phone = $1 RETURNING *;";
    executeClearCartNode.parameters.options = {
      queryReplacement: '={{ $json.from }}',
    };
    const after = JSON.stringify(executeClearCartNode.parameters);
    if (before !== after) {
      changes.push('Patched Execute Clear Cart to use last_inbound_at');
    }
  }

  const writeConsentNode = liveNodesByName['Write Consent to DB'];
  if (writeConsentNode) {
    const before = JSON.stringify(writeConsentNode.parameters || {});
    writeConsentNode.parameters = writeConsentNode.parameters || {};
    writeConsentNode.parameters.query =
      "INSERT INTO user_sessions (phone, consent_given_at, policy_version, cart, last_inbound_at) VALUES ($1, NOW(), $2, '[]'::jsonb, NOW()) ON CONFLICT (phone) DO UPDATE SET consent_given_at = NOW(), policy_version = $2, last_inbound_at = NOW() RETURNING *;";
    writeConsentNode.parameters.options = {
      queryReplacement:
        "={{ $('GDPR Consent Prepare').item.json.from }},={{ $env.PRIVACY_POLICY_VERSION || '1.0' }}",
    };
    const after = JSON.stringify(writeConsentNode.parameters);
    if (before !== after) {
      changes.push('Patched Write Consent to DB to valid upsert SQL');
    }
  }

  const updateItemDbNode = liveNodesByName['Update Item DB'];
  if (updateItemDbNode) {
    const before = JSON.stringify(updateItemDbNode.parameters || {});
    updateItemDbNode.parameters = updateItemDbNode.parameters || {};
    updateItemDbNode.parameters.query =
      "WITH item_idx AS ( SELECT pos - 1 AS idx FROM user_sessions, jsonb_array_elements(cart) WITH ORDINALITY arr(item, pos) WHERE phone = $1 AND COALESCE(item->>'item_code', item->>'code') = $2 LIMIT 1 ) UPDATE user_sessions SET cart = CASE WHEN (SELECT idx FROM item_idx) IS NULL THEN cart WHEN $3::int <= 0 THEN cart - (SELECT idx FROM item_idx)::int ELSE jsonb_set(cart, ARRAY[(SELECT idx FROM item_idx)::text, 'quantity'], to_jsonb($3::int)) END, last_inbound_at = NOW() WHERE phone = $1 RETURNING cart;";
    updateItemDbNode.parameters.options = {
      queryReplacement: '={{ $json.from }},={{ $json.update_item_code }},={{ $json.update_item_qty }}',
    };
    const after = JSON.stringify(updateItemDbNode.parameters);
    if (before !== after) {
      changes.push('Patched Update Item DB to match carts that use item_code');
    }
  }

  for (const connectionName of connectionNamesToCopy) {
    const sourceConnection = sourceWorkflow.connections?.[connectionName];
    if (!sourceConnection) throw new Error(`Source workflow is missing connection: ${connectionName}`);
    const before = JSON.stringify(liveConnections[connectionName] || null);
    liveConnections[connectionName] = clone(sourceConnection);
    const after = JSON.stringify(liveConnections[connectionName]);
    if (before !== after) changes.push(`Restored connection: ${connectionName}`);
  }

  const mapGlobalSettings = liveConnections['Map Global Settings'];
  if (
    !mapGlobalSettings?.main?.[0]?.[0] ||
    mapGlobalSettings.main[0][0].node !== 'Sanitize Input'
  ) {
    liveConnections['Map Global Settings'] = {
      main: [[{ node: 'Sanitize Input', type: 'main', index: 0 }]],
    };
    changes.push('Connected Map Global Settings to Sanitize Input');
  }

  const checkTableError = liveConnections['Check Table Error'];
  if (checkTableError?.main?.[0]?.[0]?.node !== 'Ask Table Number') {
    liveConnections['Check Table Error'] = liveConnections['Check Table Error'] || { main: [[], []] };
    liveConnections['Check Table Error'].main[0] = [
      { node: 'Ask Table Number', type: 'main', index: 0 },
    ];
    liveConnections['Check Table Error'].main[1] = [
      { node: 'Update Session Table', type: 'main', index: 0 },
    ];
    changes.push('Kept table validation errors routed to Ask Table Number');
  }

  const checkTableSet = liveConnections['Check Table Set'];
  const checkTableSetNeedsPatch =
    checkTableSet?.main?.[0]?.[0]?.node !== 'Route Action' ||
    checkTableSet?.main?.[1]?.[0]?.node !== 'Ask Table Number';
  if (checkTableSetNeedsPatch) {
    liveConnections['Check Table Set'] = {
      main: [
        [{ node: 'Route Action', type: 'main', index: 0 }],
        [{ node: 'Ask Table Number', type: 'main', index: 0 }],
      ],
    };
    changes.push('Fixed Check Table Set wiring so existing tables go to Route Action');
  }

  const routeActionConnections = {
    main: [
      [{ node: 'Get Menu from DB', type: 'main', index: 0 }],
      [{ node: 'Format Cart Review', type: 'main', index: 0 }],
      [{ node: 'Prepare Order', type: 'main', index: 0 }],
      [{ node: 'Send Help', type: 'main', index: 0 }],
      [{ node: 'Send Customise Success', type: 'main', index: 0 }],
      [{ node: 'Execute Clear Cart', type: 'main', index: 0 }],
      [{ node: 'Check Cancel Eligibility', type: 'main', index: 0 }],
      [{ node: 'Write Consent to DB', type: 'main', index: 0 }],
      [{ node: 'Send Consent Declined', type: 'main', index: 0 }],
      [{ node: 'Delete User Data', type: 'main', index: 0 }],
      [{ node: 'Extract Update Item', type: 'main', index: 0 }],
      [{ node: 'Repeat Last Order', type: 'main', index: 0 }],
      [{ node: 'Amendment Check', type: 'main', index: 0 }],
      [{ node: 'Extract Promo Code', type: 'main', index: 0 }],
      [{ node: 'Get Menu for AI context', type: 'main', index: 0 }],
      [{ node: 'Send Help', type: 'main', index: 0 }],
    ],
  };
  const routeActionNeedsPatch =
    JSON.stringify(liveConnections['Route Action'] || null) !== JSON.stringify(routeActionConnections);
  if (routeActionNeedsPatch) {
    liveConnections['Route Action'] = routeActionConnections;
    changes.push('Rewired Route Action outputs so confirm places orders and free text reaches the AI order parser');
  }

  if (liveConnections['Ask Table Number'] && liveConnections['Ask Table Number'].main?.[0]?.length) {
    liveConnections['Ask Table Number'] = { main: [[]] };
    changes.push('Kept Ask Table Number terminal');
  }

  const prepareOrderConnection = liveConnections['Prepare Order'];
  if (prepareOrderConnection?.main?.[0]?.[0]?.node !== 'Check Order Error') {
    liveConnections['Prepare Order'] = {
      main: [[{ node: 'Check Order Error', type: 'main', index: 0 }]],
    };
    changes.push('Bypassed the broken Get Prep Time loop from Prepare Order');
  }

  if (liveConnections['Get Prep Time']?.main?.[0]?.[0]?.node === 'Get Prep Time') {
    liveConnections['Get Prep Time'] = { main: [[]] };
    changes.push('Removed the self-loop from Get Prep Time');
  }

  return {
    nodes: JSON.stringify(liveNodes),
    connections: JSON.stringify(liveConnections),
    versionCounter: (liveRow.versionCounter || 0) + (changes.length ? 1 : 0),
    changes,
  };
}

const db = new sqlite3.Database(dbPath);

db.get(
  'SELECT id, name, nodes, connections, versionCounter FROM workflow_entity WHERE id = ?',
  [workflowId],
  (workflowErr, liveRow) => {
    if (workflowErr) throw workflowErr;
    if (!liveRow) throw new Error(`Workflow not found: ${workflowId}`);

    db.get(
      'SELECT workflowData FROM execution_data WHERE executionId = ?',
      [sourceExecutionId],
      (executionErr, executionRow) => {
        if (executionErr) throw executionErr;
        if (!executionRow?.workflowData) {
          throw new Error(`Execution ${sourceExecutionId} does not have workflowData`);
        }

        const sourceWorkflow = JSON.parse(executionRow.workflowData);
        const patched = patchWorkflow(liveRow, sourceWorkflow);

        console.log(`Workflow: ${liveRow.name} (${liveRow.id})`);
        console.log(`Source execution: ${sourceExecutionId}`);
        if (!patched.changes.length) {
          console.log('No DB changes needed.');
          db.close();
          return;
        }

        console.log('Planned changes:');
        for (const change of patched.changes) console.log(`- ${change}`);

        if (!apply) {
          console.log('Dry run only. Re-run with --apply to write changes.');
          db.close();
          return;
        }

        fs.copyFileSync(dbPath, backupPath);
        console.log(`Backup written: ${backupPath}`);

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          db.run(
            "UPDATE workflow_entity SET nodes = ?, connections = ?, versionCounter = ?, updatedAt = STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW') WHERE id = ?",
            [patched.nodes, patched.connections, patched.versionCounter, liveRow.id],
            (updateErr) => {
              if (updateErr) {
                console.error(updateErr);
                db.run('ROLLBACK', () => db.close());
                process.exitCode = 1;
                return;
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error(commitErr);
                  db.close();
                  process.exitCode = 1;
                  return;
                }
                console.log('Patch committed.');
                db.close();
              });
            },
          );
        });
      },
    );
  },
);
