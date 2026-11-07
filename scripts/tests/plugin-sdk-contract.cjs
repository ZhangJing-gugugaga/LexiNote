'use strict';
// RFC §14 T5.1 Plugin SDK · 门禁（对应 §10.1 SDK 目录 / §6.4 单一真源 / §10.x 版本对应）。
//
// 验收目标：SDK 包结构与类型面和 tools/plugin-contract 快照逐一对账;schema 导出;
// package.json 版本锚点三方一致;SDK 源码真类型检查通过(注入类型错误必须红)。
//   S1 包结构(§10.1):package.json / src / types / schema / tests。
//   S2 版本锚点:SDK version == api-version.json == 宿主常量 == shim 常量(重新推导)。
//   S3 schema 导出:schema/ 五份快照与 tools/plugin-contract 逐字节一致(生成器刷新)。
//   S4 类型面对账(P3-002:SDK 为类型单一真源,模板消费生成副本):模板 d.ts == SDK
//      types/lexinote.d.ts 逐字节(同源对账);contract.ts 覆盖全部快照方法;
//      关键 API 抽查(loadData/saveData/addCommand/requestUrl/Notice/vault.modify)。
//   S5 SDK 源码真类型检查(P3-003):ts.createProgram 严格类型检查(非仅语法转译);
//      负例:向 SDK src 临时副本注入类型错误,检查器必须报红。
//
// 用法：node scripts/tests/plugin-sdk-contract.cjs
// 依赖：LEXI_TYPESCRIPT(缺省时回落到 build-dist.cjs 同列候选)

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

section('S4 类型面对账(P3-002:SDK 为单一真源,模板消费生成副本)');
{
  const templateDts = fs.readFileSync(path.join(ROOT, 'tools/lexinote-plugin-template/lexinote.d.ts'), 'utf8');
  const sdkDtsPath = path.join(SDK, 'types', 'lexinote.d.ts');
  ok('S4.1 模板 d.ts == SDK types/lexinote.d.ts(逐字节同源对账;单一真源=SDK)',
    fs.existsSync(sdkDtsPath) && fs.readFileSync(sdkDtsPath, 'utf8') === templateDts,
    '模板副本漂移 —— 勿手改 tools/lexinote-plugin-template/lexinote.d.ts;改 packages/lexinote-plugin-sdk/types/lexinote.d.ts 后重跑 tools/sync-sdk.cjs');
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

section('S5 SDK 源码真类型检查(P3-003:createProgram 严格类型检查,非仅语法转译)');
{
  // 与 tools/build-dist.cjs 同一候选列(仓库惯例:各门禁各自解析,候选一致即可)。
  const TYPESCRIPT_CANDIDATES = [
    process.env.LEXI_TYPESCRIPT,
    path.join(SDK, '..', '..', 'node_modules', 'typescript'),
    'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
    '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript',
    'C:/Program Files/Huawei/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript'
  ];
  let ts = null;
  for (const candidate of TYPESCRIPT_CANDIDATES) {
    if (!candidate) { continue; }
    try { ts = require(candidate); break; } catch (error) { void error; }
  }
  if (!ts) {
    ok('S5.1 SDK src 类型检查通过(严格 createProgram)', false, 'typescript 不可用——设 LEXI_TYPESCRIPT(或落在候选路径)');
  } else {
    // 与 tools/build-dist.cjs 同一严格选项;noEmit 只查类型不落盘(真类型检查:
    // transpileModule 只过语法,语义错误如 number = string 在旧实现下不会红,P3-003 修)。
    const compilerOptions = {
      strict: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      forceConsistentCasingInFileNames: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      skipLibCheck: true,
      noEmit: true
    };
    const typecheckOf = (fileNames) =>
      ts.getPreEmitDiagnostics(ts.createProgram(fileNames, compilerOptions)).filter((d) => d.category === 1);
    const formatDiags = (diags) => diags.slice(0, 2).map((d) =>
      (d.file ? path.relative(SDK, d.file.fileName) : '<global>') + ' ' +
      ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | ');

    const srcFiles = ['src/index.ts', 'src/contract.ts', 'src/capabilities.ts'].map((f) => path.join(SDK, f));
    let srcDiags = [];
    try { srcDiags = typecheckOf(srcFiles); }
    catch (error) { srcDiags = null; ok('S5.1 SDK src 类型检查通过(严格 createProgram)', false, 'threw: ' + error.message); }
    if (srcDiags !== null) {
      ok('S5.1 SDK src 类型检查通过(严格 createProgram)', srcDiags.length === 0, formatDiags(srcDiags));
    }

    // 负例(P3-003):向 SDK src 的临时副本注入刻意类型错误(number = string,TS2322)。
    // 真类型检查必须报红;若 0 错误说明检查器退化为语法转译,门禁直接红。
    const os = require('node:os');
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-sdk-typecheck-'));
      for (const f of ['index.ts', 'contract.ts', 'capabilities.ts']) {
        fs.copyFileSync(path.join(SDK, 'src', f), path.join(tmp, f));
      }
      fs.appendFileSync(path.join(tmp, 'contract.ts'),
        '\n// P3-003 负例注入(门禁临时副本,不动真源):刻意类型错误,必须被 S5.1 检查器报红。\n' +
        'export const __p3003Injected: number = API_VERSION;\n');
      const injected = typecheckOf([path.join(tmp, 'index.ts')]);
      const caught2322 = injected.some((d) => d.code === 2322);
      ok('S5.2 SDK src 注入类型错误必须红(负例,证明非仅转译)', injected.length > 0 && caught2322,
        injected.length === 0
          ? '注入 TS2322(number = string)未报错——检查器退化为语法转译'
          : '报错但缺 TS2322: ' + formatDiags(injected));
    } catch (error) {
      ok('S5.2 SDK src 注入类型错误必须红(负例,证明非仅转译)', false, 'threw: ' + error.message);
    } finally {
      if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
}

section('S6 冒烟测试可跑');
{
  const smoke = path.join(SDK, 'tests', 'sdk-smoke.cjs');
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [smoke], { cwd: SDK, encoding: 'utf8' });
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  ok('S6.1 SDK 冒烟测试通过', r.status === 0, output.split('\n').slice(-2).join(' | '));
}

// S7 = P3-001 验收面:dist 是真编译产物(入口非源码 ts)、npm pack 产物可离线安装并被
// 外部工程消费(运行时 require + 类型面 ts 编译双通道)。M1 出口前包级稳定性锚点必须
// 停在 experimental(不打 Stable——P2-00x 约束)。
section('S7 dist 产物 + npm pack 离线安装(P3-001)');
{
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');

  ok('S7.1 包入口是编译产物(main/types → dist,不是源码 ts)', sdkPkg !== null &&
    sdkPkg.main === 'dist/index.js' && sdkPkg.types === 'dist/index.d.ts' &&
    Array.isArray(sdkPkg.files) && sdkPkg.files.indexOf('dist') >= 0,
    'main=' + (sdkPkg && sdkPkg.main) + ' types=' + (sdkPkg && sdkPkg.types));
  ok('S7.2 包级稳定性锚点=experimental(M1 出口前不打 Stable)', sdkPkg !== null &&
    sdkPkg.lexinote && sdkPkg.lexinote.stability === 'experimental' &&
    sdkPkg.lexinote.apiVersion === (apiVersion ? apiVersion.apiVersion : ''),
    'stability=' + (sdkPkg && sdkPkg.lexinote && sdkPkg.lexinote.stability));

  function npmCliPath() {
    const candidates = [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) { return candidate; }
    }
    return '';
  }
  function npmRun(args, cwd) {
    const cli = npmCliPath();
    if (!cli) { return { status: -1, output: 'npm-cli.js 不存在(预期 <node>/node_modules/npm/bin/npm-cli.js)' }; }
    const r = spawnSync(process.execPath, [cli].concat(args), {
      cwd, encoding: 'utf8',
      env: Object.assign({}, process.env, { npm_config_update_notifier: 'false' })
    });
    return { status: r.status, output: ((r.stdout || '') + '\n' + (r.stderr || '')) };
  }

  let tmp = '';
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-sdk-pack-'));

    // 构建失败要在这里显式红,而不是混进 pack 的错误输出里。
    const built = spawnSync(process.execPath, [path.join(SDK, 'tools', 'build-dist.cjs')],
      { cwd: SDK, encoding: 'utf8' });
    const buildOut = ((built.stdout || '') + (built.stderr || '')).trim();
    ok('S7.3 dist 构建通过(src → js + d.ts,严格类型检查)', built.status === 0 &&
      fs.existsSync(path.join(SDK, 'dist', 'index.js')) &&
      fs.existsSync(path.join(SDK, 'dist', 'index.d.ts')),
      buildOut.split('\n').slice(-2).join(' | '));

    const packed = npmRun(['pack', '--pack-destination', tmp, '--loglevel', 'error', '--no-audit', '--no-fund'], SDK);
    let tarball = '';
    if (packed.status === 0 && fs.existsSync(tmp)) {
      const produced = fs.readdirSync(tmp).filter((f) => f.endsWith('.tgz'));
      if (produced.length === 1) { tarball = path.join(tmp, produced[0]); }
    }
    ok('S7.4 npm pack 产出 tarball', packed.status === 0 && tarball !== '',
      packed.output.split('\n').filter((l) => l.trim()).slice(-2).join(' | '));

    if (tarball !== '') {
      // 离线安装:tarball 无外部依赖,--offline 全程不触网。
      const fixture = path.join(tmp, 'fixture');
      fs.mkdirSync(fixture, { recursive: true });
      fs.writeFileSync(path.join(fixture, 'package.json'),
        JSON.stringify({ name: 'lexi-sdk-pack-fixture', version: '0.0.0', private: true }, null, 2) + '\n');
      const installed = npmRun(['install', tarball, '--offline', '--no-audit', '--no-fund',
        '--ignore-scripts', '--loglevel', 'error'], fixture);
      const pkgDir = path.join(fixture, 'node_modules', '@lexinote', 'plugin-sdk');
      ok('S7.5 npm install <tarball> 离线可装', installed.status === 0 &&
        fs.existsSync(path.join(pkgDir, 'dist', 'index.js')),
        installed.output.split('\n').filter((l) => l.trim()).slice(-2).join(' | '));

      // 运行时消费:装进来的 dist 就是可 require 的真模块。
      let runtimeDetail = '';
      let runtimeOk = false;
      try {
        const api = require(path.join(pkgDir, 'dist', 'index.js'));
        const tags = api.capabilityTags({ vault: { write: true }, network: ['https://API.example.com/path'] });
        runtimeOk = api.API_VERSION === (apiVersion ? apiVersion.apiVersion : '?') &&
          Array.isArray(api.SDK_METHODS) && api.SDK_METHODS.length > 0 &&
          JSON.stringify(tags) === JSON.stringify(['network:api.example.com', 'vault.write']) &&
          api.methodsOf('vault').length > 0;
        runtimeDetail = 'API_VERSION=' + api.API_VERSION + ' tags=' + tags.join(',');
      } catch (error) { runtimeDetail = 'threw: ' + error.message; }
      ok('S7.6 安装产物可 require(API_VERSION/能力标签/方法发现)', runtimeOk, runtimeDetail);

      // 类型面消费:外部工程经 package.json types + tsconfig paths 双路编译通过
      // (正值编译;负例见 S7.8 —— P3-003 注入类型错误必须红)。
      const tsPath2 = process.env.LEXI_TYPESCRIPT;
      let typeDetail = '';
      let typeOk = false;
      try {
        fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true,
            module: 'commonjs', target: 'es2020', moduleResolution: 'node',
            lib: ['es2020', 'dom'], baseUrl: '.',
            paths: {
              'lexinote': ['node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts'],
              'obsidian': ['node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts']
            }
          },
          include: ['consumer.ts', 'ambient.ts']
        }, null, 2));
        fs.writeFileSync(path.join(fixture, 'consumer.ts'), [
          "import { API_VERSION, capabilityTags, methodsOf } from '@lexinote/plugin-sdk';",
          "const tags: string[] = capabilityTags({ vault: { write: true }, network: ['https://api.example.com'] });",
          "const vaultMethods: string[] = methodsOf('vault').map((m) => m.method);",
          "export const fixtureSummary: string = API_VERSION + '|' + tags.join(',') + '|' + vaultMethods.length;",
          ''
        ].join('\n'));
        fs.writeFileSync(path.join(fixture, 'ambient.ts'), [
          "import { Plugin, Notice } from 'lexinote';",
          'export class FixturePlugin extends Plugin {',
          '  async onload(): Promise<void> { new Notice("lexi-sdk-pack-fixture"); }',
          '}',
          ''
        ].join('\n'));
        const ts = require(tsPath2);
        // 用 parseJsonConfigFileContent 归一化枚举/lib(tsconfig 语义与 tsc 完全一致)。
        const parsed = ts.parseJsonConfigFileContent(
          JSON.parse(fs.readFileSync(path.join(fixture, 'tsconfig.json'), 'utf8')),
          ts.sys, fixture);
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.category === 1);
        typeOk = diags.length === 0;
        typeDetail = diags.slice(0, 2).map((d) =>
          (d.file ? path.basename(d.file.fileName) : '<global>') + ' ' +
          ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | ');
      } catch (error) { typeDetail = 'threw: ' + error.message; }
      ok('S7.7 类型面可消费(@lexinote/plugin-sdk 入口 + lexinote/obsidian 别名)', typeOk, typeDetail);

      // S7.8 = P3-003 负例:同一 fixture 消费者注入刻意类型错误(TS2322)→ 类型检查必须红。
      // 若这里仍 0 错误,说明消费端检查只是语法转译(语义错误漏网),门禁直接判红。
      {
        const ts = require(tsPath2);
        const badCompilerOptions = {
          strict: true, noEmit: true, skipLibCheck: true,
          module: 'commonjs', target: 'es2020', moduleResolution: 'node',
          lib: ['es2020', 'dom'], baseUrl: '.',
          paths: {
            'lexinote': ['node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts'],
            'obsidian': ['node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts']
          }
        };
        fs.writeFileSync(path.join(fixture, 'tsconfig.bad.json'),
          JSON.stringify({ compilerOptions: badCompilerOptions, include: ['consumer-bad.ts'] }, null, 2));
        fs.writeFileSync(path.join(fixture, 'consumer-bad.ts'), [
          "import { API_VERSION } from '@lexinote/plugin-sdk';",
          "import { Notice } from 'lexinote';",
          '// P3-003 负例(门禁临时 fixture):刻意类型错误,真类型检查必须报 TS2322。',
          'export const broken: number = API_VERSION;',
          "export const alsoBroken: Notice = 'not-a-notice';",
          ''
        ].join('\n'));
        let negDetail = '';
        let negOk = false;
        try {
          const parsedBad = ts.parseJsonConfigFileContent(
            JSON.parse(fs.readFileSync(path.join(fixture, 'tsconfig.bad.json'), 'utf8')),
            ts.sys, fixture);
          const programBad = ts.createProgram(parsedBad.fileNames, parsedBad.options);
          const badDiags = ts.getPreEmitDiagnostics(programBad).filter((d) => d.category === 1);
          negOk = badDiags.some((d) => d.code === 2322);
          negDetail = badDiags.length === 0
            ? '注入 TS2322 未报错——消费端检查退化为语法转译'
            : badDiags.slice(0, 2).map((d) =>
              (d.file ? path.basename(d.file.fileName) : '<global>') + ' ' +
              ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | ');
        } catch (error) { negDetail = 'threw: ' + error.message; }
        ok('S7.8 消费端 fixture 注入类型错误必须红(P3-003 负例)', negOk, negDetail);
      }
    }
  } finally {
    if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-sdk-contract: PASS'
  : 'plugin-sdk-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
