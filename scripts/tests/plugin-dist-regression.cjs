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
  assert.match(text, /async uninstallPlugin\(/, '宿主必须暴露卸载');
  assert.match(text, /async rollbackPlugin\(/, '宿主必须暴露回滚');
  assert.match(text, /fetchMarketIndex\(/, '市场必须走严格索引解析');
  assert.match(text, /parseMarketIndexResult\(/, '严格解析函数必须被真正调用');
  assert.match(text, /code: string = ''/, 'RpcResponse 必须能携带错误码');
  assert.match(text, /installFromUrl\(url: string, expectedSha256: string = ''\)/, 'installFromUrl 必须能收 sha256');
  assert.match(text, /private wasUninstalled\(/, '卸载记录必须能挡住内置资源重装');
  assert.match(text, /if \(this\.wasUninstalled\(entryName\)\) \{ return; \}/, '内置插件落盘前必须先查卸载记录');
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
