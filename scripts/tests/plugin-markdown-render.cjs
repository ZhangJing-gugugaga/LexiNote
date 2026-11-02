#!/usr/bin/env node
'use strict';
// Gate: the SHIPPED plugin page (lexinote_plugin_runtime.html) must really render markdown
// through the reading kernel, apply post-processors per section, resolve getSectionInfo, and
// unload children when the container is replaced. Every assertion below runs the published
// rawfile artifacts; nothing here patches the shim, the kernel or the probe plugin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const RAWFILE = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile');
const PROBE_DIR = path.join(REPO, 'tools', 'plugins-fixtures', 'local', 'md-render-probe');
const PAGE = path.join(RAWFILE, 'lexinote_plugin_runtime.html');

const checks = [];
function check(name, ok, evidence) {
  checks.push({ name, ok: !!ok, evidence });
  return !!ok;
}

// console.log 只接受可序列化的证据: sectionInfo 里带 DOM 引用,序列化时按节点裁剪。
function brief(value) {
  return JSON.stringify(value, (key, item) => (item && typeof item === 'object' && typeof item.nodeType === 'number' ? '[node ' + item.nodeName + ']' : item));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function scriptOrder() {
  const html = fs.readFileSync(PAGE, 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

function answer(method) {
  switch (method) {
    case 'runtime.ready': return { apiVersion: '1.0.0' };
    case 'vault.files': return [];
    case 'data.load': return null;
    case 'app.isDarkMode': return false;
    default: return null;
  }
}

function boot(scripts) {
  const { JSDOM } = require(require.resolve('jsdom', { paths: [path.join(REPO, 'tools', 'reading-bundle')] }));
  const logs = [];
  const calls = [];
  const dom = new JSDOM(
    fs.readFileSync(PAGE, 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''),
    { runScripts: 'outside-only', url: 'https://lexinote.local/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const fmt = (tag) => (...args) => {
    logs.push(tag + ' ' + args.map((x) => (typeof x === 'string' ? x : (x && x.message ? x.message : String(x)))).join(' '));
  };
  w.console = Object.assign({}, console, { log: fmt('log'), warn: fmt('warn'), error: fmt('error'), debug: fmt('debug') });
  w.lexiHost = {
    call(callId, method, raw) {
      calls.push(method);
      return Promise.resolve(JSON.stringify({ ok: true, result: answer(method) }));
    }
  };
  const loaded = [];
  for (const name of scripts) {
    try {
      w.eval(fs.readFileSync(path.join(RAWFILE, name), 'utf8'));
      loaded.push(name);
    } catch (err) {
      loaded.push(name + ' FAILED: ' + (err && err.message));
    }
  }
  return { w, dom, logs, calls, loaded };
}

function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      let value = null;
      try { value = fn(); } catch (err) { value = null; }
      if (value || Date.now() > deadline) { resolve(value); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main() {
  const order = scriptOrder();

  check('html: kernel script loads before the shim',
    order.indexOf('lexinote_plugin_render.js') >= 0 && order.indexOf('lexinote_plugin_render.js') < order.indexOf('lexinote_plugin_shim.js'),
    order.join(' -> '));

  check('artifact: plugin page kernel is byte-identical to the workspace kernel',
    sha256(path.join(RAWFILE, 'lexinote_plugin_render.js')) === sha256(path.join(RAWFILE, 'lexinote_reading.js')) &&
      fs.statSync(path.join(RAWFILE, 'lexinote_plugin_render.js')).size <= 150 * 1024,
    'bytes=' + fs.statSync(path.join(RAWFILE, 'lexinote_plugin_render.js')).size);

  check('workspace page: still loads only its own kernel copy',
    fs.readFileSync(path.join(RAWFILE, 'lexinote_workspace.html'), 'utf8').indexOf('lexinote_plugin_render.js') < 0,
    'lexinote_workspace.html mentions no plugin render artifact');

  const page = boot(order);
  const w = page.w;
  check('boot: page scripts evaluated in html order', page.loaded.join(',') === order.join(','), page.loaded.join(','));

  const R = w.LexiReading;
  check('kernel: window.LexiReading exposes render + applyPostProcessors in the plugin page',
    !!R && typeof R.render === 'function' && typeof R.applyPostProcessors === 'function',
    R ? Object.keys(R).join(',') : 'missing');

  const shimNs = w.LexiObsidian && w.LexiObsidian.namespace;
  check('shim: MarkdownRenderer is published on the obsidian namespace',
    !!shimNs && !!shimNs.MarkdownRenderer && typeof shimNs.MarkdownRenderer.render === 'function',
    shimNs ? typeof shimNs.MarkdownRenderer : 'missing namespace');

  const manifest = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, 'manifest.json'), 'utf8'));
  const code = fs.readFileSync(path.join(PROBE_DIR, 'main.js'), 'utf8');
  w.lexiRuntime.__receive('load.plugin', JSON.stringify({ manifest, code, token: 'tok-md-probe' }));
  const report = await waitFor(() => (w.__mdRenderProbe && w.__mdRenderProbe.renderMarkdown ? w.__mdRenderProbe : null), 8000);
  check('probe: plugin onload reached the end of both render calls', !!report, report ? 'report present' : 'timeout; logs=' + page.logs.slice(-6).join(' | '));
  if (!report) return finish(page, order);

  check('render: returns a real Promise and resolves (no reject)', report.render && report.render.isPromiseLike === true && !report.render.rejected,
    brief(report.render && { isPromiseLike: report.render.isPromiseLike, rejected: report.render.rejected, errors: report.errors }));
  check('render: **bold** became <strong>', report.render.html.strong >= 1, 'strong=' + report.render.html.strong);
  check('render: task list became li.task-list-item', report.render.html.taskItems === 2, 'task-list-item=' + report.render.html.taskItems);
  check('render: task list rendered real checkboxes', report.render.html.checkboxes === 2, 'input[type=checkbox]=' + report.render.html.checkboxes);
  check('render: fenced code became pre > code', report.render.html.preCode >= 1, 'pre>code=' + report.render.html.preCode);
  check('render: table became <table>', report.render.html.tables === 1, 'table=' + report.render.html.tables);
  check('renderMarkdown: resolves with the rendered HTML string',
    report.renderMarkdown.type === 'string' && report.renderMarkdown.hasStrong && report.renderMarkdown.hasTaskItem,
    brief(report.renderMarkdown));
  check('post-processor: ran inside render (per section fan-out)', report.postProcessorRuns >= 1, 'runs=' + report.postProcessorRuns);
  check('getSectionInfo: an inner rendered node resolves to its section',
    !!report.sectionInfoInner && typeof report.sectionInfoInner.lineStart === 'number' && typeof report.sectionInfoInner.lineEnd === 'number',
    brief(report.sectionInfoInner));
  check('getSectionInfo: a non-section container resolves to null', report.sectionInfoNonSection === null,
    brief(report.sectionInfoNonSection));
  check('child lifecycle: addChild ran load, container replacement unloaded the old child',
    report.childLoads >= 1 && report.childUnloads >= 1 && report.childUnloads <= report.childLoads,
    'loads=' + report.childLoads + ' unloads=' + report.childUnloads + ' postProcessorRuns=' + report.postProcessorRuns);
  check('host: no render crash was swallowed into a component error', page.logs.every((line) => line.indexOf('child.unload failed') < 0), 'logs=' + page.logs.length);

  // Direct call on the shipped namespace: the real implementation, not the old rejecting stub.
  const directEl = w.document.createElement('div');
  const direct = await shimNs.MarkdownRenderer.render(w.app, '**direct**', directEl, 'Notes/direct.md', null);
  check('shim: MarkdownRenderer.render on the namespace renders instead of rejecting',
    direct === undefined && directEl.querySelectorAll('strong').length === 1,
    'strong=' + directEl.querySelectorAll('strong').length);

  // Order independence: the shim must not depend on the kernel having been evaluated first.
  const late = boot(['lexinote_plugin_shim.js']);
  const lateNs = late.w.LexiObsidian && late.w.LexiObsidian.namespace;
  const lateEl = late.w.document.createElement('div');
  let lateError = null;
  try { await lateNs.MarkdownRenderer.render(late.w.app, '**late**', lateEl, 'Notes/late.md', null); } catch (err) { lateError = String(err && err.message); }
  check('order: shim evaluated WITHOUT the kernel still boots and fails honestly (lazy lookup, no top-level use)',
    !!lateNs && !!lateError && lateError.indexOf('lexinote_plugin_render.js') >= 0,
    'error=' + lateError + ' loaded=' + late.loaded.join(','));
  late.w.eval(fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_render.js'), 'utf8'));
  const lateEl2 = late.w.document.createElement('div');
  await lateNs.MarkdownRenderer.render(late.w.app, '**late**', lateEl2, 'Notes/late.md', null);
  check('order: the same shim renders once the kernel arrives later',
    lateEl2.querySelectorAll('strong').length === 1, 'strong=' + lateEl2.querySelectorAll('strong').length);

  return finish(page, order);
}

function finish(page, order) {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.evidence ? '  [' + c.evidence + ']' : ''));
  }
  console.log('');
  console.log('summary: ' + (checks.length - failed.length) + ' pass / ' + failed.length + ' fail, assertions=' + checks.length);
  console.log('page scripts: ' + order.join(' -> '));
  if (failed.length > 0) {
    console.log('failures: ' + failed.map((c) => c.name).join(' | '));
    process.exitCode = 1;
  }
  return failed.length === 0;
}

main().then((ok) => { if (!ok) { process.exitCode = 1; } }).catch((err) => {
  console.error('gate crashed: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});