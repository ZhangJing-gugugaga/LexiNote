#!/usr/bin/env node
// RFC §6.4/§10.1 · SDK 导出物同步生成器。
// 单一真源 = 宿主代码 + tools/plugin-contract 快照:
//   - schema/*.json   ← tools/plugin-contract(逐字节拷贝)
//   - types/lexinote.d.ts ← tools/lexinote-plugin-template/lexinote.d.ts(逐字节拷贝)
//   - src/contract.ts ← api-surface.json(生成:API_VERSION + 方法表)
// 契约漂移时重跑本脚本;门禁 plugin-sdk-contract.cjs 对账。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SDK = path.resolve(__dirname, '..');
const CONTRACT = path.resolve(SDK, '..', '..', 'tools', 'plugin-contract');
const TEMPLATE_DTS = path.resolve(SDK, '..', '..', 'tools', 'lexinote-plugin-template', 'lexinote.d.ts');

const SNAPSHOT_SOURCES = {
  'api-surface.json': path.join(CONTRACT, 'api-surface.json'),
  'capability-map.json': path.join(CONTRACT, 'capability-map.json'),
  'api-version.json': path.join(CONTRACT, 'api-version.json'),
  'manifest-v2.schema.json': path.join(CONTRACT, 'schema', 'manifest-v2.schema.json'),
  'codemirror-versions.json': path.join(CONTRACT, 'codemirror-versions.json')
};
for (const snap of Object.keys(SNAPSHOT_SOURCES)) {
  fs.copyFileSync(SNAPSHOT_SOURCES[snap], path.join(SDK, 'schema', snap));
}
fs.copyFileSync(TEMPLATE_DTS, path.join(SDK, 'types', 'lexinote.d.ts'));

const surface = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'api-surface.json'), 'utf8'));
const apiVersion = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'api-version.json'), 'utf8'));
const methodLines = surface.methods.map((m) =>
  "  { method: '" + m.method + "', domain: '" + m.domain + "', kind: '" + m.kind + "', status: '" + m.status + "' },");
const contract = [
  '// 由 tools/sync-sdk.cjs 生成 —— 勿手改;真源: tools/plugin-contract/api-surface.json。',
  '/** SDK/插件 API 版本(与宿主 PLUGIN_API_VERSION、shim API_VERSION 三方一致)。 */',
  "export const API_VERSION = '" + apiVersion.apiVersion + "';",
  '',
  '/** 宿主 RPC 方法契约(生成自 api-surface.json;kind 见 capability-map.json)。 */',
  'export interface SdkMethodEntry {',
  '  method: string;',
  "  domain: 'app' | 'vault' | 'metadata' | 'workspace' | 'editor' | 'commands' | 'events' | 'storage' | 'ui' | 'network' | 'plugin' | 'markdown' | 'theme' | 'internal';",
  "  kind: string;",
  "  status: 'stable' | 'experimental' | 'deprecated' | 'removed';",
  '}',
  '',
  'export const SDK_METHODS: SdkMethodEntry[] = [',
  methodLines.join('\n'),
  '];',
  '',
  '/** 按域取方法(开发者发现面)。 */',
  'export function methodsOf(domain: string): SdkMethodEntry[] {',
  '  return SDK_METHODS.filter((m) => m.domain === domain);',
  '}',
  ''
].join('\n');
fs.writeFileSync(path.join(SDK, 'src', 'contract.ts'), contract);
console.log('SDK 导出物已同步: methods=' + surface.methods.length + ' apiVersion=' + apiVersion.apiVersion);
