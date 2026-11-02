#!/usr/bin/env node
/**
 * 宽屏「第一次点笔记询问一次并记住」门禁。
 *
 *   node scripts/tests/wide-open-choice.cjs              # 真跑设备（不装包，用已装好的 HAP）
 *   node scripts/tests/wide-open-choice.cjs --install    # 先 hdc install -r 再跑
 *
 * 断言分两层：
 *   静态层  W-S*  直接读三个源码文件，断言状态字段/读入处/漏斗分支/弹窗文案/组件拦截点/设置行，全部带文件行号。
 *   设备层  W0..W8 真点宽屏窗口（aa start --ww/--wh 造宽屏），hilog 原文行号 + uitest dump 双证：
 *     W1 未选择 + 宽屏点笔记 → 弹出询问（dump 里两个按钮文案）+ [note.route] target=ask
 *     W2 选「插件工作区容器」→ target=container → [note.open.initial]/[note.open.loaded]；再点另一篇 → 不再询问，直接 target=container
 *     W3 设置页「重新询问」把键清空后标签回到「下次点击时询问」
 *     W4 记住 container 后设置页显示当前选择，开关可点
 *     W5 arkuiEditorOpen=true 时即使 wideOpenTarget=container 也不询问直接 target=arkui（开关优先）
 *     W6 重新询问后又弹窗
 *     W7 选「ArkUI 编辑器」→ target=arkui，且这一步没有容器装载日志，桌面标签页打开
 *     W8 重启后记住 arkui：不再询问，直接 target=arkui
 *
 * 每一步都是「点击 → 用正向锚点（确切 id/文本）轮询到出现 → 再走下一步」；「没有弹窗」类断言会
 * 在整个轮询窗口里持续观察弹窗文案，避免空树/桌面转场被当成证据。
 *
 * Exit: 0 全绿 / 1 有断言失败 / 2 设备不可达或 HAP 缺失。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HDC = process.env.HDC_PATH ||
  path.join('E:', 'dev-tools', 'harmonyos', 'command-line-tools', 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
const BUNDLE = 'com.lovexjy.lexinote';
const ABILITY = 'EntryAbility';
const HAP = path.join(REPO, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const OUT_ROOT = path.join(REPO, '.fixtures-out', 'evidence');
const INDEX = path.join(REPO, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
const SETTINGS = path.join(REPO, 'entry', 'src', 'main', 'ets', 'components', 'LexiSettingsWindow.ets');
const DESKTOP = path.join(REPO, 'entry', 'src', 'main', 'ets', 'components', 'LexiDesktopWorkspace.ets');
/** 宽屏窗口：1800px / Density 1.9 ≈ 947vp ≥ wide() 的 840 阈值。 */
const WW = ['--ww', '1800', '--wh', '1300', '--wl', '200', '--wt', '150'];
const DIALOG_CONTAINER = /^插件工作区容器$/;
const DIALOG_ARKUI = /^ArkUI 编辑器$/;
const PAGE_READY = /通道已建立/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(args, timeoutMs) {
  const res = spawnSync(HDC, args, { encoding: 'utf8', timeout: timeoutMs || 60000 });
  return { code: res.status, out: String(res.stdout || '') + String(res.stderr || '') };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/); } catch (err) { return []; }
}

// ---------------------------------------------------------------- 静态层

const staticChecks = [];
function srcLine(file, re) {
  const lines = readLines(file);
  for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { return { line: i + 1, text: lines[i].trim() }; } }
  return null;
}
function take(id, hit, detail, file) {
  staticChecks.push({ id, state: hit ? 'pass' : 'fail', file: path.relative(REPO, file || INDEX),
    line: hit ? hit.line : 0, text: hit ? hit.text : '', detail: hit ? '' : detail });
  return hit;
}

function staticLayer() {
  const state = srcLine(INDEX, /@State private wideOpenTarget: string = ''/);
  take('W-S1 wideOpenTarget state', state, 'Index.ets 缺少 @State private wideOpenTarget', INDEX);

  const load = srcLine(INDEX, /getSetting\('wideOpenTarget', ''\)/);
  take('W-S2 load from storage', load, 'initialize 没有读取 wideOpenTarget', INDEX);

  const save = srcLine(INDEX, /setSetting\('wideOpenTarget', value\)/);
  take('W-S3 persist choice', save, '没有把选择写回 LexiStorageService', INDEX);

  const switchFirst = srcLine(INDEX, /if \(this\.arkuiEditorOpen \|\| noteId\.length === 0\) \{ this\.openNoteArkui\(noteId\); return; \}/);
  take('W-S4 switch wins', switchFirst, 'openNote 首行没有把 arkuiEditorOpen 置于询问之前', INDEX);

  const containerBranch = srcLine(INDEX, /if \(this\.wideOpenTarget === 'container'\) \{ this\.openNoteContainer\(noteId\); return; \}/);
  take('W-S5 remembered container branch', containerBranch, 'openNote 没有按已记住的 container 直接路由', INDEX);

  const arkuiBranch = srcLine(INDEX, /if \(this\.wideOpenTarget === 'arkui'\) \{ this\.openNoteArkui\(noteId\); return; \}/);
  take('W-S6 remembered arkui branch', arkuiBranch, 'openNote 没有按已记住的 arkui 直接路由', INDEX);

  const funnel = srcLine(INDEX, /pushUrl\(\{ url: 'workspace\/LexiWorkspacePage', params: params \}\)/);
  take('W-S7 container through funnel', funnel, '容器路由没有走 pushUrl(workspace/LexiWorkspacePage)', INDEX);

  const logContainer = srcLine(INDEX, /WorkspaceLog\.info\('note\.route', 'target=container noteId=' \+ noteId\)/);
  take('W-S8 container anchor', logContainer, '缺少 target=container 日志锚点', INDEX);
  const logArkui = srcLine(INDEX, /WorkspaceLog\.info\('note\.route', 'target=arkui noteId=' \+ noteId\)/);
  take('W-S9 arkui anchor', logArkui, '缺少 target=arkui 日志锚点', INDEX);
  const logAsk = srcLine(INDEX, /WorkspaceLog\.info\('note\.route', 'target=ask noteId=' \+ noteId\)/);
  take('W-S10 ask anchor', logAsk, '缺少 target=ask 日志锚点', INDEX);

  const ctx = srcLine(INDEX, /this\.getUIContext\(\)\.getPromptAction\(\)\.showDialog\(\{/);
  take('W-S11 dialog via UIContext', ctx, '弹窗没有走 getUIContext().getPromptAction()', INDEX);
  const btnContainer = srcLine(INDEX, /text: '插件工作区容器'/);
  take('W-S12 button container copy', btnContainer, '弹窗缺少「插件工作区容器」按钮', INDEX);
  const btnArkui = srcLine(INDEX, /text: 'ArkUI 编辑器'/);
  take('W-S13 button arkui copy', btnArkui, '弹窗缺少「ArkUI 编辑器」按钮', INDEX);

  // 桌面拦截（开关优先 / 已记住 arkui）也必须留 route 证据，不能静默就地开标签。
  const hookLog = srcLine(INDEX, /reason=wide-tab/);
  const hookFn = srcLine(INDEX, /private requestNoteOpen\(noteId: string\): boolean \{/);
  const hookOrdered = hookLog && hookFn && hookLog.line > hookFn.line;
  take('W-S22 arkui short-circuit anchor', hookOrdered ? hookLog : null,
    'requestNoteOpen 返回 false 前没有打 target=arkui reason=wide-tab', INDEX);

  const resetProp = srcLine(SETTINGS, /@Prop wideOpenTarget: string = ''/);
  take('W-S14 settings prop', resetProp, 'LexiSettingsWindow 没有接住 wideOpenTarget', SETTINGS);
  const resetId = srcLine(SETTINGS, /\.id\('settings-wide-open-reset'\)/);
  take('W-S15 settings reset id', resetId, '缺少 settings-wide-open-reset', SETTINGS);
  const resetCopy = srcLine(SETTINGS, /Button\('重新询问'/);
  take('W-S16 settings reset copy', resetCopy, '缺少「重新询问」按钮', SETTINGS);
  const resetCall = srcLine(SETTINGS, /this\.onResetWideOpen\(\)/);
  take('W-S17 settings reset action', resetCall, '「重新询问」没有回调', SETTINGS);

  const dProp = srcLine(DESKTOP, /onNoteOpenRequest: \(noteId: string\) => boolean/);
  take('W-S18 desktop hook prop', dProp, 'LexiDesktopWorkspace 没有 onNoteOpenRequest', DESKTOP);
  const dRow = srcLine(DESKTOP, /onClick\(\(\): void => \{ if \(!this\.onNoteOpenRequest\(\$\$\.note\.id\)\)/);
  take('W-S19 desktop row intercept', dRow, '侧栏笔记行没有先问宿主', DESKTOP);
  const dPalette = srcLine(DESKTOP, /else if \(!this\.onNoteOpenRequest\(id\)\)/);
  take('W-S20 desktop palette intercept', dPalette, '命令面板打开笔记没有先问宿主', DESKTOP);

  const wire = srcLine(INDEX, /onNoteOpenRequest: \(noteId: string\): boolean => this\.requestNoteOpen\(noteId\)/);
  take('W-S21 host wired', wire, 'Index 没有把 requestNoteOpen 接给桌面工作区', INDEX);

  console.log('--- static layer (source line anchors)');
  for (const c of staticChecks) {
    console.log('  ' + c.state.toUpperCase().padEnd(5) + c.id + ' @ ' + (c.line ? c.file + ':' + c.line : '-') +
      (c.text ? '  ' + c.text : '  ' + c.detail));
  }
}

// ---------------------------------------------------------------- 设备层

function box(bounds) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(bounds || ''));
  if (!m) { return null; }
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], cx: Math.round((+m[1] + +m[3]) / 2), cy: Math.round((+m[2] + +m[4]) / 2) };
}

/** 判定文案分两类：pass 记「命中」证据（附 @hilog 行号与原文），fail 才记「缺少/没有」的原因。
 *  绿报告里出现「hilog 缺少 …」，任何人 grep 都会读成失败——文案必须跟着判定走。 */
function hitDetail(ok, failDetail, line, passDetail, readLine) {
  if (!ok) { return { detailKind: 'miss', detail: failDetail }; }
  if (passDetail) { return { detailKind: 'hit', detail: passDetail }; }
  if (!line) { return { detailKind: 'hit', detail: '锚点已命中（dump 正向锚点，见本步落盘的节点树）' }; }
  const text = readLine ? String(readLine(line) || '').trim().slice(0, 120) : '';
  return { detailKind: 'hit', detail: '命中 @hilog:' + line + (text ? '  ' + text : '') };
}

function walk(node, out) {
  if (!node || typeof node !== 'object') { return out; }
  if (node.attributes) { out.push(node.attributes); }
  for (const c of node.children || []) { walk(c, out); }
  return out;
}

async function deviceLayer(dir, hilogFile) {
  let seq = 0;
  const checks = [];
  const deviceChecks = [];
  let detailLogLines = null;
  const add = (id, ok, failDetail, line, passDetail) => {
    const r = hitDetail(ok, failDetail, line, passDetail, (n) => {
      if (!detailLogLines) { detailLogLines = readLines(hilogFile); }
      return detailLogLines[n - 1];
    });
    const c = { id, state: ok ? 'pass' : 'fail', detailKind: r.detailKind, detail: r.detail, line: line || 0 };
    checks.push(c);
    deviceChecks.push(c);
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + '  ' + r.detail + (!ok && line ? ' @hilog:' + line : ''));
  };

  const dump = (tag) => {
    const name = (++seq) + '-' + tag;
    const remote = '/data/local/tmp/wo-' + name + '.json';
    const local = path.join(dir, name + '.json');
    sh(['shell', 'uitest', 'dumpLayout', '-p', remote], 60000);
    sh(['file', 'recv', remote, local], 60000);
    let nodes = [];
    try { nodes = walk(JSON.parse(fs.readFileSync(local, 'utf8')), []); } catch (err) { nodes = []; }
    return nodes;
  };
  const hasId = (nodes, re) => nodes.some((a) => re.test(String(a.id || '')) && box(a.bounds));
  const hasText = (nodes, re) => nodes.some((a) => a.type === 'Text' && re.test(String(a.text || '')) && box(a.bounds));
  const byId = (nodes, re) => nodes.find((a) => re.test(String(a.id || '')) && box(a.bounds));
  const byText = (nodes, re) => nodes.find((a) => a.type === 'Text' && re.test(String(a.text || '')) && box(a.bounds));
  /** 设置窗在模拟器上刚出现时坐标还在动，一次点不中很常见：先看是否已经满足，再「取节点→点→等目标」，最多 3 轮。 */
  const clickUntil = async (findNode, screenPred, tag, tries) => {
    const limit = tries || 3;
    const first = dump(tag + '-first');
    if (screenPred(first)) { return { ok: true, clicks: 0, nodes: first }; }
    for (let i = 0; i < limit; i++) {
      const node = findNode(dump(tag + '-find' + i));
      if (!node) { return { ok: false, clicks: i, nodes: [] }; }
      clickNode(node, tag);
      const w = await waitScreen(tag + '-wait' + i, screenPred, 12000);
      if (w.ok) { return { ok: true, clicks: i + 1, nodes: w.nodes }; }
    }
    return { ok: false, clicks: limit, nodes: [] };
  };
  const clickNode = (node, what) => {
    if (!node) { throw new Error('找不到要点击的节点：' + (what || '(未命名)')); }
    const b = box(node.bounds);
    sh(['shell', 'uitest', 'uiInput', 'click', String(b.cx), String(b.cy)], 30000);
    return b;
  };

  /** 轮询 dump 直到 pred 成立；onEach 可在窗口内持续观察（例如「这一步有没有出现弹窗」）。 */
  const waitScreen = async (tag, pred, timeoutMs, onEach) => {
    const end = Date.now() + (timeoutMs || 30000);
    let nodes = [];
    let tries = 0;
    while (Date.now() < end) {
      nodes = dump(tag + (tries ? '-' + tries : ''));
      tries++;
      if (onEach) { onEach(nodes); }
      if (pred(nodes)) { return { ok: true, nodes }; }
      await sleep(700);
    }
    return { ok: false, nodes };
  };

  const logMark = () => readLines(hilogFile).length;
  const logSince = (mark) => readLines(hilogFile).slice(mark).map((text, i) => ({ line: mark + i + 1, text }));
  const findIn = (mark, re) => logSince(mark).find((row) => re.test(row.text)) || null;
  const countIn = (mark, re) => logSince(mark).filter((row) => re.test(row.text)).length;
  const syncLog = () => { readLines(hilogFile); };
  /** 轮询日志等锚点：容器装载是异步的，auth.ok 之后还有约 1s 才 openInitialNote，
   *  固定 sleep 或提前 force-stop 都会把「还没装载」误判成「装载错了」。 */
  const waitLog = async (mark, re, ms) => {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) {
      const hit = findIn(mark, re);
      if (hit) { return hit; }
      await sleep(400);
    }
    return null;
  };
  /** 失败取证：auth.ok 到末尾的行区间，及该区间里 layoutReady 的命中数。 */
  const logWindowNote = (mark) => {
    const rows = logSince(mark);
    if (rows.length === 0) { return '（本步日志为空）'; }
    const authIdx = rows.findIndex((r) => /\[channel\.auth\.ok\]/.test(r.text));
    const from = rows[authIdx >= 0 ? authIdx : 0];
    const to = rows[rows.length - 1];
    const seg = rows.slice(authIdx >= 0 ? authIdx : 0);
    const ready = seg.filter((r) => /layoutReady/.test(r.text)).length;
    return '；auth.ok@hilog:' + from.line + ' → 末尾@hilog:' + to.line + '（该区间 layoutReady 命中 ' + ready + ' 条）';
  };

  const ON_DESKTOP = (nodes) => hasId(nodes, /^workspace-action-dock-profile$/);
  const noteRows = (nodes) => nodes.filter((a) => /^workspace-note-/.test(String(a.id || '')) && box(a.bounds));

  /** 冷启宽屏。设置窗的关闭按钮在 dump 里时有时无，所以每次改完设置都直接重启应用：
   *  既避开「窗口已关但点不到」的遮罩歧义，又顺带证明选择真的落盘了。 */
  const launchWide = async (tag) => {
    sh(['shell', 'aa', 'force-stop', BUNDLE], 30000);
    syncLog();
    sh(['shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE].concat(WW), 30000);
    return waitScreen((tag || 'boot') + '-boot', ON_DESKTOP, 40000);
  };

  /** 打开设置 → 编辑器分类；返回该屏 nodes（含 settings-wide-open-reset）。 */
  const openEditorSettings = async (tag) => {
    const desk = await waitScreen(tag + '-desktop', ON_DESKTOP, 30000);
    const profile = byId(desk.nodes, /^workspace-action-dock-profile$/);
    if (!profile) { return { ok: false, nodes: desk.nodes, reason: '桌面没有 workspace-action-dock-profile' }; }
    clickNode(profile);
    const opened = await waitScreen(tag + '-settings', (n) => hasText(n, /^编辑器$/) && hasId(n, /^settings-window|^settings-arkui-editor-toggle$/), 40000);
    const tab = byText(opened.nodes, /^编辑器$/);
    if (!tab) { return { ok: false, nodes: opened.nodes, reason: '设置窗没有打开（找不到「编辑器」分类）' }; }
    clickNode(tab);
    const editor = await waitScreen(tag + '-editor', (n) => hasId(n, /^settings-wide-open-reset$/), 30000);
    return { ok: editor.ok, nodes: editor.nodes, reason: editor.ok ? '' : '编辑器分类里没有 settings-wide-open-reset' };
  };
  const closeSettings = async (tag) => {
    const nodes = dump(tag + '-before-close');
    const close = byText(nodes, /^关闭$/);
    if (close) { clickNode(close); }
    return waitScreen(tag + '-closed', (n) => !hasId(n, /^settings-wide-open-reset$/) && ON_DESKTOP(n), 30000);
  };

  return (async () => {
    // ---------- W0 宽屏桌面
    let screen = await launchWide('w0');
    const rows0 = noteRows(screen.nodes);
    add('W0 wide desktop rendered', screen.ok && rows0.length > 0,
      '宽屏桌面工作区没渲染（ribbon=' + hasId(screen.nodes, /^workspace-action-dock-profile$/) + ' rows=' + rows0.length + '）');

    // ---------- W3 设置「重新询问」
    let s = await openEditorSettings('s1');
    if (!s.ok) { throw new Error('设置窗打不开：' + s.reason); }
    const resetBtn = byId(s.nodes, /^settings-wide-open-reset$/);
    add('W3a settings reset row present', !!resetBtn, s.reason || '找不到 settings-wide-open-reset');
    const labelBefore = byText(s.nodes, /^宽屏点击笔记：/);
    add('W3b settings label present', !!labelBefore, '设置行没有状态文案');
    if (labelBefore) { console.log('  note: 重置前标签 = ' + String(labelBefore.text)); }

    // 基线归零：上一轮跑挂时可能留下 arkuiEditorOpen=true 或已记住的选择，先把两者都清掉。
    const staleToggle = byId(s.nodes, /^settings-arkui-editor-toggle$/);
    if (staleToggle && String(staleToggle.checked) === 'true') {
      console.log('  note: 基线清理 —— 开关先前是打开的，先关掉');
      const off = await clickUntil(
        (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return t && String(t.checked) === 'true' ? t : null; },
        (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return !!t && String(t.checked) !== 'true'; },
        'baseline-switch-off');
      add('W3d baseline switch cleared', off.ok, '基线清理：开关没能关掉，后续会误判');
    }
    const afterReset = await clickUntil(
      (n) => byId(n, /^settings-wide-open-reset$/),
      (n) => hasText(n, /^宽屏点击笔记：下次点击时询问$/),
      'after-reset');
    add('W3c reset clears choice', afterReset.ok, '点「重新询问」后标签没有回到「下次点击时询问」');
    await launchWide('relaunch-after-baseline');

    // ---------- W1 未选择 → 询问
    const listA = await waitScreen('list-a', (n) => noteRows(n).length > 0 && ON_DESKTOP(n), 30000);
    const rowA = noteRows(listA.nodes)[0];
    if (!rowA) { throw new Error('宽屏列表里没有 workspace-note-* 行'); }
    const noteA = String(rowA.id).replace('workspace-note-', '');
    let mark = logMark();
    let sawDialogA = false;
    clickNode(rowA);
    const dlgA = await waitScreen('dialog-a', (n) => hasText(n, DIALOG_CONTAINER) && hasText(n, DIALOG_ARKUI), 30000,
      (n) => { if (hasText(n, DIALOG_CONTAINER)) { sawDialogA = true; } });
    add('W1a ask dialog shown', dlgA.ok && sawDialogA, 'dump 里没有同时出现「插件工作区容器」和「ArkUI 编辑器」');
    const askLine = findIn(mark, new RegExp('\\[note\\.route\\] target=ask noteId=' + noteA));
    add('W1b ask anchor', !!askLine, 'hilog 缺少 [note.route] target=ask noteId=' + noteA, askLine ? askLine.line : 0);

    // ---------- W2 选容器 → 装载 → 记住
    mark = logMark();
    clickNode(byText(dump('dialog-a-click'), DIALOG_CONTAINER));
    const pageA = await waitScreen('container-page', (n) => hasText(n, PAGE_READY), 40000);
    add('W2a container page opened', pageA.ok, '容器页没有出现（dump 无「通道已建立」）');
    const routeC = findIn(mark, new RegExp('\\[note\\.route\\] target=container noteId=' + noteA));
    add('W2b route container', !!routeC, 'hilog 缺少 target=container noteId=' + noteA, routeC ? routeC.line : 0);
    const initialC = await waitLog(mark, new RegExp('\\[note\\.open\\.initial\\] noteId=' + noteA), 8000);
    add('W2c container loaded that note', !!initialC,
      'hilog 缺少 [note.open.initial] noteId=' + noteA + logWindowNote(mark), initialC ? initialC.line : 0);
    const loadedC = initialC ? await waitLog(mark, /\[note\.open\.loaded\]/, 8000) : null;
    add('W2d note.open.loaded', !!loadedC,
      'hilog 缺少 [note.open.loaded]' + logWindowNote(mark), loadedC ? loadedC.line : 0);

    // ---------- W2e 已记住 container → 再点另一篇不再询问（重启后仍记住）
    await launchWide('relaunch-after-container');
    const listB = await waitScreen('list-b', (n) => noteRows(n).length > 1 && ON_DESKTOP(n), 30000);
    const rowB = noteRows(listB.nodes).filter((a) => String(a.id) !== String(rowA.id))[0];
    if (!rowB) { throw new Error('宽屏列表里没有第二篇笔记可点'); }
    const noteB = String(rowB.id).replace('workspace-note-', '');
    mark = logMark();
    let sawDialogB = false;
    clickNode(rowB);
    const pageB = await waitScreen('remembered-container', (n) => hasText(n, PAGE_READY), 40000,
      (n) => { if (hasText(n, DIALOG_CONTAINER)) { sawDialogB = true; } });
    add('W2e no second prompt', !sawDialogB, '第二次点击仍然弹窗（说明没记住选择）');
    add('W2f container page again', pageB.ok, '第二次点击没有直接进容器页');
    const askB = countIn(mark, /\[note\.route\] target=ask/);
    add('W2g no second ask log', askB === 0, '第二次点击仍打出 target=ask（' + askB + ' 次）');
    const routeB = findIn(mark, new RegExp('\\[note\\.route\\] target=container noteId=' + noteB));
    add('W2h direct container', !!routeB, 'hilog 缺少第二篇的 target=container noteId=' + noteB, routeB ? routeB.line : 0);
    await launchWide('relaunch-after-remembered');

    // ---------- W4 设置页显示当前选择 + 开关
    s = await openEditorSettings('s2');
    const labelContainer = s.nodes ? byText(s.nodes, /^宽屏点击笔记：插件工作区容器$/) : null;
    add('W4a settings reflects container', !!labelContainer, s.reason || '设置行没有显示「宽屏点击笔记：插件工作区容器」');
    const toggle = s.nodes ? byId(s.nodes, /^settings-arkui-editor-toggle$/) : null;
    add('W4b switch toggle present', !!toggle, '找不到 settings-arkui-editor-toggle');
    const switchedOn = await clickUntil(
      (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return t && String(t.checked) !== 'true' ? t : null; },
      (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return !!t && String(t.checked) === 'true'; },
      'switch-on');
    add('W4c switch turned on', switchedOn.ok, '点了开关但 checked 不是 true' + (toggle ? '' : '（W4b 已失败）'));
    await sleep(1500);
    const settledOn = byId(dump('switch-on-settle'), /^settings-arkui-editor-toggle$/);
    add('W4d switch stays on', !!settledOn && String(settledOn.checked) === 'true',
      '开关自己弹回去了（checked=' + (settledOn ? String(settledOn.checked) : 'missing') + '）');
    await launchWide('relaunch-after-switch-on');

    // ---------- W5 开关优先于已记住的 container
    const listC = await waitScreen('list-c', (n) => noteRows(n).length > 0 && ON_DESKTOP(n), 30000);
    const rowC = noteRows(listC.nodes)[0];
    const noteC = String(rowC.id).replace('workspace-note-', '');
    mark = logMark();
    let sawDialogC = false;
    clickNode(rowC);
    const tabC = await waitScreen('switch-on-open', (n) => hasId(n, new RegExp('^workspace-tab-' + noteC + '$')), 30000,
      (n) => { if (hasText(n, DIALOG_CONTAINER)) { sawDialogC = true; } });
    add('W5a no prompt when switch on', !sawDialogC, '开关打开时仍然弹窗（开关没有优先于询问）');
    const routeC2 = findIn(mark, new RegExp('\\[note\\.route\\] target=arkui noteId=' + noteC + ' reason=wide-tab'));
    add('W5b switch wins over remembered container', !!routeC2, 'hilog 缺少 target=arkui noteId=' + noteC, routeC2 ? routeC2.line : 0);
    const askC = countIn(mark, /\[note\.route\] target=ask/);
    add('W5c no ask log when switch on', askC === 0, '开关打开时仍打 target=ask（' + askC + ' 次）');
    add('W5d arkui desktop tab', tabC.ok, 'dump 里没有 workspace-tab-' + noteC);
    const containerC = countIn(mark, /\[note\.route\] target=container|\[note\.open\.initial\]/);
    add('W5e no container leg when switch on', containerC === 0, '开关打开时仍出现容器路由/装载（' + containerC + ' 条）');

    // ---------- W6 关开关 + 重新询问 → 又弹窗
    s = await openEditorSettings('s3');
    const toggle2 = s.nodes ? byId(s.nodes, /^settings-arkui-editor-toggle$/) : null;
    add('W6a switch reachable again', !!toggle2, s.reason || '第二次找不到开关');
    const switchedOff = await clickUntil(
      (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return t && String(t.checked) === 'true' ? t : null; },
      (n) => { const t = byId(n, /^settings-arkui-editor-toggle$/); return !!t && String(t.checked) !== 'true'; },
      'switch-off');
    add('W6a2 switch turned off', switchedOff.ok, '点了开关但没有关掉（checked 仍是 true）');
    await sleep(1500);
    const settledOff = byId(dump('switch-off-settle'), /^settings-arkui-editor-toggle$/);
    add('W6a3 switch stays off', !!settledOff && String(settledOff.checked) !== 'true',
      '开关自己弹回打开了（checked=' + (settledOff ? String(settledOff.checked) : 'missing') + '）');
    const reset2 = byId(dump('s3-reset'), /^settings-wide-open-reset$/);
    add('W6b settings reset reachable', !!reset2, '第二次找不到 settings-wide-open-reset');
    const resetAgain = await clickUntil(
      (n) => byId(n, /^settings-wide-open-reset$/),
      (n) => hasText(n, /^宽屏点击笔记：下次点击时询问$/),
      'reset-again');
    add('W6c reset label back to ask', resetAgain.ok, '重新询问后标签没有回到「下次点击时询问」');
    await launchWide('relaunch-after-reset');

    const listD = await waitScreen('list-d', (n) => noteRows(n).length > 0 && ON_DESKTOP(n), 30000);
    const rowD = noteRows(listD.nodes)[0];
    const noteD = String(rowD.id).replace('workspace-note-', '');
    mark = logMark();
    clickNode(rowD);
    const dlgD = await waitScreen('dialog-d', (n) => hasText(n, DIALOG_CONTAINER) && hasText(n, DIALOG_ARKUI), 30000);
    add('W6d reset restores prompt', dlgD.ok, '「重新询问」之后点笔记没有重新弹窗');

    // ---------- W7 选 ArkUI 编辑器
    mark = logMark();
    clickNode(byText(dump('dialog-d-click'), DIALOG_ARKUI));
    const tabD = await waitScreen('arkui-open', (n) => hasId(n, new RegExp('^workspace-tab-' + noteD + '$')), 30000);
    // 本步是「询问后选 ArkUI」，走 openNoteArkui（Index.ets:447）打的是 target=arkui，
    // reason=wide-tab 只属于 requestNoteOpen 的开关/已记住短路，两条路径锚点不能混用。
    const routeArkuiD = findIn(mark, new RegExp('\\[note\\.route\\] target=arkui noteId=' + noteD));
    add('W7a route arkui', !!routeArkuiD, 'hilog 缺少 target=arkui noteId=' + noteD, routeArkuiD ? routeArkuiD.line : 0);
    const containerD = countIn(mark, /\[note\.route\] target=container|\[note\.open\.initial\]|\[note\.open\.loaded\]/);
    add('W7b no container leg', containerD === 0, '选 ArkUI 后仍出现容器路由/装载（' + containerD + ' 条）');
    add('W7c arkui desktop tab opened', tabD.ok, 'dump 里没有 workspace-tab-' + noteD);

    // ---------- W8 重启后记住 arkui
    screen = await launchWide('w8');
    const rows3 = noteRows(screen.nodes);
    const rowE = rows3.filter((a) => String(a.id) !== 'workspace-note-' + noteD)[0] || rows3[0];
    if (!rowE) { throw new Error('重启后宽屏列表为空'); }
    const noteE = String(rowE.id).replace('workspace-note-', '');
    mark = logMark();
    let sawDialogE = false;
    clickNode(rowE);
    const tabE = await waitScreen('restart-arkui', (n) => hasId(n, new RegExp('^workspace-tab-' + noteE + '$')), 30000,
      (n) => { if (hasText(n, DIALOG_CONTAINER)) { sawDialogE = true; } });
    add('W8a remembered arkui no prompt', !sawDialogE, '重启后仍然弹窗（arkui 没记住）');
    const askE = countIn(mark, /\[note\.route\] target=ask/);
    add('W8b no ask log after restart', askE === 0, '重启后仍打 target=ask（' + askE + ' 次）');
    const routeE = findIn(mark, new RegExp('\\[note\\.route\\] target=arkui noteId=' + noteE + ' reason=wide-tab'));
    add('W8c direct arkui after restart', !!routeE, '重启后没有直接 target=arkui noteId=' + noteE, routeE ? routeE.line : 0);
    add('W8d arkui tab after restart', tabE.ok, 'dump 里没有 workspace-tab-' + noteE);

    return checks;
  })().catch((err) => {
    console.log('  FAIL    flow @ -  ' + (err && err.message ? err.message : String(err)));
    return checks;
  });
}

// ---------------------------------------------------------------- replay
// 回放模式：拿一次真跑落盘的 hilog.log + dump 复判同一批设备断言。
// 它让「断言对证据的敏感性」可以被廉价的变异证明（改日志副本 → 必须红），
// 而不必为造红去改产品代码、再吃一次构建/安装额度。
function replayLayer(dir) {
  const logPath = path.join(dir, 'hilog.log');
  if (!fs.existsSync(logPath)) { console.log('replay: missing ' + logPath); return false; }
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r\n|\r|\n/);
  // hilog 是从启动抓取的：上一次运行残留的进程会先打出旧 route 行（run8 里在 hilog:1546）。
  // 因此只统计本次运行第一次冷启（StartAbility com.lovexjy.lexinote）之后的路由。
  const runStart = lines.findIndex((l) => /StartAbility com\.lovexjy\.lexinote/.test(l));
  const routes = [];
  lines.forEach((l, i) => {
    if (runStart >= 0 && i < runStart) { return; }
    const m = /\[note\.route\] target=(\w+) noteId=([0-9a-f-]+)/.exec(l);
    if (m) { routes.push({ kind: m[1], noteId: m[2], line: i + 1, text: l.trim() }); }
  });
  const checks = [];
  const add = (id, ok, detail) => { checks.push({ id, ok, detail }); };

  const asks = routes.filter((r) => r.kind === 'ask');
  add('R1 exactly two prompt points', asks.length === 2,
    'target=ask 行数 = ' + asks.length + '（期望 2：未选那次 + 重新询问那次），行号 ' + asks.map((a) => a.line).join(','));

  const firstAsk = asks[0];
  const firstRoute = routes.find((r) => r.kind !== 'ask');
  add('R2 first open asks before routing', !!firstAsk && !!firstRoute && firstAsk.line < firstRoute.line,
    firstAsk ? '首次询问 @' + firstAsk.line + ' 早于首个路由 @' + (firstRoute ? firstRoute.line : '-') : 'hilog 没有 target=ask');

  const secondAsk = asks[1];
  const remembered = routes.filter((r) => r.kind === 'container' && firstAsk && secondAsk &&
    r.line > firstAsk.line && r.line < secondAsk.line);
  const rememberedOther = remembered.filter((r) => firstAsk && r.noteId !== firstAsk.noteId);
  add('R3 remembered choice routes without asking again', rememberedOther.length >= 1,
    '首次询问与重新询问之间的 container 路由 ' + remembered.length + ' 条，其中另一篇 ' + rememberedOther.length + ' 条（期望 ≥1：即记住后换一篇直接进容器）');

  const askBetween = routes.filter((r) => r.kind === 'ask' && firstAsk && secondAsk && r.line > firstAsk.line && r.line < secondAsk.line);
  add('R4 no prompt while choice is remembered', askBetween.length === 0,
    '记忆区间内仍有 target=ask ' + askBetween.length + ' 条');

  const arkuiAfter = routes.filter((r) => r.kind === 'arkui' && secondAsk && r.line > secondAsk.line);
  // 最后一条路由必须是 arkui：否则「记住 arkui 之后换一篇」仍可能悄悄走容器。
  const lastAfter = routes.filter((r) => secondAsk && r.line > secondAsk.line).pop();
  add('R5 remembered arkui routes arkui', arkuiAfter.length >= 1 && !!lastAfter && lastAfter.kind === 'arkui',
    '最后一次询问之后的 target=arkui ' + arkuiAfter.length + ' 条，末条路由=' + (lastAfter ? lastAfter.kind + '@' + lastAfter.line : '无'));

  const dumps = fs.readdirSync(dir).filter((n) => /^\d+-.*\.json$/.test(n)).map((n) => {
    try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { return ''; }
  });
  const dialogDumps = dumps.filter((t) => t.indexOf('插件工作区容器') >= 0 && t.indexOf('ArkUI 编辑器') >= 0).length;
  const pageDumps = dumps.filter((t) => t.indexOf('通道已建立') >= 0).length;
  add('R6 dumps carry dialog + container page', dialogDumps >= 1 && pageDumps >= 1,
    '含双按钮的 dump ' + dialogDumps + ' 个，含容器页锚点的 dump ' + pageDumps + ' 个');

  console.log('--- replay layer (' + path.relative(REPO, dir) + ')');
  console.log('routes: ' + routes.length + ' (ask ' + asks.length + ')');
  let pass = 0;
  checks.forEach((c) => {
    if (c.ok) { pass++; }
    console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + ' ' + c.id + '  ' + c.detail);
  });
  console.log('checks: ' + pass + '/' + checks.length + ' pass');
  console.log('result: ' + (pass === checks.length ? 'PASS' : 'FAIL'));
  fs.writeFileSync(path.join(dir, 'replay.json'), JSON.stringify({ dir: path.relative(REPO, dir), result: pass === checks.length ? 'pass' : 'fail', checks }, null, 2));
  return pass === checks.length;
}

// ---------------------------------------------------------------- entry

async function main() {
  const argv = process.argv.slice(2);
  const doInstall = argv.indexOf('--install') >= 0;
  const outIdx = argv.indexOf('--out');
  const dir = outIdx >= 0 ? path.resolve(REPO, argv[outIdx + 1]) : path.join(OUT_ROOT, stamp() + '-wide-open-choice');
  fs.mkdirSync(dir, { recursive: true });

  staticLayer();

  const replayIdx = argv.indexOf('--replay');
  if (replayIdx >= 0) {
    const target = path.resolve(REPO, argv[replayIdx + 1]);
    process.exit(replayLayer(target) ? 0 : 1);
  }

  const devices = sh(['list', 'targets'], 20000).out.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.length > 0 && l.indexOf('Empty') < 0);
  if (devices.length === 0) { console.log('device: none reachable via ' + HDC); process.exit(2); }
  if (!fs.existsSync(HAP)) { console.log('hap: missing ' + HAP + ' (run hvigorw assembleHap first)'); process.exit(2); }
  console.log('device: ' + devices[0]);
  console.log('out: ' + path.relative(REPO, dir));

  if (doInstall) {
    const install = sh(['install', '-r', HAP], 240000);
    console.log('install: ' + (install.out.indexOf('successfully') >= 0 ? 'successfully' : 'FAILED'));
    if (install.out.indexOf('successfully') < 0) { process.exit(1); }
  }

  sh(['shell', 'power-shell', 'wakeup'], 20000);
  const hilogFile = path.join(dir, 'hilog.log');
  const fd = fs.openSync(hilogFile, 'w');
  const child = spawn(HDC, ['shell', 'hilog'], { stdio: ['ignore', fd, fd] });

  let checks = [];
  let flowError = '';
  try {
    checks = await deviceLayer(dir, hilogFile);
  } catch (err) {
    flowError = err && err.message ? err.message : String(err);
  } finally {
    child.kill();
    fs.closeSync(fd);
  }

  console.log('--- device layer (hilog line anchors)');
  for (const c of checks) {
    console.log('  ' + c.state.toUpperCase().padEnd(5) + c.id + ' @ line ' + (c.line || '-') + '  ' + c.detail);
  }
  if (flowError) { console.log('  FAIL    flow @ -  ' + flowError); }

  const staticFailed = staticChecks.filter((c) => c.state === 'fail');
  const failed = checks.filter((c) => c.state === 'fail').length + staticFailed.length + (flowError ? 1 : 0);
  const total = checks.length + staticChecks.length;
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    device: devices[0],
    hap: HAP,
    log: path.relative(REPO, hilogFile),
    flowError,
    result: failed === 0 ? 'pass' : 'fail',
    static: staticChecks,
    deviceChecks: checks
  }, null, 2) + '\n');
  console.log('checks: ' + (total - failed) + '/' + total + ' pass');
  console.log('result: ' + (failed === 0 ? 'PASS' : 'FAIL'));
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.log('flow error: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
}

// 供离线审计用：以既有 run 的判定结果 + 该 run 的 hilog 原文，用同一条 helper 重算 detail。
module.exports = { hitDetail };
