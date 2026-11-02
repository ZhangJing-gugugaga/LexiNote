'use strict';
// SDK 冒烟:契约常量与快照一致、能力标签助手语义正确。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SDK = path.resolve(__dirname, '..');
const surface = JSON.parse(fs.readFileSync(path.join(SDK, 'schema', 'api-surface.json'), 'utf8'));
const contractSrc = fs.readFileSync(path.join(SDK, 'src', 'contract.ts'), 'utf8');
assert.equal(contractSrc.includes("API_VERSION = '" + surface.apiVersion + "'"), true, 'API_VERSION 锚点');
for (const m of surface.methods) { assert.ok(contractSrc.includes(m.method), '缺方法 ' + m.method); }

// capabilities.ts 语义(经 ts 转译求值)
const tsPath = process.env.LEXI_TYPESCRIPT;
if (tsPath) {
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(path.join(SDK, 'src', 'capabilities.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + js + '\n})')(
    () => {}, mod, mod.exports);
  const tags = mod.exports.capabilityTags({
    vault: { write: { enabled: true } },
    network: { origins: ['https://API.example.com/path'] },
    clipboard: { read: true }
  });
  assert.deepEqual(tags, ['clipboard', 'network:api.example.com', 'vault.write']);
  assert.deepEqual(mod.exports.capabilityTags({}), []);
}
console.log('sdk-smoke: PASS (' + surface.methods.length + ' methods)');
