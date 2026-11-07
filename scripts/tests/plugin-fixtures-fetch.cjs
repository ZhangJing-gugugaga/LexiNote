#!/usr/bin/env node
// 插件夹具：拉取源码 → 本地构建 → 产出 .fixtures-out/<id>/{manifest.json,main.js,styles.css}
//
// 为什么需要这个脚本：本机 github.com:443 不通，官方 Release 资产（.../releases/latest/download/main.js）
// 下载不了；codeload.github.com 与 raw.githubusercontent.com 可用。所以夹具只能"取源码 + 本地构建"。
// 纯 Node（无第三方依赖，除复用 tools/workspace-bundle/node_modules/esbuild 做打包）。
//
// 用法：
//   node scripts/tests/plugin-fixtures-fetch.cjs                 拉取 + 构建 + 校验，并生成 API 使用面报告
//   node scripts/tests/plugin-fixtures-fetch.cjs --check          只校验磁盘产物与 lock 里的 sha256 是否一致（不联网、不构建）
//   node scripts/tests/plugin-fixtures-fetch.cjs --only theme-minimal
//   node scripts/tests/plugin-fixtures-fetch.cjs --force          忽略 .fixtures-out/.cache 重拉重装
//   node scripts/tests/plugin-fixtures-fetch.cjs --update-lock    用本次实测结果回写 manifest.lock.json
//   node scripts/tests/plugin-fixtures-fetch.cjs --no-report      不生成 API 使用面报告
//
// 约定：第三方插件源码与产物一律落在 .fixtures-out/（已 gitignore），仓库里只留 manifest.lock.json。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'tools', 'plugins-fixtures');
const LOCK_PATH = path.join(FIXTURES_DIR, 'manifest.lock.json');
const REPORT_SCRIPT = path.join(FIXTURES_DIR, 'api-surface.cjs');
const OUT_DIR = path.join(ROOT, '.fixtures-out');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const ESBUILD_MODULE = path.join(ROOT, 'tools', 'workspace-bundle', 'node_modules', 'esbuild');

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const onlyIndex = argv.indexOf('--only');
const ONLY = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;

const CHECK_ONLY = FLAGS.has('--check');
const FORCE = FLAGS.has('--force');
const UPDATE_LOCK = FLAGS.has('--update-lock');
const NO_REPORT = FLAGS.has('--no-report');

function say(msg) {
  console.log(msg);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- 网络 ----------------------------------------------------------------

async function download(url, label) {
  const tries = 4;
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'lexinote-plugin-fixtures' },
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('响应为空');
      return buf;
    } catch (err) {
      lastError = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
  throw new Error('下载失败 ' + (label || url) + '：' + lastError.message);
}

// ---- zip（单层目录剥离，无第三方依赖）-----------------------------------

function unzipStripRoot(buf, destDir) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 解析失败：找不到中央目录结束记录');
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  let written = 0;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip 解析失败：中央目录项损坏');
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const parts = name.split('/').slice(1); // 去掉 codeload 的 <repo>-<sha>/ 顶层目录
    const relative = parts.join('/');
    if (!relative) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    const target = path.join(destDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written += 1;
  }
  if (written === 0) throw new Error('zip 解压后没有任何文件');
  return written;
}

// ---- 补丁 ----------------------------------------------------------------

function applyPatches(fx, srcDir) {
  for (const patch of fx.build.patches || []) {
    const file = path.join(srcDir, patch.file);
    if (!fs.existsSync(file)) throw new Error('补丁目标不存在：' + patch.file);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(patch.replace)) {
      say('  补丁已在位：' + patch.file);
      continue;
    }
    const at = text.indexOf(patch.find);
    if (at < 0) throw new Error('补丁锚点未找到：' + patch.file + ' :: ' + patch.find);
    if (text.indexOf(patch.find, at + 1) >= 0) throw new Error('补丁锚点不唯一：' + patch.file);
    fs.writeFileSync(file, text.slice(0, at) + patch.replace + text.slice(at + patch.find.length), 'utf8');
    say('  已应用补丁：' + patch.file + ' — ' + patch.why);
  }
}

// ---- 拉源码 --------------------------------------------------------------

async function materializeSource(fx) {
  const rootDir = path.join(CACHE_DIR, fx.id);
  const srcDir = path.join(rootDir, 'src');
  const stampPath = path.join(rootDir, 'stamp.json');

  if (!FORCE && fs.existsSync(stampPath) && fs.existsSync(srcDir)) {
    const stamp = readJson(stampPath);
    if (stamp.commit === fx.source.commit) {
      say('  复用已缓存的源码（commit ' + stamp.commit.slice(0, 7) + '）');
      return { srcDir, fresh: false };
    }
  }

  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });

  if (fx.source.archive) {
    say('  下载源码包 ' + fx.source.archive);
    const zip = await download(fx.source.archive, fx.id + ' 源码包');
    const files = unzipStripRoot(zip, srcDir);
    say('  解压 ' + files + ' 个文件');
  } else {
    for (const entry of fx.source.fetch) {
      const url = fx.source.raw + entry.path;
      say('  下载单文件 ' + url);
      const buf = await download(url, fx.id + '/' + entry.path);
      const target = path.join(srcDir, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    }
  }

  applyPatches(fx, srcDir);
  fs.writeFileSync(stampPath, JSON.stringify({ commit: fx.source.commit, fetchedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return { srcDir, fresh: true };
}

// ---- 构建 ----------------------------------------------------------------

// P4-006b(R39-B):宿主两轨(legacy 求值轨与沙箱轨)都按 fail-closed 拒绝外部模块
// ("依赖请随 main.js 打包"),所以声明了 build.sharedCm 的夹具把 @codemirror/* 一并打进
// main.js。但 CM6 双副本不会报错、只会让 ViewPlugin/StateField 静默失效,而 workspace 页经
// window.__lexiCmModules 注入的正是与编辑器同一份实例 —— 别名桩在加载期优先取宿主注册表,
// 注册表缺席(runtime 轨)才落到随包打包的副本。上游源码零改动,别名只在构建期生效。
const CM_SHARED_MODULES = ['@codemirror/state', '@codemirror/view', '@codemirror/language'];
const VENDORED_NODE_MODULES = path.join(ROOT, 'tools', 'workspace-bundle', 'node_modules');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cmSharedStubPlugin() {
  const alternatives = CM_SHARED_MODULES.map(escapeRegExp).join('|');
  return {
    name: 'lexi-cm-shared-or-bundled',
    setup(build) {
      build.onResolve({ filter: new RegExp('^(' + alternatives + ')$') }, (args) => {
        return { path: args.path, namespace: 'lexi-cm-stub' };
      });
      build.onLoad({ filter: /.*/, namespace: 'lexi-cm-stub' }, (args) => {
        const literal = JSON.stringify(args.path);
        return {
          contents: [
            "'use strict';",
            'var __lexiRegistry = typeof window !== "undefined" ? window.__lexiCmModules : null;',
            'module.exports = (__lexiRegistry && Object.prototype.hasOwnProperty.call(__lexiRegistry, ' + literal + ') && __lexiRegistry[' + literal + '])',
            '  ? __lexiRegistry[' + literal + ']',
            '  : require(' + JSON.stringify('lexi-cm-real:' + args.path) + ');',
            '',
          ].join('\n'),
          loader: 'js',
        };
      });
      build.onResolve({ filter: new RegExp('^lexi-cm-real:(' + alternatives + ')$') }, (args) => {
        // 直接落到包的 CJS 入口文件（@codemirror/* 的 main=dist/index.cjs）：
        // 目录形态的 onResolve 结果在 win32 上 esbuild 读目录会报 Incorrect function。
        const pkgDir = path.join(VENDORED_NODE_MODULES, args.path.slice('lexi-cm-real:'.length));
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        return { path: path.join(pkgDir, pkg.main || 'dist/index.cjs') };
      });
    },
  };
}

function resolveDefine(srcDir, spec) {
  if (spec.startsWith('package.json:')) {
    const field = spec.slice('package.json:'.length);
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
    if (!(field in pkg)) throw new Error('define 取不到 package.json 字段：' + field);
    return JSON.stringify(pkg[field]);
  }
  if (spec.startsWith('file:')) {
    const file = path.join(srcDir, spec.slice('file:'.length));
    if (!fs.existsSync(file)) throw new Error('define 取不到文件：' + spec);
    return JSON.stringify(fs.readFileSync(file, 'utf8'));
  }
  return JSON.stringify(spec);
}

async function buildEsbuild(fx, srcDir) {
  const esbuild = require(ESBUILD_MODULE);
  const defines = {};
  for (const [key, spec] of Object.entries(fx.build.define || {})) {
    defines[key] = resolveDefine(srcDir, spec);
  }
  const outfile = path.join(srcDir, fx.build.artifact);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const plugins = [];
  if (fx.build.sharedCm) { plugins.push(cmSharedStubPlugin()); }
  await esbuild.build({
    entryPoints: [path.join(srcDir, fx.build.entry)],
    bundle: true,
    format: fx.build.format || 'cjs',
    target: fx.build.target || 'es2018',
    platform: 'browser',
    external: fx.build.external || [],
    // vendoredNodePaths: 夹具源码树没有 node_modules,依赖解析落到仓库内 vendored 的
    // tools/workspace-bundle/node_modules(与 workspace 页宿主同一份 @codemirror 来源)。
    nodePaths: fx.build.vendoredNodePaths ? [VENDORED_NODE_MODULES] : [],
    // minifyWhitespace: 随包的第三方 dist(如 @codemirror/state)带 JSDoc 文本,产物里的
    // "from `from`." 会被 plugin-dist-audit 的 ESM from-正则当模块导入误报;压掉注释/空白,
    // 语义零变化,静态审核面保持干净。
    minifyWhitespace: fx.build.minifyWhitespace === true,
    define: defines,
    plugins,
    legalComments: 'none',
    logLevel: 'warning',
    outfile,
  });
  return outfile;
}

function runBuildCommand(fx, srcDir, args, label) {
  const res = spawnSync(args[0], args.slice(1), {
    cwd: srcDir,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  });
  if (res.error) throw new Error(label + ' 启动失败：' + res.error.message);
  if (res.status !== 0) {
    const tail = ((res.stdout || '') + (res.stderr || '')).split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
    throw new Error(label + ' 退出码 ' + res.status + '\n' + tail);
  }
  return res;
}

async function buildNpm(fx, srcDir) {
  const modules = path.join(srcDir, 'node_modules');
  if (FORCE || !fs.existsSync(modules)) {
    const installArgs = ['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', ...(fx.build.installArgs || [])];
    say('  ' + installArgs.join(' ') + '（禁用依赖的构建期脚本，跳过 lint 等前置步骤）');
    runBuildCommand(fx, srcDir, installArgs, 'npm install');
  } else {
    say('  复用已安装的 node_modules');
  }
  say('  ' + fx.build.run);
  runBuildCommand(fx, srcDir, fx.build.run.split(' '), fx.build.run);
  const artifact = path.join(srcDir, fx.build.artifact);
  if (!fs.existsSync(artifact)) throw new Error('构建结束但产物不存在：' + fx.build.artifact);

  const resolved = {};
  for (const name of fx.build.recordResolved || []) {
    const pkgFile = path.join(srcDir, 'node_modules', name, 'package.json');
    if (fs.existsSync(pkgFile)) resolved[name] = readJson(pkgFile).version;
  }
  return { artifact, resolved };
}

async function build(fx, srcDir) {
  if (fx.build.kind === 'none') return { artifact: null, resolved: {} };
  if (fx.build.kind === 'esbuild') {
    const esbuildVersion = readJson(path.join(ESBUILD_MODULE, 'package.json')).version;
    return { artifact: await buildEsbuild(fx, srcDir), resolved: { esbuild: esbuildVersion } };
  }
  if (fx.build.kind === 'npm') return buildNpm(fx, srcDir);
  throw new Error('未知构建方式：' + fx.build.kind);
}

// ---- 产物落盘 / 校验 -----------------------------------------------------

function stageArtifacts(fx, srcDir, builtArtifact) {
  const target = path.join(OUT_DIR, fx.id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fx.source.fetch) {
    const from = path.join(srcDir, entry.path);
    if (!fs.existsSync(from)) throw new Error('源文件缺失：' + entry.path);
    fs.copyFileSync(from, path.join(target, entry.as));
  }
  if (builtArtifact) fs.copyFileSync(builtArtifact, path.join(target, fx.build.outputFile || 'main.js'));
  for (const extra of fx.build.extraArtifacts || []) {
    const from = path.join(srcDir, extra.from);
    if (!fs.existsSync(from)) throw new Error('构建结束但附加产物不存在：' + extra.from);
    fs.copyFileSync(from, path.join(target, extra.as));
  }

  return collectArtifacts(target);
}

function collectArtifacts(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => {
      const buf = fs.readFileSync(path.join(dir, name));
      return { file: name, bytes: buf.length, sha256: sha256(buf) };
    });
}

function describeArtifacts(artifacts) {
  return (artifacts || []).map((a) => a.file + ' ' + a.bytes + 'B ' + a.sha256.slice(0, 16)).join(' | ');
}

function compareWithLock(fx, artifacts) {
  if (!fx.artifacts) return { state: 'unlocked', detail: 'lock 未记录产物指纹' };
  const disk = new Map((artifacts || []).map((a) => [a.file, a]));
  const lock = new Map(fx.artifacts.map((a) => [a.file, a]));
  const problems = [];
  for (const [file, want] of lock) {
    const got = disk.get(file);
    if (!got) {
      problems.push('缺文件 ' + file);
      continue;
    }
    if (got.sha256 !== want.sha256) problems.push(file + ' sha256 不一致（lock ' + want.sha256.slice(0, 16) + '，实际 ' + got.sha256.slice(0, 16) + '）');
    else if (got.bytes !== want.bytes) problems.push(file + ' 体积不一致');
  }
  for (const file of disk.keys()) if (!lock.has(file)) problems.push('多余文件 ' + file);
  return problems.length ? { state: 'mismatch', detail: problems.join('；') } : { state: 'ok', detail: '' };
}

// ---- 主流程 --------------------------------------------------------------

async function main() {
  if (FLAGS.has('--help') || FLAGS.has('-h')) {
    say('用法见脚本头部注释：node scripts/tests/plugin-fixtures-fetch.cjs [--check|--force|--update-lock|--only <id>|--no-report]');
    return 0;
  }
  if (!fs.existsSync(LOCK_PATH)) {
    say('✗ 缺少 ' + rel(LOCK_PATH));
    return 1;
  }
  const lock = readJson(LOCK_PATH);
  const fixtures = lock.fixtures.filter((fx) => !ONLY || fx.id === ONLY);
  if (fixtures.length === 0) {
    say('✗ --only ' + ONLY + ' 没有匹配的夹具');
    return 1;
  }

  say('夹具清单：' + rel(LOCK_PATH) + '（契约基线 ' + (lock.contractBaseline || '未知') + '）');
  say('产物目录：' + rel(OUT_DIR) + '（已 gitignore，不进仓库）');
  say('模式：' + (CHECK_ONLY ? '只校验（--check）' : '拉取+构建') + (FORCE ? ' + 强制重来' : '') + (UPDATE_LOCK ? ' + 回写 lock' : ''));
  say('');

  const results = [];
  let failed = 0;

  for (const fx of fixtures) {
    say('▌ ' + fx.id + '（' + fx.role + '）' + fx.source.repo + '@' + fx.source.commit.slice(0, 7));
    try {
      let artifacts;
      let resolved = {};
      if (CHECK_ONLY) {
        artifacts = collectArtifacts(path.join(OUT_DIR, fx.id));
        if (!artifacts) throw new Error('产物目录不存在，先跑一次不带 --check 的拉取构建');
      } else {
        const { srcDir } = await materializeSource(fx);
        const built = await build(fx, srcDir);
        resolved = built.resolved;
        artifacts = stageArtifacts(fx, srcDir, built.artifact);
      }
      const verdict = UPDATE_LOCK ? { state: 'updated', detail: '' } : compareWithLock(fx, artifacts);
      if (verdict.state === 'mismatch') failed += 1;
      if (verdict.state === 'unlocked' && !UPDATE_LOCK) failed += 1;
      say('  产物：' + describeArtifacts(artifacts));
      if (verdict.state === 'mismatch') say('  ✗ 与 lock 不一致：' + verdict.detail);
      else if (verdict.state === 'unlocked') say('  ✗ lock 里没有产物指纹；跑 --update-lock 固化（说明这是首次基线）');
      else if (verdict.state === 'updated') say('  ✓ 已写入 lock（' + artifacts.length + ' 个文件）');
      else say('  ✓ 与 lock 一致');
      say('');
      results.push({ id: fx.id, artifacts, resolved, verdict });
    } catch (err) {
      failed += 1;
      say('  ✗ ' + err.message.split('\n').join('\n  '));
      say('');
      results.push({ id: fx.id, error: err.message });
    }
  }

  if (UPDATE_LOCK) {
    for (const result of results) {
      if (!result.artifacts) continue;
      const fx = lock.fixtures.find((item) => item.id === result.id);
      fx.artifacts = result.artifacts;
      if (Object.keys(result.resolved).length) fx.build.resolved = result.resolved;
    }
    lock.updatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    say('lock 已回写：' + rel(LOCK_PATH));
    say('');
  }

  if (!CHECK_ONLY && !NO_REPORT && failed === 0) {
    say('▌ API 使用面报告');
    const res = spawnSync(process.execPath, [REPORT_SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(res.stdout || '');
    if (res.status !== 0) {
      process.stderr.write(res.stderr || '');
      say('✗ 报告生成失败');
      failed += 1;
    }
  }

  say(failed === 0 ? '✓ 夹具全部就绪（' + results.length + ' 件）' : '✗ ' + failed + ' 件夹具未就绪');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('✗ ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
