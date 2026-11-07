#!/usr/bin/env node
// RFC §10.2 / §14 T5.2 · lexi 开发者 CLI。
// 命令:lexi plugin create|validate|pack|sign|publish(§10.2 的核心开发闭环)
//        + dev|test|inspect|doctor|compatibility(P3-004 开发基础设施)。
//   dev           — validate+build 单次(--watch 进入监视循环,改动即重跑;P3-005 热重载另行设计)
//   build         — CJS→IIFE 包装(ADR-R25-01:包装器单一真源=宿主 shim,经 vm 复用)
//   validate      — 走宿主同一 LexiPluginManifestV2 解析器
//   test          — 运行 <proj>/test|tests/*.cjs|js(子进程 node,真退出码汇总)
//   inspect       — manifest/入口/打包面摘要(数据全部来自真实文件,--json 供工具消费)
//   doctor        — 环境体检:node/typescript/宿主 shim/解析器/契约快照/zip-store
//   compatibility — 兼容面读数:API 版本对账 + 能力标签(SDK 单一真源) + CM 矩阵 + API 面状态分布
// 单一真源:validate/inspect/compatibility 复用宿主 LexiPluginManifestV2 解析器与 SDK
// capabilityTags(经 LEXI_TYPESCRIPT 转译,与门禁同法)——CLI 不另写第二份校验。
// 签名:开发缝用 HMAC-SHA256(LEXI_SIGN_KEY);生产签名归服务侧/TUF(§9.3)。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function fail(message) { console.error('error: ' + message); process.exit(1); }

/** 宿主 ArkTS 模块 → node 可用(与门禁同一转译法)。失败抛错,由调用方决定 fail-visible 形态。 */
function loadHostModule(rel) {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('validate/publish 需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-cli-'));
  const copyAndPatch = (name) => {
    let src = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin', name + '.ets'), 'utf8');
    src = src.replace(/from '\.\/LexiPluginManifestV2'/g, "from './LexiPluginManifestV2.ts'");
    fs.writeFileSync(path.join(dir, name + '.ts'), src);
  };
  copyAndPatch('LexiPluginManifest');
  copyAndPatch('LexiPluginManifestV2');
  void rel;
  const mod = require(path.join(dir, path.basename(rel).replace(/\.ets$/, '.ts')));
  return mod;
}

/** SDK capabilityTags 复用(SDK 单一真源;与 tests/sdk-smoke.cjs 同一转译法)。失败抛错。 */
function loadSdkCapabilities() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块(SDK capabilityTags 经同一转译法复用)'); }
  const ts = require(tsPath);
  const src = fs.readFileSync(path.join(ROOT, 'packages', 'lexinote-plugin-sdk', 'src', 'capabilities.ts'), 'utf8');
  const js = ts.transpileModule(src,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})')(() => {}, mod, mod.exports);
  return mod.exports;
}

function readManifest(proj) {
  const manifestPath = path.join(proj, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { throw new Error('manifest.json 不存在: ' + proj); }
  try {
    return { path: manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  } catch (error) {
    throw new Error('manifest.json 解析失败: ' + (error && error.message));
  }
}

/** manifest v2 严格校验(宿主同一解析器)。失败抛错。 */
function validateProject(proj) {
  const { path: manifestPath } = readManifest(proj);
  const mod = loadHostModule('LexiPluginManifestV2.ets');
  mod.parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
}

// P1-003c:构建期 CJS→IIFE。包装器单一真源 = 宿主 shim 的 __lexiWrapPluginSource
// (经 vm 复用,与 runtime 页装载期包装逐字节同源,CLI 不另写第二份 —— 与 validate/publish
// 复用宿主解析器同一原则)。产物自执行,求值期不再需要 module/exports/require 宿主管线。
const IIFE_MARKER_PATTERN = /^\s*\/\*\s*lexi-iife:v1\s*\*\//;

function loadShimWrapper() {
  const shimPath = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_shim.js');
  if (!fs.existsSync(shimPath)) { throw new Error('找不到宿主 shim(单一真源包装器): ' + shimPath); }
  const sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Map: Map,
    Set: Set,
    document: { createElement: function () { return { style: {}, classList: { add: function () {} } }; } },
    location: { href: 'about:blank' }
  };
  sandbox.window = sandbox;
  try {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(shimPath, 'utf8'), sandbox, { filename: 'lexinote_plugin_shim.js' });
  } catch (error) {
    throw new Error('宿主 shim 求值失败: ' + (error && error.message));
  }
  const wrap = sandbox.window.lexiRuntime && sandbox.window.lexiRuntime.__lexiWrapPluginSource;
  if (typeof wrap !== 'function') {
    throw new Error('宿主 shim 未发布 __lexiWrapPluginSource(P1-003c 单一真源包装器缺失)');
  }
  return wrap;
}

/** 构建核心(可复用;失败抛错)。返回 { outPath, bytes, sha256, skipped }。 */
function buildProject(proj, outPath) {
  const manifestPath = path.join(proj, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { throw new Error('manifest.json 不存在: ' + proj); }
  let manifestId = '';
  try { manifestId = String(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id || ''); } catch (error) {
    throw new Error('manifest.json 解析失败: ' + (error && error.message));
  }
  if (!manifestId) { throw new Error('manifest.json 缺少 id'); }
  const mainPath = path.join(proj, 'main.js');
  if (!fs.existsSync(mainPath)) { throw new Error('main.js 不存在: ' + proj + '(先由 esbuild/tsc 产出 CommonJS bundle)'); }
  const source = fs.readFileSync(mainPath, 'utf8');
  if (IIFE_MARKER_PATTERN.test(source)) {
    return { outPath, bytes: Buffer.byteLength(source), skipped: true, id: manifestId };
  }
  const wrap = loadShimWrapper();
  let wrapped = '';
  try { wrapped = wrap(source, manifestId); } catch (error) { throw new Error('IIFE 包装失败: ' + (error && error.message)); }
  // 构建期验证:包装产物必须可编译(语法级失败在此拦下,不流入分发)。
  try { new vm.Script(wrapped, { filename: 'lexinote-plugin-' + manifestId + '.js' }); } catch (error) {
    throw new Error('包装产物语法校验失败: ' + (error && error.message));
  }
  fs.writeFileSync(outPath, wrapped);
  const sha256 = crypto.createHash('sha256').update(wrapped).digest('hex');
  return { outPath, bytes: Buffer.byteLength(wrapped), sha256, skipped: false, id: manifestId };
}

/** pack 面文件枚举(pack 与 inspect 共用同一 walk 语义)。 */
function listPackFiles(proj) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(full, rel); } else { files.push({ name: rel, bytes: fs.statSync(full).size }); }
    }
  };
  walk(proj, '');
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function cmdCreate(args) {
  const name = args[0];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) { fail('插件 id 只允许小写字母、数字与连字符: ' + name); }
  let outDir = process.cwd();
  const dirIdx = args.indexOf('--dir');
  if (dirIdx >= 0 && args[dirIdx + 1]) { outDir = path.resolve(args[dirIdx + 1]); }
  const proj = path.join(outDir, name);
  if (fs.existsSync(proj)) { fail('目录已存在: ' + proj); }
  fs.mkdirSync(proj, { recursive: true });
  const manifest = {
    manifestVersion: 2,
    id: name,
    name: name,
    version: '0.1.0',
    author: 'your-name',
    description: 'A LexiNote plugin.',
    license: 'MIT',
    entrypoints: { service: 'main.js' },
    compatibility: { obsidianApiLevel: '1.14.4' },
    platforms: ['harmonyos-phone', 'harmonyos-tablet', 'harmonyos-pc'],
    capabilities: {}
  };
  fs.writeFileSync(path.join(proj, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(proj, 'main.js'), [
    '// ' + name + ' — LexiNote 插件入口(§10.4 官方模板语义)。', '',
    "module.exports = class " + name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + " {",
    '  onload() {',
    "    console.log('[" + name + "] loaded');",
    '  }',
    '',
    '  onunload() {}',
    '};',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(proj, 'README.md'), '# ' + name + '\n\nLexiNote 插件。开发文档见 docs/plugin-development.md。\n');
  fs.writeFileSync(path.join(proj, 'styles.css'), '/* ' + name + ' 样式(消费 --lexi-* token,§7.8) */\n');
  console.log('created: ' + proj);
}

function cmdValidate(args) {
  const proj = path.resolve(args[0] || process.cwd());
  try {
    validateProject(proj);
    console.log('validate: PASS (manifest v2 严格解析通过)');
  } catch (error) {
    fail('validate: ' + (error && error.message));
  }
}

function cmdBuild(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const outIdx = args.indexOf('--out');
  const mainPath = path.join(proj, 'main.js');
  const outPath = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : mainPath;
  let result;
  try { result = buildProject(proj, outPath); } catch (error) { fail('build: ' + (error && error.message)); }
  if (result.skipped) {
    console.log('build: 已是 lexi-iife:v1 自执行产物,跳过包装: ' + result.outPath);
    return;
  }
  console.log('build: iife=' + result.outPath + ' bytes=' + result.bytes + ' sha256=' + result.sha256 +
    ' (lexi-iife:v1; 包装器单一真源=宿主 shim __lexiWrapPluginSource)');
}

function cmdDev(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const watch = args.indexOf('--watch') >= 0;
  try { validateProject(proj); } catch (error) { fail('dev: ' + (error && error.message)); }
  if (!fs.existsSync(path.join(proj, 'main.js'))) { fail('dev: main.js 不存在: ' + proj); }
  const pass = (trigger) => {
    validateProject(proj);
    console.log('[dev] pass(' + trigger + '): validate PASS');
    const result = buildProject(proj, path.join(proj, 'main.js'));
    console.log('[dev] pass(' + trigger + '): build ' + (result.skipped ? 'skip(iife 已包装)' : 'iife=' + result.bytes + 'B'));
  };
  try { pass('initial'); } catch (error) { fail('dev: ' + (error && error.message)); }
  if (!watch) { console.log('[dev] 单次完成(--watch 进入监视循环)'); return; }
  console.log('[dev] watching ' + proj + ' (Ctrl+C 退出)');
  // dev 循环 fail-visible 但不退出:单次 pass 失败(坏编辑)打印后继续等下一次改动。
  let timer = null;
  let pendingPasses = 0;
  fs.watch(proj, { recursive: true }, (_event, file) => {
    const name = String(file || '').replace(/\\/g, '/');
    if (!/^(main\.js|manifest\.json|styles\.css)$/.test(name)) { return; }
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => {
      timer = null;
      pendingPasses++;
      const seq = pendingPasses;
      try { pass('change#' + seq + ':' + name); } catch (error) {
        console.error('[dev] pass(' + seq + ') 失败: ' + (error && error.message));
      }
    }, 120);
  });
}

function cmdTest(args) {
  const proj = path.resolve(args[0] || process.cwd());
  try { readManifest(proj); } catch (error) { fail('test: ' + (error && error.message)); }
  const files = [];
  for (const dirName of ['test', 'tests']) {
    const dir = path.join(proj, dirName);
    if (!fs.existsSync(dir)) { continue; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(cjs|mjs|js)$/.test(entry.name) && !/^[._]/.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  if (files.length === 0) {
    fail('test: 未找到测试文件(放置 <proj>/test/*.cjs 或 <proj>/tests/*.cjs): ' + proj);
  }
  let failed = 0;
  for (const file of files.sort()) {
    const r = spawnSync(process.execPath, [file], { cwd: proj, encoding: 'utf8' });
    const label = path.relative(proj, file);
    if (r.status === 0) {
      console.log('test: ok   ' + label);
    } else {
      failed++;
      console.log('test: FAIL ' + label + ' (exit=' + r.status + ')');
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      if (out) { console.log(out.split('\n').map((l) => '  | ' + l).join('\n')); }
    }
  }
  if (failed > 0) { fail('test: ' + (files.length - failed) + '/' + files.length + ' 通过'); }
  console.log('test: PASS (' + files.length + ' 文件)');
}

function cmdInspect(args) {
  const json = args.indexOf('--json') >= 0;
  const proj = path.resolve(args[0] || process.cwd());
  let manifest;
  try { manifest = readManifest(proj).manifest; } catch (error) { fail('inspect: ' + (error && error.message)); }
  const mainPath = path.join(proj, 'main.js');
  let entry = null;
  if (fs.existsSync(mainPath)) {
    const buf = fs.readFileSync(mainPath);
    entry = {
      file: 'main.js',
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      iife: IIFE_MARKER_PATTERN.test(buf.toString('utf8'))
    };
  }
  let validate = 'skipped(LEXI_TYPESCRIPT 未设;只做了 JSON 摘要,未跑宿主 v2 严格解析)';
  if (process.env.LEXI_TYPESCRIPT) {
    try { validateProject(proj); validate = 'PASS'; }
    catch (error) { fail('inspect: manifest v2 校验失败: ' + (error && error.message)); }
  }
  let tags = null;
  let tagsNote = '';
  try { tags = loadSdkCapabilities().capabilityTags(manifest.capabilities || {}); }
  catch (error) { tagsNote = String(error && error.message); }
  const packFiles = fs.existsSync(proj) ? listPackFiles(proj) : [];
  const report = {
    project: proj,
    id: manifest.id || '',
    name: manifest.name || '',
    version: manifest.version || '',
    author: manifest.author || '',
    description: manifest.description || '',
    license: manifest.license || '',
    entrypoints: manifest.entrypoints || {},
    platforms: manifest.platforms || [],
    compatibility: manifest.compatibility || {},
    capabilities: manifest.capabilities || {},
    authorizationTags: tags,
    authorizationTagsNote: tagsNote,
    mainEntry: entry,
    manifestV2Validate: validate,
    packFiles: packFiles.map((f) => f.name + '(' + f.bytes + 'B)')
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('inspect: id=' + report.id + ' name=' + report.name + ' version=' + report.version +
      ' author=' + report.author + ' license=' + report.license);
    console.log('inspect: entrypoints=' + JSON.stringify(report.entrypoints) +
      ' platforms=[' + report.platforms.join(', ') + ']');
    console.log('inspect: compatibility=' + JSON.stringify(report.compatibility));
    console.log('inspect: capabilities=' + JSON.stringify(report.capabilities));
    console.log('inspect: authorizationTags=' + (tags ? '[' + tags.join(', ') + ']' : '推导失败(需要 LEXI_TYPESCRIPT)' + tagsNote));
    console.log('inspect: mainEntry=' + (entry
      ? entry.file + ' bytes=' + entry.bytes + ' sha256=' + entry.sha256 + ' iife=' + (entry.iife ? 'yes' : 'no')
      : '缺失'));
    console.log('inspect: manifestV2Validate=' + validate);
    console.log('inspect: packFiles=' + report.packFiles.length + ' [' + report.packFiles.join(', ') + ']');
  }
}

function cmdDoctor(args) {
  const projArg = args.find((a) => a && !a.startsWith('--'));
  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, status: 'ok', detail: detail || '' });
    } catch (error) {
      checks.push({ name, status: error && error.warn ? 'warn' : 'fail', detail: (error && error.message) || '' });
    }
  };
  check('node', () => 'v' + process.version);
  check('typescript(LEXI_TYPESCRIPT)', () => {
    const p = process.env.LEXI_TYPESCRIPT;
    if (!p) {
      const e = new Error('未设置——validate/publish/dev/inspect 需要它: export LEXI_TYPESCRIPT=<typescript 模块目录>');
      e.warn = true;
      throw e;
    }
    const ts = require(p);
    return 'ts=' + ts.version + ' (' + p + ')';
  });
  check('宿主 shim(单一真源包装器)', () => {
    const wrap = loadShimWrapper();
    return typeof wrap === 'function' ? '__lexiWrapPluginSource 可复用' : '';
  });
  check('宿主 manifest v2 解析器', () => {
    if (!process.env.LEXI_TYPESCRIPT) {
      const e = new Error('跳过(LEXI_TYPESCRIPT 未设;validate/publish/dev 在此环境不可用)');
      e.warn = true;
      throw e;
    }
    loadHostModule('LexiPluginManifestV2.ets');
    return 'LexiPluginManifestV2 转译+加载成功';
  });
  check('契约快照(tools/plugin-contract)', () => {
    const names = ['api-surface.json', 'api-version.json', 'capability-map.json', 'codemirror-versions.json'];
    let methods = 0;
    for (const name of names) {
      const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'plugin-contract', name), 'utf8'));
      if (name === 'api-surface.json') { methods = parsed.methods.length; }
    }
    return names.length + ' 份可解析,api-surface methods=' + methods;
  });
  check('SDK schema 导出', () => {
    const dir = path.join(ROOT, 'packages', 'lexinote-plugin-sdk', 'schema');
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (names.length === 0) { throw new Error('schema/ 为空(重跑 packages/lexinote-plugin-sdk/tools/sync-sdk.cjs)'); }
    for (const name of names) { JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
    return names.length + ' 份可解析(' + names.join(', ') + ')';
  });
  check('zip-store(打包面)', () => {
    const zipStore = require(path.join(ROOT, 'tools', 'plugin-dist', 'zip-store.cjs'));
    if (typeof zipStore.writeZip !== 'function' || typeof zipStore.readZip !== 'function') {
      throw new Error('zip-store 缺 writeZip/readZip');
    }
    return 'writeZip/readZip 在位';
  });
  if (projArg) {
    check('项目 ' + projArg, () => {
      const proj = path.resolve(projArg);
      const { manifest } = readManifest(proj);
      if (!manifest.id) { throw new Error('manifest.json 缺少 id'); }
      if (!fs.existsSync(path.join(proj, 'main.js'))) { throw new Error('main.js 不存在'); }
      return 'id=' + manifest.id + ' version=' + (manifest.version || '');
    });
  }
  let fails = 0;
  let warns = 0;
  for (const c of checks) {
    if (c.status === 'fail') { fails++; }
    if (c.status === 'warn') { warns++; }
    console.log('doctor: ' + (c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL') + ' ' + c.name +
      (c.detail ? ' — ' + c.detail : ''));
  }
  const summary = 'doctor: ' + (checks.length - fails - warns) + ' ok / ' + warns + ' warn / ' + fails + ' fail';
  if (fails > 0) { fail(summary); }
  console.log(summary + ' — PASS');
}

function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) - (pb[i] || 0); }
  }
  return 0;
}

function cmdCompatibility(args) {
  const proj = path.resolve(args[0] || process.cwd());
  let manifest;
  try { manifest = readManifest(proj).manifest; } catch (error) { fail('compatibility: ' + (error && error.message)); }
  const compat = manifest.compatibility || {};
  const contract = path.join(ROOT, 'tools', 'plugin-contract');
  let apiVersion = '';
  let surface = null;
  let capMap = null;
  let cm = null;
  try {
    apiVersion = JSON.parse(fs.readFileSync(path.join(contract, 'api-version.json'), 'utf8')).apiVersion;
    surface = JSON.parse(fs.readFileSync(path.join(contract, 'api-surface.json'), 'utf8'));
    capMap = JSON.parse(fs.readFileSync(path.join(contract, 'capability-map.json'), 'utf8'));
    cm = JSON.parse(fs.readFileSync(path.join(contract, 'codemirror-versions.json'), 'utf8'));
  } catch (error) { fail('compatibility: 契约快照读取失败: ' + (error && error.message)); }

  const lines = [];
  let incompatible = false;
  lines.push('compatibility: 宿主 API 版本=' + apiVersion);
  const lex = compat.lexinote || null;
  if (lex && lex.min) {
    if (cmpSemver(lex.min, apiVersion) > 0) {
      incompatible = true;
      lines.push('compatibility: FAIL manifest 要求 lexinote>=' + lex.min + ',宿主只有 ' + apiVersion);
    } else {
      lines.push('compatibility: ok manifest 要求 lexinote>=' + lex.min + ' ≤ 宿主 ' + apiVersion);
    }
    if (lex.maxExclusive && cmpSemver(apiVersion, lex.maxExclusive) >= 0) {
      incompatible = true;
      lines.push('compatibility: FAIL 宿主 ' + apiVersion + ' 不在 manifest 上界 [min=' + lex.min + ', maxExclusive=' + lex.maxExclusive + ')');
    }
  } else {
    lines.push('compatibility: 未声明 compatibility.lexinote(建议声明 min;不声明视为接受宿主当前 API 版本)');
  }
  if (compat.obsidianApiLevel) { lines.push('compatibility: obsidianApiLevel=' + compat.obsidianApiLevel + '(兼容别名面)'); }
  if (compat.harmonyOS && compat.harmonyOS.min) { lines.push('compatibility: harmonyOS min=' + compat.harmonyOS.min); }

  let tags = [];
  try { tags = loadSdkCapabilities().capabilityTags(manifest.capabilities || {}); }
  catch (error) { fail('compatibility: 能力标签推导失败(需要 LEXI_TYPESCRIPT): ' + (error && error.message)); }
  lines.push('compatibility: 授权标签=[' + tags.join(', ') + ']');

  const kinds = {};
  for (const c of (capMap.capabilities || [])) { kinds[c.kind] = (kinds[c.kind] || 0) + 1; }
  lines.push('compatibility: 契约方法 ' + (capMap.capabilities || []).length + ' 条,授权类别分布 ' + JSON.stringify(kinds));

  const byStatus = {};
  for (const m of surface.methods) { byStatus[m.status] = (byStatus[m.status] || 0) + 1; }
  lines.push('compatibility: API 面 ' + surface.methods.length + ' 方法,状态分布 ' + JSON.stringify(byStatus) +
    '(逐方法状态见 api-surface.json)');
  lines.push('compatibility: CodeMirror 宿主矩阵 ' + Object.keys(cm.modules || {})
    .map((k) => k + '@' + cm.modules[k]).join(', '));
  for (const line of lines) { console.log(line); }
  if (incompatible) { fail('compatibility: FAIL(宿主版本不满足 manifest 声明)'); }
  console.log('compatibility: PASS ' + proj);
}

function cmdPack(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const zipStore = require(path.join(ROOT, 'tools', 'plugin-dist', 'zip-store.cjs'));
  const outZip = proj + '.zip';
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(full, rel); } else { files.push({ name: rel, data: fs.readFileSync(full) }); }
    }
  };
  walk(proj, '');
  const zipBuffer = zipStore.writeZip(files);
  fs.writeFileSync(outZip, zipBuffer);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outZip)).digest('hex');
  console.log('pack: zip=' + outZip + ' sha256=' + sha256);
}

function cmdSign(args) {
  const zipPath = path.resolve(args[0] || '');
  if (!fs.existsSync(zipPath)) { fail('待签文件不存在: ' + zipPath); }
  const key = process.env.LEXI_SIGN_KEY || '';
  if (!key) { fail('sign 需要 LEXI_SIGN_KEY(开发缝 HMAC;生产签名归服务侧/TUF §9.3)'); }
  const signature = crypto.createHmac('sha256', key).update(fs.readFileSync(zipPath)).digest('hex');
  const sigPath = zipPath + '.sig';
  fs.writeFileSync(sigPath, JSON.stringify({ algorithm: 'HMAC-SHA256', signature }, null, 2) + '\n');
  console.log('sign: signature=' + sigPath);
}

function cmdPublish(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const zipIdx = args.indexOf('--zip');
  const shaIdx = args.indexOf('--sha256');
  const zipPath = zipIdx >= 0 ? args[zipIdx + 1] : proj + '.zip';
  let sha256 = shaIdx >= 0 ? args[shaIdx + 1] : '';
  if (!sha256) {
    if (!fs.existsSync(zipPath)) { fail('缺 --sha256 且找不到 zip: ' + zipPath); }
    sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(proj, 'manifest.json'), 'utf8'));
  const key = process.env.LEXI_SIGN_KEY || 'dev';
  const targetsPayload = JSON.stringify({
    plugins: { [manifest.id]: { [manifest.version]: { sha256 } } },
    version: 1
  }, null, 2);
  const signature = crypto.createHmac('sha256', key).update(targetsPayload).digest('hex');
  const outPath = proj + '.targets.json';
  fs.writeFileSync(outPath, JSON.stringify({ payload: targetsPayload, signature: signature }, null, 2) + '\n');
  console.log('publish: targets=' + outPath);
}

const [, , command, sub, ...subArgs] = process.argv;
switch (command === 'plugin' ? sub : command) {
  case 'create': cmdCreate((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'build': cmdBuild((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'validate': cmdValidate((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'dev': cmdDev((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'test': cmdTest((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'inspect': cmdInspect((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'doctor': cmdDoctor((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'compatibility': cmdCompatibility((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'pack': cmdPack((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'sign': cmdSign((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'publish': cmdPublish((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  default:
    console.log('用法: lexi plugin create|build|validate|dev|test|inspect|doctor|compatibility|pack|sign|publish [args](RFC §10.2)');
    process.exit(command === 'plugin' && !sub ? 0 : 1);
}
