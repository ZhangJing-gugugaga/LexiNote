#!/usr/bin/env node
// 一次性迁移:把还留在 exports/cdn-market.json 里的 ZCode 形状索引改成显式 deprecated 包装。
// 客户端只接受 schemaVersion=1 的单一索引(tools/plugin-dist/market-index-v1.cjs),旧的 ZCode
// 数据不再被读取,但原件不丢:整体放进 deprecated 包装的 legacy 字段里,便于追溯。
//
//   node tools/plugin-dist/deprecate-zcode-market.cjs [--file exports/cdn-market.json] [--dry-run]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const target = path.resolve(REPO, arg('--file', path.join('exports', 'cdn-market.json')));
const dryRun = argv.indexOf('--dry-run') >= 0;

if (!fs.existsSync(target)) {
  console.log('skip: 文件不存在 ' + target);
  process.exit(0);
}
const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
if (raw && raw.deprecated === true) {
  console.log('already deprecated: ' + target);
  process.exit(0);
}
const wrapped = {
  schemaVersion: 0,
  deprecated: true,
  deprecatedReason: 'ZCode 形状索引已停用：客户端只接受 schemaVersion=1 的单一索引，旧格式会被 legacy_zcode_rejected 拒绝',
  replacement: 'exports/market-index-v1.json',
  pluginCount: Array.isArray(raw.plugins) ? raw.plugins.length : 0,
  legacy: raw
};
const text = JSON.stringify(wrapped, null, 2) + '\n';
if (dryRun) {
  console.log('dry-run: 会写入 ' + target + '（' + Buffer.byteLength(text) + ' 字节，legacy 保留 ' + wrapped.pluginCount + ' 条）');
  process.exit(0);
}
fs.writeFileSync(target, text);
console.log('deprecated: ' + target + '（legacy 保留 ' + wrapped.pluginCount + ' 条）');
