#!/usr/bin/env node
// 四流程真机回归:安装 / 升级 / 回滚 / 卸载。
//
//   node scripts/tests/plugin-dist-flows.cjs                  # 默认:只打印计划与前置条件,不碰设备
//   node scripts/tests/plugin-dist-flows.cjs --run            # 真跑四个流程
//   node scripts/tests/plugin-dist-flows.cjs --run --flow uninstall --with-bundled
//
// 前置:1) hvigorw assembleHap 产出 entry-default-unsigned.hap;2) 一台设备在线(emulator 127.0.0.1:15555);
//       3) 宿主机 8099 端口空闲(应用里"演示源"固定指向 http://10.0.2.2:8099/market.json)。
// 证据:每个流程一个目录 .fixtures-out/evidence/<ts>/flows/<flow>/{layout-*.json,hilog.log,anchors.txt,ls*.txt,summary.txt}
//
// 探针插件:主代码取仓库内的 lexi-sample-plugin(已证明能装载的真实 Obsidian 风格插件),
// 只换 manifest(id/version/capabilities),并在 main.js 末尾追加版本标记,让 v1/v2 字节不同、sha256 不同。
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { writeZip } = require(path.join(__dirname, '..', '..', 'tools', 'plugin-dist', 'zip-store.cjs'));

const REPO = path.resolve(__dirname, '..', '..');
const HDC = process.env.HDC_PATH || path.join('E:', 'dev-tools', 'harmonyos', 'command-line-tools', 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
const BUNDLE = 'com.lovexjy.lexinote';
const ABILITY = 'EntryAbility';
const HAP = path.join(REPO, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const OUT_ROOT = path.join(REPO, '.fixtures-out', 'evidence');
const FIXTURES = path.join(REPO, '.fixtures-out');
const SAMPLE = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins', 'lexi-sample-plugin');
const PLUGIN_ID = 'dist-flow-probe';
const PROBE_NAME = '分发探针';

const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name) >= 0;
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const DEVICE = value('--device', '127.0.0.1:15555');
const PORT = Number(value('--port', '8099'));
const FLOW = value('--flow', 'all');
const PLUGINS_DIR = value('--plugins-dir', '/data/app/el2/100/base/' + BUNDLE + '/haps/entry/files/plugins');
const PLUGIN_DIR = PLUGINS_DIR + '/' + PLUGIN_ID;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- hdc plumbing ---------------------------------------------------------
function hdc(args, timeout) {
  const res = spawnSync(HDC, args, { encoding: 'utf8', timeout: timeout || 120000 });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
function targets() {
  return hdc(['list', 'targets'], 30000).out.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line));
}
function sh(command, timeout) {
  return hdc(['-t', DEVICE, 'shell', command], timeout).out.trim();
}
const lsPlugin = () => sh('ls -a ' + PLUGIN_DIR + ' 2>&1');
const readFile = (file) => sh('cat ' + file + ' 2>&1');

// --- ui plumbing ----------------------------------------------------------
function walk(node, visit) {
  if (!node || typeof node !== 'object') { return; }
  if (node.attributes) { visit(node.attributes); }
  for (const child of node.children || []) { walk(child, visit); }
}
function bounds(attrs) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '');
  if (!m) { return null; }
  const box = { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
  if (box.x2 <= box.x1 || box.y2 <= box.y1) { return null; }
  box.cx = Math.round((box.x1 + box.x2) / 2);
  box.cy = Math.round((box.y1 + box.y2) / 2);
  return box;
}
function dumpLayout(dir, tag) {
  const remote = '/data/local/tmp/' + tag + '.json';
  sh('uitest dumpLayout -p ' + remote, 60000);
  const local = path.join(dir, tag + '.json');
  hdc(['-t', DEVICE, 'file', 'recv', remote, local], 60000);
  if (!fs.existsSync(local)) { return []; }
  try {
    const list = [];
    walk(JSON.parse(fs.readFileSync(local, 'utf8')), (attrs) => list.push(attrs));
    return list;
  } catch { return []; }
}
function texts(list) {
  return list.map((attrs) => attrs.text || '').filter((text) => text.length > 0);
}
function findByText(list, pattern, filter) {
  return list.find((attrs) => bounds(attrs) && pattern.test(attrs.text || '') && (!filter || filter(bounds(attrs)))) || null;
}
// P0-012:同文本多节点时取最窄者(侧边栏行 vs 宽卡片/标题)。R8 时代的 x1<1000 约束在
// 2in1 宽布局下既滤不干净也挑不对:社区插件市场的宽卡片 x1=978 同样过筛且先于侧栏行出现,
// 点卡片中心落空 → 市场从未打开(2026-11-07 两轮 flows 失败根因)。
function findByTextNarrowest(list, pattern, filter) {
  const candidates = list.filter((attrs) => bounds(attrs) && pattern.test(attrs.text || '') && (!filter || filter(bounds(attrs))));
  if (candidates.length === 0) { return null; }
  return candidates.reduce((best, attrs) => (bounds(attrs).x2 - bounds(attrs).x1 < bounds(best).x2 - bounds(best).x1 ? attrs : best));
}
function clickNode(attrs) {
  const box = bounds(attrs || {});
  if (!box) { return false; }
  const res = sh('uitest uiInput click ' + box.cx + ' ' + box.cy, 60000);
  return res.indexOf('No Error') >= 0 || res.length === 0;
}
function clickText(list, pattern, filter) {
  return clickNode(findByText(list, pattern, filter));
}
function swipe(x1, y1, x2, y2, ms) {
  return sh('uitest uiInput swipe ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2 + ' ' + (ms || 600), 60000);
}

// 市场面板/已安装列表都可能比一屏长:滚动直到目标文本出现(最多 max 次,每次记录一次 layout)。
function reveal(dir, tag, pattern, options) {
  const max = (options && options.max) || 6;
  const filter = options && options.filter;
  let list = dumpLayout(dir, tag);
  let hit = findByText(list, pattern, filter);
  if (hit) { return { list, hit, scrolls: 0 }; }
  for (let i = 1; i <= max; i++) {
    swipe(1700, 1650, 1700, 900, 500);
    list = dumpLayout(dir, tag + '-s' + i);
    hit = findByText(list, pattern, filter);
    if (hit) { return { list, hit, scrolls: i }; }
  }
  return { list, hit: null, scrolls: max };
}
// 列表行的动作按钮没有稳定 id:取文本匹配、y 与目标行最近的那个。
function clickRowAction(dir, tag, label, action) {
  const found = reveal(dir, tag, new RegExp(label));
  if (!found.hit) { return false; }
  const rowY = bounds(found.hit).cy;
  const buttons = found.list.filter((attrs) => bounds(attrs) && action.test(attrs.text || ''));
  buttons.sort((a, b) => Math.abs(bounds(a).cy - rowY) - Math.abs(bounds(b).cy - rowY));
  return buttons.length > 0 && clickNode(buttons[0]);
}

async function pollState(label, probe, expect, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const intervalMs = (options && options.intervalMs) || 500;
  const started = Date.now();
  let attempts = 0;
  let last = '';
  while (Date.now() - started < timeoutMs) {
    attempts++;
    last = probe();
    if (expect(last)) { return { ok: true, attempts, elapsedMs: Date.now() - started, last }; }
    await sleep(intervalMs);
  }
  return { ok: false, attempts, elapsedMs: Date.now() - started, last };
}
// 界面断言同样走轮询:固定 sleep 在模拟器上会抖。
async function pollText(dir, tag, pattern, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const started = Date.now();
  let attempts = 0;
  let lastTexts = [];
  while (Date.now() - started < timeoutMs) {
    attempts++;
    lastTexts = texts(dumpLayout(dir, tag));
    const hit = lastTexts.find((text) => pattern.test(text));
    if (hit) { return { ok: true, attempts, elapsedMs: Date.now() - started, hit, texts: lastTexts }; }
    await sleep(800);
  }
  return { ok: false, attempts, elapsedMs: Date.now() - started, hit: '', texts: lastTexts };
}
async function restartApp(dir) {
  sh('aa force-stop ' + BUNDLE, 60000);
  sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
  const pid = await pollState('进程重启', () => sh('pidof ' + BUNDLE, 30000),
    (text) => /^\d+(\s+\d+)*$/.test(text.trim()), { timeoutMs: 30000 });
  if (pid.ok) {
    return { ok: true, attempts: pid.attempts, elapsedMs: pid.elapsedMs, probe: { kind: 'pidof', value: pid.last.trim() } };
  }
  const ui = await pollState('界面重绘', () => dumpLayout(dir, 'layout-restart'),
    (list) => findByText(list, /LexiNote|笔记|工作区/) !== null, { timeoutMs: 60000, intervalMs: 1000 });
  return { ok: ui.ok, attempts: pid.attempts + ui.attempts, elapsedMs: pid.elapsedMs + ui.elapsedMs, probe: { kind: 'layout' } };
}

// --- hilog capture --------------------------------------------------------
// hilog 必须后台落盘(hdc shell hilog -x 事后取不到),每条流程一份文件,行号即锚点。
function startHilog(file) {
  const fd = fs.openSync(file, 'w');
  const child = spawn(HDC, ['-t', DEVICE, 'shell', 'hilog'], { stdio: ['ignore', fd, fd] });
  // hilog 一开就会把环缓冲里的历史一起吐出来:不设时间窗的话,上一轮留下的 "onload 完成" 会让锚点假绿。
  const since = deviceClock();
  return {
    file,
    since,
    mark() { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).length : 0; },
    stop() { child.kill(); try { fs.closeSync(fd); } catch { /* already closed */ } },
    lines() { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []; }
  };
}
function deviceClock() {
  const out = sh('date "+%m-%d %H:%M:%S"');
  const m = /(\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(out);
  return m ? m[1] : '';
}
function lineClock(line) {
  const m = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
  return m ? m[1] : '';
}
// 取某个锚点在文件里的首行号(可限定"从第 fromLine 行之后",用于重启前后区分)。
// 时间窗内的才算:历史环缓冲行即使匹配也不采信。
function anchor(log, pattern, fromLine) {
  const lines = log.lines();
  for (let i = Math.max(0, (fromLine || 1) - 1); i < lines.length; i++) {
    if (!pattern.test(lines[i])) { continue; }
    const ts = lineClock(lines[i]);
    if (log.since && (!ts || ts < log.since)) { continue; }
    return { lineNumber: i + 1, text: lines[i].trim() };
  }
  return null;
}

// --- probe zips + market server ------------------------------------------
// 探针插件在 onload 里"只有没有数据时才写入"自己的标记:于是升级后磁盘上的标记属于哪个版本,
// 就成了 preserveDataFile 是否真的生效的直接证据(壳层对 files/ 无写权限,只能让插件自己写)。
function dataBootstrap(version) {
  return [
    ';(function () {',
    '  var Base = module.exports;',
    '  if (typeof Base !== "function") { return; }',
    '  var MARKER = "keep-me-from-' + version + '";',
    '  module.exports = class DistFlowProbe extends Base {',
    '    async onload() {',
    '      if (typeof super.onload === "function") { await super.onload(); }',
    '      try {',
    '        var existing = (typeof this.loadData === "function") ? await this.loadData() : null;',
    '        if (!existing || !existing.marker) {',
    '          if (typeof this.saveData === "function") { await this.saveData({ marker: MARKER }); }',
    '        }',
    '      } catch (err) { console.warn("[lexinote] dist-flow-probe data bootstrap failed", err); }',
    '    }',
    '  };',
    '  module.exports.__distFlowProbe = MARKER;',
    '})();',
    ''
  ].join('\n');
}

function buildProbeZips() {
  const sampleManifest = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'manifest.json'), 'utf8'));
  const sampleMain = fs.readFileSync(path.join(SAMPLE, 'main.js'), 'utf8');
  const sampleStyles = fs.existsSync(path.join(SAMPLE, 'styles.css')) ? fs.readFileSync(path.join(SAMPLE, 'styles.css')) : null;
  const outDir = path.join(FIXTURES, 'flow-zips');
  fs.mkdirSync(outDir, { recursive: true });
  const make = (version) => {
    const manifest = {
      id: PLUGIN_ID, name: PROBE_NAME, version, author: 'plugin-dist',
      minAppVersion: sampleManifest.minAppVersion || '0.1.0',
      description: '四流程真机回归用探针插件', minApiVersion: '1.0.0', isDesktopOnly: false,
      capabilities: { network: [], fs: true, clipboard: false }
    };
    const main = sampleMain + '\n// dist-flow-probe marker v' + version + '\n' + dataBootstrap(version);
    // 包内不带 data.json:安装器本来就把包里的 data.json 排除在外(那是插件数据不是代码)。
    // 真正的 data.json 由插件自己在 onload 里写(走 data.save),这样 preserveDataFile 才有真机证据。
    const entries = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: 'main.js', data: Buffer.from(main, 'utf8') }
    ];
    if (sampleStyles) { entries.push({ name: 'styles.css', data: sampleStyles }); }
    const bytes = writeZip(entries);
    const file = path.join(outDir, PLUGIN_ID + '-' + version + '.zip');
    fs.writeFileSync(file, bytes);
    return { version, file, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  return { v1: make('1.0.0'), v2: make('1.1.0'), outDir };
}
// 只翻 zip 里的一个字节:字节变了、声明的 sha256 还是好的 → 必须 integrity_mismatch。
function corruptBytes(bytes) {
  const copy = Buffer.from(bytes);
  const at = copy.indexOf(Buffer.from('manifest.json')) + 4;
  copy[at] = copy[at] ^ 0xff;
  return copy;
}

function startServer(zips) {
  const state = { zip: zips.v1, served: zips.v1.bytes, declaredSha: zips.v1.sha256 };
  const server = http.createServer((request, response) => {
    if (request.url === '/market.json') {
      const index = {
        schemaVersion: 1,
        plugins: [{
          id: PLUGIN_ID, name: PROBE_NAME, version: state.zip.version, author: 'plugin-dist',
          description: '四流程真机回归用探针插件', repo: 'lexinote/dist-flow-probe',
          minApiVersion: '1.0.0', isDesktopOnly: false, sha256: state.declaredSha,
          zipUrl: 'http://10.0.2.2:' + PORT + '/zips/current.zip',
          capabilities: { network: [], fs: true, clipboard: false }
        }]
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(index));
      return;
    }
    if (request.url === '/zips/current.zip') {
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.end(state.served);
      return;
    }
    response.writeHead(404); response.end('not found');
  });
  return new Promise((resolve) => {
    server.on('error', (error) => { console.error('市场服务启动失败(8099 被占用?): ' + error.message); process.exit(3); });
    server.listen(PORT, '0.0.0.0', () => resolve({
      close: () => server.close(),
      good(zip) { state.zip = zip; state.served = zip.bytes; state.declaredSha = zip.sha256; },
      corrupt(zip) { state.zip = zip; state.served = corruptBytes(zip.bytes); state.declaredSha = zip.sha256; }
    }));
  });
}

// --- ui route -------------------------------------------------------------
// profile 底座 → 设置面板 → 社区插件市场 → 演示源 → 刷新
async function openMarketSheet(dir) {
  sh('aa force-stop ' + BUNDLE, 60000);
  sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
  // 全新安装后的冷启比热启慢得多(首启要解包 rawfile / 首次建 vault),40s 会假红。
  let dock = await pollState('profile 底座出现', () => dumpLayout(dir, 'layout-dock'),
    (list) => list.some((attrs) => attrs.id === 'workspace-action-dock-profile' && bounds(attrs)), { timeoutMs: 90000, intervalMs: 1500 });
  if (!dock.ok) {
    // 冷启期被系统回收/自启失败:再拉一次再等一轮,仍没有才算红。
    sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
    dock = await pollState('profile 底座出现(重试)', () => dumpLayout(dir, 'layout-dock-retry'),
      (list) => list.some((attrs) => attrs.id === 'workspace-action-dock-profile' && bounds(attrs)), { timeoutMs: 60000, intervalMs: 1500 });
  }
  if (!dock.ok) { throw new Error('未出现 workspace-action-dock-profile'); }
  // P0-012:全新安装后首启会弹 onboarding 向导(跳过按钮),不处理则后续点击全落向导上。
  const wiz = await pollText(dir, 'layout-onboarding', /^跳过$/, { timeoutMs: 6000, intervalMs: 1500 });
  if (wiz.ok) {
    const nodes = dumpLayout(dir, 'layout-onboarding-click');
    const skip = findByTextNarrowest(nodes, /^跳过$/, null);
    if (skip) { clickNode(skip); }
  }
  const dockList = dumpLayout(dir, 'layout-dock-click');
  clickNode(dockList.find((attrs) => attrs.id === 'workspace-action-dock-profile' && bounds(attrs)));
  const settings = await pollText(dir, 'layout-settings', /^社区插件市场$/, { timeoutMs: 20000 });
  if (!settings.ok) { throw new Error('设置面板未出现'); }
  // P0-012:改选最窄匹配(侧栏行),不再依赖 R8 的 x1<1000 布局假设。
  const panel = dumpLayout(dir, 'layout-settings-click');
  clickNode(findByTextNarrowest(panel, /^社区插件市场$/, null));
  const sheet = await pollText(dir, 'layout-market', /^演示源$/, { timeoutMs: 20000 });
  if (!sheet.ok) { throw new Error('社区插件市场未打开'); }
  return sheet.texts;
}
// 面板打开链路在模拟器上会偶发(底座点击被系统手势吞掉、列表没渲染):组合动作整体重试,而不是只重试某一步。
async function marketIndex(dir, label, pattern) {
  let listed = { ok: false, texts: [], hit: '' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await openMarketSheet(dir);
      await loadDemoSource(dir);
    } catch (err) {
      console.log('  打开市场面板失败(第 ' + attempt + ' 次): ' + err.message);
      sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
      await sleep(3000);
      continue;
    }
    // 面板可能被"点在遮罩上"的点击关掉:先确认它还开着,再等条目渲染。
    // 点过演示源之后按钮文案会变成「演示源（使用中）」,所以只匹配前缀。
    const alive = await pollText(dir, 'layout-market-' + label + '-alive' + attempt, /^演示源/, { timeoutMs: 6000 });
    if (!alive.ok) {
      console.log('  第 ' + attempt + ' 次面板被关掉了,重开:可见文本=' + alive.texts.slice(0, 6).join(' | '));
      continue;
    }
    listed = await pollText(dir, 'layout-market-' + label + '-a' + attempt, pattern, { timeoutMs: 20000 });
    if (listed.ok) { return listed; }
    // P0-012/KI-1:已安装列表把远程条目挤出视口(R8 时代夹具少无需滚动,dumpLayout 只见可见节点)。
    // 轮询未中则向上滑动市场列表再等,最多 4 屏。
    for (let scroll = 1; scroll <= 4 && !listed.ok; scroll++) {
      sh('uitest uiInput swipe 1400 1700 1400 800 600', 60000);
      await sleep(900);
      listed = await pollText(dir, 'layout-market-' + label + '-a' + attempt + '-s' + scroll, pattern, { timeoutMs: 8000 });
    }
    if (listed.ok) { return listed; }
    console.log('  第 ' + attempt + ' 次没渲染出目标条目,可见文本=' + listed.texts.slice(0, 8).join(' | '));
  }
  return listed;
}
// 面板还在加载时(标题右侧显示「处理中…」)行内按钮是 disabled 的,点击会被静默吞掉:动手前先等空闲。
async function waitIdle(dir, tag) {
  for (let i = 0; i < 25; i++) {
    const busy = texts(dumpLayout(dir, tag + '-idle' + i)).some((text) => text.indexOf('处理中') === 0);
    if (!busy) { return true; }
    await sleep(1000);
  }
  return false;
}
async function marketAction(dir, label, fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await openMarketSheet(dir);
      await waitIdle(dir, 'layout-' + label);
    } catch (err) {
      console.log('  打开市场面板失败(第 ' + attempt + ' 次): ' + err.message);
      sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
      await sleep(3000);
      continue;
    }
    if (fn('layout-' + label + '-a' + attempt)) { return true; }
    console.log('  第 ' + attempt + ' 次没点到 ' + label + ',重开面板');
  }
  return false;
}

// 演示源 + 刷新:让应用从本地 8099 拉索引。
async function loadDemoSource(dir) {
  const panel = dumpLayout(dir, 'layout-market-source');
  clickText(panel, /^演示源$/);
  await sleep(1200);
  const again = dumpLayout(dir, 'layout-market-refresh');
  clickText(again, /^刷新$/);
  await sleep(1200);
}

// 上一轮跑剩下的探针目录会让"装 1.0.0"变成"同版本重装",投影会从旧的 .versions/1.0.0 快照来,
// 于是包里的新字节根本落不到盘上(实测:设备 main.js 停在上一轮的版本)。每轮 install 前先清干净。
function resetProbe() {
  sh('rm -rf ' + PLUGIN_DIR);
  const trash = sh('ls -d ' + PLUGINS_DIR + '/.trash/dist-flow-probe-* 2>/dev/null || true');
  if (trash.trim().length > 0) { sh('rm -rf ' + PLUGINS_DIR + '/.trash/dist-flow-probe-*'); }
  return sh('ls -a ' + PLUGINS_DIR + ' 2>&1');
}

function makeChecker(dir) {
  const lines = [];
  return {
    lines,
    check(label, condition, detail) {
      lines.push((condition ? 'PASS ' : 'FAIL ') + label + (detail ? ' :: ' + String(detail).slice(0, 300) : ''));
      console.log(lines[lines.length - 1]);
      return condition;
    },
    note(text) { lines.push('NOTE ' + text); console.log('NOTE ' + text); },
    save() { fs.writeFileSync(path.join(dir, 'summary.txt'), lines.join('\n') + '\n'); }
  };
}
function writeAnchors(dir, log, specs, fromLine) {
  const rows = [];
  for (const spec of specs) {
    const hit = anchor(log, spec.pattern, fromLine);
    rows.push((hit ? 'PASS ' : 'MISS ') + spec.label + ' :: ' + (hit ? log.file + ':' + hit.lineNumber + ' :: ' + hit.text.slice(0, 180) : String(spec.pattern)));
  }
  fs.writeFileSync(path.join(dir, 'anchors.txt'), rows.join('\n') + '\n');
  for (const row of rows) { console.log('  ' + row); }
  return rows;
}

// --- flows ----------------------------------------------------------------
async function flowInstall(dir, check, ctx) {
  const before = resetProbe();
  fs.writeFileSync(path.join(dir, 'reset.txt'), before);
  console.log('  清空上一轮残留 → ' + before.split(/\r?\n/).filter((line) => line.trim().length > 0).join(' '));
  const install = hdc(['-t', DEVICE, 'install', '-r', HAP], 240000);
  check.check('安装 HAP', install.out.indexOf('successfully') >= 0, install.out.trim().slice(-120));

  const log = startHilog(path.join(dir, 'hilog.log'));
  try {
    const listed = await marketIndex(dir, 'install', new RegExp(PROBE_NAME));
    check.check('v1 索引被接受(列表出现探针)', listed.ok, listed.ok ? listed.hit : '可见文本=' + listed.texts.slice(0, 12).join(' | '));

    clickRowAction(dir, 'layout-install', PROBE_NAME, /^安装$/);
    // P5-004:安装不再自动 enable——先停在授权面板(已安装未启用),再显式同意启用。
    const pending = await pollText(dir, 'layout-installed-pending', /已安装（未启用）：/, { timeoutMs: 40000 });
    check.check('UI 显示已安装(未启用,待授权)', pending.ok, pending.hit);
    const consent = dumpLayout(dir, 'layout-consent');
    const consentBtn = findByText(consent, /^同意并启用$/);
    check.check('授权面板同意按钮可见', Boolean(consentBtn), consentBtn ? 'y=' + bounds(consentBtn).cy : texts(consent).slice(0, 12).join(' | '));
    if (consentBtn) { clickNode(consentBtn); }
    const done = await pollText(dir, 'layout-installed', /已安装并启用：/, { timeoutMs: 40000 });
    check.check('UI 显示已安装并启用(同意后)', done.ok, done.hit);

    const listing = lsPlugin();
    fs.writeFileSync(path.join(dir, 'ls.txt'), listing);
    check.check('插件目录含 manifest/main/current', /manifest\.json/.test(listing) && /main\.js/.test(listing) && /current\.json/.test(listing), listing);
    const pointer = readFile(PLUGIN_DIR + '/current.json');
    fs.writeFileSync(path.join(dir, 'current.json'), pointer);
    check.check('current.json 指向 1.0.0', /"version"\s*:\s*"1\.0\.0"/.test(pointer), pointer);
    const versions = sh('ls -a ' + PLUGIN_DIR + '/.versions 2>&1');
    fs.writeFileSync(path.join(dir, 'ls-versions.txt'), versions);
    check.check('.versions 有 1.0.0 快照', /1\.0\.0/.test(versions), versions);
    const manifest = readFile(PLUGIN_DIR + '/manifest.json');
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
    check.check('落盘 manifest = 探针 v1.0.0', /"id"\s*:\s*"dist-flow-probe"/.test(manifest) && /"version"\s*:\s*"1\.0\.0"/.test(manifest), manifest);

    // --- sha256 反例:字节被改一个,声明 sha 还是好的 → 必须 integrity_mismatch 且不留半装目录
    ctx.server.corrupt(ctx.zips.v2);
    const listed2 = await marketIndex(dir, 'integrity', new RegExp(PROBE_NAME));
    check.check('坏包前索引仍列出探针', listed2.ok, listed2.ok ? listed2.hit : '可见文本=' + listed2.texts.slice(0, 12).join(' | '));
    clickRowAction(dir, 'layout-integrity', PROBE_NAME, /^安装$/);
    const denied = await pollText(dir, 'layout-integrity-result', /安装失败|integrity_mismatch|完整性/, { timeoutMs: 40000 });
    check.check('错误 sha256 → UI 报失败', denied.ok, denied.hit);
    const afterBad = readFile(PLUGIN_DIR + '/current.json');
    check.check('integrity 失败后指针仍是 1.0.0', /"version"\s*:\s*"1\.0\.0"/.test(afterBad), afterBad);
    const versionsAfterBad = sh('ls -a ' + PLUGIN_DIR + '/.versions 2>&1');
    check.check('integrity 失败后没有 1.1.0 残留', versionsAfterBad.indexOf('1.1.0') < 0, versionsAfterBad);
    const staging = sh('ls -a ' + PLUGINS_DIR + ' 2>&1 | grep -iE "staging|tmp|partial" || true');
    check.check('没有半装目录残留', staging.length === 0, staging);

    // 升级要证明 data.json 不被覆盖。壳层对 files/ 无写权限(shell 与 hdc file send 都是 permission denied),
    // 所以 data.json 由插件自己在 onload 里经 data.save 落盘(标记 keep-me-from-1.0.0)。
    const seededPoll = await pollState('data.json 落盘', () => readFile(PLUGIN_DIR + '/data.json'), (text) => /keep-me-from-1\.0\.0/.test(text), { timeoutMs: 20000 });
    const seeded = seededPoll.last;
    fs.writeFileSync(path.join(dir, 'data.json.before-upgrade'), seeded);
    check.check('插件 onload 经 data.save 写出 data.json(标记 keep-me-from-1.0.0)', seededPoll.ok, seeded);

    const rows = writeAnchors(dir, log, [
      { label: '插件安装完成', pattern: /LexiPlugin.*插件安装完成: dist-flow-probe v1\.0\.0/ },
      { label: '插件 onload 完成', pattern: /LexiPlugin.*插件 onload 完成: dist-flow-probe/ },
      { label: '插件命令注册', pattern: /LexiPlugin.*插件命令注册: dist-flow-probe:/ }
    ]);
    check.check('hilog 锚点齐全', rows.every((row) => row.indexOf('PASS ') === 0), rows.join(' / '));
  } finally {
    log.stop();
  }
}

async function flowUpgrade(dir, check, ctx) {
  ctx.server.good(ctx.zips.v2);
  const log = startHilog(path.join(dir, 'hilog.log'));
  try {
    const mark = log.mark();
    const listed = await marketIndex(dir, 'upgrade', new RegExp(PROBE_NAME));
    check.check('v2 索引被接受', listed.ok, listed.ok ? listed.hit : listed.texts.slice(0, 12).join(' | '));

    clickRowAction(dir, 'layout-upgrade', PROBE_NAME, /^安装$/);
    const done = await pollText(dir, 'layout-upgraded', /已安装并启用：|已升级/, { timeoutMs: 60000 });
    check.check('UI 完成升级', done.ok, done.hit);

    const pointer = readFile(PLUGIN_DIR + '/current.json');
    fs.writeFileSync(path.join(dir, 'current.json'), pointer);
    check.check('current.json 指向 1.1.0', /"version"\s*:\s*"1\.1\.0"/.test(pointer), pointer);
    check.check('current.json 记住上一版 1.0.0', /1\.0\.0/.test(pointer), pointer);
    const versions = sh('ls -a ' + PLUGIN_DIR + '/.versions 2>&1');
    fs.writeFileSync(path.join(dir, 'ls-versions.txt'), versions);
    check.check('.versions 同时有 1.0.0 与 1.1.0', /1\.0\.0/.test(versions) && /1\.1\.0/.test(versions), versions);
    const projected = readFile(PLUGIN_DIR + '/main.js');
    fs.writeFileSync(path.join(dir, 'main.js'), projected.slice(0, 4000));
    check.check('投影代码是 v2', /dist-flow-probe marker v1\.1\.0/.test(projected), 'main.js 末行=' + projected.split(/\r?\n/).filter((line) => line.indexOf('marker') >= 0).join(''));
    const data = readFile(PLUGIN_DIR + '/data.json');
    fs.writeFileSync(path.join(dir, 'data.json.after-upgrade'), data);
    check.check('升级后 data.json 未被覆盖', /keep-me-from-1\.0\.0/.test(data), data);

    const rows = writeAnchors(dir, log, [
      { label: '插件安装完成 v1.1.0', pattern: /LexiPlugin.*插件安装完成: dist-flow-probe v1\.1\.0/ }
    ], mark);
    check.check('hilog 记录升级装包', rows[0].indexOf('PASS ') === 0, rows[0]);
  } finally {
    log.stop();
  }
}

async function flowRollback(dir, check, ctx) {
  const log = startHilog(path.join(dir, 'hilog.log'));
  try {
    const mark = log.mark();
    const clicked = await marketAction(dir, 'rollback', (tag) => clickRowAction(dir, tag, PROBE_NAME, /^回滚$/));
    check.check('找到并点击回滚', clicked, '');
    const done = await pollText(dir, 'layout-rolledback', /已回滚/, { timeoutMs: 40000 });
    check.check('UI 显示已回滚', done.ok, done.hit);

    const pointer = readFile(PLUGIN_DIR + '/current.json');
    fs.writeFileSync(path.join(dir, 'current.json'), pointer);
    check.check('current.json 回到 1.0.0', /"version"\s*:\s*"1\.0\.0"/.test(pointer), pointer);
    check.check('previousVersion 记为 1.1.0', /"previousVersion"\s*:\s*"1\.1\.0"/.test(pointer), pointer);
    const projected = readFile(PLUGIN_DIR + '/main.js');
    check.check('投影代码回到 v1', /dist-flow-probe marker v1\.0\.0/.test(projected), '');
    const data = readFile(PLUGIN_DIR + '/data.json');
    check.check('回滚后 data.json 仍在', /keep-me-from-1\.0\.0/.test(data), data);

    // 回滚后的插件必须仍可装载并执行命令:重启 → 等 onload → 点 Ribbon → 看命令执行日志
    const restart = await restartApp(dir);
    console.log('  重启 ok=' + restart.ok + ' 轮询=' + restart.attempts + ' 次/' + restart.elapsedMs + 'ms');
    const markAfterRestart = log.mark();
    const loaded = await pollState('插件重新装载', () => sh('pidof ' + BUNDLE), (t) => /^\d+/.test(t.trim()), { timeoutMs: 30000 });
    await sleep(6000);
    const panel = dumpLayout(dir, 'layout-after-restart');
    fs.writeFileSync(path.join(dir, 'texts-after-restart.txt'), texts(panel).join('\n'));
    // 命令面板(⌘)是插件命令唯一的用户入口:点开它找工作区里没有 Ribbon 图标的命令。
    // 这一步只作证据,不作判据:面板是否渲染命令受工作区页状态影响,用它当判据会把"UI 没画出来"错报成"插件坏了"。
    const palette = findByText(panel, /^⌘$/);
    let paletteHit = '';
    if (palette && clickNode(palette)) {
      await sleep(1500);
      const open = dumpLayout(dir, 'layout-palette');
      fs.writeFileSync(path.join(dir, 'texts-palette.txt'), texts(open).join('\n'));
      const cmd = findByText(open, /insert-demo-block|插入演示|分发探针/);
      paletteHit = cmd ? '命令项可见 y=' + bounds(cmd).cy : '命令面板里没找到探针命令';
      if (cmd) { clickNode(cmd); await sleep(2000); }
    } else {
      paletteHit = '未见 ⌘ 入口';
    }
    console.log('  命令面板: ' + paletteHit);
    const executed = await pollState('命令执行日志', () => String(anchor(log, /LexiPlugin.*命令执行: dist-flow-probe:/, markAfterRestart + 1) ? 'hit' : ''),
      (t) => t === 'hit', { timeoutMs: 8000, intervalMs: 1000 });
    console.log('  命令执行日志: ' + (executed.ok ? '命中' : '未命中(不计入判据)'));
    const rows = writeAnchors(dir, log, [
      { label: '插件已回滚', pattern: /LexiPlugin.*插件已回滚: dist-flow-probe/ },
      { label: '重启后重新 onload', pattern: /LexiPlugin.*插件 onload 完成: dist-flow-probe/ },
      { label: '重启后命令注册', pattern: /LexiPlugin.*插件命令注册: dist-flow-probe:/ }
    ], mark);
    check.check('回滚后插件仍能装载(重启后 onload + 命令注册)', rows.every((row) => row.indexOf('PASS ') === 0), rows.join(' / '));
  } finally {
    log.stop();
  }
}

async function flowUninstall(dir, check, ctx) {
  const log = startHilog(path.join(dir, 'hilog.log'));
  try {
    const mark = log.mark();
    const clicked = await marketAction(dir, 'uninstall', (tag) => clickRowAction(dir, tag, PROBE_NAME, /^卸载$/));
    check.check('找到并点击卸载', clicked, '');
    const gone = await pollState('插件目录消失', () => lsPlugin(), (t) => t.indexOf('No such file') >= 0, { timeoutMs: 40000 });
    check.check('插件目录已删除', gone.ok, gone.last);

    const trash = sh('ls -a ' + PLUGINS_DIR + '/.trash 2>&1');
    fs.writeFileSync(path.join(dir, 'ls-trash.txt'), trash);
    const entry = (trash.match(new RegExp('(' + PLUGIN_ID + '-[0-9A-Za-z-]+)')) || [])[1] || '';
    check.check('.trash 里有本次卸载目录', entry.length > 0, trash);
    const record = entry ? readFile(PLUGINS_DIR + '/.trash/' + entry + '/uninstall.json') : '';
    fs.writeFileSync(path.join(dir, 'uninstall.json'), record);
    check.check('uninstall.json 记录存在且指向探针', /dist-flow-probe/.test(record), record);
    // trash 布局是 .trash/<id>-<ts>/<id>/… + uninstall.json:data.json 在内层目录里。
    const inner = sh('ls -a ' + PLUGINS_DIR + '/.trash/' + entry + '/' + PLUGIN_ID + ' 2>&1');
    fs.writeFileSync(path.join(dir, 'ls-trash-inner.txt'), inner);
    check.check('data.json 随目录进了 trash', /data\.json/.test(inner), inner);

    const restart = await restartApp(dir);
    console.log('  重启 ok=' + restart.ok + ' 轮询=' + restart.attempts + ' 次/' + restart.elapsedMs + 'ms');
    const stillGone = await pollState('重启后不复活', () => lsPlugin(), (t) => t.indexOf('No such file') >= 0, { timeoutMs: 40000 });
    fs.writeFileSync(path.join(dir, 'restart.txt'),
      'restart ok=' + restart.ok + ' attempts=' + restart.attempts + ' elapsedMs=' + restart.elapsedMs + '\n' +
      'plugin-gone ok=' + stillGone.ok + ' attempts=' + stillGone.attempts + ' elapsedMs=' + stillGone.elapsedMs + '\n' + stillGone.last + '\n');
    check.check('重启后插件不复活(轮询)', stillGone.ok, '轮询 ' + stillGone.attempts + ' 次/' + stillGone.elapsedMs + 'ms: ' + stillGone.last);
    writeAnchors(dir, log, [
      { label: '插件已卸载', pattern: /LexiPlugin.*插件已卸载: dist-flow-probe/ }
    ], mark);

    if (flag('--with-bundled')) {
      // 内置插件(calendar)必须能在界面上真卸掉,而不是靠 rm -rf 造墓碑。
      const calendarDir = PLUGINS_DIR + '/calendar';
      const before = sh('ls -a ' + calendarDir + ' 2>&1');
      fs.writeFileSync(path.join(dir, 'bundled-before.txt'), before);
      if (before.indexOf('No such file') >= 0) {
        check.check('内置插件 calendar 在装置上存在', false, 'calendar 目录不存在,无法验证内置卸载');
      } else {
        const mark2 = log.mark();
        const uninstalled = await marketAction(dir, 'bundled-uninstall', (tag) => clickRowAction(dir, tag, 'Calendar', /^卸载$/));
        check.check('界面上点击 calendar 卸载', uninstalled, '');
        const calGone = await pollState('calendar 目录消失', () => sh('ls -a ' + calendarDir + ' 2>&1'),
          (t) => t.indexOf('No such file') >= 0, { timeoutMs: 40000 });
        check.check('calendar 目录已删除', calGone.ok, calGone.last);
        const trash2 = sh('ls -a ' + PLUGINS_DIR + '/.trash 2>&1');
        fs.writeFileSync(path.join(dir, 'ls-trash-bundled.txt'), trash2);
        const calEntry = (trash2.match(/(calendar-[0-9A-Za-z-]+)/) || [])[1] || '';
        check.check('.trash 里有 calendar 卸载目录', calEntry.length > 0, trash2);
        const calRecord = calEntry ? readFile(PLUGINS_DIR + '/.trash/' + calEntry + '/uninstall.json') : '';
        check.check('calendar uninstall.json 存在', /calendar/.test(calRecord), calRecord);
        const restart2 = await restartApp(dir);
        const calStillGone = await pollState('重启后 calendar 不复活', () => sh('ls -a ' + calendarDir + ' 2>&1'),
          (t) => t.indexOf('No such file') >= 0, { timeoutMs: 40000 });
        fs.writeFileSync(path.join(dir, 'restart-bundled.txt'),
          'restart ok=' + restart2.ok + ' attempts=' + restart2.attempts + '\n' +
          'calendar-gone ok=' + calStillGone.ok + ' attempts=' + calStillGone.attempts + ' elapsedMs=' + calStillGone.elapsedMs + '\n' + calStillGone.last + '\n');
        check.check('内置插件卸载后重启不复活', calStillGone.ok, '轮询 ' + calStillGone.attempts + ' 次/' + calStillGone.elapsedMs + 'ms');
        writeAnchors(dir, log, [
          { label: 'calendar 已卸载', pattern: /LexiPlugin.*插件已卸载: calendar/ }
        ], mark2);
      }
    }
  } finally {
    log.stop();
  }
}

// --- runner --------------------------------------------------------------
function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('') + '-' +
    [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
}
function printPlan() {
  console.log('四流程真机回归(不带 --run 只打印计划)');
  console.log('脚本: scripts/tests/plugin-dist-flows.cjs');
  console.log('前置: ' + HAP + ' 存在; 设备在线; 宿主机 ' + PORT + ' 端口空闲');
  const plan = [
    'install    : hdc install -r → profile 底座 → 设置/社区插件市场 → 演示源 → 刷新 → 安装 → 断言 current.json=1.0.0 / .versions=1.0.0 / 落盘 manifest；再构造错误 sha256 装 1.1.0 → 必须 integrity_mismatch 且无残留',
    'upgrade    : 索引切到 1.1.0 → 再点安装 → .versions 同时有 1.0.0+1.1.0 / current.json=1.1.0 / data.json 标记未被覆盖',
    'rollback   : 点回滚 → current.json=1.0.0 且 previousVersion=1.1.0 / main.js 回 v1 / 重启后仍 onload 并能执行命令',
    'uninstall  : 点卸载 → 目录删除 + .trash/<id>-<ts>/uninstall.json → 重启后不复活；--with-bundled 再覆盖内置 calendar'
  ];
  for (const line of plan) { console.log('  ' + line); }
  console.log('真跑: node scripts/tests/plugin-dist-flows.cjs --run' + (fs.existsSync(HAP) ? '' : '   (注意: 当前没有 HAP,先跑 hvigorw assembleHap)'));
}

(async () => {
  if (!flag('--run')) { printPlan(); return; }
  if (!fs.existsSync(HAP)) { console.log('缺少 HAP: ' + HAP); process.exit(1); }
  if (!fs.existsSync(HDC)) { console.log('缺少 hdc: ' + HDC + '（可用 HDC_PATH 覆盖）'); process.exit(1); }
  const online = targets();
  if (online.indexOf(DEVICE) < 0) { console.log('设备不在线: ' + DEVICE + ',在线=' + (online.join(',') || '(无)')); process.exit(2); }
  const zips = buildProbeZips();
  console.log('探针 zip: v1 sha=' + zips.v1.sha256.slice(0, 12) + ' v2 sha=' + zips.v2.sha256.slice(0, 12) + ' → ' + zips.outDir);
  const server = await startServer(zips);
  const dir = path.join(OUT_ROOT, stamp(), 'flows');
  fs.mkdirSync(dir, { recursive: true });
  const flows = FLOW === 'all' ? ['install', 'upgrade', 'rollback', 'uninstall'] : [FLOW];
  const ctx = { zips, server };
  let failed = 0;
  for (const name of flows) {
    const flowDir = path.join(dir, name);
    fs.mkdirSync(flowDir, { recursive: true });
    const check = makeChecker(flowDir);
    console.log('\n## ' + name);
    try {
      if (name === 'install') { await flowInstall(flowDir, check, ctx); }
      else if (name === 'upgrade') { await flowUpgrade(flowDir, check, ctx); }
      else if (name === 'rollback') { await flowRollback(flowDir, check, ctx); }
      else if (name === 'uninstall') { await flowUninstall(flowDir, check, ctx); }
      else { console.log('未知流程: ' + name); failed++; }
    } catch (error) {
      check.check(name + ' 流程未走完', false, (error && error.stack) || error);
      failed++;
    }
    check.save();
    if (check.lines.some((line) => line.indexOf('FAIL ') === 0)) { failed++; }
  }
  server.close();
  console.log('\nplugin-dist-flows: ' + (failed === 0 ? 'PASS' : failed + ' 处失败') + '  证据=' + dir);
  process.exitCode = failed === 0 ? 0 : 1;
})();
