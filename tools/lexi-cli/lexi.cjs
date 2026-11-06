#!/usr/bin/env node
// RFC §10.2 / §14 T5.2 · lexi 开发者 CLI。
// 命令:lexi plugin create|validate|pack|sign|publish(§10.2 的核心开发闭环)。
// 单一真源:validate/publish 复用宿主 LexiPluginManifestV2 解析器与 LexiRegistryTrust
// 信任链(经 LEXI_TYPESCRIPT 转译,与门禁同法)——CLI 不另写第二份校验。
// 签名:开发缝用 HMAC-SHA256(LEXI_SIGN_KEY);生产签名归服务侧/TUF(§9.3)。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

function fail(message) { console.error('error: ' + message); process.exit(1); }

/** 宿主 ArkTS 模块 → node 可用(与门禁同一转译法)。 */
function loadHostModule(rel) {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { fail('validate/publish 需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
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

// P1-003c:构建期 CJS→IIFE。包装器单一真源 = 宿主 shim 的 __lexiWrapPluginSource
// (经 vm 复用,与 runtime 页装载期包装逐字节同源,CLI 不另写第二份 —— 与 validate/publish
// 复用宿主解析器同一原则)。产物自执行,求值期不再需要 module/exports/require 宿主管线。
const IIFE_MARKER_PATTERN = /^\s*\/\*\s*lexi-iife:v1\s*\*\//;

function loadShimWrapper() {
  const shimPath = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_shim.js');
  if (!fs.existsSync(shimPath)) { fail('找不到宿主 shim(单一真源包装器): ' + shimPath); }
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
    fail('宿主 shim 求值失败: ' + (error && error.message));
  }
  const wrap = sandbox.window.lexiRuntime && sandbox.window.lexiRuntime.__lexiWrapPluginSource;
  if (typeof wrap !== 'function') {
    fail('宿主 shim 未发布 __lexiWrapPluginSource(P1-003c 单一真源包装器缺失)');
  }
  return wrap;
}

function cmdBuild(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const manifestPath = path.join(proj, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { fail('manifest.json 不存在: ' + proj); }
  let manifestId = '';
  try { manifestId = String(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id || ''); } catch (error) {
    fail('manifest.json 解析失败: ' + (error && error.message));
  }
  if (!manifestId) { fail('manifest.json 缺少 id'); }
  const mainPath = path.join(proj, 'main.js');
  if (!fs.existsSync(mainPath)) { fail('main.js 不存在: ' + proj + '(先由 esbuild/tsc 产出 CommonJS bundle)'); }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : mainPath;
  const source = fs.readFileSync(mainPath, 'utf8');
  if (IIFE_MARKER_PATTERN.test(source)) {
    console.log('build: 已是 lexi-iife:v1 自执行产物,跳过包装: ' + outPath);
    return;
  }
  const wrap = loadShimWrapper();
  let wrapped = '';
  try { wrapped = wrap(source, manifestId); } catch (error) { fail('IIFE 包装失败: ' + (error && error.message)); }
  // 构建期验证:包装产物必须可编译(语法级失败在此拦下,不流入分发)。
  try { new vm.Script(wrapped, { filename: 'lexinote-plugin-' + manifestId + '.js' }); } catch (error) {
    fail('包装产物语法校验失败: ' + (error && error.message));
  }
  fs.writeFileSync(outPath, wrapped);
  const sha256 = crypto.createHash('sha256').update(wrapped).digest('hex');
  console.log('build: iife=' + outPath + ' bytes=' + Buffer.byteLength(wrapped) + ' sha256=' + sha256 +
    ' (lexi-iife:v1; 包装器单一真源=宿主 shim __lexiWrapPluginSource)');
}

function cmdValidate(args) {
  const proj = path.resolve(args[0] || process.cwd());
  const manifestPath = path.join(proj, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { fail('manifest.json 不存在: ' + proj); }
  const mod = loadHostModule('LexiPluginManifestV2.ets');
  try {
    mod.parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
    console.log('validate: PASS (manifest v2 严格解析通过)');
  } catch (error) {
    fail('validate: ' + (error && error.message));
  }
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

const ROOT = path.resolve(__dirname, '..', '..');
const [, , command, sub, ...subArgs] = process.argv;
switch (command === 'plugin' ? sub : command) {
  case 'create': cmdCreate((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'build': cmdBuild((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'validate': cmdValidate((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'pack': cmdPack((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'sign': cmdSign((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  case 'publish': cmdPublish((command === 'plugin' ? subArgs : [sub]).filter(Boolean)); break;
  default:
    console.log('用法: lexi plugin create|build|validate|pack|sign|publish [args](RFC §10.2)');
    process.exit(command === 'plugin' && !sub ? 0 : 1);
}
