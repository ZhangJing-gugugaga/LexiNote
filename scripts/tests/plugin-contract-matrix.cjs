#!/usr/bin/env node
// M0 门禁 2/2：契约矩阵 vs 官方 d.ts 的一致性。
// 规则（docs/lexinote_plugin_bridge_spec.md 第 7 节）：
//   1. d.ts 里的每个符号都必须在 tools/contract/symbols.json 有条目，且矩阵里不能有多余符号；
//   2. status 只能是 implemented|partial|stub|unsupported，owner 只能是四个轨道之一，note 不能为空；
//   3. status=implemented|partial|stub 必须带可核对证据：note 里的 H:<宿主处理器> 必须存在于 registerHandler 表，
//      W:<Web 侧实现名> 必须存在于 shim 的实现索引；implemented 至少命中一个且全部存在，
//      partial/stub 既不能没有证据，也不能引用查不到的 H:/W:（防止 note 说假话骗过排期）。
//   4. apiVersion 只能来自宿主注入或 API_VERSION 常量：shim 里出现硬编码字面量即红灯（spec 第 11 节）。
//   5. 策略符号（NOTE_POLICY）的 note 必须带「[截至 YYYY-MM-DD @ commit7] + 覆盖插件:」时效头，
//      并给出 members:/members(excludes): 结构化清单；members 里的名字必须能在实现索引里查到（spec 第 12 节）。
//   6. note 里出现的「路径:行号（标识符）」必须真实存在，且该行确实包含该标识符；夹具路径写成
//      fixture:<夹具名>/<路径>:<行号>，每条红都附可直接照抄的替换行。夹具未就位默认计入跳过、但跳过度
//      永远显式打印（fixture citations skipped: N）；CI 的夹具 job 用 --fixtures-required 把跳过变成失败
//      （spec 第 12 节：note 不许与代码脱节；跳过可以是流程属性，不能是隐形属性）。
// 任一条不满足 → 退出码 1。矩阵本身用 node tools/contract/generate.cjs 或本脚本 --generate 重写。
const fs = require('node:fs');
const path = require('node:path');

const contract = path.join(__dirname, '../../tools/contract');
const { build, serialize, counts, gapCounts, OUT_FILE, SOURCE, STATUSES, OWNERS, GAPS_ENUM } = require(path.join(contract, 'generate.cjs'));

const LIMIT = 20; // 每类差异最多打印条数，超出只给总数，避免刷屏

if (process.argv.includes('--generate')) {
  const { matrix, dtsPath } = build();
  fs.writeFileSync(OUT_FILE, serialize(matrix), 'utf8');
  const c = counts(matrix.symbols);
  console.log('契约矩阵已写入 tools/contract/symbols.json');
  console.log('  来源 d.ts: ' + dtsPath + '（' + SOURCE + '）');
  console.log('  符号总数: ' + matrix.symbols.length + ' / implemented ' + c.implemented + ' / partial ' + c.partial + ' / stub ' + c.stub + ' / unsupported ' + c.unsupported);
  process.exit(0);
}

function fail(title, items) {
  console.log('\n✗ ' + title + '（' + items.length + ' 项）：');
  for (const item of items.slice(0, LIMIT)) {
    console.log('  - ' + (typeof item === 'string' ? item : item.text));
    if (typeof item !== 'string') for (const hint of item.hints || []) console.log('      ↳ ' + hint);
  }
  if (items.length > LIMIT) console.log('  … 还有 ' + (items.length - LIMIT) + ' 项');
}

if (!fs.existsSync(OUT_FILE)) {
  console.log('✗ 缺少 tools/contract/symbols.json；先跑 node tools/contract/generate.cjs');
  process.exit(1);
}

let matrix;
try {
  matrix = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
} catch (err) {
  console.log('✗ tools/contract/symbols.json 不是合法 JSON：' + err.message);
  process.exit(1);
}

const problems = [];
if (matrix.generatedFrom !== SOURCE) problems.push('generatedFrom 应为 ' + SOURCE + '，实为 ' + matrix.generatedFrom);
if (!Array.isArray(matrix.symbols)) {
  console.log('✗ symbols.json 缺少 symbols 数组');
  process.exit(1);
}
const symbols = matrix.symbols;

const official = build().matrix.symbols.map((s) => s.symbol);
const officialSet = new Set(official);
const listed = symbols.map((s) => (s && s.symbol) || '');
const listedSet = new Set(listed);

const missing = official.filter((s) => !listedSet.has(s));
const extra = listed.filter((s) => s && !officialSet.has(s));
const blank = symbols.filter((s) => !s || !s.symbol || !s.note || !String(s.note).trim()).map((s) => (s && s.symbol) || '(空条目)');
const badStatus = symbols.filter((s) => !STATUSES.includes(s.status)).map((s) => s.symbol + ' → ' + JSON.stringify(s.status));
const badOwner = symbols.filter((s) => !OWNERS.includes(s.owner)).map((s) => s.symbol + ' → ' + JSON.stringify(s.owner));
const badKind = symbols.filter((s) => !s.kind || !/^(abstract class|class|interface|function|const|let|var|enum|type)$/.test(s.kind)).map((s) => s.symbol + ' → ' + JSON.stringify(s.kind));

// gap：implemented 必须 null，其余必须落在三值枚举里（schema 见 spec 第 7 节）
const hasGap = (s) => Object.prototype.hasOwnProperty.call(s, 'gap');
const badGap = symbols.filter((s) => s && (!hasGap(s) || (s.gap !== null && !GAPS_ENUM.includes(s.gap)))).map((s) => (s && s.symbol) + ' → ' + JSON.stringify((s || {}).gap));
const gapOnImplemented = symbols.filter((s) => s && s.status === 'implemented' && s.gap !== null).map((s) => s.symbol + ' → ' + JSON.stringify(s.gap));
const gapMissing = symbols.filter((s) => s && s.status !== 'implemented' && (s.gap === null || s.gap === undefined)).map((s) => s.symbol);

const dupes = [];
const seen = new Set();
for (const s of listed) {
  if (!s) continue;
  if (seen.has(s)) dupes.push(s);
  seen.add(s);
}
const unsorted = [];
for (let i = 1; i < listed.length; i += 1) {
  if (listed[i - 1] > listed[i]) unsorted.push((listed[i - 1] || '(空条目)') + ' > ' + (listed[i] || '(空条目)'));
}

// implemented 必须有真实实现证据（spec 第 7 节第三条）
const index = (() => {
  const { collectImplIndex } = require(path.join(contract, 'generate.cjs'));
  return collectImplIndex();
})();
const unbacked = [];
for (const s of symbols) {
  if (!s || s.status !== 'implemented') continue;
  const hosts = (String(s.note || '').match(/H:([A-Za-z0-9_$.]+)/g) || []).map((t) => t.slice(2));
  const webs = (String(s.note || '').match(/W:([A-Za-z0-9_$.]+)/g) || []).map((t) => t.slice(2));
  const okHost = hosts.some((h) => index.handlers.has(h));
  const okWeb = webs.some((w) => index.web.has(w));
  if (!hosts.length && !webs.length) unbacked.push(s.symbol + ' → note 未给证据（H:<handler> 或 W:<shim 实现>）');
  else if (!okHost && !okWeb) {
    const detail = [];
    for (const h of hosts) if (!index.handlers.has(h)) detail.push('H:' + h + ' 不在宿主处理器表');
    for (const w of webs) if (!index.web.has(w)) detail.push('W:' + w + ' 不在 shim 实现索引');
    unbacked.push(s.symbol + ' → ' + detail.join('，'));
  }
}

// partial/stub 声称"部分可用"，note 必须给得出可核对证据，且引用的 H:/W: 都要真实存在
const MARKER = /([HW]):([A-Za-z0-9_$.]+)/g;
const markersOf = (note) => {
  const out = [];
  let m;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(String(note || '')))) out.push({ kind: m[1], name: m[2] });
  return out;
};
const resolves = (mk) => (mk.kind === 'H' ? index.handlers.has(mk.name) : index.web.has(mk.name) || index.channels.has(mk.name));
const noEvidence = [];
const danglingEvidence = [];
for (const s of symbols) {
  if (!s || (s.status !== 'partial' && s.status !== 'stub')) continue;
  const marks = markersOf(s.note);
  if (!marks.length) {
    noEvidence.push(s.symbol + ' → note 未给证据（H:<handler> 或 W:<shim 实现>）');
    continue;
  }
  const bad = marks.filter((mk) => !resolves(mk)).map((mk) => mk.kind + ':' + mk.name);
  if (bad.length) danglingEvidence.push(s.symbol + ' → ' + bad.join('，') + ' 查无实现');
}

// apiVersion 唯一合法来源：宿主注入的 API_VERSION 常量。shim 里出现第二处硬编码即红灯（spec 第 11 节）
const REPO_ROOT = path.join(contract, '../..');
const RAWFILE = process.env.LEXINOTE_RAWFILE || path.join(REPO_ROOT, 'entry/src/main/resources/rawfile'); // 自测钩子：可指向镜像目录验证规则可满足
const shimFiles = [];
(() => {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (/shim\.js$/i.test(entry.name)) shimFiles.push(p);
    }
  };
  if (fs.existsSync(RAWFILE)) visit(RAWFILE);
})();
const apiVersionSites = [];
const apiVersionBad = [];
for (const file of shimFiles) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const m = line.match(/apiVersion\s*:\s*([^,\n}]+)/);
    if (!m) return;
    const value = m[1].trim();
    apiVersionSites.push(rel + ':' + (i + 1) + ' → ' + value);
    if (!/^[A-Za-z_$][\w$]*$/.test(value) || !/API_VERSION$/.test(value)) {
      apiVersionBad.push(rel + ':' + (i + 1) + ' apiVersion: ' + value + '（只允许宿主注入的 API_VERSION 常量）');
    }
  });
}

// 策略符号的 note 必须是「时效头 + 覆盖插件清单 + members/members(excludes)」结构（spec 第 12 节）。
// 名单以 generate.cjs 的 NOTE_POLICY 为准，这里只做镜像；两边不一致本身即红灯，防止悄悄少校验一个符号。
const POLICY_SYMBOLS = ['moment', 'App', 'Workspace', 'Vault', 'MetadataCache', 'MarkdownView'];
const STAMP = /^\[截至 \d{4}-\d{2}-\d{2} @ [0-9a-f]{7}\]/;
const policyDrift = [];
const policyBadNote = [];
const memberDangling = [];
let memberCount = 0;
let excludeCount = 0;
(() => {
  const src = fs.readFileSync(path.join(contract, 'generate.cjs'), 'utf8');
  const decl = src.match(/const NOTE_POLICY = \[([^\]]*)\]/);
  if (!decl) {
    policyDrift.push('generate.cjs 里找不到 NOTE_POLICY 声明');
    return;
  }
  const listed = (decl[1].match(/'([^']+)'|"([^"]+)"/g) || []).map((t) => t.slice(1, -1));
  if (listed.join(',') !== POLICY_SYMBOLS.join(',')) {
    policyDrift.push('门禁镜像 [' + POLICY_SYMBOLS.join(', ') + '] ≠ NOTE_POLICY [' + listed.join(', ') + ']');
  }
})();
const byName = new Map();
for (const s of symbols) if (s && s.symbol) byName.set(s.symbol, s);
for (const name of POLICY_SYMBOLS) {
  const s = byName.get(name);
  if (!s) {
    policyDrift.push(name + ' 在矩阵里不存在，但仍在 NOTE_POLICY 里');
    continue;
  }
  const note = String(s.note || '');
  if (!STAMP.test(note)) policyBadNote.push(name + ' → note 未以 [截至 YYYY-MM-DD @ <commit7>] 开头（partial 是快照不是稳定契约）');
  if (!/覆盖插件[:：]/.test(note)) policyBadNote.push(name + ' → note 缺「覆盖插件:」清单');
  const membersLine = note.match(/^members:[ \t]*(.*)$/m);
  const excludesLine = note.match(/^members\(excludes\):[ \t]*(.*)$/m);
  if (!membersLine) policyBadNote.push(name + ' → note 缺 members: 行');
  if (!excludesLine) policyBadNote.push(name + ' → note 缺 members(excludes): 行（确实无排除项就写空并说明）');
  const pick = (line) => (line ? line[1].split(/[,，]/).map((t) => t.trim()).filter(Boolean) : []);
  const members = pick(membersLine);
  memberCount += members.length;
  excludeCount += pick(excludesLine).length;
  for (const m of members) {
    if (!index.handlers.has(m) && !index.web.has(m)) {
      memberDangling.push(name + ' → members 里的 ' + m + ' 在实现索引里查不到');
    }
  }
}

// note 里的「路径:行号（标识符）」必须真实存在，且该行确实含所标的标识符（spec 第 12 节：note 不许与代码脱节）。
// 每条红都附「可直接照抄的替换行」（在该文件里 grep 标识符的真实行号，最多 3 个候选），刷 note 是照抄不是排查。
// 夹具内的路径写成 fixture:<夹具名>/<相对路径>:<行号>；夹具是下载缓存、不入库，默认模式下未就位计入跳过。
// 跳过度永远显式打印（fixture citations skipped: N），CI 的夹具 job 用 --fixtures-required 把跳过变成失败。
const CITATIONS = /(?:(fixture:)([a-z0-9-]+)\/)?((?:[\w.@-]+\/)*[\w.@-]+\.(?:ets|ts|js|cjs|mjs|md|json)):(\d+)/g;
const TOKEN_TAIL = /^（`([^`]+)`）/;
const FIXTURES = process.env.LEXINOTE_FIXTURES || path.join(REPO_ROOT, '.fixtures-out/.cache');
const FIXTURES_REQUIRED = process.argv.includes('--fixtures-required');
const citeBad = [];
const citeSkipped = [];
let citeRepo = 0;
let citeFixture = 0;
const lineMemo = new Map();
const linesOf = (file) => {
  if (!lineMemo.has(file)) lineMemo.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : null);
  return lineMemo.get(file);
};
// 红一条就给一条可直接照抄的替换：在该文件里找标识符的真实行号（最多 3 个候选）
const hintFor = (fixtureName, relPath, token) => {
  const lines = linesOf(fixtureName ? path.join(FIXTURES, fixtureName, 'src', relPath) : path.join(REPO_ROOT, relPath));
  if (!lines) return ['该文件不存在，先确认 note 里的路径'];
  const isComment = (t) => /^\s*(\/\/|\/?\*|<!--)/.test(t);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(token)) hits.push({ n: i + 1, comment: isComment(lines[i]) });
  }
  if (!hits.length) return ['该文件里搜不到 ' + token + '：说法本身可能不成立，先确认实现是否存在'];
  // 只提"注释里提到该标识符"的行会把 note 指向一句注释，优先给真正的代码行
  const code = hits.filter((h) => !h.comment);
  const prefix = fixtureName ? 'fixture:' + fixtureName + '/' : '';
  return (code.length ? code : hits).slice(0, 3).map((h) => '改成 ' + prefix + relPath + ':' + h.n + '（`' + token + '`）');
};
for (const s of symbols) {
  if (!s || !s.symbol) continue;
  const note = String(s.note || '');
  CITATIONS.lastIndex = 0;
  let m;
  while ((m = CITATIONS.exec(note))) {
    const [whole, fixtureTag, fixtureName, relPath, lineText] = m;
    const label = (fixtureTag ? 'fixture:' + fixtureName + '/' : '') + relPath + ':' + lineText;
    const token = (note.slice(m.index + whole.length).match(TOKEN_TAIL) || [])[1];
    if (!token) {
      citeBad.push({
        text: s.symbol + ' → ' + label + ' 后面没写（标识符），无法核对',
        hints: ['在行号后面补全角括号包住的标识符，例如 ' + label + '（`SomeIdentifier`）'],
      });
      continue;
    }
    const file = fixtureTag ? path.join(FIXTURES, fixtureName, 'src', relPath) : path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(file)) {
      if (fixtureTag) citeSkipped.push({ symbol: s.symbol, label });
      else citeBad.push({ text: s.symbol + ' → ' + label + ' 文件不存在', hints: ['先确认仓库路径是否写错（区分大小写）'] });
      continue;
    }
    if (fixtureTag) citeFixture += 1;
    else citeRepo += 1;
    const line = linesOf(file)[Number(lineText) - 1];
    if (line === undefined) {
      citeBad.push({ text: s.symbol + ' → ' + label + ' 行号越界', hints: hintFor(fixtureTag && fixtureName, relPath, token) });
    } else if (!line.includes(token)) {
      citeBad.push({ text: s.symbol + ' → ' + label + ' 该行不含 ' + token + '（note 与代码脱节）', hints: hintFor(fixtureTag && fixtureName, relPath, token) });
    }
  }
}
const skippedBad = FIXTURES_REQUIRED
  ? citeSkipped.map((x) => x.symbol + ' → ' + x.label + '（夹具未就位；--fixtures-required 要求真校验）')
  : [];

const c = counts(symbols) || {};
const summary = [
  'implemented ' + (c.implemented || 0),
  'partial ' + (c.partial || 0),
  'stub ' + (c.stub || 0),
  'unsupported ' + (c.unsupported || 0),
].join(' / ');

console.log('契约矩阵对账：官方 d.ts ' + official.length + ' 个符号 / 矩阵 ' + symbols.length + ' 条');
console.log('状态分布：' + summary);
console.log('实现面索引：宿主处理器 ' + index.handlers.size + ' 条 / shim 实现 ' + index.web.size + ' 个');
const softCount = symbols.filter((s) => s && (s.status === 'partial' || s.status === 'stub')).length;
console.log('证据覆盖：partial/stub ' + softCount + ' 条，空证 ' + noEvidence.length + ' 条 / 悬空标记 ' + danglingEvidence.length + ' 条');
console.log('apiVersion 来源：' + apiVersionSites.length + ' 处（API_VERSION 常量 ' + (apiVersionSites.length - apiVersionBad.length) + ' 处 / 硬编码 ' + apiVersionBad.length + ' 处）');
console.log('行为证据引用：' + (citeRepo + citeFixture) + ' 处（仓库 ' + citeRepo + ' 处 / 夹具 ' + citeFixture + ' 处 / 夹具未就位跳过 ' + citeSkipped.length + ' 处）');
console.log('fixture citations skipped: ' + citeSkipped.length + ' (must be 0 in fixtures job)');
console.log('策略符号快照：' + POLICY_SYMBOLS.length + ' 条（members ' + memberCount + ' 项 / excludes ' + excludeCount + ' 项 / 时效头缺失 ' + policyBadNote.length + ' 处 / 清单脱节 ' + memberDangling.length + ' 处）');
const gc = gapCounts(symbols);
console.log('缺口分布：low-risk ' + gc['low-risk'] + ' / needs-architecture ' + gc['needs-architecture'] + ' / out-of-scope ' + gc['out-of-scope'] + '（implemented ' + gc.null + ' 条 gap=null）');

if (problems.length) fail('矩阵头信息不合法', problems);
if (missing.length) fail('d.ts 有、矩阵缺的符号（漏登记）', missing);
if (extra.length) fail('矩阵有、d.ts 已不存在的符号（需删）', extra);
if (dupes.length) fail('重复符号', dupes);
if (blank.length) fail('note 为空（spec 禁止空注条目，尤其是 stub）', blank);
if (badStatus.length) fail('status 非法', badStatus);
if (badOwner.length) fail('owner 非法', badOwner);
if (badKind.length) fail('kind 非法', badKind);
if (unsorted.length) fail('符号未按字典序（重跑生成器可修复）', unsorted);
if (badGap.length) fail('gap 取值非法或字段缺失（只允许 low-risk|needs-architecture|out-of-scope|null）', badGap);
if (gapOnImplemented.length) fail('status=implemented 的 gap 必须为 null', gapOnImplemented);
if (gapMissing.length) fail('status 非 implemented 但 gap 为 null（缺口性质必填，否则无法排期）', gapMissing);
if (unbacked.length) fail('status=implemented 但找不到实现证据', unbacked);
if (noEvidence.length) fail('status=partial|stub 的 note 必须带可核对实现证据（H:<handler> 或 W:<shim 实现>）', noEvidence);
if (danglingEvidence.length) fail('note 引用的证据在实现里查不到（note 与实现脱节）', danglingEvidence);
if (apiVersionBad.length) fail('apiVersion 被硬编码（只能来自宿主注入的 API_VERSION 常量，否则两个 Web 上下文会各报一个版本）', apiVersionBad);
if (policyDrift.length) fail('门禁策略符号表与 generate.cjs 的 NOTE_POLICY 不一致', policyDrift);
if (policyBadNote.length) fail('策略符号 note 不合规（必须以 [截至 YYYY-MM-DD @ commit7] 开头，并给出覆盖插件与 members/members(excludes) 清单）', policyBadNote);
if (memberDangling.length) fail('覆盖清单与实现脱节（members 里的名字在实现索引里查不到）', memberDangling);
if (citeBad.length) fail('note 里的「路径:行号（标识符）」核对不上（每条附可直接照抄的替换行）', citeBad);
if (skippedBad.length) fail('夹具未就位但有夹具侧引用；--fixtures-required 要求这些引用全部真校验过', skippedBad);

const failed = problems.length + missing.length + extra.length + dupes.length + blank.length +
  badStatus.length + badOwner.length + badKind.length + unsorted.length + unbacked.length +
  badGap.length + gapOnImplemented.length + gapMissing.length + noEvidence.length + danglingEvidence.length +
  apiVersionBad.length + policyDrift.length + policyBadNote.length + memberDangling.length + citeBad.length +
  skippedBad.length;

if (failed) {
  console.log('\n共 ' + failed + ' 处不一致；修完重跑 node tools/contract/generate.cjs 或本脚本 --generate。');
  process.exit(1);
}
console.log('\n✓ 契约矩阵一致：符号集合 100% 覆盖，gap 齐全且合法，实现证据齐全，格式稳定');
process.exit(0);
