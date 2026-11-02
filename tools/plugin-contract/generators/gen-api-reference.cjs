#!/usr/bin/env node
// RFC §14 T5.4 · API 参考文档生成器(单一真源:api-surface.json)。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const surface = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/plugin-contract/api-surface.json'), 'utf8'));
const apiVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/plugin-contract/api-version.json'), 'utf8'));
const byDomain = {};
for (const m of surface.methods) { (byDomain[m.domain] = byDomain[m.domain] || []).push(m); }
const lines = [
  '# LexiNote 插件 API 参考（自动生成）', '',
  '> 生成器：`tools/plugin-contract/generators/gen-api-reference.cjs`；真源：`tools/plugin-contract/api-surface.json`。勿手改本文件。',
  '> API 版本：**' + apiVersion.apiVersion + '**（与宿主 PLUGIN_API_VERSION / shim API_VERSION 三方一致，门禁钉死）。', '',
  'kind 为授权矩阵类别（见 `capability-map.json` 与 `LexiPermissionBroker`）；roles 为允许角色。', ''
];
for (const domain of Object.keys(byDomain).sort()) {
  lines.push('## ' + domain, '');
  lines.push('| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of byDomain[domain]) {
    lines.push('| `' + m.method + '` | ' + m.kind + ' | ' + m.roles.join('/') + ' | ' + m.status +
      ' | ' + (m.hostHandler ? '✓' : '') + ' | ' + (m.bridge ? '✓' : '') + ' |');
  }
  lines.push('');
}
fs.writeFileSync(path.join(ROOT, 'docs', 'plugin-api-reference.md'), lines.join('\n') + '\n');
console.log('docs/plugin-api-reference.md 生成: methods=' + surface.methods.length);
