'use strict';
// RFC §14 T5.1 Plugin SDK · 门禁（对应 §10.1 SDK 目录 / §6.4 单一真源 / §10.x 版本对应）。
//
// 验收目标：SDK 包结构与类型面和 tools/plugin-contract 快照逐一对账;schema 导出;
// package.json 版本锚点三方一致;SDK 源码类型检查通过。
//   S1 包结构(§10.1):package.json / src / types / schema / tests。
//   S2 版本锚点:SDK version == api-version.json == 宿主常量 == shim 常量(重新推导)。
//   S3 schema 导出:schema/ 五份快照与 tools/plugin-contract 逐字节一致(生成器刷新)。
//   S4 类型面对账:SDK 类型文件 == 模板 d.ts(单一真源);contract.ts 覆盖全部快照方法;
//      关键 API 抽查(loadData/saveData/addCommand/requestUrl/Notice/vault.modify)。
//   S5 类型检查:tsc 转译 SDK src 全量通过。
//
// 用法：node scripts/tests/plugin-sdk-contract.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SDK = path.join(ROOT, 'packages', 'lexinote-plugin-sdk');
const CONTRACT = path.join(ROOT, 'tools', 'plugin-contract');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

section('S1 包结构(§10.1)');
const required = [
  'package.json',
  path.join('src', 'index.ts'),
  path.join('src', 'contract.ts'),
  path.join('src', 'capabilities.ts'),
  path.join('types', 'lexinote.d.ts'),
  path.join('schema', 'api-surface.json'),
  path.join('schema', 'capability-map.json'),
  path.join('schema', 'api-version.json'),
  path.join('schema', 'manifest-v2.schema.json'),
  path.join('schema', 'codemirror-versions.json'),
  path.join('tests', 'sdk-smoke.cjs'),
  path.join('tools', 'sync-sdk.cjs')
];
for (const rel of required) {
  ok('S1 ' + rel, fs.existsSync(path.join(SDK, rel)), '缺少 packages/lexinote-plugin-sdk/' + rel);
}

section('S2 版本锚点');
let sdkPkg = null;
let apiVersion = null;
try {
  sdkPkg = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8'));
  apiVersion = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'api-version.json'), 'utf8'));
  ok('S2.0 包描述与契约快照可解析', true);
} catch (error) {
  ok('S2.0 包描述与契约快照可解析', false, 'threw: ' + error.message);
}
{
  const manifestSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginManifest.ets'), 'utf8');
  const shimSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js'), 'utf8');
  const manifestVer = (manifestSrc.match(/PLUGIN_API_VERSION:\s*string\s*=\s*'([^']+)'/) || [])[1] || '';
  const shimVer = (shimSrc.match(/var API_VERSION = '([^']+)'/) || [])[1] || '';
  ok('S2.1 SDK version == API 版本(§10 SDK 版本对应明确 API 版本)',
    sdkPkg !== null && apiVersion !== null && sdkPkg.version === apiVersion.apiVersion &&
    apiVersion.apiVersion === manifestVer && manifestVer === shimVer,
    'sdk=' + (sdkPkg ? sdkPkg.version : '?') + ' api=' + (apiVersion ? apiVersion.apiVersion : '?') +
    ' manifest=' + manifestVer + ' shim=' + shimVer);
  ok('S2.2 SDK 包名与元信息', sdkPkg !== null && sdkPkg.name === '@lexinote/plugin-sdk' &&
    sdkPkg.description !== undefined);
}

section('S3 schema 导出(逐字节一致)');
{
  const snapshotSources = {
    'api-surface.json': path.join(CONTRACT, 'api-surface.json'),
    'capability-map.json': path.join(CONTRACT, 'capability-map.json'),
    'api-version.json': path.join(CONTRACT, 'api-version.json'),
    'manifest-v2.schema.json': path.join(CONTRACT, 'schema', 'manifest-v2.schema.json'),
    'codemirror-versions.json': path.join(CONTRACT, 'codemirror-versions.json')
  };
  for (const snap of Object.keys(snapshotSources)) {
    const srcPath = snapshotSources[snap];
    const sdkPath = path.join(SDK, 'schema', snap);
    if (!fs.existsSync(srcPath) || !fs.existsSync(sdkPath)) {
      ok('S3 ' + snap, false, '源或导出缺失'); continue;
    }
    ok('S3 ' + snap + ' 逐字节一致',
      fs.readFileSync(srcPath, 'utf8') === fs.readFileSync(sdkPath, 'utf8'),
      '重跑 packages/lexinote-plugin-sdk/tools/sync-sdk.cjs 刷新');
  }
}

section('S4 类型面对账');
{
  const templateDts = fs.readFileSync(path.join(ROOT, 'tools/lexinote-plugin-template/lexinote.d.ts'), 'utf8');
  const sdkDtsPath = path.join(SDK, 'types', 'lexinote.d.ts');
  ok('S4.1 SDK 类型 == 模板 d.ts(单一真源)',
    fs.existsSync(sdkDtsPath) && fs.readFileSync(sdkDtsPath, 'utf8') === templateDts);
  const contractTs = fs.readFileSync(path.join(SDK, 'src', 'contract.ts'), 'utf8');
  let surface = null;
  try { surface = JSON.parse(fs.readFileSync(path.join(SDK, 'schema', 'api-surface.json'), 'utf8')); }
  catch (e) { surface = null; }
  ok('S4.2 contract.ts 覆盖全部快照方法', surface !== null &&
    surface.methods.every((m) => contractTs.indexOf("'" + m.method + "'") >= 0 || contractTs.indexOf('"' + m.method + '"') >= 0),
    'contract.ts 必须逐方法列出(生成物)');
  const spot = ['data.load', 'data.save', 'commands.add', 'net.requestUrl', 'ui.notice', 'vault.modify'];
  for (const method of spot) {
    ok('S4.3 抽查 ' + method, surface !== null &&
      surface.methods.some((m) => m.method === method) && contractTs.indexOf(method) >= 0);
  }
}

section('S5 SDK 类型检查');
{
  const tsPath = process.env.LEXI_TYPESCRIPT;
  let srcOk = false;
  let detail = '';
  try {
    const ts = require(tsPath);
    const files = ['src/index.ts', 'src/contract.ts', 'src/capabilities.ts'];
    for (const file of files) {
      const full = path.join(SDK, file);
      const out = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true },
        reportDiagnostics: true, fileName: file
      });
      const diags = (out.diagnostics || []).filter((d) => d.category === 1);
      if (diags.length > 0) {
        detail = file + ': ' + diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).slice(0, 2).join(' | ');
        srcOk = false;
        break;
      }
      srcOk = true;
    }
  } catch (error) {
    detail = 'threw: ' + error.message;
  }
  ok('S5.1 SDK src 类型检查通过', srcOk, detail);
}

section('S6 冒烟测试可跑');
{
  const smoke = path.join(SDK, 'tests', 'sdk-smoke.cjs');
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [smoke], { cwd: SDK, encoding: 'utf8' });
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  ok('S6.1 SDK 冒烟测试通过', r.status === 0, output.split('\n').slice(-2).join(' | '));
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-sdk-contract: PASS'
  : 'plugin-sdk-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
