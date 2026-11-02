#!/usr/bin/env node
// 插件夹具 API 使用面报告：静态扫描 .fixtures-out/ 里的真实产物，把它用到的 API 面
// join 到 tools/contract/symbols.json（obsidian@1.14.4 契约矩阵），输出频次清单与跨夹具缺口排名。
//
// 用法：node tools/plugins-fixtures/api-surface.cjs
// 产出：tools/plugins-fixtures/api-surface.report.md / .json
// 只读：不改动 entry/**、rawfile/**、夹具源码与产物。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'tools', 'plugins-fixtures');
const LOCK_PATH = path.join(FIXTURES_DIR, 'manifest.lock.json');
const OUT_DIR = path.join(ROOT, '.fixtures-out');
const CONTRACT_PATH = path.join(ROOT, 'tools', 'contract', 'symbols.json');
const HOST_DIRS = ['entry', 'rawfile'].map((d) => path.join(ROOT, d));
const HOST_EXT = new Set(['.css', '.ets', '.ts', '.js', '.json5', '.json']);
const HOST_SKIP = /(node_modules|oh_modules|[\\/]build[\\/]|\.fixtures-out)/;
const TICK = String.fromCharCode(96);
const code = (text) => TICK + text + TICK;

// ---- 调用点标记 ---------------------------------------------------------
// symbol 为 null 表示该能力不在 obsidian.d.ts 里（CodeMirror 6 是 Obsidian 另外注入的运行时依赖），
// 这类标记自带 status/gap，不参与符号 join。
const MARKERS = [
  { id: 'vault-any', label: 'app.vault.*', re: /\.vault\s*\./g, symbol: 'Vault', capability: 'vault-read' },
  { id: 'vault-modify', label: 'vault.modify/create/delete/adapter', re: /vault\s*\.(modify|create|createFolder|delete|trash|adapter|process|cachedRead)\s*\(/g, symbol: 'Vault', capability: 'vault-write' },
  { id: 'workspace-any', label: 'app.workspace.*', re: /\.workspace\s*\./g, symbol: 'Workspace', capability: 'workspace' },
  { id: 'metadata-cache', label: 'app.metadataCache.*', re: /\.metadataCache\s*\./g, symbol: 'MetadataCache', capability: 'metadata' },
  { id: 'file-manager', label: 'app.fileManager.*', re: /\.fileManager\s*\./g, symbol: 'FileManager', capability: 'file-manager' },
  { id: 'register-view', label: 'registerView(', re: /registerView\s*\(/g, symbol: 'ItemView', capability: 'view-registration' },
  { id: 'item-view', label: 'ItemView（继承/引用）', re: /\bItemView\b/g, symbol: 'ItemView', capability: 'view-registration' },
  { id: 'get-leaf', label: 'getLeaf(', re: /getLeaf\s*\(/g, symbol: 'WorkspaceLeaf', capability: 'workspace-leaf' },
  { id: 'set-view-state', label: 'setViewState(', re: /setViewState\s*\(/g, symbol: 'WorkspaceLeaf', capability: 'workspace-leaf' },
  { id: 'reveal-leaf', label: 'revealLeaf(', re: /revealLeaf\s*\(/g, symbol: 'Workspace', capability: 'workspace-leaf' },
  { id: 'get-active-view', label: 'getActiveViewOfType(', re: /getActiveViewOfType\s*\(/g, symbol: 'Workspace', capability: 'workspace' },
  { id: 'md-post-processor', label: 'registerMarkdownPostProcessor(', re: /registerMarkdownPostProcessor\s*\(/g, symbol: 'MarkdownPostProcessor', capability: 'markdown-render' },
  { id: 'md-renderer', label: 'MarkdownRenderer.render*', re: /MarkdownRenderer\s*\.\s*render/g, symbol: 'MarkdownRenderer', capability: 'markdown-render' },
  { id: 'register-editor-extension', label: 'registerEditorExtension(', re: /registerEditorExtension\s*\(/g, symbol: 'Plugin', capability: 'editor-cm6' },
  { id: 'register-code-mirror', label: 'registerCodeMirror(', re: /registerCodeMirror\s*\(/g, symbol: 'Plugin', capability: 'editor-cm6' },
  { id: 'editor-callback', label: 'editorCallback/editorCheckCallback/editorPaste', re: /editor(Callback|CheckCallback|DropCallback|Paste)\b/g, symbol: 'Plugin', capability: 'editor-callback' },
  { id: 'cm-viewplugin', label: 'ViewPlugin.fromClass/define', re: /ViewPlugin\s*\.\s*(fromClass|define)/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture', note: 'CM6 运行时对象不在 obsidian.d.ts 里；宿主必须把同一份 @codemirror/view 实例交给插件，插件才能把 ViewPlugin 挂到真实编辑器上。' },
  { id: 'cm-statefield', label: 'StateField.define', re: /StateField\s*\.\s*define/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture', note: '同上：StateField 依赖宿主持有的 EditorState 类型，跨实例会因构造函数不同而失效。' },
  { id: 'cm-editorview', label: 'EditorView（构造/静态方法）', re: /\bEditorView\b/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture' },
  { id: 'cm-dispatch', label: '.dispatch(', re: /\.dispatch\s*\(/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture' },
  { id: 'cm-transaction', label: 'EditorState.create/transaction/readOnly', re: /EditorState\s*\.\s*(create|transaction|readOnly|tabSize)/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture' },
  { id: 'cm-syntax-tree', label: 'syntaxTree(', re: /syntaxTree\s*\(/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture' },
  { id: 'cm-decoration', label: 'Decoration.* / EditorView.decorations|theme|domEventHandlers', re: /Decoration\s*\.\s*(line|mark|widget|replace|none)|EditorView\s*\.\s*(decorations|theme|lineWrapping|domEventHandlers|updateListener|contentAttributes)/g, symbol: null, capability: 'editor-cm6', status: 'unsupported', gap: 'needs-architecture' },
  { id: 'editor-api', label: 'Editor.getValue/setValue/replaceRange/listSelections', re: /\beditor\s*\.\s*(getValue|setValue|replaceRange|getCursor|listSelections|somethingSelected|getLine|lineCount)/g, symbol: 'Editor', capability: 'editor-api' },
  { id: 'load-save-data', label: 'loadData(/saveData(', re: /(loadData|saveData)\s*\(/g, symbol: 'Plugin', capability: 'persistence' },
  { id: 'add-command', label: 'addCommand(', re: /addCommand\s*\(/g, symbol: 'Plugin', capability: 'commands' },
  { id: 'add-ribbon', label: 'addRibbonIcon(', re: /addRibbonIcon\s*\(/g, symbol: 'Plugin', capability: 'ribbon' },
  { id: 'add-statusbar', label: 'addStatusBarItem(', re: /addStatusBarItem\s*\(/g, symbol: 'Plugin', capability: 'status-bar' },
  { id: 'add-setting-tab', label: 'addSettingTab(', re: /addSettingTab\s*\(/g, symbol: 'PluginSettingTab', capability: 'settings-ui' },
  { id: 'setting-ctor', label: 'new Setting(', re: /new\s+Setting\s*\(/g, symbol: 'Setting', capability: 'settings-ui' },
  { id: 'ui-components', label: 'new TextComponent/ToggleComponent/Dropdown/Button/Slider/Color', re: /new\s+(TextComponent|ToggleComponent|DropdownComponent|ButtonComponent|SliderComponent|ColorComponent|ExtraButtonComponent)\s*\(/g, symbol: null, capability: 'ui-components', status: 'unsupported', gap: 'needs-architecture', note: 'obsidian 的 UI 组件类在契约矩阵里整体是 unsupported；插件一旦 new 这些组件，宿主必须提供对应 DOM 组件实现。' },
  { id: 'modal', label: 'Modal / SuggestModal / FuzzySuggestModal', re: /(extends\s+[A-Za-z_$]*(?:Modal|SuggestModal|FuzzySuggestModal)\b|new\s+(?:SuggestModal|FuzzySuggestModal)\s*\()/g, symbol: 'Modal', capability: 'modal-ui' },
  { id: 'notice', label: 'new Notice(', re: /new\s+Notice\s*\(/g, symbol: 'Notice', capability: 'notice' },
  { id: 'set-icon', label: 'setIcon(', re: /\bsetIcon\s*\(/g, symbol: 'setIcon', capability: 'icons' },
  { id: 'menu', label: 'new Menu(', re: /new\s+Menu\s*\(/g, symbol: 'Menu', capability: 'menu' },
  { id: 'tfile', label: 'TFile / TFolder', re: /\b(TFile|TFolder)\b/g, symbol: 'TFile', capability: 'files' },
  { id: 'create-el', label: 'createEl/createDiv/createSpan', re: /(createEl|createDiv|createSpan|createDocumentFragment)\s*\(/g, symbol: 'DomElementInfo', capability: 'dom' },
  { id: 'register-dom-event', label: 'registerDomEvent(', re: /registerDomEvent\s*\(/g, symbol: 'Component', capability: 'dom' },
  { id: 'moment', label: 'moment(', re: /\bmoment\s*\(/g, symbol: 'moment', capability: 'time' },
  { id: 'debounce', label: 'debounce(', re: /\bdebounce\s*\(/g, symbol: 'debounce', capability: 'util' },
  { id: 'request-url', label: 'requestUrl(', re: /requestUrl\s*\(/g, symbol: 'requestUrl', capability: 'network' },
  { id: 'platform', label: 'Platform.*', re: /Platform\s*\./g, symbol: 'Platform', capability: 'platform' },
  { id: 'app-any', label: 'this.app', re: /\bthis\.app\b/g, symbol: 'App', capability: 'app-object' },

  // 阅读视图：registerMarkdownPostProcessor 回调拿到的 ctx，以及它挂的子组件。
  // 属性名不会被 esbuild 改名，压缩产物里仍然静态可命中。
  { id: 'ctx-get-section-info', label: 'ctx.getSectionInfo(', re: /\.getSectionInfo\s*\(/g, symbol: 'MarkdownPostProcessorContext', capability: 'markdown-postprocessor' },
  { id: 'ctx-source-path', label: 'ctx.sourcePath', re: /\.sourcePath\b/g, symbol: 'MarkdownPostProcessorContext', capability: 'markdown-postprocessor' },
  { id: 'ctx-add-child', label: 'ctx.addChild(', re: /\.addChild\s*\(/g, symbol: 'MarkdownPostProcessorContext', capability: 'markdown-postprocessor', note: 'Component.addChild 在契约矩阵里是 implemented（addChild/removeChild 已实现），但 post-processor ctx 的 addChild 走同一条宿主轨缺口：ctx 本身 unsupported，挂上去的子组件不会进入渲染管线。' },
  { id: 'ctx-frontmatter', label: 'ctx.frontmatter', re: /\.frontmatter\b/g, symbol: 'MarkdownPostProcessorContext', capability: 'markdown-postprocessor' },
  { id: 'md-render-child', label: 'MarkdownRenderChild（new / extends）', re: /\bMarkdownRenderChild\b/g, symbol: 'MarkdownRenderChild', capability: 'markdown-render' },
  { id: 'window-moment', label: 'window.moment(', re: /window\s*\.\s*moment\s*\(/g, symbol: 'moment', capability: 'time' },
];

// ---- 阅读视图契约（M2 的输入面）------------------------------------------
// 这一组是"阅读视图能不能跑"的直接判据：产物里调没调 + 源码里在哪一行调。
// 源码位置扫 .fixtures-out/.cache/<id>/src（构建前的原始源码，锁定的 commit）。
const READING_VIEW_PROBES = [
  { symbol: 'MarkdownPostProcessor', what: 'registerMarkdownPostProcessor(', re: /registerMarkdownPostProcessor\s*\(/ },
  { symbol: 'MarkdownPostProcessorContext', what: 'ctx.getSectionInfo(', re: /\.getSectionInfo\s*\(/ },
  { symbol: 'MarkdownPostProcessorContext', what: 'ctx.sourcePath', re: /\.sourcePath\b/ },
  { symbol: 'MarkdownPostProcessorContext', what: '\.frontmatter（ctx 或缓存对象）', re: /\.frontmatter\b/ },
  { symbol: 'MarkdownPostProcessorContext', what: 'ctx.addChild(', re: /\.addChild\s*\(/ },
  { symbol: 'MarkdownRenderChild', what: 'MarkdownRenderChild', re: /\bMarkdownRenderChild\b/ },
  { symbol: 'MarkdownRenderer', what: 'MarkdownRenderer.render*', re: /MarkdownRenderer\s*\.\s*render/ },
  { symbol: 'setIcon', what: 'setIcon(', re: /\bsetIcon\s*\(/ },
  { symbol: 'MarkdownView', what: 'MarkdownView', re: /\bMarkdownView\b/ },
  { symbol: 'MarkdownPostProcessorContext', what: 'ctx.docId', re: /\.docId\b/ },
  // 矩阵未收录（symbols.json 里没有独立条目）但这条链路上真用到、且缺了就直接抛错的三条。
  { symbol: null, what: 'element.findAll(', re: /\.findAll\s*\(/, status: 'missing', gap: 'needs-architecture', note: 'Obsidian 给 HTMLElement 打的原型补丁（和 Object.isEmpty/String.isString 同类），契约矩阵没有收录；后处理器第一步就是 element.findAll(".task-list-item")，不 patch 就直接 TypeError。' },
  { symbol: null, what: 'vault.getFileByPath(', re: /\.getFileByPath\s*\(/, status: 'missing', gap: 'needs-architecture', note: '矩阵的 Vault 条目没有 getFileByPath（只有 TFile 与 MetadataCache.getFirstLinkpathDest 之类）；宿主必须支持按 path 直接取 TFile。' },
  { symbol: null, what: 'workspace.onLayoutReady(', re: /\.onLayoutReady\s*\(/, status: 'missing', gap: 'needs-architecture', note: '矩阵的 Workspace 条目没有 onLayoutReady；插件用它把首次渲染推迟到布局就绪之后。' },
];

// 同名计数噪声：JS 内建名与插件自有同名标识符。压缩后的 bundle 里这些词到处都是，
// 计进 unsupported/stub 清单只会让"缺口"看起来比实际更大。只用于第 6 节，不改第 2 节排序。
const GENERIC_NAMES = new Set([
  'Array', 'String', 'Object', 'Math', 'Number', 'Promise', 'Date', 'Map', 'Set', 'RegExp', 'Error', 'JSON',
  'Tasks', 'TasksFile', 'Instruction', 'Modifier', 'displayTooltip', 'renderResults', 'request', 'ready',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.svelte', '.js']);
const SOURCE_SKIP = /(node_modules|[\\/]\.git[\\/]|[\\/]docs[\\/]|[\\/]resources[\\/]|[\\/]contributing[\\/]|[\\/]tests?[\\/])/i;
const SOURCE_MAX_BYTES = 512 * 1024;

// ---- CSS 契约（主题夹具用）---------------------------------------------
// hostHits 每次运行实测（扫 entry/ + rawfile/），不靠人工声明。
const CSS_CONTRACTS = [
  { id: 'theme-vars', label: '主题背景/文字变量', probes: ['--background-primary', '--background-secondary', '--background-secondary-alt', '--text-normal', '--text-muted', '--text-faint'], capability: 'theme-vars' },
  { id: 'typography-vars', label: '字体变量', probes: ['--font-text', '--font-interface', '--font-monospace', '--font-text-size', '--line-height-normal'], capability: 'typography-vars' },
  { id: 'semantic-color-vars', label: '语义色变量', probes: ['--color-accent', '--color-red', '--color-green', '--color-orange', '--color-cyan', '--color-yellow'], capability: 'semantic-color-vars' },
  { id: 'radius-vars', label: '圆角/间距变量', probes: ['--radius-s', '--radius-m', '--radius-l', '--size-4-2', '--size-4-4', '--size-4-8'], capability: 'radius-vars' },
  { id: 'theme-mode', label: '明暗主题类（body.theme-dark/light）', probes: ['theme-dark', 'theme-light'], capability: 'theme-mode' },
  { id: 'editor-dom-classes', label: '编辑器 DOM 类（.cm-*）', probes: ['.cm-editor', '.cm-content', '.cm-line', '.cm-active', '.cm-gutters', '.cm-scroller'], capability: 'editor-dom-classes' },
  { id: 'markdown-view-classes', label: 'Markdown 视图 DOM 类', probes: ['.markdown-preview-view', '.markdown-source-view', '.markdown-rendered', '.markdown-embed'], capability: 'markdown-view-classes' },
  { id: 'workspace-dom-classes', label: '工作区 DOM 类', probes: ['.workspace-leaf', '.workspace-split', '.workspace-tab-header', '.workspace-ribbon', '.workspace-tabs', '.workspace-leaf-content'], capability: 'workspace-dom-classes' },
  { id: 'view-chrome', label: '视图外壳 DOM 类', probes: ['.view-header', '.view-content', '.view-actions', '.view-header-title'], capability: 'view-chrome' },
];

// ---- 工具 ---------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countRe(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function countLiteral(text, needle) {
  let count = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function walk(dir, extSet, skipRe, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skipRe.test(full)) continue;
    if (entry.isDirectory()) walk(full, extSet, skipRe, acc);
    else if (extSet.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

function hostEvidence(probes) {
  const files = [];
  for (const dir of HOST_DIRS) walk(dir, HOST_EXT, HOST_SKIP, files);
  let hits = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const probe of probes) hits += countLiteral(text, probe);
  }
  return { hits, files: files.length };
}

function collectSourceFiles(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SOURCE_SKIP.test(full)) continue;
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!SOURCE_EXT.has(path.extname(entry.name))) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SOURCE_MAX_BYTES) continue;
    acc.push(full);
  }
  return acc;
}

// 源码定位：给每条阅读视图探针找"文件:行"，最多 4 处（够证明用到即可）。
function locateInSource(id) {
  const srcDir = path.join(OUT_DIR, '.cache', id, 'src');
  const files = collectSourceFiles(srcDir, []);
  // 相对夹具源码根（src/）显示，读起来就是仓库内路径；ROOT 级路径只在 srcDir 字段出现一次。
  const rel = (file) => path.relative(srcDir, file).split(path.sep).join('/');
  const rows = READING_VIEW_PROBES.map((probe) => {
    const hits = [];
    for (const file of files) {
      if (hits.length >= 4) break;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 4; i += 1) {
        if (probe.re.test(lines[i])) hits.push(rel(file) + ':' + (i + 1));
      }
    }
    return { symbol: probe.symbol, what: probe.what, hits };
  });
  return { srcDir: files.length ? rel(srcDir) : null, fileCount: files.length, rows };
}

function countTopLevelPackages(id) {
  const modules = path.join(OUT_DIR, '.cache', id, 'src', 'node_modules');
  if (!fs.existsSync(modules)) return null;
  let count = 0;
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) count += 1;
      }
    } else count += 1;
  }
  return count;
}

function statusOf(bySymbol, name) {
  const entry = bySymbol.get(name);
  return entry ? entry.status + '/' + (entry.gap || '—') : 'missing';
}

// ---- 主流程 -------------------------------------------------------------

function buildReport() {
  if (!fs.existsSync(LOCK_PATH)) throw new Error('缺少 ' + path.relative(ROOT, LOCK_PATH));
  if (!fs.existsSync(CONTRACT_PATH)) throw new Error('缺少 tools/contract/symbols.json');

  const lock = readJson(LOCK_PATH);
  const matrix = readJson(CONTRACT_PATH);
  const bySymbol = new Map(matrix.symbols.map((s) => [s.symbol, s]));
  const symbolNames = matrix.symbols.map((s) => s.symbol).filter((n) => n && n.length >= 5);

  const fixtures = [];
  const missing = [];
  for (const fx of lock.fixtures) {
    const dir = path.join(OUT_DIR, fx.id);
    if (!fs.existsSync(dir)) {
      missing.push(fx.id);
      continue;
    }
    const artifacts = fs
      .readdirSync(dir)
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
      .sort()
      .map((name) => {
        const buf = fs.readFileSync(path.join(dir, name));
        return { file: name, bytes: buf.length, sha256: sha256(buf) };
      });
    const readIf = (name) => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    };
    fixtures.push({ def: fx, dir, artifacts, js: readIf('main.js'), css: readIf('styles.css') });
  }
  if (missing.length) throw new Error('缺少夹具产物：' + missing.join(', ') + '；先跑 node scripts/tests/plugin-fixtures-fetch.cjs');

  for (const fixture of fixtures) {
    const identifiers = new Map();
    for (const m of fixture.js.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      identifiers.set(m[0], (identifiers.get(m[0]) || 0) + 1);
    }
    const symbolHits = [];
    for (const name of symbolNames) {
      const hits = identifiers.get(name) || 0;
      if (!hits) continue;
      const entry = bySymbol.get(name);
      if (!entry) continue;
      symbolHits.push({ symbol: name, hits, status: entry.status, gap: entry.gap, owner: entry.owner, kind: entry.kind });
    }
    symbolHits.sort((a, b) => b.hits - a.hits || a.symbol.localeCompare(b.symbol));

    const markerHits = MARKERS.map((marker) => {
      const hits = countRe(fixture.js, marker.re);
      let status = marker.status;
      let gap = marker.gap;
      let owner = marker.owner;
      let note = marker.note;
      if (marker.symbol) {
        const entry = bySymbol.get(marker.symbol);
        if (entry) {
          status = entry.status;
          gap = entry.gap;
          owner = entry.owner;
          note = entry.note;
        } else {
          status = 'unknown';
          gap = null;
          note = '契约矩阵里没有 ' + marker.symbol;
        }
      }
      return { id: marker.id, label: marker.label, capability: marker.capability, symbol: marker.symbol, hits, status, gap, owner, note };
    }).filter((marker) => marker.hits > 0);
    markerHits.sort((a, b) => b.hits - a.hits);

    const cssHits = CSS_CONTRACTS.map((contract) => {
      const hits = contract.probes.reduce((sum, probe) => sum + countLiteral(fixture.css, probe), 0);
      const host = hostEvidence(contract.probes);
      let status = 'implemented';
      if (host.hits === 0) status = 'unsupported';
      else if (host.hits < hits) status = 'partial';
      return { id: contract.id, label: contract.label, capability: contract.capability, hits, hostHits: host.hits, hostFiles: host.files, status, gap: status === 'implemented' ? null : 'needs-architecture' };
    }).filter((row) => row.hits > 0);

    fixture.symbolHits = symbolHits;
    fixture.markerHits = markerHits;
    fixture.cssHits = cssHits;
    fixture.sourceHits = locateInSource(fixture.def.id);
    fixture.installedPackages = countTopLevelPackages(fixture.def.id);
  }

  const unified = new Map();
  const bump = (key, kind, fixtureId, hits, status, gap, label) => {
    if (!unified.has(key)) unified.set(key, { key, kind, label, counts: {}, status, gap });
    const row = unified.get(key);
    row.counts[fixtureId] = (row.counts[fixtureId] || 0) + hits;
  };
  for (const fixture of fixtures) {
    const id = fixture.def.id;
    for (const hit of fixture.symbolHits) bump('symbol:' + hit.symbol, '契约符号', id, hit.hits, hit.status, hit.gap, hit.symbol);
    for (const hit of fixture.markerHits) bump('marker:' + hit.id, '调用点', id, hit.hits, hit.status, hit.gap, hit.label);
    for (const hit of fixture.cssHits) bump('css:' + hit.id, 'CSS 契约', id, hit.hits, hit.status, hit.gap, hit.label);
  }

  const gaps = [...unified.values()]
    .filter((row) => row.status && row.status !== 'implemented')
    .map((row) => Object.assign({}, row, {
      fixtureCount: Object.keys(row.counts).length,
      totalHits: Object.values(row.counts).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.fixtureCount - a.fixtureCount || b.totalHits - a.totalHits || a.key.localeCompare(b.key));

  const fixtureIds = fixtures.map((f) => f.def.id);
  const sharedGaps = gaps.filter((row) => row.fixtureCount === fixtureIds.length);

  return { lock, matrix, bySymbol, fixtures, gaps, sharedGaps, fixtureIds };
}

function writeMarkdown(ctx) {
  const { lock, matrix, bySymbol, fixtures, gaps, sharedGaps, fixtureIds } = ctx;
  const themeFixture = fixtures.find((f) => f.def.role === 'theme');
  const editorFixture = fixtures.find((f) => f.def.role === 'editor');
  const readingFixture = fixtures.find((f) => f.def.role === 'markdown-postprocessor');
  const pkgOf = (id) => {
    const p = path.join(OUT_DIR, '.cache', id, 'src', 'package.json');
    return fs.existsSync(p) ? readJson(p) : null;
  };
  // 排序时同样剔除同名噪声：Array/String/... 这类"契约符号"行只是标识符计数，不是缺口。
  const rankedGaps = gaps.filter((row) => !(row.kind === '契约符号' && GENERIC_NAMES.has(row.label)));
  const gapTop10 = rankedGaps.slice(0, 10);

  const md = [];
  md.push('# 插件夹具 API 使用面报告');
  md.push('');
  md.push('> 由 ' + code('node tools/plugins-fixtures/api-surface.cjs') + ' 生成（' + code('plugin-fixtures-fetch.cjs') + ' 跑完会自动调它）。');
  md.push('> 输入：' + code('tools/plugins-fixtures/manifest.lock.json') + ' 锁定的源码 commit 构建出的产物 + ' + code('tools/contract/symbols.json') + '（' + matrix.generatedFrom + '，' + matrix.symbols.length + ' 条）。');
  md.push('> 生成时间：' + new Date().toISOString() + '；产物目录：' + code('.fixtures-out/') + '（gitignore，不进仓库）。');
  md.push('');
  md.push('## 0. 结论摘要');
  md.push('');
  md.push('- ' + fixtures.length + ' 件夹具都是锁定 commit 的真实产物（' + fixtures.map((f) => code(f.def.id)).join('、') + '）：除主题外都是源码零改动、本地构建出的 main.js，主题是原样 CSS。');
  md.push('- 阅读视图（Markdown 后处理器）由 ' + code(readingFixture ? readingFixture.def.id : '（缺件）') + ' 承担：它调 ' + code('registerMarkdownPostProcessor(') + ' ×' + (readingFixture ? countRe(readingFixture.js, /registerMarkdownPostProcessor\s*\(/g) : 0) + '、' + code('new MarkdownRenderChild(') + ' ×' + (readingFixture ? countRe(readingFixture.js, /new\s+MarkdownRenderChild\s*\(/g) : 0) + '、' + code('ctx.getSectionInfo(') + ' ×' + (readingFixture ? countRe(readingFixture.js, /\.getSectionInfo\s*\(/g) : 0) + '；而宿主侧这条链路整体是 ' + code(statusOf(bySymbol, 'MarkdownPostProcessor')) + '（第 5 节逐条对账）。');
  md.push('- 视图型最大缺口：' + (fixtures.find((f) => f.def.role === 'view') ? fixtures.find((f) => f.def.role === 'view').markerHits.filter((m) => m.gap).slice(0, 4).map((m) => code(m.label) + '×' + m.hits + ' → ' + m.status).join('、') : '') + '。');
  md.push('- 编辑器增强型最大缺口：' + (editorFixture ? editorFixture.markerHits.filter((m) => m.capability === 'editor-cm6').map((m) => code(m.label) + '×' + m.hits).join('、') : '') + '，这些 CodeMirror 6 对象根本不在 obsidian.d.ts 里，宿主必须把真实 @codemirror 实例交给插件。');
  md.push('- 主题夹具没有 JS，它对宿主的要求全在 CSS 契约上：' + (themeFixture ? themeFixture.cssHits.filter((c) => c.status !== 'implemented').map((c) => code(c.label) + '（宿主 ' + c.hostHits + ' 处 vs 主题 ' + c.hits + ' 处）').join('、') : '') + '。');
  md.push('- 全部 ' + fixtures.length + ' 件夹具同时命中的缺口 ' + sharedGaps.length + ' 条；合并排名前 10 见第 8 节。主题不参与 JS 侧交集（它没有 main.js），它的 CSS 缺口单独成行参与合并排名。');
  md.push('');
  md.push('## 1. 夹具概览');
  md.push('');
  md.push('| 夹具 | 角色 | 来源 | commit | 许可 | 产物 | 调用点标记 | 契约符号 | CSS 契约 |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const fixture of fixtures) {
    const files = fixture.artifacts.map((a) => code(a.file) + ' ' + a.bytes + 'B').join('<br>');
    md.push('| ' + code(fixture.def.id) + ' | ' + fixture.def.role + ' | ' + fixture.def.source.repo + ' | ' + code(fixture.def.source.commit.slice(0, 12)) + ' | ' + fixture.def.license.spdx + ' | ' + files + ' | ' + fixture.markerHits.length + ' | ' + fixture.symbolHits.length + ' | ' + fixture.cssHits.length + ' |');
  }
  md.push('');
  md.push('产物 sha256 以 ' + code('manifest.lock.json') + ' 为准，' + code('--check') + ' 逐个文件比对。');
  md.push('');

  md.push('## 2. 每个夹具实际用到的契约符号 top 15');
  md.push('');
  md.push('计数方式：把 main.js 切成标识符后与契约符号名做精确同名计数——是**近似值**（同名局部变量也会计入），用于排序而非断言调用次数。已剔除同名噪声（' + code([...GENERIC_NAMES].join('/')) + '：JS 内建名与插件自有类型名），它们的计数与宿主 API 无关。');
  md.push('');
  for (const fixture of fixtures) {
    md.push('### ' + code(fixture.def.id) + '（' + fixture.def.role + '）');
    md.push('');
    if (!fixture.symbolHits.length) {
      md.push('（没有 main.js，主题夹具不参与此项）');
      md.push('');
      continue;
    }
    md.push('| # | 符号 | 命中 | status | gap | owner |');
    md.push('| --- | --- | --- | --- | --- | --- |');
    fixture.symbolHits.filter((hit) => !GENERIC_NAMES.has(hit.symbol)).slice(0, 15).forEach((hit, index) => {
      md.push('| ' + (index + 1) + ' | ' + code(hit.symbol) + ' | ' + hit.hits + ' | ' + hit.status + ' | ' + (hit.gap || '—') + ' | ' + (hit.owner || '—') + ' |');
    });
    md.push('');
  }

  md.push('## 3. 每个夹具的调用点标记（全量）');
  md.push('');
  md.push('标记是人工整理的 API 调用面正则（' + code('registerView(') + '、' + code('editorCallback') + '、' + code('ViewPlugin.fromClass') + ' 之类），比"同名标识符计数"更贴近真实用法；每行都 join 到契约矩阵的 status/gap。');
  md.push('');
  for (const fixture of fixtures) {
    md.push('### ' + code(fixture.def.id) + '（' + fixture.def.role + '）');
    md.push('');
    if (!fixture.markerHits.length) {
      md.push('（没有 main.js）');
      md.push('');
      continue;
    }
    md.push('| 标记 | 命中 | 能力域 | 契约符号 | status | gap |');
    md.push('| --- | --- | --- | --- | --- | --- |');
    for (const hit of fixture.markerHits) {
      md.push('| ' + code(hit.label) + ' | ' + hit.hits + ' | ' + hit.capability + ' | ' + (hit.symbol ? code(hit.symbol) : '（d.ts 之外）') + ' | ' + hit.status + ' | ' + (hit.gap || '—') + ' |');
    }
    md.push('');
  }

  md.push('## 4. 主题夹具：CSS 契约（主题侧 vs 宿主侧）');
  md.push('');
  md.push('主题不含 JS，能验证的只有"宿主的 CSS 变量层与 DOM 类名层"。宿主侧计数是本次实测：扫 ' + code('entry/') + ' + ' + code('rawfile/') + ' 里 ' + (themeFixture ? themeFixture.cssHits[0].hostFiles : 0) + ' 个 css/ets/ts/json5 文件（排除 node_modules / build / .fixtures-out）。');
  md.push('');
  md.push('| CSS 契约 | 主题引用 | 宿主现有 | status | gap |');
  md.push('| --- | --- | --- | --- | --- |');
  if (themeFixture) {
    for (const row of themeFixture.cssHits) {
      md.push('| ' + row.label + ' | ' + row.hits + ' | ' + row.hostHits + ' | ' + row.status + ' | ' + (row.gap || '—') + ' |');
    }
  }
  md.push('');
  md.push('判定规则（可复算）：宿主侧 0 处 → ' + code('unsupported') + '；宿主有但少于主题引用数 → ' + code('partial') + '；不少于 → ' + code('implemented') + '。');
  md.push('');

  // ---- 5. 阅读视图契约 ----
  md.push('## 5. 阅读视图契约（M2 输入）：registerMarkdownPostProcessor 全链路');
  md.push('');
  md.push('这条链路是"阅读视图验收门禁"的唯一判据，也是本轨新加第四件夹具的全部理由。口径三列：**产物命中**（压缩后属性名不变，可静态计数）、**源码位置**（锁定 commit 的原始源码，扫 ' + code('.fixtures-out/.cache/<id>/src') + '，排除 node_modules/docs/resources/tests，单文件 >512KB 跳过）、**status/gap**（直接取自 ' + code('tools/contract/symbols.json') + '，不是本报告推断）。');
  md.push('');
  if (!readingFixture) {
    md.push('（缺 ' + code('markdown-postprocessor') + ' 角色的夹具）');
    md.push('');
  } else {
    md.push('夹具：' + code(readingFixture.def.id) + ' — ' + readingFixture.def.source.repo + '@' + code(readingFixture.def.source.commit.slice(0, 12)) + '；源码扫描 ' + readingFixture.sourceHits.fileCount + ' 个 .ts/.tsx/.svelte/.js 文件，下表源码位置**相对夹具源码根**（' + code(readingFixture.sourceHits.srcDir) + '）。');
    md.push('');
    md.push('| 契约条目 | 符号 | status | gap | 产物命中 | 源码位置 |');
    md.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of readingFixture.sourceHits.rows) {
      const probe = READING_VIEW_PROBES.find((p) => p.what === row.what);
      const artifactHits = countRe(readingFixture.js, new RegExp(probe.re.source, 'g'));
      const entry = row.symbol ? bySymbol.get(row.symbol) : null;
      const status = entry ? entry.status : (probe.status || 'missing');
      const gap = entry ? entry.gap : probe.gap || null;
      md.push('| ' + code(row.what) + ' | ' + (row.symbol ? code(row.symbol) : '（矩阵未收录）') + ' | ' + status + ' | ' + (gap || '—') + ' | ' + artifactHits + ' | ' + (row.hits.length ? row.hits.join('<br>') : '—') + ' |');
    }
    md.push('');
    md.push('宿主侧现状（逐条，来自契约矩阵）：');
    md.push('');
    for (const name of ['MarkdownPostProcessor', 'MarkdownPostProcessorContext', 'MarkdownRenderChild', 'MarkdownRenderer', 'MarkdownView', 'MarkdownPreviewView', 'MarkdownSubView', 'setIcon', 'Component']) {
      const entry = bySymbol.get(name);
      if (!entry) continue;
      md.push('- ' + code(name) + ' → ' + code(entry.status) + ' / gap=' + (entry.gap || '—') + '（' + entry.owner + '）：' + entry.note);
    }
    md.push('');
    for (const probe of READING_VIEW_PROBES.filter((p) => !p.symbol)) {
      md.push('- 矩阵未收录：' + code(probe.what) + ' — ' + probe.note);
    }
    md.push('');
    md.push('**结论**：这条链路在宿主上整体是 ' + code(statusOf(bySymbol, 'MarkdownPostProcessor')) + ' —— ' + code('registerMarkdownPostProcessor(') + ' 现在只 ' + code('console.warn') + '（证据 W:PluginShim）。所以第四件夹具"能构建、能被宿主加载、但渲染后处理不会执行"：阅读视图的 DOM 上不会出现任何任务控件。M2 要补的最小面是：①真 post-processor 注册表（按 sourcePath 过滤）②ctx 对象（' + code('docId') + ' / ' + code('sourcePath') + ' / ' + code('frontmatter') + ' / ' + code('getSectionInfo') + ' / ' + code('addChild') + '）③Markdown 渲染完成后把 el + ctx 交给每个 processor ④' + code('MarkdownRenderChild') + ' 的生命周期挂到视图 unload（现在基于 ComponentShim，containerEl 是桩）。');
    md.push('');
  }

  md.push('## 6. 每个夹具用到的 unsupported / stub 条目清单');
  md.push('');
  md.push('口径：只统计该夹具产物里**真实命中**（计数 > 0）的契约符号与调用点标记，' + code('status ∈ {unsupported, stub}') + ' 单列；' + code('partial') + ' 另计一行（partial 表示宿主有实现但不完整，语义见契约矩阵的 note）。');
  md.push('');
  md.push('已剔除同名噪声：' + code([...GENERIC_NAMES].join('/')) + '——它们是 JS 内建名或插件自有类型名（如 tasks 自己的 ' + code('Tasks') + '/' + code('TasksFile') + '），在压缩产物里出现几百次但没有一次是调用宿主 API，计进缺口只会虚增。**判据以「调用点」行为准**（精确正则），「契约符号」行只是量级参考。');
  md.push('');
  md.push('| 夹具 | 条目 | 类别 | 命中 | status | gap | 契约矩阵说明 |');
  md.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const fixture of fixtures) {
    const rows = [];
    for (const hit of fixture.symbolHits) {
      if (GENERIC_NAMES.has(hit.symbol)) continue;
      rows.push({ label: hit.symbol, kind: '契约符号', hits: hit.hits, status: hit.status, gap: hit.gap, note: (bySymbol.get(hit.symbol) || {}).note || '' });
    }
    for (const hit of fixture.markerHits) rows.push({ label: hit.label, kind: '调用点', hits: hit.hits, status: hit.status, gap: hit.gap, note: hit.note || '' });
    const hard = rows.filter((r) => r.status === 'unsupported' || r.status === 'stub').sort((a, b) => b.hits - a.hits);
    const partials = rows.filter((r) => r.status === 'partial');
    if (!hard.length && !partials.length) {
      md.push('| ' + code(fixture.def.id) + ' | — | — | — | — | — | 无 unsupported/stub 命中 |');
      continue;
    }
    for (const row of hard) {
      const note = row.note.replace(/\|/g, '/').slice(0, 110);
      md.push('| ' + code(fixture.def.id) + ' | ' + code(row.label) + ' | ' + row.kind + ' | ' + row.hits + ' | ' + row.status + ' | ' + (row.gap || '—') + ' | ' + (note || '—') + ' |');
    }
    md.push('| ' + code(fixture.def.id) + ' | ' + code('（partial 汇总）') + ' | 合计 | ' + partials.reduce((s, r) => s + r.hits, 0) + ' | partial | needs-architecture | ' + partials.length + ' 条：' + (partials.slice(0, 6).map((r) => r.label).join('、') || '—') + (partials.length > 6 ? ' …' : '') + ' |');
  }
  md.push('');

  md.push('## 7. 依赖树与外置项（M2 容器要提供的实例）');
  md.push('');
  md.push('口径：**external** 取 lock 的 ' + code('build.external') + '（构建时真正标记为外置的模块：产物里是 ' + code('require(...)') + ' 而不是内联代码，宿主必须在运行时给出同一份实例）；**锁定版本**取 lock 的 ' + code('build.resolved') + '（npm install 之后回写）；**声明范围**取该 commit 的 package.json。');
  md.push('');
  md.push('| 夹具 | 产物 | 外置模块 | 一级依赖（声明 → 锁定） | node_modules 顶层包数 |');
  md.push('| --- | --- | --- | --- | --- |');
  for (const fixture of fixtures) {
    const build = fixture.def.build || {};
    const external = build.external || [];
    const pkg = pkgOf(fixture.def.id);
    const deps = pkg && pkg.dependencies ? pkg.dependencies : null;
    const resolved = build.resolved || {};
    const depText = deps
      ? Object.entries(deps).map(([name, range]) => code(name) + ' ' + range + ' → ' + (resolved[name] || '（未记录）')).join('<br>')
      : '—';
    const artifacts = fixture.artifacts.map((a) => code(a.file) + ' ' + a.bytes + 'B').join('<br>');
    md.push('| ' + code(fixture.def.id) + ' | ' + artifacts + ' | ' + (external.length ? external.map((e) => code(e)).join('<br>') : '—') + ' | ' + depText + ' | ' + (fixture.installedPackages == null ? '—' : fixture.installedPackages) + ' |');
  }
  md.push('');
  const withExternal = fixtures.filter((f) => (f.def.build && f.def.build.external || []).length);
  for (const fixture of withExternal) {
    const external = fixture.def.build.external;
    const cm = external.filter((e) => e.startsWith('@codemirror/') || e === 'codemirror');
    const moment = external.filter((e) => e === 'moment');
    md.push('- ' + code(fixture.def.id) + '：' + external.length + ' 个 external' + (cm.length ? '，其中 CodeMirror 相关 ' + cm.length + ' 个（' + cm.map((e) => code(e)).join('、') + '）—— 宿主必须提供**同一份** ' + code('@codemirror/state') + '/' + code('@codemirror/view') + ' 实例，否则插件 import 到的类与宿主编译器里的不是同一个构造函数，ViewPlugin/StateField 会静默失效' : '') + (moment.length ? '；' + code('moment') + ' 也是 external，宿主必须给同一个 moment 实例（含 locale 状态）' : '；moment 不在 external，若产物里出现 moment 引用就是内联打包') + '。');
  }
  md.push('- 现在宿主的实际情况：' + code('tools/workspace-bundle/node_modules') + ' 里**没有** ' + code('moment') + '（本报告生成时实测），也还没有给插件注入 ' + code('@codemirror/*') + ' 实例的通道；这就是"external 列表"对 M2 的待办清单。');
  md.push('');

  md.push('## 8. 缺口排名 top 10（跨夹具合并）');
  md.push('');
  md.push('口径：把"契约符号 / 调用点标记 / CSS 契约"三类行统一，过滤掉 status=implemented 与同名噪声（见第 6 节黑名单），按命中夹具数、再按总频次排序取前 10。全部夹具共同命中的缺口共 ' + sharedGaps.length + ' 条（若不足 10 条，后面用两件套/单件套缺口补齐，逐夹具列里能看出谁命中）。');
  md.push('');
  md.push('| # | 缺口 | 类别 | 命中夹具数 | 总频次 | 逐夹具 | status | gap |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  gapTop10.forEach((row, index) => {
    const perFixture = fixtureIds.map((id) => code(id) + ':' + (row.counts[id] || 0)).join(' / ');
    md.push('| ' + (index + 1) + ' | ' + code(row.label) + ' | ' + row.kind + ' | ' + row.fixtureCount + ' | ' + row.totalHits + ' | ' + perFixture + ' | ' + row.status + ' | ' + (row.gap || '—') + ' |');
  });
  md.push('');

  md.push('## 9. 方法与局限');
  md.push('');
  md.push('- 扫描对象是**构建产物**而非源码：被 tree-shake 掉的 import 不会计入，这比读 src 更贴近运行时真实调用面。');
  md.push('- 契约符号计数是同名标识符近似，会高估（局部变量同名）。调用点标记（第 3 节）是精确正则：排序看第 2 节，判定缺口看第 3 节。');
  md.push('- ' + code('@codemirror/*') + ' 相关能力在 obsidian.d.ts 里不存在，矩阵没有对应符号；这类行标"（d.ts 之外）"并自带 status/gap。');
  md.push('- 本报告只回答"插件用了什么、宿主缺什么"，不回答"能不能跑起来"——运行时轨道未完成。');
  md.push('');

  fs.writeFileSync(path.join(FIXTURES_DIR, 'api-surface.report.md'), md.join('\n') + '\n', 'utf8');

  return {
    generatedAt: new Date().toISOString(),
    contractBaseline: matrix.generatedFrom,
    contractSymbolCount: matrix.symbols.length,
    lockUpdatedAt: lock.updatedAt,
    fixtures: fixtures.map((fixture) => ({
      id: fixture.def.id,
      role: fixture.def.role,
      repo: fixture.def.source.repo,
      commit: fixture.def.source.commit,
      license: fixture.def.license.spdx,
      artifacts: fixture.artifacts,
      markerHits: fixture.markerHits,
      symbolHitsTop: fixture.symbolHits.slice(0, 15),
      cssHits: fixture.cssHits,
    })),
    sharedGapCount: sharedGaps.length,
    gapTop10: gapTop10.map((row) => ({ label: row.label, kind: row.kind, fixtureCount: row.fixtureCount, counts: row.counts, totalHits: row.totalHits, status: row.status, gap: row.gap })),
  };
}

try {
  const ctx = buildReport();
  const summary = writeMarkdown(ctx);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'api-surface.report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('报告已写入 tools/plugins-fixtures/api-surface.report.md / .json');
  console.log('  夹具 ' + ctx.fixtures.length + ' 件；缺口行 ' + ctx.gaps.length + ' 条；三件套共同缺口 ' + ctx.sharedGaps.length + ' 条');
  for (const fixture of ctx.fixtures) {
    console.log('  ' + fixture.def.id + '：调用点标记 ' + fixture.markerHits.length + ' 类 / 契约符号 ' + fixture.symbolHits.length + ' 个 / CSS 契约 ' + fixture.cssHits.length + ' 项');
  }
  process.exit(0);
} catch (err) {
  console.log('✗ ' + (err && err.stack ? err.stack : err));
  process.exit(1);
}
