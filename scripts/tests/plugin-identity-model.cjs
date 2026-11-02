'use strict';
// 共享静态模型：把"谁消费身份 / 身份从哪条链来"从源码里抽出来，
// 供 plugin-identity-delivery.cjs（令牌下发门禁）与 plugin-route-coverage.cjs（路由覆盖报告）复用。
// 只读源码，不连设备、不构建。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKTICK = String.fromCharCode(96);
const PATHS = {
  ets: path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets'),
  shim: path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js'),
  bridge: path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceBridge.ets'),
  host: path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginRuntimeHost.ets'),
  index: path.join(ROOT, 'entry/src/main/ets/pages/Index.ets'),
  runtimeHtml: path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_runtime.html'),
  wsShim: path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_workspace_shim.js')
};

const SHORT = {
  'lexinote_plugin_shim.js': 'shim',
  'LexiPluginRuntime.ets': 'LexiPluginRuntime',
  'WorkspaceBridge.ets': 'WorkspaceBridge',
  'LexiPluginRuntimeHost.ets': 'RuntimeHost',
  'Index.ets': 'Index',
  'lexinote_workspace_shim.js': 'wsShim'
};

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function short(file) {
  return SHORT[path.basename(file)] || path.basename(file);
}

function indentOf(line) {
  const m = line.match(/^\s*/);
  return m ? m[0].length : 0;
}

// 从 openIndex（指向 '('）开始做括号配对，返回顶层参数数组。
function splitArgs(text, openIndex) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = '';
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += text[i + 1] || ''; i++; continue; }
      if (ch === quote) { quote = ''; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === BACKTICK) { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 1) { continue; }
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { args.push(current.trim()); return { args, end: i }; }
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  return { args, end: text.length };
}

function parseHandlers() {
  const text = readLines(PATHS.ets).join('\n');
  const handlers = [];
  const re = /registerHandler\('([^']+)'\s*,\s*async\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    const paramNames = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((p) => p.split(':')[0].trim());
    handlers.push({
      method: m[1],
      line,
      params: paramNames,
      consumesIdentity: paramNames.length >= 2 && paramNames[1] === 'identity'
    });
  }
  return handlers;
}

// 处理器体：从 registerHandler 行到同缩进的 '});'（用于查"handler 回头读 payload.pluginId"的回潮）。
function handlerBodies() {
  const lines = readLines(PATHS.ets);
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/registerHandler\('([^']+)'/);
    if (!m) { continue; }
    const baseIndent = indentOf(lines[i]);
    const body = [];
    for (let j = i; j < lines.length && j < i + 150; j++) {
      if (j > i && indentOf(lines[j]) <= baseIndent && /^\}\);?\s*$/.test(lines[j].trim())) { break; }
      body.push(lines[j]);
    }
    out.set(m[1], { startLine: i + 1, text: body.join('\n') });
  }
  return out;
}

function parseHostCalls() {
  const text = readLines(PATHS.shim).join('\n');
  const lines = text.split('\n');
  const calls = [];
  const re = /hostCall\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    if (/function hostCall\s*\(/.test(lines[line - 1])) { continue; }
    const { args } = splitArgs(text, m.index + 'hostCall'.length);
    const methodArg = (args[0] || '').trim();
    const literal = methodArg.match(/^'([^']*)'$/);
    calls.push({
      line,
      source: lines[line - 1].trim(),
      method: literal ? literal[1] : null,
      methodExpr: methodArg,
      argCount: args.length,
      payload: (args[1] || '').trim(),
      tokenExpr: args.length >= 3 ? (args[2] || '').trim() : null
    });
  }
  return calls;
}

function parseDispatchSites() {
  const lines = readLines(PATHS.ets);
  const sites = [];
  lines.forEach((line, i) => {
    const m = line.match(/runtime\.dispatch(?:WithTimeout)?\('([^']+)'/);
    if (m) { sites.push({ method: m[1], line: i + 1, source: line.trim(), index: i }); }
  });
  return sites;
}

// 取 dispatch 前最近一个对象字面量的键集合（'token' / 'identity' 是否存在）。
function payloadKeysNear(etsLines, dispatchIndex) {
  for (let i = dispatchIndex - 1; i >= Math.max(0, dispatchIndex - 60); i--) {
    const line = etsLines[i];
    const open = line.match(/(?:const|let|var)\s+[A-Za-z0-9_$]+\s*(?::[^=]+)?=\s*\{\s*$/);
    if (!open) { continue; }
    const baseIndent = indentOf(line);
    const keys = [];
    for (let j = i + 1; j < etsLines.length; j++) {
      if (indentOf(etsLines[j]) <= baseIndent && /^\};?\s*$/.test(etsLines[j].trim())) { break; }
      const k = etsLines[j].match(/'([^']+)'\s*:/);
      if (k) { keys.push(k[1]); }
    }
    return { line: i + 1, keys };
  }
  const inline = etsLines.slice(Math.max(0, dispatchIndex - 6), dispatchIndex).join('\n');
  const keys = [];
  let km;
  const kre = /'([^']+)'\s*:/g;
  while ((km = kre.exec(inline)) !== null) { keys.push(km[1]); }
  return { line: Math.max(1, dispatchIndex - 5), keys };
}

function mechanisms() {
  const shimLines = readLines(PATHS.shim);
  const shimText = shimLines.join('\n');
  const etsText = readLines(PATHS.ets).join('\n');
  const bindRootsMatch = shimText.match(/API_BIND_ROOTS\s*=\s*\[([^\]]*)\]/);
  const bindRoots = bindRootsMatch
    ? bindRootsMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : [];
  const wrappers = new Set();
  const wrapMatch = shimText.match(/\[([^\]]*)\]\.forEach\(function \(name\)/);
  if (wrapMatch) {
    wrapMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).forEach((n) => wrappers.add(n));
  }
  return {
    bindRoots,
    wrappers,
    wrappedByWithToken: /withToken\(self\.__lexiToken/.test(shimText),
    bindAppliedInLoad: /bindApiToken\([^;\n]*message\.token[^;\n]*\)/.test(shimText),
    hostCallFallsBackToCurrentToken: /token === undefined \? currentToken\(\) : token/.test(shimText),
    handlerCount: (etsText.match(/registerHandler\('/g) || []).length
  };
}

const TOKEN_SOURCES = [
  /message\.token/,
  /__lexiToken/,
  /tokenForPluginId\(/,
  /\bentry\.token\b/,
  /\bpluginToken\b/,
  /\bloadToken\b/
];

function traceIdentifier(ident, shimLines, depth) {
  const level = typeof depth === 'number' ? depth : 0;
  if (level > 3) { return null; }
  const re = new RegExp('(?:var|let|const)\\s+' + ident + '\\s*=\\s*(.+)');
  for (let i = 0; i < shimLines.length; i++) {
    const m = shimLines[i].match(re);
    if (!m) { continue; }
    const rhs = m[1].trim();
    if (TOKEN_SOURCES.some((r) => r.test(rhs))) { return { line: i + 1, rhs, ok: true }; }
    const nested = rhs.match(/^([A-Za-z_$][\w$]*)$/);
    if (nested) {
      const inner = traceIdentifier(nested[1], shimLines, level + 1);
      if (inner) { return { line: i + 1, rhs, ok: true, via: inner }; }
    }
    return { line: i + 1, rhs, ok: false };
  }
  return null;
}

function enclosingFunction(shimLines, lineIndex) {
  const siteIndent = indentOf(shimLines[lineIndex]);
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = shimLines[i];
    if (!line.trim()) { continue; }
    if (indentOf(line) >= siteIndent) { continue; }
    const m = line.match(/function\s+([A-Za-z0-9_$]+)\s*\(/) ||
      line.match(/([A-Za-z0-9_$.]+)\s*=\s*function\s*\(/) ||
      line.match(/^\s*([A-Za-z0-9_$]+)\s*:\s*function\s*\(/);
    if (m) { return { name: m[1].split('.').pop(), line: i + 1 }; }
  }
  return null;
}

function enclosingContainer(shimLines, lineIndex) {
  const siteIndent = indentOf(shimLines[lineIndex]);
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = shimLines[i];
    const m = line.match(/^\s*(?:var|let|const)\s+([A-Za-z0-9_$]+)\s*=\s*\{\s*$/);
    if (m && indentOf(line) < siteIndent) { return { name: m[1], line: i + 1 }; }
  }
  return null;
}

function classifyTokenSite(call, ctx) {
  const shimLines = ctx.shimLines;
  if (call.tokenExpr !== null) {
    if (/^(undefined|null|''|""|currentToken\(\))$/.test(call.tokenExpr)) {
      return { kind: 'none', detail: '第三参是 ' + call.tokenExpr + '（运行时回落会话令牌）' };
    }
    if (TOKEN_SOURCES.some((r) => r.test(call.tokenExpr))) {
      return { kind: 'explicit', detail: '第三参 ' + call.tokenExpr };
    }
    const ident = call.tokenExpr.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident) {
      const trace = traceIdentifier(ident[1], shimLines);
      if (!trace) { return { kind: 'unknown-token', detail: call.tokenExpr + ' 找不到赋值点' }; }
      if (!trace.ok) {
        return { kind: 'unknown-token', detail: call.tokenExpr + ' ← ' + short(PATHS.shim) + ':' + trace.line + ' ' + trace.rhs };
      }
      return { kind: 'explicit', detail: call.tokenExpr + ' ← ' + short(PATHS.shim) + ':' + trace.line + ' ' + trace.rhs };
    }
    return { kind: 'unknown-token', detail: call.tokenExpr };
  }
  const fn = enclosingFunction(shimLines, call.line - 1);
  if (fn && ctx.mech.wrappers.has(fn.name) && ctx.mech.wrappedByWithToken) {
    return { kind: 'wrapper', detail: fn.name + ' 被 withToken(self.__lexiToken) 包装（' + short(PATHS.shim) + ':' + fn.line + '）' };
  }
  const container = enclosingContainer(shimLines, call.line - 1);
  if (container && ctx.mech.bindRoots.indexOf(container.name) >= 0 && ctx.mech.bindAppliedInLoad) {
    return { kind: 'api-root', detail: '所在对象 ' + container.name + '（' + short(PATHS.shim) + ':' + container.line + '）在 API_BIND_ROOTS → 经 bindApiToken(message.token) 代理压令牌' };
  }
  const owner = container
    ? ('所在对象 var ' + container.name + '（' + short(PATHS.shim) + ':' + container.line + '）不在 API_BIND_ROOTS')
    : '不在任何 bind 根对象内';
  const where = fn ? ('所在函数 ' + fn.name + '（' + short(PATHS.shim) + ':' + fn.line + '）') : '模块级作用域';
  return {
    kind: 'none',
    detail: '第三参省略 → hostCall 回落 currentToken()（' + short(PATHS.shim) + ':205）；' + owner + '；' + where
  };
}

// RULE D：shim 在某个 dispatch 消息里读 message.token 做身份 ⇒ 宿主 payload 必须带 token 键。
function dispatchTokenGaps() {
  const shimLines = readLines(PATHS.shim);
  const etsLines = readLines(PATHS.ets);
  const gaps = [];
  for (const site of parseDispatchSites()) {
    let handlerLine = -1;
    for (let i = 0; i < shimLines.length; i++) {
      if (shimLines[i].indexOf("'" + site.method + "'") >= 0 && /if \(method ===|case /.test(shimLines[i])) { handlerLine = i + 1; break; }
    }
    if (handlerLine < 0) { continue; }
    // 区块必须止于下一个 handler 起始行：否则窗口会漏进相邻 handler，把别处的令牌读取算到本条消息头上。
    let blockEnd = Math.min(shimLines.length, handlerLine + 20);
    for (let i = handlerLine; i < blockEnd; i++) {
      if (/^\s*(?:if \(method ===|case )/.test(shimLines[i])) { blockEnd = i; break; }
    }
    const block = shimLines.slice(handlerLine - 1, blockEnd).join('\n');
    const callees = [];
    const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(block)) !== null) {
      const name = cm[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'Promise'].indexOf(name) >= 0) { continue; }
      if (callees.indexOf(name) < 0) { callees.push(name); }
    }
    let readsToken = /message\.token/.test(block);
    let tokenSource = readsToken ? handlerLine : 0;
    if (!readsToken) {
      for (const name of callees) {
        // 允许 `async function`：loadPlugin 就是这种形态，漏掉 async 会让 RULE D 静默空转。
        const start = shimLines.findIndex((l) => new RegExp('^\\s{2}(?:async\\s+)?function\\s+' + name + '\\s*\\(').test(l));
        if (start < 0) { continue; }
        const body = [];
        for (let j = start + 1; j < shimLines.length; j++) {
          if (/^\s{2}\}\s*$/.test(shimLines[j])) { break; }
          body.push(shimLines[j]);
        }
        if (/message\.token/.test(body.join('\n'))) { readsToken = true; tokenSource = start + 1; break; }
      }
    }
    if (!readsToken) { continue; }
    const payload = payloadKeysNear(etsLines, site.index);
    const hasTokenKey = payload.keys.indexOf('token') >= 0 || payload.keys.indexOf('identity') >= 0;
    gaps.push({
      method: site.method,
      dispatchLine: site.line,
      handlerLine,
      tokenSource,
      hasTokenKey,
      payloadKeys: payload.keys,
      detail: hasTokenKey
        ? 'payload 已带 token 键'
        : (short(PATHS.ets) + ':' + site.line + ' 的 payload 键 [' + payload.keys.join(', ') + '] 无 token/identity，而 ' +
           short(PATHS.shim) + ':' + tokenSource + ' 起读 message.token')
    });
  }
  return gaps;
}

function loadContext() {
  const ctx = {
    shimLines: readLines(PATHS.shim),
    etsLines: readLines(PATHS.ets),
    mech: mechanisms(),
    paths: PATHS
  };
  ctx.handlers = parseHandlers();
  ctx.identityHandlers = ctx.handlers.filter((h) => h.consumesIdentity);
  ctx.calls = parseHostCalls();
  return ctx;
}

module.exports = {
  PATHS,
  ROOT,
  rel,
  short,
  readLines,
  loadContext,
  handlerBodies,
  parseDispatchSites,
  payloadKeysNear,
  classifyTokenSite,
  dispatchTokenGaps,
  mechanisms
};
