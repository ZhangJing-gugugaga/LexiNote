/* ---------------------------------------------------------------------------
   LexiNote 主题装载器（页面侧）

   职责：
   1. 通过宿主插件式管线取主题：theme.config / theme.list / theme.install /
      theme.load / theme.setActive。主题 styles.css 原样从宿主 files/themes/<id>/
      读出（宿主侧已做 sha256 度量），页面只负责"最后注入"。
   2. 注入顺序：<link href="lexinote_theme.css"> 在 head 里先加载，主题 <style>
      追加到 head 末尾 —— 同特异性规则后来者胜，主题因此能压住宿主基础层。
   3. 明暗：body 上 theme-dark / theme-light 类，默认跟随宿主 app.isDarkMode，
      面板可强制（对应 Obsidian 的"浅色/深色"外观选择）。
   4. 证据日志（tag LexiWorkspace，topic 以 theme. 开头）：
      theme.mode / theme.classes / theme.inject / theme.probe / theme.states /
      theme.coverage
   本文件不改写主题 CSS，不加 !important。
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  var REQUIRED_CLASSES = [
    'app-container', 'horizontal-main-container', 'workspace', 'workspace-split',
    'workspace-ribbon', 'workspace-ribbon-inner', 'workspace-tabs',
    'workspace-tab-header-container', 'workspace-tab-header', 'workspace-leaf',
    'workspace-leaf-content', 'workspace-sidenav', 'view-header', 'view-header-title',
    'view-content', 'view-body', 'markdown-source-view', 'cm-editor', 'cm-scroller',
    'cm-content', 'status-bar', 'status-bar-item', 'mod-root', 'mod-active', 'is-active',
    'clickable-icon',
    /* 命令面板 / 通知 / 错误面板：第一轮缺的就是这一层，主题的 .prompt/.modal 规则全靠它。 */
    'prompt-container', 'modal-container', 'prompt', 'modal', 'prompt-input', 'prompt-results',
    'suggestion-container', 'notice-container'
  ];

  var state = { config: null, theme: null, baseline: null, hostDark: null, override: null, injected: null };

  function $(id) { return document.getElementById(id); }

  function unwrap(rep) {
    if (rep && typeof rep === 'object') {
      if (Object.prototype.hasOwnProperty.call(rep, 'result')) { return rep.result; }
      if (Object.prototype.hasOwnProperty.call(rep, 'data')) { return rep.data; }
    }
    return rep;
  }

  function bridge() {
    return (typeof window !== 'undefined') ? window.LexiPluginShim : null;
  }

  function call(method, payload) {
    var b = bridge();
    if (!b || typeof b.call !== 'function') { return Promise.reject(new Error('shim 未就绪')); }
    return Promise.resolve(b.call(method, payload || {})).then(unwrap);
  }

  function log(topic, detail) {
    try {
      // 传对象而不是字符串:宿主 onLogEvent 会 JSON.stringify(payload.detail),
      // 传字符串会被二次编码成带引号的 JSON,门禁解析不了。
      var payload = (detail && typeof detail === 'object') ? detail : { note: String(detail) };
      call('log.event', { topic: topic, detail: payload }).catch(function () {});
    } catch (e) { /* 日志不可用不得影响页面 */ }
  }

  function setStateText(text) {
    var el = $('theme-state');
    if (el) { el.textContent = text; }
  }

  /* ---------- 纯 JS SHA-256（ArkWeb 非安全上下文没有 crypto.subtle） ---------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return new Uint8Array(out);
  }

  function sha256hex(str) {
    var bytes = (typeof str === 'string') ? utf8Bytes(str) : str;
    var len = bytes.length;
    var blocks = Math.floor((len + 8) / 64) + 1;
    var buf = new Uint8Array(blocks * 64);
    buf.set(bytes, 0);
    buf[len] = 0x80;
    var bits = len * 8;
    var dv = new DataView(buf.buffer);
    dv.setUint32(blocks * 64 - 4, bits >>> 0, false);
    dv.setUint32(blocks * 64 - 8, Math.floor(bits / 4294967296), false);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var b = 0; b < blocks; b++) {
      for (var t = 0; t < 16; t++) { w[t] = dv.getUint32(b * 64 + t * 4, false); }
      for (t = 16; t < 64; t++) {
        var s0 = ror(w[t - 15], 7) ^ ror(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = ror(w[t - 2], 17) ^ ror(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
        var maj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var hex = '';
    for (var i = 0; i < 8; i++) { hex += ('00000000' + H[i].toString(16)).slice(-8); }
    return hex;
  }

  function ror(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  /* ---------- 明暗状态 ---------- */
  function isDarkNow() {
    if (state.override) { return state.override === 'dark'; }
    if (state.hostDark === true || state.hostDark === false) { return state.hostDark; }
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }

  function applyMode(source) {
    var dark = isDarkNow();
    if (!document.body) { return; }
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-light', !dark);
    // Minimal 的调色板变量挂在 .minimal-default-dark/.minimal-default-light 上
    // （styles.css 里 .minimal-default-dark{--bg1: hsl(...)} 是裸类选择器），
    // 只给 theme-dark 而不给这一层，主题就没有暗色底色可用。
    document.body.classList.toggle('minimal-default-dark', dark);
    document.body.classList.toggle('minimal-default-light', !dark);
    var item = $('status-mode');
    if (item) { item.textContent = (dark ? '暗色' : '亮色') + (state.override ? '（手动）' : '（宿主）'); }
    applyViewport();
    return { dark: dark, source: source };
  }

  /* is-mobile：Minimal 把移动端分支（.is-mobile .menu-item 内边距、.is-mobile
     .modal-close-button 定位）挂在 body 上，宿主页面自己不加这个类，主题那半截规则
     就永远不生效。断点与 lexinote_theme.css 的 @media (max-width: 560px) 对齐。 */
  var MOBILE_QUERY = '(max-width: 560px)';

  function applyViewport() {
    if (!document.body || typeof window.matchMedia !== 'function') { return null; }
    var mobile = false;
    try { mobile = !!window.matchMedia(MOBILE_QUERY).matches; } catch (e) { mobile = false; }
    document.body.classList.toggle('is-mobile', mobile);
    return mobile;
  }

  function watchViewport() {
    try {
      var mq = window.matchMedia(MOBILE_QUERY);
      if (mq && typeof mq.addEventListener === 'function') { mq.addEventListener('change', applyViewport); }
    } catch (e) { /* 视口监听不可用不影响已算出的类 */ }
  }

  function pollHostMode() {
    call('app.isDarkMode', {}).then(function (v) {
      var dark = (v === true) || (v && v.value === true) || (v && v.dark === true);
      if (state.hostDark !== dark) {
        state.hostDark = dark;
        var m = applyMode('host');
        if (m) { log('theme.mode', { dark: m.dark, source: 'host', override: state.override }); }
        if (state.injected) { logProbe(); }
      }
    }).catch(function () {});
  }

  /* ---------- 变量探针 ---------- */
  function computedVars() {
    var cs = window.getComputedStyle(document.body);
    return {
      bg: (cs.getPropertyValue('--background-primary') || '').trim(),
      bgSecondary: (cs.getPropertyValue('--background-secondary') || '').trim(),
      text: (cs.getPropertyValue('--text-normal') || '').trim(),
      accent: (cs.getPropertyValue('--color-accent') || '').trim(),
      fontText: (cs.getPropertyValue('--font-text') || '').trim()
    };
  }

  /* 采集"真正上色的那一层"：从 #editor 往上找到第一个非透明的背景。
     宿主把底色画在 .workspace-leaf，主题可能画在 .markdown-source-view/.cm-editor，
     只读 #editor 自己的 backgroundColor 会永远是 rgba(0,0,0,0)。 */
  function sampleBg() {
    var el = document.getElementById('editor') || document.body;
    var chain = [];
    var node = el;
    var colorText = window.getComputedStyle(el).color;
    while (node && node !== document.documentElement) {
      var cs = window.getComputedStyle(node);
      var color = cs.backgroundColor;
      chain.push((node.tagName || '').toLowerCase() + (node.id ? '#' + node.id : '') + '=' + color);
      if (color && color !== 'transparent' && color.indexOf('rgba(0, 0, 0, 0)') !== 0) {
        return { tag: node.id || node.className || node.tagName, color: color, colorText: cs.color, chain: chain.join(' ') };
      }
      node = node.parentElement;
    }
    return { tag: 'none', color: 'transparent', colorText: colorText, chain: chain.join(' ') };
  }

  function logProbe() {
    var on = computedVars();
    var off = state.baseline || {};
    var sample = sampleBg();
    log('theme.probe', {
      off: { bg: off.bg || '', text: off.text || '' },
      on: { bg: on.bg, text: on.text, bgSecondary: on.bgSecondary, accent: on.accent },
      differBg: (off.bg || '') !== on.bg,
      differText: (off.text || '') !== on.text,
      sample: sample,
      classes: document.body.className
    });
  }

  function logStates() {
    if (!document.body) { return; }
    var before = document.body.className;
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
    var light = sampleBg();
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
    var dark = sampleBg();
    document.body.className = before;
    applyMode('restore');
    log('theme.states', { light: light, dark: dark, differ: light.color !== dark.color });
  }

  function logClasses() {
    var detail = {};
    var missing = [];
    for (var i = 0; i < REQUIRED_CLASSES.length; i++) {
      var name = REQUIRED_CLASSES[i];
      var n = document.getElementsByClassName(name).length;
      detail[name] = n;
      if (n === 0) { missing.push(name); }
    }
    detail.__missing = missing.join(',');
    /* theme-dark / theme-light 是明暗态类，测试时只可能有一个在场，
       所以单独报当前态，而不是塞进"必须存在"的表里。 */
    detail.__mode = document.body.classList.contains('theme-dark') ? 'theme-dark'
      : (document.body.classList.contains('theme-light') ? 'theme-light' : '');
    log('theme.classes', detail);
  }

  function logCoverage(css) {
    var referenced = [];
    var seen = {};
    var re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    var m;
    while ((m = re.exec(css))) {
      if (!seen[m[1]]) { seen[m[1]] = 1; referenced.push(m[1]); }
    }
    var cs = window.getComputedStyle(document.body);
    var defined = [];
    var undef = [];
    for (var i = 0; i < referenced.length; i++) {
      var val = (cs.getPropertyValue(referenced[i]) || '').trim();
      if (val) { defined.push(referenced[i]); } else { undef.push(referenced[i]); }
    }
    log('theme.coverage', { referenced: referenced.length, defined: defined.length, undefined: undef.length });
    var chunk = 6;
    for (var j = 0; j < undef.length; j += chunk) {
      log('theme.coverage.undefined', { part: Math.floor(j / chunk) + 1, names: undef.slice(j, j + chunk).join(' ') });
    }
  }

  /* 采集"宿主压不住的证据"：命令面板遮罩、面板、一条真实通知的计算背景色。
     通知由页面自己的 notice 通道创建（#btn-notice），不是脚本里假造 DOM。 */
  function sampleUi() {
    var g = window.getComputedStyle;
    var palette = document.getElementById('palette');
    var panel = document.getElementById('palette-panel');
    var input = document.getElementById('palette-input');
    var list = document.getElementById('palette-list');
    var notices = document.getElementsByClassName('notice');
    var notice = notices.length ? notices[notices.length - 1] : null;
    var items = document.getElementsByClassName('suggestion-item');
    return {
      palette: palette ? g(palette).backgroundColor : '',
      panel: panel ? g(panel).backgroundColor : '',
      input: input ? g(input).backgroundColor : '',
      results: list ? g(list).backgroundColor : '',
      notice: notice ? g(notice).backgroundColor : '',
      noticeCount: notices.length,
      suggestionCount: items.length
    };
  }

  function logUi() {
    var ui = sampleUi();
    log('theme.ui', {
      palette: ui.palette, panel: ui.panel, input: ui.input, results: ui.results,
      notice: ui.notice, noticeCount: ui.noticeCount, suggestionCount: ui.suggestionCount,
      classes: (document.body && document.body.className) || ''
    });
  }

  /* 宿主产物把命令面板行标成 .palette-item（tools/workspace-bundle/src/main.ts:503），
     而 Minimal 只认 Obsidian 的 .suggestion-item —— 面板内边距/圆角/选中态因此一条都不命中。
     这里在真实节点上补类（幂等，不造节点、不改产物）。 */
  var DECORATE = [
    { from: '#palette-list > li.palette-item', to: 'suggestion-item' }
  ];

  function decorate() {
    var added = 0;
    for (var i = 0; i < DECORATE.length; i++) {
      var nodes = document.querySelectorAll(DECORATE[i].from + ':not(.' + DECORATE[i].to + ')');
      for (var j = 0; j < nodes.length; j++) { nodes[j].classList.add(DECORATE[i].to); added++; }
    }
    return added;
  }

  /* 面板行与通知都是"短命节点"：行是点击时才生成，通知 3.2s 后自我移除。
     等到下一次人工探针（或 uitest dump）再采样就什么都看不到了，
     所以在两个容器上挂 MutationObserver：节点一出现就补类并立刻采一次 theme.ui。 */
  function watch() {
    if (typeof window.MutationObserver !== 'function') { return null; }
    var list = $('palette-list');
    var notices = $('notices');
    if (!list && !notices) { return null; }
    var mo = new MutationObserver(function () { decorate(); logUi(); });
    if (list) { mo.observe(list, { childList: true, subtree: true }); }
    if (notices) { mo.observe(notices, { childList: true, subtree: true }); }
    return mo;
  }

  /* 选择器特异性（CSSOM 口径）：把每条规则的 selectorText 拆开算 [id, class/attr/pseudo-class]。
     宿主基础层出现任何 ID 选择器都算违例：ID 的 (1,0,0) 会压住主题的单类规则，
     "主题对整个应用生效"就退化成只对编辑面板生效。 */
  function specificityOf(sel) {
    var worst = { ids: 0, classes: 0, tag: '' };
    var parts = String(sel).split(',');
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      var ids = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
      var noIds = s.replace(/#[A-Za-z0-9_-]+/g, ' ');
      var cls = (noIds.match(/\.[A-Za-z0-9_-]+/g) || []).length
        + (noIds.match(/\[[^\]]*\]/g) || []).length
        + (noIds.match(/:(?!:)[A-Za-z-]+/g) || []).length;
      if (ids > worst.ids || (ids === worst.ids && cls > worst.classes)) {
        worst = { ids: ids, classes: cls, tag: s.trim() };
      }
    }
    return worst;
  }

  function logSpecificity() {
    var found = { host: null, theme: null };
    var host = null;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      var href = s.href || '';
      if (href.indexOf('lexinote_theme.css') >= 0) { host = s; }
    }
    if (host) {
      var rec = { sheet: 'lexinote_theme.css', rules: 0, idSelectors: [], maxIds: 0, maxClasses: 0, worst: '' };
      try { walkRules(host.cssRules, rec); } catch (e) { rec.error = String(e && e.name ? e.name : e); }
      found.host = rec;
    }
    var ts = themeSheet();
    if (ts) {
      var rec2 = { sheet: 'lexinote-theme', rules: 0, idSelectors: [], maxIds: 0, maxClasses: 0, worst: '' };
      try { walkRules(ts.cssRules, rec2); } catch (e) { rec2.error = String(e && e.name ? e.name : e); }
      found.theme = rec2;
    }
    log('theme.specificity', found);

    function walkRules(list, rec) {
      for (var k = 0; k < list.length; k++) {
        var r = list[k];
        if (!r) { continue; }
        if (r.selectorText) {
          rec.rules++;
          var sp = specificityOf(r.selectorText);
          if (sp.ids > rec.maxIds || (sp.ids === rec.maxIds && sp.classes > rec.maxClasses)) {
            rec.maxIds = sp.ids; rec.maxClasses = sp.classes; rec.worst = sp.tag;
          }
          if (sp.ids > 0 && rec.idSelectors.length < 12) { rec.idSelectors.push(sp.tag); }
        } else if (r.cssRules) {
          walkRules(r.cssRules, rec);
        }
      }
    }
  }

  function themeSheet() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      if (s.ownerNode && s.ownerNode.id === 'lexinote-theme') { return s; }
    }
    return null;
  }

  /* Minimal 里 .prompt/.notice/.modal 相关规则的命中数（CSSOM 口径）：
     total = 选择器文本里出现该类的规则条数（含 @media 内部），
     matched = 这些规则当前在 DOM 上至少匹配到一个元素（document.querySelector 非空）的条数。
     命不中就是宿主没提供主题期待的类名/层级，必须在报告里列出来。 */
  function logRules() {
    var sheet = themeSheet();
    if (!sheet) { log('theme.rules', { sheet: 'none' }); return; }
    var groups = { prompt: /\.prompt/, notice: /\.notice/, modal: /\.modal/ };
    var buckets = {};
    Object.keys(groups).forEach(function (k) {
      buckets[k] = { total: 0, matched: 0, samples: [] };
    });
    var walk = function (list) {
      for (var k = 0; k < list.length; k++) {
        var r = list[k];
        if (!r) { continue; }
        if (!r.selectorText) { if (r.cssRules) { walk(r.cssRules); } continue; }
        var sel = r.selectorText;
        Object.keys(groups).forEach(function (key) {
          if (!groups[key].test(sel)) { return; }
          var b = buckets[key];
          b.total++;
          var hit = false;
          try { hit = !!document.querySelector(sel); } catch (e) { hit = false; }
          if (hit) {
            b.matched++;
            if (b.samples.length < 4) { b.samples.push(sel.slice(0, 60)); }
          }
        });
      }
    };
    try { walk(sheet.cssRules); } catch (e) { log('theme.rules', { sheet: 'error', message: String(e && e.name ? e.name : e) }); return; }
    log('theme.rules', {
      sheet: 'lexinote-theme',
      rules: sheet.cssRules.length,
      prompt: buckets.prompt, notice: buckets.notice, modal: buckets.modal,
      noticeCount: document.getElementsByClassName('notice').length,
      suggestionCount: document.getElementsByClassName('suggestion-item').length
    });
  }

  /* ---------- 注入 ---------- */
  function inject(css, meta) {
    var old = $('lexinote-theme');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var style = document.createElement('style');
    style.id = 'lexinote-theme';
    style.textContent = css;
    document.head.appendChild(style);
    state.injected = { chars: css.length };
    var mine = sha256hex(css);
    var hostSha = (meta && meta.sha256) || '';
    log('theme.inject', {
      id: (meta && meta.id) || '',
      chars: css.length,
      bytes: utf8Bytes(css).length,
      sha256: mine,
      hostSha: hostSha,
      match: !!hostSha && hostSha === mine,
      styleLast: document.head.lastElementChild === style,
      order: Array.prototype.map.call(document.head.querySelectorAll('link[rel=stylesheet],style'), function (n) { return n.id || n.getAttribute('href'); }).join(' > ')
    });
    setStateText('主题：' + ((meta && meta.name) || (meta && meta.id) || '已注入') + '（' + css.length + ' 字符）');
    return style;
  }

  function disable() {
    var old = $('lexinote-theme');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    state.injected = null;
    setStateText('主题：已停用');
    call('theme.setActive', { id: '' }).catch(function () {});
    log('theme.disabled', { note: '已移除 <style id="lexinote-theme">' });
  }

  function enable(id) {
    return call('theme.load', id ? { id: id } : {}).then(function (css) {
      if (!css || typeof css.css !== 'string' || !css.css.length) {
        setStateText('主题：没有可加载的主题');
        log('theme.enable.none', { id: id || '' });
        return null;
      }
      state.theme = css;
      inject(css.css, css);
      return call('theme.setActive', { id: css.id }).then(function (r) {
        log('theme.enabled', { id: css.id, bytes: css.bytes, sha256: css.sha256, active: (r && r.active) || css.id });
        if (!state.baseline) { state.baseline = computedVars(); }
        logProbe();
        logStates();
        logCoverage(css.css);
        logClasses();
        return css;
      });
    }).catch(function (err) {
      setStateText('主题：加载失败 ' + (err && err.message ? err.message : ''));
      log('theme.fail.load', { message: String(err && err.message ? err.message : err) });
      return null;
    });
  }

  function install() {
    var input = $('theme-source');
    var url = (input && input.value ? input.value : (state.config && state.config.source) || '').trim();
    setStateText('主题：安装中…');
    log('theme.install.request', { url: url });
    return call('theme.install', { url: url }).then(function (res) {
      log('theme.install.done', { id: res.id, bytes: res.bytes, sha256: res.sha256, source: res.source });
      setStateText('主题：已安装 ' + res.id + '（' + res.bytes + ' 字节）');
      return refreshList().then(function () { return res; });
    }).catch(function (err) {
      setStateText('主题：安装失败 ' + (err && err.message ? err.message : ''));
      log('theme.fail.install', { url: url, message: String(err && err.message ? err.message : err) });
      return null;
    });
  }

  function refreshList() {
    return call('theme.list', {}).then(function (res) {
      state.config = res;
      var input = $('theme-source');
      if (input && !input.value && res && res.source) { input.value = res.source; }
      var active = (res && res.active) || '';
      var names = ((res && res.themes) || []).map(function (t) { return t.id + ':' + t.bytes; }).join(',');
      setStateText(active ? ('主题：' + active + ' 已启用') : (names ? ('主题：已安装 ' + names + '（未启用）') : '主题：未安装'));
      log('theme.list.done', { active: active, themes: names || 'none', source: (res && res.source) || '' });
      return res;
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    state.baseline = (document.body && document.body.className !== undefined) ? computedVars() : {};
    applyMode('boot');
    decorate();
    watch();
    watchViewport();
    logClasses();
    /* 特异性与规则命中不依赖主题是否装上：宿主层一旦出现 ID 选择器，这里立刻能看出来。 */
    logSpecificity();
    logUi();
    logRules();

    var tries = 0;
    function waitBridge() {
      tries++;
      call('theme.config', {}).then(function (res) {
        state.config = res;
        var input = $('theme-source');
        if (input && !input.value && res && res.source) { input.value = res.source; }
        pollHostMode();
        log('theme.config.done', { source: (res && res.source) || '', active: (res && res.active) || '', count: ((res && res.themes) || []).length });
        if (res && res.active) { enable(res.active); } else { refreshList(); }
      }).catch(function (err) {
        if (tries < 60) { setTimeout(waitBridge, 500); }
        else { setStateText('主题：宿主通道不可用'); log('theme.fail.bridge', { message: String(err && err.message ? err.message : err) }); }
      });
    }
    waitBridge();

    setInterval(pollHostMode, 1500);

    var bind = function (id, fn) {
      var el = $(id);
      if (el) { el.addEventListener('click', function (ev) { ev.preventDefault(); try { fn(); } catch (e) { log('theme.fail.ui', { id: id, message: String(e && e.message ? e.message : e) }); } }); }
    };
    bind('btn-theme-install', install);
    bind('btn-theme-enable', function () {
      var t = state.config && state.config.themes && state.config.themes[0];
      enable((state.config && state.config.active) || (t && t.id) || '');
    });
    bind('btn-theme-disable', disable);
    bind('btn-theme-probe', function () {
      logProbe();
      logStates();
      logCoverage(state.theme ? state.theme.css : '');
      logClasses();
      logUi();
      logSpecificity();
      logRules();
    });
    // 明暗切换有两个入口：侧栏按钮与状态栏条目。状态栏常在最后一行可见，
    // 侧栏被插件卡片挤高时仍能点到（见 html 里主题面板置顶的注释）。
    var toggleMode = function () {
      state.override = isDarkNow() ? 'light' : 'dark';
      var m = applyMode('manual');
      log('theme.mode', { dark: m.dark, source: 'manual', override: state.override });
      logStates();
    };
    bind('btn-theme-mode', toggleMode);
    bind('status-mode', toggleMode);
    bind('btn-theme-panel', function () {
      var panel = $('theme-panel');
      if (panel) { panel.hidden = !panel.hidden; }
    });
  }

  /* 静态门禁（scripts/tests/theme-evidence.cjs 的 jsdom 路径）直接调用这三个真实函数：
     补类、视口类、UI 采样都在页面代码里跑一遍，门禁不另写一份实现。 */
  window.LexiTheme = { decorate: decorate, applyViewport: applyViewport, sampleUi: sampleUi, watch: watch };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
