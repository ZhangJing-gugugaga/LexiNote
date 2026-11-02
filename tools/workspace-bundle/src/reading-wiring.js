/*
 * 阅读渲染接线(M2-B 第一片)。
 *
 * 只做五件事:装载内核产物、把笔记正文交给 window.LexiReading.render 挂到挂载点、把插件注册的
 * markdown post processor 转进内核注册表、编辑后走 rerenderSection 的节级增量、把宿主 file-open
 * 的 path 落成 ctx.sourcePath。
 * 骨架(.markdown-preview-view > .markdown-preview-sizer > .markdown-rendered >
 * .markdown-preview-section[data-heading-level])由 lexinote_reading.js 生成,本段不拼、不改它。
 *
 * 注意:本文件是 tools/workspace-bundle 的构建产物(bundles/workspace.js 的同源拷贝),
 * 本段是接线补丁 —— 重跑构建会被覆盖,源码侧等价改动必须在 build 时并入 src/main.ts。
 */
(function () {
  'use strict';

  var READING_ROOT_ID = 'reading-root';
  var REFRESH_DEBOUNCE_MS = 180;
  var WIRE_RETRY_MS = 50;
  var WIRE_RETRY_MAX = 40;
  /** 骨架选择器常量:必须与内核产物一致(门禁 scripts/tests/reading-wiring.cjs 逐项比对)。 */
  var SKELETON_SELECTORS = ['markdown-preview-view', 'markdown-preview-sizer', 'markdown-rendered', 'markdown-preview-section'];
  var SECTION_LEVEL_ATTR = 'data-heading-level';

  var noteSource = '';        // 笔记正文:render 的入参来源(同页编辑器活文档)
  var noteSourcePath = '';    // ctx.sourcePath:宿主 file-open 的 path,未收到时为 ''
  var noteFrontmatter;        // ctx.frontmatter:undefined 时内核用正文解析出的前言
  var reading = null;         // 首次 render 的结果;非 null 后不再整篇重建 DOM
  var sectionSpans = [];      // 每节的绝对行区间(内核 rerender 后只给节内相对行号,故自持一份)
  var refreshTimer = null;
  var wireTries = 0;
  var watching = false;
  var watchingPath = false;   // 宿主 file-open 订阅是否已挂上(挂上就不再重复订阅)

  function kernel() { return window.LexiReading || null; }
  function readingRoot() { return document.getElementById(READING_ROOT_ID); }
  function message(err) { return err && err.message ? String(err.message) : String(err); }

  /** file-open 载荷里的路径:宿主 fileToJson 的 path 就是笔记文件路径,类型不对一律回落 ''。 */
  function filePathOf(file) {
    if (!file || typeof file !== 'object') { return ''; }
    var p = file.path;
    return typeof p === 'string' ? p : '';
  }

  /** 当前笔记路径:只接受非空字符串,所以缺省永远是 ''(不是 undefined/null),也不会被空事件打回空串。 */
  function applySourcePath(nextPath) {
    var next = typeof nextPath === 'string' ? nextPath : '';
    if (next.length === 0 || next === noteSourcePath) { return; }
    noteSourcePath = next;
    log('reading.sourcePath', { path: noteSourcePath });
    reapplyPostProcessors();
  }

  /** detail 自己 JSON 化并截断:宿主 onConsole 只拿到一行文本,原样传对象就只有 [object Object]。 */
  var LOG_DETAIL_MAX = 160;
  function logDetail(detail) {
    var text;
    try { text = JSON.stringify(detail === undefined || detail === null ? {} : detail); }
    catch (err) { text = '[unserializable]'; }
    if (typeof text !== 'string' || text.length === 0) { text = '[unserializable]'; }
    return text.length > LOG_DETAIL_MAX ? text.slice(0, LOG_DETAIL_MAX) + '…(' + text.length + ')' : text;
  }

  /** 遥测走容器既有 v1 帧(log.event),与 bundle 内 note() 同一落点。 */
  function log(topic, detail) {
    console.log('[lexi] ' + topic + ' ' + logDetail(detail));
    var shim = window.LexiPluginShim;
    if (!shim || typeof shim.call !== 'function') { return; }
    try {
      void shim.call('log.event', { topic: topic, detail: detail || {} }).catch(function () {});
    } catch (err) { /* 通道未就绪,只留 console */ }
  }

  /** 正文来源:同页唯一真文档(CM6)的活文本。 */
  function readingSource() {
    var bridge = window.__lexiEditor;
    noteSource = bridge && typeof bridge.getValue === 'function' ? String(bridge.getValue() || '') : '';
    return noteSource;
  }

  function lineArray(text) { return String(text).split(/\r?\n/); }

  function spansOf(sections) {
    var spans = [];
    for (var i = 0; i < sections.length; i++) {
      var info = typeof sections[i].getSectionInfo === 'function' ? sections[i].getSectionInfo() : null;
      spans.push({ start: info ? info.lineStart : 0, end: info ? info.lineEnd : 0 });
    }
    return spans;
  }

  function missingSkeleton(root) {
    var selector = '.' + SKELETON_SELECTORS.join(' > .') + '[' + SECTION_LEVEL_ATTR + ']';
    var found = root ? root.querySelector(selector) : null;
    return found ? [] : [selector];
  }

  /**
   * 首次装载,也是整篇 render 的唯一调用点:已装载就直接返回,
   * 刷新路径永远进不到 render(门禁第 5 条判的就是这条短路)。
   */
  function mountReading() {
    var root = readingRoot();
    if (!root || !kernel()) { return false; }
    if (reading) { return true; }
    readingSource();
    var result = window.LexiReading.render(noteSource, {
      sourcePath: noteSourcePath,
      frontmatter: noteFrontmatter
    });
    root.textContent = '';
    root.appendChild(result.containerEl);
    reading = result;
    sectionSpans = spansOf(result.sections);
    log('reading.mount', {
      sections: sectionSpans.length,
      lines: lineArray(noteSource).length,
      missing: missingSkeleton(root)
    });
    // 内核只有节级 rerender 会自己跑后处理器,整篇 render 不会:首屏在这里补一次。
    reapplyPostProcessors();
    return true;
  }

  /**
   * 后处理器是通过 ctx.sourcePath 认笔记的:首屏补跑、路径变更后重跑都走这一处,
   * 整篇 render 依旧只有 mountReading 那一次(门禁第 5 条)。
   */
  function reapplyPostProcessors() {
    if (!reading || !kernel()) { return; }
    var applied = window.LexiReading.applyPostProcessors(reading.containerEl, {
      sourcePath: noteSourcePath,
      frontmatter: noteFrontmatter
    });
    if (applied && typeof applied.then === 'function') {
      applied.then(function (outcome) {
        log('reading.postProcessors', {
          sourcePath: noteSourcePath,
          errors: outcome && outcome.errors ? outcome.errors.length : 0
        });
      }, function (err) { log('reading.postProcessors.error', { message: message(err) }); });
    }
  }

  /**
   * 编辑后刷新:逐节比对,只把变了的节回灌内核(rerenderSection),整篇 DOM 不重建。
   * 节边界自持:内核 rerender 后 data-line-* 变成节内相对行号,不能拿来算绝对位置。
   */
  function refreshReading() {
    if (!kernel() || !reading) { return; }
    var source = readingSource();
    if (source === reading.source) { return; }
    var next = lineArray(source);
    var spans = sectionSpans.slice();
    var jobs = [];
    var shift = 0;
    for (var i = 0; i < spans.length; i++) {
      var start = spans[i].start + shift;
      var end = i + 1 < spans.length ? spans[i + 1].start + shift : next.length;
      end = Math.max(start, Math.min(end, next.length));
      var text = next.slice(start, end).join('\n');
      if (text !== reading.sections[i].source) {
        jobs.push(window.LexiReading.rerenderSection(i, text));
      }
      shift += (end - start) - (spans[i].end - spans[i].start);
      spans[i] = { start: start, end: end };
    }
    sectionSpans = spans;
    reading.source = source;
    if (jobs.length === 0) { return; }
    Promise.all(jobs).then(function () {
      log('reading.refresh', { sections: jobs.length, total: spans.length });
    }, function (err) { log('reading.refresh.error', { message: message(err) }); });
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) { return; }
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      refreshReading();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** 监听编辑:用 bundle 自己那份 @codemirror 挂 updateListener,不做 DOM 变更轮询。 */
  function watchEditor() {
    if (watching) { return true; }
    var bridge = window.__lexiEditor;
    var modules = window.LexiCmModules || window.__lexiCmModules;
    if (!bridge || !modules || typeof bridge.cm !== 'function') { return false; }
    var view = bridge.cm();
    var cmState = modules['@codemirror/state'];
    var cmView = modules['@codemirror/view'];
    if (!view || !cmState || !cmView) { return false; }
    view.dispatch({
      effects: cmState.StateEffect.appendConfig.of(cmView.EditorView.updateListener.of(function (update) {
        if (update.docChanged) { scheduleRefresh(); }
      }))
    });
    watching = true;
    return true;
  }

  /**
   * 后处理器桥:兼容层里 registerMarkdownPostProcessor 现在是丢弃式空实现(插件注册的后处理器没有去处),
   * 这里在页面侧覆写 Plugin.prototype,把它转进 LexiReading.registerPostProcessor;兼容层文件本身不动。
   * 注销句柄交给 Component.register,插件 unload 时自动摘掉。
   */
  function installPostProcessorBridge() {
    var ns = window.LexiObsidian && window.LexiObsidian.namespace;
    var Plugin = ns && ns.Plugin;
    if (!kernel() || !Plugin || !Plugin.prototype) { return false; }
    if (Plugin.prototype.__lexiReadingBridge === true) { return true; }
    Plugin.prototype.registerMarkdownPostProcessor = function (processor, sortOrder) {
      if (typeof processor !== 'function') { return processor; }
      var unregister = window.LexiReading.registerPostProcessor(function (el, ctx) {
        return processor(el, ctx);
      }, sortOrder);
      if (typeof this.register === 'function') {
        this.register(function () { unregister(); });
      }
      log('reading.postProcessor.register', {
        pluginId: this.manifest && this.manifest.id ? String(this.manifest.id) : ''
      });
      return processor;
    };
    Plugin.prototype.__lexiReadingBridge = true;
    return true;
  }

  /**
   * 宿主 file-open:兼容层已把事件帧 {topic:'workspace',name:'file-open',payload:{file}} 还原成
   * Obsidian 的位置参数问题,这里拿到的是带 path 的 TFile,只取路径。window.app 由兼容层更早建立。
   */
  function watchSourcePath() {
    if (watchingPath) { return true; }
    var app = window.app;
    var workspace = app && app.workspace ? app.workspace : null;
    if (!workspace || typeof workspace.on !== 'function') { return false; }
    workspace.on('file-open', function (file) { applySourcePath(filePathOf(file)); });
    watchingPath = true;
    return true;
  }

  /**
   * 编辑器桥在 boot() 里同步建立,与本段的先后取决于打包顺序:先等桥出现(有界 40×50ms),
   * 再装载并挂监听。
   */
  function wire() {
    installPostProcessorBridge();
    var pathWatched = watchSourcePath();
    var bridge = window.__lexiEditor;
    var bridgeReady = !!(bridge && typeof bridge.getValue === 'function');
    if (!bridgeReady && wireTries < WIRE_RETRY_MAX) {
      wireTries += 1;
      window.setTimeout(wire, WIRE_RETRY_MS);
      return;
    }
    var mounted = mountReading();
    var watched = watchEditor();
    log(mounted && watched ? 'reading.wiring.ready' : 'reading.wiring.blocked', {
      mounted: mounted,
      watched: watched,
      pathWatched: pathWatched,
      sourcePath: noteSourcePath,
      selectors: SKELETON_SELECTORS.join(' > ')
    });
  }

  wire();
})();
