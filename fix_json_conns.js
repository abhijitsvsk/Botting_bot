const fs = require('fs');
const file = 'restaurant_bot_ENDGAME_VERSION.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodeNames = new Set(json.nodes.map(n => n.name));

const cleanConnections = {};
for (const [srcNode, outputs] of Object.entries(json.connections)) {
  if (!nodeNames.has(srcNode)) {
    console.log(`Removed connection FROM missing node: "${srcNode}"`);
    continue;
  }
  const cleanOutputs = {};
  for (const [outputType, outputIndices] of Object.entries(outputs)) {
    const cleanIndices = outputIndices.map(conns =>
      conns.filter(c => {
        if (!nodeNames.has(c.node)) {
          console.log(`Removed connection TO missing node: "${c.node}" (from "${srcNode}")`);
          return false;
        }
        return true;
      })
    );
    cleanOutputs[outputType] = cleanIndices;
  }
  cleanConnections[srcNode] = cleanOutputs;
}
json.connections = cleanConnections;
fs.writeFileSync(file, JSON.stringify(json, null, 2));
console.log('JSON source file cleaned');
