#!/usr/bin/env node
'use strict';
// 容器启动门禁(纯离线,只读 hilog 文本,不碰设备):证明「进页面 -> Web 真的开始加载 -> 加载完」这条链。
//
// 为什么需要它:D4 的真实现象是 aa force-stop + start 后第一次点进容器,整整 70 秒没有
// [web.page.begin],用户停在「启动中…」。这里把那次空洞变成一条可重放的红灯:同一份旧日志
// 必须 FAIL 到具体行号,修完的新日志必须 PASS。
//
// 七条判据,每条都打印真实的 日志:行号 + 该行原文:
// A 每个 [page.appear] 之后 3000ms 内必须有 [web.page.begin];
// B 每个 [web.page.begin] 之后 15000ms 内必须有 [web.page.end];
// C 每份文档最多 1 次宿主侧 [channel.port.attached](detail 含 tag=),页面侧自称的那条
//   (detail={},来自 tools/workspace-bundle/src/main.ts 的 note('channel.port.attached', {}))
//   也各有上限 1;两条不是同一个来源,所以分开数而不是把它们加在一起。
//   「一份文档」= 相邻两次 [web.page.begin] 之间的区间:ArkWeb 在页面自我重载时会换渲染进程
//   重新 begin,新文档本来就要挂自己的端口,所以按文档数而不是按页面实例数。同一份文档里
//   挂两次端口仍然 FAIL(那才是重复 postMessage)。
// D 出现 [web.boot.retry] 的页面实例里不得伴随 [channel.open.skip] port already attached
//   (自愈重载前必须先摘掉旧端口,否则重载后的 hello 会被 skip 掉,端口就永远没了);
// E 日志里不得出现 [web.boot.error](loadUrl 只在 controller 关联后发起,不该抛);
// F 每实例首个 [web.boot.load] 必须是 attempt=1 + reason=controller.attached,且不得早于
//   [web.controller.attached](否则就是又一次"控制器还没关联就先加载");
// G 每实例 [web.boot.load] 次数 <= 2(自愈重试用掉一次是上限,不许无限重来);
// H 每个 [channel.open.request] 之后要么出现 [channel.port.attached](host 或 page 侧都算),
//   要么该 request 之前已经出现过 [channel.port.reset];出现 [channel.open.skip] port already attached
//   直接判 FAIL —— skip 等于新文档拿不到端口;
// I 文档活性:每个 [web.page.begin] 之后到下一个 begin / 实例结束之间,只要这份文档里的页面
//   hello 过([channel.open.request]),就必须至少有 1 条 [channel.frame.in]。没有 hello 的窗口
//   (例如自愈重试时被下一个 begin 在 1ms 内顶掉的空文档)不算失败,但会打印出来。
//
// 用法: node scripts/tests/workspace-boot-evidence.cjs --log <hilog 文件>
const fs = require('node:fs');
const path = require('node:path');

const BEGIN_BUDGET_MS = 3000;
const END_BUDGET_MS = 15000;
const LOAD_MAX = 2;

function usage(why) {
  if (why) { console.log('FAIL  ' + why); }
  console.log('usage: node scripts/tests/workspace-boot-evidence.cjs --log <hilog file>');
  process.exit(2);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) { return process.argv[i + 1]; }
  return '';
}

const logPath = argValue('--log') || argValue('--log-file');
if (!logPath) { usage('missing --log <path>'); }
const resolved = path.resolve(logPath);
if (!fs.existsSync(resolved)) { usage('log not found: ' + resolved); }

const raw = fs.readFileSync(resolved, 'utf8');
const rel = path.relative(path.resolve(__dirname, '..', '..'), resolved).split(path.sep).join('/') || resolved;
const lines = raw.split(/\r?\n/);

// "11-02 14:35:45.502  7885  7885 I A00a17/LexiWorkspace: [page.appear] ..."
const LINE_RE = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d\d\d)\s+\d+\s+\d+\s+\w+\s+\S*LexiWorkspace:\s?(.*)$/;
const TOPIC_RE = /^\[([^\]]+)\]\s?([\s\S]*)$/;

function stamp(month, day, h, m, s, ms) {
  // 伪天序号:只用它做同日/跨日的单调排序,不参与任何日历换算。
  const dayIndex = (Number(month) * 31 + Number(day));
  return dayIndex * 86400000 + Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms);
}

const events = [];
lines.forEach(function (text, index) {
  const m = LINE_RE.exec(text);
  if (!m) { return; }
  const body = TOPIC_RE.exec(m[7]);
  if (!body) { return; }
  events.push({
    line: index + 1,
    topic: body[1],
    detail: body[2],
    at: stamp(m[1], m[2], m[3], m[4], m[5], m[6]),
    clock: m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6] + '.' + m[7],
    text: text
  });
});

if (events.length === 0) {
  console.log('FAIL  ' + rel + ': no LexiWorkspace hilog line found (wrong file?)');
  process.exit(1);
}

function at(ev) { return rel + ':' + ev.line + ': ' + ev.text.trim(); }

// ---------------------------------------------------------------- 切分页面实例
const instances = [];
events.forEach(function (ev) {
  if (ev.topic === 'page.appear') {
    instances.push({ appear: ev, events: [], index: instances.length + 1 });
    return;
  }
  if (instances.length === 0) { return; }
  instances[instances.length - 1].events.push(ev);
});

function topicIn(inst, topic) {
  return inst.events.filter(function (ev) { return ev.topic === topic; });
}

// ---------------------------------------------------------------- 判据
const results = [];
function check(name, run) {
  let outcome;
  try { outcome = run(); } catch (err) { outcome = { ok: false, evidence: ['exception: ' + (err && err.message ? err.message : String(err))] }; }
  results.push({ name: name, ok: outcome.ok, evidence: outcome.evidence || [], expected: outcome.expected || '' });
}

check('A 每个 [page.appear] 之后 ' + BEGIN_BUDGET_MS + 'ms 内出现 [web.page.begin]', function () {
  const broken = [];
  instances.forEach(function (inst) {
    const begins = topicIn(inst, 'web.page.begin');
    const first = begins.length > 0 ? begins[0] : null;
    if (first === null) {
      broken.push(at(inst.appear) + '  -> 本次页面实例内没有任何 [web.page.begin]');
      return;
    }
    const gap = first.at - inst.appear.at;
    if (gap > BEGIN_BUDGET_MS) {
      broken.push(at(inst.appear) + '  -> 下一个 [web.page.begin] 在 ' + rel + ':' + first.line
        + ' (' + first.clock + '),间隔 ' + gap + 'ms > ' + BEGIN_BUDGET_MS + 'ms');
    }
  });
  return {
    ok: broken.length === 0,
    expected: '每个页面实例的 [page.appear] 到首个 [web.page.begin] 都 <= ' + BEGIN_BUDGET_MS + 'ms',
    evidence: broken.length > 0 ? broken : [rel + ': ' + instances.length + ' 个页面实例,个个都在预算内']
  };
});

check('B 每个 [web.page.begin] 之后 ' + END_BUDGET_MS + 'ms 内出现 [web.page.end]', function () {
  const broken = [];
  let paired = 0;
  instances.forEach(function (inst) {
    const begins = topicIn(inst, 'web.page.begin');
    const ends = topicIn(inst, 'web.page.end');
    begins.forEach(function (begin) {
      const end = ends.find(function (ev) { return ev.at >= begin.at; });
      if (!end) {
        broken.push(at(begin) + '  -> 本次页面实例内它之后没有 [web.page.end]');
        return;
      }
      const gap = end.at - begin.at;
      if (gap > END_BUDGET_MS) {
        broken.push(at(begin) + '  -> [web.page.end] 在 ' + rel + ':' + end.line + ' (' + end.clock + '),间隔 ' + gap + 'ms > ' + END_BUDGET_MS + 'ms');
        return;
      }
      paired += 1;
    });
  });
  return {
    ok: broken.length === 0,
    expected: '每个 [web.page.begin] 后 ' + END_BUDGET_MS + 'ms 内都要有 [web.page.end]',
    evidence: broken.length > 0 ? broken : [rel + ': ' + paired + ' 对 begin/end,最长间隔在预算内']
  };
});

check('C 每份文档最多 1 次宿主侧 [channel.port.attached](重载出的多份文档各算一份)', function () {
  const broken = [];
  const observed = [];
  instances.forEach(function (inst) {
    const begins = topicIn(inst, 'web.page.begin');
    const docs = begins.map(function (begin, i) {
      const to = i + 1 < begins.length ? begins[i + 1].line : Infinity;
      return { label: 'doc#' + (i + 1) + '(begin ' + rel + ':' + begin.line + ')', from: begin.line, to: to, host: [], page: [] };
    });
    const preLabel = 'doc#0(首个 begin 之前)';
    const pre = { label: preLabel, from: -Infinity, to: begins.length > 0 ? begins[0].line : Infinity, host: [], page: [] };
    const all = topicIn(inst, 'channel.port.attached');
    all.forEach(function (ev) {
      const doc = docs.find(function (d) { return ev.line > d.from && ev.line < d.to; }) || pre;
      if (ev.detail.indexOf('tag=') >= 0) { doc.host.push(ev); } else { doc.page.push(ev); }
    });
    const buckets = (pre.host.length + pre.page.length) > 0 ? [pre].concat(docs) : docs;
    buckets.forEach(function (doc) {
      observed.push('instance#' + inst.index + ' ' + doc.label + ': host=' + doc.host.length + ' page=' + doc.page.length);
      if (doc.host.length > 1) {
        broken.push(at(doc.host[1]) + '  -> 同一份文档里宿主第二次 postMessage 端口(第一次在 ' + rel + ':' + doc.host[0].line + ')');
      }
      if (doc.page.length > 1) {
        broken.push(at(doc.page[1]) + '  -> 同一份文档里页面侧第二次自称收到端口(第一次在 ' + rel + ':' + doc.page[0].line + ')');
      }
    });
  });
  return {
    ok: broken.length === 0,
    expected: '同一份文档 host<=1 且 page<=1(两条来源不同:host 是 WorkspaceLog,page 是 main.ts 的 note)',
    evidence: broken.length > 0 ? broken : observed
  };
});

check('D 有 [web.boot.retry] 的页面实例不得伴随 [channel.open.skip] port already attached', function () {
  const broken = [];
  const retried = [];
  instances.forEach(function (inst) {
    const retries = topicIn(inst, 'web.boot.retry');
    if (retries.length === 0) { return; }
    retried.push('instance#' + inst.index + ': retry 行 ' + retries.map(function (ev) { return 'line ' + ev.line; }).join(', '));
    const skips = topicIn(inst, 'channel.open.skip').filter(function (ev) { return ev.detail.indexOf('port already attached') >= 0; });
    skips.forEach(function (ev) {
      broken.push(at(ev) + '  -> 重载后页面重新 hello 时端口还挂着(自愈路径没先摘端口)');
    });
  });
  return {
    ok: broken.length === 0,
    expected: '重载前先 close/null 旧端口,重载后的 hello 不得撞上 port already attached',
    evidence: broken.length > 0 ? broken : (retried.length > 0 ? retried : ['本次日志没有 [web.boot.retry](首进即成功)'])
  };
});

check('E 日志里不得出现 [web.boot.error]', function () {
  const errs = events.filter(function (ev) { return ev.topic === 'web.boot.error'; });
  return {
    ok: errs.length === 0,
    expected: '首次加载只在 controller 关联后发起,loadUrl 不得抛错',
    evidence: errs.length > 0 ? errs.map(at) : ['没有 [web.boot.error]']
  };
});

check('F 每实例首个 [web.boot.load] 必须是 attempt=1 + reason=controller.attached,且不早于 [web.controller.attached]', function () {
  const broken = [];
  const observed = [];
  instances.forEach(function (inst) {
    const loads = topicIn(inst, 'web.boot.load');
    if (loads.length === 0) {
      broken.push(at(inst.appear) + '  -> 本次页面实例内没有任何 [web.boot.load]');
      return;
    }
    const first = loads[0];
    const attempt = (/attempt=(\d+)/.exec(first.detail) || [])[1] || '?';
    const reason = (/reason=(\S+)/.exec(first.detail) || [])[1] || '?';
    const attached = topicIn(inst, 'web.controller.attached');
    observed.push('instance#' + inst.index + ': 首个 load 在 ' + rel + ':' + first.line
      + ' attempt=' + attempt + ' reason=' + reason
      + (attached.length > 0 ? ', controller.attached 在 ' + rel + ':' + attached[0].line : ', 没有 controller.attached'));
    if (attempt !== '1') {
      broken.push(at(first) + '  -> 首个 [web.boot.load] 不是 attempt=1(attempt=' + attempt + ')');
    }
    if (reason !== 'controller.attached') {
      broken.push(at(first) + '  -> 首个 [web.boot.load] 的 reason 不是 controller.attached(reason=' + reason + ')');
    }
    if (attached.length === 0) {
      broken.push(at(first) + '  -> 同一实例里没有 [web.controller.attached],加载早于控制器关联');
    } else if (first.line < attached[0].line) {
      broken.push(at(first) + '  -> 它早于 [web.controller.attached](' + rel + ':' + attached[0].line + '),控制器还没关联就 loadUrl');
    }
  });
  return {
    ok: broken.length === 0,
    expected: '首次加载只由 onControllerAttached 发起:attempt=1、reason=controller.attached、不早于 controller.attached',
    evidence: broken.length > 0 ? broken : observed
  };
});

check('G 每实例 [web.boot.load] 次数 <= ' + LOAD_MAX, function () {
  const broken = [];
  const observed = [];
  instances.forEach(function (inst) {
    const loads = topicIn(inst, 'web.boot.load');
    observed.push('instance#' + inst.index + ': load 次数=' + loads.length
      + (loads.length > 0 ? ' (line ' + loads.map(function (ev) { return ev.line; }).join(', ') + ')' : ''));
    if (loads.length > LOAD_MAX) {
      broken.push(at(loads[LOAD_MAX]) + '  -> 第 ' + (LOAD_MAX + 1) + ' 次 loadUrl,超过自愈重试上限');
    }
  });
  return {
    ok: broken.length === 0,
    expected: '每实例 loadUrl 次数 <= ' + LOAD_MAX,
    evidence: broken.length > 0 ? broken : observed
  };
});

check('H 每个 [channel.open.request] 之后必须有 [channel.port.attached],或它之前出现过 [channel.port.reset]', function () {
  const broken = [];
  const observed = [];
  instances.forEach(function (inst) {
    const reqs = topicIn(inst, 'channel.open.request');
    const resets = topicIn(inst, 'channel.port.reset');
    const attaches = topicIn(inst, 'channel.port.attached');
    const skips = topicIn(inst, 'channel.open.skip').filter(function (ev) {
      return ev.detail.indexOf('port already attached') >= 0;
    });
    skips.forEach(function (ev) {
      broken.push(at(ev) + '  -> 页面重新 hello 时端口还挂着,这份文档再也拿不到端口(通道静默变哑)');
    });
    reqs.forEach(function (req) {
      const attachedAfter = attaches.find(function (ev) { return ev.line > req.line; });
      const resetBefore = resets.find(function (ev) { return ev.line < req.line; });
      if (attachedAfter) {
        observed.push('instance#' + inst.index + ': request ' + rel + ':' + req.line + ' -> attached ' + rel + ':' + attachedAfter.line);
        return;
      }
      if (resetBefore) {
        observed.push('instance#' + inst.index + ': request ' + rel + ':' + req.line + ' -> 端口在 ' + rel + ':' + resetBefore.line + ' 已摘掉');
        return;
      }
      broken.push(at(req) + '  -> 这次 hello 之后没有任何 [channel.port.attached],之前也没有 [channel.port.reset]');
    });
  });
  return {
    ok: broken.length === 0,
    expected: '每次 hello 都要么挂上端口、要么先前已摘端口;不得出现 port already attached',
    evidence: broken.length > 0 ? broken : (observed.length > 0 ? observed : ['本次日志没有 [channel.open.request]'])
  };
});

check('I 每个 hello 过的文档([web.page.begin] 之后有 [channel.open.request])至少有 1 条 [channel.frame.in]', function () {
  const broken = [];
  const observed = [];
  instances.forEach(function (inst) {
    const begins = topicIn(inst, 'web.page.begin');
    const frames = topicIn(inst, 'channel.frame.in');
    const reqs = topicIn(inst, 'channel.open.request');
    begins.forEach(function (begin, i) {
      const nextAt = i + 1 < begins.length ? begins[i + 1].line : Infinity;
      const windowReqs = reqs.filter(function (ev) { return ev.line > begin.line && ev.line < nextAt; });
      const windowFrames = frames.filter(function (ev) { return ev.line > begin.line && ev.line < nextAt; });
      const tail = nextAt === Infinity ? '实例结束' : rel + ':' + nextAt;
      if (windowReqs.length === 0) {
        observed.push('instance#' + inst.index + ' begin ' + rel + ':' + begin.line + ' -> ' + tail + ': 这份文档没有 hello,不判(空文档)');
        return;
      }
      if (windowFrames.length > 0) {
        observed.push('instance#' + inst.index + ' begin ' + rel + ':' + begin.line + ' -> ' + tail + ': request ' + windowReqs.length + ', frame.in ' + windowFrames.length + '(首个 ' + rel + ':' + windowFrames[0].line + ')');
        return;
      }
      broken.push(at(begin) + '  -> 这份文档 hello 过(' + rel + ':' + windowReqs[0].line + '),但到 ' + tail + ' 之间一条 [channel.frame.in] 都没有:页面渲染了,通道是哑的');
    });
  });
  return {
    ok: broken.length === 0,
    expected: 'hello 过的文档里宿主必须收到过至少 1 帧',
    evidence: broken.length > 0 ? broken : observed
  };
});

// ---------------------------------------------------------------- 输出
let failed = 0;
results.forEach(function (r) {
  if (r.ok) {
    console.log('PASS  ' + r.name);
  } else {
    failed += 1;
    console.log('FAIL  ' + r.name);
    if (r.expected) { console.log('      expected: ' + r.expected); }
  }
  r.evidence.slice(0, 6).forEach(function (line) { console.log('      -> ' + line); });
});

console.log('');
console.log('log:        ' + rel);
console.log('instances:  ' + instances.length + ' (首个 [page.appear] 在 ' + rel + ':' + (instances[0] ? instances[0].appear.line : '?') + ')');
console.log('assertions: ' + results.length + ', passed: ' + (results.length - failed) + ', failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
