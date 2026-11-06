#!/usr/bin/env node
// 真机证据:插件作用域调用 app.vault.adapter.* 到底能不能拿到身份(fs 门禁)。
// 设备上没有 obsidian-text-format 夹具,所以这里自建最小探针(市场安装,不碰 rawfile/plugins)。
// 用法: node scripts/tests/adapter-probe-evidence.cjs [--run]
// 证据: .fixtures-out/evidence/<ts>-adapter-probe/{hilog.log,anchors.txt,summary.json,probe-line.txt}
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
const DEVICE = '127.0.0.1:15555';
const PORT = 8099;
const PLUGINS_DIR = '/data/app/el2/100/base/' + BUNDLE + '/haps/entry/files/plugins';
const PLUGIN_ID = 'adapter-probe';
const PLUGIN_NAME = '适配探针';

// 探针本体:只 require('obsidian')。用 console.log 输出探测结果(不是异常),
// 避免被 negative 组的 console.error 断言误判。
const PROBE_MAIN = [
  "const { Plugin } = require('obsidian');",
  'module.exports = class AdapterProbe extends Plugin {',
  '  async onload() {',
  '    const adapter = this.app.vault.adapter;',
  '    const parts = [];',
  '    const step = async (name, fn) => {',
  '      try {',
  '        const value = await fn();',
  '        const shown = typeof value === "boolean" ? String(value) : (typeof value === "string" ? value.length + "chars" : String(value));',
  '        parts.push(name + "=ok(" + shown + ")");',
  '      } catch (err) {',
  '        parts.push(name + "=ERR(" + ((err && (err.code || err.message)) || String(err)) + ")");',
  '      }',
  '    };',
  '    await step("adapter.exists.before", () => adapter.exists("AdapterProbe/probe.md"));',
  '    await step("adapter.write", () => adapter.write("AdapterProbe/probe.md", "probe-ok"));',
  '    await step("adapter.read", () => adapter.read("AdapterProbe/probe.md"));',
  '    await step("adapter.exists.after", () => adapter.exists("AdapterProbe/probe.md"));',
  '    await step("adapter.stat", async () => { const s = await adapter.stat("AdapterProbe/probe.md"); return s ? s.size : "null"; });',
  '    await step("adapter.remove", () => adapter.remove("AdapterProbe/probe.md"));',
  '    await step("adapter.list", () => adapter.list("").then((r) => (r.files || []).length));',
  '    await step("vault.markdownFiles", () => this.app.vault.getMarkdownFiles().length);',
  '    console.log("[adapter.probe] run=__RUN_NONCE__ " + parts.join(" "));',
  '  }',
  '};',
  ''
].join('\n');

const argv = process.argv.slice(2);
const run = argv.indexOf('--run') >= 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hdc(args, timeout) {
  const res = spawnSync(HDC, args, { encoding: 'utf8', timeout: timeout || 120000 });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
function sh(cmd, timeout) { return hdc(['-t', DEVICE, 'shell', cmd], timeout).out; }
function walk(node, visit) {
  if (!node || typeof node !== 'object') { return; }
  if (node.attributes) { visit(node.attributes); }
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) { walk(kids[i], visit); }
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
    walk(JSON.parse(fs.readFileSync(local, 'utf8')), (a) => list.push(a));
    return list;
  } catch (e) { return []; }
}
function texts(list) { return list.map((a) => a.text || '').filter((t) => t.length > 0); }
function findByText(list, pattern, filter) {
  for (const a of list) {
    const box = bounds(a);
    if (box && pattern.test(a.text || '') && (!filter || filter(box))) { return a; }
  }
  return null;
}
function clickNode(attrs) {
  const box = bounds(attrs || {});
  if (!box) { return false; }
  sh('uitest uiInput click ' + box.cx + ' ' + box.cy, 60000);
  return true;
}
function clickText(list, pattern, filter) { return clickNode(findByText(list, pattern, filter)); }
async function pollText(dir, tag, pattern, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const started = Date.now();
  let last = [];
  let attempts = 0;
  while (Date.now() - started < timeoutMs) {
    attempts++;
    last = texts(dumpLayout(dir, tag));
    const hit = last.filter((t) => pattern.test(t))[0];
    if (hit) { return { ok: true, attempts: attempts, hit: hit, texts: last }; }
    await sleep(800);
  }
  return { ok: false, attempts: attempts, hit: '', texts: last };
}
function clickRowAction(dir, tag, label, action) {
  const list = dumpLayout(dir, tag);
  const row = findByText(list, new RegExp(label));
  if (!row) { return false; }
  const rowY = bounds(row).cy;
  const buttons = list.filter((a) => bounds(a) && action.test(a.text || ''));
  buttons.sort((a, b) => Math.abs(bounds(b).cy - rowY) - Math.abs(bounds(a).cy - rowY));
  return buttons.length > 0 && clickNode(buttons[0]);
}
// hilog 缓冲区跨轮留存:只把本轮开始之后的行算证据,旧行一律过滤。
function clockOf(line) { const m = /(\d\d:\d\d:\d\d)\.\d+/.exec(line); return m ? m[1] : ''; }
function startHilog(file) {
  const fd = fs.openSync(file, 'w');
  const child = spawn(HDC, ['-t', DEVICE, 'shell', 'hilog'], { stdio: ['ignore', fd, fd] });
  return {
    file: file,
    stop: function () { child.kill(); try { fs.closeSync(fd); } catch (e) { /* closed */ } },
    lines: function () { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/) : []; }
  };
}

// 每次运行换一个 nonce:hilog 里还留着上一轮的探针行(设备缓冲区不会因为重装清空),
// 只认本轮 nonce,避免把旧结果当成本轮证据。
function buildZip(nonce) {
  const manifest = {
    id: PLUGIN_ID, name: PLUGIN_NAME, version: '1.0.0', author: 'runtime-track',
    minAppVersion: '0.1.0', description: '真机 adapter 通路探针(证据用,不发布)',
    minApiVersion: '1.0.0', isDesktopOnly: false,
    capabilities: { network: [], fs: true, clipboard: false }
  };
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'main.js', data: Buffer.from(PROBE_MAIN.split('__RUN_NONCE__').join(nonce), 'utf8') }
  ];
  const bytes = writeZip(entries);
  const outDir = path.join(REPO, '.fixtures-out', 'adapter-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, PLUGIN_ID + '-1.0.0.zip');
  fs.writeFileSync(file, bytes);
  return { file: file, bytes: bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function startServer(zip) {
  const server = http.createServer((request, response) => {
    console.log('[serve] ' + request.method + ' ' + request.url);
    if (request.url === '/market.json') {
      const index = {
        schemaVersion: 1,
        plugins: [{
          id: PLUGIN_ID, name: PLUGIN_NAME, version: '1.0.0', author: 'runtime-track',
          description: '真机 adapter 通路探针', repo: 'lexinote/adapter-probe',
          minApiVersion: '1.0.0', isDesktopOnly: false, sha256: zip.sha256,
          zipUrl: 'http://10.0.2.2:' + PORT + '/zips/probe.zip',
          capabilities: { network: [], fs: true, clipboard: false }
        }]
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(index));
      return;
    }
    if (request.url === '/zips/probe.zip') {
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.end(zip.bytes);
      return;
    }
    response.writeHead(404); response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '0.0.0.0', function () { resolve({ close: function () { server.close(); } }); });
  });
}
async function openMarket(dir) {
  sh('aa force-stop ' + BUNDLE, 60000);
  sh('aa start -a ' + ABILITY + ' -b ' + BUNDLE, 60000);
  const profile = await (async function () {
    const started = Date.now();
    while (Date.now() - started < 90000) {
      const list = dumpLayout(dir, 'layout-dock');
      const found = list.filter((a) => a.id === 'workspace-action-dock-profile' && bounds(a))[0];
      if (found) { return found; }
      await sleep(1000);
    }
    return null;
  })();
  if (!profile) { throw new Error('未出现 workspace-action-dock-profile(冷启未完成)'); }
  clickNode(profile);
  const panel = await pollText(dir, 'layout-settings', /^社区插件市场$/, { timeoutMs: 25000 });
  if (!panel.ok) { throw new Error('设置面板未出现:' + panel.texts.slice(0, 12).join(' | ')); }
  const list = dumpLayout(dir, 'layout-settings-click');
  const side = list.filter((a) => /^社区插件市场$/.test(a.text || '') && bounds(a) && bounds(a).x1 < 1000)[0];
  if (!side) { throw new Error('设置侧栏没有"社区插件市场"'); }
  clickNode(side);
  const sheet = await pollText(dir, 'layout-market', /^演示源/, { timeoutMs: 25000 });
  if (!sheet.ok) { throw new Error('社区插件市场未打开:' + sheet.texts.slice(0, 12).join(' | ')); }
  // 演示源是切换按钮:关着的时候必须先点开(点开后文案变「演示源（使用中）」),
  // 否则刷新拉的是官方源(设备上没有)→ HTTP 404,看起来像本地服务没起来。
  let demo = false;
  for (let attempt = 0; attempt < 3 && !demo; attempt++) {
    if (!/使用中/.test(texts(dumpLayout(dir, 'layout-source-' + attempt)).join('|'))) {
      clickText(dumpLayout(dir, 'layout-source-click-' + attempt), /^演示源/);
      await sleep(1200);
    }
    const after = texts(dumpLayout(dir, 'layout-source-after-' + attempt)).join('|');
    demo = /演示源（使用中）/.test(after);
  }
  clickText(dumpLayout(dir, 'layout-refresh'), /^刷新$/);
  await sleep(2500);
}

async function main() {
  const nonce = crypto.randomBytes(4).toString('hex');
  const zip = buildZip(nonce);
  console.log('[adapter-probe] nonce=' + nonce);
  console.log('[adapter-probe] zip ' + zip.file + ' sha256=' + zip.sha256 + ' bytes=' + zip.bytes.length);
  if (!run) {
    console.log('[adapter-probe] 计划: 8099 市场 → UI 安装 → hilog 抓 [adapter.probe];未带 --run 不碰设备');
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const dir = path.join(REPO, '.fixtures-out', 'evidence', stamp + '-adapter-probe');
  fs.mkdirSync(dir, { recursive: true });
  const server = await startServer(zip);
  const log = startHilog(path.join(dir, 'hilog.log'));
  const rows = [];
  const check = function (label, ok, detail) {
    const row = (ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' :: ' + String(detail).slice(0, 400) : '');
    rows.push(row);
    console.log('  ' + row);
    return ok;
  };
  const sinceClock = sh('date +%H:%M:%S').trim();
  console.log('[adapter-probe] device-clock since=' + sinceClock);
  try {
    sh('rm -rf ' + PLUGINS_DIR + '/' + PLUGIN_ID, 60000);
    await openMarket(dir);
    const listed = await pollText(dir, 'layout-listed', new RegExp(PLUGIN_NAME), { timeoutMs: 25000 });
    check('市场索引列出探针', listed.ok, listed.ok ? listed.hit : '可见文本=' + listed.texts.slice(0, 10).join(' | '));
    if (!listed.ok) { throw new Error('市场没列出探针'); }
    clickRowAction(dir, 'layout-install-click', PLUGIN_NAME, /^安装$/);
    // P5-004:安装不再自动 enable——先停在授权面板,显式同意后启用。
    const pending = await pollText(dir, 'layout-installed-pending', /已安装（未启用）：|安装失败/, { timeoutMs: 45000 });
    check('UI 报安装结果(待授权)', pending.ok && !/安装失败/.test(pending.hit || ''), pending.hit);
    const consentBtn = findByText(dumpLayout(dir, 'layout-consent'), /^同意并启用$/);
    check('授权面板同意按钮可见', Boolean(consentBtn), consentBtn ? 'y=' + bounds(consentBtn).cy : '');
    if (consentBtn) { clickNode(consentBtn); }
    const done = await pollText(dir, 'layout-installed', /已安装并启用|安装失败/, { timeoutMs: 45000 });
    check('UI 报安装结果(同意后)', done.ok && !/安装失败/.test(done.hit), done.hit);
    const ls = sh('ls -1 ' + PLUGINS_DIR + '/' + PLUGIN_ID + ' 2>&1');
    fs.writeFileSync(path.join(dir, 'ls.txt'), ls);
    check('插件目录落盘 manifest/main', /manifest\.json/.test(ls) && /main\.js/.test(ls), ls.replace(/\n/g, ' '));

    let hit = null;
    const started = Date.now();
    while (Date.now() - started < 60000) {
      const lines = log.lines();
      const mine = new RegExp('\\[adapter\\.probe\\] run=' + nonce);
      for (let i = 0; i < lines.length; i++) {
        if (mine.test(lines[i])) { hit = { line: lines[i], index: i }; break; }
      }
      if (hit) { break; }
      await sleep(1500);
    }
    const text = hit ? hit.line.trim() : '';
    fs.writeFileSync(path.join(dir, 'probe-line.txt'), text + '\n');
    check('[adapter.probe] 日志出现', Boolean(hit), hit ? 'line ' + (hit.index + 1) + ' :: ' + text : '60s 内没有探针日志');

    const failures = [];
    if (hit) {
      const body = text.replace(/.*\[adapter\.probe\] run=\S+\s*/, '');
      const tokens = body.split(/\s+/);
      for (const token of tokens) {
        const m = /^(adapter\.[a-zA-Z]+|vault\.[a-zA-Z]+)=(.+)$/.exec(token);
        if (m && /^ERR\(/.test(m[2])) { failures.push(m[1] + ' -> ' + m[2]); }
      }
    }
    check('adapter 全部方法成功(无 ERR)', hit !== null && failures.length === 0, failures.join(' ; '));

    const denies = log.lines().filter((line) => /capability\.fs|capability_denied/.test(line) && (!clockOf(line) || clockOf(line) >= sinceClock));
    fs.writeFileSync(path.join(dir, 'host-denies.txt'), denies.join('\n') + '\n');
    check('宿主侧无 fs/adapter 拒绝行', denies.length === 0, denies.length ? denies.slice(0, 3).join(' || ') : '无');
  } catch (err) {
    check('流程完成', false, err && err.message ? err.message : String(err));
  } finally {
    await sleep(1500);
    log.stop();
    server.close();
  }
  fs.writeFileSync(path.join(dir, 'anchors.txt'), rows.join('\n') + '\n');
  const failed = rows.filter((row) => row.indexOf('FAIL') === 0).length;
  const summary = { at: new Date().toISOString(), device: DEVICE, zipSha256: zip.sha256, result: failed === 0 ? 'pass' : 'fail', failures: failed, rows: rows, dir: dir };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n[summary] ' + (failed === 0 ? 'PASS' : 'FAIL (' + failed + ')') + '  evidence: ' + dir);
  return failed === 0 ? 0 : 1;
}

main().then(function (code) { process.exit(code); }).catch(function (err) { console.error('[adapter-probe] 崩了: ' + (err && err.stack ? err.stack : err)); process.exit(2); });
