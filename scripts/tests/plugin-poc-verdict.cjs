#!/usr/bin/env node
// M0 门禁 2/2：把真机 PoC 结果 JSON 判成一条路线结论。
// 用法：node scripts/tests/plugin-poc-verdict.cjs [results.json]
// 退出码：0=可推进 A 轨 / 1=需降级（见输出）/ 2=数据不完整，不能决策。
const fs = require('node:fs');
const path = require('node:path');

const THRESHOLDS = {
  ime: { p95LatencyMs: 50, compositionErrors: 0 },
  doc: { openMs: 800, typingP95Ms: 50 },
  residency: { pluginCount: 8, extraMemoryMB: 60 },
  rpc: { p95Ms: 8 },
};

const file = process.argv[2] || path.resolve(__dirname, 'fixtures/poc-results.sample.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

function at(obj, key) {
  const v = obj && obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
const rows = [];
let missing = 0;
function check(scope, key, actual, limit, cmp) {
  if (actual === null) { missing++; rows.push([scope + '.' + key, String(limit), '未测', '—', 'MISSING']); return false; }
  const pass = cmp === '<=' ? actual <= limit : actual === limit;
  const margin = cmp === '<=' ? (limit - actual) : (limit - actual);
  rows.push([scope + '.' + key, String(limit), String(actual), margin.toFixed(1), pass ? 'PASS' : 'FAIL']);
  return pass;
}

const ime = data.ime || {};
const doc = data.doc || {};
const res = data.residency || {};
const rpc = data.rpc || {};

const okIme = [
  check('ime', 'p95LatencyMs', at(ime, 'p95LatencyMs'), THRESHOLDS.ime.p95LatencyMs, '<='),
  check('ime', 'compositionErrors', at(ime, 'compositionErrors'), THRESHOLDS.ime.compositionErrors, '=='),
].every(Boolean);
const okDoc = [
  check('doc', 'openMs', at(doc, 'openMs'), THRESHOLDS.doc.openMs, '<='),
  check('doc', 'typingP95Ms', at(doc, 'typingP95Ms'), THRESHOLDS.doc.typingP95Ms, '<='),
].every(Boolean);
const okRes = [
  check('residency', 'extraMemoryMB', at(res, 'extraMemoryMB'), THRESHOLDS.residency.extraMemoryMB, '<='),
].every(Boolean);
const okCount = check('residency', 'pluginCount', at(res, 'pluginCount'), THRESHOLDS.residency.pluginCount, '==');
const okRpc = check('rpc', 'p95Ms', at(rpc, 'p95Ms'), THRESHOLDS.rpc.p95Ms, '<=');

const pad = (s, n) => String(s).padEnd(n);
console.log('M0 判定  ' + file);
console.log(pad('指标', 26) + pad('阈值', 8) + pad('实测', 10) + pad('余量', 8) + '判定');
for (const r of rows) console.log(pad(r[0], 26) + pad(r[1], 8) + pad(r[2], 10) + pad(r[3], 8) + r[4]);

if (missing) {
  console.log('\n✗ 有 ' + missing + ' 项未测，PoC 不完整，不能决策（退出码 2）');
  process.exit(2);
}

const blockers = [];
if (!okIme) blockers.push('中文 IME 不达标 → 编辑器不能进 Web：A 轨降级，「工作区/面板/视图/主题」Web 化，编辑器留 ArkUI');
if (!okDoc) blockers.push('大文档不达标 → 同上降级为 A-lite，并对 200KB 以上文档走原生编辑');
if (!okCount || !okRes) blockers.push('常驻不达标 → 引入插件池上限与按需装载，M1 需加池化验收项');
const rpcNote = okRpc ? '' : '（RPC 时延未达标：先做通道批处理与事件合并后复测，此项不否决路线）';

if (blockers.length) {
  console.log('\n✗ 结论：不满足 A 全量条件');
  for (const b of blockers) console.log('  - ' + b);
  if (rpcNote) console.log('  ' + rpcNote);
  process.exit(1);
}
console.log('\n✓ 结论：A 全量轨可推进（编辑器+工作区搬入常驻 ArkWeb 页）' + rpcNote);
process.exit(0);
