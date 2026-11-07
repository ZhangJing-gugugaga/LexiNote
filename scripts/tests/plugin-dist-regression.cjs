#!/usr/bin/env node
// Offline regression for the distribution track. No device, no network.
//
//   node scripts/tests/plugin-dist-regression.cjs
//
// Layers:
//   1. manifest v1/v2 parsing + capability decisions (ArkTS, transpiled and loaded in a vm)
//   2. index schema v1: the ArkTS parser and the Node validator must reach the same verdict
//   3. install/upgrade/rollback/uninstall state machine on a fake in-memory filesystem
//   4. the same lifecycle on a real temp directory through SystemPluginStorageIo,
//      including the byte-tampered package that must stop with integrity_mismatch
//   5. structural wiring assertions on LexiPluginRuntime.ets (capability gate in front of
//      the network/fs handlers, uninstall/rollback/fetchMarketIndex exported)
//   6. static audit allowlist: @codemirror/* is legal, left-pad is not
//   7. P1-009(R33) SEC runtime gates 行为级: fsGate/vaultReadGate/storageQuotaGate/
//      withTimeout 真跑(SEC-005/006/008/009/011/012 的宿主端正/负用例)
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'core');
const TOOLS = path.join(REPO_ROOT, 'tools', 'plugin-dist');
const { writeZip, readZip } = require(path.join(TOOLS, 'zip-store.cjs'));
const validator = require(path.join(TOOLS, 'market-index-v1.cjs'));
const audit = require(path.join(REPO_ROOT, 'scripts', 'tests', 'plugin-dist-audit.cjs'));

const TS_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  path.join(REPO_ROOT, 'oh_modules', 'typescript'),
  'typescript'
].filter((candidate) => Boolean(candidate));
function loadTypeScript() {
  for (const candidate of TS_CANDIDATES) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error('找不到 typescript：请设置 LEXI_TYPESCRIPT');
}
const ts = loadTypeScript();

// --- kit stubs ------------------------------------------------------------
// SystemPluginStorageIo is exercised for real: the fileIo stub is a thin node:fs adapter and
// zlib.decompressFile unpacks with zip-store, so the production path runs unmodified.
function makeFileIo() {
  const OpenMode = { READ_ONLY: 0, WRITE_ONLY: 1, READ_WRITE: 2, CREATE: 64, TRUNC: 512 };
  return {
    OpenMode,
    accessSync(target) { try { fs.accessSync(target); return true; } catch { return false; } },
    statSync(target) { const stat = fs.statSync(target); return { size: stat.size, isDirectory: () => stat.isDirectory() }; },
    mkdirSync(target, recursive) { fs.mkdirSync(target, { recursive: Boolean(recursive) }); },
    listFile(target) { return Promise.resolve(fs.readdirSync(target)); },
    listFileSync(target) { return fs.readdirSync(target); },
    readTextSync(target) { return fs.readFileSync(target, 'utf8'); },
    openSync(target, mode) { return { fd: fs.openSync(target, mode === OpenMode.READ_ONLY ? 'r' : 'w+') }; },
    readSync(fd, buffer) { return fs.readSync(fd, Buffer.from(buffer), 0, buffer.byteLength, null); },
    writeSync(fd, text) { return fs.writeSync(fd, typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text)); },
    closeSync(file) { fs.closeSync(file.fd); },
    copyFileSync(source, dest) { fs.copyFileSync(source, dest); },
    renameSync(source, dest) { fs.renameSync(source, dest); },
    unlinkSync(target) { fs.unlinkSync(target); },
    rmdirSync(target) { fs.rmSync(target, { recursive: true, force: true }); },
    removeTree(target) { fs.rmSync(target, { recursive: true, force: true }); },
    listDirSync(target) { return fs.readdirSync(target); }
  };
}

function makeKitStubs() {
  const fileIo = makeFileIo();
  return {
    '@kit.AbilityKit': { common: {} },
    '@kit.CoreFileKit': { fileIo },
    '@kit.BasicServicesKit': {
      zlib: {
        decompressFile(zipPath, dest) {
          fs.mkdirSync(dest, { recursive: true });
          for (const entry of readZip(fs.readFileSync(zipPath))) {
            const target = path.join(dest, entry.name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, entry.data);
          }
          return Promise.resolve();
        }
      }
    },
    '@kit.CryptoArchitectureKit': {
      cryptoFramework: {
        createMd(algorithm) {
          const hash = crypto.createHash(String(algorithm).toLowerCase().replace('sha256', 'sha256'));
          return {
            update(input) { hash.update(Buffer.from(input.data)); return Promise.resolve(); },
            digest() { return Promise.resolve({ data: new Uint8Array(hash.digest()) }); }
          };
        }
      }
    }
  };
}

// P1-009(R33):装载 LexiPluginRuntime.ets 这类重依赖模块时,未显式桩化的 @kit/@ohos
// 模块用递归 no-op 混合代理兜底:属性访问与函数调用都返回新桩(hilog.error(...) 这类
// 「属性链后调用」可用)。显式 kits 仍优先;此前未登记的 kit 会直接 require 抛错,所以
// 该兜底只扩大可装载面,不改变任何既有判定。
const autoKitStubCache = new Map();
function autoKitStub(name) {
  if (autoKitStubCache.has(name)) { return autoKitStubCache.get(name); }
  const hybrid = new Proxy(function () {}, {
    get(target, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === 'constructor') { return undefined; }
      return autoKitStub(name + '.' + String(prop));
    },
    apply() { return autoKitStub(name + '()'); }
  });
  autoKitStubCache.set(name, hybrid);
  return hybrid;
}

function loadEts(spec, kits) {
  const target = path.resolve(CORE, spec + '.ets');
  const js = ts.transpileModule(fs.readFileSync(target, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const cache = new Map();
  const requireShim = (name) => {
    if (kits[name]) { return kits[name]; }
    if (name.startsWith('.')) {
      const resolved = path.resolve(path.dirname(target), name);
      const key = resolved.replace(/\.ets$/, '');
      if (cache.has(key)) { return cache.get(key); }
      const exports = loadEts(key.slice(CORE.length + 1), kits);
      cache.set(key, exports);
      return exports;
    }
    if (/^@kit\.|^@ohos\./.test(name)) { return autoKitStub(name); }
    return require(name);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: target })(requireShim, module, module.exports);
  return module.exports;
}

// P1-009(R33) SEC 行为级用例的共享装载:LexiPluginRuntime.ets 只转译装载一次,两个
// SEC 用例组(fs/storage/超时 gate 与超时语义)复用同一份编译产物。
let secRuntimeMod = null;
function loadSecRuntime() {
  if (secRuntimeMod === null) { secRuntimeMod = loadEts('plugin/LexiPluginRuntime', kits); }
  return secRuntimeMod;
}

const kits = makeKitStubs();
const manifestMod = loadEts('plugin/LexiPluginManifest', kits);
const marketMod = loadEts('plugin/LexiPluginMarketModel', kits);
const installerMod = loadEts('plugin/LexiPluginInstaller', kits);

// --- fake in-memory filesystem -------------------------------------------
// Path-prefix map: a directory exists as soon as something lives under it.
function makeFakeIo() {
  const files = new Map();
  const dirs = new Set(['/']);
  const parentOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/';
  const mkdirp = (p) => { let cur = p; while (cur && cur !== '/' && !dirs.has(cur)) { dirs.add(cur); cur = parentOf(cur); } };
  const childrenOf = (p) => {
    const prefix = p === '/' ? '/' : p + '/';
    const names = new Set();
    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(prefix) || key === p) { continue; }
      const rest = key.slice(prefix.length);
      if (rest.length === 0) { continue; }
      names.add(rest.split('/')[0]);
    }
    return [...names];
  };
  const io = {
    tree: { files, dirs },
    exists(p) { return files.has(p) || dirs.has(p); },
    isDirectory(p) { return dirs.has(p); },
    mkdirp(p) { mkdirp(p); },
    list(p) { return Promise.resolve(childrenOf(p)); },
    listSync(p) { return childrenOf(p); },
    readText(p) { assert.ok(files.has(p), 'readText 缺失: ' + p); return files.get(p).toString('utf8'); },
    writeText(p, content) { mkdirp(parentOf(p)); files.set(p, Buffer.from(content, 'utf8')); },
    copyFile(source, dest) { assert.ok(files.has(source), 'copyFile 源缺失: ' + source); mkdirp(parentOf(dest)); files.set(dest, Buffer.from(files.get(source))); },
    copyTree(source, dest) {
      for (const name of childrenOf(source)) {
        const src = source + '/' + name;
        const dst = dest + '/' + name;
        if (dirs.has(src)) { io.copyTree(src, dst); } else { io.copyFile(src, dst); }
      }
      return Promise.resolve();
    },
    removeTree(p) {
      for (const key of [...files.keys()]) { if (key === p || key.startsWith(p + '/')) { files.delete(key); } }
      for (const key of [...dirs]) { if (key === p || key.startsWith(p + '/')) { dirs.delete(key); } }
    },
    sha256File(p) { assert.ok(files.has(p), 'sha256File 缺失: ' + p); return Promise.resolve(crypto.createHash('sha256').update(files.get(p)).digest('hex')); },
    fileSize(p) { return files.has(p) ? files.get(p).length : 0; },
    sha256FileSync(p) { return files.has(p) ? crypto.createHash('sha256').update(files.get(p)).digest('hex') : ''; }
  }
  return io;
}

// --- package fixtures ----------------------------------------------------
const V1_MANIFEST = {
  id: 'legacy-plugin', name: 'Legacy Plugin', version: '1.0.0', author: 'legacy',
  minAppVersion: '0.9.0', description: 'v1 清单，没有任何新字段', authorUrl: 'https://example.com', isDesktopOnly: false
};
const V2_MANIFEST = {
  id: 'legacy-plugin', name: 'Legacy Plugin', version: '1.1.0', author: 'legacy',
  description: 'v2 清单', minApiVersion: '1.0.0', isDesktopOnly: false,
  capabilities: { network: ['api.example.com', '*.cdn.example.com'], fs: true, clipboard: true }
};
const V3_MANIFEST = {
  id: 'legacy-plugin', name: 'Legacy Plugin', version: '9.9.9', author: 'legacy', minApiVersion: '9.9.9',
  capabilities: { network: [], fs: true, clipboard: true }
};

function writePackage(io, root, manifest, mainJs) {
  io.mkdirp(root);
  io.writeText(root + '/manifest.json', JSON.stringify(manifest));
  if (mainJs) { io.writeText(root + '/main.js', mainJs); }
  return root;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

// --- 1. manifest parsing -------------------------------------------------
test('v1 manifest 仍能装载：新字段走默认值', () => {
  const manifest = manifestMod.parsePluginManifest(JSON.stringify(V1_MANIFEST));
  assert.equal(manifest.id, 'legacy-plugin');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.capabilitiesDeclared, false);
  assert.deepEqual([...manifest.capabilities.network], []);
  assert.equal(manifest.capabilities.fs, false);
  assert.equal(manifest.capabilities.clipboard, false);
  assert.equal(manifest.minApiVersion, '0.0.0');
  assert.equal(manifest.sha256, '');
});

test('v2 manifest 解析能力声明并做主机名归一化', () => {
  const manifest = manifestMod.parsePluginManifest(JSON.stringify(V2_MANIFEST));
  assert.equal(manifest.capabilitiesDeclared, true);
  assert.deepEqual([...manifest.capabilities.network], ['api.example.com', '*.cdn.example.com']);
  assert.equal(manifest.capabilities.fs, true);
  assert.equal(manifest.capabilities.clipboard, true);
  assert.equal(manifestApiCompatibleOk(manifest), true);
});

function manifestApiCompatibleOk(manifest) {
  return manifestMod.manifestApiCompatible(manifest);
}

test('非法 id / 缺失字段 → 解析拒绝（安装器再映射成 manifest_invalid）', () => {
  for (const bad of [
    { id: 'Bad_ID', name: 'x', version: '1.0.0', author: 'a' },
    { id: 'ok', name: 'x', author: 'a' },
    { name: 'x', version: '1.0.0', author: 'a' }
  ]) {
    assert.throws(() => manifestMod.parsePluginManifest(JSON.stringify(bad)), /插件/, '应拒绝: ' + JSON.stringify(bad));
  }
  assert.throws(() => manifestMod.parsePluginManifest('not an object'), Error, '非 JSON 也必须抛错而不是返回空清单');
});

// --- 2. capability decisions --------------------------------------------
test('network：声明了能通', () => {
  const manifest = manifestMod.parsePluginManifest(JSON.stringify(V2_MANIFEST));
  const decision = manifestMod.checkNetworkCapability(manifest, 'https://api.example.com/v1/ping');
  assert.equal(decision.allowed, true);
  const wildcard = manifestMod.checkNetworkCapability(manifest, 'https://static.cdn.example.com/a.js');
  assert.equal(wildcard.allowed, true);
});

test('network：没声明被拒（capability_denied，不是静默失败）', () => {
  const manifest = manifestMod.parsePluginManifest(JSON.stringify(V2_MANIFEST));
  const decision = manifestMod.checkNetworkCapability(manifest, 'https://evil.example.com/collect');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'capability_denied');
  assert.equal(decision.host, 'evil.example.com');
  const partial = manifestMod.checkNetworkCapability(manifest, 'https://api.example.com.evil.tld/x');
  assert.equal(partial.allowed, false, '不能把声明的主机名当字符串前缀用');
});

test('network：v1 清单与未知归属 fail-closed', () => {
  const legacy = manifestMod.parsePluginManifest(JSON.stringify(V1_MANIFEST));
  assert.equal(manifestMod.checkNetworkCapability(legacy, 'https://api.example.com/x').code, 'capability_denied');
  assert.equal(manifestMod.checkNetworkCapability(null, 'https://api.example.com/x').code, 'capability_denied');
});

test('fs / clipboard：v2 严格，v1 沿用放行，未声明拒绝', () => {
  const v2 = manifestMod.parsePluginManifest(JSON.stringify(V2_MANIFEST));
  assert.equal(manifestMod.checkFsCapability(v2).allowed, true);
  assert.equal(manifestMod.checkClipboardCapability(v2).allowed, true);
  const denied = manifestMod.parsePluginManifest(JSON.stringify({
    id: 'no-caps', name: 'NoCaps', version: '1.0.0', author: 'a',
    capabilities: { network: [], fs: false, clipboard: false }
  }));
  assert.equal(manifestMod.checkFsCapability(denied).code, 'capability_denied');
  assert.equal(manifestMod.checkClipboardCapability(denied).code, 'capability_denied');
  const legacy = manifestMod.parsePluginManifest(JSON.stringify(V1_MANIFEST));
  assert.equal(manifestMod.checkFsCapability(legacy).allowed, true, 'v1 没有能力声明，保持旧行为');
  assert.equal(manifestMod.checkClipboardCapability(legacy).code, 'capability_denied');
});

test('版本比较与 minApiVersion 判定', () => {
  assert.equal(manifestMod.comparePluginVersion('1.10.0', '1.9.9'), 1);
  assert.equal(manifestMod.comparePluginVersion('1.0.0', '1.0.0'), 0);
  assert.equal(manifestMod.comparePluginVersion('0.9.0', '1.0.0'), -1);
  const tooNew = manifestMod.parsePluginManifest(JSON.stringify(V3_MANIFEST));
  assert.equal(manifestMod.manifestApiCompatible(tooNew), false);
});

// --- 3. index schema parity ---------------------------------------------
const VALID_INDEX = {
  schemaVersion: 1,
  plugins: [{
    id: 'demo-plugin', name: 'Demo', version: '1.0.0', author: 'a',
    minApiVersion: '1.0.0', isDesktopOnly: false,
    sha256: 'a'.repeat(64), zipUrl: 'https://example.com/demo.zip', repo: 'a/demo',
    description: 'd', capabilities: { network: ['example.com'], fs: true, clipboard: false }
  }]
};
const ZCODE_INDEX = {
  name: 'LexiNote 插件市场', owner: 'zcode', unlistedPlugins: [], description: 'x',
  plugins: [{ name: 'view-calendar', source: { source: 'url', type: 'zip', url: 'https://x/a.zip', sha256: 'b'.repeat(64), path: 'main.js' }, componentTypes: ['view'] }]
};
const INDEX_CASES = [
  ['合法 v1 索引', JSON.stringify(VALID_INDEX), true, ''],
  ['ZCode 形状必须被拒绝', JSON.stringify(ZCODE_INDEX), false, 'legacy_zcode_rejected'],
  ['裸数组旧形状仍收（带警告）', JSON.stringify([{ id: 'a', name: 'A' }]), true, ''],
  ['{plugins} 无 schemaVersion 仍收（带警告）', JSON.stringify({ plugins: [{ id: 'b', name: 'B' }] }), true, ''],
  ['schemaVersion 2 拒绝', JSON.stringify({ schemaVersion: 2, plugins: VALID_INDEX.plugins }), false, 'unsupported_schema_version'],
  ['缺 sha256 拒绝', JSON.stringify({ schemaVersion: 1, plugins: [{ ...VALID_INDEX.plugins[0], sha256: undefined }] }), false, 'index_invalid'],
  ['sha256 大写拒绝', JSON.stringify({ schemaVersion: 1, plugins: [{ ...VALID_INDEX.plugins[0], sha256: 'A'.repeat(64) }] }), false, 'index_invalid'],
  ['zipUrl 非 http(s) 拒绝', JSON.stringify({ schemaVersion: 1, plugins: [{ ...VALID_INDEX.plugins[0], zipUrl: 'ftp://example.com/a.zip' }] }), false, 'index_invalid'],
  ['id 大写拒绝', JSON.stringify({ schemaVersion: 1, plugins: [{ ...VALID_INDEX.plugins[0], id: 'Demo' }] }), false, 'index_invalid'],
  ['坏 JSON 拒绝', '{', false, 'index_invalid']
];

test('索引 v1：ArkTS 解析器与 Node 校验器逐例一致', () => {
  for (const [label, text, expectOk, expectCode] of INDEX_CASES) {
    const ark = marketMod.parseMarketIndexResult(text);
    const node = validator.parseIndex(text);
    assert.equal(ark.ok, node.ok, label + ': ok 不一致 (ark=' + ark.ok + ' node=' + node.ok + ')');
    assert.equal(ark.ok, expectOk, label + ': 期望 ok=' + expectOk + '，实际 ' + ark.ok + ' (' + ark.code + ' ' + ark.message + ')');
    if (!expectOk) {
      assert.equal(ark.code, expectCode, label + ': ArkTS code');
      assert.equal(node.code, expectCode, label + ': Node code');
    }
    assert.equal(ark.entries.length, node.entries.length, label + ': 条目数不一致');
  }
});

test('信任闸门：isTrustedInstallHash 只认 64 位小写十六进制（RFC P0-04 整改）', () => {
  assert.equal(marketMod.isTrustedInstallHash('a'.repeat(64)), true);
  assert.equal(marketMod.isTrustedInstallHash('A'.repeat(64)), false);
  assert.equal(marketMod.isTrustedInstallHash(''), false);
  assert.equal(marketMod.isTrustedInstallHash('deadbeef'), false);
  assert.equal(marketMod.isTrustedInstallHash('a'.repeat(63) + 'g'), false);
});

test('远程安装信任闸门已接线：宿主在下载前拦截，UI 复用同一判定', () => {
  const runtimeText = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginRuntime.ets'), 'utf8');
  const gate = runtimeText.slice(runtimeText.indexOf('async installFromUrl('));
  assert.match(gate, /if \(!isTrustedInstallHash\(expectedSha256\)\) \{/,
    'installFromUrl 必须拦截空/非法哈希(空哈希在 verifyPackageHash 里是 fail-open)');
  assert.ok(gate.indexOf('isTrustedInstallHash') < gate.indexOf('client.request('),
    '信任闸门必须排在网络下载之前');
  const sheetText = fs.readFileSync(
    path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'plugin', 'LexiPluginMarketSheet.ets'), 'utf8');
  assert.match(sheetText, /isTrustedInstallHash\(entry\.sha256\)/, '市场 UI 必须复用同一判定，而不是各写一份');
});

test('导出索引能被两边同时接受，且 ZCode 旧文件确实会被客户端拒绝', () => {
  const exported = path.join(REPO_ROOT, 'exports', 'market-index-v1.json');
  if (fs.existsSync(exported)) {
    const text = fs.readFileSync(exported, 'utf8');
    assert.equal(marketMod.parseMarketIndexResult(text).ok, true, '导出索引必须被客户端接受');
    assert.equal(validator.parseIndex(text).ok, true, '导出索引必须通过共享校验');
  }
  const legacy = path.join(REPO_ROOT, 'exports', 'cdn-market.json');
  if (fs.existsSync(legacy)) {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const body = raw && raw.deprecated ? raw.legacy : raw;
    const verdict = marketMod.parseMarketIndexResult(JSON.stringify(body));
    assert.equal(verdict.ok, false, 'ZCode 索引不能被静默丢弃成 0 条，必须显式拒绝');
    assert.equal(verdict.code, 'legacy_zcode_rejected');
  }
});

test('发布镜像索引三方一致(P5-006)：仓库 CI 校验器 = 共享校验器 = 客户端解析器', () => {
  const indexPath = path.join(REPO_ROOT, 'tools', 'lexinote-releases', 'community-plugins.json');
  const text = fs.readFileSync(indexPath, 'utf8');
  const ark = marketMod.parseMarketIndexResult(text);
  assert.equal(ark.ok, true, '发布镜像必须被客户端接受: ' + ark.code + ' ' + ark.message);
  assert.equal(ark.schemaVersion, 1, '发布镜像必须走严格 v1 口径(裸数组已停用)');
  assert.equal(ark.warnings.length, 0, 'v1 索引不应产生旧版警告');
  assert.equal(validator.parseIndex(text).ok, true, '发布镜像必须通过共享 Node 校验');
  // 钉死"能过发布仓 CI ⇒ 客户端必可安装"：直接跑本仓自己的 validate.mjs(离线口径)。
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'lexinote-releases', 'scripts', 'validate.mjs')], { stdio: 'pipe' });
});

// --- 4. state machine on the fake filesystem ----------------------------
async function fakeLifecycle() {
  const io = makeFakeIo();
  const installer = new installerMod.LexiPluginInstaller({ cacheDir: '/cache' }, '/plugins', io);
  const options = () => ({});

  writePackage(io, '/src/v1', V1_MANIFEST, 'module.exports={v:1}');
  const first = await installer.installExtracted('/src/v1', options());
  assert.equal(first.ok, true, '首次安装应成功: ' + first.code + ' ' + first.message);
  assert.equal(first.version, '1.0.0');
  assert.equal(io.readText('/plugins/legacy-plugin/manifest.json'), JSON.stringify(V1_MANIFEST));
  assert.equal(io.readText('/plugins/legacy-plugin/main.js'), 'module.exports={v:1}');
  assert.equal(io.readText('/plugins/legacy-plugin/current.json').includes('1.0.0'), true);
  assert.equal(io.exists('/plugins/legacy-plugin/.versions/1.0.0/main.js'), true);

  io.writeText('/plugins/legacy-plugin/data.json', '{"note":"用户数据"}');

  writePackage(io, '/src/v2', V2_MANIFEST, 'module.exports={v:2}');
  // T4.4(§9.5):v1→v2 引入新权限声明,未批准必须拒绝;批准(grantApproved)后放行。
  const blockedUpgrade = await installer.installExtracted('/src/v2', options());
  assert.equal(blockedUpgrade.ok, false, '未批准新权限的升级应拒绝: ' + blockedUpgrade.code);
  assert.equal(blockedUpgrade.code, 'ERR_PERMISSION_REGRANT_REQUIRED',
    '拒绝码应为 ERR_PERMISSION_REGRANT_REQUIRED: ' + blockedUpgrade.code);
  const upgrade = await installer.installExtracted('/src/v2', { grantApproved: true });
  assert.equal(upgrade.ok, true, '批准后升级应成功: ' + upgrade.code + ' ' + upgrade.message);
  assert.equal(upgrade.version, '1.1.0');
  assert.equal(upgrade.previousVersion, '1.0.0');
  assert.equal(io.readText('/plugins/legacy-plugin/main.js'), 'module.exports={v:2}');
  assert.equal(io.readText('/plugins/legacy-plugin/data.json'), '{"note":"用户数据"}', '升级不得碰 data.json');
  assert.equal(io.readText('/plugins/legacy-plugin/.versions/1.0.0/main.js'), 'module.exports={v:1}', '旧版本必须留快照');
  assert.equal(installer.currentVersion('legacy-plugin'), '1.1.0');

  const rollback = await installer.rollbackPlugin('legacy-plugin');
  assert.equal(rollback.ok, true, '回滚应成功: ' + rollback.code + ' ' + rollback.message);
  assert.equal(rollback.version, '1.0.0');
  assert.equal(io.readText('/plugins/legacy-plugin/main.js'), 'module.exports={v:1}', '回滚必须真的换回旧代码');
  assert.equal(io.readText('/plugins/legacy-plugin/data.json'), '{"note":"用户数据"}', '回滚不得碰 data.json');
  assert.equal(installer.readPointer('legacy-plugin').previousVersion, '1.1.0');

  const second = await installer.rollbackPlugin('legacy-plugin');
  assert.equal(second.ok, true, '来回回滚应可用');
  assert.equal(second.version, '1.1.0');

  const downgrade = await installer.installExtracted('/src/v1', options());
  assert.equal(downgrade.ok, false, '降级必须被拦');
  assert.equal(downgrade.code, 'downgrade_blocked');
  assert.equal(installer.currentVersion('legacy-plugin'), '1.1.0');

  writePackage(io, '/src/v3', V3_MANIFEST, 'module.exports={v:3}');
  const tooNew = await installer.installExtracted('/src/v3', options());
  assert.equal(tooNew.code, 'min_api_unsatisfied');
  assert.equal(installer.currentVersion('legacy-plugin'), '1.1.0');

  writePackage(io, '/src/broken', { ...V2_MANIFEST, version: '1.2.0' }, '');
  const broken = await installer.installExtracted('/src/broken', options());
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'install_failed');
  const staging = [...io.tree.dirs].filter((dir) => dir.includes('.staging-'));
  assert.deepEqual(staging, [], '失败不得留下 staging 目录');
  assert.equal(installer.currentVersion('legacy-plugin'), '1.1.0', '失败不得改指针');

  const uninstall = installer.uninstallPlugin('legacy-plugin');
  assert.equal(uninstall.ok, true, '卸载应成功: ' + uninstall.code + ' ' + uninstall.message);
  assert.equal(io.exists('/plugins/legacy-plugin'), false, '卸载后插件目录必须消失（重启不复活）');
  const trash = [...io.tree.files.keys()].filter((key) => key.startsWith('/plugins/.trash/'));
  assert.ok(trash.some((key) => key.endsWith('/data.json')), 'data.json 必须随目录留在 trash 里可恢复');
  assert.ok(trash.some((key) => key.endsWith('/uninstall.json')), '卸载应留下可审计的记录');
  assert.equal(installer.uninstallPlugin('legacy-plugin').code, 'uninstall_failed', '重复卸载要报错');
}
test('假文件系统：安装→升级→回滚→卸载状态机', fakeLifecycle);

test('假文件系统：sha256 不符 → integrity_mismatch 且中止在下载校验阶段', async () => {
  const io = makeFakeIo();
  const installer = new installerMod.LexiPluginInstaller({ cacheDir: '/cache' }, '/plugins', io);
  const good = writeZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(V2_MANIFEST)) },
    { name: 'main.js', data: Buffer.from('module.exports={v:1}') }
  ]);
  const tampered = Buffer.from(good);
  tampered[tampered.indexOf(Buffer.from('module.exports')) + 20] ^= 0xff;
  io.mkdirp('/cache');
  io.tree.files.set('/cache/pkg.zip', tampered);
  const expected = crypto.createHash('sha256').update(good).digest('hex');
  const rejected = await installer.verifyPackageHash('/cache/pkg.zip', expected);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'integrity_mismatch');
  const accepted = await installer.verifyPackageHash('/cache/pkg.zip', crypto.createHash('sha256').update(tampered).digest('hex'));
  assert.equal(accepted.ok, true, '对照：哈希对上时放行');
});

// --- 5. real directory end-to-end ---------------------------------------
function realZip(manifest, mainJs) {
  const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }];
  if (mainJs) { entries.push({ name: 'main.js', data: Buffer.from(mainJs, 'utf8') }); }
  return writeZip(entries);
}

test('真实目录：篡改一个字节 → integrity_mismatch，且不留半装目录', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-dist-'));
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pluginsRoot = path.join(tmp, 'plugins');
  const installer = new installerMod.LexiPluginInstaller({ cacheDir }, pluginsRoot);
  const bytes = realZip(V2_MANIFEST, 'module.exports={v:2}');
  const zipPath = path.join(tmp, 'pkg.zip');
  fs.writeFileSync(zipPath, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  const tampered = Buffer.from(bytes);
  tampered[tampered.indexOf(Buffer.from('module.exports')) + 22] ^= 0xff;
  const badPath = path.join(tmp, 'pkg-tampered.zip');
  fs.writeFileSync(badPath, tampered);

  await assert.rejects(() => installer.installZip(badPath, expected), /integrity_mismatch/);
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'legacy-plugin')), false, '校验失败不得留下插件目录');
  assert.deepEqual(fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : [], [], 'plugins 根目录必须保持干净');

  const badManifestPath = path.join(tmp, 'bad-manifest.zip');
  fs.writeFileSync(badManifestPath, realZip({ ...V2_MANIFEST, id: 'NOT_ALLOWED' }, 'module.exports={}'));
  await assert.rejects(() => installer.installZip(badManifestPath, ''), /manifest_invalid/);

  const installed = await installer.installZip(zipPath, expected);
  assert.equal(installed.id, 'legacy-plugin', '对照：同一份包哈希正确时能装');
  assert.equal(fs.readFileSync(path.join(pluginsRoot, 'legacy-plugin', 'main.js'), 'utf8'), 'module.exports={v:2}');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('真实目录：升级、回滚、卸载走 SystemPluginStorageIo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-dist-'));
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pluginsRoot = path.join(tmp, 'plugins');
  const installer = new installerMod.LexiPluginInstaller({ cacheDir }, pluginsRoot);

  const v1Path = path.join(tmp, 'v1.zip');
  const v1Bytes = realZip(V1_MANIFEST, 'module.exports={v:1}');
  fs.writeFileSync(v1Path, v1Bytes);
  await installer.installZip(v1Path, crypto.createHash('sha256').update(v1Bytes).digest('hex'));
  fs.writeFileSync(path.join(pluginsRoot, 'legacy-plugin', 'data.json'), '{"note":"keep"}');

  const v2Path = path.join(tmp, 'v2.zip');
  const v2Bytes = realZip(V2_MANIFEST, 'module.exports={v:2}');
  fs.writeFileSync(v2Path, v2Bytes);
  // T4.4(§9.5):先证未批准被拒,再证批准后放行(与假文件系统场景同口径)。
  await assert.rejects(() => installer.installZip(v2Path, crypto.createHash('sha256').update(v2Bytes).digest('hex')),
    /ERR_PERMISSION_REGRANT_REQUIRED/, '未批准新权限的升级应拒绝');
  await installer.installZip(v2Path, crypto.createHash('sha256').update(v2Bytes).digest('hex'),
    JSON.stringify({ grantApproved: true }));
  assert.equal(installer.currentVersion('legacy-plugin'), '1.1.0');
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'legacy-plugin', '.versions', '1.0.0', 'main.js')), true);
  assert.deepEqual(await installer.listVersions('legacy-plugin'), ['1.0.0', '1.1.0']);

  const rollback = await installer.rollbackPlugin('legacy-plugin');
  assert.equal(rollback.ok, true, rollback.message);
  assert.equal(fs.readFileSync(path.join(pluginsRoot, 'legacy-plugin', 'main.js'), 'utf8'), 'module.exports={v:1}');
  assert.equal(fs.readFileSync(path.join(pluginsRoot, 'legacy-plugin', 'data.json'), 'utf8'), '{"note":"keep"}');

  const uninstall = installer.uninstallPlugin('legacy-plugin');
  assert.equal(uninstall.ok, true, uninstall.message);
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'legacy-plugin')), false);
  assert.equal(fs.readdirSync(pluginsRoot).some((name) => name === '.trash'), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- 6. runtime wiring ---------------------------------------------------
test('runtime 接线：能力门禁在处理器前面，卸载/回滚/严格索引都已接上', () => {
  const text = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginRuntime.ets'), 'utf8');
  // 锚点更新:net handler 委派 performRequest → executeNetRequest(能力门禁/身份判定/超时全在
  // LexiNetProbe,由 net-request-url.cjs 用 76 条断言真跑)。这里钉"委派链完整"而不是复制判定。
  const performRequest = text.slice(text.indexOf("manager.performRequest(payload, identity, token)"));
  assert.match(performRequest, /executeNetRequest\(/, 'performRequest 必须走 probe 能力管线(checkNetworkCapability 在 LexiNetProbe)');
  assert.match(text, /failResponseCode\(/, '拒绝必须带错误码，不能只有 ok=false');
  // 单一正典形态：fsGate(identity)。两种形态都认会让"半途回退"（一部分改回 request）蒙混过关。
  assert.ok((text.match(/\.fsGate\(identity,/g) || []).length >= 6, 'fs 门禁必须覆盖 data.save 与 vault.* 五个写入口（fsGate(identity, …) 至少 6 处）');
  assert.equal((text.match(/\.fsGate\(request\)/g) || []).length, 0, '禁止回退成 fsGate(request)：正典形态是 fsGate(identity)');
  // P2-003/004:capability gate 注入 + 路径白名单 + data.* 解绑 + rename 双端检查。
  assert.match(text, /new LexiPermissionBroker\(\(pluginId: string, method: string\): boolean =>[\s\S]{0,160}fsAllowedByManifest\(pluginId, method\), \(pluginId: string, method: string\): boolean =>[\s\S]{0,80}capabilityAllowedFor\(pluginId, method\)\)/,
    'P2-003: broker 必须同时注入 fs 判定与 capability gate(两个 seam)');
  assert.match(text, /private vaultReadGate\(/, 'P2-004: 读路径白名单 gate 必须存在');
  assert.match(text, /fsGate\(identity, 'vault\.rename', rpcString\(request, 'newPath'\)\)/,
    'rename 的目标路径必须同样过白名单(防借改名把内容移出范围)');
  assert.match(text, /method === 'data\.load' \|\| method === 'data\.save'/,
    'data.* 必须与 vault.write 解绑(storage 归属,反向绑定修复 P2-003)');
  // P2-005:配额宿主端强制执行(data.save 写入前按 manifest.v2.storage.quotaBytes 拒绝超限)。
  assert.match(text, /private storageQuotaGate\(/, 'P2-005: 配额 gate 必须存在');
  assert.match(text, /data\.save[\s\S]{0,300}storageQuotaGate\(identity, dataJson\.length\)/,
    'data.save 必须在落盘前过配额检查');
  // P2-008:grantApproved 通道从 UI 可达(审计确认的死端修复)。
  assert.match(text, /installZip\(zipSource: string, expectedSha256: string = '', optionsJson: string = ''\)/,
    'installZip 必须能接收安装选项(grantApproved)');
  assert.match(text, /grantApproved[\s\S]{0,400}permissionStore\.grant\(manifest\.id, manifest\.version, this\.capabilityFingerprintOf\(manifest\)\)/,
    'grantApproved 安装必须按新清单落账授权,否则 enablePlugin 授权门仍会打回 regrant(死端)');
  assert.match(text, /installFromUrl\(url: string, expectedSha256: string = '', optionsJson: string = ''\)/,
    'installFromUrl 必须透传安装选项');
  assert.match(text, /permissionTagsOf\(pluginId: string\): string\[\]/, '授权展示面必须有权限标签查询');
  // P2-010:撤销语义覆盖所有清单版本——revoked 检查必须在 capabilitiesDeclared 版本门之前。
  assert.match(text, /const storedGrant = this\.permissionStore\.grantOf\(pluginId\);[\s\S]{0,200}state === 'revoked'[\s\S]{0,400}if \(record\.manifest\.capabilitiesDeclared\)/,
    '撤销必须先于版本门短路启用(否则 v1 插件撤销后仍可重新启用,P2-010 缺口)');
  // P1-003a:contextRegistry 接线(enable 创建/disable 吊销/端口帧裁决链)。
  assert.match(text, /readonly contextRegistry: LexiContextRegistry = new LexiContextRegistry\(\)/,
    'manager 必须持有 contextRegistry(P1-003a)');
  assert.match(text, /attachContextPort\(port: webview\.WebMessagePort\): void/ && /handleContextPortFrame\(data: string\): void/,
    '端口挂载与帧裁决入口必须存在');
  assert.match(text, /contextRegistry\.ensureService\(pluginId, activationId\)/, '启用必须注册端口身份(幂等;沙箱轨在 dispatch 前置)');
  assert.match(text, /const revokedContexts = this\.contextRegistry\.revokePlugin\(pluginId\);/,
    '停用必须吊销端口身份(P2-010 联动)');
  // P1-005(R30):端口身份纯端口化——调用点只传 contextRegistry 反查身份,凭据在
  // callFromPort 宿主内部补铸(旧形态 tokenForPlugin(gateway.identity) 出现在调用点
  // = 凭据表达式回流,红;验收行:插件侧报文不含任何身份字段,身份仅由端口解析)。
  assert.match(text, /callFromPort\('ctxport-' \+ gateway\.requestId, gateway\.method, gateway\.payloadJson, gateway\.identity\)/,
    '端口帧身份必须经 callFromPort 进既有调用链(P1-005 身份纯端口化)');
  assert.doesNotMatch(text, /tokenForPlugin\(gateway\.identity\)/,
    '端口调用点不得出现凭据表达式(credential 第 4 参经页面形态已废弃;补铸收口在 callFromPort)');
  // 真机 KI-4:运行时安装的插件在 enablePlugin 前必须经 scanPluginDir 落 installed,
  // 否则生命周期表判 discovered→starting 非法迁移,"装得上却永不 onload"。
  const scan = text.slice(text.indexOf('private async scanPluginDir('), text.indexOf('private readTextFile('));
  assert.match(scan, /this\.lifecycle\.markInstalled\(/, '落盘扫描必须做 discovered→installed 记账(KI-4)');
  assert.match(text, /async uninstallPlugin\(/, '宿主必须暴露卸载');
  assert.match(text, /async rollbackPlugin\(/, '宿主必须暴露回滚');
  assert.match(text, /fetchMarketIndex\(/, '市场必须走严格索引解析');
  assert.match(text, /parseMarketIndexResult\(/, '严格解析函数必须被真正调用');
  assert.match(text, /code: string = ''/, 'RpcResponse 必须能携带错误码');
  // 默认值 '' 只是签名兼容；空哈希已被 installFromUrl 的信任闸门拒绝(见上面的接线用例)。
  assert.match(text, /installFromUrl\(url: string, expectedSha256: string = '', optionsJson: string = ''\)/, 'installFromUrl 必须能收 sha256 与安装选项');
  assert.match(text, /private wasUninstalled\(/, '卸载记录必须能挡住内置资源重装');
  assert.match(text, /if \(this\.wasUninstalled\(entryName\)\) \{ return; \}/, '内置插件落盘前必须先查卸载记录');
});

// --- 6b. P1-007(R31) RPC 入口归一:单一 Gateway ------------------------------------------
test('P1-007 RPC 入口归一：五类前门收敛单一 Gateway,入口双闸(unknown/schema)在位', () => {
  const text = runtimeEts();
  const gwText = fs.readFileSync(path.join(CORE, 'plugin', 'LexiRpcGateway.ets'), 'utf8');
  const bridgeText = fs.readFileSync(path.join(WORKSPACE_ETS, 'WorkspaceBridge.ets'), 'utf8');
  // ① broker 实例归一:runtime 字段降级为转发访问器,桥内第二实例删除——全应用唯一
  //   授权判定器活在 Gateway(init 注入经 set attachBroker 换血,不另立实例)。
  assert.match(text, /readonly rpcGateway: LexiRpcGateway = LexiRpcGateway\.shared/,
    'runtime 必须持有单一 Gateway(LexiRpcGateway.shared)');
  assert.match(text, /get broker\(\): LexiPermissionBroker \{ return this\.rpcGateway\.broker\(\); \}/,
    'runtime.broker 必须是转发访问器(P1-007 实例归一)');
  assert.doesNotMatch(text, /broker: LexiPermissionBroker = new LexiPermissionBroker/,
    'runtime 不得再自持 broker 字段实例');
  assert.equal((bridgeText.match(/new LexiPermissionBroker\(/g) || []).length, 0,
    'WorkspaceBridge 内第二个 broker 实例必须删除(P1-007 两实例合并)');
  assert.match(bridgeText, /rpcGateway\.authorize\(ctx, method, null\)/,
    '桥面授权必须经单一 Gateway');
  assert.equal((gwText.match(/new LexiPermissionBroker\(/g) || []).length, 1,
    'Gateway 内只允许默认 fail-closed 一个构造点(唯一实例在 Gateway)');
  // ② 入口双闸:call() 先过 Gateway(未知方法显式拒绝 + 敏感家族 payload schema)。
  assert.match(text, /const entryReject: string = this\.rpcGateway\.entryReject\(method, payloadJson\);/,
    'call() 入口必须先过 Gateway 双闸');
  assert.match(text, /const handler = this\.rpcGateway\.handlerOf\(method\);/,
    'handler 表必须归 Gateway(handlerOf)');
  assert.match(gwText, /ERROR_RPC_UNKNOWN_METHOD: string = 'unknown_method'/,
    '未知方法必须显式机器码(不静默 undefined)');
  assert.match(gwText, /ERROR_RPC_BAD_REQUEST: string = 'bad_request'/,
    'schema 违例必须显式机器码');
  for (const method of ['vault.read', 'vault.modify', 'vault.rename', 'vault.append', 'editor.replace',
    'editor.applyChanges', 'net.requestUrl', 'commands.add', 'commands.execute', 'data.save']) {
    assert.ok(gwText.indexOf("'" + method + "'") >= 0, '敏感家族 schema 必须覆盖 ' + method);
  }
  // ③ dispatch 面归一:host→页只许投递 Gateway 登记的页侧方法(未知显式抛错)。
  assert.match(text, /const surfaceReject: string = this\.rpcGateway\.dispatchSurfaceReject\(method\);/,
    'dispatch 必须经 Gateway 方法面校验');
  assert.match(gwText, /dispatchSurfaceReject\(method: string\): string/,
    'dispatch 面策略必须活在 Gateway');
  // ④ 五类前门收敛:三个 javaScriptProxy 面绑 runtime/sandboxProxy;端口帧与容器页经
  //   callFromPort→call;桥 delegate→runtime.call;每条路都过 entryReject+authorize。
  const compSrc = (name) => fs.readFileSync(
    path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'plugin', name + '.ets'), 'utf8');
  const hostSrc = compSrc('LexiPluginRuntimeHost');
  const viewSrc = compSrc('LexiPluginViewSlot');
  const codeblockSrc = compSrc('LexiPluginCodeBlockSlot');
  const sandboxSrc = compSrc('LexiSandboxContainerHost');
  assert.match(hostSrc, /object: this\.manager\.runtime,\s*\n\s*name: 'lexiHost',[\s\S]{0,240}methodList: \['call', 'admitDispatch'\]/,
    'runtime 页 proxy 必须绑 manager.runtime(call+admitDispatch)');
  assert.match(viewSrc, /object: LexiPluginManager\.shared!\.runtime/, '视图页 proxy 必须绑 runtime');
  assert.match(codeblockSrc, /object: LexiPluginManager\.shared!\.runtime/, '代码块页 proxy 必须绑 runtime');
  assert.match(sandboxSrc, /object: this\.manager\.sandboxProxy/, '沙箱容器页 proxy 必须绑 sandboxProxy');
  assert.match(bridgeText, /manager\.runtime\.call\('', method, JSON\.stringify\(forwarded\), credential\)/,
    '桥 delegate 必须转发 runtime.call(Gateway 漏斗)');
});

// --- 7. P5-004 安装不再自动 enable:授权清单展示 → 用户同意 → 启用 ---------------------
function runtimeEts() {
  return fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginRuntime.ets'), 'utf8');
}
function marketSheetEts() {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'plugin', 'LexiPluginMarketSheet.ets'), 'utf8');
}

test('P5-004 安装链不再自动 enable：首装落 installed 等授权，仅授权/升级重启两条通路', () => {
  const text = runtimeEts();
  const body = text.slice(text.indexOf('async installZip('), text.indexOf('async installFromUrl('));
  assert.ok(body.length > 0, 'installZip 必须存在');
  // 升级重启判定必须在 scanPluginDir 重建记录之前取 enabledIds(启用的持久真源)。
  const scanPos = body.indexOf('await this.scanPluginDir()');
  const wasEnabledPos = body.indexOf('const wasEnabled = this.enabledIds.has(manifest.id)');
  assert.ok(wasEnabledPos > 0 && wasEnabledPos < scanPos,
    'wasEnabled 判定必须在 scanPluginDir 之前(扫描会把记录重建为未启用)');
  // 通路 1:grantApproved(P2-008 升级重授权)= 落账 + 启用。
  const grantStart = body.indexOf('if (grantApproved) {');
  const upgradeStart = body.indexOf('if (wasEnabled) {');
  const freshStart = body.indexOf('P5-004 首装默认路径');
  assert.ok(grantStart > 0 && upgradeStart > grantStart && freshStart > upgradeStart,
    'installZip 必须依次是 grantApproved / wasEnabled / 首装默认 三段');
  const grantBlock = body.slice(grantStart, upgradeStart);
  assert.match(grantBlock, /permissionStore\.grant\(manifest\.id/, '重授权通路必须落账');
  assert.match(grantBlock, /this\.enablePlugin\(manifest\.id\)/, '重授权通路启用(用户已确认新权限)');
  // 通路 2:wasEnabled(升级重启)= 只启用不重新落账(§4.6 权限不变沿用授权)。
  const upgradeBlock = body.slice(upgradeStart, freshStart);
  assert.match(upgradeBlock, /this\.enablePlugin\(manifest\.id\)/, '升级重启通路启用');
  assert.doesNotMatch(upgradeBlock, /permissionStore\.grant\(/, '升级重启不得重新落账(沿用既有授权)');
  // 首装默认路径:不得出现任何 enablePlugin 调用。
  const freshBlock = body.slice(freshStart);
  assert.doesNotMatch(freshBlock, /this\.enablePlugin\(/, '首装默认路径不得 enable(P5-004 主断言)');
  assert.match(freshBlock, /插件已安装\(未启用,等待用户授权\)/, '首装日志必须明示未启用待授权');
});

test('P5-004 enablePlugin 授权前置：未授权声明型清单拒绝启用,「启用即授权」废除', () => {
  const text = runtimeEts();
  const body = text.slice(text.indexOf('async enablePlugin('), text.indexOf('async disablePlugin('));
  assert.ok(body.length > 0, 'enablePlugin 必须存在');
  assert.match(body, /decision !== PERMISSION_GRANTED[\s\S]{0,600}插件权限尚未授权[\s\S]{0,300}return false/,
    '未授权(not-granted)必须拒绝启用,不得自动落账');
  assert.doesNotMatch(body, /decision !== PERMISSION_GRANTED[\s\S]{0,200}permissionStore\.grant\(/,
    '「首次启用:用户显式启用即授权」自动落账必须废除(P5-004)');
  // P2-010 保持:revoked 短路先于授权门(撤销对所有清单版本生效)。
  const revokedPos = body.indexOf("state === 'revoked'");
  const consentPos = body.indexOf('decision !== PERMISSION_GRANTED');
  assert.ok(revokedPos > 0 && revokedPos < consentPos, 'revoked 短路必须先于授权门(P2-010)');
  // regrant-required(指纹变化)仍拒绝。
  assert.match(body, /PERMISSION_REGRANT_REQUIRED[\s\S]{0,200}return false/, '指纹变化的 regrant 拒绝保持');
});

test('P5-004 同意通道：consentEnablePlugin = grant→enable,授权状态可查询,撤销重授权可达', () => {
  const text = runtimeEts();
  assert.match(text, /async consentEnablePlugin\(pluginId: string\): Promise<boolean> \{/,
    '授权面板的同意入口必须存在');
  const body = text.slice(text.indexOf('async consentEnablePlugin('),
    text.indexOf('async consentEnablePlugin(') + 500);
  assert.match(body, /grantPluginPermissions\(pluginId\)/, '同意必须先按当前清单落账');
  assert.match(body, /enablePlugin\(pluginId\)/, '落账后启用');
  assert.match(text, /permissionStateOf\(pluginId: string\): string \{/, 'UI 需要授权状态查询(not-granted → 展示面板)');
  // P2-010 撤销链保持:revoke → disablePlugin 立即停用;consent 可重新授权(revoked → granted)。
  const revoke = text.slice(text.indexOf('async revokePluginPermissions('),
    text.indexOf('async revokePluginPermissions(') + 400);
  assert.match(revoke, /permissionStore\.revoke\(pluginId\)/, '撤销落账');
  assert.match(revoke, /disablePlugin\(pluginId\)/, '撤销必须立即停用(通道不变)');
  // 行为面(真跑):撤销后即使指纹一致 decision 也是 revoked,不是 granted。
  const storeMod = loadEts('plugin/LexiPermissionStore', kits);
  const store = new storeMod.LexiPermissionStore();
  store.grant('plug-a', '1.0.0', 'fp:tag|');
  assert.equal(store.decisionFor('plug-a', '1.0.0', 'fp:tag|'), storeMod.PERMISSION_GRANTED, '对照:同意后 GRANTED');
  store.revoke('plug-a');
  assert.equal(store.decisionFor('plug-a', '1.0.0', 'fp:tag|'), storeMod.PERMISSION_REVOKED,
    '撤销后即使指纹一致也不得 GRANTED(P2-010)');
  store.grant('plug-a', '1.0.0', 'fp:tag|');
  assert.equal(store.decisionFor('plug-a', '1.0.0', 'fp:tag|'), storeMod.PERMISSION_GRANTED,
    '重新授权(consent)后恢复 GRANTED');
});

test('P5-004 内置夹具白名单：首启显式落账授权,沙箱探针冷启动链保留(Round 22)', () => {
  const text = runtimeEts();
  const start = text.indexOf("const bundledInit = await LexiStorageService.getSetting('lexiPluginBundledInit'");
  const end = text.indexOf('插件管理器初始化完成');
  assert.ok(start > 0 && end > start, '首启自动启用块必须存在');
  const block = text.slice(start, end);
  assert.match(block, /bundledAllowList/, '必须存在显式白名单(代码闭合,不接受数据驱动)');
  for (const id of ['lexi-sample-plugin', 'sandbox-probe', 'sandbox-sample-min', 'sandbox-editor-min']) {
    assert.ok(block.indexOf("'" + id + "'") >= 0, '内置白名单必须包含 ' + id);
  }
  assert.match(block, /permissionStore\.grant\(bundledId/, '白名单启用必须先落账授权(否则 enablePlugin 授权门拒绝)');
  assert.equal((block.match(/enabledIds\.add\(/g) || []).length, 1,
    '首启块只允许经白名单循环启用一次(不得为绕过授权门私开通道)');
  // 沙箱探针链路仍随首启启用(容器页就绪即走沙箱轨)。
  assert.ok(block.indexOf('sandbox-probe') >= 0, 'sandbox-probe 冷启动链不得回归(Round 22)');
});

// --- 8. P1-003d(R28) 装载轨政策：沙箱轨主路径 + 旧共享 realm 停用开关 -------------------
const RAWFILE_PLUGINS = path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins');

test('P1-003d 装载轨决策真跑(LexiPluginTrackPolicy)：开关两种朝向逐格断言', () => {
  const trackMod = loadEts('plugin/LexiPluginTrackPolicy', kits);
  const resolve = trackMod.resolvePluginTrack;
  const SANDBOX = trackMod.TRACK_SANDBOX;
  const LEGACY = trackMod.TRACK_LEGACY;
  const REFUSED = trackMod.TRACK_REFUSED;
  // 开关默认(true/''/任意非 'false')→ 行为与 R27 前一致:沙箱声明+轨就绪走沙箱,其余 legacy。
  assert.equal(resolve(true, true, 'true'), SANDBOX, '沙箱声明+容器就绪 → 沙箱轨');
  assert.equal(resolve(true, false, 'true'), LEGACY, '沙箱声明但轨未就绪+开关默认 → legacy(历史回落保留)');
  assert.equal(resolve(false, false, 'true'), LEGACY, '非沙箱声明+开关默认 → legacy');
  assert.equal(resolve(false, true, 'true'), LEGACY, '非沙箱声明不受沙箱轨就绪影响');
  assert.equal(resolve(false, false, ''), LEGACY, '空落盘值 = 默认 true');
  assert.equal(resolve(true, true, 'nonsense'), SANDBOX, '非 false 值一律视为允许 legacy');
  // 开关关死('false')→ 旧共享 realm 路径 fail-closed:只有沙箱轨可达的装载放行。
  assert.equal(resolve(true, true, 'false'), SANDBOX, '开关关死不拦沙箱轨主路径');
  assert.equal(resolve(true, false, 'false'), REFUSED, '开关关死:沙箱声明但轨未就绪 → 拒绝(不得溜进共享 realm)');
  assert.equal(resolve(false, false, 'false'), REFUSED, '开关关死:非沙箱声明 → 拒绝(旧共享 realm 停用)');
  assert.equal(resolve(false, true, 'false'), REFUSED, '开关关死:非沙箱声明即使容器就绪也 → 拒绝');
  // 沙箱轨是主路径:拒绝面只吃非沙箱装载,沙箱声明+就绪永不拒绝。
  assert.equal(trackMod.TRACK_REFUSED, 'refused', '拒绝轨字面量(错误态判定对账用)');
});

test('P1-003d enablePlugin 接线：resolvePluginTrack 单一真源,refused 路径 fail-closed 不派发', () => {
  const text = runtimeEts();
  const body = text.slice(text.indexOf('async enablePlugin('), text.indexOf('async disablePlugin('));
  assert.ok(body.length > 0, 'enablePlugin 必须存在');
  // 决策单一真源:enablePlugin 必须调用 resolvePluginTrack,不得内联第二份判定。
  assert.match(body, /const track = resolvePluginTrack\(/, 'enablePlugin 必须经 LexiPluginTrackPolicy 决策');
  assert.match(body, /track === TRACK_SANDBOX/, '沙箱轨分支必须以决策字面量路由');
  // refused 检查必须位于 legacy 派发(load.plugin)之前,且不派发、不静默回落。
  const refusedPos = body.indexOf('track === TRACK_REFUSED');
  const dispatchPos = body.indexOf("'load.plugin'");
  assert.ok(refusedPos > 0, 'refused 分支必须存在');
  assert.ok(dispatchPos > refusedPos, 'refused 检查必须先于 load.plugin 派发(不得先派发再补救)');
  const legacyDispatchComment = body.indexOf('// 大源码经 runJavaScript 直传会静默挂起');
  const refusedBlock = body.slice(refusedPos,
    legacyDispatchComment > refusedPos ? legacyDispatchComment : dispatchPos);
  assert.match(refusedBlock, /record\.errorState = /, '拒绝必须写错误态(用户可见,不是静默)');
  assert.match(refusedBlock, /lexiPluginLegacyTrack=false/, '错误态必须点名开关(可诊断)');
  assert.match(refusedBlock, /fail-closed/, '错误态必须明示 fail-closed 语义');
  assert.match(refusedBlock, /this\.lifecycle\.markFailed\(/, '拒绝必须走生命周期 markFailed');
  assert.match(refusedBlock, /return false/, '拒绝必须 return false');
  assert.doesNotMatch(refusedBlock, /dispatchWithTimeout\(|dispatchSandboxBoot\(|dispatch\(/,
    '拒绝路径不得派发任何执行面');
  // 开关:落盘键 + 默认 true + manager 存取面(设置页可达)。
  assert.match(text, /const KEY_LEGACY_TRACK: string = 'lexiPluginLegacyTrack'/, '落盘键必须收敛为常量');
  assert.match(text, /getSetting\(KEY_LEGACY_TRACK, 'true'\)/, '默认值必须是 true(R28 真机验收前不回归)');
  assert.match(text, /isLegacyTrackEnabled\(\): boolean/, 'manager 必须暴露开关读取');
  assert.match(text, /async setLegacyTrackEnabled\(enabled: boolean\): Promise<void> \{[\s\S]{0,400}setSetting\(KEY_LEGACY_TRACK/,
    'manager 必须暴露开关写入并即刻落盘');
});

test('P1-003d 设置页接线：legacy 轨开关 Toggle(与 safe-mode 同形,双设置面)', () => {
  for (const name of ['LexiSettingsTab.ets', 'LexiSettingsWindow.ets']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', name), 'utf8');
    assert.match(text, /@State private pluginLegacyTrack: boolean = true/, name + ': UI 态默认 true');
    assert.match(text, /isLegacyTrackEnabled\(\)/, name + ': UI 读 manager 开关态');
    assert.match(text, /toggleLegacyTrack\((isOn|enabled): boolean\)/, name + ': Toggle 回调必须走 manager 写入');
    assert.match(text, /setLegacyTrackEnabled\(enabled\)/, name + ': Toggle 必须落到 manager 落盘写入');
    assert.match(text, /\.id\('plugin-legacy-track-toggle'\)/, name + ': Toggle 必须带测试锚 id');
    assert.match(text, /旧版插件轨/, name + ': 行文案必须可读(共享 realm 轨语义)');
    assert.match(text, /fail-closed/, name + ': 行文案必须披露关死后 fail-closed');
  }
});

test('P1-003d lexi-sample 沙箱轨 opt-in：v2 严格清单 + entrypoints.service="sandbox:" + 能力与 RPC 面对账', () => {
  const manifestText = fs.readFileSync(path.join(RAWFILE_PLUGINS, 'lexi-sample-plugin', 'manifest.json'), 'utf8');
  const manifestMod2 = loadEts('plugin/LexiPluginManifest', kits);
  const manifest = manifestMod2.parsePluginManifest(manifestText);
  assert.equal(manifest.manifestVersion, 2, 'lexi-sample 必须是 manifestVersion 2(严格解析)');
  assert.equal(manifest.sandboxService, true, '声明式 opt-in:entrypoints.service="sandbox:" → sandboxService');
  assert.equal(manifest.capabilitiesDeclared, true, 'v2 清单必须声明能力(授权面板可见)');
  assert.equal(manifest.v2.vault.read.enabled, true, 'vault.read(sample-notice 统计/日志读取)');
  assert.equal(manifest.v2.vault.write.enabled, true, 'vault.write(sample-create 创建日志笔记)');
  assert.equal(manifest.v2.editor.readActive, true, 'editor.readActive(editor-stats 读正文)');
  assert.equal(manifest.v2.editor.writeSelection, true, 'editor.writeSelection(wrap-selection/insert-demo-block)');
  assert.equal(manifest.v2.editor.writeDocument, true, 'editor.writeDocument(write-chart/write-case 全文写)');
  assert.equal(manifest.v2.workspace.commands, true, 'workspace.commands(7 个命令注册)');
  assert.equal(manifest.v2.notifications, true, 'notifications(Notice → ui.notice 域)');
  assert.equal(manifestApiCompatibleOk(manifest), true, 'compatibility 必须与宿主 API 线兼容');
  // 代码仍在:sample 主代码不被本轮改写(迁移动作只在清单声明与沙箱面,业务代码保持真实插件形状)。
  const sampleMain = fs.readFileSync(path.join(RAWFILE_PLUGINS, 'lexi-sample-plugin', 'main.js'), 'utf8');
  assert.match(sampleMain, /module\.exports = class SamplePlugin extends Plugin/, 'main.js 保持 CJS Plugin 子类形状');
  assert.ok(sampleMain.includes('require(' + String.fromCharCode(39) + 'obsidian' + String.fromCharCode(39) + ')'), 'main.js 经 require("obsidian") 取面');
  // 沙箱表面代码必须提供 lexi-sample 求值期依赖的最小面(ItemView/PluginSettingTab 基类)。
  const sandboxHtml = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile',
    'lexinote_plugin_sandbox.html'), 'utf8');
  assert.ok(sandboxHtml.includes('ItemView: SandboxItemView') && sandboxHtml.includes('PluginSettingTab: SandboxPluginSettingTab'),
    '沙箱 obsidian 面缺基类则 lexi-sample 求值期 TypeError');
});

test('P1-003d SEC 探针进业务路径：夹具随 HAP 内置+首启白名单+沙箱轨声明', () => {
  // 夹具本体按仓约定是 gitignore 的本地暂存物:在场时全量断言,缺席时跳过夹具部分
  // (宿主接线断言无条件执行——那是提交内代码,任何环境都必须成立)。
  const fixtureDir = path.join(RAWFILE_PLUGINS, 'sandbox-sec-probe');
  const fixtureMainPath = path.join(fixtureDir, 'main.js');
  const fixtureManifestPath = path.join(fixtureDir, 'manifest.json');
  if (fs.existsSync(fixtureMainPath) && fs.existsSync(fixtureManifestPath)) {
    const main = fs.readFileSync(fixtureMainPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'));
    assert.equal(manifest.manifestVersion, 2, '探针必须是 v2');
    assert.equal(manifest.entrypoints && manifest.entrypoints.service, 'sandbox:', '探针必须走业务装载链(bootPlugin)');
    for (const vector of ['parent-dom', 'parent-globals', 'sibling-iframe', 'window-opener', 'opaque-storage',
      'network-fetch', 'network-xhr', 'remote-import', 'function-escape', 'credential-hunt']) {
      assert.ok(main.includes("'" + vector + "'"), '探针缺向量 ' + vector);
    }
    assert.match(main, /saveData\(\{ sec: report \}\)/, '报告必须经业务数据通道落盘');
    assert.match(main, /sandbox-sec-probe-ok/, '通过标记必须存在(设备 data.json 对账)');
  } else {
    console.log('  [skip] SEC 探针夹具本体未暂存(plugins/sandbox-sec-probe,夹具环境约定)');
  }
  // 内置链:BUNDLED_PLUGIN_DIRS + bundledAllowList(探针是设备验收对象,不经用户安装链)。
  const text = runtimeEts();
  assert.match(text, /'plugins\/sandbox-sec-probe'/, 'BUNDLED_PLUGIN_DIRS 必须包含 SEC 探针');
  assert.match(text, /if \(this\.plugins\.has\('sandbox-sec-probe'\)\) \{ bundledAllowList\.push\('sandbox-sec-probe'\); \}/,
    '首启白名单必须包含 SEC 探针');
});

// --- 9. P1-011(R29/S1) Track2(workspace 页)接轨政策与授权门 ------------------------------
// WorkspaceBridge.plugin.load 此前把每个已装插件的 main.js 直接下发页面求值,同时绕过
// ADR-R28-01 轨政策(停用开关只在 enablePlugin 裁决)与 ADR-R26-01 同意门——本节把
// WorkspaceBridge.ets 转译真跑,断言两道闸门在 Track2 生效(ADR-R29-01 S1"轨矩阵扩 Track2 行")。
const WORKSPACE_ETS = path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'workspace');
// 桥面日志桩:fail-visible 断言要证明拒载落了日志,不只是回一个错误帧。
const hilogWarns = [];
const track2Kits = {
  '@kit.PerformanceAnalysisKit': {
    hilog: {
      debug() {}, info() {}, error() {},
      warn(domain, tag, fmt, topic) { hilogWarns.push(String(topic)); }
    }
  },
  '@kit.CryptoArchitectureKit': {
    cryptoFramework: {
      // 测试桩:随机字节带自增计数,保证桥内铸出的令牌互不相同(tokens 表按令牌键控)。
      createRandom() {
        return {
          generateRandomSync(len) {
            const arr = new Uint8Array(len);
            arr[0] = (randCounter & 0xff);
            arr[1] = ((randCounter >> 8) & 0xff);
            randCounter += 1;
            return { data: arr };
          }
        };
      }
    }
  },
  '@kit.AbilityKit': { common: {} },
  '@kit.CoreFileKit': { fileIo: {} },
  '@kit.NetworkKit': { http: {} }
};
let randCounter = 0;

function loadWorkspaceEts(spec, kits) {
  const target = path.join(WORKSPACE_ETS, spec + '.ets');
  const cache = new Map();
  const loadResolved = (resolved) => {
    if (!resolved.endsWith('.ets')) { resolved = resolved + '.ets'; }
    const key = resolved.replace(/\.ets$/, '');
    if (cache.has(key)) { return cache.get(key); }
    const exports = {};
    cache.set(key, exports); // 先占位再执行:相对依赖存在共享引用(WorkspaceLog 等)
    const js = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
    }).outputText;
    const module = { exports };
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: resolved })(
      (name) => {
        if (kits[name]) { return kits[name]; }
        if (name.startsWith('.')) { return loadResolved(path.resolve(path.dirname(resolved), name)); }
        return require(name);
      }, module, exports);
    return exports;
  };
  return loadResolved(target);
}

function track2Record(id, sandboxService, capabilitiesDeclared, enabled) {
  return {
    manifest: { id, sandboxService, capabilitiesDeclared, name: id, version: '1.0.0' },
    enabled, errorState: '', dir: '/plugins/' + id, activationId: ''
  };
}

function track2Manager(opts) {
  return {
    vault: { events: { on() {} } },
    metadata: null,
    workspaceEvents: { on() {} },
    installedPlugins() { return opts.plugins; },
    isLegacyTrackEnabled() { return opts.legacyTrack !== false; },
    permissionStateOf(id) { return (opts.grants && opts.grants[id]) || 'not-granted'; },
    // 目录装载面(loadFromManager)要读清单与源码:桩按安装记录投影,保持全量列出。
    pluginManifestJson(id) {
      const record = opts.plugins.find((row) => row.manifest.id === id);
      return JSON.stringify(record ? { id, name: record.manifest.name, version: record.manifest.version } : { id });
    },
    pluginMainCode(id) { return 'module.exports=function(){/*track2-fixture*/};'; }
  };
}

async function track2AuthedBridge(manager) {
  const bridgeMod = loadWorkspaceEts('WorkspaceBridge', track2Kits);
  const bridge = new bridgeMod.WorkspaceBridge(Promise.resolve(manager), {
    list() { return []; }, active() { return ''; }, load() { return null; },
    install() { throw new Error('not used'); }, setActive() {}
  });
  const hello = JSON.parse(await bridge.handleText(
    JSON.stringify({ v: 1, id: 'h1', method: 'channel.hello', payload: {} })));
  assert.equal(hello.ok, true, 'hello 必须成功(测试脚手架前提)');
  const auth = JSON.parse(await bridge.handleText(
    JSON.stringify({ v: 1, id: 'a1', method: 'channel.auth', payload: { nonce: hello.data.nonce } })));
  assert.equal(auth.ok, true, 'auth 必须成功(测试脚手架前提)');
  return { bridge, token: auth.data.token };
}

async function track2Load(bridge, token, id) {
  return JSON.parse(await bridge.handleText(
    JSON.stringify({ v: 1, id: 'p1', token, method: 'plugin.load', payload: { id } })));
}

test('P1-011 Track2 正例不回归:demo 夹具与已启用 legacy 插件照常下发源码', async () => {
  const manager = track2Manager({ plugins: [
    track2Record('calendar', false, false, true)
  ] });
  const { bridge, token } = await track2AuthedBridge(manager);
  // plugin.list 仍列出已装插件:拒载可见性(fail-visible)的前提,不得静默缺席。
  const list = JSON.parse(await bridge.handleText(
    JSON.stringify({ v: 1, id: 'l1', token, method: 'plugin.list', payload: {} })));
  assert.equal(list.ok, true);
  const listed = list.data.plugins.map((row) => row.id);
  assert.ok(listed.indexOf('lexinote.demo-status') >= 0, '内联 demo 必须在列(工作区 UI 不回归)');
  assert.ok(listed.indexOf('calendar') >= 0, '已装插件必须在列(拒载可见性前提)');
  const demo = await track2Load(bridge, token, 'lexinote.demo-status');
  assert.equal(demo.ok, true, '内联 demo(随 HAP 分发,不经安装/授权链)必须照常装载: ' +
    JSON.stringify(demo.error || null));
  assert.ok(demo.data.code.length > 0 && demo.data.token.length > 0, 'demo descriptor 必须含源码与令牌');
  const legacy = await track2Load(bridge, token, 'calendar');
  assert.equal(legacy.ok, true, '已启用 legacy 插件(v1 无声明清单,启用即授权存量语义)必须照常装载: ' +
    JSON.stringify(legacy.error || null));
  assert.ok(legacy.data.code.length > 0 && legacy.data.manifest, 'descriptor 必须含源码与清单');
  // 已启用 + 已授权的声明型清单同样放行(与设置页"开关即同意"同一授权语义)。
  const grantedManager = track2Manager({
    plugins: [track2Record('v2-ok', false, true, true)],
    grants: { 'v2-ok': 'granted' }
  });
  const grantedBridge = await track2AuthedBridge(grantedManager);
  const granted = await track2Load(grantedBridge.bridge, grantedBridge.token, 'v2-ok');
  assert.equal(granted.ok, true, '已启用且授权的 v2 插件必须照常装载: ' + JSON.stringify(granted.error || null));
});

test('P1-011 门② consent 真跑:未启用/未授权/被撤销插件在工作区页拒载且零源码下发', async () => {
  hilogWarns.length = 0;
  const manager = track2Manager({
    plugins: [
      track2Record('v2-fresh', false, true, false),   // 安装后从未启用(未授权)
      track2Record('v2-revoked', false, true, true),  // 曾启用但被用户撤销
      track2Record('legacy-fresh', false, false, false) // v1 未启用(启用即授权语义下未同意)
    ],
    grants: { 'v2-revoked': 'revoked' }
  });
  const { bridge, token } = await track2AuthedBridge(manager);
  for (const [id, why] of [['v2-fresh', '未授权声明型清单'], ['v2-revoked', '已撤销授权'], ['legacy-fresh', '未启用 v1']]) {
    const reply = await track2Load(bridge, token, id);
    assert.equal(reply.ok, false, why + ' 必须拒载: ' + JSON.stringify(reply.data || null));
    assert.equal(reply.error.code, 'plugin_consent_required', why + ' 的拒绝码必须机器可读');
    assert.ok(reply.error.message.length > 0, '拒绝必须带可读信息(fail-visible)');
    assert.equal(reply.data === undefined, true, why + ' 拒载时不得携带源码');
  }
  // 页面侧可见性通道:拒载必须落桥面日志(WorkspaceLog.warn),不是只回一个静默错误。
  assert.ok(hilogWarns.indexOf('plugin.load.consent') >= 0,
    'consent 拒载必须落桥面日志 plugin.load.consent(fail-visible,非静默缺席)');
});

test('P1-011 门① track 真跑:沙箱声明插件即使已授权已启用也不发进工作区页(P4-005 待收敛)', async () => {
  hilogWarns.length = 0;
  const manager = track2Manager({
    plugins: [track2Record('lexi-sample-plugin', true, true, true)],
    grants: { 'lexi-sample-plugin': 'granted' }
  });
  const { bridge, token } = await track2AuthedBridge(manager);
  const reply = await track2Load(bridge, token, 'lexi-sample-plugin');
  assert.equal(reply.ok, false, '沙箱声明插件不得下发工作区页(授权/启用齐全也拒——拒因是轨)');
  assert.equal(reply.error.code, 'plugin_track_refused', '拒绝码必须机器可读');
  assert.match(reply.error.message, /P4-005/, '错误信息必须指明视图载体收敛去向(P4-005)');
  assert.match(reply.error.message, /ADR-R21-02|iframe/, '错误信息必须点名工作区页无 iframe 容器(ADR-R21-02)');
  assert.equal(reply.data === undefined, true, '拒载不得携带源码');
  assert.ok(hilogWarns.indexOf('plugin.load.track') >= 0,
    '轨拒载必须落桥面日志 plugin.load.track(fail-visible,非静默缺席)');
});

test('P1-011 门① track 真跑:legacy 轨开关关死时工作区页同样 fail-closed(R28 开关覆盖 Track2)', async () => {
  hilogWarns.length = 0;
  const manager = track2Manager({
    legacyTrack: false,
    plugins: [track2Record('calendar', false, false, true)]
  });
  const { bridge, token } = await track2AuthedBridge(manager);
  const reply = await track2Load(bridge, token, 'calendar');
  assert.equal(reply.ok, false, '开关关死:已启用 legacy 插件同样拒载(此前只裁决 runtime 轨)');
  assert.equal(reply.error.code, 'plugin_track_refused');
  assert.match(reply.error.message, /lexiPluginLegacyTrack=false/, '错误信息必须点名开关(可诊断)');
  assert.match(reply.error.message, /fail-closed/, '错误信息必须明示 fail-closed 语义');
  assert.equal(reply.data === undefined, true, '拒载不得携带源码');
  assert.ok(hilogWarns.indexOf('plugin.load.track') >= 0, '轨拒载必须落桥面日志(fail-visible)');
});

test('P1-011 边界:卸载后的陈旧注册表条目不得继续下发源码', async () => {
  const plugins = [track2Record('calendar', false, false, true)];
  const manager = track2Manager({ plugins });
  const { bridge, token } = await track2AuthedBridge(manager);
  const before = await track2Load(bridge, token, 'calendar');
  assert.equal(before.ok, true, '对照:在册且已启用时照常装载');
  plugins.length = 0; // 模拟卸载:manager 无记录,而工作区注册表仍是陈旧快照(registryLoaded 缓存)
  const stale = await track2Load(bridge, token, 'calendar');
  assert.equal(stale.ok, false, '陈旧条目必须拒载(不得借注册表快照绕过装载门)');
  assert.equal(stale.error.code, 'unknown_plugin', '陈旧条目按未安装拒绝');
  assert.equal(stale.data === undefined, true, '陈旧拒载不得携带源码');
  // 对照:内联 demo 没有清单(非目录条目),不受快照判定影响。
  const demo = await track2Load(bridge, token, 'lexinote.demo-status');
  assert.equal(demo.ok, true, 'demo(无清单条目)不受陈旧快照判定影响');
});

test('P1-011 接线:装载门先于一切下发动作,轨判定走单一真源,同意语义复用 manager', () => {
  const bridgeText = fs.readFileSync(path.join(WORKSPACE_ETS, 'WorkspaceBridge.ets'), 'utf8');
  const onLoad = bridgeText.slice(bridgeText.indexOf('private async onPluginLoad('),
    bridgeText.indexOf('private onPluginUnload('));
  assert.ok(onLoad.length > 0, 'onPluginLoad 必须存在');
  const gatePos = onLoad.indexOf('this.pluginLoadRefusal(');
  const mintPos = onLoad.indexOf("this.mint('tk')");
  assert.ok(gatePos > 0, 'onPluginLoad 必须过 Track2 装载门(pluginLoadRefusal)');
  assert.ok(mintPos > gatePos, '装载门必须先于令牌铸造/源码下发(不得先下发再补救)');
  const gate = bridgeText.slice(bridgeText.indexOf('private pluginLoadRefusal('),
    bridgeText.indexOf('private onPluginUnload(') > bridgeText.indexOf('private pluginLoadRefusal(')
      ? bridgeText.indexOf('private onPluginUnload(') : undefined);
  assert.match(gate, /resolvePluginTrack\(/, '轨判定必须走 LexiPluginTrackPolicy 单一真源(不内联第二份判定)');
  assert.match(gate, /manager\.isLegacyTrackEnabled\(\)/, 'legacy 开关状态必须取自 manager(与设置页同一份)');
  assert.match(gate, /manifest\.sandboxService/, '沙箱声明插件必须显式拒发(工作区页无 iframe,ADR-R21-02)');
  assert.match(gate, /P4-005/, '沙箱拒绝信息必须指明视图载体收敛去向');
  assert.match(gate, /record\.enabled/, '未启用插件不得下发(P5-004/ADR-R26-01)');
  assert.match(gate, /manifest\.capabilitiesDeclared[\s\S]{0,200}manager\.permissionStateOf\(id\)/,
    '声明型清单必须查授权态,且与 manager 同一判定面');
  assert.match(gate, /ERR_PLUGIN_TRACK_REFUSED/, '轨拒绝必须带机器可读错误码');
  assert.match(gate, /ERR_PLUGIN_CONSENT_REQUIRED/, '同意拒绝必须带机器可读错误码');
  // 目录(WorkspacePluginCatalog)保持全量列表:拒载可见性由 load 门负责,静默缺席是禁止形态。
  const catalogText = fs.readFileSync(path.join(WORKSPACE_ETS, 'WorkspacePluginCatalog.ets'), 'utf8');
  assert.match(catalogText, /loadFromManager\(manager: LexiPluginManager\): void/,
    '目录装载面保持(全量列出已装插件,拒绝发生在 load 门,fail-visible)');
});

test('P2-005/P1-003b 编辑器切片：editor 分级档位接线(域映射+精判+脱敏+沙箱路由)', () => {
  const text = runtimeEts();
  // broker capabilityGate 域映射(方法→档位):state→readActive;selection→writeSelection;
  // applyChanges→writeDocument;replace→任一写档位(选区等值精判在 handler,broker 看不到载荷)。
  assert.match(text, /method === 'editor\.state'\) \{ return caps\.editor\.readActive; \}/,
    'editor.state 的 capability 域 = editor.readActive');
  assert.match(text, /method === 'editor\.replace'\) \{ return caps\.editor\.writeSelection \|\| caps\.editor\.writeDocument; \}/,
    'editor.replace 的 capability 域 = writeSelection||writeDocument(writeSelection-only 插件由此可用 replaceSelection)');
  assert.match(text, /method === 'editor\.selection'\) \{ return caps\.editor\.writeSelection; \}/,
    'editor.selection 的 capability 域 = editor.writeSelection');
  assert.match(text, /method === 'editor\.applyChanges'\) \{ return caps\.editor\.writeDocument; \}/,
    'editor.applyChanges 的 capability 域 = editor.writeDocument');
  // editor.replace 档位精判 gate:必须先于 mutation(no half-writes)。
  assert.match(text, /private editorReplaceGate\(/, 'P2-005: editor.replace 档位精判 gate 必须存在');
  const replace = text.slice(text.indexOf("registerHandler('editor.replace'"),
    text.indexOf("registerHandler('editor.selection'"));
  assert.ok(replace.length > 0, 'editor.replace handler 必须存在');
  assert.match(replace, /editorReplaceGate\(identity,/, 'editor.replace handler 必须过档位精判 gate');
  assert.ok(replace.indexOf('editorReplaceGate') < replace.indexOf('controller.replaceRange'),
    '档位精判必须先于 replaceRange(未声明档位不得产生半次写入)');
  // 回包脱敏:未声明 readActive 的插件不得借写回包读全文(三处写回包统一走 editorResponseFor)。
  assert.match(text, /private editorResponseFor\(/, 'P2-005: editor 写回包脱敏必须存在');
  assert.ok((text.match(/editorResponseFor\(identity\)/g) || []).length >= 3,
    'editor.replace/selection/applyChanges 三处回包都必须经脱敏(实际 ' +
    (text.match(/editorResponseFor\(identity\)/g) || []).length + ' 处)');
  // 编辑器命令帧快照脱敏 + 沙箱轨编辑器命令经容器回推(与普通命令同通道)。
  assert.match(text, /private editorStateForManifest\(/, 'P2-005: 命令帧快照档位脱敏必须存在');
  const invokePos = text.indexOf('private async invokeEditorCommand(');
  assert.ok(invokePos > 0, 'invokeEditorCommand 必须存在');
  const invoke = text.slice(invokePos, text.indexOf('static async tryExecuteCommand('));
  assert.match(invoke, /editorStateForManifest\(/, 'invokeEditorCommand 必须用档位脱敏快照(未声明 readActive 不带正文)');
  assert.match(invoke, /record\.manifest\.sandboxService && this\.sandboxController !== null/,
    '沙箱轨插件的编辑器命令必须按 sandboxService 路由');
  assert.match(invoke, /dispatchSandboxCommand\(body\)/, '沙箱轨编辑器命令必须经容器回推(与普通命令同通道)');
  // 夹具对账:沙箱编辑器夹具(在库时)必须声明沙箱轨入口 + editor 三档,才能正面行使三条通道;
  // 未声明档位的对照由 authz-matrix M2b-2 的 broker 层逐档拒绝覆盖。
  const fixturePath = path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins',
    'sandbox-editor-min', 'manifest.json');
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.manifestVersion, 2, '编辑器夹具必须是 manifestVersion 2');
    assert.equal(fixture.entrypoints && fixture.entrypoints.service, 'sandbox:',
      '编辑器夹具必须声明沙箱轨入口');
    assert.deepEqual([
      fixture.capabilities.editor.readActive,
      fixture.capabilities.editor.writeSelection,
      fixture.capabilities.editor.writeDocument], [true, true, true],
      '编辑器夹具必须声明 editor 三档(readActive/writeSelection/writeDocument)');
  }
});

// --- R37(P4-001) Modal/Menu/Setting Builder 三交互面接线 ------------------------------------
test('P4-001 交互面接线:handler/registry/sandbox.ui 回推/设置值回推/销毁回收/宿主渲染组件', () => {
  const text = runtimeEts();
  // 宿主 handler 面:描述符出站四方法全部在案(身份段表键 + 修订号驱动渲染)。
  for (const method of ['ui.modal.open', 'ui.modal.close', 'ui.menu.show', 'ui.menu.hide']) {
    assert.match(text, new RegExp("registerHandler\\('" + method.replace(/\./g, '\\.') + "'"),
      method + ' handler 必须在案(P4-001)');
  }
  assert.match(text, /manager\.modalSurfaces\.set\(identity \+ '#' \+ modalId, surface\)/,
    'Modal 在途表键必须带身份段(插件只能寻址自己的在途面)');
  assert.match(text, /manager\.menuSurfaces\.set\(identity \+ '#' \+ menuId, surface\)/,
    'Menu 在途表键必须带身份段');
  // capability 域映射:与 Notice 同域(notifications),未声明即拒(fail-closed)。
  assert.match(text,
    /method === 'ui\.modal\.open' \|\| method === 'ui\.modal\.close' \|\|\s*\n\s*method === 'ui\.menu\.show' \|\| method === 'ui\.menu\.hide'\) \{ return caps\.notifications; \}/,
    'ui.modal.*/ui.menu.* 的 capability 域必须映射 notifications(与 Notice 同域)');
  // sandbox.ui 回推链:与 dispatchSandboxCommand 同一信任形态(身份只用于容器路由)。
  assert.match(text, /private notifySandboxUiEvent\(/, 'sandbox.ui 回推派发器必须在案');
  assert.match(text, /window\.lexiSandboxUiEvent && window\.lexiSandboxUiEvent\(/,
    '容器页回推函数必须带存在性守卫(旧容器页 fail-safe)');
  const notifyBody = text.slice(text.indexOf('private notifySandboxUiEvent('),
    text.indexOf('private notifySandboxUiEvent(') + 1600);
  assert.match(notifyBody, /record\.manifest\.sandboxService/,
    'sandbox.ui 回推必须按 sandboxService 分流(legacy 轨无容器回推面)');
  assert.match(notifyBody, /'pluginId': pluginId as Object/,
    '容器路由载荷必须携带 pluginId(容器页路由用,不进 iframe 帧)');
  // 设置值回推:writePluginData 双通道(legacy dispatch 保持 + 沙箱轨 sandbox.ui)。
  assert.match(text, /this\.runtime\.dispatch\('settings\.values'/,
    'legacy 轨设置值回推通道不得移除');
  assert.match(text, /notifySandboxUiEvent\(pluginId, 'settings', 'values', 'changed', -1, values\)/,
    '沙箱轨设置值回推必须随 writePluginData 派发(R36 缺口收口)');
  // 销毁回收:disable 尾序 dropPluginSurfaces(在途弹层不残留)。
  const disableBody = text.slice(text.indexOf('async disablePlugin('),
    text.indexOf('private failPendingLifecycleWaits('));
  assert.match(disableBody, /this\.dropPluginSurfaces\(pluginId\)/,
    '交互面必须随插件销毁回收(disable 尾序)');
  assert.match(text, /pluginModalSurfaces\(\): LexiPluginModalSurface\[\]/,
    '渲染读取面(pluginModalSurfaces)必须在案');
  // 宿主渲染组件:LexiPluginSurfaceHost 观察修订号 + Index 嵌入。
  const surfaceHost = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components',
    'plugin', 'LexiPluginSurfaceHost.ets'), 'utf8');
  assert.match(surfaceHost, /struct LexiPluginSurfaceHost/, '宿主渲染组件必须在案');
  assert.match(surfaceHost, /lexiPluginRevision/, '渲染组件必须观察插件修订号(与 Ribbon 同纪律)');
  assert.match(surfaceHost, /dismissPluginModal\(/, '用户关闭必须回流 manager(回推 onClose)');
  assert.match(surfaceHost, /choosePluginMenuItem\(/, '用户点选必须回流 manager(回推 onClick)');
  const indexText = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8');
  assert.match(indexText, /LexiPluginSurfaceHost\(\)/, '渲染组件必须嵌入主页面(Index Stack)');
  // 容器页路由:lexiSandboxUiEvent 按 pluginId 路由,frame 本体零身份字段。
  const containerText = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile',
    'lexinote_sandbox_container.js'), 'utf8');
  assert.match(containerText, /window\.lexiSandboxUiEvent = function/, '容器 ui 事件路由必须在案');
  const frameZone = containerText.slice(containerText.indexOf("type: 'sandbox.ui'"),
    containerText.indexOf("type: 'sandbox.ui'") + 260);
  assert.doesNotMatch(frameZone, /pluginId|token|activationId/,
    'sandbox.ui 帧本体不得携带身份字段(身份只在容器路由)');
  // 内置夹具对账(夹具环境约定:在库时强校验)。
  const fixturePath = path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins',
    'sandbox-ui-min', 'manifest.json');
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.manifestVersion, 2, '交互面夹具必须是 manifestVersion 2');
    assert.equal(fixture.entrypoints && fixture.entrypoints.service, 'sandbox:',
      '交互面夹具必须声明沙箱轨入口');
    assert.equal(fixture.capabilities && fixture.capabilities.notifications, true,
      '交互面夹具必须声明 notifications(ui.modal.*/ui.menu.* 的 capability 域)');
    assert.ok(text.indexOf("'plugins/sandbox-ui-min'") >= 0,
      '交互面夹具必须进内置夹具白名单(BUNDLED_PLUGIN_IDS)');
  }
});

test('P5-004 分级呈现(§4.5 必需/可选/高风险)：capabilityTagsOfV2Caps 标签三档分类真跑', () => {
  const v2Mod = loadEts('plugin/LexiPluginManifestV2', kits);
  const caps = new v2Mod.LexiManifestV2Caps();
  caps.vault.write.enabled = true;
  caps.vault.delete = true;
  caps.editor.readActive = true;
  caps.workspace.commands = true;
  caps.network.origins = ['api.example.com'];
  caps.clipboard.read = true;
  caps.clipboard.write = true;
  caps.notifications = true;
  const tags = v2Mod.capabilityTagsOfV2Caps(caps);
  const view = v2Mod.classifyCapabilityTags(tags);
  assert.deepEqual([...view.risky], ['clipboard.read', 'editor.readActive', 'network:api.example.com', 'vault.delete', 'vault.write'],
    '高风险 = 笔记读改删/敏感读取/剪贴板读/网络外联');
  assert.deepEqual([...view.optional], ['clipboard.write', 'notifications'], '可选 = 纯增量体验面');
  assert.deepEqual([...view.required], ['netreq:65536', 'netres:1048576', 'storage.quota:1048576', 'workspace.commands'],
    '必需/基线 = 基础交互面与配额披露');
  // 分档必须是全集划分:每个正典标签恰好落一档(分类不改变指纹输入)。
  const union = [...view.risky, ...view.optional, ...view.required].sort();
  assert.deepEqual(union, [...tags].sort(), '三档并集必须等于标签全集(分类纯展示,不吞标签)');
});

test('P5-004 市场 UI：安装 → 授权面板 → 同意启用;拒绝 = 保持未启用', () => {
  const sheetText = marketSheetEts();
  assert.match(sheetText, /pendingConsentId/, '安装完成必须进入待授权态而不是报已启用');
  assert.match(sheetText, /已安装（未启用）：/, '安装成功文案必须明示未启用');
  assert.match(sheetText, /同意并启用/, '授权面板必须有显式同意按钮');
  assert.match(sheetText, /暂不启用/, '授权面板必须有拒绝通路(拒绝 = 不启用)');
  assert.match(sheetText, /consentEnablePlugin\(/, '同意必须走 consentEnablePlugin(grant→enable)');
  assert.match(sheetText, /classifyCapabilityTags\(/, '权限清单必须分级呈现(RFC §4.5)');
  assert.match(sheetText, /高风险权限/, '高风险权限必须显式标注');
  assert.match(sheetText, /安装授权确认/, '授权面板必须展示插件元数据与权限用途披露');
  // 首装不携带 grantApproved(那是升级重授权专用通道):只在 pendingGrantEntry 确认行置真。
  // P2-009(R32):options 改携带 targetPluginId——升级包 integrity_mismatch 时宿主据此
  // 隔离已装版本(§6.4/§9.2);grantApproved 仍只在重授权确认行置真(首装默认不授权)。
  const installBody = sheetText.slice(sheetText.indexOf('private async install('), sheetText.indexOf('private async revokePermissions('));
  assert.match(installBody, /const optionsBody: Record<string, Object> = \{ 'targetPluginId': entry\.id as Object \};/,
    '安装选项必须携带目标插件 id(P2-009 完整性失败隔离的归属依据)');
  assert.match(installBody, /if \(grantApproved\) \{ optionsBody\['grantApproved'\] = true as Object; \}/,
    'grantApproved 仅在重授权确认行置真(首装默认不授权,P5-004 语义保持)');
  assert.match(installBody, /pendingConsentId = pluginId/, '首装成功后进入待授权');
});

test('P5-004 设置页接线：未授权插件的开关 = 同意行内权限清单(consent 通路)', () => {
  for (const name of ['LexiSettingsTab.ets', 'LexiSettingsWindow.ets']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', name), 'utf8');
    assert.match(text, /permissionStateOf\(id\) !== 'granted'[\s\S]{0,120}consentEnablePlugin\(id\)/,
      name + ': 未授权声明型插件的开启必须走 consent 通路');
    assert.match(text, /permissionNote/, name + ': 行内权限标签必须展示(开关即同意的可读性前提)');
    assert.match(text, /待授权/, name + ': 未授权插件必须标出待授权状态');
    assert.match(text, /已安装插件（未启用/, name + ': 侧载安装提示必须明示未启用');
  }
});

// --- 9b. P5-007(R40/KI-1) 市场条目塌陷：已安装列表限高可滚动,条目区保住正高度 -------------
// P0-012 真机发现(dump 证明):根 Column height('100%') 把面板钉在视口上,已安装 8+ 行一溢出,
// layoutWeight(1) 的条目 Scroll 拿到 max(0, 负数)=0 高——条目不是滚出视口而是根本不渲染
// (容器内滑 6 屏前后 dump 逐字节相同,内层 Scroll 节点不存在)。修复形状 = 发现里给的
// constraintSize/scrollable-installed-list:已安装列表改成内部限高滚动。本用例把塌陷条件
// 和修复后的空间分配都钉进离线门禁,真机 --market-repro reachable=true 复测归 B-001。
test('P5-007 市场条目塌陷(KI-1/P0-012)：已安装列表限高可滚动,8-9 行溢出时条目区保住正高度', () => {
  const sheet = marketSheetEts();
  // 1) 结构断言:已安装段(必须先于市场条目段)被包进带 constraintSize maxHeight 的内部滚动 Scroll。
  const installedAt = sheet.indexOf('if (this.installed.length > 0) {');
  const entriesAt = sheet.indexOf('ForEach(this.entries');
  assert.ok(installedAt > 0 && entriesAt > installedAt, '已安装段必须先于市场条目段(源锚点漂移,先修锚点)');
  const installedBlock = sheet.slice(installedAt, entriesAt);
  const cap = /constraintSize\(\{ maxHeight: '(\d+)%' \}\)/.exec(installedBlock);
  assert.ok(cap, 'P5-007:已安装列表必须用 constraintSize({ maxHeight: … }) 限高——条目区不被挤塌的前提');
  assert.ok(/Scroll\(\) \{[\s\S]*?ForEach\(this\.installed/.test(installedBlock),
    'P5-007:已安装列表必须包进 Scroll 内部滚动(限高后超出行仍可达,不许静默裁剪)');
  assert.match(installedBlock, /\.scrollBar\(BarState\.Auto\)/, 'P5-007:已安装限高滚动区必须有滚动条(可发现性)');
  const pct = Number(cap[1]);
  assert.ok(pct >= 20 && pct <= 50, 'P5-007:限高比例须在 20-50%(太小已安装列表不可用,太大条目区保不住),实为 ' + pct + '%');
  // 2) 机制两端保持:条目 Scroll 仍 layoutWeight(1)+可滚,根 Column 仍 height('100%')——
  //    修复靠"已安装限高"消除负空间,不改根布局(flows 的市场容器发现/滚动轮询依赖这个形态)。
  const entriesBlock = sheet.slice(entriesAt);
  assert.match(entriesBlock, /\.layoutWeight\(1\)/, '市场条目 Scroll 必须保留 layoutWeight(1)(flows 可达面)');
  assert.match(entriesBlock, /\.scrollBar\(BarState\.Auto\)/, '市场条目 Scroll 必须保留滚动条(Auto)');
  assert.match(sheet, /\.height\('100%'\)/, '根 Column height(100%) 必须保持(钉视口的既有形态)');
  // 3) 计算高度行为:行距 132px = P0-012 真机实测行距(flows clickRowAction 配对注释);
  //    固定区(标题行+按钮行+间距+内边距)上界 170。面板高取两个真实容器:
  //    手机 bindSheet 的 height 从 LexiSettingsTab.ets 现读(改了自动跟随),2in1 视口 1179 为 P0-012 dump 实测。
  const tabText = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'LexiSettingsTab.ets'), 'utf8');
  const sheetHeight = /bindSheet\(\$\$this\.sheetOpen[\s\S]{0,200}?height: (\d+)/.exec(tabText);
  assert.ok(sheetHeight, 'LexiSettingsTab 的市场 bindSheet 必须带固定 height(测试按它算空间分配)');
  const PITCH = 132;
  const CHROME = 170;
  const CARD = 110; // 一张市场条目卡的最小可视高度(内边距 24 + 名称 + 两行简介)
  const containers = [['bindSheet(手机,height=' + sheetHeight[1] + ')', Number(sheetHeight[1])],
    ['2in1 设置窗视口(P0-012 实测 1179)', 1179]];
  for (const [label, h] of containers) {
    for (const n of [8, 9]) {
      assert.ok(h - CHROME - n * PITCH < 0,
        label + ' 已安装 ' + n + ' 行时修复前条目区必为负空间(P0-012 塌陷条件;不为负说明行距/固定区常量漂移,重测后再改)');
      assert.ok(h - CHROME - Math.min(n * PITCH, (pct / 100) * h) >= CARD,
        label + ' 已安装 ' + n + ' 行时修复后条目区必须 ≥ 一张条目卡(≈' + CARD + 'px),实为 ' +
        Math.floor(h - CHROME - Math.min(n * PITCH, (pct / 100) * h)) + 'px——限高比例或面板高度变了,重算后再改');
    }
    // flows 验收区间 N=3..8 的下界:条目区同样保住(收起侧不再依赖夹具收纳)。
    for (const n of [3, 4, 5]) {
      assert.ok(h - CHROME - Math.min(n * PITCH, (pct / 100) * h) >= CARD,
        label + ' 已安装 ' + n + ' 行时修复后条目区必须 ≥ 一张条目卡(flows --market-repro N=3..8 的可达前提)');
    }
  }
  // 备注:授权面板(P5-004)打开时面板空间竞争另算——它是瞬时态,且同意面板优先级高于条目可见;
  // KI-1 的塌陷场景是"已安装列表溢出"这个持久态,不在本用例断言范围。
});

// --- 10. R32(P1-008 + P2-009) 执行环境销毁闭环 + 生命周期状态机补全 ----------------------
test('R32 销毁闭环与状态机接线：五步尾序/quarantine 触发链/permission-pending/revoked/degraded', () => {
  const text = runtimeEts();
  const managerEts = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginLifecycleManager.ets'), 'utf8');
  const activationEts = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginActivation.ets'), 'utf8');
  const containerEts = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile',
    'lexinote_sandbox_container.js'), 'utf8');
  // P2-009:RFC §4.1 全量状态面进状态机(类型面);可达性/转出行为级断言在 lifecycle-once L7。
  assert.match(activationEts, /'permission-pending' \| 'disabled'/, 'permission-pending 进 LexiLifecycleState');
  assert.match(activationEts, /'degraded' \| 'stopping'/, 'degraded 进 LexiLifecycleState');
  assert.match(activationEts, /'quarantined' \| 'revoked'/, 'revoked 进 LexiLifecycleState');
  assert.match(managerEts, /static canTransitStatic\(from: LexiLifecycleState, to: LexiLifecycleState\): boolean/,
    '迁移表静态查询面(门禁逐格对账/Inspector 对账)');
  assert.match(managerEts, /table\['revoked'\] = \['permission-pending', 'uninstalling', 'removed'\];/,
    'revoked 转出: 卸载或重新落账 lift(不得直接 starting)');
  assert.match(managerEts, /table\['quarantined'\] = \['stopping', 'disabled', 'uninstalling'\];/,
    'quarantined 转出: 强停释放或卸载(不得直接 starting)');
  // P2-009:quarantine 由真实安全事件触发(P5-001 完整性失败链),不是死状态。
  assert.match(text, /async quarantinePlugin\(pluginId: string, reason: string\): Promise<boolean> \{/,
    'quarantine 插件级入口(标记→销毁闭环→落账)');
  assert.match(text, /import \{[\s\S]*ERROR_INTEGRITY_MISMATCH[\s\S]*\} from '\.\/LexiPluginManifest';/,
    'integrity_mismatch 机器码进 runtime(触发源接线)');
  assert.match(text, /message\.indexOf\(ERROR_INTEGRITY_MISMATCH \+ ':'\) === 0[\s\S]{0,300}quarantinePlugin\(targetPluginId,/,
    '升级包完整性失败 → 已装版本隔离(§6.4/§9.2)');
  assert.match(text, /record\.quarantineReason\.length > 0[\s\S]{0,240}return false/,
    'enablePlugin 隔离门:quarantined 拒绝启用(唯一出口=卸载)');
  assert.match(text, /this\.lifecycle\.markRevoked\(pluginId, 'user-revoke/, '撤销链落 revoked(P2-010 联动)');
  assert.match(text, /this\.lifecycle\.markPermissionPending\(manifest\.id, 'P5-004: 已安装未授权\(等待用户同意\)'\)/,
    '首装默认路径落 permission-pending(R26 面)');
  assert.match(text, /markDegradedIfShrunk\(manifest\.id, removedCaps\)/, '能力收缩升级落 degraded(降级运行记账)');
  const installerEts = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPluginInstaller.ets'), 'utf8');
  assert.match(installerEts, /lastRemovedCaps = diff\.removed\.slice\(\);/, 'installer 快照能力收缩(T4.4 只减不增放行)');
  assert.match(text, /this\.lifecycle\.markVerified\(manifest\.id, 'scan: manifest 解析通过\(安装面验证\)'\)/,
    '扫描链 verified 可达');
  // P1-008:销毁闭环尾序 + 容器销毁面(行为级负例在 context-registry D 组)。
  assert.match(text, /private failPendingLifecycleWaits\(pluginId: string, reason: string\): void/,
    '清 pending:在途装载/卸载等待快速失败');
  assert.match(text, /pendingOnloadFail: Map<string, \(reason: string\) => void> = new Map\(\)/,
    '装载等待快速失败通道');
  assert.match(containerEts, /window\.lexiContainerTeardown = function \(pluginId\) \{/,
    '容器侧 per-plugin iframe 销毁面(SEC-013)');
  assert.match(text, /window\.lexiContainerTeardown && window\.lexiContainerTeardown\(/,
    '宿主接线带存在性守卫(fail-safe)');
  // 市场安装链携带目标插件 id(完整性失败隔离的归属依据)。
  assert.match(text, /const claimed = parsed\['targetPluginId'\];/, 'installZip 解析 targetPluginId');
});

// --- R39(P2-014 + P2-015) 命令失败可见 + 卸载清理身份链 ------------------------------------
test('R39 P2-014/P2-015: 命令派发失败 fail-visible + plugin-owned 入口预检后置 + 卸载清理带身份', () => {
  const text = runtimeEts();
  const shimSrc = fs.readFileSync(path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile',
    'lexinote_plugin_shim.js'), 'utf8');
  const brokerEts = fs.readFileSync(path.join(CORE, 'plugin', 'LexiPermissionBroker.ets'), 'utf8');
  // --- P2-014:命令族派发失败统一可见出口(不再 .catch(()=>{}) 吞) ---
  assert.match(text, /private reportCommandDispatchFailure\(pluginId: string, label: string, error: Error\): void/,
    'P2-014: 统一失败出口必须存在(日志+错误态+用户通知三面记录)');
  const helperPos = text.indexOf('private reportCommandDispatchFailure(');
  const helper = text.slice(helperPos, text.indexOf('private async invokePluginCommand(') > helperPos
    ? text.indexOf('private async invokePluginCommand(') : helperPos + 1200);
  assert.match(helper, /pluginError\(/, '失败出口必须落 pluginError 日志(设备可对账)');
  assert.match(helper, /record\.errorState = message/, '失败出口必须记 record.errorState(设置页/Inspector 可见)');
  assert.match(helper, /this\.uiHost\.toast\(/, '失败出口必须发用户可见通知(既有 Notice 通道)');
  const invokeCmd = text.slice(text.indexOf('private async invokePluginCommand('),
    text.indexOf('private async dispatchSandboxCommand('));
  assert.ok(invokeCmd.length > 0, 'invokePluginCommand 必须存在');
  assert.match(invokeCmd, /reportCommandDispatchFailure\(pluginId, '插件命令 ' \+ fullId, error as Error\)/,
    'invokePluginCommand 派发失败必须走可见出口');
  assert.doesNotMatch(invokeCmd, /\.catch\(\(\): void => \{\}\)/,
    'P2-014 主缺陷: invoke.command 派发失败不得再被 .catch(()=>{}) 吞掉');
  for (const [fn, label] of [['private async invokeEditorCommand(', '编辑器命令 '],
    ['async invokeRibbon(', 'Ribbon 回调 ']]) {
    const slice = text.slice(text.indexOf(fn));
    assert.match(slice, new RegExp('reportCommandDispatchFailure\\(pluginId, \'' + label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + "'"),
      fn + ' 同类吞噬点必须一并修(P2-014)');
  }
  // 页面侧:命令回调失败的 ui.notice 必须带命令归属插件的令牌(匿名通知会被宿主
  // fail-closed 拒收,失败退化成静默——设备证据 open-weekly-note 零通知零日志)。
  const cmdCatch = shimSrc.slice(shimSrc.indexOf("if (method === 'invoke.command')"),
    shimSrc.indexOf("if (method === 'invoke.editorCommand')"));
  assert.match(cmdCatch, /hostCall\('ui.notice', \{[\s\S]*\}, commandToken\)/,
    'P2-014: 命令失败通知必须携带归属插件令牌');
  assert.match(cmdCatch, /命令执行失败 ' \+ String\(message\.fullId/,
    '失败通知必须点明是哪条命令(可对账)');
  const editorCatch = shimSrc.slice(shimSrc.indexOf("if (method === 'invoke.editorCommand')"),
    shimSrc.indexOf("if (method === 'load.plugin')"));
  assert.match(editorCatch, /editorCommandToken/, '编辑器命令回调必须有自己的身份令牌(原实现误用命令分支的悬挂变量)');
  assert.match(editorCatch, /hostCall\('ui.notice',[\s\S]*\}, editorCommandToken\)/,
    '编辑器命令失败通知必须带身份(P2-014 同类吞噬点)');
  // --- P2-015:入口预检后置(plugin-owned 归属判定在处理器层)+ 卸载清理身份链 ---
  assert.match(text, /this\.broker\.entryAuthorize\(LexiWebRuntime\.contextOf\(role, trusted\), method\)/,
    'P2-015: call() 预检必须用 entryAuthorize(resource-less 预检不得直判 plugin-owned)');
  assert.match(brokerEts, /entryAuthorize\(ctx: LexiCallerContext, method: string\): LexiAuthzDecision \{/,
    'entryAuthorize 必须在 broker(矩阵知识单一真源)');
  const entryBody = brokerEts.slice(brokerEts.indexOf('entryAuthorize(ctx: LexiCallerContext, method: string): LexiAuthzDecision {'),
    brokerEts.indexOf('authorize(ctx: LexiCallerContext, method: string, resource: LexiAuthzResource | null = null)'));
  assert.match(entryBody, /ctx\.role === 'plugin' && this\.kindOf\(method\) === 'plugin-owned'/,
    '仅 plugin-owned+插件角色后置(其余逐格与 authorize 一致)');
  assert.match(entryBody, /return this\.authorize\(ctx, method, null\);/, '其余 kind 委托 authorize(resource=null 语义不变)');
  // 处理器层归属复查不得缺席(entryAuthorize 后置的前提:五个 owned 方法都带 resource 复查)。
  for (const method of ['commands.remove', 'views.remove', 'events.off', 'workspace.closeView', 'codeblocks.unregister']) {
    assert.match(text, new RegExp("registerHandler\\('" + method.replace(/\./g, '\\.') + "'[\\s\\S]{0,600}authzFor\\("),
      method + ' 处理器必须带 resource 复查(authzFor)——入口后置的语义前提');
  }
  // 卸载清理身份链:unloadPlugin 与 loadPlugin 的 withToken 对称 + 清理闭包显式带身份。
  const unloadBody = shimSrc.slice(shimSrc.indexOf('async function unloadPlugin(pluginId)'),
    shimSrc.indexOf('window.lexiRuntime = {'));
  assert.match(unloadBody, /var pluginToken = instance \? objectToken\(instance\) : '';/,
    'P2-015: 卸载路径必须先捕获插件身份');
  assert.match(unloadBody, /withToken\(pluginToken, function \(\) \{ instance\.unload\(\); \}\)/,
    'onunload 必须在插件身份里执行(与 loadPlugin 的 withToken 装载对称)');
  assert.match(unloadBody, /hostCall\('plugin\.unload\.done', \{ id: pluginId \}, pluginToken \|\| undefined\)/,
    'unload.done 带原身份(审计面不再落 identity.anonymous 噪音)');
  const boundCleanups = shimSrc.match(/objectToken\(self\) \|\| currentToken\(\)\)/g) || [];
  assert.ok(boundCleanups.length >= 5,
    '清理闭包显式携带登记者身份(views.remove/commands.remove/ui.removeRibbon/settings.unregister/codeblocks.unregister),实际 ' + boundCleanups.length);
  assert.doesNotMatch(shimSrc, /hostCall\('commands\.remove', \{ fullId: fullId \}\)\.catch/,
    'commands.remove 清理不得再有无身份形态(匿名=宿主 fail-closed,清理失效)');
});

// --- 9c. P1-009(R33) SEC runtime gates 行为级真跑(SEC-005/006/008/009/011/012) ------------
// 此前 P2-003/004/005 的执行面在本门禁只有静态锚(§6),路径白名单另有 manifest 级真跑
// (manifest-v2 V5.6-9);本节把 LexiPluginRuntime.ets 转译装载,从类原型上真调
// fsGate/vaultReadGate/storageQuotaGate——判定代码就是交付的同一份编译产物,SEC 的
// 正/负用例逐格断言(不再只证"gate 存在")。原型提取的合法性:这些 gate 全部只依赖
// this.manifestFor 与模块级纯函数,不触碰宿主运行时状态。
test('SEC runtime gates 行为级(P1-009/R33)：fsGate/vaultReadGate/storageQuotaGate 正负用例', () => {
  const runtimeMod = loadSecRuntime();
  const proto = runtimeMod.LexiPluginManager.prototype;
  assert.equal(typeof proto.fsGate, 'function', 'LexiPluginManager.fsGate 必须可提取');
  const manifests = {
    // v2 写/读路径白名单都收敛在 notes/draft/ 下;storage 配额 10 字符。
    p2: { manifestVersion: 2, capabilitiesDeclared: true, capabilities: { fs: true },
      v2: { vault: { read: { enabled: true, paths: ['notes/draft/'] }, write: { enabled: true, paths: ['notes/draft/'], delete: false } },
        storage: { quotaBytes: 10 } } },
    // v2 但未声明 fs 域(路径白名单放行后,应在 checkFsCapability 处拒绝——域声明缺失)。
    p2n: { manifestVersion: 2, capabilitiesDeclared: true, capabilities: { fs: false },
      v2: { vault: { read: { enabled: false, paths: [] }, write: { enabled: true, paths: ['notes/draft/'] }, delete: false },
        storage: { quotaBytes: 10 } } },
    // v1 带声明的旧语义;v1 不带 fs 声明。
    v1: { manifestVersion: 1, capabilitiesDeclared: true, capabilities: { fs: true }, v2: null },
    v1n: { manifestVersion: 1, capabilitiesDeclared: true, capabilities: { fs: false }, v2: null }
  };
  const host = { manifestFor: (id) => manifests[id] || null };
  const denied = (code, message) => {
    const parsed = JSON.parse(code);
    assert.equal(parsed.ok, false, '应拒绝: ' + code);
    assert.equal(parsed.code, 'capability_denied', '拒绝码 capability_denied: ' + code);
    if (message) { assert.ok(parsed.error.indexOf(message) >= 0, '拒绝文案点名: ' + parsed.error); }
  };
  // SEC-005/008 面:身份归属失败 fail-closed(未安装插件的调用方不落任何 fs 判定)。
  denied(proto.fsGate.call(host, 'ghost-plugin', 'vault.modify', 'notes/draft/a.md'), '无法归属到已安装插件');
  // SEC-008 负例:v2 未声明 fs 域 → vault.modify 拒;v1 未声明 fs → 拒。
  denied(proto.fsGate.call(host, 'p2n', 'vault.modify', 'notes/draft/a.md'), '未声明');
  denied(proto.fsGate.call(host, 'v1n', 'vault.modify', 'notes/draft/a.md'), '未声明');
  // SEC-008 负例:v2 写路径白名单外拒绝。
  denied(proto.fsGate.call(host, 'p2', 'vault.modify', 'notes/other/x.md'), '路径不在 vault.write.paths 白名单');
  // SEC-009 负例:穿越形态路径不得借道写 gate。
  denied(proto.fsGate.call(host, 'p2', 'vault.modify', '../../../etc/x.md'), '路径不在 vault.write.paths 白名单');
  // 正例:白名单内放行;v1 带 fs 声明沿用旧语义放行。
  assert.equal(proto.fsGate.call(host, 'p2', 'vault.modify', 'notes/draft/a.md'), '', '白名单内写入放行');
  assert.equal(proto.fsGate.call(host, 'v1', 'vault.modify', 'notes/anywhere.md'), '', 'v1 带 fs 声明放行(legacy 语义)');
  // SEC-006 面:data.* 归 storage 域,与 vault.write 解绑——只带 storage 的 v2 也可读写私有 data.json。
  assert.equal(proto.fsGate.call(host, 'p2', 'data.save'), '', 'v2 data.save 归 storage 域放行');
  assert.equal(proto.fsGate.call(host, 'p2', 'data.load'), '', 'v2 data.load 归 storage 域放行');
  denied(proto.fsGate.call(host, 'v1n', 'data.load'), '未声明');
  assert.equal(proto.fsGate.call(host, 'v1', 'data.load'), '', 'v1 带 fs 声明的 data.load 沿用旧语义');
  // SEC-009 读侧:跨段/前缀外读取拒绝,白名单内放行;v1 无此维度放行(design)。
  denied(proto.vaultReadGate.call(host, 'p2', 'notes/other/x.md'), '路径不在 vault.read.paths 白名单');
  denied(proto.vaultReadGate.call(host, 'p2', '../../../etc/passwd'), '路径不在 vault.read.paths 白名单');
  assert.equal(proto.vaultReadGate.call(host, 'p2', 'notes/draft/a.md'), '', '读白名单内放行');
  denied(proto.vaultReadGate.call(host, 'p2n', 'notes/draft/a.md'), '未声明');
  assert.equal(proto.vaultReadGate.call(host, 'v1', 'notes/anywhere.md'), '', 'v1 读无白名单维度(既有语义)');
  // SEC-011 负例:超出 storage.quotaBytes 的 data.save 在落盘前被拒;边界与 v1 语义。
  const overQuota = proto.storageQuotaGate.call(host, 'p2', 100);
  denied(overQuota, 'storage: 数据量 100 超出配额 10');
  assert.equal(proto.storageQuotaGate.call(host, 'p2', 10), '', '恰好等于配额放行(边界)');
  assert.equal(proto.storageQuotaGate.call(host, 'p2', 5), '', '配额内放行');
  assert.equal(proto.storageQuotaGate.call(host, 'v1', 1000000), '', 'v1 无配额维度(既有语义)');
});

test('SEC-012 RPC 超时行为级(P1-009/R33)：LexiWebRuntime.withTimeout 真跑', async () => {
  const runtimeMod = loadSecRuntime();
  const withTimeout = runtimeMod.LexiWebRuntime.withTimeout;
  assert.equal(typeof withTimeout, 'function', 'withTimeout 必须可提取(所有 dispatchWithTimeout/生命周期等待共用)');
  // 负例:永不完成的 RPC 在超时点被拒绝,错误带标签——宿主不被挂死。
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'sec-rpc-none'),
    /插件操作超时: sec-rpc-none/);
  // 序:超时必须先于慢工作胜出(不是等 work 完成才判超时)。
  await assert.rejects(() => withTimeout(new Promise((resolve) => { setTimeout(resolve, 200); }), 20, 'sec-rpc-slow'),
    /插件操作超时: sec-rpc-slow/);
  // 正例:快工作胜出,结果原样交付(定时器被 finally 清理,不拖住进程)。
  assert.equal(await withTimeout(Promise.resolve('sec-ok'), 1000, 'sec-rpc-fast'), 'sec-ok');
});

test('静态审核的模块白名单：@codemirror 放行，其它 require 红灯', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-audit-'));
  const write = (name, manifest, mainJs) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'main.js'), mainJs);
    return dir;
  };
  const manifest = { id: 'probe', name: 'Probe', version: '1.0.0', author: 'a', capabilities: { network: ['api.example.com'], fs: true, clipboard: false } };
  const allowed = write('allowed', manifest, 'const { Plugin } = require("obsidian");\nconst { EditorView } = require("@codemirror/view");\nconst { x } = require("lexinote");\n');
  assert.equal(audit.auditPackage(allowed).critical, 0, '@codemirror/lexinote/obsidian 必须白名单');

  const badModule = write('bad-module', manifest, 'require("left-pad");\n');
  assert.ok(audit.auditPackage(badModule).critical > 0, '未知模块必须红灯');

  const declaredFetch = write('declared-fetch', manifest, 'fetch("https://api.example.com/x");\n');
  assert.equal(audit.auditPackage(declaredFetch).critical, 0, '声明过的域名应放行');
  const undeclaredFetch = write('undeclared-fetch', manifest, 'fetch("https://evil.example.com/x");\n');
  assert.equal(audit.auditPackage(undeclaredFetch).critical, 1, '未声明域名必须红灯');

  const dynamicImport = write('dynamic-import', manifest, 'const name = pick();\nimport(name);\n');
  assert.ok(audit.auditPackage(dynamicImport).critical > 0, '计算出来的动态 import 必须红灯');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- runner --------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.run();
      console.log('ok - ' + item.name);
    } catch (error) {
      failed++;
      console.error('FAIL - ' + item.name + '\n  ' + ((error && error.stack) || error));
    }
  }
  console.log('plugin-dist-regression: ' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exitCode = failed > 0 ? 1 : 0;
})();
