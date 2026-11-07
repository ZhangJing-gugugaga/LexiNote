#!/usr/bin/env node
// RFC §6.4/§10.1 · SDK 导出物同步生成器。
// 单一真源 = 宿主代码 + tools/plugin-contract 快照 + 本包类型面(P3-002 方向已翻转):
//   - schema/*.json   ← tools/plugin-contract(逐字节拷贝)
//   - src/contract.ts ← api-surface.json(生成:API_VERSION + 方法表)
//   - tools/lexinote-plugin-template/lexinote.d.ts ← 本包 types/lexinote.d.ts(逐字节拷贝)
//     类型声明单一真源在 SDK:模板不再维护类型副本,只消费这里的生成副本(勿手改);
//     改类型面 = 改 packages/lexinote-plugin-sdk/types/lexinote.d.ts 后重跑本脚本。
// 契约漂移时重跑本脚本;门禁 plugin-sdk-contract.cjs S3/S4 对账。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SDK = path.resolve(__dirname, '..');
const CONTRACT = path.resolve(SDK, '..', '..', 'tools', 'plugin-contract');
const TEMPLATE_DTS = path.resolve(SDK, '..', '..', 'tools', 'lexinote-plugin-template', 'lexinote.d.ts');
const SDK_TYPES_DTS = path.join(SDK, 'types', 'lexinote.d.ts');

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
if (!fs.existsSync(SDK_TYPES_DTS)) {
  throw new Error('types/lexinote.d.ts 缺失 —— SDK 是类型单一真源,不可由模板反推(先恢复 packages/lexinote-plugin-sdk/types/lexinote.d.ts)');
}
fs.copyFileSync(SDK_TYPES_DTS, TEMPLATE_DTS);

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
console.log('SDK 导出物已同步: methods=' + surface.methods.length + ' apiVersion=' + apiVersion.apiVersion +
  ' 模板类型副本←SDK(types/lexinote.d.ts 为单一真源,P3-002)');
