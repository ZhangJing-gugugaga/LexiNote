#!/usr/bin/env node
// Offline regression for the release gate's staging repair passes. No device, no network,
// and never the repository's own rawfile/plugins: every case runs against a temp root that
// holds a copy of the real release-gate.cjs, so what is exercised is the shipped script.
//
//   node scripts/tests/plugin-dist-restore.cjs
//
// Layers:
//   1. --strip-staging --apply alone moves the fixtures out (no --strip required)
//   2. --restore-staging --apply alone brings them back, byte for byte and with no --strip
//   3. restore only fills absent directories: a live directory is never overwritten
//   4. a clean tree makes --restore-staging a no-op that still exits 0
//   5. the default scan after a restore reports the same violation count as before the strip
//   6. the ci strip self-check: a HAP with no fixtures is ok without a stripped copy, a HAP
//      with fixtures must recheck clean, and *.stripped.hap is never a candidate
// That second layer is the red light: put restore back inside `if (strip)` and case 2 fails.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(REPO_ROOT, 'tools', 'plugin-dist');
const REAL_STAGED = path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins');
const REAL_TRASH = path.join(REPO_ROOT, '.fixtures-out', 'strip-trash');
const FIXTURES = ['calendar', 'editor-outliner'];
const SAMPLE = 'lexi-sample-plugin';
const tmpRoots = [];

// Snapshot the real tree first: this test must be able to prove it never touched it.
const realStagedBefore = fs.existsSync(REAL_STAGED) ? fs.readdirSync(REAL_STAGED).sort() : [];
const realTrashBefore = fs.existsSync(REAL_TRASH)
  ? fs.readdirSync(REAL_TRASH).map((stamp) => stamp + '[' + fs.readdirSync(path.join(REAL_TRASH, stamp)).join(',') + ']')
  : [];

function makeRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-restore-' + label + '-'));
  tmpRoots.push(root);
  fs.mkdirSync(path.join(root, 'tools', 'plugin-dist'), { recursive: true });
  for (const name of ['release-gate.cjs', 'zip-store.cjs']) {
    fs.copyFileSync(path.join(TOOLS, name), path.join(root, 'tools', 'plugin-dist', name));
  }
  return root;
}

function stagedDir(root) {
  return path.join(root, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins');
}

function writePlugin(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: path.basename(dir) }) + '\n');
  fs.writeFileSync(path.join(dir, 'main.js'), body);
}

function run(root, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', 'plugin-dist', 'release-gate.cjs'), ...args], {
    cwd: root, encoding: 'utf8'
  });
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}

// A tree hash over names and bytes: "directories came back" is not enough, the contents must too.
function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  (function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) { hash.update('D:' + prefix + entry.name + '\n'); walk(abs, prefix + entry.name + '/'); }
      else { hash.update('F:' + prefix + entry.name + ':' + fs.readFileSync(abs).toString('base64') + '\n'); }
    }
  })(dir, '');
  return hash.digest('hex');
}

function counts(out) {
  let hap = 0;
  for (const match of out.matchAll(/HAP .*: \d+ 个条目, (\d+) 处违规/gu)) { hap += Number(match[1]); }
  const staged = out.match(/资源目录里未获许可的插件: (\d+) 处/u);
  return { hap, staging: staged ? Number(staged[1]) : 0, total: hap + (staged ? Number(staged[1]) : 0) };
}

function batches(root) {
  const trash = path.join(root, '.fixtures-out', 'strip-trash');
  if (!fs.existsSync(trash)) { return []; }
  return fs.readdirSync(trash).map((stamp) => ({
    stamp, names: fs.readdirSync(path.join(trash, stamp)).sort()
  }));
}

function listFixtures(root) {
  const dir = stagedDir(root);
  if (!fs.existsSync(dir)) { return []; }
  return fs.readdirSync(dir).sort();
}

function writeHap(root, withFixtures) {
  const hapDir = path.join(root, 'entry', 'build', 'default', 'outputs', 'default');
  fs.mkdirSync(hapDir, { recursive: true });
  const { writeZip } = require(path.join(root, 'tools', 'plugin-dist', 'zip-store.cjs'));
  const entries = [{ name: 'resources/rawfile/plugins/' + SAMPLE + '/main.js', data: Buffer.from('// first-party sample\n') }];
  if (withFixtures) {
    for (const name of FIXTURES) {
      entries.push({ name: 'resources/rawfile/plugins/' + name + '/main.js', data: Buffer.from('// fixture ' + name + '\n') });
    }
  }
  fs.writeFileSync(path.join(hapDir, 'entry-default-unsigned.hap'), writeZip(entries));
  return hapDir;
}

function selfCheckLines(out) {
  return out.split('\n').filter((line) => line.includes('剥离自检:'));
}

function seededRoot(label) {
  const root = makeRoot(label);
  writePlugin(path.join(stagedDir(root), SAMPLE), '// first-party sample\n');
  for (const name of FIXTURES) { writePlugin(path.join(stagedDir(root), name), '// fixture ' + name + '\n'); }
  // A HAP that carries the fixtures, so the gate has an artifact to be red about as well.
  const hapDir = path.join(root, 'entry', 'build', 'default', 'outputs', 'default');
  fs.mkdirSync(hapDir, { recursive: true });
  const { writeZip } = require(path.join(root, 'tools', 'plugin-dist', 'zip-store.cjs'));
  fs.writeFileSync(path.join(hapDir, 'entry-default-unsigned.hap'), writeZip(FIXTURES.map((name) => ({
    name: 'resources/rawfile/plugins/' + name + '/main.js', data: Buffer.from('// fixture ' + name + '\n')
  })).concat([{ name: 'resources/rawfile/plugins/' + SAMPLE + '/main.js', data: Buffer.from('// first-party sample\n') }])));
  return root;
}

// --- 1/2/5: strip -> standalone restore -> same violations --------------------------------
let before;
let after;
{
  const root = seededRoot('cycle');
  const initial = run(root, []);
  assert.equal(initial.code, 1, 'seeded tree must start red');
  assert.equal(counts(initial.out).staging, FIXTURES.length, 'seed: every fixture is staged');
  const hashBefore = treeHash(stagedDir(root));
  before = counts(initial.out);

  const stripped = run(root, ['--strip-staging', '--apply']);
  assert.ok(!/未知参数/u.test(stripped.err), 'strip-staging must be a known flag');
  assert.equal(listFixtures(root).join(','), SAMPLE, 'strip alone must move every fixture out (no --strip needed)');
  assert.match(stripped.out, /搬出夹具: .*calendar/u, 'the strip must name what it moved');
  assert.equal(batches(root).length, FIXTURES.length, 'one batch directory per moved directory (millisecond stamps)');
  assert.deepEqual(batches(root).flatMap((batch) => batch.names).sort(), FIXTURES.slice().sort(),
    'the batches hold exactly the fixtures');
  assert.equal(fs.readFileSync(path.join(stagedDir(root), SAMPLE, 'main.js'), 'utf8'), '// first-party sample\n',
    'ALLOWED_SHIPPING plugin must survive a strip');

  const restored = run(root, ['--restore-staging', '--apply']);
  assert.equal(listFixtures(root).join(','), [SAMPLE, ...FIXTURES].sort().join(','),
    'restore alone must bring every fixture back (no --strip needed)');
  assert.equal(treeHash(stagedDir(root)), hashBefore, 'restored tree must be byte-identical');
  assert.match(restored.out, /已搬回夹具: .*calendar/u, 'the restore must name what it moved');
  assert.match(restored.out, /资源目录修复\(已执行\)/u, 'restore-only runs must report their own section');
  assert.ok(batches(root).every((batch) => batch.names.length === 0), 'restore leaves only the emptied batch directories');

  const final = run(root, []);
  after = counts(final.out);
  assert.equal(final.code, 1, 'fixtures back means the default scan is red again');
  assert.deepEqual(after, before, 'violation count after a restore must equal the count before the strip');
}

// --- 3: restore only fills gaps, never overwrites ------------------------------------------
{
  const root = makeRoot('nofill');
  writePlugin(path.join(stagedDir(root), 'calendar'), '// live, newer\n');
  writePlugin(path.join(root, '.fixtures-out', 'strip-trash', '2020-01-01T00-00-00-000Z', 'calendar'), '// stale\n');
  writePlugin(path.join(root, '.fixtures-out', 'strip-trash', '2020-01-01T00-00-00-000Z', 'editor-outliner'), '// stale\n');
  const hash = treeHash(path.join(stagedDir(root), 'calendar'));

  const result = run(root, ['--restore-staging', '--apply']);
  assert.equal(fs.readFileSync(path.join(stagedDir(root), 'calendar', 'main.js'), 'utf8'), '// live, newer\n',
    'a live directory must not be replaced by the stale copy');
  assert.equal(treeHash(path.join(stagedDir(root), 'calendar')), hash, 'the live directory must be untouched');
  assert.ok(fs.existsSync(path.join(stagedDir(root), 'editor-outliner')), 'the genuine gap is still filled');
  assert.match(result.out, /已搬回夹具: .*editor-outliner/u, 'the restore names only what it actually moved');
  assert.ok(!/已搬回夹具: .*calendar/u.test(result.out), 'the skipped directory must not be reported as moved');
}

// --- 4: a clean tree makes restore a no-op that still exits 0 ------------------------------
{
  const root = makeRoot('clean');
  writePlugin(path.join(stagedDir(root), SAMPLE), '// first-party sample\n');
  const hash = treeHash(stagedDir(root));

  const result = run(root, ['--restore-staging', '--apply']);
  assert.equal(result.code, 0, 'restore on a clean tree must exit 0');
  assert.equal(treeHash(stagedDir(root)), hash, 'restore on a clean tree must change nothing');
  assert.match(result.out, /搬回夹具: 无\(没有空缺\)/u, 'a no-op restore must say so instead of printing nothing');
  assert.equal(run(root, ['--restore-staging', '--apply']).code, 0, 'a second restore must stay at 0');
}

// --- 6a: a HAP with no fixtures is ok in --ci, and needs no stripped copy -----------------
{
  const root = makeRoot('ci-clean');
  writePlugin(path.join(stagedDir(root), SAMPLE), '// first-party sample\n');
  const hapDir = writeHap(root, false);

  const result = run(root, ['--ci']);
  const lines = selfCheckLines(result.out);
  assert.equal(lines.length, 1, 'a clean HAP yields exactly one self-check line');
  assert.match(lines[0], /✓ .*剥离自检: entry-default-unsigned\.hap/u, 'a clean HAP must pass its self-check');
  assert.match(lines[0], /无需剥离/u, 'the detail must say no strip was owed');
  assert.ok(!fs.readdirSync(hapDir).some((name) => name.endsWith('.stripped.hap')),
    'a clean HAP must not produce a stripped copy');
}

// --- 6b: a HAP with fixtures must recheck clean, and *.stripped.hap is not a candidate ------
{
  const root = makeRoot('ci-dirty');
  writePlugin(path.join(stagedDir(root), SAMPLE), '// first-party sample\n');
  const hapDir = writeHap(root, true);
  // A leftover tool product from an earlier --strip must not become a judged artifact.
  fs.writeFileSync(path.join(hapDir, 'zz-leftover.stripped.hap'), Buffer.from('not a zip'));

  const result = run(root, ['--ci']);
  const lines = selfCheckLines(result.out);
  assert.equal(lines.length, 1, 'the leftover *.stripped.hap must not add a self-check line');
  assert.match(lines[0], /✓ .*剥离 \d+ 个条目 → 剥后 \d+ 个条目 \/ 0 处违规/u,
    'a HAP with fixtures must pass once the stripped copy rechecks clean');
  assert.ok(!lines.some((line) => line.includes('stripped.hap')), 'no self-check may name the tool product');
}

// --- guard: the repository's own tree was never an input ----------------------------------
const realStagedNow = fs.existsSync(REAL_STAGED) ? fs.readdirSync(REAL_STAGED).sort() : [];
const realTrashNow = fs.existsSync(REAL_TRASH)
  ? fs.readdirSync(REAL_TRASH).map((stamp) => stamp + '[' + fs.readdirSync(path.join(REAL_TRASH, stamp)).join(',') + ']')
  : [];
assert.deepEqual(realStagedNow, realStagedBefore, 'the repo staging tree must be untouched by this test');
assert.deepEqual(realTrashNow, realTrashBefore, 'the repo trash must be untouched by this test');

for (const root of tmpRoots) { fs.rmSync(root, { recursive: true, force: true }); }
console.log('plugin-dist-restore: OK');
console.log('  剥离-还原循环: ' + before.total + ' 处违规 -> ' + after.total + ' 处违规 (HAP ' + after.hap + ' + 资源目录 ' + after.staging + ')');
console.log('  仓库 rawfile/plugins 未参与: ' + realStagedNow.join(', '));
