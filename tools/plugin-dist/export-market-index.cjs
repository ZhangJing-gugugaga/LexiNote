#!/usr/bin/env node
// Export the single market index schema (v1) from the locked fixture set, or validate an
// existing index with the same implementation the client mirrors.
//
//   node tools/plugin-dist/export-market-index.cjs --from-lock [--out exports/market-index-v1.json]
//   node tools/plugin-dist/export-market-index.cjs --check exports/market-index-v1.json
//
// The emitted JSON is fed back through tools/plugin-dist/market-index-v1.cjs before it is
// written, so an index that the client would reject can never be published.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeZip, readZip } = require('./zip-store.cjs');
const validator = require('./market-index-v1.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOCK = path.join(REPO_ROOT, 'tools', 'plugins-fixtures', 'manifest.lock.json');
const DEFAULT_OUT = path.join(REPO_ROOT, 'exports', 'market-index-v1.json');
const DEFAULT_ZIP_DIR = path.join(REPO_ROOT, '.fixtures-out', 'market-zips');
const DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/ZhangJing-gugugaga/lexinote-releases/master/zips';
const DEFAULT_API_VERSION = '1.0.0';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const options = { mode: '', lock: DEFAULT_LOCK, out: DEFAULT_OUT, zipDir: DEFAULT_ZIP_DIR, baseUrl: DEFAULT_BASE_URL, fixtures: path.join(REPO_ROOT, '.fixtures-out'), check: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-lock') { options.mode = 'from-lock'; }
    else if (arg === '--check') { options.mode = 'check'; options.check = argv[i + 1] || ''; i++; }
    else if (arg === '--lock') { options.lock = path.resolve(argv[i + 1] || ''); i++; }
    else if (arg === '--out') { options.out = path.resolve(argv[i + 1] || ''); i++; }
    else if (arg === '--zip-out') { options.zipDir = path.resolve(argv[i + 1] || ''); i++; }
    else if (arg === '--fixtures') { options.fixtures = path.resolve(argv[i + 1] || ''); i++; }
    else if (arg === '--base-url') { options.baseUrl = String(argv[i + 1] || '').replace(/\/+$/, ''); i++; }
  }
  return options;
}

function packageFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }));
}

function buildFromLock(options) {
  const lock = JSON.parse(fs.readFileSync(options.lock, 'utf8'));
  const problems = [];
  const plugins = [];
  fs.mkdirSync(options.zipDir, { recursive: true });
  for (const fixture of lock.fixtures) {
    const dir = path.join(options.fixtures, fixture.id);
    if (!fs.existsSync(dir)) {
      problems.push(fixture.id + ': 产物目录不存在 (' + dir + ')，先跑夹具构建脚本');
      continue;
    }
    const files = packageFiles(dir);
    if (!files.some((file) => file.name === 'manifest.json')) {
      problems.push(fixture.id + ': 缺少 manifest.json');
      continue;
    }
    const declared = new Map((fixture.artifacts || []).map((artifact) => [artifact.file, artifact.sha256]));
    for (const file of files) {
      const expected = declared.get(file.name);
      if (!expected || !fixture.artifacts) { continue; }
      const actual = sha256(file.data);
      if (actual !== expected) { problems.push(fixture.id + '/' + file.name + ': 产物 sha256 与 lock 不一致 ' + actual + ' != ' + expected); }
    }
    const zipBytes = writeZip(files);
    const zipPath = path.join(options.zipDir, fixture.id + '.zip');
    fs.writeFileSync(zipPath, zipBytes);
    // Read the package back: the index hash must describe the bytes that actually travel.
    const reread = readZip(fs.readFileSync(zipPath));
    if (reread.length !== files.length) { problems.push(fixture.id + ': 回读 zip 文件数不一致'); }
    const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json').data.toString('utf8'));
    const entry = {
      id: String(manifest.id || fixture.id),
      name: String(manifest.name || fixture.id),
      version: String(manifest.version || ''),
      author: String(manifest.author || ''),
      description: String(manifest.description || ''),
      repo: String((fixture.source && fixture.source.repo) || ''),
      minApiVersion: String(manifest.minApiVersion || DEFAULT_API_VERSION),
      isDesktopOnly: Boolean(manifest.isDesktopOnly),
      sha256: sha256(zipBytes),
      zipUrl: options.baseUrl + '/' + fixture.id + '.zip'
    };
    if (manifest.capabilities) { entry.capabilities = manifest.capabilities; }
    plugins.push(entry);
  }
  const index = { schemaVersion: 1, plugins };
  const text = JSON.stringify(index, null, 2) + '\n';
  const verdict = validator.parseIndex(text);
  if (!verdict.ok) { problems.push('导出的索引未通过共享校验: ' + verdict.code + ' ' + verdict.message); }
  if (problems.length > 0) {
    for (const problem of problems) { console.error('  [FAIL] ' + problem); }
    return 1;
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, text);
  console.log('已导出 v1 索引: ' + options.out);
  console.log('  plugins=' + plugins.length + ' sha256 全部来自 zip 实测字节');
  for (const line of verdict.entries) { void line; }
  for (const entry of plugins) {
    console.log('  - ' + entry.id + ' ' + entry.version + '  ' + entry.sha256.slice(0, 16) + '…  ' + entry.zipUrl);
  }
  console.log('  zip 目录: ' + options.zipDir);
  return 0;
}

function check(options) {
  if (!options.check || !fs.existsSync(options.check)) {
    console.error('[plugin-dist] --check 需要一个存在的索引文件');
    return 2;
  }
  const verdict = validator.parseIndex(fs.readFileSync(options.check, 'utf8'));
  console.log('索引校验: ' + path.resolve(options.check));
  console.log('  ok=' + verdict.ok + ' code=' + (verdict.code || '-') + ' schemaVersion=' + verdict.schemaVersion + ' entries=' + verdict.entries.length);
  if (verdict.warnings.length > 0) { console.log('  警告: ' + verdict.warnings.join(', ')); }
  if (!verdict.ok) { console.log('  拒绝原因: ' + verdict.message); return 1; }
  return 0;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'from-lock') { return buildFromLock(options); }
  if (options.mode === 'check') { return check(options); }
  console.error('用法: node tools/plugin-dist/export-market-index.cjs --from-lock | --check <index.json>');
  return 2;
}

if (require.main === module) { process.exitCode = main(process.argv.slice(2)); }

module.exports = { buildFromLock, check, sha256 };
