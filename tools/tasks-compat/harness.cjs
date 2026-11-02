#!/usr/bin/env node
'use strict';
// Offline harness: boots the SHIPPED workspace page in jsdom, hands the real
// obsidian-tasks 8.6.0 main.js to our published plugin loader, and records what
// happens. It never patches our shim and never patches the fixture.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const RAWFILE = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile');
const FIXTURE = path.join(REPO, 'tools', 'plugins-fixtures', 'local', 'obsidian-tasks');
const OUT = path.join(REPO, '.fixtures-out', 'tasks-compat');

const PAGE_SCRIPTS = ['lexinote_plugin_shim.js', 'lexinote_workspace_shim.js', 'lexinote_reading.js', 'lexinote_workspace.js'];

const NOTE_PATH = 'Notes/tasks-demo.md';
const NOTE_TEXT = ['# Tasks demo', '', '- [ ] write the report', '- [x] ship the harness', ''].join('\n');

function sha256(p) {
  const buf = fs.readFileSync(p);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
}

function answer(method, payload, state) {
  switch (method) {
    case 'runtime.ready': return { apiVersion: '1.0.0' };
    case 'vault.files': return [{ kind: 'file', path: NOTE_PATH, name: 'tasks-demo.md', basename: 'tasks-demo', extension: 'md', stat: { ctime: 1, mtime: 2, size: NOTE_TEXT.length } }];
    case 'vault.read': return state.note;
    case 'vault.modify':
      state.note = payload.data; state.writes.push({ method, path: payload.path, data: payload.data }); return null;
    case 'vault.create': state.writes.push({ method, path: payload.path, data: payload.data }); return null;
    case 'data.load': return null;
    case 'data.save': return null;
    case 'metadata.get': return { headings: [], links: [], frontmatter: {}, sections: [], listItems: [] };
    case 'events.on': return 1;
    case 'app.isDarkMode': return false;
    case 'settings.register': return null;
    default: return null;
  }
}

function boot() {
  const { JSDOM } = require(require.resolve('jsdom', { paths: [path.join(REPO, 'tools', 'reading-bundle')] }));
  const logs = [];
  const state = { note: NOTE_TEXT, writes: [] };
  const dom = new JSDOM(
    fs.readFileSync(path.join(RAWFILE, 'lexinote_workspace.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''),
    { runScripts: 'outside-only', url: 'https://lexinote.local/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const errors = [];
  const fmt = (tag) => (...args) => {
    const text = args.map((x) => (typeof x === 'string' ? x : (x && x.message ? x.message : String(x)))).join(' ');
    logs.push(tag + ' ' + text);
    for (const a of args) {
      if (a && typeof a === 'object' && typeof a.stack === 'string' && a.stack.indexOf('lexinote-plugin-') >= 0) errors.push(a);
    }
  };
  w.console = Object.assign({}, console, { log: fmt('log'), warn: fmt('warn'), error: fmt('error'), debug: fmt('debug') });

  const calls = [];
  w.lexiHost = {
    call(callId, method, raw, token) {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) { payload = {}; }
      calls.push({ method, token: token || '', payload: Object.keys(payload) });
      return Promise.resolve(JSON.stringify({ ok: true, result: answer(method, payload, state) }));
    }
  };

  const loaded = [];
  for (const name of PAGE_SCRIPTS) {
    try { w.eval(fs.readFileSync(path.join(RAWFILE, name), 'utf8')); loaded.push(name); }
    catch (err) { loaded.push(name + ' FAILED: ' + (err && err.message)); }
  }

  // Observation hook only: count what plugins register, do not implement anything.
  const postProcessors = [];
  if (w.LexiReading && typeof w.LexiReading.registerPostProcessor === 'function') {
    const orig = w.LexiReading.registerPostProcessor;
    w.LexiReading.registerPostProcessor = function () {
      postProcessors.push(arguments[0]);
      return orig.apply(w.LexiReading, arguments);
    };
  }
  return { w, dom, logs, calls, errors, state, postProcessors, loaded };
}

// V8 reports new Function bodies two lines lower than the body's own line 1.
function calibrate(w) {
  const body = 'var a = 1;\nthrow new Error("calib");\n';
  try { new w.Function('require', 'module', 'exports', body)(); } catch (err) {
    const m = /:(\d+):(\d+)\)?$/.exec(String(err.stack).split('\n')[1] || '');
    return m ? Number(m[1]) - 2 : null;
  }
  return null;
}

function staticNamespaceDiff(w) {
  const shim = fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_shim.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(FIXTURE, 'main.js'), 'utf8');
  const ns = w.LexiObsidian && w.LexiObsidian.namespace ? w.LexiObsidian.namespace : {};
  const exposed = Object.keys(ns);
  const vars = [...new Set([...bundle.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*require\("obsidian"\)/g)].map((m) => m[1]))];
  const used = new Map();
  for (const v of vars) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
    let m;
    while ((m = re.exec(bundle))) if (!used.has(m[1])) used.set(m[1], { via: v, offset: m.index });
  }
  const lineAt = (offset) => bundle.slice(0, offset).split('\n').length;
  const missing = [];
  for (const [name, info] of used) {
    if (Object.prototype.hasOwnProperty.call(ns, name)) continue;
    missing.push({ api: name, via: info.via, calledFrom: 'tools/plugins-fixtures/local/obsidian-tasks/main.js:' + lineAt(info.offset) });
  }
  return { exposedCount: exposed.length, obsVars: vars.length, usedCount: used.size, missing };
}

function parseFirstError(errors, offset) {
  for (const err of errors) {
    const frames = String(err.stack || '').split('\n');
    for (const frame of frames) {
      const m = /lexinote-plugin-obsidian-tasks-plugin\.js:(\d+):(\d+)/.exec(frame);
      if (!m) continue;
      const evalLine = Number(m[1]);
      const evalCol = Number(m[2]);
      return {
        message: String(err.message),
        stackTop: frames[1] ? frames[1].trim() : '',
        evalLine, evalCol,
        lineOffset: offset,
        fixtureLine: offset === null ? null : evalLine - offset,
        fixtureCol: evalCol
      };
    }
  }
  return null;
}

// Every captured console error that carries a fixture frame, in the order the
// plugin logged it. Ladder rows match their evidence against this list instead of
// assuming the first logged error is the fatal one (the plugin swallows plenty).
function parseAllErrors(errors, offset) {
  const out = [];
  for (const err of errors) {
    const frames = String(err.stack || '').split('\n');
    for (const frame of frames) {
      const m = /lexinote-plugin-obsidian-tasks-plugin\.js:(\d+):(\d+)/.exec(frame);
      if (!m) continue;
      out.push({
        message: String(err.message),
        evalLine: Number(m[1]),
        evalCol: Number(m[2]),
        fixtureLine: offset === null ? null : Number(m[1]) - offset,
        stackTop3: frames.slice(1, 4).map((s) => s.trim())
      });
      break;
    }
  }
  return out;
}

function locateApi(fixtureLine, fixtureCol) {
  const bundle = fs.readFileSync(path.join(FIXTURE, 'main.js'), 'utf8');
  const line = (bundle.split('\n')[fixtureLine - 1] || '');
  const around = line.slice(Math.max(0, fixtureCol - 40), fixtureCol + 40);
  const m = /extends\s+[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/.exec(line) || /([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)/.exec(around);
  return { snippet: around, symbol: m ? m[0] : null };
}

function summarizeRejections(list) {
  return list.map((e) => ({
    message: String((e && e.message) || e),
    stackTop3: String((e && e.stack) || '').split('\n').slice(1, 4).map((s) => s.trim())
  }));
}

// HARNESS-ONLY bookkeeping, adds no capability: the plugin registers its
// post-processor behind app.workspace.onLayoutReady(), so the handler runs outside
// applyPostProcessors' await chain and a throw there escapes as an unhandled
// rejection that would kill node before the ladder can report it. Collecting it here
// turns that crash into evidence; it does not make the gap go away.
async function run(opts) {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    return await runInner(opts, rejections);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
}

async function runInner(opts, rejections) {
  opts = opts || {};
  const { w, logs, calls, errors, state, postProcessors, loaded } = boot();
  const result = {
    fixture: {
      main: sha256(path.join(FIXTURE, 'main.js')),
      manifest: sha256(path.join(FIXTURE, 'manifest.json'))
    },
    shims: {
      pluginShim: sha256(path.join(RAWFILE, 'lexinote_plugin_shim.js')),
      viewShim: sha256(path.join(RAWFILE, 'lexinote_plugin_view_shim.js'))
    },
    boot: { scripts: loaded, apiVersion: w.LexiObsidian ? w.LexiObsidian.apiVersion : null, hasReading: !!(w.LexiReading) },
    namespace: staticNamespaceDiff(w),
    load: { attempted: false, hostCalls: calls, logs: [] },
    firstError: null,
    onloadAnchor: false,
    postProcessors: { registered: 0 },
    render: { ran: false, nodeCount: 0 },
    click: { ran: false, sourceBefore: null, sourceAfter: null }
  };

  // HARNESS-ONLY ladder hook: the caller injects minimal stubs into the live
  // namespace copy inside this jsdom window. The shipped shim is never touched, so
  // every stub here stays MISSING on a real device (see tools/tasks-compat/REPORT.md).
  if (typeof opts.prepare === 'function') { result.stubs = opts.prepare(w, result) || null; }

  const offset = calibrate(w);
  result.lineOffsetCalibration = { offset, note: 'V8 new Function header lines' };

  if (!w.lexiRuntime || typeof w.lexiRuntime.__receive !== 'function') {
    result.load.error = 'window.lexiRuntime.__receive missing';
    result.unhandledRejections = summarizeRejections(rejections);
    return result;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'));
  const code = fs.readFileSync(path.join(FIXTURE, 'main.js'), 'utf8');
  result.load.attempted = true;
  try {
    w.lexiRuntime.__receive('load.plugin', JSON.stringify({ manifest, code, token: 'tok-tasks' }));
  } catch (err) {
    result.load.dispatchThrew = String(err && err.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  result.load.logs = logs.slice(0, 40);
  result.load.logsAll = logs.slice(0, 200);
  result.load.hostMethods = calls.map((c) => c.method);
  result.errorStacks = errors.map((e) => String(e.stack || '').split('\n').slice(0, 8));
  result.onloadAnchor = calls.some((c) => c.method === 'plugin.onload.done');
  result.firstError = parseFirstError(errors, offset);
  result.loggedErrors = parseAllErrors(errors, offset);
  result.postProcessors.registered = postProcessors.length;

  if (result.firstError && result.firstError.fixtureLine) {
    result.firstError.api = locateApi(result.firstError.fixtureLine, result.firstError.fixtureCol);
  }

  if (result.onloadAnchor) {
    // Only reachable when the plugin actually loaded. Render one note and let the
    // shipped reading host apply whatever post-processors the plugin registered.
    const R = w.LexiReading;
    const out = R.render(state.note, { sourcePath: NOTE_PATH });
    // Measured on the same tree BEFORE any post-processor runs: the renderer's own task
    // list is already inside this count, so the delta afterwards is DOM the plugin itself
    // produced and can never be confused with renderer-native output.
    const nativeElementCount = out.containerEl.getElementsByTagName('*').length;
    const rejectionStart = rejections.length;
    const applied = await R.applyPostProcessors(out.containerEl, { sourcePath: NOTE_PATH, frontmatter: out.frontmatter });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const boxes = out.containerEl.querySelectorAll('.task-list-item');
    const checks = out.containerEl.querySelectorAll('.task-list-item input[type="checkbox"], input.task-list-item-checkbox');
    result.render = {
      ran: true,
      nodeCount: boxes.length,
      selector: '.task-list-item',
      checkboxCount: checks.length,
      nativeElementCount: nativeElementCount,
      elementCount: out.containerEl.getElementsByTagName('*').length,
      pluginDomDelta: out.containerEl.getElementsByTagName('*').length - nativeElementCount,
      // Rejections that escaped WHILE the post-processors ran. The plugin registers its
      // handler behind a wrapper that returns undefined, so an async handler failure never
      // reaches applyPostProcessors' catch; this window is the only place it surfaces.
      rejections: summarizeRejections(rejections.slice(rejectionStart)),
      postProcessorErrors: (applied && applied.errors ? applied.errors : []).map((e) => String(e && e.message ? e.message : e))
    };
    const before = state.note;
    const box = checks[0] || null;
    if (box) {
      box.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      result.click = { ran: true, sourceBefore: before, sourceAfter: state.note, writes: state.writes.slice(-3) };
    }
  }
  result.unhandledRejections = summarizeRejections(rejections);
  return result;
}

module.exports = { run, sha256, NOTE_TEXT, NOTE_PATH, OUT };
