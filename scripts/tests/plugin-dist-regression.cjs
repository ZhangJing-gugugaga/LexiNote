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
    return require(name);
  };
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: target })(requireShim, module, module.exports);
  return module.exports;
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
  assert.match(text, /tokenForPlugin\(gateway\.identity\)/, '端口身份必须经既有 credential 链进 call()');
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
  for (const id of ['lexi-sample-plugin', 'sandbox-probe', 'sandbox-sample-min']) {
    assert.ok(block.indexOf("'" + id + "'") >= 0, '内置白名单必须包含 ' + id);
  }
  assert.match(block, /permissionStore\.grant\(bundledId/, '白名单启用必须先落账授权(否则 enablePlugin 授权门拒绝)');
  assert.equal((block.match(/enabledIds\.add\(/g) || []).length, 1,
    '首启块只允许经白名单循环启用一次(不得为绕过授权门私开通道)');
  // 沙箱探针链路仍随首启启用(容器页就绪即走沙箱轨)。
  assert.ok(block.indexOf('sandbox-probe') >= 0, 'sandbox-probe 冷启动链不得回归(Round 22)');
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
  const installBody = sheetText.slice(sheetText.indexOf('private async install('), sheetText.indexOf('private async revokePermissions('));
  assert.match(installBody, /grantApproved \? '\{"grantApproved":true\}' : ''/, '安装选项三目保持:默认为空(不授权)');
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
