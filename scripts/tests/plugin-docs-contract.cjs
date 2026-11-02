'use strict';
// RFC §14 T5.4 文档 · 门禁（对应 §10.4 文档对账）。
//
// 验收目标：外部开发者不修改主仓库即可完成开发/测试/打包/提交——文档与实现逐项对账。
//   D1 八篇文档在库(docs/ 为本地账面,不入 git——仓库惯例)。
//   D2 API 参考逐方法覆盖 stable 面(生成物,真源 api-surface.json)。
//   D3 各篇与实现锚点对账(manifest v2 规则/安全错误码/信任链/隐私边界)。
//   D4 桥接规范(lexinote_plugin_bridge_spec)在库。
//
// 用法：node scripts/tests/plugin-docs-contract.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

section('D1 文档在库');
const docs = ['plugin-api-reference.md', 'plugin-manifest-v2.md', 'plugin-security.md',
  'plugin-marketplace.md', 'plugin-development.md', 'plugin-testing.md',
  'obsidian-compatibility.md', 'plugin-inspector.md'];
for (const doc of docs) {
  ok('D1 ' + doc, fs.existsSync(path.join(DOCS, doc)), '缺少 docs/' + doc);
}

section('D2 API 参考覆盖');
{
  const reference = fs.existsSync(path.join(DOCS, 'plugin-api-reference.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-api-reference.md'), 'utf8') : '';
  let surface = null;
  try { surface = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/plugin-contract/api-surface.json'), 'utf8')); }
  catch (e) { surface = null; }
  ok('D2.1 契约快照可解析', surface !== null);
  if (surface !== null) {
    const stable = surface.methods.filter((m) => m.status === 'stable');
    const missing = stable.filter((m) => reference.indexOf('`' + m.method + '`') < 0);
    ok('D2.2 全部 stable 方法入文档(' + stable.length + ' 条)', missing.length === 0,
      '缺: ' + missing.slice(0, 6).map((m) => m.method).join(', '));
    const domains = Object.keys(byDomainOf(surface));
    const missingDomains = domains.filter((d) => reference.indexOf('## ' + d) < 0);
    ok('D2.3 域分节齐备', missingDomains.length === 0, '缺: ' + missingDomains.join(', '));
  }
}
function byDomainOf(surface) {
  const map = {};
  for (const m of surface.methods) { map[m.domain] = true; }
  return map;
}

section('D3 实现锚点对账');
{
  const manifestDoc = fs.existsSync(path.join(DOCS, 'plugin-manifest-v2.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-manifest-v2.md'), 'utf8') : '';
  ok('D3.1 manifest v2 文档覆盖关键规则', /manifestVersion/.test(manifestDoc) &&
    /capabilities/.test(manifestDoc) && /sha256/.test(manifestDoc) &&
    /legacyProfile|legacy/.test(manifestDoc));
  const securityDoc = fs.existsSync(path.join(DOCS, 'plugin-security.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-security.md'), 'utf8') : '';
  ok('D3.2 安全文档覆盖错误码与信任链', /ERR_PERMISSION_DENIED/.test(securityDoc) &&
    /ERR_SIGNATURE_INVALID/.test(securityDoc) && /root/.test(securityDoc) &&
    /targets/.test(securityDoc));
  const marketplaceDoc = fs.existsSync(path.join(DOCS, 'plugin-marketplace.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-marketplace.md'), 'utf8') : '';
  ok('D3.3 市场文档覆盖 targets 与撤销', /targets/.test(marketplaceDoc) && /撤销/.test(marketplaceDoc));
  const inspectorDoc = fs.existsSync(path.join(DOCS, 'plugin-inspector.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-inspector.md'), 'utf8') : '';
  ok('D3.4 Inspector 文档声明隐私边界', /session token/.test(inspectorDoc) || /token/.test(inspectorDoc));
  const devDoc = fs.existsSync(path.join(DOCS, 'plugin-development.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-development.md'), 'utf8') : '';
  ok('D3.5 开发指南覆盖 CLI 三命令与乐观锁', /lexi plugin create/.test(devDoc) &&
    /lexi plugin validate/.test(devDoc) && /vault_conflict/.test(devDoc));
}

section('D4 桥接规范');
ok('D4.1 lexinote_plugin_bridge_spec 在库', fs.existsSync(path.join(DOCS, 'lexinote_plugin_bridge_spec.md')));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-docs-contract: PASS'
  : 'plugin-docs-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
