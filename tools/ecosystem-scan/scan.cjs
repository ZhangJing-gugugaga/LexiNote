#!/usr/bin/env node
// Static scan of cached Obsidian community plugin main.js bundles.
// Produces tools/ecosystem-scan/result.json and tools/ecosystem-scan/REPORT.md.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.fixtures-out', 'eco-scan');
const CACHE = path.join(OUT, 'cache');
const MANIFEST = path.join(OUT, 'fetch-manifest.json');
const HERE = __dirname;

const NODE_BUILTINS = new Set(['fs','path','child_process','os','crypto','http','https','net','tls','stream','events','buffer','url','util','zlib','assert','process','querystring','readline','worker_threads','vm','module','perf_hooks','string_decoder','dns','dgram','cluster','v8','async_hooks','timers','constants','tty','repl','sys','punycode','inspector']);

const CM_EXPORTS = {
  '@codemirror/view': ['EditorView','ViewPlugin','ViewUpdate','Decoration','WidgetType','MatchDecorator','GutterMarker','gutter','gutters','lineNumbers','highlightActiveLine','highlightActiveLineGutter','highlightSpecialChars','drawSelection','dropCursor','rectangularSelection','crosshairCursor','highlightWhitespace','highlightTrailingWhitespace','keymap','placeholder','scrollPastEnd','showPanel','panels','tooltips','hoverTooltip','theme','baseTheme'],
  '@codemirror/state': ['EditorState','StateField','StateEffect','Text','RangeSet','RangeSetBuilder','Range','SelectionRange','ChangeSet','Compartment','Facet','Prec','Transaction','Annotation','combineConfig','EditorSelection','TextIterator','CharCategory'],
  '@codemirror/language': ['syntaxTree','syntaxHighlighting','HighlightStyle','Language','StreamLanguage','LanguageDescription','indentUnit','indentOnInput','bracketMatching','foldGutter','foldService','codeFolding','foldAll','unfoldAll','foldCode','unfoldCode','foldedRanges','getLanguage','ensureSyntaxTree','syntaxParserRunning','defaultHighlightStyle','defineLanguageFacet','indentNodeProp','languageDataProp'],
  '@codemirror/commands': ['defaultKeymap','history','historyKeymap','undo','redo','undoSelection','redoSelection','indentMore','indentLess','toggleComment','lineComment','blockComment','moveLineUp','moveLineDown','copyLineDown','copyLineUp','deleteLine','selectLine','transposeChars','cursorCharLeft','cursorCharRight','cursorLineUp','cursorLineDown','cursorDocStart','cursorDocEnd','addCursorAbove','addCursorBelow','selectAll','deleteGroupBackward'],
  '@codemirror/search': ['search','searchKeymap','openSearchPanel','closeSearchPanel','highlightSelectionMatches','SearchQuery','setSearchQuery','getSearchQuery','findNext','findPrevious','replaceAll','replaceNext','selectMatches','searchPanelOpen','gotoLine'],
  '@codemirror/autocomplete': ['autocompletion','completionKeymap','CompletionContext','startCompletion','closeCompletion','acceptCompletion','completeFromList','ifNotIn','snippet','snippetCompletion','completionStatus','moveCompletionSelection'],
  '@codemirror/lint': ['linter','lintGutter','Diagnostic','setDiagnostics','lintKeymap','forceLinting','diagnosticCount','openLintPanel','closeLintPanel'],
  '@codemirror/closebrackets': ['closeBrackets','closeBracketsKeymap','deleteBracketPair'],
  '@codemirror/matchbrackets': ['matchBrackets','bracketMatching'],
  '@codemirror/comment': ['toggleComment','commentKeymap','lineComment','blockComment'],
  '@codemirror/fold': ['foldGutter','foldService','foldCode','unfoldCode','foldAll','unfoldAll','foldedRanges','codeFolding','foldKeymap'],
  '@codemirror/highlight': ['syntaxHighlighting','HighlightStyle','highlightTree','defaultHighlightStyle','tagHighlighter'],
  '@codemirror/lang-markdown': ['markdown','markdownLanguage','commonmarkLanguage','insertNewlineContinueMarkup','deleteMarkupBackward'],
  '@codemirror/lang-javascript': ['javascript','javascriptLanguage','typescriptLanguage','jsxLanguage','tsxLanguage','esLint'],
  '@codemirror/lang-css': ['css','cssLanguage'],
  '@codemirror/lang-html': ['html','htmlLanguage','autoCloseTags'],
  '@codemirror/lang-python': ['python','pythonLanguage'],
  '@codemirror/lang-json': ['json','jsonLanguage'],
  '@codemirror/lang-java': ['java','javaLanguage'],
  '@codemirror/lang-sql': ['sql','sqlLanguage','SQLDialect','StandardSQL','MySQL','PostgreSQL','SQLite'],
  '@codemirror/lang-xml': ['xml','xmlLanguage'],
  '@codemirror/lang-yaml': ['yaml','yamlLanguage'],
  '@codemirror/lang-php': ['php','phpLanguage'],
  '@codemirror/lang-cpp': ['cpp','cppLanguage'],
  '@codemirror/lang-rust': ['rust','rustLanguage'],
  '@codemirror/lang-go': ['go','goLanguage'],
  '@codemirror/theme-one-dark': ['oneDark','oneDarkHighlightStyle','oneDarkTheme'],
  '@codemirror/collab': ['collab','receiveUpdates','sendableUpdates','getSyncedVersion','updateUserEvent'],
  '@codemirror/legacy-modes': ['StreamLanguage','streamParser'],
  '@codemirror/stream-parser': ['StreamLanguage','streamParser','Language'],
  '@codemirror/panel': ['showPanel','panels'],
  '@codemirror/rangeset': ['RangeSet','RangeSetBuilder','Range'],
  '@codemirror/text': ['Text','TextIterator'],
  '@codemirror/tooltip': ['showTooltip','tooltips','hoverTooltip'],
};

function escapeRe(s) { return s.replace(/[.*+?^$()|[\]\\{}]/g, function (c) { return '\\' + c; }); }

function isBareSpec(s) { return s.length < 100 && /^[@A-Za-z0-9/._:-]+$/.test(s) && !s.startsWith('.') && !s.startsWith('/'); }

function isOptionalRequire(text, mod) {
  let idx = text.indexOf('"' + mod + '"');
  const single = text.indexOf("'" + mod + "'");
  if (idx === -1 || (single !== -1 && single < idx)) idx = single;
  if (idx === -1) return false;
  const before = text.slice(Math.max(0, idx - 400), idx);
  const lastTry = Math.max(before.lastIndexOf('try{'), before.lastIndexOf('try {'));
  if (lastTry === -1) return false;
  if (/\bcatch\b/.test(before.slice(lastTry))) return false;
  return /\bcatch\b/.test(text.slice(idx, idx + 400));
}

function classifyModule(spec) {
  if (spec.startsWith('@codemirror/')) return 'codemirror';
  if (spec === 'electron' || spec.startsWith('electron/') || spec.startsWith('node:') || NODE_BUILTINS.has(spec)) return 'node';
  return 'other';
}

function scanFile(text) {
  const requires = new Map();
  for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) requires.set(m[1], (requires.get(m[1]) || 0) + 1);
  for (const m of text.matchAll(/\b(?:import|export)\s[^;]{0,200}?\bfrom\s*["']([^"']+)["']/g)) requires.set(m[1], (requires.get(m[1]) || 0) + 1);
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) requires.set(m[1], (requires.get(m[1]) || 0) + 1);
  const dynamicRequires = [];
  for (const m of text.matchAll(/require\(\s*([^"')\s][^)]{0,60})\)/g)) {
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ');
    const viaWindow = /window\.$/.test(text.slice(Math.max(0, m.index - 7), m.index));
    dynamicRequires.push((viaWindow ? 'window.require' : 'require') + ' @offset ' + m.index + ' · ' + ctx);
  }

  const externals = [...requires.keys()].filter(function (s) { return isBareSpec(s) && s !== 'obsidian' && !s.startsWith('obsidian/'); });
  const groups = { codemirror: [], node: [], other: [] };
  for (const s of externals) groups[classifyModule(s)].push(s);

  const symbols = {};
  for (const mod of groups.codemirror) {
    const allow = CM_EXPORTS[mod];
    const props = new Map();
    const Q = '["' + String.fromCharCode(39) + ']';
    const bindRe = new RegExp('(?:var|let|const|,)\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*[^;,\\n]{0,80}?require\\(\\s*' + Q + escapeRe(mod) + Q + '\\s*\\)', 'g');
    const names = new Set();
    for (const m of text.matchAll(bindRe)) names.add(m[1]);
    const destrRe = new RegExp('(?:var|let|const)\\s*\\{([^}]{0,300})\\}\\s*=\\s*require\\(\\s*' + Q + escapeRe(mod) + Q + '\\s*\\)', 'g');
    for (const m of text.matchAll(destrRe)) {
      for (const part of m[1].split(',')) { const k = part.split(':')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) props.set(k, (props.get(k) || 0) + 1); }
    }
    for (const name of names) {
      const propRe = new RegExp('\\b' + escapeRe(name) + '\\.([A-Za-z_$][\\w$]*)', 'g');
      for (const m of text.matchAll(propRe)) {
        const sym = m[1];
        if (allow ? allow.includes(sym) : /^[A-Z]/.test(sym)) props.set(sym, (props.get(sym) || 0) + 1);
      }
    }
    symbols[mod] = [...props.entries()].sort(function (a, b) { return b[1] - a[1]; }).map(function (e) { return { name: e[0], count: e[1] }; });
  }

  const hostGlobals = [];
  if (/\bwindow\.moment\b/.test(text) || /(^|[^.\w$])moment\s*[.(]/.test(text)) hostGlobals.push('moment');
  if (/\bwindow\.require\b/.test(text)) hostGlobals.push('window.require');
  if (/\bactiveWindow\b/.test(text)) hostGlobals.push('activeWindow');
  if (/\bactiveDocument\b/.test(text)) hostGlobals.push('activeDocument');
  if (/\bwindow\.CodeMirror\b/.test(text) || /\bCodeMirror\.[A-Za-z]/.test(text)) hostGlobals.push('CodeMirror(CM5)');

  let category;
  if (groups.other.length) category = 'D';
  else if (groups.node.length) category = 'C';
  else if (groups.codemirror.length) category = 'B';
  else if (dynamicRequires.length) category = 'U';
  else category = 'A';

  const optionalModules = externals.filter(function (m) { return isOptionalRequire(text, m); });

  return { externals: externals, groups: groups, symbols: symbols, dynamicRequires: [...new Set(dynamicRequires)], hostGlobals: hostGlobals, optionalModules: optionalModules, category: category };
}

function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const rows = [];
  for (const p of manifest.plugins) {
    const file = path.join(CACHE, p.id, 'main.js');
    if (p.status !== 'ok' || !fs.existsSync(file)) {
      rows.push(Object.assign({}, p, { category: 'FAIL', symbols: {}, groups: { codemirror: [], node: [], other: [] }, externals: [], dynamicRequires: [], hostGlobals: [], optionalModules: [] }));
      continue;
    }
    const text = fs.readFileSync(file, 'latin1');
    const scan = scanFile(text);
    rows.push(Object.assign({}, p, { bytes: fs.statSync(file).size }, scan));
  }

  const ok = rows.filter(function (r) { return r.category !== 'FAIL'; });
  const counts = { A: 0, B: 0, C: 0, D: 0, U: 0, FAIL: 0 };
  for (const r of rows) counts[r.category]++;
  const denom = counts.A + counts.B + counts.C + counts.D;
  const rate = denom ? counts.A / denom : 0;
  const aWithGlobals = rows.filter(function (r) { return r.category === 'A' && (r.hostGlobals || []).length; });
  const aStrictRisk = aWithGlobals.filter(function (r) { return r.hostGlobals.some(function (g) { return g === 'moment' || g.indexOf('CodeMirror') === 0; }); }).length;

  const bRows = rows.filter(function (r) { return r.category === 'B'; });
  const freq = new Map();
  for (const r of bRows) {
    for (const mod of Object.keys(r.symbols || {})) {
      for (const s of r.symbols[mod]) {
        const key = mod + ':' + s.name;
        const e = freq.get(key) || { module: mod, symbol: s.name, mentions: 0, plugins: new Set() };
        e.mentions += s.count;
        e.plugins.add(r.id);
        freq.set(key, e);
      }
    }
  }
  const freqRows = [...freq.values()].map(function (e) { return { module: e.module, symbol: e.symbol, mentions: e.mentions, plugins: e.plugins.size, pluginIds: [...e.plugins] }; }).sort(function (a, b) { return b.plugins - a.plugins || b.mentions - a.mentions; });

  const allCmRows = rows.filter(function (r) { return (r.groups.codemirror || []).length > 0; });
  const allCmFreq = new Map();
  for (const r of allCmRows) {
    for (const mod of Object.keys(r.symbols)) {
      for (const s of r.symbols[mod]) {
        const key = mod + ':' + s.name;
        const e = allCmFreq.get(key) || { module: mod, symbol: s.name, mentions: 0, plugins: new Set() };
        e.mentions += s.count;
        e.plugins.add(r.id);
        allCmFreq.set(key, e);
      }
    }
  }
  const allCmFreqRows = [...allCmFreq.values()].map(function (e) { return { module: e.module, symbol: e.symbol, mentions: e.mentions, plugins: e.plugins.size, pluginIds: [...e.plugins] }; }).sort(function (a, b) { return b.plugins - a.plugins || b.mentions - a.mentions; });
  const allCmUsers = allCmRows.map(function (r) { return r.id; });

  const unionByModule = {};
  for (const r of bRows) for (const mod of Object.keys(r.symbols)) {
    unionByModule[mod] = unionByModule[mod] || new Set();
    for (const s of r.symbols[mod]) unionByModule[mod].add(s.name);
  }
  const unionSet = Object.keys(unionByModule).map(function (mod) { return { module: mod, symbols: [...unionByModule[mod]].sort() }; });

  const needed = bRows.map(function (r) {
    const need = [];
    for (const mod of Object.keys(r.symbols)) for (const s of r.symbols[mod]) need.push(mod + ':' + s.name);
    return { id: r.id, need: need.sort() };
  });
  const acc = new Set();
  const milestones = [];
  for (const f2 of freqRows) {
    acc.add(f2.module + ':' + f2.symbol);
    const covered = needed.filter(function (n) { return n.need.every(function (k) { return acc.has(k); }); });
    milestones.push({ added: f2.module + ':' + f2.symbol, size: acc.size, covered: covered.length, coveredIds: covered.map(function (n) { return n.id; }), rate: denom ? (counts.A + covered.length) / denom : 0 });
  }
  const cheapest = needed.slice().sort(function (a, b) { return a.need.length - b.need.length; })[0] || null;
  const cheapestRate = denom && cheapest ? (counts.A + 1) / denom : rate;

  const projectedFull = denom ? (counts.A + counts.B) / denom : 0;
  const totalBytes = ok.reduce(function (a, r) { return a + (r.bytes || 0); }, 0);

  const result = {
    generatedAt: new Date().toISOString(),
    source: manifest.listUrl,
    sampleRule: 'first ' + rows.length + ' entries in community-plugins.json order',
    sampleSize: rows.length,
    downloads: {
      lastRun: manifest.lastRun || { downloadsMade: manifest.downloadsMade, cacheHits: manifest.cacheHits },
      runs: manifest.runs || null,
      totalDownloads: manifest.totalDownloads != null ? manifest.totalDownloads : manifest.downloadsMade,
      totalNetworkBytes: manifest.totalNetworkBytes != null ? manifest.totalNetworkBytes : totalBytes,
      ok: rows.length - counts.FAIL,
      failed: counts.FAIL,
      cachedBytes: totalBytes,
    },
    counts: counts, denom: denom, loadableRate: rate, projectedAfterCodemirror: projectedFull,
    aPluginsWithHostGlobals: aWithGlobals.map(function (r) { return { id: r.id, globals: r.hostGlobals }; }),
    aStrictRisk: aStrictRisk,
    aStrictRate: denom ? (counts.A - aStrictRisk) / denom : 0,
    dynamicRequirePlugins: rows.filter(function (r) { return r.dynamicRequires.length; }).map(function (r) { return { id: r.id, exprs: r.dynamicRequires }; }),
    hostGlobalPlugins: rows.filter(function (r) { return (r.hostGlobals || []).length; }).map(function (r) { return { id: r.id, globals: r.hostGlobals }; }),
    codemirrorSymbolFreq: freqRows,
    allCodemirrorUsers: allCmUsers,
    allCodemirrorSymbolFreq: allCmFreqRows,
    minimalSetUnion: unionSet,
    perPluginNeeds: needed,
    coverageMilestones: milestones,
    cheapestSinglePlugin: cheapest,
    cheapestSinglePluginRate: cheapestRate,
    plugins: rows.map(function (r) { return { id: r.id, repo: r.repo, bytes: r.bytes || 0, status: r.status, category: r.category, externals: r.externals, symbols: r.symbols, dynamicRequires: r.dynamicRequires, hostGlobals: r.hostGlobals, error: r.error || null, optionalModules: r.optionalModules || [] }; }),
  };
  fs.writeFileSync(path.join(HERE, 'result.json'), JSON.stringify(result, null, 2));

  const L = [];
  L.push('# Obsidian 社区插件 main.js 静态依赖扫描报告');
  L.push('');
  L.push('- 生成时间: ' + result.generatedAt);
  L.push('- 抽样源: ' + manifest.listUrl);
  L.push('- 抽样规则: 按该 JSON 顺序取前 ' + result.sampleSize + ' 个（不人工挑选）');
  const d = result.downloads;
  L.push('- 下载缓存: `.fixtures-out/eco-scan/cache/<id>/main.js`（幂等：缓存命中不重复下载）');
  L.push('- 最近一次运行: 缓存命中 ' + d.lastRun.cacheHits + ' 个 / 实际下载 ' + d.lastRun.downloadsMade + ' 次；下载成功 ' + d.ok + ' 个，失败 ' + d.failed + ' 个');
  L.push('- 累计（' + (d.runs ? d.runs.length : 1) + ' 次运行）: 网络下载 ' + d.totalDownloads + ' 次、' + d.totalNetworkBytes + ' 字节 (' + fmtBytes(d.totalNetworkBytes) + ')；当前缓存文件合计 ' + totalBytes + ' 字节 (' + fmtBytes(totalBytes) + ')');
  L.push('- 扫描方式: 从原始 bundle 文本提取 `require("...")` / `from "..."` / `import("...")` 的字面量说明符；非相对且非 `obsidian` 的视为宿主模块依赖。');
  L.push('');
  L.push('## 1. 逐插件结果');
  L.push('');
  L.push('| # | id | repo | main.js 字节 | 分类 | 命中的外部模块与符号 | 下载状态 |');
  L.push('|---|----|------|--------------|------|----------------------|----------|');
  rows.forEach(function (r, i) {
    const mods = r.groups.other.concat(r.groups.node, r.groups.codemirror);
    const detail = mods.length ? mods.map(function (m) {
      const syms = r.symbols[m];
      return syms && syms.length ? m + '(' + syms.map(function (s) { return s.name; }).join(',') + ')' : m;
    }).join('; ') : (r.category === 'A' ? '仅 obsidian' : r.category === 'U' ? '动态 require: ' + r.dynamicRequires.join(' | ') : '-');
    const opt = (r.optionalModules && r.optionalModules.length) ? ' [try/catch 内可选: ' + r.optionalModules.join(',') + ']' : '';
    const glob = (r.hostGlobals && r.hostGlobals.length) ? ' 全局: ' + r.hostGlobals.join(',') : '';
    L.push('| ' + (i + 1) + ' | ' + r.id + ' | ' + r.repo + ' | ' + (r.bytes || 0) + ' | ' + r.category + ' | ' + detail + opt + glob + ' | ' + r.status + (r.error ? ' (' + r.error + ')' : '') + ' |');
  });
  L.push('');
  L.push('## 2. 分类计数与可加载率');
  L.push('');
  L.push('| 分类 | 含义 | 数量 |');
  L.push('|------|------|------|');
  L.push('| A | 只依赖 obsidian（沙箱当前即可加载） | ' + counts.A + ' |');
  L.push('| B | 需要 @codemirror/* | ' + counts.B + ' |');
  L.push('| C | 需要 electron / node 内建 | ' + counts.C + ' |');
  L.push('| D | 需要其他未提供模块 | ' + counts.D + ' |');
  L.push('| U | 含动态 require，无法静态判定 | ' + counts.U + ' |');
  L.push('| FAIL | 下载失败（未参与分类） | ' + counts.FAIL + ' |');
  L.push('');
  L.push('**可加载率 = A / (A+B+C+D) = ' + counts.A + ' / ' + denom + ' = ' + (rate * 100).toFixed(1) + '%**（U 与 FAIL 不计入分母，见第 5 节）。');
  L.push('');
  L.push('这个数字的口径是「模块依赖只落在 obsidian 包内」。A 类里还有 ' + aWithGlobals.length + ' 个插件引用了宿主全局（见 2.1）：' + aWithGlobals.map(function (r) { return r.id + '(' + r.hostGlobals.join(',') + ')'; }).join('、') + '。');
  L.push('若沙箱未注入 moment / CodeMirror(CM5)，这 ' + aWithGlobals.filter(function (r) { return r.hostGlobals.some(function (g) { return g === 'moment' || g.indexOf('CodeMirror') === 0; }); }).length + ' 个里引用这两个全局的插件实际也加载不了，可加载率会降到 (' + counts.A + '-' + aStrictRisk + ')/' + denom + ' = ' + (((counts.A - aStrictRisk) / denom) * 100).toFixed(1) + '%（下限，未验证）。');
  L.push('');
  L.push('### 2.1 宿主全局依赖（obsidian 包之外需要注入的全局）');
  L.push('');
  L.push('| 插件 | 命中的全局 |');
  L.push('|------|------------|');
  for (const r of rows) { if ((r.hostGlobals || []).length) L.push('| ' + r.id + ' | ' + r.hostGlobals.join(', ') + ' |'); }
  L.push('');
  L.push('共 ' + rows.filter(function (r) { return (r.hostGlobals || []).length; }).length + ' / ' + rows.length + ' 个插件引用至少一个宿主全局。其中 moment 与 CodeMirror(CM5) 属于沙箱当前未注入的全局；activeWindow/activeDocument 是 Obsidian 的 DOM 别名，window.require 是 Electron 连通性标志（已同时命中 C 类模块依赖）。');
  L.push('');
  L.push('## 3. B 类 @codemirror/* 符号频次表');
  L.push('');
  if (!freqRows.length) L.push('（无 B 类命中）');
  else {
    L.push('| 模块 | 符号 | 提及次数 | 使用该符号的插件数 | 插件 |');
    L.push('|------|------|----------|------------------|------|');
    for (const f of freqRows) L.push('| ' + f.module + ' | ' + f.symbol + ' | ' + f.mentions + ' | ' + f.plugins + ' | ' + f.pluginIds.join(', ') + ' |');
  }
  L.push('');
  L.push('### 3.1 参考：全部引用 @codemirror/* 的插件（含 B/C/D 类）的符号频次');
  L.push('');
  L.push('这一节不改变分类，只用于判断兼容模块该写哪些符号；B 类之外的插件还缺别的模块，补 @codemirror/* 不会让它们可加载。');
  L.push('');
  L.push('| 模块 | 符号 | 提及次数 | 使用该符号的插件数 | 插件 |');
  L.push('|------|------|----------|------------------|------|');
  for (const f2 of allCmFreqRows) L.push('| ' + f2.module + ' | ' + f2.symbol + ' | ' + f2.mentions + ' | ' + f2.plugins + ' | ' + f2.pluginIds.join(', ') + ' |');
  L.push('');
  L.push('## 4. 最小兼容模块集与重算');
  L.push('');
  L.push('### 4.1 每个 B 类插件各自需要的最小符号集');
  L.push('');
  L.push('| 插件 | 符号数 | 所需符号 | 只解锁该插件后的可加载率 |');
  L.push('|------|--------|----------|--------------------------|');
  for (const n of needed) {
    L.push('| ' + n.id + ' | ' + n.need.length + ' | ' + n.need.join(', ') + ' | (' + counts.A + '+1)/' + denom + ' = ' + (((counts.A + 1) / denom) * 100).toFixed(1) + '% |');
  }
  L.push('');
  L.push('最便宜的单插件解锁: **' + (cheapest ? cheapest.id + '（' + cheapest.need.length + ' 个符号）' : 'n/a') + '**，可加载率 ' + (cheapestRate * 100).toFixed(1) + '%（同一批样本重算）。');
  L.push('');
  L.push('### 4.2 覆盖全部 B 类插件的最小符号集（并集，' + unionSet.reduce(function (a, u) { return a + u.symbols.length; }, 0) + ' 个符号）');
  L.push('');
  for (const u of unionSet) L.push('- `' + u.module + '`: ' + u.symbols.join(', '));
  L.push('');
  L.push('### 4.3 按顺序补齐时的覆盖率里程（同一批样本重算，非估算）');
  L.push('');
  L.push('顺序 = 先补被最多 B 类插件用到的符号（同频次按提及次数降序）；只列覆盖率发生变化的行。');
  L.push('');
  L.push('| 已补符号数 | 本次加入 | 完全可加载的 B 类插件 | 可加载率 |');
  L.push('|------------|----------|------------------------|----------|');
  let lastCovered = 0;
  for (const m of milestones) {
    if (m.covered === lastCovered) continue;
    lastCovered = m.covered;
    L.push('| ' + m.size + ' | ' + m.added + ' | ' + m.covered + ' (' + m.coveredIds.join(', ') + ') | ' + '(' + counts.A + '+' + m.covered + ')/' + denom + ' = ' + (m.rate * 100).toFixed(1) + '% |');
  }
  L.push('');
  L.push('**结论（同一批样本）**: 只补最便宜的单插件集 → ' + (cheapestRate * 100).toFixed(1) + '%；补齐全集 ' + unionSet.reduce(function (a, u) { return a + u.symbols.length; }, 0) + ' 个符号 → (' + counts.A + '+' + counts.B + ')/' + denom + ' = **' + (projectedFull * 100).toFixed(1) + '%**。');
  L.push('');
  L.push('注意 obsidian-tasks 8.6.0 只用 `ViewPlugin.fromClass`，属于本表 @codemirror/view 的低频符号——它不在这 24 个样本里，所以「补 ViewPlugin 能解锁 tasks」与「覆盖本表符号集能提升多少比例」是两件事，不要混算。');
  L.push('');
  L.push('## 5. 我没能确定的');
  L.push('');
  L.push('- **非字面量 require 无法静态判定**: ' + result.dynamicRequirePlugins.length + ' 个插件出现 `require(变量)` 或 `window.require(变量)`（参数不是字符串字面量，静态无法确定目标模块）。这些插件**没有**被默认算进 A 类。');
  L.push('  - U 类计数 = ' + counts.U + '：只有当某插件除动态 require 外没有其它可识别的外部模块时才归 U；若它还有静态外部依赖，按优先级已归入 B/C/D，但仍计入下面这个「含动态 require 的插件数」。');
  for (const dr of result.dynamicRequirePlugins) L.push('  - ' + dr.id + '（分类 ' + (rows.find(function (r) { return r.id === dr.id; }) || {}).category + '）: ' + dr.exprs.join(' | '));
  L.push('- **宿主全局的可用性未验证**: 上表列出 moment / CodeMirror(CM5) / activeWindow / activeDocument / window.require 的引用，但沙箱是否已注入这些全局、注入后语义是否完整，本轮没有验证（未上设备）。');
  L.push('- **try/catch 可选依赖按严格口径计入分类**: ' + rows.filter(function (r) { return (r.optionalModules || []).length; }).length + ' 个插件的外部模块位于 try/catch 内（见第 1 节标注），沙箱抛错可能被 catch 住从而仍能加载；本表没有把这种情况算作 A，属于偏保守。');
  L.push('- **下载失败**: ' + counts.FAIL + ' 个，已从分母剔除，未当作 A 类；失败项本身可能改变比例。');
  L.push('- 静态扫描只能证明「代码里引用了某模块」，不能证明运行时真的执行到；也不能证明补了模块后行为正确（API 语义可能缺失）。');
  L.push('- 符号提取依赖 CodeMirror 导出名白名单 + `var X = require(...)` 绑定识别，可能漏掉解构别名/间接传递用到的符号。');
  L.push('- 样本 ' + result.sampleSize + ' 个，且是文件顺序最前面的一批（偏早期插件），**不可外推**为整个生态的比例。');
  L.push('');
  L.push('## 6. 复现');
  L.push('');
  L.push('```');
  L.push('node tools/ecosystem-scan/fetch.cjs   # 幂等下载，缓存命中不重复下载');
  L.push('node tools/ecosystem-scan/scan.cjs    # 扫描缓存并生成 result.json / REPORT.md');
  L.push('```');
  fs.writeFileSync(path.join(HERE, 'REPORT.md'), L.join('\n') + '\n');
  console.log('A=' + counts.A + ' B=' + counts.B + ' C=' + counts.C + ' D=' + counts.D + ' U=' + counts.U + ' FAIL=' + counts.FAIL + ' rate=' + (rate * 100).toFixed(1) + '% projected=' + (projectedFull * 100).toFixed(1) + '% cheapestSingle=' + (cheapest ? cheapest.id + '(' + cheapest.need.length + ' syms) ' + (cheapestRate * 100).toFixed(1) + '%' : 'n/a'));
}
main();
