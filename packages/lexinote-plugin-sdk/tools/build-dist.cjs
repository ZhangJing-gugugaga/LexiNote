#!/usr/bin/env node
// P3-001 · SDK dist 构建器:src/*.ts → dist/*.js + *.d.ts(编译产物,入口不再是源码 ts)。
// 单一真源不变:src/ 由 sync-sdk.cjs 从宿主契约生成;本脚本只做编译,不产生第二份逻辑。
// typescript 解析顺序:LEXI_TYPESCRIPT → 已知候选(与 tools/plugin-dist/release-gate.cjs 同列)
// → 失败即红(不发半成品)。npm pack 经 prepack 自动走本脚本,产物可离线安装(P3-001 验收)。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SDK = path.resolve(__dirname, '..');
const SRC = path.join(SDK, 'src');
const DIST = path.join(SDK, 'dist');

// 与 tools/plugin-dist/release-gate.cjs 的 TYPESCRIPT_CANDIDATES 保持同一候选列(仓库惯例:
// 各门禁各自解析,候选一致即可,新增机器时同步两处)。
const TYPESCRIPT_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  path.join(SDK, '..', '..', 'node_modules', 'typescript'),
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript',
  'C:/Program Files/Huawei/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript'
];

function resolveTypescript() {
  for (const candidate of TYPESCRIPT_CANDIDATES) {
    if (candidate) {
      try { require(candidate); return candidate; } catch (error) { void error; }
    }
  }
  return '';
}

function fail(message) { console.error('sdk-build error: ' + message); process.exit(1); }

const tsPath = resolveTypescript();
if (!tsPath) {
  fail('typescript 不可用——设 LEXI_TYPESCRIPT 指向 typescript 模块(或落在候选路径)');
}
const ts = require(tsPath);

if (!fs.existsSync(path.join(SRC, 'index.ts'))) { fail('src/index.ts 缺失(先跑 tools/sync-sdk.cjs)'); }

// 干净重构建:不残留上一次的过期产物。
fs.rmSync(DIST, { recursive: true, force: true });

const options = {
  outDir: DIST,
  rootDir: SRC,
  declaration: true,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  strict: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
  skipLibCheck: true,
  newLine: ts.NewLineKind.Lf
};
const program = ts.createProgram([path.join(SRC, 'index.ts')], options);
const preEmit = ts.getPreEmitDiagnostics(program).filter((d) => d.category === 1);
const emit = program.emit();
const emitDiags = emit.diagnostics.filter((d) => d.category === 1);
const allDiags = preEmit.concat(emitDiags);
if (allDiags.length > 0 || emit.emitSkipped) {
  const detail = allDiags.slice(0, 4).map((d) => {
    const file = d.file ? path.relative(SDK, d.file.fileName) + ':' + (d.file.getLineAndCharacterOfPosition(d.start).line + 1) : '<global>';
    return file + ' ' + ts.flattenDiagnosticMessageText(d.messageText, ' ');
  }).join(' | ');
  fail('类型错误(' + allDiags.length + '): ' + detail);
}

// 产物完整性:入口 js + d.ts 双齐,且 d.ts 与源码面一致(index 的再导出全部落在产物里)。
const expected = ['index.js', 'index.d.ts', 'contract.js', 'contract.d.ts', 'capabilities.js', 'capabilities.d.ts'];
const missing = expected.filter((rel) => !fs.existsSync(path.join(DIST, rel)));
if (missing.length > 0) { fail('dist 产物缺失: ' + missing.join(', ')); }

const indexJs = fs.readFileSync(path.join(DIST, 'index.js'), 'utf8');
const indexDts = fs.readFileSync(path.join(DIST, 'index.d.ts'), 'utf8');
for (const anchor of ['API_VERSION', 'SDK_METHODS', 'methodsOf', 'capabilityTags', 'normalizeCapabilityHost']) {
  if (indexJs.indexOf(anchor) < 0) { fail('dist/index.js 缺锚点 ' + anchor); }
  if (indexDts.indexOf(anchor) < 0) { fail('dist/index.d.ts 缺锚点 ' + anchor); }
}
// 入口非源码:dist 里不允许出现 .ts 直拷(main/types 由 package.json 指向 dist,这里防误拷源码)。
const distFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); } else { distFiles.push(path.relative(DIST, full)); }
  }
})(DIST);
const strayTs = distFiles.filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.d.ts'));
if (strayTs.length > 0) { fail('dist 混入源码 ts: ' + strayTs.join(', ')); }

const surface = JSON.parse(fs.readFileSync(path.join(SDK, 'schema', 'api-surface.json'), 'utf8'));
console.log('sdk-build: dist=' + DIST);
console.log('sdk-build: files=' + distFiles.length + ' (' + distFiles.slice().sort().join(', ') + ')');
console.log('sdk-build: apiVersion=' + surface.apiVersion + ' methods=' + surface.methods.length +
  ' typescript=' + path.basename(path.dirname(path.dirname(tsPath))));
console.log('sdk-build: PASS');
