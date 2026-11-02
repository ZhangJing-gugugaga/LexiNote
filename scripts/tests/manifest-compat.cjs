#!/usr/bin/env node
// Gate: 插件版本闸门的判据是「我们模拟的 Obsidian API 级别」OBSIDIAN_API_COMPAT,
// 不是 LexiNote 自己的产品版本号。minAppVersion 声明的是插件要求的 Obsidian 版本线。
// 语义边界(每条都固化成断言,不许"看情况"):
//   缺失       -> 清单解析填充 0.0.0,视为没提要求 -> 放行
//   空串       -> 视为没提要求(Obsidian 侧同样按 falsy 跳过) -> 放行
//   '1.x'      -> 无法解析的版本声明,不能当成"要求很低" -> 拒绝(malformed)
//   '1.13'     -> 1.13.0 -> 放行
//   '1.13.1.0' -> 按前 3 段 1.13.1 -> 放行
//   'v1.13.1'  -> 去掉前导 v -> 1.13.1 -> 放行
// 用法: node scripts/tests/manifest-compat.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');
const CORE = path.join(REPO, 'entry', 'src', 'main', 'ets', 'core');
const TASKS_MANIFEST = path.join(REPO, 'tools', 'plugins-fixtures', 'local', 'obsidian-tasks', 'manifest.json');
const MANIFEST_SRC = path.join(CORE, 'plugin', 'LexiPluginManifest.ets');

const TS_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  path.join(REPO, 'oh_modules', 'typescript'),
  'typescript'
].filter((candidate) => Boolean(candidate));
function loadTypeScript() {
  for (const candidate of TS_CANDIDATES) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error('找不到 typescript:请设置 LEXI_TYPESCRIPT');
}
const ts = loadTypeScript();

const cache = new Map();
function load(spec, fromDir) {
  const base = spec.startsWith('.') ? path.resolve(fromDir || CORE, spec) : path.resolve(CORE, spec);
  const target = base.endsWith('.ets') ? base : base + '.ets';
  if (cache.has(target)) { return cache.get(target); }
  const js = ts.transpileModule(fs.readFileSync(target, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  cache.set(target, mod.exports);
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: target })(
    (s) => load(s, path.dirname(target)), mod, mod.exports);
  cache.set(target, mod.exports);
  return mod.exports;
}

const manifestModule = load('plugin/LexiPluginManifest');
const { parsePluginManifest, manifestCompatible, evaluateManifestCompat, OBSIDIAN_API_COMPAT } = manifestModule;

let failed = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    console.log('[PASS] ' + name);
  } catch (error) {
    failed += 1;
    console.log('[FAIL] ' + name + ' — ' + String(error && error.message ? error.message : error));
  }
}

/** 造一份最小可解析清单;template 只放真正要测的那几个字段。 */
function manifestOf(template) {
  const raw = Object.assign({ id: 'probe', name: 'Probe', version: '1.0.0', author: 'gate' }, template);
  return parsePluginManifest(JSON.stringify(raw));
}

// ---------------------------------------------------------------- 判据本身
check('compat 常量与仓库 obsidian 契约基线一致(1.14.x 版本线,不是产品版本号)', () => {
  // 契约基线 = 夹具缓存里 obsidian 类型包的真实版本;compat 必须落在这条线上。
  const bases = [
    path.join(REPO, '.fixtures-out', '.cache', 'view-calendar', 'src', 'node_modules', 'obsidian', 'package.json'),
    path.join(REPO, '.fixtures-out', '.cache', 'markdown-postprocessor-tasks', 'src', 'node_modules', 'obsidian', 'package.json')
  ].filter((file) => fs.existsSync(file));
  assert.ok(bases.length > 0, '仓里找不到 obsidian 契约基线 package.json');
  const versions = bases.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).version);
  assert.equal(new Set(versions).size, 1, '仓里 obsidian 基线版本不唯一: ' + versions.join(','));
  assert.equal(OBSIDIAN_API_COMPAT, versions[0], 'OBSIDIAN_API_COMPAT 应等于契约基线 obsidian.d.ts 版本');
});

check('旧的产品版本号判据(1.1.0)已不在源码里当闸门使用', () => {
  const source = fs.readFileSync(MANIFEST_SRC, 'utf8');
  assert.ok(!/APP_VERSION/.test(source), 'LexiPluginManifest.ets 仍残留 APP_VERSION');
  assert.ok(/export const OBSIDIAN_API_COMPAT/.test(source), 'LexiPluginManifest.ets 缺 OBSIDIAN_API_COMPAT');
});

// ---------------------------------------------------------------- 畸形输入矩阵
const CASES = [
  // name, template, expectCompatible, expectMalformed
  ['minAppVersion 缺失 -> 0.0.0 放行', {}, true, false],
  ['minAppVersion 空串 -> 没提要求,放行', { minAppVersion: '' }, true, false],
  ['minAppVersion 畸形 1.x -> 拒绝(不能当 1.0.0)', { minAppVersion: '1.x' }, false, true],
  ['minAppVersion 畸形 x.1.1 -> 拒绝', { minAppVersion: 'x.1.1' }, false, true],
  ['minAppVersion 两段 1.13 -> 1.13.0 放行', { minAppVersion: '1.13' }, true, false],
  ['minAppVersion 四段 1.13.1.0 -> 1.13.1 放行', { minAppVersion: '1.13.1.0' }, true, false],
  ['minAppVersion 带前缀 v1.13.1 -> 1.13.1 放行', { minAppVersion: 'v1.13.1' }, true, false],
  ['minAppVersion 等于 compat 1.14.4 -> 放行', { minAppVersion: '1.14.4' }, true, false],
  ['minAppVersion 高一位 1.14.5 -> 拒绝', { minAppVersion: '1.14.5' }, false, false],
  ['minAppVersion 1.15.0 -> 拒绝', { minAppVersion: '1.15.0' }, false, false],
  ['minAppVersion v1.15 -> 拒绝', { minAppVersion: 'v1.15' }, false, false]
];

const rows = [];
for (const [name, template, wantCompatible, wantMalformed] of CASES) {
  const manifest = manifestOf(template);
  const verdict = evaluateManifestCompat(manifest);
  rows.push({
    input: Object.prototype.hasOwnProperty.call(template, 'minAppVersion') ? JSON.stringify(template.minAppVersion) : '(缺失)',
    parsed: manifest.minAppVersion,
    requirement: verdict.requirement,
    compatible: verdict.compatible,
    malformed: verdict.malformed
  });
  check(name, () => {
    assert.equal(verdict.compatible, wantCompatible, 'compatible 期望 ' + wantCompatible + ' 实际 ' + verdict.compatible);
    assert.equal(verdict.malformed, wantMalformed, 'malformed 期望 ' + wantMalformed + ' 实际 ' + verdict.malformed);
    assert.equal(manifestCompatible(manifest), wantCompatible, 'manifestCompatible 与 verdict 不一致');
  });
}

// ---------------------------------------------------------------- 真实任务插件
check('obsidian-tasks 8.6.0 夹具(真实 manifest)判为 compatible=true', () => {
  const raw = fs.readFileSync(TASKS_MANIFEST, 'utf8');
  const parsed = JSON.parse(raw);
  // 锁住夹具:夹具一换,这条断言的结论就不属于同一个被测对象了。
  assert.equal(parsed.minAppVersion, '1.13.1', '夹具 minAppVersion 变了: ' + parsed.minAppVersion);
  const manifest = parsePluginManifest(raw);
  const verdict = evaluateManifestCompat(manifest);
  assert.equal(manifestCompatible(manifest), true, 'obsidian-tasks minAppVersion 1.13.1 必须放行');
  assert.equal(verdict.malformed, false);
  assert.equal(verdict.requirement, '1.13.1', '提示文案要能点名插件侧要求');
});

check('伪造 minAppVersion 1.15.0 的插件判为 compatible=false,且文案两侧都能取到', () => {
  const manifest = manifestOf({ minAppVersion: '1.15.0' });
  const verdict = evaluateManifestCompat(manifest);
  assert.equal(manifestCompatible(manifest), false);
  // 运行期文案的两个插值点:宿主侧 = OBSIDIAN_API_COMPAT,插件侧 = verdict.requirement
  const text = OBSIDIAN_API_COMPAT + '|' + verdict.requirement;
  assert.equal(text, OBSIDIAN_API_COMPAT + '|1.15.0');
});

check('两处文案同一份来源:宿主侧与插件侧版本都在同一句里', () => {
  const { manifestCompatMessage } = manifestModule;
  const blocked = manifestCompatMessage(manifestOf({ minAppVersion: '1.15.0' }));
  assert.equal(blocked, '本应用模拟 Obsidian API ' + OBSIDIAN_API_COMPAT + '，该插件要求 1.15.0');
  const malformed = manifestCompatMessage(manifestOf({ minAppVersion: '1.x' }));
  assert.equal(malformed, '本应用模拟 Obsidian API ' + OBSIDIAN_API_COMPAT + '，该插件要求 1.x（版本声明无法解析）');
  assert.equal(manifestCompatMessage(manifestOf({ minAppVersion: '1.13.1' })), '');
});

check('isDesktopOnly 不参与版本闸门(该判据本轮不动)', () => {
  assert.equal(manifestCompatible(manifestOf({ minAppVersion: '1.13.1', isDesktopOnly: true })), true);
  assert.equal(manifestCompatible(manifestOf({ minAppVersion: '1.15.0', isDesktopOnly: true })), false);
});

// ---------------------------------------------------------------- 报告
console.log('');
console.log('| ' + ['minAppVersion', 'parsePluginManifest', 'requirement', 'compatible', 'malformed'].join(' | ') + ' |');
console.log('|' + ['---', '---', '---', '---', '---'].join('|') + '|');
for (const row of rows) {
  console.log('| ' + [row.input, row.parsed === '' ? '(空)' : row.parsed, row.requirement, String(row.compatible), String(row.malformed)].join(' | ') + ' |');
}
console.log('');
console.log('[manifest-compat] compat=' + OBSIDIAN_API_COMPAT + ' assertions=' + total + ' failed=' + failed);
if (failed > 0) { process.exitCode = 1; }
