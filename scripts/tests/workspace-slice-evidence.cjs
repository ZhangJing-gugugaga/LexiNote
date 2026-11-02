#!/usr/bin/env node
/**
 * LexiNote workspace vertical-slice evidence gate.
 *
 *   node scripts/tests/workspace-slice-evidence.cjs                # live run on the attached device
 *   node scripts/tests/workspace-slice-evidence.cjs --check-only <dir|log>
 *
 * Exit codes: 0 all milestones present in order, 1 a milestone is missing, 2 device unreachable.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
let REQUIRE_SESSION = false;
const HDC = process.env.HDC_PATH ||
  path.join('E:', 'dev-tools', 'harmonyos', 'command-line-tools', 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
const BUNDLE = 'com.lovexjy.lexinote';
const ABILITY = 'EntryAbility';
const HAP = path.join(REPO, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const OUT_ROOT = path.join(REPO, '.fixtures-out', 'evidence');
const TAG_FILTER = 'LexiWorkspace';
/** 身份正反证据用的宿主探针服务:设备侧 18080 经 hdc rport 反连宿主 18080。 */
const PORT = Number(process.env.WORKSPACE_PROBE_PORT || 18080);
const NET_PATH = '/netprobe/hello.txt';
const NET_BODY = 'lexinote-netprobe-ok';

/**
 * Regression set: the inline demo plugin path from M1-A. Kept so real-plugin work cannot silently break it.
 * A PASS here does not mean real plugins work; the real set below is the acceptance anchor.
 */
const MILESTONES = [
  { id: 'channel.port.attached', topic: 'channel.port.attached' },
  { id: 'channel.hello', topic: 'channel.hello' },
  { id: 'channel.auth', topic: 'channel.auth', match: /authed=true/ },
  { id: 'plugin.load', topic: 'plugin.load' },
  { id: 'plugin.instance.create', topic: 'plugin.instance.create', json: (d) => d.createCalls === 1 },
  { id: 'plugin.view.render x3', topic: 'plugin.view.render', repeat: 3, json: (d) => d.instanceCount === 1 },
  { id: 'command.invoke', topic: 'command.invoke' },
  // The plugin notices synchronously, then its host round-trip resolves; both hang off command.invoke
  // so the gate does not depend on the relative order of two independent events.
  { id: 'notice.render', topic: 'notice.render', json: (d) => d.visible === 1, after: 'command.invoke' },
  { id: 'plugin.command.ok', topic: 'plugin.command.ok', after: 'command.invoke' },
];

/** Real set: anchored on a real obsidian plugin loaded from files/plugins/<id>/main.js. */
const REAL_MILESTONES = [
  { id: 'plugin.obsidian.ready', topic: 'plugin.obsidian.ready', json: (d) => typeof d.id === 'string' && d.id.length > 0 },
  { id: 'probe.plugin.onload', topic: 'probe.plugin.onload' },
  { id: 'probe.view.open', topic: 'probe.view.open' },
  { id: 'probe.view.setViewState', topic: 'probe.view.setViewState', json: (d) => d.leaves >= 1 },
  { id: 'probe.probe.done', topic: 'probe.probe.done' },
];

/** M1-B protocol set: identity, the seven formerly dead channels, batch limit and the 20s timeout. */
const PROTOCOL_MILESTONES = [
  { id: 'frame.identity.selfcheck', topic: 'frame.identity.selfcheck', json: (d) => d.ok === true && d.claimed === 'forged-identity' },
  { id: 'probe.channel.localStorage', topic: 'probe.channel.localStorage', json: (d) => d.roundTrip === true && d.tag === 'compat' },
  { id: 'probe.channel.commands', topic: 'probe.channel.commands', json: (d) => d.echoed === true && d.listed > 0 },
  { id: 'probe.channel.placeholder', topic: 'probe.channel.placeholder', json: (d) => d.statusbar >= 1 && d.modals >= 1 },
  { id: 'probe.channel.commandsHost', topic: 'probe.channel.commandsHost', json: (d) => d.hostFallback === true && d.rejected === true },
  { id: 'probe.channel.commandsHostOnly', topic: 'probe.channel.commandsHostOnly', json: (d) => d.executed === true && d.rejected === false },
  { id: 'probe.channel.openLinkText', topic: 'probe.channel.openLinkText' },
  { id: 'probe.channel.onLayoutReady', topic: 'probe.channel.onLayoutReady', json: (d) => d.fired === true },
  { id: 'frame.batch.selfcheck', topic: 'frame.batch.selfcheck', json: (d) => d.overflowCode === 'batch_overflow' && d.okReplies === 64 },
  { id: 'frame.timeout.selfcheck', topic: 'frame.timeout.selfcheck', json: (d) => d.rejected === true && d.code === 'timeout' },
];

/** M1-C layout/state set: 跨进程持久化 + 日历零改动渲染 + metadata 真值。无序匹配,靠 repeat 计次数。 */
const LAYOUT_MILESTONES = [
  { id: 'probe.metadata.links', topic: 'probe.metadata.links', json: (d) => d.links === 3 && d.embeds === 1 && d.resolved === 3 && d.unresolved === 1 && d.frontmatterTags >= 2 },
  { id: 'probe.metadata.links.rename', topic: 'probe.metadata.links.rename', json: (d) => d.allArrived === true && d.oldLinkGone === true && d.newLinkLive === true },
  { id: 'workspace.layout.restore x2', topic: 'workspace.layout.restore', repeat: 2, json: (d) => d.leaves >= 1 },
  { id: 'probe.calendar.leaf', topic: 'probe.calendar.leaf', json: (d) => d.leaves >= 1 && d.rendered === true && d.connected === true },
];

/** M1-C2 editor set: CM6 单实例恒等 + 扩展真装真撤 + 编辑器真操作 + leaf 去重。 */
const EDITOR_MILESTONES = [
  { id: 'probe.editor.identity', topic: 'probe.editor.identity', json: (d) => d.ctorSame === true && d.liveSame === true && d.liveCtorSame === true && d.fieldReadable === true },
  { id: 'probe.editor.ext.install', topic: 'probe.editor.ext.install', json: (d) => d.installed === true && d.error === '' && d.count >= 1 },
  { id: 'probe.editor.ext.release', topic: 'probe.editor.ext.release', json: (d) => d.removed === true && d.remaining === 0 && d.count === 0 },
  { id: 'probe.editor.undo', topic: 'probe.editor.undo', json: (d) => d.editedOk === true && d.undoneOk === true && d.redoneOk === true },
  { id: 'probe.editor.exec', topic: 'probe.editor.exec', json: (d) => d.ran === true && d.selLen === 13 },
  { id: 'probe.editor.processLines', topic: 'probe.editor.processLines', json: (d) => d.ok === true },
  { id: 'probe.editor.outliner', topic: 'probe.editor.outliner', json: (d) => d.extCount >= 1 && (d.markers >= 1 || d.bodyClass === true) },
  { id: 'probe.editor.leaves', topic: 'probe.editor.leaves', json: (d) => d.duplicates === 0 && d.leaves >= 1 },
];

/** Any of these topics in a live log fails the gate even when every milestone passed. */
const FATAL_TOPICS = [
  'plugin.error', 'plugin.onload.error', 'plugin.obsidian.error', 'plugin.obsidian.skip',
  'workspace.boot.error', 'probe.error', 'probe.view.setViewState.error', 'channel.localStorage.error',
  'channel.commands.error', 'channel.placeholder.error', 'channel.openLinkText.error',
  'frame.event.drop', 'frame.batch.overflow.unexpected'
];

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function nodes(root) {
  const list = [];
  walk(root, (attrs) => list.push(attrs));
  return list;
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
    return nodes(JSON.parse(fs.readFileSync(local, 'utf8')));
  } catch (err) {
    return [];
  }
}

function findById(list, id) {
  return list.find((attrs) => attrs.id === id && bounds(attrs)) || null;
}

function findByText(list, pattern, preferLeftMost) {
  const hits = list.filter((attrs) => bounds(attrs) && pattern.test(attrs.text || ''));
  if (hits.length === 0) {
    return null;
  }
  if (preferLeftMost) {
    hits.sort((a, b) => bounds(a).x1 - bounds(b).x1);
  }
  return hits[0];
}

function click(attrs) {
  const box = bounds(attrs);
  const res = run(['shell', 'uitest', 'uiInput', 'click', String(box.cx), String(box.cy)], { timeout: 60000 });
  return res.out.indexOf('No Error') >= 0 || res.status === 0;
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

// ---------------------------------------------------------------- log parsing

function readAllLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function readLogLines(file) {
  return readAllLines(file).filter((line) => line.indexOf(TAG_FILTER) >= 0);
}

/** Turn "… A00a17/LexiWorkspace: [topic] detail" into { topic, detail, raw }. */
function parseEntry(line) {
  const m = /\/LexiWorkspace: \[([^\]]+)\]\s*(.*)$/.exec(line);
  if (!m) {
    return null;
  }
  let topic = m[1];
  let tail = m[2].trim();
  // 容器把插件侧 console 输出包了一层 [web.console] [lexi] <topic> <json>;拆开才能按真实 topic 断言。
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
  return { topic, tail, detail, raw: line };
}

function logHas(file, needle) {
  return readLogLines(file).some((line) => line.indexOf(needle) >= 0);
}

/** 只在布局恢复帧计次:一次启动只可能恢复一次。 */
function countRestores(file) {
  return readLogLines(file).filter((line) => line.indexOf("[workspace.layout.restore]") >= 0).length;
}

// ---------------------------------------------------------------- assertions

function assertMilestones(lines, steps, ordered = true) {
  const entries = lines.map(parseEntry).filter(Boolean);
  const passed = [];
  const endOf = new Map();
  let cursor = 0;
  const missing = [];

  for (const step of steps) {
    const need = step.repeat || 1;
    const collected = [];
    let scan = step.after && endOf.has(step.after) ? endOf.get(step.after) : (ordered ? cursor : 0);
    while (collected.length < need && scan < entries.length) {
      const entry = entries[scan];
      const topicOk = entry.topic === step.topic;
      const textOk = !step.match || step.match.test(entry.tail);
      const jsonOk = !step.json || (entry.detail !== null && step.json(entry.detail));
      if (topicOk && textOk && jsonOk) {
        collected.push(entry);
      }
      scan += 1;
    }
    if (collected.length < need) {
      missing.push(step.id);
      const hint = entries.slice(cursor).find((entry) => entry.topic === step.topic);
      if (hint) {
        missing.push('  (found ' + step.topic + ' but it did not satisfy the predicate: ' + hint.tail.slice(0, 120) + ')');
      }
      break;
    }
    cursor = scan;
    endOf.set(step.id, scan);
    const first = collected[0];
    passed.push(step.id + '  <-  ' + (first.topic + ' ' + first.tail).slice(0, 120).trim());
  }
  return { passed, missing, entryCount: entries.length };
}

function reportSet(lines, title, steps, ordered = true) {
  const result = assertMilestones(lines, steps, ordered);
  console.log('\n[' + title + '] ' + (result.passed.length + '/' + steps.length) + ' milestones');
  for (const line of result.passed) {
    console.log('  PASS  ' + line);
  }
  if (result.missing.length > 0) {
    console.log('  FAIL  missing milestone: ' + result.missing[0]);
    for (const extra of result.missing.slice(1)) {
      console.log('        ' + extra);
    }
    return false;
  }
  return true;
}

function reportFatal(lines) {
  const entries = lines.map(parseEntry).filter(Boolean);
  // 任何 *.error topic 都算负向证据(插件装载失败不允许被整链路 PASS 掩盖);
  // [object Object] 这类非 JSON tail 只是同一条错误的回显,不做二次计入。
  const hits = entries.filter((entry) => FATAL_TOPICS.indexOf(entry.topic) >= 0
    || (entry.topic.slice(-6) === '.error' && entry.detail !== null));
  console.log('\n[negative] ' + (hits.length === 0 ? 'clean (no error frames)' : hits.length + ' error frames'));
  for (const hit of hits.slice(0, 8)) {
    console.log('  FAIL  ' + (hit.topic + ' ' + hit.tail).slice(0, 160));
  }
  return hits.length === 0;
}

/**
 * 第三方插件异常判定口径（这是"门禁假绿"的直接修复:只查自己打的帧等于自证)。
 *
 * 算：
 *   ARKWEB-CONSOLE 行 + 行内(console 的 source 字段或栈帧)指向插件脚本 lexinote-plugin-<id>.js
 *   + 文本命中 EXCEPTION_PATTERNS:即插件运行时真的抛了。console.error 转发出来的 "[lexinote] listener error …" 的
 *   source 往往落在兼容层的 wrapper 上(shim:299),所以归属不能只看 source 字段，要看整行是否出现插件脚本名。
 *   命中项包括 Uncaught TypeError /
 *   ReferenceError / SyntaxError / RangeError、"x is not a function"、"Cannot read properties of null
 *   (reading 'store')" 这类。
 * 不算：
 *   1) source 指向 lexinote_*.js 的行 —— 那是宿主/兼容层自己打的，不是插件异常；
 *   2) 兼容层显式"未实现 / unsupported / 已退役 / retired"提示 —— 那是声明式缺口，不是异常；
 *   3) LexiPlugin 域(A01051) 的 error 行 —— 那是宿主主动拒绝的日志(capability_denied 等)，
 *      越权探针被正确拒绝时必须出现 error 行，把它算成插件异常会把正确行为判红；
 *   4) ArkCompiler 域(C03f00) 的 Observed/Track/Navigation/AppStorage/Trace is not defined 噪声 ——
 *      构建器注入的宿主噪声，既没有 source 指向插件，也不来自插件代码。
 * 断言：本口径命中的条数必须 = 0。修前基线(.fixtures-out/evidence/20261102-051318)命中 20 条，
 * 全部来自 calendar-beta 的 "reading 'store'" 与 obsidian-text-format 的 "reading 'settings'"。
 */
const EXCEPTION_PATTERNS = [
  /listener error/i,
  /Uncaught\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  /is not a function/,
  /reading '[^']*'/,
  /Cannot read propert/,
  /Cannot set propert/,
  /undefined is not an object/
];
const EXEMPT_PATTERNS = [/未实现/, /unsupported/i, /已退役/, /retired/i];

/** 容器里 console 的落盘形态:… A01194/ARKWEB-CONSOLE: [CONSOLE:14] "<text>", source: <src> (<line>) */
function consoleMessage(line) {
  const at = line.indexOf('[CONSOLE:');
  if (at < 0) {
    return null;
  }
  const head = /^\[CONSOLE:(\d+)\]\s*/.exec(line.slice(at));
  if (!head) {
    return null;
  }
  let rest = line.slice(at + head[0].length);
  let source = '';
  const srcAt = rest.lastIndexOf(', source: ');
  if (srcAt >= 0) {
    source = rest.slice(srcAt + 10).replace(/\s*\(\d+\)\s*$/, '').trim();
    rest = rest.slice(0, srcAt);
  }
  // 日志里是 JSON 字符串字面量,解开才能匹配异常文本(不解开会有转义引号)。
  let text = rest.trim();
  try {
    text = String(JSON.parse(text));
  } catch (err) {
    text = text.replace(/^"|"$/g, '');
  }
  return { level: Number(head[1]), source, text };
}

function pluginAnomalies(lines) {
  const hits = [];
  for (const line of lines) {
    const message = consoleMessage(line);
    if (!message) {
      continue;
    }
    // 归属到插件:整行(含 source 与栈帧)必须出现插件脚本名。宿主/兼容层自己抛的行没有这个标记。
    if (!/lexinote-plugin-[^/\s]*\.js/.test(line)) {
      continue;
    }
    if (EXEMPT_PATTERNS.some((re) => re.test(message.text))) {
      continue;
    }
    if (!EXCEPTION_PATTERNS.some((re) => re.test(message.text))) {
      continue;
    }
    hits.push({ source: message.source || 'plugin', text: message.text });
  }
  return hits;
}

/** 身份判定必须是活的:探针插件的每次装载都会重放这两组请求。 */
const IDENTITY_CHECKS = [
  {
    id: 'identity.forged.denied',
    detail: 'cap-probe-unauth 自报 pluginId=cap-probe-open 请求网络 → 按令牌身份拒绝',
    all: ['capability.net identity=cap-probe-unauth host=127.0.0.1 allowed=false']
  },
  {
    id: 'identity.forged.audit',
    detail: 'payload 自述被忽略并落审计行(claimed≠identity)',
    all: ['identity.ignored method=net.requestUrl identity=cap-probe-unauth claimed=cap-probe-open ignored=true']
  },
  {
    id: 'identity.forged.frame',
    detail: '桥层同一帧也留下 identity/claimed 审计行',
    all: ['frame.identity', 'identity=cap-probe-unauth', 'claimed=cap-probe-open', 'ignored=true']
  },
  {
    id: 'identity.unattributed.failclosed',
    detail: '会话身份(identity 为空)请求网络 → fail-closed 且落日志',
    all: ['capability.net identity=(none) host=127.0.0.1 allowed=false']
  },
  {
    id: 'identity.self.allowed',
    detail: 'cap-probe-open 自己发同一请求 → 放行(能力来自 manifest,不来自 payload)',
    all: ['capability.net identity=cap-probe-open host=127.0.0.1 allowed=true']
  },
  {
    id: 'probe.forged.report',
    detail: '插件侧收到的失败码是 capability_denied',
    all: ['cap.identity.forged', 'allowed=false', 'code=capability_denied']
  },
  {
    id: 'probe.self.report',
    detail: '被冒名方真拿到 200 响应体',
    all: ['cap.identity.self', 'allowed=true', 'status=200']
  }
];

function assertIdentity(lines) {
  let ok = true;
  for (const check of IDENTITY_CHECKS) {
    // 同一条日志行必须同时命中所有片段:不同帧的碎片拼起来不算证据。
    const hit = lines.find((line) => check.all.every((needle) => line.indexOf(needle) >= 0));
    console.log('  ' + (hit ? 'PASS  ' : 'FAIL  ') + check.id + '  ' + check.detail);
    if (!hit) {
      ok = false;
    }
  }
  return ok;
}

function reportAnomalies(lines) {
  const hits = pluginAnomalies(lines);
  console.log('\n[negative] third-party plugin exceptions: ' + (hits.length === 0 ? '0 (clean)' : hits.length + ' (must be 0)'));
  for (const hit of hits.slice(0, 10)) {
    console.log('  FAIL  ' + (hit.source + ' :: ' + hit.text).slice(0, 200));
  }
  if (hits.length > 10) {
    console.log('        … ' + (hits.length - 10) + ' more');
  }
  return hits.length === 0;
}

function reportIdentity(lines) {
  console.log('\n[negative] capability identity (token-sourced)');
  return assertIdentity(lines);
}

/**
 * R2 裁定:静态只能证明 setSessionToken 有调用点,不能证明值到位。
 * 插件 shim 自己打印 session.token tail=<末尾6位|none>,这条是切路由施工单第一项的运行时锚点。
 * 默认只报(PEND),--require-session 才算失败——设备轮前这个值本来就是 none。
 */
function reportSession(lines) {
  const hit = lines.find((line) => line.indexOf('[lexinote] session.token tail=') >= 0);
  const tail = hit ? (hit.match(/tail=(\S+)/) || [])[1] || '' : '';
  const state = hit && tail !== 'none' && tail.length > 0 ? 'PASS' : (REQUIRE_SESSION ? 'FAIL' : 'PEND');
  console.log('\n[anchor] plugin session token (R2)');
  console.log('  ' + state.padEnd(6) + ' session.token tail=' + (tail || '-') + (REQUIRE_SESSION ? '' : '  [--require-session 才断言]'));
  return state !== 'FAIL';
}

function report(file) {
  const allLines = readAllLines(file);
  const lines = allLines.filter((line) => line.indexOf(TAG_FILTER) >= 0);
  const entries = lines.map(parseEntry).filter(Boolean);
  console.log('log: ' + file + '  (' + allLines.length + ' lines total, ' + lines.length + ' LexiWorkspace, ' + entries.length + ' parsed)');
  const regression = reportSet(lines, 'regression', MILESTONES);
  const real = reportSet(lines, 'real', REAL_MILESTONES);
  const protocol = reportSet(lines, 'protocol', PROTOCOL_MILESTONES, false);
  const layout = reportSet(lines, 'layout-lifecycle', LAYOUT_MILESTONES, false);
  const editor = reportSet(lines, 'editor-extension', EDITOR_MILESTONES, false);
  const negative = reportFatal(lines);
  const anomalies = reportAnomalies(allLines);
  const identity = reportIdentity(allLines);
  const session = reportSession(allLines);
  return regression && real && protocol && layout && editor && negative && anomalies && identity && session;
}

// ---------------------------------------------------------------- probe server

/**
 * 身份正反证据要一个"真实网络端点":设备(插件)侧访问 http://127.0.0.1:18080/netprobe/hello.txt,
 * 由 hdc rport(反向:设备监听 → 宿主)接到这里的宿主 http 服务。
 * 用 fport 是反方向,设备侧没人监听,插件侧只会拿到 ECONNREFUSED,证据就假了。
 */
function startProbeServer() {
  const body = Buffer.from(NET_BODY);
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === NET_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve(server));
  });
}

function ensureReverseForward() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    run(['fport', 'rm', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000 });
    run(['rport', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000 });
    const listed = run(['fport', 'ls'], { timeout: 60000 });
    if (listed.out.indexOf('tcp:' + PORT + ' tcp:' + PORT) >= 0 && listed.out.indexOf('[Reverse]') >= 0) {
      console.log('forward: device tcp:' + PORT + ' -> host tcp:' + PORT + '  [Reverse]');
      return true;
    }
    console.log('forward retry ' + attempt + ': ' + listed.out.trim().slice(0, 160));
  }
  return false;
}

// ---------------------------------------------------------------- live run

async function live(outDirOverride) {
  const devices = targets();
  if (devices.length === 0) {
    console.log('device: none reachable via ' + HDC);
    process.exit(2);
  }
  const device = devices[0];
  console.log('device: ' + device);

  const dir = outDirOverride || path.join(OUT_ROOT, stamp());
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'hilog.log');

  if (!fs.existsSync(HAP)) {
    console.log('hap: missing ' + HAP + ' (run hvigorw assembleHap first)');
    process.exit(1);
  }
  console.log('hap: ' + HAP);
  console.log('out: ' + dir);

  const probeServer = await startProbeServer();
  console.log('netprobe: http://127.0.0.1:' + PORT + NET_PATH + ' (' + NET_BODY.length + 'B, host side)');
  if (!ensureReverseForward()) {
    console.log('FATAL: reverse port forward failed, identity evidence cannot be collected');
    probeServer.close();
    process.exit(2);
  }

  const logFd = fs.openSync(logFile, 'w');
  const logChild = spawn(HDC, ['shell', 'hilog'], { stdio: ['ignore', logFd, logFd] });

  try {
    const install = run(['install', '-r', HAP], { timeout: 180000 });
    const installed = install.out.indexOf('successfully') >= 0;
    console.log('install: ' + (installed ? 'successfully' : 'FAILED'));
    fs.writeFileSync(path.join(dir, 'install.txt'), install.out);
    if (!installed) {
      process.exit(1);
    }

    run(['shell', 'aa', 'force-stop', BUNDLE], { timeout: 60000 });
    run(['shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE], { timeout: 60000 });
    console.log('launch: ' + BUNDLE + '/' + ABILITY);
    await sleep(4000);

    // Coordinates are discovered per run: this device is a resizable desktop window with no wm size.
    const dockDump = await waitFor('dock', () => {
      const list = dumpLayout(dir, 'layout-dock');
      return findById(list, 'workspace-action-dock-profile') ? list : null;
    }, 20000);
    click(findById(dockDump, 'workspace-action-dock-profile'));
    console.log('nav: opened settings via workspace-action-dock-profile');

    const navDump = await waitFor('settings plugin category', () => {
      const list = dumpLayout(dir, 'layout-settings');
      return findByText(list, /^插件$/, true) ? list : null;
    }, 15000);
    click(findByText(navDump, /^插件$/, true));
    console.log('nav: opened 插件 category');

    const entryDump = await waitFor('workspace entry row', () => {
      const list = dumpLayout(dir, 'layout-entry');
      return findById(list, 'plugin-workspace-entry') ? list : null;
    }, 15000);
    click(findById(entryDump, 'plugin-workspace-entry'));
    console.log('nav: opened workspace/LexiWorkspacePage');

    await waitFor('workspace page', () => {
      const list = dumpLayout(dir, 'layout-page');
      const web = list.find((attrs) => attrs.type === 'Web' && /lexinote_workspace\.html/.test(attrs.text || attrs.src || ''));
      return web || (logHas(logFile, 'web.page.begin') ? true : null);
    }, 20000);

    await waitFor('channel ready', () => logHas(logFile, 'channel.auth') && logHas(logFile, 'workspace.ready'), 25000);

    // Trigger the palette command from the page UI; the page self-check may have done it already.
    // dumpLayout sometimes returns the bare desktop while the window is still animating, so retry.
    let paletteButton = null;
    for (let attempt = 0; attempt < 6 && !paletteButton; attempt += 1) {
      await sleep(700);
      paletteButton = findByText(dumpLayout(dir, 'layout-page-ready'), /命令面板/);
    }
    if (paletteButton) {
      click(paletteButton);
      await sleep(900);
      const paletteDump = dumpLayout(dir, 'layout-palette');
      const item = findByText(paletteDump, /示例插件/);
      if (item) {
        click(item);
        console.log('trigger: palette -> 示例插件 command');
      } else {
        console.log('trigger: palette item not exposed by uitest (page self-check used instead)');
      }
    } else {
      console.log('trigger: 命令面板 button not exposed (page self-check used instead)');
    }

    await waitFor('notice.render', () => logHas(logFile, 'notice.render'), 20000);
    // 20s 超时自检在页面启动约 1.5s 后发起,必须等它落日志(超时帧本身要 20s)。
    await waitFor('frame.timeout.selfcheck', () => logHas(logFile, 'frame.timeout.selfcheck'), 40000);
    // 布局持久化必须跨进程:杀掉应用再启动,calendar/compat-probe 的视图要自己回来。
    run(['shell', 'aa', 'force-stop', BUNDLE], { timeout: 60000 });
    await sleep(1500);
    run(['shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE], { timeout: 60000 });
    console.log('relaunch: ' + BUNDLE + ' (layout persistence check)');
    await sleep(4500);
    const dock2 = await waitFor('dock (relaunch)', () => {
      const list = dumpLayout(dir, 'layout-dock-relaunch');
      return findById(list, 'workspace-action-dock-profile') ? list : null;
    }, 25000);
    click(findById(dock2, 'workspace-action-dock-profile'));
    const nav2 = await waitFor('settings plugin category (relaunch)', () => {
      const list = dumpLayout(dir, 'layout-settings-relaunch');
      return findByText(list, /^插件$/, true) ? list : null;
    }, 15000);
    click(findByText(nav2, /^插件$/, true));
    const entry2 = await waitFor('workspace entry row (relaunch)', () => {
      const list = dumpLayout(dir, 'layout-entry-relaunch');
      return findById(list, 'plugin-workspace-entry') ? list : null;
    }, 15000);
    click(findById(entry2, 'plugin-workspace-entry'));
    await waitFor('layout restore (relaunch)', () => countRestores(logFile) >= 2, 30000);
    console.log('relaunch: layout restored ' + countRestores(logFile) + ' time(s)');

  } catch (err) {
    console.log('flow error: ' + (err && err.message ? err.message : String(err)));
  } finally {
    logChild.kill();
    fs.closeSync(logFd);
    run(['fport', 'rm', 'tcp:' + PORT, 'tcp:' + PORT], { timeout: 60000 });
    probeServer.close();
  }

  const ok = report(logFile);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    device,
    hap: HAP,
    log: path.relative(REPO, logFile),
    result: ok ? 'pass' : 'fail',
    milestones: MILESTONES.map((step) => step.id),
    realMilestones: REAL_MILESTONES.map((step) => step.id),
    protocolMilestones: PROTOCOL_MILESTONES.map((step) => step.id),
    layoutMilestones: LAYOUT_MILESTONES.map((step) => step.id),
    editorMilestones: EDITOR_MILESTONES.map((step) => step.id),
  }, null, 2) + '\n');
  console.log('result: ' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- entry

function main() {
  const argv = process.argv.slice(2);
  REQUIRE_SESSION = argv.indexOf('--require-session') >= 0;
  const checkOnlyIdx = argv.indexOf('--check-only');
  if (checkOnlyIdx >= 0) {
    const target = argv[checkOnlyIdx + 1];
    if (!target) {
      console.log('usage: --check-only <evidence dir | hilog file>');
      process.exit(1);
    }
    let logFile = path.resolve(REPO, target);
    if (fs.existsSync(logFile) && fs.statSync(logFile).isDirectory()) {
      const candidates = fs.readdirSync(logFile).filter((name) => /\.log$/.test(name)).sort();
      if (candidates.length === 0) {
        console.log('no *.log in ' + logFile);
        process.exit(1);
      }
      logFile = path.join(logFile, candidates[candidates.length - 1]);
    }
    if (!fs.existsSync(logFile)) {
      console.log('missing log: ' + logFile);
      process.exit(1);
    }
    const ok = report(logFile);
    console.log('result: ' + (ok ? 'PASS' : 'FAIL') + ' (check-only)');
    process.exit(ok ? 0 : 1);
  }
  const outIdx = argv.indexOf('--out');
  live(outIdx >= 0 ? path.resolve(REPO, argv[outIdx + 1]) : null);
}

main();
