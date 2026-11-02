#!/usr/bin/env node
// M0 门禁 1/2：插件通道双向对账。
// 规则：shim 侧 hostCall('x') 的每条 x 必须在宿主 registerHandler('x') 中存在。
// 有调用无处理器 = 死通道（插件运行到一半静默失败）→ 退出码 1。
// 有处理器无静态调用 = 孤儿（可能走动态分派，仅提示）。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const rawfile = path.join(root, 'entry/src/main/resources/rawfile');
const etsRoot = path.join(root, 'entry/src/main/ets');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc); } else acc.push(p);
  }
  return acc;
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

const shimFiles = ['lexinote_plugin_shim.js', 'lexinote_plugin_view_shim.js']
  .map((f) => path.join(rawfile, f)).filter((f) => fs.existsSync(f));

const called = new Map();
const dynamic = [];
// 动态分派入口：方法名以字符串字面量出现但不在hostCall/registerHandler调用位上（如 EditorProxy._apply('editor.replace')）。
const literalNames = new Map();
for (const f of shimFiles) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  const literal = /hostCall\(\s*'([^']+)'/g;
  while ((m = literal.exec(src))) {
    const at = rel(f) + ':' + lineOf(src, m.index);
    if (!called.has(m[1])) called.set(m[1], []);
    called.get(m[1]).push(at);
  }
  const quoted = /'([a-z][\w.]*\.[\w.]+)'/g;
  while ((m = quoted.exec(src))) {
    const at = rel(f) + ':' + lineOf(src, m.index);
    if (!literalNames.has(m[1])) literalNames.set(m[1], at);
  }
  const dyn = /hostCall\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = dyn.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/function\s+hostCall/.test(src.slice(lineStart, m.index + 20))) continue; // hostCall 定义本身
    dynamic.push(rel(f) + ':' + lineOf(src, m.index) + ' hostCall(' + m[1] + ')');
  }
}

const handlers = new Map();
for (const f of walk(etsRoot).filter((p) => /\.(ets|ts)$/.test(p))) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  const re = /registerHandler\(\s*'([^']+)'/g;
  while ((m = re.exec(src))) {
    const at = rel(f) + ':' + lineOf(src, m.index);
    if (!handlers.has(m[1])) handlers.set(m[1], []);
    handlers.get(m[1]).push(at);
  }
}

const dead = [...called.keys()].filter((k) => !handlers.has(k)).sort();
const orphan = [...handlers.keys()].filter((k) => !called.has(k)).sort();

console.log('通道对账：shim 调用 ' + called.size + ' 条 / 宿主处理器 ' + handlers.size + ' 条');
console.log('动态分派调用点 ' + dynamic.length + ' 处（静态无法判定，不参与死通道判定）');
for (const d of dynamic) console.log('  ~ ' + d);

if (dead.length) {
  console.log('\n✗ 死通道 ' + dead.length + ' 条（宿主无处理器，插件调用必然失败）：');
  for (const k of dead) console.log('  - ' + k + '  ← ' + called.get(k).join(', '));
} else {
  console.log('\n✓ 死通道 0 条');
}
const dispatchEntries = orphan.filter((k) => literalNames.has(k));
const companions = orphan.filter((k) => !literalNames.has(k));
if (dispatchEntries.length) {
  console.log('\n· 动态分派入口 ' + dispatchEntries.length + ' 条（静态无 hostCall 调用位，由 shim 内字符串分派到达，不计失败）：');
  for (const k of dispatchEntries) {
    console.log('  - ' + k + '  @ ' + handlers.get(k)[0] + '  ← 字面量 ' + literalNames.get(k));
  }
}
if (companions.length) {
  console.log('\n· 未调用处理器 ' + companions.length + ' 条（保留能力，不计失败）：');
  for (const k of companions) console.log('  - ' + k + '  @ ' + handlers.get(k)[0]);
}

process.exit(dead.length ? 1 : 0);
