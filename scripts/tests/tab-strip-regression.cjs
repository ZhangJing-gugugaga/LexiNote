const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const file = path.resolve(__dirname, '../../entry/src/main/ets/core/LexiTabStripLayout.ets');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
vm.runInThisContext('(function(module,exports){' + js + '\n})')(mod, mod.exports);
const layout = mod.exports.LexiTabStripLayout;
assert.equal(layout.tabWidth(1000, 1), 196);
assert.equal(layout.contentWidth(1000, 0), 0);
for (const viewport of [240, 320, 420, 640, 1024, 1500]) {
  let previous = Infinity;
  for (let count = 1; count <= 100; count++) {
    const width = layout.tabWidth(viewport, count);
    assert.ok(width >= 104 && width <= 196 && width <= previous);
    previous = width;
    const content = layout.contentWidth(viewport, count);
    if (width > 104) { assert.ok(content <= viewport + 0.001); }
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      for (const current of [0, 25, 10000]) {
        const offset = layout.revealOffset(viewport, count, index, current);
        const left = index * (width + 3);
        assert.ok(offset >= 0 && offset <= Math.max(0, content - viewport));
        assert.ok(left >= offset - 0.001 && left + width <= offset + viewport + 0.001,
          `selected tab must be visible: viewport=${viewport}, count=${count}, index=${index}`);
      }
    }
  }
}
assert.equal(layout.revealOffset(500, 10, 4, 200), 200, 'leave manually scrolled visible tabs in place');
assert.equal(layout.revealOffset(1000, 2, 1, 1200), 0, 'closing tabs or widening the window clamps the old offset');
console.log('PASS adaptive tab widths and active-tab visibility across tablet/desktop widths and 1–100 tabs');
