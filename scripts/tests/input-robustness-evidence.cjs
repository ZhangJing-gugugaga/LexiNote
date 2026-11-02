#!/usr/bin/env node
/**
 * 编辑器输入健壮性证据脚本（插件工作区 / ArkWeb + CodeMirror 6）
 *
 * 边界（写在脚本里，避免误读）：
 * - 只读产品代码；只写 evidence 目录。
 * - 本脚本注入的是「已提交文本」（uitest uiInput text 走 IME 提交路径），
 *   不产生、也无法断言拼音组合态 / 候选栏 / 真实 IME 时序。
 *
 * 用法：
 *   node scripts/tests/input-robustness-evidence.cjs --run         # 跑设备序列，落证据
 *   node scripts/tests/input-robustness-evidence.cjs               # 复判 A1–A6（只用既有产物）
 *   node scripts/tests/input-robustness-evidence.cjs --dir <dir>   # 指定证据目录
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HDC = process.env.LEXINOTE_HDC || 'E:\\dev-tools\\harmonyos\\command-line-tools\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const DEVICE = '127.0.0.1:15555';
const BUNDLE = 'com.lovexjy.lexinote';
const ROOT = path.resolve(__dirname, '..', '..');

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DIR = path.resolve(argOf('--dir', path.join(ROOT, '.fixtures-out', 'evidence', '20261102-1330-input-robustness')));
const HILOG = path.join(DIR, 'hilog.log');
const RECORD = path.join(DIR, 'run-record.json');
const STEPS = path.join(DIR, 'run-steps.jsonl');
const RUN = process.argv.includes('--run');

// 注入文本：纯汉字 + 全角标点，不含拉丁字母（拉丁字母会触发拼音组合，见报告「没有证明的东西」）
const T2 = '插件工作区的输入通道需要被完整验证一次因为拼音输入法的组合态无法用自动化复现所以这一轮只证明已提交文本注入与长文档编辑会不会在容器里丢字错位甚至崩溃这段文字全部使用汉字与全角标点避免触发拼音组合路径随后用内容长度与末尾字符做交叉核对只要长度与末尾都吻合就说明注入通道没有丢字符。';
const LINES3 = [
  '第一行用来验证长行输入在容器里是否逐字到达不发生截断与错位这里再补齐一些字符凑够三十个以上',
  '第二行继续灌入较长的一行中文内容检查换行之后光标位置与文本顺序是否仍然保持正确并补齐字数',
  '第三行同样保持三十个字符以上让连续五行输入覆盖编辑器的多次事务避免只测到单次插入的偶然情况',
  '第四行用来观察长文本累积之后文档长度读数是否线性增长以及末尾字符是否与最后一次注入保持一致',
  '第五行收尾再写一段中等长度的中文确保五行合计长度远超一百五十个字符并留待日志交叉核对结论',
];
const T4 = '重新挂载容器之后再注入一段中文用来确认输入通道没有被上一次路径事件弄坏。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const len = (s) => Array.from(s).length;

function sh(args, timeout) {
  const res = spawnSync(HDC, ['-t', DEVICE].concat(args), { encoding: 'utf8', timeout: timeout || 120000 });
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  return { out, code: res.status, timedOut: res.error && res.error.code === 'ETIMEDOUT' };
}
const shell = (cmd, timeout) => sh(['shell', cmd], timeout).out;

const steps = [];
let phase = 'boot';
function record(cmd, out) {
  steps.push({ phase, cmd, out: String(out).split('\n')[0].slice(0, 200) });
}
function dev(cmd) {
  const r = sh(['shell', cmd]);
  record('hdc shell ' + cmd, r.out);
  return r.out;
}

function walk(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.attributes) out.push(node.attributes);
  for (const c of node.children || []) walk(c, out);
  return out;
}
function nodes(tag) {
  const remote = '/data/local/tmp/' + tag + '.json';
  const local = path.join(DIR, 'layout-' + tag + '.json');
  dev('uitest dumpLayout -p ' + remote);
  const r = sh(['file', 'recv', remote, local]);
  record('hdc file recv ' + remote + ' ' + local, r.out);
  return walk(JSON.parse(fs.readFileSync(local, 'utf8')), []);
}
function box(b) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(b || '');
  if (!m) return null;
  const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}
function click(x, y) { return dev('uitest uiInput click ' + x + ' ' + y); }
function key(code) { return dev('uitest uiInput keyEvent ' + code); }
function inject(text) { return dev('uitest uiInput text ' + JSON.stringify(text)); }

function hilogLines() { return fs.readFileSync(HILOG, 'utf8').split(/\r?\n/); }
function mark() { return hilogLines().length; }

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const r = probe();
    if (r) return r;
    await sleep(600);
  }
  throw new Error('等待超时: ' + label);
}

const CHG = /\[editor\.change\] (\{"length":\d+.*)$/;

// ---------------- run 模式：设备序列 ----------------
async function run() {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(STEPS)) fs.rmSync(STEPS);

  phase = 'A1';
  dev('aa force-stop ' + BUNDLE);
  dev('aa start -a EntryAbility -b ' + BUNDLE);
  await sleep(3500);
  let n = nodes('a1-boot');
  const dock = n.find((a) => a.id === 'workspace-action-dock-profile') || n.find((a) => a.text === '设置');
  if (!dock) throw new Error('A1 停在: 找不到主界面 dock(id=workspace-action-dock-profile / text=设置)');
  let b = box(dock.bounds);
  click(b.cx, b.cy);
  await sleep(1600);
  n = nodes('a1-settings');
  let entry = n.find((a) => a.id === 'plugin-workspace-entry');
  if (!entry) {
    const tab = n.find((a) => a.text === '插件' && a.type === 'Text');
    if (!tab) throw new Error('A1 停在: 设置页既无 plugin-workspace-entry 也无「插件」入口');
    b = box(tab.bounds);
    click(b.cx, b.cy);
    await sleep(1400);
    n = nodes('a1-plugins');
    entry = n.find((a) => a.id === 'plugin-workspace-entry');
  }
  if (!entry) throw new Error('A1 停在: 插件页没有 id=plugin-workspace-entry');
  const a1Start = mark();
  b = box(entry.bounds);
  click(b.cx, b.cy);
  await waitFor('容器 editor.change', () => hilogLines().slice(a1Start).some((l) => CHG.test(l)), 25000);
  await sleep(1500);
  n = nodes('a1-container');
  const a1End = mark();

  const editorOf = (list) => list.find((a) => a.type === 'textField' && /LexiNote 插件工作区/.test(String(a.text || '')));
  let ed = editorOf(n);
  if (!ed) throw new Error('A1 停在: 容器页 dump 里没有 CM6 编辑器 textField 节点');

  phase = 'A2';
  const a2Start = mark();
  const eb = box(ed.bounds);
  click(eb.x1 + 700, eb.y1 + Math.round((eb.y2 - eb.y1) * 0.75)); // 点正文下方 → 光标落到文档末尾
  await sleep(500);
  inject(T2);
  await sleep(1600);
  const a2End = mark();
  n = nodes('a2-after-inject');

  phase = 'A3';
  const a3Start = mark();
  for (let i = 0; i < LINES3.length; i += 1) {
    inject(LINES3[i]);
    await sleep(900);
    if (i < LINES3.length - 1) { key(2054); await sleep(700); } // KEYCODE_ENTER
  }
  await sleep(1500);
  const a3End = mark();
  n = nodes('a3-after-lines');

  phase = 'A4';
  const a4Start = mark();
  const paletteBtn = n.find((a) => a.text === '命令面板');
  if (paletteBtn) { b = box(paletteBtn.bounds); click(b.cx, b.cy); await sleep(1200); }
  const a4Palette = nodes('a4-palette');
  // 替代观察：重挂载容器后再次注入（容器内没有切换笔记的入口，见报告）
  let tries = 0;
  let again = null;
  while (tries < 3 && !again) {
    dev('uitest uiInput keyEvent Back');
    await sleep(1500);
    const back = nodes('a4-back-' + tries);
    again = back.find((a) => a.id === 'plugin-workspace-entry');
    tries += 1;
  }
  if (again) {
    b = box(again.bounds);
    click(b.cx, b.cy);
    await waitFor('重挂载 editor.change', () => hilogLines().slice(a4Start).some((l) => CHG.test(l)), 25000);
    await sleep(1200);
    const remount = nodes('a4-remount');
    ed = editorOf(remount);
    if (ed) {
      const rb = box(ed.bounds);
      click(rb.x1 + 700, rb.y1 + Math.round((rb.y2 - rb.y1) * 0.75));
      await sleep(400);
    }
    inject(T4);
    await sleep(1500);
  }
  const a4End = mark();
  nodes('a4-final');

  const record = {
    hdc: HDC, device: DEVICE, bundle: BUNDLE, hilog: HILOG,
    texts: { T2, LINES3, T4 },
    windows: {
      A1: { start: a1Start, end: a1End },
      A2: { start: a2Start, end: a2End },
      A3: { start: a3Start, end: a3End },
      A4: { start: a4Start, end: a4End },
    },
    layouts: fs.readdirSync(DIR).filter((f) => /^layout-/.test(f)),
    steps,
  };
  fs.writeFileSync(RECORD, JSON.stringify(record, null, 2));
  fs.writeFileSync(STEPS, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log('run 完成: ' + RECORD + '  steps=' + steps.length);
}

// ---------------- judge 模式：只读既有产物复判 ----------------
function changesIn(lines) {
  const out = [];
  for (const l of lines) {
    const m = CHG.exec(l);
    if (m) { try { out.push(JSON.parse(m[1])); } catch (_) { /* 半行忽略 */ } }
  }
  return out;
}
function baselineBefore(lines, idx) {
  const found = changesIn(lines.slice(0, idx));
  return found.length ? found[found.length - 1].length : null;
}
const tailOf = (s, n) => Array.from(s).slice(-n).join('');

// dumpLayout 里编辑器正文是可读的（type=textField 节点 attributes.text）。
// 注意：它的长度比 hilog 的 length 少 2（尾部换行/末尾处理），只能用来验「内容包含」，不能验长度。
function dumpEditorText(file) {
  const abs = path.join(DIR, file);
  if (!fs.existsSync(abs)) return null;
  const walk2 = (n, acc) => {
    if (!n || typeof n !== 'object') return acc;
    // dumpLayout 的节点不带 type 字段，只能按「最长 attributes.text」取编辑器正文
    if (n.attributes && typeof n.attributes.text === 'string') acc.push(n.attributes.text);
    for (const c of n.children || []) walk2(c, acc);
    return acc;
  };
  const all = walk2(JSON.parse(fs.readFileSync(abs, 'utf8')), []);
  if (!all.length) return null;
  return all.sort((x, y) => y.length - x.length)[0];
}
function containInfo(dumpFile, text) {
  const got = dumpEditorText(dumpFile);
  if (got === null) return { ok: false, note: dumpFile + ' 不存在或无 textField 文本' };
  const head = Array.from(text).slice(0, 20).join('');
  const tail = tailOf(text, 20);
  return { ok: got.indexOf(head) >= 0 && got.indexOf(tail) >= 0, note: dumpFile + ' 文本长度=' + Array.from(got).length + ' 含首20字=' + (got.indexOf(head) >= 0) + ' 含尾20字=' + (got.indexOf(tail) >= 0) };
}

// 注入没落地时的旁证：Chromium 走剪贴板粘贴回退且读剪贴板失败 / 设备 IME 进程缺席。
// 这两类行是判 A2/A3 失败原因的证据，不属于 A5 的 crash 口径。
const PASTE = /pasteboard_client_adapter/;
const IME_DEAD = /inputmethod.*(?:exit with code|OnProcessDied)/i;
function diag(lines) {
  const p = lines.filter((l) => PASTE.test(l)).length;
  const i = lines.filter((l) => IME_DEAD.test(l)).length;
  return '; 旁证: pasteboard 读剪贴板失败 ' + p + ' 行, IME 进程死亡 ' + i + ' 行';
}

function judge() {
  const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  const logFile = [record.hilog, HILOG, path.join(DIR, 'hilog-run1.log')].filter((f) => f && fs.existsSync(f))[0];
  if (!logFile) { throw new Error('找不到 hilog 证据文件（record.hilog / hilog.log / hilog-run1.log 都不存在）'); }
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  const win = (k) => { const w = record.windows[k]; return lines.slice(w.start, w.end); };
  const verdicts = [];
  const push = (id, ok, detail) => verdicts.push({ id, ok, detail });

  // A1
  const a1 = win('A1');
  const a1Need = ['[page.appear]', '[channel.port.attached]', '[web.page.end]'];
  const a1Hit = a1Need.map((t) => a1.find((l) => l.indexOf(t) >= 0));
  const layout = path.join(DIR, 'layout-a1-container.json');
  const domText = fs.existsSync(layout) ? fs.readFileSync(layout, 'utf8') : '';
  const isContainer = /lexinote_workspace\.html/.test(domText) && /通道已建立/.test(domText);
  push('A1', a1Hit.every(Boolean) && isContainer,
    a1Hit.map((l, i) => (l ? 'hilog: ' + l.trim().slice(0, 150) : '缺失 ' + a1Need[i])).join(' | ') +
    ' | layout-a1-container.json: Web url 含 lexinote_workspace.html=' + /lexinote_workspace\.html/.test(domText) + ', 文本含「通道已建立」=' + /通道已建立/.test(domText));

  // A2
  const { T2 } = record.texts;
  const a2changes = changesIn(win('A2'));
  const b2 = baselineBefore(lines, record.windows.A2.start);
  const last2 = a2changes.length ? a2changes[a2changes.length - 1] : null;
  const expect2 = b2 + len(T2);
  const okLen2 = last2 && last2.length === expect2;
  const okTail2 = last2 && last2.tail === tailOf('\n' + T2, 24) || (last2 && String(last2.tail).endsWith(tailOf(T2, 20)));
  const c2 = containInfo('layout-a2-after-inject.json', T2);
  push('A2', !!(okLen2 && c2.ok && len(T2) >= 120),
    '注入 ' + len(T2) + ' 字符; baseline=' + b2 + '; 期望 length=' + expect2 + '; 实际=' + (last2 ? last2.length : '无 editor.change') +
    '; tail 实际=' + JSON.stringify(last2 ? last2.tail : null) + '; 期望尾部含=' + JSON.stringify(tailOf(T2, 20)) +
    '; 内容核对: ' + c2.note + diag(win('A2')));

  // A3
  const { LINES3 } = record.texts;
  const a3changes = changesIn(win('A3'));
  const b3 = baselineBefore(lines, record.windows.A3.start);
  const last3 = a3changes.length ? a3changes[a3changes.length - 1] : null;
  const expect3 = b3 + LINES3.reduce((s, x) => s + len(x), 0) + (LINES3.length - 1);
  const okLen3 = last3 && last3.length === expect3;
  const okTail3 = last3 && String(last3.tail).endsWith(tailOf(LINES3[LINES3.length - 1], 20));
  const c3 = containInfo('layout-a3-after-lines.json', LINES3.join('\n'));
  push('A3', !!(okLen3 && c3.ok && LINES3.every((x) => len(x) >= 30)),
    '五行长度=' + LINES3.map(len).join('/') + '; baseline=' + b3 + '; 期望 length=' + expect3 + '; 实际=' + (last3 ? last3.length : '无 editor.change') +
    '; tail 实际=' + JSON.stringify(last3 ? last3.tail : null) + '; 内容核对: ' + c3.note + diag(win('A3')));

  // A4
  const a4 = win('A4');
  const pathEvents = a4.filter((l) => /\[reading\.sourcePath\]/.test(l));
  const fileOpen = a4.filter((l) => /file-open/.test(l));
  const a4changes = changesIn(a4);
  const okSwitch = pathEvents.length > 0 || fileOpen.length > 0;
  const b4 = baselineBefore(lines, record.windows.A4.start);
  const last4 = a4changes.length ? a4changes[a4changes.length - 1] : null;
  const okInject4 = last4 && last4.length > b4 && String(last4.tail).endsWith(tailOf(record.texts.T4, 16));
  push('A4', !!(okSwitch && okInject4),
    '切笔记事件 reading.sourcePath/file-open 行数=' + pathEvents.length + '/' + fileOpen.length +
    '（唯一触发点 WorkspaceBridge.ets:285 ← LexiPluginRuntime.ets:1074 workspace.openLinkText）; 重挂载后注入 ' + len(record.texts.T4) +
    ' 字符: baseline=' + b4 + '; 实际=' + (last4 ? last4.length : '无 editor.change') + '; tail=' + JSON.stringify(last4 ? last4.tail : null) +
    diag(a4));

  // A5
  const span = lines.slice(record.windows.A1.start, record.windows.A4.end);
  const bad = /(FATAL|jscrash|uncaught|Uncaught|TypeError|ReferenceError|is not a function|ArkWeb.*(?:crash|Error)|InputMethod.*(?:error|fail)|keyboard.*(?:error|fail))/;
  const badLines = span.filter((l) => bad.test(l));
  push('A5', badLines.length === 0, badLines.length === 0 ? '窗口内 ' + span.length + ' 行无 crash/uncaught/键盘异常' : '命中 ' + badLines.length + ' 行: ' + badLines.slice(0, 5).map((l) => l.trim().slice(0, 160)).join(' || '));

  // A6
  push('A6', true, '本判据即由本脚本在 --run 产物上完成（不需要重跑设备），命令序列固化为 run-record.json.steps');

  console.log('证据目录: ' + DIR);
  for (const v of verdicts) console.log((v.ok ? 'PASS' : 'FAIL') + ' ' + v.id + ' — ' + v.detail);
  const failed = verdicts.filter((v) => !v.ok).length;
  console.log('\n结论: ' + (failed === 0 ? '全部通过' : failed + ' 项未通过'));
  fs.writeFileSync(path.join(DIR, 'judge-report.json'), JSON.stringify({ at: new Date().toISOString(), verdicts }, null, 2));
}


// ---------------- judge 模式（--min）：复判 14:29 之后的最小验证窗口 ----------------
function judgeMin() {
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, 'min-record.json'), 'utf8'));
  const lines = fs.readFileSync(path.join(DIR, rec.streamLog), 'utf8').split(/\r?\n/);
  const chg = changesIn(lines);
  const lens = chg.map((c) => c.length);
  const verdicts = [];
  const push = (id, ok, detail) => verdicts.push({ id, ok, detail });
  const readDump = (f) => (fs.existsSync(path.join(DIR, f)) ? fs.readFileSync(path.join(DIR, f), 'utf8') : null);
  const has = (txt, s) => !!txt && txt.indexOf(s) >= 0;

  // A1：本窗口的内存证是 lifecycle 三行 + 页面状态文本
  const need = ['[page.appear]', '[channel.port.attached]', '[web.page.end] lexinote_workspace.html'];
  const hit = need.map((t) => lines.find((l) => l.indexOf(t) >= 0));
  push('A1', hit.every(Boolean), hit.map((l, i) => (l ? 'hilog: ' + l.trim().slice(0, 150) : '缺失 ' + need[i])).join(' | '));

  // A2：长度差必须精确等于注入字符数，且 dump 全文包含首尾各 20 字
  const T2c = Array.from(rec.texts.T2);
  const d2 = readDump(rec.a2.dump);
  const okLen2 = lens.indexOf(rec.a2.to) >= 0 && rec.a2.to - rec.a2.from === T2c.length;
  const okTxt2 = has(d2, T2c.slice(0, 20).join('')) && has(d2, T2c.slice(-20).join(''));
  push('A2', okLen2 && okTxt2, '注入 ' + T2c.length + ' 字符: ' + rec.a2.from + ' -> ' + rec.a2.to + '（要求差值=' + T2c.length +
    '）; dump ' + rec.a2.dump + ' 长度=' + (d2 ? Array.from(d2).length : '缺') + ', 含首20字/尾20字=' + okTxt2);

  // A3：五行 + 4 个换行，逐行首尾 15 字都要在 dump 里
  const d3 = readDump(rec.a3.dump);
  const sum = rec.texts.LINES3.reduce((s, x) => s + Array.from(x).length, 0) + rec.a3.newlines;
  const okLen3 = lens.indexOf(rec.a3.to) >= 0 && rec.a3.to - rec.a3.from === sum;
  const perLine = rec.texts.LINES3.map((x) => { const c = Array.from(x); return has(d3, c.slice(0, 15).join('')) && has(d3, c.slice(-15).join('')); });
  push('A3', okLen3 && perLine.every(Boolean), '五行长度=' + rec.texts.LINES3.map((x) => Array.from(x).length).join('/') + ': ' + rec.a3.from + ' -> ' + rec.a3.to +
    '（要求差值=' + sum + '）; dump ' + rec.a3.dump + ' 长度=' + (d3 ? Array.from(d3).length : '缺') + ', 逐行首尾命中=' + perLine.join('/'));

  // A4：本窗口同样没有任何 file-open / reading.sourcePath
  const sw = lines.filter((l) => /reading\.sourcePath|file-open/.test(l)).length;
  push('A4', false, '切笔记事件行数=' + sw + '（容器内无入口，触发链只有 LexiPluginRuntime.ets:1074 workspace.openLinkText → WorkspaceBridge.ets:285）');

  // A5：本窗口无 crash / uncaught / 键盘异常；同时要求没有剪贴板回退（有则说明注入没落在可编辑区）
  const badRe = /(FATAL|jscrash|uncaught|Uncaught|TypeError|ReferenceError|is not a function|ArkWeb.*(?:crash|Error)|InputMethod.*(?:error|fail)|keyboard.*(?:error|fail))/;
  const bad = lines.filter((l) => badRe.test(l));
  const paste = lines.filter((l) => PASTE.test(l)).length;
  push('A5', bad.length === 0 && paste === 0, '窗口内 ' + lines.length + ' 行: crash 类 ' + bad.length + ' 行, 剪贴板回退 ' + paste + ' 行');

  push('A6', true, '本判据同样由本脚本在既有产物上离线完成（node scripts/tests/input-robustness-evidence.cjs --min）');
  console.log('证据目录: ' + DIR);
  for (const v of verdicts) console.log((v.ok ? 'PASS' : 'FAIL') + ' ' + v.id + ' — ' + v.detail);
  fs.writeFileSync(path.join(DIR, 'judge-report-min.json'), JSON.stringify({ at: new Date().toISOString(), verdicts }, null, 2));
}

const MIN = process.argv.includes('--min');
(MIN ? Promise.resolve().then(judgeMin) : (RUN ? run() : Promise.resolve()).then(() => judge())).catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
