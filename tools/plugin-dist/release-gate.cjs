#!/usr/bin/env node
// Release artifact gate: a shipping HAP (or a staging directory) must not carry the
// third-party plugin fixtures. They are build inputs for the offline gates, never product.
//
//   node tools/plugin-dist/release-gate.cjs                      # scan the built HAP + source staging
//   node tools/plugin-dist/release-gate.cjs --hap <file.hap> --dir <dir> --json <out>
//   node tools/plugin-dist/release-gate.cjs --strip              # dry run: what would be removed
//   node tools/plugin-dist/release-gate.cjs --strip --apply      # write x.stripped.hap next to the HAP
//   node tools/plugin-dist/release-gate.cjs --strip-staging --apply  # move every staged
//       rawfile/plugins/<dir> that is not in ALLOWED_SHIPPING into .fixtures-out/strip-trash/<ts>/
//       (reversible). Staging removal is opt-in on purpose: it breaks every fixture gate until
//       plugin-fixtures-stage runs again. --strip is not required; combining them still works.
//   node tools/plugin-dist/release-gate.cjs --restore-staging --apply  # the way back: fill only the
//       directories that are absent, so a half-run can never overwrite something newer. Also
//       standalone — asking for the fixtures back must not require asking for a strip pass.
//
//   node tools/plugin-dist/release-gate.cjs --ci               # the CI entry: stage 分类 -> 依赖夹具的门禁
//       -> release 产物剥离自检, 任一环节红即 exit 1, 每步都打印名字与结论
//
// Exit codes: 0 clean, 1 violations found (or left after a dry run), 2 bad usage.
// --strip --apply is judged by the artifact it writes, not by the source it read: the
// rewritten *.stripped.hap is re-scanned and drives the exit code (clean -> 0); the source
// package's violation count is printed as an information line only.
//
// CI ordering (why --ci exists): stripping destroys the inputs of other gates, so the
// fixture-dependent gates must run before it. --ci encodes exactly that order:
//   1. stage 分类        — 未登记（未 gitignore）的插件目录 = 准事故, 红
//   2. 依赖夹具的门禁    — channel-audit / contract-matrix / dist-audit --all / dist-regression / market-regression
//   3. release 产物剥离自检 — 在临时副本上 strip 后重扫, 必须 0 处违规
// A repo with no fixtures staged still passes step 1 (0 known / 0 unregistered); step 2 then
// fails loudly on the gates that need them, which is the honest signal to run
// plugin-fixtures-fetch + plugin-fixtures-stage first. See tools/plugin-dist/README.md.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readZip, writeZip } = require('./zip-store.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HAP_DIR = path.join(REPO_ROOT, 'entry', 'build', 'default', 'outputs', 'default');
const STAGED_ROOT = path.join(REPO_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins');
const TRASH_ROOT = path.join(REPO_ROOT, '.fixtures-out', 'strip-trash');

// First-party samples (rawfile/plugins/lexi-sample-plugin) are product; only the
// third-party fixtures and the local probe are forbidden.
const ALLOWED_SHIPPING = ['lexi-sample-plugin'];
const FORBIDDEN_MARKERS = ['.fixtures-out'];

function isAllowedShippingPlugin(name) {
  return ALLOWED_SHIPPING.indexOf(normalize(name)) >= 0;
}

function normalize(name) {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function forbiddenReason(name) {
  const normalized = normalize(name);
  const segments = normalized.split('/');
  for (const marker of FORBIDDEN_MARKERS) {
    if (segments.indexOf(marker) >= 0) { return '第三方夹具产物目录 ' + marker; }
  }
  for (let i = 0; i < segments.length - 1; i++) {
    // segments[i + 1] may be empty when the entry is the plugins directory itself (".../plugins/");
    // the directory node carries no plugin id, so only real child names are judged.
    if (segments[i] === 'plugins' && segments[i - 1] === 'rawfile' && segments[i + 1] && !isAllowedShippingPlugin(segments[i + 1])) {
      return 'rawfile/plugins/' + segments[i + 1] + ' 未在 ALLOWED_SHIPPING 内（允许随包发布: ' + ALLOWED_SHIPPING.join(', ') + '）';
    }
  }
  return '';
}

function scanHap(hapPath) {
  const entries = readZip(fs.readFileSync(hapPath));
  const hits = [];
  for (const entry of entries) {
    const reason = forbiddenReason(entry.name);
    if (reason) { hits.push({ source: 'hap', target: hapPath, entry: entry.name, bytes: entry.size, reason }); }
  }
  return { entries, hits };
}

function scanDir(dirPath) {
  const hits = [];
  const walk = (absolute, prefix) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        const reason = forbiddenReason(name + '/');
        if (reason) {
          hits.push({ source: 'dir', target: dirPath, entry: name + '/', bytes: 0, reason });
          continue;
        }
        walk(full, name);
      } else {
        const reason = forbiddenReason(name);
        if (reason) { hits.push({ source: 'dir', target: dirPath, entry: name, bytes: fs.statSync(full).size, reason }); }
      }
    }
  };
  walk(dirPath, '');
  return hits;
}

// Every staged directory that is not explicitly allowed to ship. Single source of truth for
// what counts as a fixture, so scanning, stripping and reporting cannot drift apart.
function forbiddenStagedDirs() {
  if (!fs.existsSync(STAGED_ROOT)) { return []; }
  return fs.readdirSync(STAGED_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !isAllowedShippingPlugin(entry.name))
    .map((entry) => path.join(STAGED_ROOT, entry.name))
    .sort();
}

function scanStagedSource() {
  return forbiddenStagedDirs().map((dir) => ({
    source: 'staging',
    target: dir,
    entry: 'rawfile/plugins/' + path.basename(dir) + '/',
    bytes: 0,
    reason: path.basename(dir) + ' 未在 ALLOWED_SHIPPING 内（允许随包发布: ' + ALLOWED_SHIPPING.join(', ') + '），下一次 build 会把它打进 HAP'
  }));
}

// A staged directory only counts as a "known fixture" when version control already ignores it.
// Anything else is an unregistered plugin directory: someone dropped a plugin into the shipping
// resource tree without even the ignore entry that keeps it out of git. Fail-closed when git is
// unavailable, because "I could not check" is not the same as "it is registered".
function isGitIgnored(absPath) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', absPath], { cwd: REPO_ROOT });
  if (result.error || result.status === null) { return false; }
  return result.status === 0;
}

function classifyStagedDirs() {
  const known = [];
  const unregistered = [];
  for (const dir of forbiddenStagedDirs()) {
    if (isGitIgnored(dir)) { known.push(dir); } else { unregistered.push(dir); }
  }
  return { known, unregistered };
}

// *.stripped.hap is written by --strip next to its source, so it is a tool product, not an
// artifact to be judged: leaving it in would make every later run self-check its own output.
function listHaps() {
  if (!fs.existsSync(HAP_DIR)) { return []; }
  return fs.readdirSync(HAP_DIR)
    .filter((name) => name.endsWith('.hap') && !name.endsWith('.stripped.hap'))
    .map((name) => path.join(HAP_DIR, name));
}

function stripHap(hapPath, apply) {
  const entries = readZip(fs.readFileSync(hapPath));
  const kept = entries.filter((entry) => forbiddenReason(entry.name) === '');
  const removed = entries.filter((entry) => forbiddenReason(entry.name) !== '');
  if (removed.length === 0) { return { path: hapPath, removed: [], wrote: '' }; }
  const outPath = hapPath.replace(/\.hap$/, '.stripped.hap');
  if (!apply) { return { path: hapPath, removed: removed.map((entry) => entry.name), wrote: '' }; }
  const bytes = writeZip(kept.map((entry) => ({ name: entry.name, data: entry.data })));
  fs.writeFileSync(outPath, bytes);
  // Re-read to prove the rewritten package is still a valid archive.
  const check = readZip(fs.readFileSync(outPath));
  const leftover = check.filter((entry) => forbiddenReason(entry.name) !== '').length;
  if (leftover !== 0 || check.length !== kept.length) { throw new Error('剥离后回读校验失败: ' + outPath); }
  return {
    path: hapPath,
    removed: removed.map((entry) => entry.name),
    wrote: outPath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function stripStagedSource(apply) {
  const removed = [];
  for (const dir of forbiddenStagedDirs()) {
    removed.push(dir);
    if (!apply) { continue; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(TRASH_ROOT, stamp, path.basename(dir));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
  }
  return removed;
}

// --strip-staging moves fixtures out of the resource tree; this is the way back. Restoring only
// fills directories that are absent, so a half-run can never overwrite something newer.
function restoreStagedSource(apply) {
  if (!fs.existsSync(TRASH_ROOT)) { return []; }
  const pending = [];
  for (const stamp of fs.readdirSync(TRASH_ROOT).sort()) {
    const batch = path.join(TRASH_ROOT, stamp);
    if (!fs.statSync(batch).isDirectory()) { continue; }
    for (const name of fs.readdirSync(batch)) {
      const dest = path.join(STAGED_ROOT, name);
      if (fs.existsSync(dest)) { continue; }
      pending.push({ from: path.join(batch, name), to: dest });
    }
  }
  if (apply) {
    for (const item of pending) {
      fs.mkdirSync(STAGED_ROOT, { recursive: true });
      fs.renameSync(item.from, item.to);
    }
  }
  return pending.map((item) => item.to);
}

// Regression gates transpile .ets with TypeScript and locate it through this variable.
const TYPESCRIPT_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  path.join(REPO_ROOT, 'node_modules', 'typescript'),
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript',
  'C:/Program Files/Huawei/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript'
];

function resolveTypescript() {
  for (const candidate of TYPESCRIPT_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) { return candidate; }
  }
  return '';
}

function ciMode() {
  const steps = [];
  const typescript = resolveTypescript();

  const staged = classifyStagedDirs();
  steps.push({
    name: 'stage 分类: 已 gitignore 的夹具 vs 未登记目录',
    ok: staged.unregistered.length === 0,
    detail: '已知夹具(已 gitignore) ' + staged.known.length + ' 处 / 未登记目录(未 ignore) ' + staged.unregistered.length + ' 处' +
      (staged.unregistered.length ? ' → ' + staged.unregistered.map((dir) => path.basename(dir)).join(', ') : '')
  });

  // 夹具 job 与默认 CI 的区别只在"跳过算不算失败":夹具已就位(stage 分类里的已知夹具非空)时要强校验,
  // 没装夹具的环境保留跳过。两种模式下契约门禁都会打印 fixture citations skipped: N,这里照样透传出来。
  const fixturesJob = staged.known.length > 0;
  const contractArgs = fixturesJob ? ['--fixtures-required'] : [];
  const gates = [
    ['channel-audit: 死通道必须 0', 'scripts/tests/plugin-channel-audit.cjs', []],
    ['contract-matrix: 契约矩阵一致' + (fixturesJob ? '(--fixtures-required)' : ''), 'scripts/tests/plugin-contract-matrix.cjs', contractArgs],
    ['dist-audit --all: 三件夹具 + 恶意样本', 'scripts/tests/plugin-dist-audit.cjs', ['--all']],
    ['dist-regression: 分发离线回归', 'scripts/tests/plugin-dist-regression.cjs', []],
    ['identity-delivery: 令牌下发点', 'scripts/tests/plugin-identity-delivery.cjs', []],
    ['bridge-security: T0.1 身份面(RFC)', 'scripts/tests/plugin-bridge-security.cjs', []],
    ['context-isolation: T0.2 沙箱面(RFC)', 'scripts/tests/plugin-context-isolation.cjs', []],
    ['authz-matrix: T0.3 授权矩阵(RFC)', 'scripts/tests/plugin-authz-matrix.cjs', []],
    ['lifecycle-once: T1.1 生命周期(RFC)', 'scripts/tests/plugin-lifecycle-once.cjs', []],
    ['extension-ownership: T1.2 扩展注册(RFC)', 'scripts/tests/plugin-extension-ownership.cjs', []],
    ['contract-tripod: T1.3 契约三方(RFC)', 'scripts/tests/plugin-contract-tripod.cjs', []],
    ['manifest-v2: T2.1 清单契约(RFC)', 'scripts/tests/plugin-manifest-v2.cjs', []],
    ['permission-store: T2.2 权限存储(RFC)', 'scripts/tests/plugin-permission-store.cjs', []],
    ['vault-revision: T2.3 乐观锁(RFC)', 'scripts/tests/plugin-vault-revision.cjs', []],
    ['workspace-api: T2.4 视图会话(RFC)', 'scripts/tests/plugin-workspace-api.cjs', []],
    ['market-regression: v1 索引解析', 'scripts/tests/plugin-market-regression.cjs', []]
  ];
  const env = Object.assign({}, process.env);
  if (typescript) { env.LEXI_TYPESCRIPT = typescript; }
  const citations = [];
  for (const [name, script, extra] of gates) {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, script)].concat(extra), { cwd: REPO_ROOT, env, encoding: 'utf8' });
    const output = ((result.stdout || '') + (result.stderr || '')).trim();
    const tail = output ? output.split('\n').pop().trim() : '';
    // 跳过可以是流程属性,但不能是隐形属性:契约门禁固定那行必须原样出现在 CI 输出里。
    const cite = output.split('\n').map((line) => line.trim()).find((line) => line.indexOf('fixture citations skipped:') === 0);
    if (cite) { citations.push(cite); }
    steps.push({ name, ok: result.status === 0, detail: 'exit=' + result.status + (tail ? ' | ' + tail : '') });
  }

  const haps = listHaps();
  if (haps.length === 0) {
    steps.push({ name: 'release 产物剥离自检', ok: false, detail: '没找到 HAP: ' + HAP_DIR + '（先跑 hvigorw assembleHap）' });
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-ci-'));
    for (const hap of haps) {
      const copy = path.join(tmpDir, path.basename(hap));
      fs.copyFileSync(hap, copy);
      const source = scanHap(hap);
      const job = stripHap(copy, true);
      const recheck = job.wrote ? scanHap(job.wrote) : null;
      // Only a HAP that still carries fixtures owes us a stripped copy. A HAP with nothing to
      // remove is already the artifact we would ship — demanding a non-empty removal would make
      // this step pass in one order of the release sequence only. Same rule as report.strippedClean.
      let ok;
      let detail;
      if (source.hits.length === 0) {
        ok = true;
        detail = '源包 ' + source.entries.length + ' 个条目 / 0 处违规（无需剥离，未产出副本）';
      } else {
        ok = !!(recheck && recheck.entries.length > 0 && recheck.hits.length === 0);
        detail = '剥离 ' + job.removed.length + ' 个条目 → 剥后 ' +
          (recheck ? recheck.entries.length + ' 个条目 / ' + recheck.hits.length + ' 处违规' : '未产出剥离副本');
      }
      steps.push({ name: '剥离自检: ' + path.basename(hap), ok, detail });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('CI 顺序检查:');
  steps.forEach((step, index) => {
    console.log('  ' + (step.ok ? '✓' : '✗') + ' ' + (index + 1) + '. ' + step.name + ' — ' + step.detail);
  });
  for (const cite of citations) { console.log('  夹具引用: ' + cite); }
  const failed = steps.filter((step) => !step.ok);
  console.log('  结论: ' + (failed.length === 0
    ? 'ok  (' + steps.length + '/' + steps.length + ' 步通过)'
    : 'red  (' + failed.length + ' 步失败: ' + failed.map((step) => step.name).join('; ') + ')'));
  if (!typescript) {
    console.log('  提示: 没找到 TypeScript，dist-regression / market-regression 会去 require 各自默认路径；设 LEXI_TYPESCRIPT 可消除这条提示。');
  }
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  let hapPaths = [];
  let dirPaths = [];
  let jsonPath = '';
  let strip = false;
  let apply = false;
  let stripStaging = false;
  let restoreStaging = false;
  let ci = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hap') { hapPaths.push(path.resolve(argv[i + 1] || '')); i++; }
    else if (arg === '--dir') { dirPaths.push(path.resolve(argv[i + 1] || '')); i++; }
    else if (arg === '--json') { jsonPath = path.resolve(argv[i + 1] || ''); i++; }
    else if (arg === '--strip') { strip = true; }
    else if (arg === '--strip-staging') { stripStaging = true; }
    else if (arg === '--restore-staging') { restoreStaging = true; }
    else if (arg === '--apply') { apply = true; }
    else if (arg === '--ci') { ci = true; }
    else { console.error('未知参数: ' + arg); return 2; }
  }
  if (ci) { return ciMode(); }
  const explicitTargets = hapPaths.length + dirPaths.length > 0;
  if (!explicitTargets) { hapPaths = listHaps(); }

  // Staging repair passes stand alone. --strip-staging and --restore-staging are the only two
  // ways to move fixture directories, so neither may hide behind --strip: a caller who wants the
  // fixtures back must not have to ask for a strip pass it does not want. Both run before the
  // scan, so the verdict below describes the tree as it stands when this process exits.
  const stagingJobs = { stripped: [], restored: [] };
  if (stripStaging) { stagingJobs.stripped = stripStagedSource(apply); }
  if (restoreStaging) { stagingJobs.restored = restoreStagedSource(apply); }

  const report = { generatedAt: new Date().toISOString(), haps: [], dirs: [], staging: [], strip: null, verdict: 'clean' };
  let violations = 0;
  for (const hapPath of hapPaths) {
    if (!fs.existsSync(hapPath)) { report.haps.push({ path: hapPath, error: '不存在' }); continue; }
    const scanned = scanHap(hapPath);
    violations += scanned.hits.length;
    report.haps.push({ path: hapPath, entries: scanned.entries.length, hits: scanned.hits });
  }
  for (const dirPath of dirPaths) {
    if (!fs.existsSync(dirPath)) { report.dirs.push({ path: dirPath, error: '不存在' }); continue; }
    const hits = scanDir(dirPath);
    violations += hits.length;
    report.dirs.push({ path: dirPath, hits });
  }
  // The staging check is a repo-state opinion; with an explicit --hap/--dir the caller
  // asked about that artifact only, so it stays out of the verdict.
  report.staging = explicitTargets ? [] : scanStagedSource();
  report.stagingChecked = !explicitTargets;
  const staged = explicitTargets ? { known: [], unregistered: [] } : classifyStagedDirs();
  report.stagingKnown = staged.known.map((dir) => 'rawfile/plugins/' + path.basename(dir) + '/');
  report.stagingUnregistered = staged.unregistered.map((dir) => 'rawfile/plugins/' + path.basename(dir) + '/');
  violations += report.staging.length;

  if (strip) {
    const jobs = { haps: [], staging: [] };
    for (const hapPath of hapPaths) {
      if (!fs.existsSync(hapPath)) { continue; }
      const job = stripHap(hapPath, apply);
      if (job.wrote) {
        // The verdict belongs to the artifact we would ship, so read the stripped copy back
        // instead of trusting the writer's own self-check.
        const recheck = scanHap(job.wrote);
        job.recheck = { entries: recheck.entries.length, violations: recheck.hits.length };
      }
      jobs.haps.push(job);
    }
    jobs.staging = stagingJobs.stripped;
    jobs.restored = stagingJobs.restored;
    report.strip = { apply, ...jobs };
  }
  report.strippedClean = !!(report.strip && apply) && report.strip.haps.length > 0
    && report.strip.haps.every((job) => (job.removed.length === 0 && !job.wrote)
      || (job.recheck && job.recheck.violations === 0))
    && report.strip.staging.every((dir) => !fs.existsSync(dir));

  report.violations = violations;
  report.verdict = (violations === 0 || report.strippedClean) ? 'clean' : 'violations';

  const lines = ['发布产物夹具防线:'];
  for (const hap of report.haps) {
    if (hap.error) { lines.push('  HAP ' + hap.path + ': ' + hap.error); continue; }
    lines.push('  HAP ' + path.basename(hap.path) + ': ' + hap.entries + ' 个条目, ' + hap.hits.length + ' 处违规');
    for (const hit of hap.hits) { lines.push('    - ' + hit.entry + '  (' + hit.reason + ')'); }
  }
  for (const dir of report.dirs) {
    if (dir.error) { lines.push('  目录 ' + dir.path + ': ' + dir.error); continue; }
    lines.push('  目录 ' + dir.path + ': ' + dir.hits.length + ' 处违规');
    for (const hit of dir.hits) { lines.push('    - ' + hit.entry + '  (' + hit.reason + ')'); }
  }
  lines.push('  允许随包发布的插件(ALLOWED_SHIPPING): ' + ALLOWED_SHIPPING.join(', '));
  if (report.stagingChecked) {
    lines.push('  资源目录里未获许可的插件: ' + report.staging.length + ' 处');
    for (const hit of report.staging) { lines.push('    - ' + hit.entry); }
    lines.push('  已知夹具(已 gitignore): ' + report.stagingKnown.length + ' 处');
    lines.push('  未登记目录(未 ignore): ' + report.stagingUnregistered.length + ' 处');
    if (report.stagingUnregistered.length) {
      lines.push('  ! 准事故: 下列插件目录既不在 ALLOWED_SHIPPING 内，也没有进 .gitignore —— 下一次 build 会把它打进 release，且 git 里看不到:');
      for (const entry of report.stagingUnregistered) { lines.push('    ! ' + entry); }
    }
  } else {
    lines.push('  资源目录里未获许可的插件: 未检查(指定了 --hap/--dir)');
  }
  if (report.strip) {
    const mode = report.strip.apply ? '已执行' : '预演';
    lines.push('  剥离(' + mode + '):');
    for (const job of report.strip.haps) {
      lines.push('    - ' + path.basename(job.path) + ' 移除 ' + job.removed.length + ' 个条目' + (job.wrote ? ' → ' + path.basename(job.wrote) + ' sha256=' + job.sha256.slice(0, 16) + '…' : ''));
      if (job.recheck) { lines.push('      复检 ' + path.basename(job.wrote) + ': ' + job.recheck.entries + ' 个条目, ' + job.recheck.violations + ' 处违规'); }
    }
    lines.push('    - 资源目录: ' + (report.strip.staging.length ? report.strip.staging.join(', ') : '无'));
    if (report.strip.restored.length) { lines.push('    - 已搬回夹具: ' + report.strip.restored.join(', ')); }
  } else if (stripStaging || restoreStaging) {
    lines.push('  资源目录修复(' + (apply ? '已执行' : '预演') + '):');
    if (stripStaging) { lines.push('    - 搬出夹具: ' + (stagingJobs.stripped.join(', ') || '无')); }
    if (restoreStaging) {
      lines.push('    - ' + (apply ? '已搬回夹具: ' : '待搬回夹具: ') + (stagingJobs.restored.join(', ') || '无(没有空缺)'));
    }
  }
  if (report.strippedClean) {
    lines.push('  结论: clean(以剥离产物为准；源包 ' + violations + ' 处违规为信息行，不参与退出码)');
  } else {
    lines.push('  结论: ' + report.verdict + (violations ? '  (' + violations + ' 处违规——release 不得发布)' : ''));
  }
  console.log(lines.join('\n'));

  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    console.log('  JSON 报告: ' + jsonPath);
  }
  if (strip && !apply) { return report.strip.haps.some((job) => job.removed.length > 0) || report.strip.staging.length > 0 ? 1 : 0; }
  if (strip && apply) { return report.strippedClean ? 0 : 1; }
  return violations === 0 ? 0 : 1;
}

if (require.main === module) { process.exitCode = main(process.argv.slice(2)); }

module.exports = {
  forbiddenReason, scanHap, scanDir, scanStagedSource, forbiddenStagedDirs,
  classifyStagedDirs, isGitIgnored, isAllowedShippingPlugin, ALLOWED_SHIPPING
};
