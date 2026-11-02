#!/usr/bin/env node
/**
 * Product-route evidence gate: 默认路由 = 「列表点笔记 → 插件工作区容器装载该笔记」。
 *
 *   node scripts/tests/product-route-evidence.cjs                       # live run on the attached device (uitest 真点列表)
 *   node scripts/tests/product-route-evidence.cjs --check-only <dir|log> # 重放已有 hilog（不占设备）
 *   node scripts/tests/product-route-evidence.cjs --check-only <log> --require-session
 *
 * M2-A 之后产品默认路由换了方向：Index.openNote 在「用 ArkUI 编辑器打开笔记」关闭时把笔记交给
 * workspace/LexiWorkspacePage 容器，容器再通过既有通道（workspace.note.write / note-open）装载与写回。
 * 旧的产品路由（LexiPluginRuntimeHost → lexinote_plugin_runtime.html，冷启自带页面）没有删除：
 * 它的断言整组保留，id 一律带 [route:product:fallback]，日志里出现旧路由锚点时才判定（否则 SKIP）。
 * 开关打开后走 ArkUI 编辑器的那条腿同样是回退用例：[route:product:fallback:arkui]。
 *
 * 断言（当前路由为容器时）：
 *   C0 路由决策   [note.route] target=container noteId=<id>                  ← 列表点击进容器，不是编辑器
 *   C1 页面装载   [web.page.begin]/[web.page.end] lexinote_workspace.html + runtime.page 指向同一页面
 *   C2 插件装载   LexiPlugin: 插件 onload 完成: lexi-sample-plugin（容器内插件真的活）
 *   C3 笔记请求   [page.note.request] noteId=<同一 id>                       ← 路由参数被容器读到
 *   C4 正文下推   [note.open.out] path=<path> chars=<n>                      ← 宿主 pumpNote 读到了正文
 *   C5 编辑器落地 [note.open.loaded] {path,chars}                            ← CM6 真的 setValue
 *   C6 无装载异常 C0 之后不得出现 onload error / 插件源码读取失败 / note.open.miss / note.write.deny
 *   C7 会话身份   [lexinote] session.token tail=<非 none>（--require-session 时断言，否则只报告）
 *   C8 写回同一篇 每条 reason=edit 的 [note.write.saved] 结构化载荷，其 path 必须等于 C4/C5 打开的那篇；
 *                  一次编辑都没有时才 pending，有写回但缺 reason=edit 或 path 对不上 → fail
 *   C9 id 链路     [note.route] target=container noteId=X 必须等于 [note.open.initial] noteId=Y
 *                  （Index 传错 id 时 C4/C5 仍会绿，这条把路由参数与装载 id 焊在一起）
 *
 * 回退用例（旧路由 / ArkUI 编辑器）的锚点、判定规则与 M2-A 之前完全一致，只是 id 加了前缀。
 *
 * Exit: 0 通过 / 1 断言失败 / 2 设备不可达或 HAP 缺失。
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
/** 冷启/容器都自带的内置插件:不需要额外安装就能触发一次真实的 load.plugin。 */
const SAMPLE = 'lexi-sample-plugin';
/** 回退用例 id 前缀：旧产品路由（LexiPluginRuntimeHost）与 ArkUI 编辑器两条回退腿。 */
const FALLBACK = '[route:product:fallback]';
const FALLBACK_ARKUI = '[route:product:fallback:arkui]';
const CONTAINER = '[route:container]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(args, timeoutMs) {
  const res = spawnSync(HDC, args, { encoding: 'utf8', timeout: timeoutMs || 60000 });
  return { code: res.status, out: String(res.stdout || '') + String(res.stderr || '') };
}

function targets() {
  const res = sh(['list', 'targets'], 20000);
  return res.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.indexOf('Empty') < 0);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readLines(file) {
  // hilog 里偶尔有孤立 \r(CEF 行)，只按 \n 切的编号会比编辑器少 1——证据行号必须和编辑器一致。
  try { return fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/); } catch (err) { return []; }
}

// ---------------------------------------------------------------- assertions

/** 从日志行里取结构化载荷：桥把页面回报的 JSON 原样下推，页面侧同一条会在 ARKWEB-CONSOLE 里再出现一次。 */
function parseJsonPayload(text, marker) {
  const at = text.lastIndexOf(marker);
  if (at < 0) {
    return null;
  }
  const start = text.indexOf('{', at);
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  const raw = text.slice(start, end + 1);
  for (const candidate of [raw, raw.replace(/\\"/g, '"')]) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === 'object') {
        return value;
      }
    } catch (err) {
      // 换下一种形态
    }
  }
  return null;
}

/** 会话令牌锚点：`none` 是 auth 之前的那一条，取第一处非 none。 */
function sessionTail(lines) {
  let first = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\[lexinote\] session\.token tail=([^"\s]+)/);
    if (!m) { continue; }
    const hit = { line: i + 1, tail: m[1] };
    if (m[1] !== 'none') { return hit; }
    if (!first) { first = hit; }
  }
  return first;
}

/**
 * 断言全部只读 hilog 文本,所以真跑与 --check-only 走同一条判定路径。
 * 行号即锚点(证据里可直接跳到该行)。
 */
function report(logFile, opts) {
  const lines = readLines(logFile);
  const checks = [];
  const find = (re, from) => {
    for (let i = from || 0; i < lines.length; i++) { if (re.test(lines[i])) { return { line: i + 1, text: lines[i].trim() }; } }
    return null;
  };
  // pass/fail 计入结论；pending 表示"这条日志不具备判定条件"（如没编辑过就没有写回锚点）；skip 表示该用例在本日志里不适用。
  const add = (id, state, detail, line) => checks.push({ id, state, ok: state !== 'fail', detail, line: line || 0 });

  const route = find(/\[note\.route\] target=(\w+) noteId=(\S+)/);
  const routeTarget = route ? (route.text.match(/target=(\w+)/) || [])[1] : '';
  const routeNoteId = route ? (route.text.match(/noteId=([^"\s]+)/) || [])[1] : '';

  const pages = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\[lexinote\] runtime\.page ([^"\s]+)/);
    if (m) { pages.push({ line: i + 1, url: m[1] }); }
  }
  const legacyPages = pages.filter((p) => /lexinote_plugin_runtime\.html/.test(p.url));
  const containerPages = pages.filter((p) => /lexinote_workspace\.html/.test(p.url));

  // 主路由判定：容器锚点优先；只在旧路由日志上回落到 legacy；ArkUI 编辑器日志单独判 A1。
  const mode = (containerPages.length > 0 || routeTarget === 'container') ? 'container'
    : (routeTarget === 'arkui') ? 'arkui'
      : (legacyPages.length > 0) ? 'legacy' : 'none';

  // ---------------------------------------------------------------- 容器路由（M2-A 新默认）
  if (mode === 'container') {
    add(CONTAINER + ' C0 route decision', route ? 'pass' : 'fail',
      route ? 'target=' + routeTarget + ' noteId=' + routeNoteId : '缺少 [note.route] target=container', route ? route.line : 0);

    const begin = find(/\[web\.page\.begin\] lexinote_workspace\.html/);
    const end = find(/\[web\.page\.end\] lexinote_workspace\.html loaded/);
    add(CONTAINER + ' C1 page loaded', begin && end && containerPages.length > 0 ? 'pass' : 'fail',
      (begin ? 'begin@' + begin.line : '缺少 web.page.begin') + ' / ' + (end ? 'end@' + end.line : '缺少 web.page.end') +
      ' / runtime.page=' + (containerPages.length ? containerPages[0].url : '(缺)'),
      end ? end.line : (begin ? begin.line : 0));

    const loaded = find(new RegExp('LexiPlugin.*插件 onload 完成: ' + SAMPLE), begin ? begin.line : 0);
    add(CONTAINER + ' C2 plugin onload', loaded ? 'pass' : 'fail',
      loaded ? loaded.text.slice(-90) : '容器内缺少 插件 onload 完成: ' + SAMPLE, loaded ? loaded.line : 0);

    const request = find(/\[page\.note\.request\] noteId=(\S+)/, route ? route.line : 0);
    const requestId = request ? (request.text.match(/noteId=([^"\s]+)/) || [])[1] : '';
    const sameId = request !== null && (routeNoteId === '' || requestId === routeNoteId);
    add(CONTAINER + ' C3 note request', sameId ? 'pass' : 'fail',
      request === null ? '缺少 [page.note.request]（容器没读到路由参数）' : 'noteId=' + requestId + (sameId ? '' : ' 与 note.route 的 ' + routeNoteId + ' 不一致'),
      request ? request.line : 0);

    const initial = find(/\[note\.open\.initial\] noteId=(\S+) path=(\S+)/, request ? request.line : 0);
    const pump = find(/\[note\.open\.out\] path=(\S+) chars=(\d+)/, initial ? initial.line : 0);
    const initialPath = initial ? (initial.text.match(/path=([^"\s]+)/) || [])[1] : '';
    add(CONTAINER + ' C4 note pushed', initial && pump ? 'pass' : 'fail',
      (initial ? 'note.open.initial path=' + initialPath + '@' + initial.line : '缺少 note.open.initial') + ' / ' +
      (pump ? 'note.open.out chars=' + (pump.text.match(/chars=(\d+)/) || [])[1] + '@' + pump.line : '缺少 note.open.out'),
      pump ? pump.line : (initial ? initial.line : 0));

    const applied = find(/\[note\.open\.loaded\]/, pump ? pump.line : 0);
    add(CONTAINER + ' C5 editor applied', applied ? 'pass' : 'fail',
      applied ? applied.text.slice(-110) : '缺少 note.open.loaded（CM6 没拿到正文）', applied ? applied.line : 0);

    const failure = find(/onload error|插件源码读取失败: |\[note\.open\.miss\]|\[note\.write\.deny\]/, route ? route.line : 0);
    add(CONTAINER + ' C6 no load failure', failure ? 'fail' : 'pass',
      failure === null ? '装载链路无失败行' : '出现失败: ' + failure.text.slice(-140), failure ? failure.line : 0);

    const sessionToken = sessionTail(lines);
    const tail = sessionToken ? sessionToken.tail : '';
    const tokenOk = sessionToken !== null && tail !== 'none' && tail.length > 0;
    add(CONTAINER + ' C7 session token', tokenOk ? 'pass' : (opts.requireSession ? 'fail' : 'pending'),
      (sessionToken === null ? '缺少 session.token 锚点' : 'tail=' + tail) + (opts.requireSession ? '' : ' [--require-session 才断言]'),
      sessionToken ? sessionToken.line : 0);

    // C8：写回的必须就是 C4/C5 打开的那篇笔记，且这次写回的动机是编辑（reason=edit）。
    // 只看"日志里有过一次 note.write.saved"会把"打开了 A、写回了 B"判成绿，这里要求 path 相等。
    const openPaths = [];
    if (initialPath) { openPaths.push(initialPath); }
    const loadedJson = applied ? parseJsonPayload(applied.text, 'note.open.loaded') : null;
    if (loadedJson !== null && typeof loadedJson.path === 'string' && openPaths.indexOf(loadedJson.path) < 0) {
      openPaths.push(loadedJson.path);
    }
    const writes = [];
    for (let i = applied ? applied.line : 0; i < lines.length; i++) {
      if (lines[i].indexOf('[note.write.saved]') >= 0) {
        writes.push({ line: i + 1, parsed: parseJsonPayload(lines[i], 'note.write.saved') });
      }
    }
    const editWrites = writes.filter((w) => w.parsed !== null && w.parsed.reason === 'edit');
    const firstEdit = editWrites.length > 0 ? editWrites[0] : null;
    const writePath = firstEdit !== null && typeof firstEdit.parsed.path === 'string' ? firstEdit.parsed.path : '';
    const writeChars = firstEdit !== null && firstEdit.parsed.chars !== undefined ? String(firstEdit.parsed.chars) : '?';
    const offPath = editWrites.filter((w) => openPaths.indexOf(String(w.parsed.path)) < 0);
    const onOpenPath = editWrites.length > 0 && offPath.length === 0;
    add(CONTAINER + ' C8 write back',
      writes.length === 0 ? 'pending' : (onOpenPath ? 'pass' : 'fail'),
      writes.length === 0
        ? '本段日志没有一次编辑（写回锚点由验收 2 的注入轮负责）'
        : (editWrites.length === 0
          ? '没有 reason=edit 的写回行（写回动机未证明）'
          : 'path=' + writePath + ' chars=' + writeChars + ' reason=edit' +
            ' / open=' + openPaths.join(',') +
            (onOpenPath ? '' : '  ← 写回 path=[' + offPath.map((w) => String(w.parsed.path)).join(',') + '] 与打开的 [' + openPaths.join(',') + '] 不一致')),
      firstEdit !== null ? firstEdit.line : (writes.length > 0 ? writes[0].line : 0));

    // C9：路由参数里的 noteId 必须就是容器实际装载的 noteId（传错 id 时 C4/C5 仍会绿，这里补上耦合）。
    const initialNoteId = initial ? (initial.text.match(/noteId=([^"\s]+)/) || [])[1] || '' : '';
    const idSame = routeNoteId !== '' && initialNoteId !== '' && routeNoteId === initialNoteId;
    add(CONTAINER + ' C9 note id chain', idSame ? 'pass' : 'fail',
      'route=' + (routeNoteId || '(缺)') + ' / initial=' + (initialNoteId || '(缺)') + (idSame ? '' : '  ← noteId 不一致'),
      initial ? initial.line : (route ? route.line : 0));
  } else {
    add(CONTAINER + ' C0 route decision', 'skip', '本日志不是容器路由（mode=' + mode + '）', 0);
  }

  // ---------------------------------------------------------------- 回退用例 A：旧产品路由（M2-A 之前的产品默认）
  if (mode === 'legacy') {
    const ready = find(new RegExp('LexiPlugin.*插件源码就绪: ' + SAMPLE));
    add(FALLBACK + ' R1 route marker', legacyPages.length ? 'pass' : 'fail',
      legacyPages.length ? 'runtime.page ' + legacyPages[0].url : '缺少 lexinote_plugin_runtime.html 的 runtime.page', legacyPages.length ? legacyPages[0].line : 0);
    add(FALLBACK + ' R2 source ready', ready ? 'pass' : 'fail', ready ? ready.text.slice(-90) : '缺少 插件源码就绪: ' + SAMPLE, ready ? ready.line : 0);

    const loaded = find(new RegExp('LexiPlugin.*插件 onload 完成: ' + SAMPLE));
    add(FALLBACK + ' R3 onload done', loaded ? 'pass' : 'fail', loaded ? loaded.text.slice(-90) : '缺少 插件 onload 完成: ' + SAMPLE, loaded ? loaded.line : 0);

    const failure = find(new RegExp('插件源码读取失败: ' + SAMPLE + '|onload error[^\n]*' + SAMPLE), ready ? ready.line : 0);
    add(FALLBACK + ' R4 no load failure', failure ? 'fail' : 'pass',
      failure === null ? '装载链路无失败行' : '出现失败: ' + failure.text.slice(-140), failure ? failure.line : 0);

    const session = sessionTail(lines);
    const tail = session ? session.tail : '';
    const sessionOk = session !== null && tail !== 'none' && tail.length > 0;
    add(FALLBACK + ' R5 session token', sessionOk ? 'pass' : (opts.requireSession ? 'fail' : 'pending'),
      (session === null ? '缺少 session.token 锚点' : (sessionOk ? 'tail=' + tail : 'tail=none')) + (opts.requireSession ? '' : ' [--require-session 才断言]'),
      session ? session.line : 0);
  } else {
    add(FALLBACK + ' R1 route marker', 'skip', '本日志没有旧产品路由（mode=' + mode + '）；旧证据用 --check-only 复判', 0);
    for (const id of ['R2 source ready', 'R3 onload done', 'R4 no load failure', 'R5 session token']) {
      add(FALLBACK + ' ' + id, 'skip', '同上：仅旧路由日志判定', 0);
    }
  }

  // ---------------------------------------------------------------- 回退用例 B：开关打开 → ArkUI 编辑器
  if (mode === 'arkui') {
    add(FALLBACK_ARKUI + ' A1 route decision', route ? 'pass' : 'fail',
      route ? 'target=arkui noteId=' + routeNoteId + '（开关打开后回归编辑器）' : '缺少 [note.route] target=arkui', route ? route.line : 0);
    const containerHits = find(/\[note\.open\.initial\]/, route ? route.line : 0);
    add(FALLBACK_ARKUI + ' A2 no container', containerHits ? 'fail' : 'pass',
      containerHits ? '开关打开后仍然出现 note.open.initial' : '开关打开后容器没有介入', containerHits ? containerHits.line : 0);
  } else {
    add(FALLBACK_ARKUI + ' A1 route decision', 'skip', '本日志不是 ArkUI 编辑器路由（mode=' + mode + '）', 0);
    add(FALLBACK_ARKUI + ' A2 no container', 'skip', '同上', 0);
  }

  console.log('log: ' + path.relative(REPO, logFile) + ' (' + lines.length + ' lines)');
  console.log('mode: ' + mode);
  for (const c of checks) {
    console.log('  ' + c.state.toUpperCase().padEnd(8) + c.id + ' @ line ' + (c.line || '-') + '  ' + c.detail);
  }
  const ok = checks.every((c) => c.state !== 'fail');
  return { ok, mode, checks, anchors: checks.filter((c) => c.line > 0).map((c) => ({ id: c.id, line: c.line })) };
}

// ---------------------------------------------------------------- live run

function box(bounds) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(bounds || ''));
  if (!m) { return null; }
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], cx: Math.round((+m[1] + +m[3]) / 2), cy: Math.round((+m[2] + +m[4]) / 2) };
}

function walk(node, out) {
  if (!node || typeof node !== 'object') { return out; }
  if (node.attributes) { out.push(node.attributes); }
  for (const c of node.children || []) { walk(c, out); }
  return out;
}

/** 真点列表：dump 布局 → 找笔记行（宽屏有 workspace-note-<id>，窄屏是带 clickable 祖先的标题 Text）→ 点它。 */
function findNoteRow(dir) {
  const tag = 'route-list';
  const remote = '/data/local/tmp/' + tag + '.json';
  const local = path.join(dir, tag + '.json');
  sh(['shell', 'uitest', 'dumpLayout', '-p', remote], 60000);
  sh(['file', 'recv', remote, local], 60000);
  let nodes = [];
  try { nodes = walk(JSON.parse(fs.readFileSync(local, 'utf8')), []); } catch (err) { return null; }
  const byId = nodes.find((a) => /^(workspace-note-|vault-note-|note-row-)/.test(String(a.id || '')) && box(a.bounds));
  if (byId) { const b = box(byId.bounds); return { x: b.cx, y: b.cy, label: byId.id }; }
  const skipText = /^(首页|知识库|关联|我的|搜索|新建|今日笔记|从模板新建|随手记|打开设置|回收站|使用说明|\d+)$/;
  let cursor = null;
  const visit = (node, clickable) => {
    if (cursor || !node || typeof node !== 'object') { return; }
    const a = node.attributes || {};
    const nextClickable = a.clickable === 'true' && box(a.bounds) ? box(a.bounds) : clickable;
    if (a.type === 'Text' && a.text && !skipText.test(String(a.text)) && nextClickable && nextClickable.cy > 500
      && nextClickable.x2 - nextClickable.x1 > 600) {
      cursor = { x: nextClickable.cx, y: nextClickable.cy, label: String(a.text).slice(0, 40) };
      return;
    }
    for (const c of node.children || []) { visit(c, nextClickable); if (cursor) { return; } }
  };
  visit(JSON.parse(fs.readFileSync(local, 'utf8')), null);
  return cursor;
}

async function live(dirOverride, opts) {
  const devices = targets();
  if (devices.length === 0) { console.log('device: none reachable via ' + HDC); process.exit(2); }
  const device = devices[0];
  console.log('device: ' + device);
  if (!fs.existsSync(HAP)) { console.log('hap: missing ' + HAP + ' (run hvigorw assembleHap first)'); process.exit(2); }

  const dir = dirOverride || path.join(OUT_ROOT, stamp() + '-product-route');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'hilog.log');
  console.log('hap: ' + HAP);
  console.log('out: ' + dir);

  sh(['shell', 'power-shell', 'wakeup'], 30000); // 息屏会让后续一切证据失真

  const logFd = fs.openSync(logFile, 'w');
  const logChild = spawn(HDC, ['shell', 'hilog'], { stdio: ['ignore', logFd, logFd] });

  try {
    const install = sh(['install', '-r', HAP], 240000);
    const installed = install.out.indexOf('successfully') >= 0;
    console.log('install: ' + (installed ? 'successfully' : 'FAILED'));
    fs.writeFileSync(path.join(dir, 'install.txt'), install.out);
    if (!installed) { process.exit(1); }

    sh(['shell', 'aa', 'force-stop', BUNDLE], 60000);
    sh(['shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE], 60000);
    console.log('launch: ' + BUNDLE + '/' + ABILITY);
    await sleep(4000); // 让列表渲染出来；随后按 dump 真实坐标点，不用固定坐标硬赌

    const row = findNoteRow(dir);
    if (!row) { throw new Error('uitest dumpLayout 里找不到可点的笔记行（列表没渲染/窗口形态不支持）'); }
    console.log('click: ' + row.label + ' @ ' + row.x + ',' + row.y);
    sh(['shell', 'uitest', 'uiInput', 'click', String(row.x), String(row.y)], 60000);
    fs.writeFileSync(path.join(dir, 'click.json'), JSON.stringify(row, null, 2) + '\n');

    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const text = fs.readFileSync(logFile, 'utf8');
      if (/\[note\.open\.loaded\]/.test(text) || /\[note\.open\.miss\]/.test(text) || /note\.route\] target=arkui/.test(text)) { break; }
      await sleep(1000);
    }
    await sleep(1500); // 收尾:让紧随其后的日志落地
  } finally {
    logChild.kill();
    fs.closeSync(logFd);
  }

  const result = report(logFile, opts);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    device,
    hap: HAP,
    log: path.relative(REPO, logFile),
    capturedAt: new Date().toISOString(),
    mode: result.mode,
    route: result.mode === 'container'
      ? 'container (Index.openNote → workspace/LexiWorkspacePage + WorkspaceBridge.note-open)'
      : result.mode,
    plugin: SAMPLE,
    requireSession: opts.requireSession,
    result: result.ok ? 'pass' : 'fail',
    anchors: result.anchors,
    checks: result.checks.map((c) => ({ id: c.id, state: c.state, line: c.line, detail: c.detail }))
  }, null, 2) + '\n');
  console.log('result: ' + (result.ok ? 'PASS' : 'FAIL'));
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------- entry

function main() {
  const argv = process.argv.slice(2);
  const requireSession = argv.indexOf('--require-session') >= 0;
  const checkOnlyIdx = argv.indexOf('--check-only');
  if (checkOnlyIdx >= 0) {
    const target = argv[checkOnlyIdx + 1];
    if (!target) { console.log('usage: --check-only <evidence dir | hilog file> [--require-session]'); process.exit(1); }
    let logFile = path.resolve(REPO, target);
    if (fs.existsSync(logFile) && fs.statSync(logFile).isDirectory()) {
      const candidates = fs.readdirSync(logFile).filter((name) => /\.log$/.test(name)).sort();
      if (candidates.length === 0) { console.log('no *.log in ' + logFile); process.exit(1); }
      logFile = path.join(logFile, candidates[candidates.length - 1]);
    }
    if (!fs.existsSync(logFile)) { console.log('missing log: ' + logFile); process.exit(1); }
    const result = report(logFile, { requireSession });
    console.log('result: ' + (result.ok ? 'PASS' : 'FAIL') + ' (check-only)');
    process.exit(result.ok ? 0 : 1);
  }
  const outIdx = argv.indexOf('--out');
  live(outIdx >= 0 ? path.resolve(REPO, argv[outIdx + 1]) : null, { requireSession }).catch((err) => {
    console.log('flow error: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
}

main();
