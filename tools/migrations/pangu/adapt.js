const fs = require('fs');
const path = 'src/main.ts';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
const out = [];
let skipping = false;
for (const line of lines) {
  if (line.includes('bindAutomaticSpacing')) { continue; }
  if (line.includes('const syncEditors = () => {')) { skipping = true; continue; }
  if (skipping) {
    if (line.includes('onLayoutReady(syncEditors)')) { skipping = false; }
    continue;
  }
  if (line.includes('layout-change') && line.includes('syncEditors')) { continue; }
  out.push(line);
}
fs.writeFileSync(path, out.join('\n'));
const text = out.join('\n');
console.log('syncEditors removed:', !text.includes('syncEditors'));
console.log('import removed:', !text.includes('bindAutomaticSpacing'));
