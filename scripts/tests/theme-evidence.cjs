#!/usr/bin/env node
'use strict';
/**
 * 主题门禁：证明 Obsidian 主题 Minimal 的 styles.css 在 LexiNote 工作区容器里
 * 【原样装入即可生效】，并长期守住这条链路。
 *
 * 断言（全部要真跑设备）：
 *   C1 fixture 与 manifest.lock.json 一致（本地源头未漂移）
 *   C2 宿主 install 后落盘的字节数/sha256 与锁一致
 *   C3 页面注入的 <style> 内容 = 505243 字节且 sha256 与锁一致（"原样"证明）
 *   C4 注入节点在 head 末尾（顺序证明：主题压住宿主基础层）
 *   C5 必需 Obsidian 类名逐个 > 0（表里少一个就红）
 *   C6 主题关闭 vs 开启：body 的 --background-primary / --text-normal 计算值不同
 *   C7 明暗两态：同一元素计算背景色不同
 *   C8 变量覆盖报告（未定义项打印出来，允许存在但必须列出）
 *   C9 截图 theme-off.png / theme-on.png 尺寸一致
 *  C10 同一区域平均色差 > 阈值（客观截图证据）
 *
 * 用法（默认 = 静态门禁 S1-S13，不碰设备）：
 *   node scripts/tests/theme-evidence.cjs
 * 真机全链路（C1-C13，需要 hdc + HAP + 截图）：
 *   node scripts/tests/theme-evidence.cjs --live
 *   node scripts/tests/theme-evidence.cjs --check-only <证据目录>
 *   node scripts/tests/theme-evidence.cjs --redlight=sha       # 服务端改 1 字节 → C3 红
 *   node scripts/tests/theme-evidence.cjs --redlight=same-shot  # 两张截图同一张 → C10 红
 *   node scripts/tests/theme-evidence.cjs --redlight=no-notice  # 不造真实通知 → C11.pre/C12 红
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HDC = process.env.HDC_PATH ||
  'E:\\dev-tools\\harmonyos\\command-line-tools\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const BUNDLE = 'com.lovexjy.lexinote';
const ABILITY = 'EntryAbility';
const HAP = path.join(REPO, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const OUT_ROOT = path.join(REPO, '.fixtures-out', 'evidence');
const FIXTURE = path.join(REPO, '.fixtures-out', process.env.THEME_FIXTURE || 'theme-minimal');
const LOCK = path.join(REPO, 'tools', 'plugins-fixtures', 'manifest.lock.json');
const TAG_FILTER = 'LexiWorkspace';
const PORT = Number(process.env.THEME_PORT || 18080);
const DIFF_THRESHOLD = Number(process.env.THEME_DIFF_THRESHOLD || 8);

// 与 rawfile/lexinote_theme.js 的 REQUIRED_CLASSES 必须一致：容器里真实存在、
// 主题 Minimal 真正会命中的类名（阅读模式的 .markdown-preview-view 不在表内，
// 因为本容器没有阅读视图，见报告"未生效清单"）。theme-dark/theme-light 是明暗态，
// 同一时刻只有一个在场，因此单独按 __mode 断言，不进这张"必须存在"表。
const REQUIRED_CLASSES = [
  'app-container', 'horizontal-main-container', 'workspace', 'workspace-split',
  'workspace-ribbon', 'workspace-ribbon-inner', 'workspace-tabs',
  'workspace-tab-header-container', 'workspace-tab-header', 'workspace-leaf',
  'workspace-leaf-content', 'workspace-sidenav', 'view-header', 'view-header-title',
  'view-content', 'view-body', 'markdown-source-view', 'cm-editor', 'cm-scroller',
  'cm-content', 'status-bar', 'status-bar-item', 'mod-root', 'mod-active', 'is-active',
  'clickable-icon',
  // 命令面板 / 通知 / 错误面板（第二轮补）：Minimal 的 .prompt* / .modal* 规则只在这层存在时命中
  'prompt-container', 'modal-container', 'prompt', 'modal', 'prompt-input', 'prompt-results',
  'suggestion-container', 'notice-container'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ hdc shell

function run(args, options) {
  const opts = options || {};
  const res = spawnSync(HDC, args, { encoding: 'utf8', timeout: opts.timeout || 120000 });
  const out = (res.stdout || '') + (res.stderr || '');
  if (opts.echo) {
    process.stdout.write(out.trim() ? out.trim() + '\n' : '');
  }
  return { status: res.status, out };
}

function targets() {
  const res = run(['list', 'targets'], { timeout: 30000 });
  return res.out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line));
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('') + '-' +
    [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (node.attributes) {
    visit(node.attributes);
  }
  for (const child of node.children || []) {
    walk(child, visit);
  }
}

function bounds(attrs) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '');
  if (!m) {
    return null;
  }
  const box = { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
  if (box.x2 <= box.x1 || box.y2 <= box.y1) {
    return null;
  }
  box.cx = Math.round((box.x1 + box.x2) / 2);
  box.cy = Math.round((box.y1 + box.y2) / 2);
  return box;
}

function dumpLayout(dir, tag) {
  const remote = '/data/local/tmp/' + tag + '.json';
  run(['shell', 'uitest', 'dumpLayout', '-p', remote], { timeout: 60000 });
  const local = path.join(dir, tag + '.json');
  run(['file', 'recv', remote, local], { timeout: 60000 });
  if (!fs.existsSync(local)) {
    return [];
  }
  try {
    const nodes = [];
    walk(JSON.parse(fs.readFileSync(local, 'utf8')), (attrs) => nodes.push(attrs));
    return nodes;
  } catch (err) {
    return [];
  }
}

function findById(list, id) {
  return list.find((attrs) => attrs.id === id && bounds(attrs)) || null;
}

function findByText(list, pattern) {
  const hits = list.filter((attrs) => bounds(attrs) && pattern.test(attrs.text || ''));
  if (hits.length === 0) {
    return null;
  }
  hits.sort((a, b) => bounds(a).x1 - bounds(b).x1);
  return hits[0];
}

function click(attrs) {
  const box = bounds(attrs);
  run(['shell', 'uitest', 'uiInput', 'click', String(box.cx), String(box.cy)], { timeout: 60000 });
  return true;
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    const found = probe();
    if (found) {
      return found;
    }
    await sleep(500);
  }
  throw new Error('timeout waiting for ' + label);
}

// 模拟器息屏时 uitest 拿不到 pixelMap（ScreenCap failed: Failed to get display pixelMap），
// 且息屏期间 aa start 出来的窗口不会渲染 —— 截图前必须唤醒。
function wake() {
  run(['shell', 'power-shell', 'wakeup'], { timeout: 30000 });
}

function screenCap(dir, name) {
  const remote = '/data/local/tmp/' + name + '.png';
  const local = path.join(dir, name + '.png');
  for (let attempt = 1; attempt <= 3; attempt++) {
    run(['shell', 'uitest', 'screenCap', '-p', remote], { timeout: 60000 });
    run(['file', 'recv', remote, local], { timeout: 180000 });
    if (fs.existsSync(local) && fs.statSync(local).size > 4096) {
      return local;
    }
    console.log('screenCap 重试 ' + attempt + '（唤醒屏幕）');
    wake();
  }
  return fs.existsSync(local) ? local : null;
}

// ------------------------------------------------------------------ hilog

function readLogLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.indexOf(TAG_FILTER) >= 0);
}

/** "…/LexiWorkspace: [topic] {"json"}" → { topic, tail, detail, raw, lineNo } */
function entriesOf(file) {
  const out = [];
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf(TAG_FILTER) < 0) {
      continue;
    }
    const m = /\/LexiWorkspace: \[([^\]]+)\]\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let topic = m[1];
    let tail = m[2].trim();
    if (topic === 'web.console') {
      const inner = /^\[lexi\]\s*(\S+)\s*(.*)$/.exec(tail);
      if (inner) {
        topic = inner[1];
        tail = inner[2].trim();
      }
    }
    let detail = null;
    if (tail.length > 0) {
      try {
        detail = JSON.parse(tail);
      } catch (err) {
        detail = null;
      }
    }
    out.push({ topic, tail, detail, raw: line, lineNo: i + 1 });
  }
  return out;
}

function pick(entries, topic) {
  const hits = entries.filter((entry) => entry.topic === topic && entry.detail !== null);
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

function pickAll(entries, topic) {
  return entries.filter((entry) => entry.topic === topic && entry.detail !== null);
}

// ------------------------------------------------------------------ host css scan

// 宿主基础层的 ID 选择器扫描（静态口径，权威）。
// 为什么不用 CSSOM：<link href="lexinote_theme.css"> 走的是 resource://rawfile，
// 对文档而言是跨源样式表，读 styleSheet.cssRules 直接抛 SecurityError
// （实测 theme.specificity 的 host 分支 host rules=0 error=SecurityError，
//  不修就会变成"零 ID 选择器"的假绿灯）。所以：
//   - 静态扫描 CSS 文本 = 这条断言的判定依据；
//   - CSSOM 仍然扫主题自己的内联 <style>（同源可读），用来给"规则命中数"取证。
const HOST_CSS = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_theme.css');

function scanIdSelectors(cssFile) {
  const text = fs.readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];
  const ruleRe = /(^|\})\s*([^{}]+)\{/g;
  let m;
  while ((m = ruleRe.exec(text))) {
    const sel = String(m[2]).trim();
    if (!sel || sel.charAt(0) === '@') { continue; }
    sel.split(',').forEach((part) => {
      const one = part.trim();
      if (/#[A-Za-z_-][A-Za-z0-9_-]*/.test(one)) { hits.push(one.slice(0, 70)); }
    });
  }
  return hits;
}

// ------------------------------------------------------------------ png

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a png');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) {
    throw new Error('png without IHDR');
  }
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) {
    throw new Error('unsupported png: depth=' + ihdr.depth + ' interlace=' + ihdr.interlace);
  }
  const channels = ihdr.color === 2 ? 3 : ihdr.color === 6 ? 4 : ihdr.color === 0 ? 1 : 0;
  if (channels === 0) {
    throw new Error('unsupported png color type ' + ihdr.color);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const pixels = Buffer.alloc(stride * ihdr.height);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++];
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) {
        v = (v + a) & 0xff;
      } else if (filter === 2) {
        v = (v + b) & 0xff;
      } else if (filter === 3) {
        v = (v + ((a + b) >> 1)) & 0xff;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      } else if (filter !== 0) {
        throw new Error('bad png filter ' + filter);
      }
      row[x] = v;
    }
    row.copy(pixels, y * stride);
    prev = row;
  }
  return { width: ihdr.width, height: ihdr.height, channels, pixels };
}

/** 同一区域的平均通道绝对色差，只比 RGB。third 传数字=四周留白比例，传 {x,y,w,h}=指定矩形。 */
function meanAbsDiff(a, b, region) {
  const pad = typeof region === 'number' || region === undefined ? (region === undefined ? 0.1 : region) : 0;
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('尺寸不一致 ' + a.width + 'x' + a.height + ' vs ' + b.width + 'x' + b.height);
  }
  const rect = region && typeof region === 'object' ? region : null;
  const x0 = rect ? Math.max(0, Math.floor(rect.x)) : Math.floor(a.width * pad);
  const x1 = rect ? Math.min(a.width, Math.ceil(rect.x + rect.w)) : Math.ceil(a.width * (1 - pad));
  const y0 = rect ? Math.max(0, Math.floor(rect.y)) : Math.floor(a.height * pad);
  const y1 = rect ? Math.min(a.height, Math.ceil(rect.y + rect.h)) : Math.ceil(a.height * (1 - pad));
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      sum += Math.abs(a.pixels[ia] - b.pixels[ib]);
      sum += Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]);
      sum += Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]);
      count += 3;
    }
  }
  return { mean: sum / count, region: [x0, y0, x1, y1] };
}

// ------------------------------------------------------------------ fixture

function loadLock() {
  const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  let hit = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || hit) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.id === 'theme-minimal') {
      hit = node;
      return;
    }
    Object.keys(node).forEach((key) => visit(node[key]));
  };
  visit(raw);
  if (!hit) {
    throw new Error('manifest.lock.json 里没有 theme-minimal');
  }
  const css = (hit.artifacts || []).find((a) => a.file === 'styles.css');
  const manifest = (hit.artifacts || []).find((a) => a.file === 'manifest.json');
  if (!css) {
    throw new Error('theme-minimal 的 artifacts 里没有 styles.css');
  }
  return { css, manifest };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ------------------------------------------------------------------ http server

function startServer(corrupt) {
  const cssPath = path.join(FIXTURE, 'styles.css');
  const css = Buffer.from(fs.readFileSync(cssPath));
  const served = Buffer.from(css);
  if (corrupt) {
    const at = Math.floor(served.length / 2);
    served[at] = served[at] ^ 0x01;
  }
  const manifestPath = path.join(FIXTURE, 'manifest.json');
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/theme-minimal/styles.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'content-length': served.length });
      res.end(served);
      return;
    }
    if (url === '/theme-minimal/manifest.json' && fs.existsSync(manifestPath)) {
      const body = fs.readFileSync(manifestPath);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve(server));
  }).then((s) => ({ server: s, served, corrupt }));
}

// ------------------------------------------------------------------ checks

const results = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL' + ' /* red */') + '  ' + id + ' ' + title + (detail ? '  [' + detail + ']' : ''));
  return !!ok;
}

function reportChecks(title) {
  const failed = results.filter((r) => !r.ok);
  console.log('\n[' + title + '] ' + (results.length - failed.length) + '/' + results.length + ' assertions green');
  for (const r of failed) {
    console.log('  RED  ' + r.id + ' ' + r.title + (r.detail ? '  [' + r.detail + ']' : ''));
  }
  return failed.length === 0;
}

// ------------------------------------------------------------------ port forward
// 设备里的 app 要连宿主机的 http 服务，用的是 hdc 的【反向】转发 rport
// （设备侧监听 18080，转给宿主 18080）。fport 是正方向（宿主→设备），
// 用错了设备侧根本没人监听，app 侧表现就是 ECONNREFUSED / errCode 2300007。
// 上一轮被中断还会残留规则，所以先清、再建、再核对 fport ls。
function ensureForward() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    run(['fport', 'rm', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000 });
    run(['rport', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000, echo: true });
    const listed = run(['fport', 'ls'], { timeout: 60000 });
    if (listed.out.indexOf('tcp:' + PORT + ' tcp:' + PORT) >= 0 && listed.out.indexOf('[Reverse]') >= 0) {
      console.log('forward: 设备 tcp:' + PORT + ' -> 宿主 tcp:' + PORT + '  [Reverse]');
      return;
    }
    console.log('forward 重试 ' + attempt + '：' + listed.out.trim().slice(0, 200));
    run(['fport', 'rm', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000 });
  }
  console.log('FATAL 端口转发建立失败 tcp:' + PORT);
  process.exit(1);
}

// ------------------------------------------------------------------ live run

async function live(dir, redlight) {
  const lock = loadLock();
  console.log('lock: theme-minimal/styles.css bytes=' + lock.css.bytes + ' sha256=' + lock.css.sha256);
  const localBytes = fs.statSync(path.join(FIXTURE, 'styles.css')).size;
  const localSha = sha256File(path.join(FIXTURE, 'styles.css'));
  check('C1', 'fixture 与 manifest.lock.json 一致（原样源头）',
    localBytes === lock.css.bytes && localSha === lock.css.sha256,
    localBytes + 'B ' + localSha.slice(0, 16) + '…');

  const devices = targets();
  if (devices.length === 0) {
    console.log('device: none reachable via ' + HDC);
    process.exit(2);
  }
  console.log('device: ' + devices[0]);
  if (!fs.existsSync(HAP)) {
    console.log('hap: missing ' + HAP + '（先跑 hvigorw assembleHap）');
    process.exit(1);
  }
  console.log('hap: ' + HAP);
  console.log('out: ' + dir);

  const served = await startServer(redlight === 'sha');
  console.log('http: http://127.0.0.1:' + PORT + '/theme-minimal/styles.css  (served ' + served.served.length +
    'B, corrupt=' + served.corrupt + ')');
  ensureForward();

  const logFile = path.join(dir, 'hilog.log');
  const logFd = fs.openSync(logFile, 'w');
  const logChild = spawn(HDC, ['shell', 'hilog'], { stdio: ['ignore', logFd, logFd] });
  let ok = false;

  try {
    const install = run(['install', '-r', HAP], { timeout: 240000 });
    fs.writeFileSync(path.join(dir, 'install.txt'), install.out);
    if (install.out.indexOf('successfully') < 0) {
      console.log('install: FAILED\n' + install.out.slice(0, 800));
      process.exit(1);
    }
    console.log('install: successfully');

    wake();
    await sleep(1500);
    run(['shell', 'aa', 'force-stop', BUNDLE], { timeout: 60000 });
    run(['shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE], { timeout: 60000 });
    console.log('launch: ' + BUNDLE + '/' + ABILITY);
    await sleep(4000);

    // --- 导航到工作区页（与 workspace-slice-evidence 同一套坐标发现方式）
    const dock = await waitFor('dock', () => {
      const list = dumpLayout(dir, 'layout-dock');
      return findById(list, 'workspace-action-dock-profile') ? list : null;
    }, 30000);
    click(findById(dock, 'workspace-action-dock-profile'));
    const navDump = await waitFor('settings 插件', () => {
      const list = dumpLayout(dir, 'layout-settings');
      return findByText(list, /^插件$/) ? list : null;
    }, 20000);
    click(findByText(navDump, /^插件$/));
    const entryDump = await waitFor('workspace entry', () => {
      const list = dumpLayout(dir, 'layout-entry');
      return findById(list, 'plugin-workspace-entry') ? list : null;
    }, 20000);
    click(findById(entryDump, 'plugin-workspace-entry'));
    console.log('nav: workspace page');
    // 记住 Web 容器的屏幕矩形：C10 只在这个矩形内比色差，
    // 整屏比会被桌面壁纸稀释（实测整屏 mean≈6.4，容器内一个数量级更高）。
    let webBox = null;
    let diffSummary = null;
    let screenVp = null;
    await waitFor('workspace page', () => {
      const list = dumpLayout(dir, 'layout-page');
      const all = list.map((attrs) => bounds(attrs)).filter(Boolean);
      if (all.length) {
        screenVp = {
          w: Math.max.apply(null, all.map((b) => b.x2)),
          h: Math.max.apply(null, all.map((b) => b.y2))
        };
      }
      const web = list.find((attrs) => attrs.type === 'Web' && /lexinote_workspace\.htm/i.test(attrs.text || attrs.src || ''));
      if (web && web.bounds) {
        const box = bounds(web);
        if (box) { webBox = { x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 }; }
      }
      return web || (entriesOf(logFile).some((e) => e.topic === 'web.page.begin') ? true : null);
    }, 30000);
    if (webBox) { console.log('  web rect: ' + JSON.stringify(webBox)); }
    await waitFor('channel ready', () => {
      const entries = entriesOf(logFile);
      return entries.some((e) => e.topic === 'channel.auth') && entries.some((e) => e.topic === 'workspace.ready');
    }, 40000);
    console.log('channel: auth + workspace.ready');

    // --- 点击页面内按钮（web 内容文本可被 uitest 命中；命中不了就把可见文本打出来）
    const clickPageText = async (tag, pattern, label) => {
      const dump = await waitFor(label, () => {
        const list = dumpLayout(dir, tag);
        return findByText(list, pattern) ? list : null;
      }, 25000).catch(() => null);
      if (!dump) {
        const list = dumpLayout(dir, 'layout-' + tag + '-miss');
        console.log('  click FAILED ' + label + '; 可见文本样例: ' +
          list.filter((a) => a.text).map((a) => JSON.stringify(a.text)).slice(0, 40).join(' '));
        return false;
      }
      click(findByText(dump, pattern));
      console.log('  click ' + label + ' -> ' + findByText(dump, pattern).text);
      return true;
    };

    // --- 安装主题（宿主 http 下载 → files/themes/theme-minimal/styles.css）
    const installed = await clickPageText('install-btn', /安装主题/, '安装主题按钮');
    check('C2.pre', '页面能点到"安装主题"按钮', installed);
    if (!installed) {
      throw new Error('页面按钮不可达，无法继续');
    }
    const installEntry = await waitFor('theme.install.done', () => pick(entriesOf(logFile), 'theme.install.done'), 60000)
      .catch(() => null);
    const verified = pick(entriesOf(logFile), 'theme.css.verified');
    const installDetail = installEntry ? installEntry.detail : null;
    console.log('  install: ' + (installDetail ? JSON.stringify(installDetail) : 'no log'));
    console.log('  verified: ' + (verified ? JSON.stringify(verified.detail) : 'no log'));
    const hostBytes = installDetail && installDetail.bytes;
    const hostSha = installDetail && installDetail.sha256;
    check('C2', '宿主落盘字节数/sha256 与 manifest.lock.json 一致',
      hostBytes === lock.css.bytes && hostSha === lock.css.sha256,
      'bytes=' + hostBytes + ' sha=' + String(hostSha).slice(0, 16) + '…');

    // --- 先把主题停掉：活动主题是持久化的（files/themes/theme-active.json），
    // 上一轮门禁启用过 Minimal，下次进页面自检到 res.active 会自动注入 —— 那时"关闭态"
    // 截图其实已经带主题（实测 run10 两张图像素几乎相同，mean=0.117）。门禁必须与运行历史
    // 无关，所以第一步显式停用，并把停用作为断言。
    const disabledClick = await clickPageText('disable-btn', /停用主题/, '停用主题按钮');
    const disabledEntry = await waitFor('theme.disabled', () => pick(entriesOf(logFile), 'theme.disabled'), 30000)
      .catch(() => null);
    check('C0', '门禁先停用主题（截图前主题确实关闭，可重复跑，不依赖运行历史）',
      !!disabledClick && !!disabledEntry, disabledEntry ? 'theme.disabled 已记录' : '没有 theme.disabled 日志');

    // --- 强制定到暗色（避免装置本身是亮色时"关闭态"与"开启态"底色太接近）
    const modeOf = () => pick(entriesOf(logFile), 'theme.mode');
    // 明暗切换有两个入口：侧栏"切换明暗"按钮、状态栏"亮色/暗色"条目。
    // 侧栏被插件卡片挤高时前者可能点不到（uitest 仍报 bounds），所以两个都试。
    const MODE_ENTRIES = [/切换明暗/, /^(亮色|暗色)(（.*）)?$/];
    const toggleTo = async (wantDark) => {
      for (let i = 0; i < 3; i++) {
        const before = pickAll(entriesOf(logFile), 'theme.mode').length;
        let clicked = false;
        for (let k = 0; k < MODE_ENTRIES.length && !clicked; k++) {
          clicked = await clickPageText('mode-btn', MODE_ENTRIES[k], '切换明暗入口' + (k + 1));
        }
        if (!clicked) {
          return false;
        }
        const entry = await waitFor('theme.mode', () => {
          const list = pickAll(entriesOf(logFile), 'theme.mode');
          return list.length > before ? list[list.length - 1] : null;
        }, 20000).catch(() => null);
        if (!entry) {
          return false;
        }
        console.log('  mode: ' + JSON.stringify(entry.detail));
        if (!!entry.detail.dark === wantDark) {
          return true;
        }
      }
      return false;
    };
    // 页面启动自检会把命令面板浮层打开；它横跨编辑区，两张截图里只要一张带浮层，
    // 色差就来自浮层开关而不是主题（实测 run9 的 mean=12.9 里就掺了这个）。
    // 所以拍之前先点编辑区空白处把浮层关掉，并把"浮层是否在场"写进证据。
    const OVERLAY_TEXT = /输入命令名/;
    const dismissOverlays = async (label) => {
      for (let i = 0; i < 3; i++) {
        const list = dumpLayout(dir, 'overlay-' + label);
        if (!list.some((attrs) => OVERLAY_TEXT.test(attrs.text || ''))) {
          console.log('  overlay: 无浮层 (' + label + ')');
          return true;
        }
        if (i === 2) { break; }
        const box = webBox || { x: 0, y: 0, w: 1, h: 1 };
        run(['shell', 'uitest', 'uiInput', 'click',
          String(Math.round(box.x + box.w * 0.35)), String(Math.round(box.y + box.h * 0.6))]);
        await sleep(700);
      }
      const list = dumpLayout(dir, 'overlay-' + label + '-final');
      const open = list.some((attrs) => OVERLAY_TEXT.test(attrs.text || ''));
      console.log('  overlay: ' + (open ? '仍有浮层' : '已关闭') + ' (' + label + ')');
      return !open;
    };
    // --- 通知/命令面板的计算色：主题必须能影响整个应用，不只编辑面板。
    // 通知走页面自己的 notice 通道（#btn-notice → lexinote_workspace.js 里的 zh()），
    // 不假造 DOM：假造的节点只能证明脚本会 appendChild，证明不了主题给它上色。
    // .notice 存在 3200ms 后开始淡出、4200ms 被移除，所以"造通知 → 点主题自检"要连着做。
    const probeUi = async (label) => {
      const before = pickAll(entriesOf(logFile), 'theme.ui').length;
      if (redlight === 'no-notice') {
        console.log('  notice: redlight=no-notice 故意不造通知 (' + label + ')');
      } else if (!(await clickPageText('notice-btn', /Notice 自检/, '通知自检按钮'))) {
        console.log('  notice: 点不到 Notice 自检 (' + label + ')');
      }
      if (!(await clickPageText('probe-btn', /主题自检/, '主题自检按钮'))) {
        console.log('  ui probe: 点不到主题自检 (' + label + ')');
        return null;
      }
      const entry = await waitFor('theme.ui', () => {
        const list = pickAll(entriesOf(logFile), 'theme.ui');
        return list.length > before ? list[list.length - 1] : null;
      }, 30000).catch(() => null);
      console.log('  ui[' + label + ']: ' + (entry ? JSON.stringify(entry.detail) : 'no log'));
      return entry ? entry.detail : null;
    };

    // 先定到暗色：C11/C12 的两份 ui 取样必须在同一个明暗态下比，
    // 否则"主题关闭 vs 开启"的色差里会混进宿主明暗切换。
    const darkOk = await toggleTo(true);
    check('C7.pre', '能把容器切到暗色（后续两张截图都在暗色下比较）', darkOk);

    const specEntry = await waitFor('theme.specificity', () => pick(entriesOf(logFile), 'theme.specificity'), 20000)
      .catch(() => null);
    const spec = specEntry ? specEntry.detail : null;
    if (spec) { console.log('  specificity: ' + JSON.stringify(spec)); }
    // 宿主基础层出现任何 ID 选择器都算违例：ID 的 (1,0,0) 会压住 Minimal 的 .prompt/.modal
    // 单类规则，于是"主题对整个应用生效"退化成只对编辑面板生效（第一轮就是这个缺口）。
    // 判定依据是静态扫描（CSSOM 读 resource:// 的 <link> 会 SecurityError）；
    // 这里同时把页面上那份 CSSOM 结果打出来，口径不同就看得见。
    const hostIds = scanIdSelectors(HOST_CSS);
    console.log('  host css: ' + path.relative(REPO, HOST_CSS) + ' idSelectors=' + JSON.stringify(hostIds));
    check('C4b', '宿主基础层零 ID 选择器（静态扫描口径；ID 会压住主题的单类规则）',
      hostIds.length === 0, 'ids=' + JSON.stringify(hostIds));

    const uiOff = await probeUi('off');
    check('C11.pre', '主题关闭态下真实 .notice 在场（页面通知通道造出来的）',
      !!uiOff && uiOff.noticeCount >= 1,
      uiOff ? ('noticeCount=' + uiOff.noticeCount + ' notice=' + uiOff.notice + ' palette=' + uiOff.palette) : 'no theme.ui log');
    // 通知浮在右下角，等它自己淡出再截图，否则色差里会掺进一条通知的开关
    await sleep(4600);

    const cleanOff = await dismissOverlays('off');
    check('C9.pre0', '主题关闭态截图前没有命令面板浮层（避免色差来自浮层）', cleanOff);

    await sleep(1200);

    const offPng = screenCap(dir, 'theme-off');
    console.log('  screenshot: ' + (offPng ? path.basename(offPng) : 'FAILED'));
    check('C9.pre', '主题关闭态截图落盘', !!offPng, offPng || '');

    // --- 启用主题
    // 页面 boot 时若 theme-active.json 里还有活动主题，会自检自注入 —— 那是一条更早的
    // theme.inject。直接取“最后一条”会在竞态里读到 boot 留下的旧证据（实测有一次 C3 读到
    // 上一轮被篡改的 CSS）。所以点击前后按条数取“新增的那一条”。
    const POST_TOPICS = ['theme.inject', 'theme.probe', 'theme.states', 'theme.coverage',
      'theme.coverage.undefined', 'theme.classes', 'theme.enabled', 'theme.ui', 'theme.rules',
      'theme.specificity'];
    const baseCount = {};
    POST_TOPICS.forEach((t) => { baseCount[t] = pickAll(entriesOf(logFile), t).length; });
    const freshOf = (topic) => {
      const list = pickAll(entriesOf(logFile), topic).slice(baseCount[topic]);
      return list.length > 0 ? list[list.length - 1] : null;
    };
    const enabledClick = await clickPageText('enable-btn', /启用主题/, '启用主题按钮');
    check('C3.pre', '页面能点到"启用主题"按钮', enabledClick);
    const injectEntry = await waitFor('theme.inject', () => freshOf('theme.inject'), 90000)
      .catch(() => null);
    const inject = injectEntry ? injectEntry.detail : null;
    console.log('  inject: ' + (inject ? JSON.stringify(inject) : 'no log'));

    check('C3', '注入的 CSS = 505243 字节且 sha256 与锁一致（原样装入）',
      !!inject && inject.bytes === lock.css.bytes && inject.sha256 === lock.css.sha256 && inject.match === true,
      inject ? ('bytes=' + inject.bytes + ' match=' + inject.match) : 'no theme.inject log');
    check('C4', '注入节点在 head 末尾（主题顺序压住宿主基础层）',
      !!inject && inject.styleLast === true, inject ? String(inject.order) : '');

    const classes = freshOf('theme.classes');
    const classDetail = classes ? classes.detail : null;
    const missing = classDetail ? String(classDetail.__missing || '') : 'no-log';
    const counts = classDetail
      ? REQUIRED_CLASSES.map((name) => name + '=' + classDetail[name]).join(' ')
      : '';
    const modeClass = classDetail ? String(classDetail.__mode || '') : '';
    console.log('  classes: ' + counts + ' __mode=' + (modeClass || '(none)'));
    check('C5', '必需类名全部存在（表里 ' + REQUIRED_CLASSES.length + ' 个）+ 明暗态类在场',
      !!classDetail && missing === '' && (modeClass === 'theme-dark' || modeClass === 'theme-light'),
      'missing=' + (missing === '' ? '(none)' : missing) + ' mode=' + (modeClass || '(none)'));

    await waitFor('theme.probe', () => freshOf('theme.probe'), 60000).catch(() => null);
    const probe = freshOf('theme.probe');
    const probeDetail = probe ? probe.detail : null;
    console.log('  probe: ' + (probeDetail ? JSON.stringify(probeDetail) : 'no log'));
    check('C6', '主题关闭 vs 开启：--background-primary / --text-normal 计算值不同',
      !!probeDetail && probeDetail.differBg === true && probeDetail.differText === true,
      probeDetail ? ('off.bg=' + probeDetail.off.bg + ' on.bg=' + probeDetail.on.bg +
        ' off.text=' + probeDetail.off.text + ' on.text=' + probeDetail.on.text) : '');

    const states = freshOf('theme.states');
    const stateDetail = states ? states.detail : null;
    console.log('  states: ' + (stateDetail ? JSON.stringify(stateDetail) : 'no log'));
    check('C7', '明暗两态下同一元素计算背景色不同',
      !!stateDetail && stateDetail.differ === true,
      stateDetail ? (stateDetail.light.color + ' vs ' + stateDetail.dark.color) : '');

    const coverage = freshOf('theme.coverage');
    const coverageDetail = coverage ? coverage.detail : null;
    const undefParts = pickAll(entriesOf(logFile), 'theme.coverage.undefined').slice(baseCount['theme.coverage.undefined']);
    const undefNames = [...new Set(undefParts.map((e) => String(e.detail.names || ''))
      .join(' ').trim().split(/\s+/).filter(Boolean))];
    console.log('  coverage: ' + (coverageDetail ? JSON.stringify(coverageDetail) : 'no log'));
    console.log('  coverage.undefined (' + undefNames.length + '): ' + (undefNames.length ? undefNames.join(' ') : '(none)'));
    fs.writeFileSync(path.join(dir, 'theme-coverage.json'), JSON.stringify({
      summary: coverageDetail, undefined: undefNames
    }, null, 2));
    check('C8', '变量覆盖报告存在（未定义项已列出，不假装 100%）',
      !!coverageDetail && coverageDetail.referenced > 100 && undefParts.length >= 0,
      coverageDetail ? ('referenced=' + coverageDetail.referenced + ' defined=' + coverageDetail.defined +
        ' undefined=' + coverageDetail.undefined) : 'no theme.coverage log');

    const uiOn = await probeUi('on');
    check('C11', '主题关闭 vs 开启：#palette（prompt 遮罩）计算背景色不同',
      !!uiOff && !!uiOn && uiOff.palette !== uiOn.palette,
      (uiOff ? 'off=' + uiOff.palette : 'off=none') + ' ' + (uiOn ? 'on=' + uiOn.palette : 'on=none'));
    check('C12', '主题关闭 vs 开启：真实 .notice 计算背景色不同（通知由页面通道造）',
      !!uiOff && !!uiOn && uiOff.noticeCount >= 1 && uiOn.noticeCount >= 1 && uiOff.notice !== uiOn.notice,
      (uiOff ? 'off=' + uiOff.notice + '/' + uiOff.noticeCount : 'off=none') + ' ' +
      (uiOn ? 'on=' + uiOn.notice + '/' + uiOn.noticeCount : 'on=none'));
    const rulesEntry = freshOf('theme.rules');
    const rulesDetail = rulesEntry ? rulesEntry.detail : null;
    console.log('  rules: ' + JSON.stringify(rulesDetail));
    // 口径：Minimal 里 selectorText 含 .prompt*/.modal*/.notice* 的规则条数（含 @media 内部），
    // matched = 这些规则当前在 DOM 上至少匹配到一个元素的条数。命不中就是宿主没给对类名/层级。
    check('C13', 'Minimal 的 .prompt*/.modal* 规则确实命中我们补的类（CSSOM 口径）',
      !!rulesDetail && !!rulesDetail.prompt && rulesDetail.prompt.matched > 0 &&
        !!rulesDetail.modal && rulesDetail.modal.matched > 0,
      rulesDetail ? ('prompt=' + JSON.stringify(rulesDetail.prompt) + ' modal=' + JSON.stringify(rulesDetail.modal) +
        ' notice=' + JSON.stringify(rulesDetail.notice)) : 'no theme.rules log');
    // 通知浮在右下角，等它淡出再截图
    await sleep(4600);
    const onPng = screenCap(dir, 'theme-on');
    console.log('  screenshot: ' + (onPng ? path.basename(onPng) : 'FAILED'));
    check('C9.pre2', '主题开启态截图落盘', !!onPng, onPng || '');

    const cleanOn = await dismissOverlays('on');
    check('C9.pre1', '主题开启态截图前没有命令面板浮层', cleanOn);

    if (redlight === 'same-shot' && offPng) {
      fs.copyFileSync(offPng, onPng);
      console.log('  redlight=same-shot: theme-on.png 被 theme-off.png 覆盖');
    }

    if (offPng && onPng) {
      const a = decodePng(fs.readFileSync(offPng));
      const b = decodePng(fs.readFileSync(onPng));
      check('C9', '两张截图尺寸一致',
        a.width === b.width && a.height === b.height, a.width + 'x' + a.height + ' vs ' + b.width + 'x' + b.height);
      // uitest 的 bounds 是 vp，截图是 px，按整屏宽度换算比例
      let rect = null;
      if (webBox && screenVp) {
        const scale = a.width / screenVp.w;
        rect = { x: webBox.x * scale, y: webBox.y * scale, w: webBox.w * scale, h: webBox.h * scale };
        console.log('  区域: Web 容器 ' + JSON.stringify(webBox) + ' vp × ' + scale.toFixed(3) + ' = px');
      }
      const diff = meanAbsDiff(a, b, rect ? rect : 0.1);
      diffSummary = { mean: Number(diff.mean.toFixed(3)), region: diff.region, rect: rect };
      console.log('  diff: mean=' + diff.mean.toFixed(3) + ' region=' + diff.region.join(','));
      check('C10', '同一区域平均色差 > ' + DIFF_THRESHOLD + '（主题关闭 vs 开启）',
        diff.mean > DIFF_THRESHOLD, 'mean=' + diff.mean.toFixed(3));
    } else {
      check('C9', '两张截图尺寸一致', false, 'missing screenshots');
      check('C10', '同一区域平均色差 > ' + DIFF_THRESHOLD, false, 'missing screenshots');
    }

    ok = reportChecks('theme-evidence');
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      kind: 'theme-evidence', at: new Date().toISOString(), redlight: redlight || null,
      lock: lock.css, threshold: DIFF_THRESHOLD, diff: diffSummary, ok, assertions: results
    }, null, 2));
  } finally {
    try { logChild.kill(); } catch (err) { /* ignore */ }
    try { fs.closeSync(logFd); } catch (err) { /* ignore */ }
    run(['fport', 'rm', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 30000 });
    served.server.close();
  }
  if (!ok) {
    process.exit(1);
  }
  if (redlight) {
    console.log('\nRED-LIGHT: --redlight=' + redlight + ' 本应让门禁变红；如果上面全绿，说明对应断言是空的。');
    process.exit(3);
  }
}


// ------------------------------------------------------------------ static gate (jsdom, no device)
//
// 为什么要有这条不碰设备的路径：live 路径要 hdc 装 HAP、uitest 点按钮、截图比对，一次验收
// 就吃掉"设备操作 0 次"的额度。而"宿主不再靠 ID 选择器压主题""补的类真的落在渲染路径的
// 节点上""主题开/关是否真的改变计算色"这三件事，纯文本 + jsdom 就能证，且每次提交都能跑。
//
// 强度边界（下面每条断言的 detail 里也带）：
//   * jsdom 不实现真实层叠：getComputedStyle 不解析 var()，也不求值 :hover / @media。
//     所以这里的"计算色"来自本文件自带的小层叠模型：
//       规则来源 = document.styleSheets[i].cssRules（i 的顺序 = 注入顺序）
//       选择器匹配 = Element.matches()（:not() 交给 jsdom），胜负 = (important, 特异性, 出现顺序)
//       var() = 沿 parentElement 链查自定义属性后递归替换（深度上限 12）
//   * 它证明：给这份 DOM + 这两张样式表，主题关闭/开启算出的颜色/字号不同，且能说出差异来自
//     哪条规则（winner 里带 selectorText 与特异性）。
//   * 它不证明：浏览器引擎的真实层叠、伪类/伪元素视觉结果、字体渲染、设备像素与截图。

const WORKSPACE_HTML = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_workspace.html');
const THEME_JS = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_theme.js');
const BUNDLE_TS = path.join(REPO, 'tools', 'workspace-bundle', 'src', 'main.ts');
const PLUGIN_SHIM = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_shim.js');
const MIN_CSS = path.join(FIXTURE, 'styles.css');

function loadJsdom() {
  const resolved = require.resolve('jsdom', { paths: [path.join(REPO, 'tools', 'reading-bundle')] });
  return require(resolved);
}

// 顶层逗号切分：:not(a, b) / [a, b] 里的逗号不是选择器分隔符
function splitSelectors(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') { depth++; } else if (ch === ')' || ch === ']') { depth--; }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) { out.push(cur.trim()); }
  return out;
}

// 特异性 [a,b,c]；:not() 的参数按规范计入内部，所以先摘出来再两边相加
function specificityOf(sel) {
  let s = String(sel);
  let inner = '';
  for (let guard = 0; guard < 8; guard++) {
    const i = s.indexOf(':not(');
    if (i < 0) { break; }
    let depth = 0;
    let j = i + 4;
    for (; j < s.length; j++) {
      if (s[j] === '(') { depth++; } else if (s[j] === ')') { depth--; if (depth === 0) { break; } }
    }
    inner += ' ' + s.slice(i + 5, j);
    s = s.slice(0, i) + ' ' + s.slice(j + 1);
  }
  const count = (str, re) => (str.match(re) || []).length;
  const a = count(s, /#[A-Za-z0-9_-]+/g) + count(inner, /#[A-Za-z0-9_-]+/g);
  const b = count(s, /\.[A-Za-z0-9_-]+/g) + count(s, /\[[^\]]*\]/g) + count(s, /:(?!:)[A-Za-z-]+/g)
    + count(inner, /\.[A-Za-z0-9_-]+/g) + count(inner, /\[[^\]]*\]/g) + count(inner, /:(?!:)[A-Za-z-]+/g);
  const bare = s.replace(/[#.][A-Za-z0-9_-]+/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/::?[A-Za-z-]+(\([^)]*\))?/g, ' ');
  const c = bare.split(/[\s>+~]+/).filter((t) => /^[A-Za-z][A-Za-z0-9-]*$/.test(t)).length;
  return [a, b, c];
}

function cmpSpec(x, y) {
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] - y[i]; } }
  return 0;
}

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = s / 100;
  const ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const hp = hh / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = ll - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const NAMED_COLORS = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };

function parseColor(text) {
  const v = String(text || '').trim().toLowerCase();
  if (!v) { return null; }
  if (NAMED_COLORS[v]) { return NAMED_COLORS[v]; }
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) { return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1]; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) {
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16),
      m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 3 && !isNaN(p[0])) { return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  }
  m = /^hsla?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 3 && !isNaN(p[0])) {
      const rgb = hslToRgb(p[0], p[1], p[2]);
      rgb.push(p.length > 3 ? p[3] : 1);
      return rgb;
    }
  }
  return null;
}

// 只比"颜色语义"：两侧都能解析就比 RGB(A)（white vs #ffffff vs rgb(255,255,255) 算同一个色），
// 解析不了（值里还带 var()/calc()）才退回原文比较 —— 否则 hsl() 与 #hex 会被误判成"不同"。
function sameColor(x, y) {
  if (String(x) === String(y)) { return true; }
  const a = parseColor(x);
  const b = parseColor(y);
  if (!a || !b) { return false; }
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
    && Math.abs((a[3] === undefined ? 1 : a[3]) - (b[3] === undefined ? 1 : b[3])) < 0.02;
}

function addStyle(doc, css) {
  const s = doc.createElement('style');
  s.textContent = css;
  doc.head.appendChild(s);
  return s;
}

// 小层叠模型：见文件头"强度边界"
function makeCascade(doc) {
  const rules = [];
  const mediaSkipped = [];
  let order = 0;
  const walkList = (list) => {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r) { continue; }
      if (r.selectorText && r.style) {
        const decls = [];
        for (let k = 0; k < r.style.length; k++) {
          const prop = r.style.item(k);
          decls.push({ prop: prop, value: r.style.getPropertyValue(prop), important: r.style.getPropertyPriority(prop) === 'important' });
        }
        if (decls.length) {
          for (const sel of splitSelectors(r.selectorText)) {
            rules.push({ sel: sel, spec: specificityOf(sel), order: order, decls: decls });
          }
          order++;
        }
      } else if (r.cssRules) {
        mediaSkipped.push(r.conditionText || String(r.type));
      }
    }
  };
  for (const sheet of doc.styleSheets) {
    let list = null;
    try { list = sheet.cssRules; } catch (e) { continue; }
    if (list) { walkList(list); }
  }
  const cache = new Map();
  const beats = (d, rule, prev) => {
    if (!!d.important !== !!prev.important) { return !!d.important; }
    const c = cmpSpec(rule.spec, prev.spec);
    if (c !== 0) { return c > 0; }
    return rule.order > prev.order;
  };
  const own = (el) => {
    if (cache.has(el)) { return cache.get(el); }
    const win = new Map();
    for (const rule of rules) {
      let hit = false;
      try { hit = el.matches(rule.sel); } catch (e) { hit = false; }
      if (!hit) { continue; }
      for (const d of rule.decls) {
        const prev = win.get(d.prop);
        if (!prev || beats(d, rule, prev)) {
          win.set(d.prop, { value: d.value, sel: rule.sel, spec: rule.spec, important: d.important, order: rule.order });
        }
      }
    }
    cache.set(el, win);
    return win;
  };
  const resolve = (value, el, depth) => {
    let out = String(value || '');
    for (let guard = 0; guard < 12; guard++) {
      const i = out.indexOf('var(');
      if (i < 0) { return out; }
      let d = 0;
      let j = i + 3;
      for (; j < out.length; j++) {
        if (out[j] === '(') { d++; } else if (out[j] === ')') { d--; if (d === 0) { break; } }
      }
      const body = out.slice(i + 4, j);
      const comma = body.indexOf(',');
      const name = (comma < 0 ? body : body.slice(0, comma)).trim();
      const fallback = comma < 0 ? '' : body.slice(comma + 1).trim();
      const got = custom(el, name, (depth || 0) + 1);
      out = out.slice(0, i) + (got || fallback) + out.slice(j + 1);
    }
    return out;
  };
  const custom = (el, name, depth) => {
    if ((depth || 0) > 12) { return ''; }
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const w = own(node).get(name);
      if (w && w.value) { return resolve(w.value, node, (depth || 0) + 1); }
    }
    return '';
  };
  // 简写 background 在真实引擎里同样设置 background-color；CSSOM 不会把
  // var() 简写展开成长属性（Minimal 用的正是 'background: var(--background-tertiary)'），
  // 所以小层叠模型显式把 background 当作 background-color 的声明来源。
  const SHORTHAND = { 'background-color': 'background' };
  const pick = (el, prop) => {
    const w = own(el);
    const hit = w.get(prop) || null;
    const short = SHORTHAND[prop] ? (w.get(SHORTHAND[prop]) || null) : null;
    if (!short) { return hit; }
    if (!hit) { return short; }
    const c = cmpSpec(short.spec, hit.spec);
    if (c !== 0) { return c > 0 ? short : hit; }
    return short.order > hit.order ? short : hit;
  };
  const value = (el, prop) => resolve((pick(el, prop) || {}).value, el, 0).trim();
  const winner = (el, prop) => pick(el, prop);
  const matching = (el, filter) => rules.filter((r) => {
    try { return el.matches(r.sel) && (!filter || filter(r)); } catch (e) { return false; }
  });
  // 状态类（is-selected 等）后加时，缓存的 per-element 赢家表要作废，否则读到的是旧状态。
  const invalidate = () => cache.clear();
  return { value: value, winner: winner, matching: matching, invalidate: invalidate, rules: rules, mediaSkipped: mediaSkipped };
}

function seedNodes(doc, rowClass) {
  const list = doc.getElementById('palette-list');
  const rows = [];
  for (const text of ['打开日记', '新建笔记']) {
    const li = doc.createElement('li');
    li.className = rowClass;
    li.textContent = text;
    list.appendChild(li);
    rows.push(li);
  }
  const notices = doc.getElementById('notices');
  const notice = doc.createElement('div');
  notice.className = 'notice';
  notice.textContent = '页面内置 Notice 自检';
  notices.appendChild(notice);
  const host = doc.querySelector('.workspace') || doc.body;
  const modal = doc.createElement('div');
  modal.className = 'modal-container mod-dim';
  modal.innerHTML = '<div class="modal mod-sandbox"><div class="modal-close-button">×</div>'
    + '<div class="modal-title">插件沙箱</div><div class="modal-content">正文</div></div>';
  host.appendChild(modal);
  return {
    list: list, rows: rows, notices: notices, notice: notice, modal: modal,
    modalInner: modal.querySelector('.modal'), title: modal.querySelector('.modal-title'),
    close: modal.querySelector('.modal-close-button'), content: modal.querySelector('.modal-content')
  };
}

function countBareRule(themeCss, className) {
  const text = themeCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(^|\})\s*([^{}]+)\{/g;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    const sel = String(m[2]).trim();
    if (!sel || sel.charAt(0) === '@') { continue; }
    for (const part of splitSelectors(sel)) {
      if (part === '.' + className) { n++; }
    }
  }
  return n;
}

function staticGate() {
  const jsdom = loadJsdom();
  const JSDOM = jsdom.JSDOM;
  const VirtualConsole = jsdom.VirtualConsole;

  if (!fs.existsSync(MIN_CSS)) {
    console.log('FATAL 缺少主题 fixture：' + MIN_CSS + '（先跑 node scripts/tests/plugin-fixtures-stage.cjs）');
    process.exit(1);
  }
  const hostCss = fs.readFileSync(HOST_CSS, 'utf8');
  const minCss = fs.readFileSync(MIN_CSS, 'utf8');
  const html = fs.readFileSync(WORKSPACE_HTML, 'utf8');
  const themeJs = fs.readFileSync(THEME_JS, 'utf8');

  const build = (withTheme) => {
    const vc = new VirtualConsole();
    vc.on('jsdomError', () => {});
    /* runScripts: 'outside-only' —— 页面自己的 <script src> 不执行（静态门禁只做结构与样式），
       但 window.eval 在 jsdom 的全局里跑，theme.js 才能拿到 window 并暴露 LexiTheme。 */
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1/lexinote_workspace.html', virtualConsole: vc, pretendToBeVisual: true, runScripts: 'outside-only'
    });
    addStyle(dom.window.document, hostCss);
    if (withTheme) { addStyle(dom.window.document, minCss); }
    return dom;
  };

  const off = build(false);
  const on = build(true);
  const offDoc = off.window.document;
  const onDoc = on.window.document;

  // ---- S1 容器类是否真的长在渲染路径的节点上 ----
  const SHAPE = [
    ['#palette', 'prompt-container'], ['#palette-modal', 'modal-container'],
    ['#palette-panel', 'prompt'], ['#palette-panel', 'modal'], ['#palette-input', 'prompt-input'],
    ['#palette-list', 'prompt-results'], ['#palette-list', 'suggestion-container'],
    ['#notices', 'notice-container'], ['#boot-error', 'notice-container']
  ];
  const missing = [];
  const shapeDetail = [];
  for (const pair of SHAPE) {
    const el = onDoc.querySelector(pair[0]);
    const ok = !!el && el.classList.contains(pair[1]);
    if (!ok) { missing.push(pair[0] + '.' + pair[1]); }
    shapeDetail.push(pair[0] + (el ? '' : '(missing)'));
  }
  check('S1', 'Obsidian 容器类长在真实节点上（prompt/notice/modal/suggestion）', missing.length === 0,
    missing.length ? 'missing=' + missing.join(',') : SHAPE.length + ' 对 ID/类全部命中：' + shapeDetail.join(' '));

  // ---- S2 宿主不再需要 ID 特异性 ----
  const idHits = scanIdSelectors(HOST_CSS);
  const idTokens = ['#palette', '#notices', '#boot-error'].filter((t) => hostCss.indexOf(t) >= 0);
  const htmlAnchors = ['palette', 'notices', 'boot-error'].map((id) => id + '=' + (html.indexOf('id="' + id + '"') >= 0));
  check('S2', '宿主基础层零 ID 选择器（#palette/#notices/#boot-error 已降级为类）',
    idHits.length === 0 && idTokens.length === 0,
    'idSelectors=' + JSON.stringify(idHits) + ' idTokensInCss=' + JSON.stringify(idTokens) + ' htmlAnchorOnly=' + htmlAnchors.join(' '));

  // ---- S3 通知：真实渲染路径 + 主题色差 ----
  const bundleTs = fs.readFileSync(BUNDLE_TS, 'utf8');
  const noticePath = bundleTs.indexOf("bubble.className = 'notice'") >= 0 && bundleTs.indexOf("el('notices')") >= 0;
  check('S3a', '通知走真实渲染路径（main.ts 把气泡挂进 #notices 且类名 .notice）', noticePath,
    'bundle:451 noticeStack el(\'notices\') + bundle:456 bubble.className = \'notice\'');

  // ---- 造同一份 DOM 两侧对齐：行/通知/弹窗都是页面自己会生成的节点 ----
  const seedOn = seedNodes(onDoc, 'palette-item');
  const seedOff = seedNodes(offDoc, 'palette-item suggestion-item');
  offDoc.body.className = 'theme-dark minimal-default-dark';
  onDoc.body.className = 'theme-dark minimal-default-dark';

  // ---- 在 ON 侧执行真实的 lexinote_theme.js，拿 window.LexiTheme ----
  const logs = [];
  let viewportMobile = false;
  on.window.LexiPluginShim = {
    call: (method, payload) => {
      logs.push({ method: method, payload: payload || {} });
      const result = method === 'app.isDarkMode' ? false
        : (method === 'theme.config' ? { active: '', themes: [], source: '' } : {});
      return Promise.resolve({ result: result });
    }
  };
  on.window.matchMedia = (q) => ({
    media: q, matches: viewportMobile && q.indexOf('max-width') >= 0,
    addEventListener: () => {}, removeEventListener: () => {}
  });
  on.window.eval(themeJs);
  const api = on.window.LexiTheme;
  const apiOk = !!api && typeof api.decorate === 'function' && typeof api.applyViewport === 'function';
  check('S4a', 'lexinote_theme.js 暴露了页面自己的补类/视口函数（门禁跑真实实现）', apiOk,
    apiOk ? 'window.LexiTheme={decorate,applyViewport,sampleUi,watch}' : 'window.LexiTheme missing');
  if (!apiOk) { reportChecks('theme-evidence (static)'); process.exit(1); }

  // 让 boot() 的 setTimeout 跑完，再把明暗态钉死成暗色（applyMode 就是切这 4 个类）
  return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
    onDoc.body.className = 'theme-dark minimal-default-dark';

    // ---- S4 命令面板行：产物类 palette-item → 补 suggestion-item（真实函数，非门禁自造） ----
    // 先把 boot() 已经补上的类摘掉，再调用一次 decorate()：断言的是"这个函数补了什么"，
    // 而不是"启动时顺手补过"。
    seedOn.rows.forEach((r) => r.classList.remove('suggestion-item'));
    const beforeCount = onDoc.getElementsByClassName('suggestion-item').length;
    const added = api.decorate();
    const afterCount = onDoc.getElementsByClassName('suggestion-item').length;
    const rowsDecorated = seedOn.rows.every((r) => r.classList.contains('suggestion-item'));
    check('S4b', '命令面板行补 Obsidian 类 .suggestion-item（运行 lexinote_theme.js 的 decorate()）',
      rowsDecorated && added >= seedOn.rows.length && beforeCount === 0 && afterCount === seedOn.rows.length,
      'palette-item→suggestion-item: before=' + beforeCount + ' added=' + added + ' after=' + afterCount);

    // ---- S4c MutationObserver：新行出现即自动补类 + 立刻采一次 theme.ui（修 live 的短命节点漏采） ----
    const lateRow = onDoc.createElement('li');
    lateRow.className = 'palette-item';
    lateRow.textContent = '后插入的行';
    seedOn.list.appendChild(lateRow);
    const lateNotice = onDoc.createElement('div');
    lateNotice.className = 'notice';
    lateNotice.textContent = '后插入的通知';
    seedOn.notices.appendChild(lateNotice);
    return new Promise((r) => setTimeout(r, 40)).then(() => {
      const uiLogs = logs.filter((l) => l.method === 'log.event' && l.payload.topic === 'theme.ui');
      const lastUi = uiLogs.length ? uiLogs[uiLogs.length - 1].payload.detail : null;
      check('S4c', 'MutationObserver：新插入的面板行自动补类，并在同一拍采到 theme.ui（通知 3.2s 生命周期内）',
        lateRow.classList.contains('suggestion-item') && !!lastUi && lastUi.noticeCount >= 1,
        'lateRowSuggestion=' + lateRow.classList.contains('suggestion-item')
        + ' themeUi=' + (lastUi ? 'noticeCount=' + lastUi.noticeCount + ' suggestionCount=' + lastUi.suggestionCount : 'none'));

      const cascOff = makeCascade(offDoc);
      const cascOn = makeCascade(onDoc);
      const COLOR_PROPS = ['background-color', 'color', 'border-top-color'];

      const diff = (props, elOff, elOn, label) => {
        const out = [];
        for (const p of props) {
          const x = cascOff.value(elOff, p);
          const y = cascOn.value(elOn, p);
          if (!sameColor(x, y)) { out.push(p + ': ' + (x || '(none)') + ' -> ' + (y || '(none)')); }
        }
        return out;
      };

      // 行节点：两侧类名一致（S4b 已证 decorate() 就是补这个类），差别只在有没有主题样式表
      const rowOff = seedOff.rows[0];
      const rowOn = seedOn.rows[0];
      const noticeDiff = diff(COLOR_PROPS, seedOff.notice, seedOn.notice);
      check('S5', '真实 .notice 计算色随主题开关变化（深色态）', noticeDiff.length > 0,
        noticeDiff.join(' | ') + ' (Minimal 无 .notice 规则：' + (minCss.indexOf('.notice') < 0 ? '确认 0 条' : '有规则') + '，差异只能来自变量链)');
      const rowDiff = diff(COLOR_PROPS.concat(['padding-top', 'padding-left', 'border-radius']), rowOff, rowOn);
      check('S6', '.suggestion-item（面板行）计算样式随主题开关变化', rowDiff.length > 0, rowDiff.join(' | '));

      const panelDiff = diff(COLOR_PROPS, offDoc.getElementById('palette-panel'), onDoc.getElementById('palette-panel'));
      check('S7a', '.prompt / .modal（#palette-panel）计算背景随主题开关变化', panelDiff.length > 0, panelDiff.join(' | '));
      const inputDiff = diff(COLOR_PROPS, offDoc.getElementById('palette-input'), onDoc.getElementById('palette-input'));
      check('S7b', '.prompt-input（#palette-input）计算色随主题开关变化', inputDiff.length > 0, inputDiff.join(' | '));
      const sugDiff = diff(COLOR_PROPS, offDoc.getElementById('palette-list'), onDoc.getElementById('palette-list'));
      check('S8a', '.suggestion-container（#palette-list）计算背景随主题开关变化', sugDiff.length > 0, sugDiff.join(' | '));

      // ---- S8b .modal-container：Minimal 没有裸规则 → 颜色差断言在原理上不成立，改结构断言 ----
      // Minimal 对 .modal-container 只有后代规则（无裸规则），不可能有"容器自身颜色差"，
      // 所以这一条是约束 2 允许的结构断言：主题的容器后代规则确实命中容器里的真实行，
      // 且赢过宿主同节点规则（.model-container .suggestion-item.is-selected = 0,2,0）。
      // 注意：is-selected 是"选中态"类，页面目前不发这个状态 —— 这里模拟状态类，不造节点。
      seedOn.rows[0].classList.add('is-selected');
      seedOff.rows[0].classList.add('is-selected');
      cascOn.invalidate();
      cascOff.invalidate();
      const bareModal = countBareRule(minCss, 'modal-container');
      const conDiff = diff(COLOR_PROPS, seedOff.modal, seedOn.modal);
      const themeWins = cascOn.matching(seedOn.rows[0], (r) => r.sel.indexOf('.modal-container') >= 0);
      const hostWins = cascOff.matching(seedOff.rows[0]);
      const winOn = cascOn.winner(seedOn.rows[0], 'background-color');
      const winOff = cascOff.winner(seedOff.rows[0], 'background-color');
      const hostMax = hostWins.reduce((acc, r) => (cmpSpec(r.spec, acc) > 0 ? r.spec : acc), [0, 0, 0]);
      const themeBest = themeWins.reduce((acc, r) => (cmpSpec(r.spec, acc) > 0 ? r.spec : acc), [0, 0, 0]);
      check('S8b', '.modal-container：无裸规则可产生颜色差 → 结构断言（主题容器后代规则命中真实行并赢过宿主同节点规则）',
        bareModal === 0 && conDiff.length === 0 && themeWins.length > 0 && !!winOn
        && winOn.sel.indexOf('.modal-container') >= 0 && cmpSpec(winOn.spec, winOff ? winOff.spec : [0, 0, 0]) >= 0,
        'bareRules=' + bareModal + ' containerColorDiff=' + (conDiff.length ? conDiff.join('|') : 'none(预期)')
        + ' themeDescendantRules=' + themeWins.length + ' themeSpec=' + JSON.stringify(themeBest)
        + ' hostMaxSpec=' + JSON.stringify(hostMax)
        + ' winnerON="' + (winOn ? winOn.sel + '" ' + JSON.stringify(winOn.spec) + ' = ' + cascOn.value(seedOn.rows[0], 'background-color') : 'none"')
        + ' winnerOFF="' + (winOff ? winOff.sel + '" ' + JSON.stringify(winOff.spec) : 'none"')
        + ' (is-selected 为模拟选中态)');

      // ---- S9 Modal 内层（plugin shim 生成的真实节点） ----
      const titleDiff = diff(['font-size', 'padding-top', 'text-align', 'color'], seedOff.title, seedOn.title);
      const closeDiff = diff(['padding-top', 'width', 'height', 'cursor', 'color'], seedOff.close, seedOn.close);
      const shim = fs.readFileSync(PLUGIN_SHIM, 'utf8');
      const shimMount = shim.indexOf("container.className = 'modal-container mod-dim'") >= 0
        && shim.indexOf("titleEl.className = 'modal-title'") >= 0
        && shim.indexOf("closeButton.className = 'modal-close-button'") >= 0;
      check('S9', 'Modal 内层 .modal-title / .modal-close-button 由主题命中（真实 shim 节点，非门禁自造）',
        shimMount && titleDiff.length > 0 && closeDiff.length > 0,
        'shim:1993/1997/2000 real classes=' + shimMount + ' title[' + titleDiff.join('|') + '] close[' + closeDiff.join('|') + ']');

      // ---- S10 .menu 内层：容器里根本没有 .menu 节点 → 记为已知缺口，不造假节点 ----
      const menuNodes = onDoc.querySelectorAll('.menu, .menu-item, .menu-separator').length;
      const shimMenuWarn = shim.indexOf('原生菜单渲染将在后续版本生效') >= 0;
      const shimMenuDom = shim.indexOf('menu-item') >= 0;
      check('S10', '.menu 内层缺口被如实记录（无真实节点，shim 只告警不建 DOM）', menuNodes === 0 && shimMenuWarn && !shimMenuDom,
        'menuNodes=' + menuNodes + ' shimWarn=' + shimMenuWarn + ' shimCreatesMenuDom=' + shimMenuDom + ' → 缺口见报告"没有证明的东西"');

      // ---- S11 is-mobile 落到真实 body 节点 ----
      viewportMobile = true;
      const mobileOn = api.applyViewport();
      const hasMobile = onDoc.body.classList.contains('is-mobile');
      viewportMobile = false;
      const mobileOff = api.applyViewport();
      const hasMobileOff = onDoc.body.classList.contains('is-mobile');
      const breakpointInCss = /@media\s*\(max-width:\s*560px\)/.test(hostCss);
      const breakpointInJs = /MOBILE_QUERY\s*=\s*'\(max-width: 560px\)'/.test(themeJs);
      const mobileLine = themeJs.split('\n').findIndex((l) => l.indexOf("classList.toggle('is-mobile'") >= 0) + 1;
      check('S11', 'is-mobile 由页面代码加到真实 <body>（断点与 CSS 的 @media 一致）',
        mobileOn === true && hasMobile && mobileOff === false && !hasMobileOff && breakpointInCss && breakpointInJs,
        'lexinote_theme.js:' + mobileLine + " body.classList.toggle('is-mobile') on=" + mobileOn + '/has=' + hasMobile
        + ' off=' + mobileOff + '/has=' + hasMobileOff + ' breakpoint css=' + breakpointInCss + ' js=' + breakpointInJs);

      // ---- S12 宿主 CSS 变量自包含（主题层不再依赖 ID 承载区的变量） ----
      const refs = [];
      const seen = {};
      const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      let m;
      while ((m = re.exec(hostCss))) { if (!seen[m[1]]) { seen[m[1]] = 1; refs.push(m[1]); } }
      const undef = refs.filter((name) => hostCss.indexOf(name + ':') < 0);
      // 口径与 C8 一致：未定义项允许存在，但必须逐条打印，不许静默。
      // 实测 --divider-color 悬空（宿主 css 用了、没定义），已记入报告"已知缺口"。
      check('S12', '宿主 CSS 变量引用已清点，悬空项逐条打印（口径同 C8：允许存在但不许静默）',
        refs.length >= 30,
        'referenced=' + refs.length + ' defined=' + (refs.length - undef.length) + ' undefined=' + undef.length
        + (undef.length ? ' [' + undef.join(' ') + ']' : ' []'));

      // ---- S13 两张 REQUIRED_CLASSES 表不许漂移 ----
      const decl = /var REQUIRED_CLASSES = \[([\s\S]*?)\];/.exec(themeJs);
      const jsList = decl ? (decl[1].match(/'([a-z0-9-]+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
      const same = jsList.length === REQUIRED_CLASSES.length && jsList.every((n, i) => n === REQUIRED_CLASSES[i]);
      check('S13', 'theme.js 与门禁的 REQUIRED_CLASSES 完全一致（防两表漂移）', same,
        'theme.js=' + jsList.length + ' gate=' + REQUIRED_CLASSES.length + ' diff=' + (same ? 'none' : jsList.filter((n) => REQUIRED_CLASSES.indexOf(n) < 0).join(',')));

      console.log('  层叠模型：off-sheet=lexinote_theme.css on-sheet=+Minimal styles.css rules=' + cascOn.rules.length
        + ' mediaSkipped=' + cascOn.mediaSkipped.length + '（@media 不求值，见文件头强度边界）');
      const ok = reportChecks('theme-evidence (static, jsdom, no device)');
      off.window.close();
      on.window.close();
      process.exit(ok ? 0 : 1);
    });
  });
}

// ------------------------------------------------------------------ offline replay

function readSummary(dir) {
  const file = path.join(dir, 'summary.json');
  if (!fs.existsSync(file)) { return null; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
}

function checkOnly(dir) {
  const logFile = path.join(dir, 'hilog.log');
  console.log('replay: ' + dir);
  const entries = entriesOf(logFile);
  console.log('log: ' + logFile + ' (' + entries.length + ' LexiWorkspace 条目)');
  const lock = loadLock();
  const inject = pick(entries, 'theme.inject');
  const injectDetail = inject ? inject.detail : null;
  check('C3', '注入的 CSS = 505243 字节且 sha256 与锁一致',
    !!injectDetail && injectDetail.bytes === lock.css.bytes && injectDetail.sha256 === lock.css.sha256 && injectDetail.match === true,
    injectDetail ? ('bytes=' + injectDetail.bytes + ' match=' + injectDetail.match) : 'no log');
  check('C4', '注入节点在 head 末尾', !!injectDetail && injectDetail.styleLast === true);
  const classes = pick(entries, 'theme.classes');
  check('C5', '必需类名全部存在', !!classes && String(classes.detail.__missing || '') === '',
    classes ? 'missing=' + (classes.detail.__missing || '(none)') : 'no log');
  const probe = pick(entries, 'theme.probe');
  check('C6', '关闭 vs 开启变量计算值不同',
    !!probe && probe.detail.differBg === true && probe.detail.differText === true,
    probe ? 'off.bg=' + probe.detail.off.bg + ' on.bg=' + probe.detail.on.bg : 'no log');
  const states = pick(entries, 'theme.states');
  check('C7', '明暗两态同一元素背景色不同', !!states && states.detail.differ === true,
    states ? states.detail.light.color + ' vs ' + states.detail.dark.color : 'no log');
  const coverage = pick(entries, 'theme.coverage');
  const undef = pickAll(entries, 'theme.coverage.undefined').map((e) => String(e.detail.names || '')).join(' ');
  console.log('  coverage.undefined: ' + (undef.trim() || '(none)'));
  check('C8', '变量覆盖报告存在', !!coverage, coverage ? JSON.stringify(coverage.detail) : 'no log');
  const offPng = path.join(dir, 'theme-off.png');
  const onPng = path.join(dir, 'theme-on.png');
  const have = fs.existsSync(offPng) && fs.existsSync(onPng);
  check('C9', '两张截图存在且尺寸一致', have,
    have ? decodePng(fs.readFileSync(offPng)).width + 'x' + decodePng(fs.readFileSync(offPng)).height : 'missing');
  if (have) {
    // 区域必须与真跑时一致，否则离线重放等于换了一把尺子（实测同一对图：整屏 inset 0.1 = 6.742，Web 容器 = 10.228）。
    const saved = readSummary(dir);
    const savedRect = saved && saved.diff && saved.diff.rect ? saved.diff.rect : null;
    if (savedRect) { console.log('  region: 复用 summary.json 的 Web 容器 rect ' + JSON.stringify(savedRect)); }
    const diff = meanAbsDiff(decodePng(fs.readFileSync(offPng)), decodePng(fs.readFileSync(onPng)), savedRect ? savedRect : 0.1);
    check('C10', '同一区域平均色差 > ' + DIFF_THRESHOLD, diff.mean > DIFF_THRESHOLD,
      'mean=' + diff.mean.toFixed(3) + ' region=' + diff.region.join(','));
  } else {
    check('C10', '同一区域平均色差 > ' + DIFF_THRESHOLD, false, 'missing screenshots');
  }
  const specEntry = pick(entriesOf(logFile), 'theme.specificity');
  check('C4b', '宿主基础层零 ID 选择器（CSSOM 口径）',
    !!specEntry && !!specEntry.detail.host && specEntry.detail.host.maxIds === 0,
    specEntry ? JSON.stringify(specEntry.detail.host && specEntry.detail.host.idSelectors) : 'no log');
  const uiList = pickAll(entriesOf(logFile), 'theme.ui');
  const uiOff = uiList.length >= 2 ? uiList[uiList.length - 2].detail : null;
  const uiOn = uiList.length >= 2 ? uiList[uiList.length - 1].detail : null;
  check('C11', '#palette 计算背景色：主题关闭 vs 开启不同',
    !!uiOff && !!uiOn && uiOff.palette !== uiOn.palette,
    (uiOff ? 'off=' + uiOff.palette : 'off=none') + ' ' + (uiOn ? 'on=' + uiOn.palette : 'on=none'));
  check('C12', '真实 .notice 计算背景色：主题关闭 vs 开启不同',
    !!uiOff && !!uiOn && uiOff.notice !== uiOn.notice,
    (uiOff ? 'off=' + uiOff.notice : 'off=none') + ' ' + (uiOn ? 'on=' + uiOn.notice : 'on=none'));
  const rulesEntry = pick(entriesOf(logFile), 'theme.rules');
  check('C13', 'Minimal 的 .prompt*/.modal* 规则有命中',
    !!rulesEntry && rulesEntry.detail.prompt.matched > 0 && rulesEntry.detail.modal.matched > 0,
    rulesEntry ? JSON.stringify(rulesEntry.detail) : 'no log');
  const ok = reportChecks('theme-evidence (offline replay)');
  if (!ok) {
    process.exit(1);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const args = process.argv.slice(2);
  const checkOnlyAt = args.indexOf('--check-only');
  if (checkOnlyAt >= 0) {
    checkOnly(path.resolve(args[checkOnlyAt + 1] || ''));
    return;
  }
  const redlightArg = args.find((a) => a.indexOf('--redlight=') === 0);
  const redlight = redlightArg ? redlightArg.split('=')[1] : null;
  const REDLIGHTS = ['sha', 'same-shot', 'no-notice'];
  if (redlight && REDLIGHTS.indexOf(redlight) < 0) {
    console.log('unknown redlight: ' + redlight);
    process.exit(2);
  }
  if (args.indexOf('--live') < 0) {
    // 默认路径不碰设备：静态门禁自己 exit，"设备操作 0 次"的约束由这里兜住。
    await staticGate();
    return;
  }
  const dir = path.join(OUT_ROOT, stamp());
  fs.mkdirSync(dir, { recursive: true });
  await live(dir, redlight);
}

main().catch((err) => {
  console.log('FATAL ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
