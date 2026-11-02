#!/usr/bin/env node
// 契约矩阵生成器：官方 obsidian@1.14.4 的 obsidian.d.ts → tools/contract/symbols.json
//
// 符号集合 = d.ts 顶层导出声明 + declare global 里的原型/DOM 补丁（按名字去重）。
// 定级 = OVERRIDES（人工定级，逐符号）+ RULES（家族规则，按顺序首命中）+ 兜底。
// 输出确定性：符号按 < 字典序排序，字段顺序固定，2 空格缩进，重跑无 diff。
//
// 用法：node tools/contract/generate.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_FILE = path.join(__dirname, 'symbols.json');
const SOURCE = 'obsidian@1.14.4';
const STATUSES = ['implemented', 'partial', 'stub', 'unsupported'];
const OWNERS = ['运行时轨', '宿主轨', '分发轨', '未排期'];
const GAPS_ENUM = ['low-risk', 'needs-architecture', 'out-of-scope'];
const GAP_FALLBACK = 'needs-architecture'; // 判不出来时的兜底，生成时会打印出来要求逐条确认
const UNMAPPED_NOTE = '未命中映射规则：新符号，需人工定级后加入 tools/contract/generate.cjs';

// ---------------------------------------------------------------- d.ts 定位

function dtsCandidates() {
  const list = [];
  if (process.env.LEXINOTE_OBSIDIAN_DTS) list.push(process.env.LEXINOTE_OBSIDIAN_DTS);
  list.push(path.join(__dirname, '.obsidian', 'obsidian.d.ts'));
  list.push(path.resolve('/tmp/obs/package/obsidian.d.ts'));
  list.push('C:/tmp/obs/package/obsidian.d.ts');
  return [...new Set(list)];
}

function locateDts() {
  for (const candidate of dtsCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function requireDts() {
  const found = locateDts();
  if (found) return found;
  console.error('✗ 找不到 obsidian.d.ts（官方契约源，不入库）。');
  console.error('  已尝试：');
  for (const c of dtsCandidates()) console.error('    - ' + c);
  console.error('  拉取方式：');
  console.error('    npm pack obsidian@' + SOURCE.split('@')[1] + '  # 在 /tmp/obs 下解包得到 package/obsidian.d.ts');
  console.error('  或用 LEXINOTE_OBSIDIAN_DTS=<path> 指定。');
  process.exit(1);
}

// ---------------------------------------------------------------- d.ts 解析

const DECL = /^export (?:declare )?(abstract )?(class|interface|function|const|let|var|enum|type)\s+([A-Za-z_$][\w$]*)/;
const GLOBAL_DECL = /^ {4}(interface|type|var|const|class|function)\s+([A-Za-z_$][\w$]*)/;

function blockEnd(lines, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

function parseSymbols(text) {
  const lines = text.split('\n');
  const found = new Map();
  for (const line of lines) {
    const m = line.match(DECL);
    if (m && !found.has(m[3])) found.set(m[3], m[1] ? 'abstract class' : m[2]);
  }
  const globalStart = lines.findIndex((l) => l.startsWith('declare global'));
  if (globalStart >= 0) {
    const globalEnd = blockEnd(lines, globalStart);
    for (let i = globalStart + 1; i < globalEnd; i += 1) {
      const m = lines[i].match(GLOBAL_DECL);
      if (m && !found.has(m[2])) found.set(m[2], m[1]);
    }
  }
  return [...found.entries()]
    .map(([symbol, kind]) => ({ symbol, kind }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

// ---------------------------------------------------------------- 实现面索引
// 宿主处理器表（registerHandler）与 Web 侧实现索引（shim 里的函数/对象/命名空间键）。
// 门禁用它校验 status=implemented 的证据能否落到真实实现上（spec 第 7 节）。

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(p, acc);
    } else {
      acc.push(p);
    }
  }
  return acc;
}

const SHIM_FILES = ['lexinote_plugin_shim.js', 'lexinote_plugin_view_shim.js'];

function collectImplIndex() {
  const rawfile = path.join(ROOT, 'entry/src/main/resources/rawfile');
  const etsRoot = path.join(ROOT, 'entry/src/main/ets');

  const handlers = new Set();
  for (const file of walk(etsRoot).filter((p) => /\.(ets|ts)$/.test(p))) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    const re = /registerHandler\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) handlers.add(m[1]);
  }

  const channels = new Set();
  const web = new Set();
  for (const name of SHIM_FILES) {
    const file = path.join(rawfile, name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    let m;
    const chan = /hostCall\(\s*'([^']+)'/g;
    while ((m = chan.exec(src))) channels.add(m[1]);
    const fn = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fn.exec(src))) web.add(m[1]);
    const declared = /var\s+([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = declared.exec(src))) web.add(m[1]);
    // 原型/window 上的成员赋值（Node.prototype.createEl = ...、window.fish = ...）
    const member = /\.([A-Za-z_$][\w$]*)\s*=\s*function/g;
    while ((m = member.exec(src))) web.add(m[1]);
    // 对象字面量的方法键（导出面 obsidianNamespace / viewNamespace 里的 xxx: function）
    const key = /([A-Za-z_$][\w$]*)\s*:\s*function\b/g;
    while ((m = key.exec(src))) web.add(m[1]);
    // 导出面里的非函数键：apiVersion: API_VERSION, / Keymap: { ... }, —— 直接映射到对象/变量
    const value = /^[ \t]+([A-Za-z_$][\w$]*)\s*:\s*(?:[A-Za-z_$][\w$]*\s*,|\{)/gm;
    while ((m = value.exec(src))) web.add(m[1]);
  }

  return { handlers, channels, web };
}

// ---------------------------------------------------------------- 定级表
// 证据标记：H:<宿主处理器名> / W:<Web 侧实现名>，门禁会校验其真实存在。
// status 语义见 tools/contract/README.md。

// 策略符号：note 必须是「时效前缀 + 覆盖插件清单 + members/members(excludes)」结构，门禁逐条校验（spec 第 12 节）。
// 表在这里显式声明，禁止用「逗号多就算清单型」之类的启发式判定；加符号就加到这张表并补清单。
const NOTE_POLICY = ['moment', 'App', 'Workspace', 'Vault', 'MetadataCache', 'MarkdownView'];

const OVERRIDES = {
  // ==== 插件运行时核心（运行时轨）====
  Plugin: { status: 'implemented', owner: '运行时轨', note: '生命周期、命令、Ribbon、设置页、视图注册、代码块处理器、数据读写均已接通。证据 H:commands.add H:data.load W:PluginShim' },
  Component: { status: 'implemented', owner: '运行时轨', note: 'load/unload/register/registerEvent/registerDomEvent/registerInterval/addChild/removeChild 均已实现。证据 W:ComponentShim' },
  Events: { status: 'implemented', owner: '运行时轨', note: 'on/off/trigger 本地实现，宿主事件经 events.on/events.off 订阅并按 topic 派发。证据 W:LocalEmitter H:events.on H:events.off' },
  EventRef: { status: 'implemented', owner: '运行时轨', note: '引用对象带 off()，可直接交给 Component.registerEvent。证据 W:makeHostRef' },
  Command: { status: 'implemented', owner: '运行时轨', note: 'id/name/icon/checkCallback/callback/editorCallback 原样存入 commandTable 并上报宿主。证据 H:commands.add W:PluginShim' },
  PluginManifest: { status: 'stub', owner: '运行时轨', note: '仅空构造占位；manifest 由宿主透传，插件侧无运行时校验。证据 W:PluginManifest' },
  App: { status: 'partial', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: lexi-sample-plugin（本仓样例）、compat-probe（本仓探针）。vault/metadataCache/workspace/commands/fileManager/isDarkMode 已挂载；loadLocalStorage/saveLocalStorage 已通（app.localStorage.get/set，宿主落 filesDir/local-storage.json，读回自动 JSON.parse）；仍缺 setting/plugins/internalPlugins，keymap 与 scope 为 null 占位。证据 H:app.localStorage.get H:app.localStorage.set W:loadLocalStorage\nmembers: app.localStorage.get, app.localStorage.set, app.isDarkMode, loadLocalStorage, saveLocalStorage\nmembers(excludes): app.setting, app.plugins, app.internalPlugins, app.keymap, app.scope' },
  FileManager: { status: 'partial', owner: '运行时轨', note: 'generateMarkdownLink/renameFile 可用；processFrontMatter 直接 reject。证据 W:app' },
  Notice: { status: 'partial', owner: '运行时轨', note: '构造即经 ui.notice 送达宿主；setMessage 不刷新已显示的提示、hide 为空实现。证据 H:ui.notice W:Notice' },
  Modal: { status: 'stub', owner: '运行时轨', note: 'open() 只发 ui.placeholder（该通道当前无宿主处理器），titleEl/contentEl 恒 null，无 DOM 容器。证据 W:Modal' },
  Menu: { status: 'stub', owner: '运行时轨', note: 'addItem 只收集 item，showAtMouseEvent 仅打印告警，不渲染菜单。证据 W:Menu' },
  MenuItem: { status: 'stub', owner: '运行时轨', note: 'addItem 回调拿到的 item 是内联空壳，setTitle/setIcon/setChecked 只返回 this。证据 W:Menu' },
  SuggestModal: { status: 'stub', owner: '运行时轨', note: '继承空 Modal，无输入框、无候选列表、无键盘导航。证据 W:SuggestModalShim' },
  FuzzySuggestModal: { status: 'stub', owner: '运行时轨', note: 'getSuggestions 恒空数组，模糊匹配与渲染均未实现。证据 W:FuzzySuggestModal' },
  AbstractInputSuggest: { status: 'stub', owner: '运行时轨', note: '别名到空 SuggestModal，未与输入框绑定。证据 W:SuggestModalShim' },
  Scope: { status: 'stub', owner: '运行时轨', note: '空构造，按键作用域与 register 未实现。证据 W:Scope' },
  Keymap: { status: 'stub', owner: '运行时轨', note: '只导出 isModifier 且恒 false，键位注册表不存在。证据 W:Keymap' },
  Setting: { status: 'stub', owner: '运行时轨', note: 'setName/setDesc/addText 等全部空壳（回调收到空桩组件）；设置 UI 实际由 settings.register 声明式渲染。证据 W:Setting H:settings.register' },
  PluginSettingTab: { status: 'partial', owner: '运行时轨', note: 'display/hide 空实现，但 getSettingDefinitions 经 settings.register 下发宿主渲染；宿主仅支持 heading/toggle/text/textarea/dropdown/slider 六类。证据 H:settings.register W:PluginSettingTab' },
  SettingTab: { status: 'stub', owner: '运行时轨', note: '空构造占位，未接设置页。证据 W:SettingTab' },
  Vault: { status: 'partial', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。read/modify/create/append/delete/rename/files/getByPath 已通；getFileByPath 也已通：shim 在 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:872（`getFileByPath`） 基于宿主回传的文件索引缓存同步返回 TFile，宿主处理器用 entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:1289（`manager.vault.getFileByPath`） 解析（obsidian-tasks 有 3 处依赖：fixture:markdown-postprocessor-tasks/src/Obsidian/File.ts:202（`getFileByPath`）、fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:83（`getFileByPath`）、fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:76（`getFileByPath`））；adapter 已实现（exists/read/write/append/process/list/stat/remove/rename，目录存在性由 vault.files 路径前缀推导，stat 无 size/mtime 时如实返回 0）；仍缺 getName/configDir，createBinary/readBinary 直接 reject，getAbstractFileByPath 已改成同步（entry/src/main/resources/rawfile/lexinote_plugin_shim.js:871（`getAbstractFileByPath`），内部走 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:845（`knownAbstractFile`），目录按「有笔记落在该前缀下」合成 TFolder，传空串得 vault 根）。证据 H:vault.read H:vault.files W:adapter\nmembers: vault.read, vault.files, vault.create, vault.modify, vault.append, vault.delete, vault.rename, vault.getByPath, adapter, getFileByPath, getFolderByPath, getAbstractFileByPath, knownAbstractFile, getMarkdownFiles\nmembers(excludes): getName, configDir, createBinary, readBinary, copy' },
  TFile: { status: 'implemented', owner: '运行时轨', note: 'path/name/basename/extension/stat/noteId 由宿主回传填充并缓存为单例。证据 W:TFile H:vault.getByPath' },
  TFolder: { status: 'partial', owner: '运行时轨', note: '字段齐全但 children 恒空，目录树未回填。证据 W:TFolder' },
  TAbstractFile: { status: 'partial', owner: '运行时轨', note: '基类 LexiFileData 提供 path/name/vault，缺官方抽象语义（isRoot 等）。证据 W:LexiFileData' },
  FileStats: { status: 'implemented', owner: '运行时轨', note: 'ctime/mtime/size 由 vault.* 响应回传并写入 file.stat。证据 H:vault.files' },
  Stat: { status: 'implemented', owner: '运行时轨', note: '与 FileStats 同源，宿主回传 ctime/mtime/size。证据 H:vault.files' },
  MetadataCache: { status: 'partial', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。getFileCache/getCache/getFirstLinkpathDest/事件已通；仍缺 getBacklinksForFile/listLinks/unresolvedLinks（宿主只建正向链接索引，无反向链接表），产出无 blocks/listItems/embeds/footnotes、无 heading 层级 patch 信息；缓存只能按需单文件拉取，无全量预热。证据 H:metadata.get H:metadata.firstLink W:getCache\nmembers: metadata.get, metadata.firstLink, metadata.resolved, metadata.graph, getCache, getFileCache, getFirstLinkpathDest\nmembers(excludes): getBacklinksForFile, listLinks, unresolvedLinks, resolvedLinks' },
  CachedMetadata: { status: 'partial', owner: '运行时轨', note: '产出 headings/links/tags/sections/frontmatter/frontmatterPosition；blocks/listItems/embeds/footnotes/references 未产出。证据 H:metadata.get' },
  Workspace: { status: 'partial', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。openView/closeView/事件、getActiveFile/getActiveViewOfType/getLeavesOfType、iterateAllLeaves/iterateRootLeaves/getMostRecentLeaf、openLinkText（宿主经 metadata.getFirstLinkpathDest 解析后触发 file-open）均已通；onLayoutReady 也已实现，宿主在 entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:1101（`workspace.onLayoutReady`） 注册处理器、旧宿主路径直接放行——夹具报告把它算成「矩阵未收录」是符号级 vs 成员级的口径差（它没有独立顶层符号），不是缺实现；obsidian-tasks 拿它当首屏闸门（3 处）：fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:32（`onLayoutReady`）、fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:45（`onLayoutReady`）、fixture:markdown-postprocessor-tasks/src/Obsidian/Cache.ts:101（`onLayoutReady`）；仍缺 splitLeaf/createLeafBySplit/getLayout 布局树，revealLeaf 只 resolve 不切页，getLeaf/getRightLeaf 返回新建子叶而非宿主真实 pane。证据 H:workspace.openLinkText H:workspace.onLayoutReady W:iterateAllLeaves W:getMostRecentLeaf\nmembers: workspace.openLinkText, workspace.openView, workspace.closeView, workspace.onLayoutReady, workspace.layoutReady, workspace.loadLayout, workspace.saveLayout, openLinkText, iterateAllLeaves, iterateRootLeaves, getMostRecentLeaf, getLeavesOfType, getActiveFile, getActiveViewOfType, revealLeaf\nmembers(excludes): splitLeaf, createLeafBySplit, getLayout, getLeaf, getRightLeaf, activeLeaf' },
  WorkspaceLeaf: { status: 'stub', owner: '运行时轨', note: '空构造；插件视图拿到的 leaf 是 makePluginLeaf 的假对象。证据 W:WorkspaceLeaf' },
  ItemView: { status: 'partial', owner: '运行时轨', note: '视图槽内以 ItemViewShim 提供容器与 onOpen/onClose；缺 addAction/getViewType/getDisplayText 完整语义。证据 W:ItemViewShim' },
  View: { status: 'partial', owner: '运行时轨', note: '视图槽映射到 ItemViewShim，内核上下文映射到 ComponentShim，无 containerEl/leaf 语义。证据 W:ItemViewShim' },
  MarkdownView: { status: 'stub', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: 无（本仓无插件依赖该视图；宿主编辑器页承担正文编辑）。空构造（FileViewShim 子类，editor 与 previewMode 恒 null），无编辑/预览双模：打开即空白容器，无 Markdown 渲染管线、无预览滚动同步、无编辑态。证据 W:MarkdownView W:MarkdownViewShim\nmembers: MarkdownView, MarkdownViewShim\nmembers(excludes): editor, previewMode, onMarkdownContextMenu, onInternalDrop' },
  MarkdownRenderer: { status: 'stub', owner: '运行时轨', note: 'render/renderMarkdown 直接 reject（entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2125（`MarkdownRenderer`）），嵌入与代码块渲染未实现。obsidian-tasks 有 3 处真实调用点：fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:136（`MarkdownRenderer.render`）、fixture:markdown-postprocessor-tasks/src/Renderer/TaskLineRenderer.ts:85（`MarkdownRenderer.render`）、fixture:markdown-postprocessor-tasks/src/ui/QuickSearchTasksModal.ts:134（`MarkdownRenderer.render`）——查询结果块与每条任务行都走它，stub 等于 tasks 的列表渲染整体抛错，不是可拖项（夹具报告把 TaskLineRenderer 第 94 行也算一个调用点，但那行是 `renderMarkdown()` 的文档注释，不是调用）。证据 W:MarkdownRenderer' },
  MarkdownRenderChild: { status: 'partial', owner: '运行时轨', note: '基于 ComponentShim 的容器子节点，containerEl 为桩对象。证据 W:MarkdownRenderChildStub' },
  Editor: { status: 'partial', owner: '运行时轨', note: '读写/选区/替换/transaction 已通；undo/redo/exec/processLines/wordAt/getScrollInfo 为桩，无 CM6 扩展面。证据 W:EditorProxy H:editor.replace H:editor.selection' },
  EditorPosition: { status: 'implemented', owner: '运行时轨', note: 'pos↔offset 双向换算已实现。证据 W:EditorProxy' },
  EditorRange: { status: 'implemented', owner: '运行时轨', note: 'from/to 参与 replaceRange/getRange。证据 W:EditorProxy' },
  EditorSelection: { status: 'implemented', owner: '运行时轨', note: 'anchor/head 映射到宿主选区并经 editor.selection 回写。证据 W:EditorProxy H:editor.selection' },
  EditorSelectionOrCaret: { status: 'implemented', owner: '运行时轨', note: '按 anchor/head 归一化，缺 head 时折叠为单点。证据 W:EditorProxy' },
  EditorRangeOrCaret: { status: 'implemented', owner: '运行时轨', note: 'to 缺省时折叠为 from。证据 W:EditorProxy' },
  EditorTransaction: { status: 'implemented', owner: '运行时轨', note: 'changes+selections 合成一帧经 editor.applyChanges 提交。证据 W:EditorProxy H:editor.applyChanges' },
  EditorChange: { status: 'partial', owner: '运行时轨', note: '只透传 from/to/text，annotated ranges 丢弃。证据 W:EditorProxy' },
  EditorScrollInfo: { status: 'stub', owner: '运行时轨', note: 'getScrollInfo 恒返回 0，无滚动同步。证据 W:EditorProxy' },
  Pos: { status: 'implemented', owner: '运行时轨', note: 'line/ch 由 offsetToPos 产出，与 Editor 共用。证据 W:offsetToPos' },
  Loc: { status: 'implemented', owner: '运行时轨', note: 'line/col/offset 由 lineOffsets 计算。证据 W:lineOffsets' },

  // ==== 网络与工具（运行时轨）====
  requestUrl: { status: 'implemented', owner: '运行时轨', note: '身份与能力双门禁：宿主按插件令牌反查身份（无令牌/令牌归属不符一律 fail-closed 且不触网），并要求清单声明 capability.net 且 host 在列；放行后 GET/POST + headers/body 透传，2xx 与非 2xx 都原样回包，超时报 net_timeout。arrayBuffer 仍恒 reject（占位 promise）。证据 W:requestUrl H:net.requestUrl' },
  RequestUrlParam: { status: 'implemented', owner: '运行时轨', note: 'url/method/headers/body 透传宿主。证据 H:net.requestUrl' },
  RequestUrlResponse: { status: 'partial', owner: '运行时轨', note: 'status/headers/text/json 可用；arrayBuffer 缺失。证据 W:requestUrl H:net.requestUrl' },
  RequestUrlResponsePromise: { status: 'partial', owner: '运行时轨', note: 'text/json 属性可用，arrayBuffer 恒 reject。证据 W:requestUrl' },
  prepareFuzzySearch: { status: 'partial', owner: '运行时轨', note: '仅做小写包含匹配，score 为命中下标，与官方打分/分词不同。证据 W:prepareFuzzySearch' },
  prepareSimpleSearch: { status: 'partial', owner: '运行时轨', note: '直接复用 fuzzy 实现，非官方 SimpleSearch 语义。证据 W:prepareSimpleSearch' },
  FuzzyMatch: { status: 'partial', owner: '运行时轨', note: 'score/matches 字段存在，但与官方打分口径不同。证据 W:prepareFuzzySearch' },
  debounce: { status: 'implemented', owner: '运行时轨', note: '含 cancel，run 为空实现。证据 W:debounce' },
  Debouncer: { status: 'partial', owner: '运行时轨', note: 'cancel 可用，run 未实现。证据 W:debounce' },
  sleep: { status: 'implemented', owner: '运行时轨', note: 'setTimeout Promise。证据 W:sleep' },
  moment: { status: 'partial', owner: '运行时轨', note: '[截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）。本项目 moment 是 MiniMoment 子集，不是完整 moment：实例侧已通 format/add/subtract/startOf/endOf/diff/unix/valueOf/toDate/toISOString/clone/isValid/isBefore/isAfter/isSame/isSameOrBefore/isSameOrAfter/calendar/locale/localeData/utc/local 与七个取值设值字段、day/weekday/isoWeekday/week/dayOfYear/daysInMonth；静态侧已通 moment(input)/isMoment/utc/unix/now/locale/localeData/updateLocale/defineLocale/locales/months/monthsShort/weekdays/weekdaysShort/weekdaysMin。这些是按 calendar 的真实调用逐条补齐的，不是按 moment 文档铺开：format 只认 YYYY/YY/MMMM/MMM/MM/M/DD/D/Do/dddd/ddd/dd/HH/H/hh/mm/ss/SSS/A/a，diff 只能按毫秒/秒/分/时/天，calendar 恒返回 YYYY-MM-DD 而非今天/昨天文案，locale 与 localeData 恒报 zh-cn。换一个用到未覆盖 API 的插件会在使用处直接抛 TypeError（xxx is not a function），装载期不会提示。宿主必须提供全局 window.moment：obsidian-tasks 产物里 43 处 moment( 调用点（夹具 API 面报告口径；我直接数其 main.js 得 51 处 window.moment 字面量、TS 源 49 处），既不内联 moment 也不 require("moment")，tools/workspace-bundle/node_modules 里也没有 moment——现在靠 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:1502（`window.moment`） 把 MiniMoment 挂成全局兜住，所以那 43 处调用实际落在 MiniMoment 子集上，MiniMoment 没覆盖的写法同样会在使用处 TypeError。证据 W:MiniMoment W:moment\nmembers: format, add, subtract, startOf, endOf, diff, unix, calendar, localeData, isoWeekday, daysInMonth, updateLocale, defineLocale, locales, monthsShort, weekdaysMin, clone, toDate, toObject, isValid\nmembers(excludes): tz, duration, fromNow, toNow, toJSON, utcOffset, isDST, parseZone' },
  normalizePath: { status: 'implemented', owner: '运行时轨', note: '统一分隔符并去掉重复/首尾斜杠。证据 W:normalizePath' },
  Platform: { status: 'implemented', owner: '运行时轨', note: '移动端常量表（isMobile/isPhone/isAndroidApp=false 等需与真机核对）。证据 W:Platform' },
  apiVersion: { status: 'partial', owner: '运行时轨', note: '值为 1.0.0，而契约基线是 1.14.4，requireApiVersion 会误判低版本并让插件走降级分支。证据 W:apiVersion' },
  parseYaml: { status: 'implemented', owner: '运行时轨', note: '视图侧自实现 YAML 子集解析（标量/行内数组/嵌套键）。证据 W:parseYaml' },
  getLanguage: { status: 'partial', owner: '运行时轨', note: '视图侧恒返回 zh，未读系统语言。证据 W:getLanguage' },
  IconName: { status: 'implemented', owner: '运行时轨', note: '字符串别名，addIcon 接受任意值并原样上报。证据 H:ui.addIcon' },
  addIcon: { status: 'implemented', owner: '运行时轨', note: '转发宿主图标注册。证据 H:ui.addIcon' },
  setIcon: { status: 'stub', owner: '运行时轨', note: '空函数，元素上不渲染图标。证据 W:setIcon' },
  getIcon: { status: 'stub', owner: '运行时轨', note: '恒返回 null。证据 W:getIcon' },
  getIconIds: { status: 'stub', owner: '运行时轨', note: '恒返回空数组。证据 W:getIconIds' },
  removeIcon: { status: 'stub', owner: '运行时轨', note: '空函数。证据 W:removeIcon' },
  SecretStorage: { status: 'unsupported', owner: '未排期', note: '无凭据存储；manifest capabilities 也未定义 secret 能力。证据 W:PluginShim' },
  Tasks: { status: 'unsupported', owner: '未排期', note: 'Obsidian 内部任务队列，未导出；插件无并发调度入口。' },
  DataAdapter: { status: 'unsupported', owner: '未排期', note: '类本身是 stub（stubClass，new 出来没有任何方法，也不可构造出可用实例）；但 vault.adapter 实例是真实现：exists/read/write/append/process/list/stat/remove/rename（目录存在性由 vault.files 路径前缀推导，readBinary/copy 仍 reject，stat 无 size/mtime 且如实返回 0）。真实插件（obsidian-text-format 等）依赖的是 vault.adapter，请直接用它而不是构造 DataAdapter。证据 W:adapter', gap: 'out-of-scope' },
  FileSystemAdapter: { status: 'unsupported', owner: '未排期', note: '类本身是 stub（无 getBasePath/getFullPath/读写实现，不可构造）；移动端没有本地文件系统直访，一切文件访问走 vault.adapter 实例（能力见 DataAdapter）。证据 W:adapter', gap: 'out-of-scope' },

  // ==== Web 侧 DOM 补丁（宿主轨）====
  createEl: { status: 'implemented', owner: '宿主轨', note: '视图页以 installDomHelpers 安装 Node.createEl 并挂 window.createEl。证据 W:createEl' },
  createDiv: { status: 'implemented', owner: '宿主轨', note: '继承 createEl 的 div 快捷方式。证据 W:createDiv' },
  createSpan: { status: 'implemented', owner: '宿主轨', note: '继承 createEl 的 span 快捷方式。证据 W:createSpan' },
  createFragment: { status: 'implemented', owner: '宿主轨', note: 'DocumentFragment + 回调。证据 W:createFragment' },
  createSvg: { status: 'unsupported', owner: '宿主轨', note: 'Node.createSvg 未安装（installDomHelpers 只装了 HTML 侧），SVG 图标渲染会抛错。' },
  fish: { status: 'implemented', owner: '宿主轨', note: 'querySelector 包装。证据 W:fish' },
  fishAll: { status: 'implemented', owner: '宿主轨', note: 'querySelectorAll 转数组。证据 W:fishAll' },
  DomElementInfo: { status: 'implemented', owner: '宿主轨', note: 'cls/text/title/placeholder/href/value/attr 均由 applyInfo 落地。证据 W:applyInfo' },
  SvgElementInfo: { status: 'partial', owner: '宿主轨', note: '属性映射已有，但 createSvg 未安装，SVG 元素仍建不出来。证据 W:applyInfo' },
  EventListenerInfo: { status: 'implemented', owner: '宿主轨', note: '委托监听记录在 __delegated 上。证据 W:delegatedOn' },
  Node: { status: 'partial', owner: '宿主轨', note: '已装 createEl/createDiv/createSpan/appendText/detach/empty/setChildrenInPlace；缺 createSvg/insertAfter/indexOf/instanceOf。证据 W:installDomHelpers' },
  Element: { status: 'partial', owner: '宿主轨', note: '已装 getText/setText/addClass/addClasses/removeClass/removeClasses/toggleClass/hasClass/setAttr/setAttrs/getAttr；缺 matchParent/getCssPropertyValue/isActiveElement/find/findAll/findAllSelf。find/findAll 不是可选助手：obsidian-tasks 的后处理器第一步就是 fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:50（`element.findAll`），不装就在阅读视图渲染时直接 TypeError（installDomHelpers 定义在 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:131（`installDomHelpers`））。证据 W:installDomHelpers' },
  HTMLElement: { status: 'partial', owner: '宿主轨', note: '已装 show/hide/toggle/setCssStyles/setCssProps/onClickEvent/on/off/trigger；缺 toggleVisibility/isShown/onNodeInserted/onWindowMigrated。证据 W:installDomHelpers' },
  SVGElement: { status: 'partial', owner: '宿主轨', note: '只继承 Element 侧补丁，无 SvgElementInfo 的 setCssStyles/setCssProps。证据 W:installDomHelpers' },
  DocumentFragment: { status: 'partial', owner: '宿主轨', note: 'Node 侧补丁可用，find/findAll 未安装。证据 W:installDomHelpers' },
  Document: { status: 'partial', owner: '宿主轨', note: '未装 Document.on/off 事件委托，_EVENTS 不存在。证据 W:installDomHelpers' },
  Window: { status: 'partial', owner: '宿主轨', note: '已装 activeDocument/activeWindow/createEl/createDiv/createSpan/createFragment/fish/fishAll；缺 window.sleep/window.nextFrame。证据 W:installDomHelpers' },
};


// 逐符号 gap 覆盖：只写与家族规则（RULES.gap）不同的条目；implemented 一律 null，不在此表。
const GAPS = {
  App: 'needs-architecture',
  FileManager: 'low-risk',
  Notice: 'low-risk',
  PluginSettingTab: 'needs-architecture',
  Vault: 'needs-architecture',
  TFolder: 'low-risk',
  TAbstractFile: 'low-risk',
  MetadataCache: 'needs-architecture',
  CachedMetadata: 'needs-architecture',
  Workspace: 'needs-architecture',
  ItemView: 'needs-architecture',
  View: 'needs-architecture',
  MarkdownRenderChild: 'needs-architecture',
  Editor: 'needs-architecture',
  EditorChange: 'needs-architecture',
  EditorScrollInfo: 'needs-architecture',
  RequestUrlResponse: 'low-risk',
  RequestUrlResponsePromise: 'low-risk',
  prepareFuzzySearch: 'low-risk',
  prepareSimpleSearch: 'low-risk',
  FuzzyMatch: 'low-risk',
  Debouncer: 'low-risk',
  moment: 'needs-architecture',
  apiVersion: 'low-risk',
  getLanguage: 'low-risk',
  SvgElementInfo: 'low-risk',
  Node: 'low-risk',
  Element: 'low-risk',
  HTMLElement: 'low-risk',
  SVGElement: 'low-risk',
  DocumentFragment: 'low-risk',
  Document: 'low-risk',
  Window: 'low-risk',
  PluginManifest: 'low-risk',
  Modal: 'needs-architecture',
  Menu: 'needs-architecture',
  MenuItem: 'needs-architecture',
  SuggestModal: 'needs-architecture',
  FuzzySuggestModal: 'needs-architecture',
  AbstractInputSuggest: 'needs-architecture',
  Scope: 'needs-architecture',
  Keymap: 'needs-architecture',
  Setting: 'needs-architecture',
  SettingTab: 'needs-architecture',
  WorkspaceLeaf: 'needs-architecture',
  MarkdownView: 'needs-architecture',
  MarkdownRenderer: 'needs-architecture',
  setIcon: 'low-risk',
  getIcon: 'low-risk',
  getIconIds: 'low-risk',
  removeIcon: 'low-risk',
  SecretStorage: 'needs-architecture',
  Tasks: 'out-of-scope',
  createSvg: 'low-risk',
};

// 家族规则：按顺序首命中生效。
const RULES = [
  { re: /^Bases/, status: 'unsupported', owner: '未排期', note: 'spec 第 9 节明确本轮不做 Bases 插件 API。', gap: 'out-of-scope' },
  { re: /^(Value|NotNullValue|PrimitiveValue|NullValue|NumberValue|StringValue|BooleanValue|DateValue|DurationValue|FileValue|LinkValue|ListValue|ObjectValue|RegExpValue|RelativeDateValue|HtmlValue|HTMLValue|IconValue|ImageValue|UrlValue|FormulaContext|QueryController|RenderContext)$/, status: 'unsupported', owner: '未排期', note: 'Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。', gap: 'out-of-scope' },
  { re: /^Setting.*(Control|Definition)/, status: 'partial', owner: '运行时轨', note: '定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register', gap: 'needs-architecture' },
  { re: /^Setting(Group|Page|GroupItem)/, status: 'unsupported', owner: '宿主轨', note: '设置 2.0 的分组/分页容器未实现，宿主设置页仍是单页列表。', gap: 'needs-architecture' },
  { re: /^Workspace(Container|Floating|Item|Parent|Root|Ribbon|Sidedock|Split|Tabs|Window|MobileDrawer|WindowInitData)$/, status: 'unsupported', owner: '未排期', note: '多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。', gap: 'needs-architecture' },
  { re: /^(AbstractTextComponent|ButtonComponent|ColorComponent|DropdownComponent|ExtraButtonComponent|MomentFormatComponent|ProgressBarComponent|SearchComponent|SecretComponent|SliderComponent|TextAreaComponent|TextComponent|ToggleComponent|ValueComponent|DisplayValueComponent|BaseComponent|ConfirmationButton|ConfirmationModal|HoverPopover|MenuSeparator|MenuPositionDef|SettingGroup|SettingPage|PopoverSuggest|FileView|TextFileView|EditableFileView|MarkdownSubView|MarkdownEditView|MarkdownPreviewView|MarkdownPreviewRenderer)$/, status: 'unsupported', owner: '宿主轨', note: 'Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。', gap: 'needs-architecture' },
  { re: /^(editorEditorField|editorInfoField|editorLivePreviewField|editorViewField|livePreviewState|LivePreviewStateType|MarkdownViewModeType|EditorCommandName|EditorSuggest|EditorSuggestContext|EditorSuggestTriggerInfo)$/, status: 'unsupported', owner: '宿主轨', note: '需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。', gap: 'needs-architecture' },
  { re: /^(CliData|CliFlag|CliFlags|CliHandler)$/, status: 'unsupported', owner: '未排期', note: '桌面 CLI 参数模型，移动端无 CLI 入口。', gap: 'out-of-scope' },
  { re: /^(CapacitorAdapter|DataWriteOptions|ListedFiles)$/, status: 'unsupported', owner: '未排期', note: '无文件系统直访通道；spec 第 5 节要求一切文件操作走 vault 通道。', gap: 'out-of-scope' },
  { re: /^(ObjectConstructor|ArrayConstructor|Array|Math|String|StringConstructor|NumberConstructor)$/, status: 'unsupported', owner: '宿主轨', note: 'Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。', gap: 'low-risk' },
  { re: /^(isBoolean|ready|nextFrame|ajax|ajaxPromise|AjaxOptions)$/, status: 'unsupported', owner: '宿主轨', note: '全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。', gap: 'low-risk' },
  { re: /^(StringConstructor|NumberConstructor)$/, status: 'unsupported', owner: '宿主轨', note: '类型判定补丁（String.isString/Number.isNumber）未安装。', gap: 'low-risk' },
  { re: /^(renderMatches|renderResults|sortSearchResults|SearchResult|SearchResultContainer)$/, status: 'unsupported', owner: '未排期', note: '搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。', gap: 'needs-architecture' },
  { re: /^(parseFrontMatterAliases|parseFrontMatterEntry|parseFrontMatterStringArray|parseFrontMatterTags|getFrontMatterInfo|parseLinktext|stripHeading|stripHeadingForLink|getLinkpath|getAllTags|resolveSubpath|iterateCacheRefs|iterateRefs|parsePropertyId|stringifyYaml)$/, status: 'unsupported', owner: '运行时轨', note: '纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。', gap: 'low-risk' },
  { re: /^(renderMath|finishRenderMath|loadMathJax|loadMermaid|loadPdfJs|loadPrism|sanitizeHTMLToDom|htmlToMarkdown)$/, status: 'unsupported', owner: '未排期', note: '数学/图表/PDF/语法高亮渲染管线未接入。', gap: 'needs-architecture' },
  { re: /^(ObsidianProtocolData|ObsidianProtocolHandler|Instruction|HoverParent|HoverLinkSource|HistoryHandler)$/, status: 'unsupported', owner: '未排期', note: '协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。', gap: 'needs-architecture' },
  { re: /^(setTooltip|displayTooltip|TooltipOptions|TooltipPlacement)$/, status: 'unsupported', owner: '宿主轨', note: 'tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。', gap: 'needs-architecture' },
  { re: /^(KeymapContext|KeymapEventHandler|KeymapEventListener|KeymapInfo|Hotkey|Modifier|UserEvent)$/, status: 'unsupported', owner: '运行时轨', note: '键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。', gap: 'needs-architecture' },
  { re: /^(Point|RGB|HSL|HexString|UIEvent|Touch)$/, status: 'unsupported', owner: '未排期', note: '几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。', gap: 'low-risk' },
  { re: /^(HeadingCache|SectionCache|TagCache|LinkCache|Reference|FrontMatterCache|FrontmatterValue)$/, status: 'partial', owner: '运行时轨', note: '宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get', gap: 'needs-architecture' },
  { re: /^(CacheItem|ReferenceCache|SearchMatches|SearchMatchPart)$/, status: 'partial', owner: '运行时轨', note: '部分字段由 metadata.get 回填，但 references 聚合结构不完整、搜索命中位置无来源。证据 H:metadata.get', gap: 'needs-architecture' },
  { re: /^(BlockCache|EmbedCache|FootnoteCache|FootnoteRefCache|ListItemCache|FrontmatterLinkCache|ReferenceLinkCache)$/, status: 'unsupported', owner: '运行时轨', note: '宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get', gap: 'needs-architecture' },
  { re: /^(SubpathResult|HeadingSubpathResult|BlockSubpathResult|FootnoteSubpathResult)$/, status: 'unsupported', owner: '运行时轨', note: '链接子路径（#标题 / #^块 / ^脚注）解析未实现，metadata.firstLink 只给目标文件。证据 H:metadata.firstLink', gap: 'needs-architecture' },
  { re: /^(MarkdownPostProcessor|MarkdownPostProcessorContext|MarkdownPreviewEvents|MarkdownSectionInformation|MarkdownFileInfo|ISuggestOwner)$/, status: 'unsupported', owner: '宿主轨', note: '渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim', gap: 'needs-architecture' },
  { re: /^(Constructor|Side|PaneType|SplitDirection|ViewState|ViewStateResult|OpenViewState|ViewCreator|PopoverState|TExternalFile)$/, status: 'unsupported', owner: '未排期', note: '布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。', gap: 'needs-architecture' },
  { re: /^(arrayBufferToBase64|arrayBufferToHex|base64ToArrayBuffer|getBlobArrayBuffer|hexToArrayBuffer)$/, status: 'unsupported', owner: '运行时轨', note: '二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。', gap: 'low-risk' },
  { re: /^requireApiVersion$/, status: 'unsupported', owner: '运行时轨', note: '未导出，插件调用即 TypeError；且 apiVersion 恒 1.0.0，即便补上也会把 1.14.x 插件误判为高版本要求。证据 W:apiVersion', gap: 'low-risk' },
  { re: /^request$/, status: 'unsupported', owner: '运行时轨', note: '官方已废弃的 requestUrl 前身，未导出；迁移到 requestUrl 即可。证据 W:requestUrl', gap: 'low-risk' },
  { re: /^FrontMatterInfo$/, status: 'unsupported', owner: '运行时轨', note: 'frontmatter 边界信息（from/to/正文字符串）未导出，宿主只回传 parsed frontmatter 对象。证据 H:metadata.get', gap: 'low-risk' },
  { re: /^TagValue$/, status: 'partial', owner: '运行时轨', note: 'frontmatter 值原样透传，未见对多值标签归一化的处理。证据 H:metadata.get', gap: 'low-risk' },
];

function grade(symbol) {
  const override = OVERRIDES[symbol];
  if (override) return override;
  for (const rule of RULES) {
    if (rule.re.test(symbol)) return { status: rule.status, owner: rule.owner, note: rule.note, gap: rule.gap };
  }
  return { status: 'unsupported', owner: '未排期', note: UNMAPPED_NOTE, gap: GAP_FALLBACK };
}

function build() {
  const dtsPath = requireDts();
  const parsed = parseSymbols(fs.readFileSync(dtsPath, 'utf8'));
  const fallback = [];
  const symbols = parsed.map(({ symbol, kind }) => {
    const g = grade(symbol);
    let gap = null;
    if (g.status !== 'implemented') {
      gap = GAPS[symbol] || g.gap || GAP_FALLBACK;
      if (!GAPS[symbol] && !g.gap) fallback.push(symbol);
    }
    return { symbol, kind, status: g.status, owner: g.owner, note: g.note, gap };
  });
  const unmapped = symbols.filter((s) => s.note === UNMAPPED_NOTE).map((s) => s.symbol);
  const stale = Object.keys(GAPS).filter((k) => !symbols.some((s) => s.symbol === k));
  return { matrix: { generatedFrom: SOURCE, symbols }, dtsPath, unmapped, fallback, stale };
}

function serialize(matrix) {
  return JSON.stringify(matrix, null, 2) + '\n';
}

function gapCounts(symbols) {
  const out = {};
  for (const gap of GAPS_ENUM) out[gap] = 0;
  out.null = 0;
  for (const s of symbols) out[s.gap === null ? 'null' : s.gap] = (out[s.gap === null ? 'null' : s.gap] || 0) + 1;
  return out;
}

function counts(symbols) {
  const out = {};
  for (const status of STATUSES) out[status] = 0;
  for (const s of symbols) out[s.status] = (out[s.status] || 0) + 1;
  return out;
}

function main() {
  const { matrix, dtsPath, unmapped, fallback, stale } = build();
  fs.writeFileSync(OUT_FILE, serialize(matrix), 'utf8');
  const c = counts(matrix.symbols);
  const gc = gapCounts(matrix.symbols);
  console.log('契约矩阵已生成: tools/contract/symbols.json');
  console.log('  来源 d.ts: ' + dtsPath);
  console.log('  符号总数: ' + matrix.symbols.length);
  console.log('  status: implemented ' + c.implemented + ' / partial ' + c.partial + ' / stub ' + c.stub + ' / unsupported ' + c.unsupported);
  console.log('  gap:    low-risk ' + gc['low-risk'] + ' / needs-architecture ' + gc['needs-architecture'] + ' / out-of-scope ' + gc['out-of-scope'] + ' / null ' + gc.null);
  if (fallback.length) {
    console.log('  ⚠ ' + fallback.length + ' 条非 implemented 缺 gap，已按 ' + GAP_FALLBACK + ' 兜底，请逐条确认:');
    console.log('    ' + fallback.join(', '));
  }
  if (stale.length) {
    console.log('  ⚠ GAPS 表里 ' + stale.length + ' 个符号已不在 d.ts 中，请清理:');
    console.log('    ' + stale.join(', '));
  }
  if (unmapped.length) {
    console.log('  ⚠ 未命中映射规则 ' + unmapped.length + ' 个（已按 unsupported 兜底，请补定级）:');
    console.log('    ' + unmapped.join(', '));
  }
}

module.exports = {
  ROOT, OUT_FILE, SOURCE, STATUSES, OWNERS, GAPS_ENUM, GAP_FALLBACK, UNMAPPED_NOTE, GAPS,
  dtsCandidates, locateDts, requireDts, parseSymbols,
  collectImplIndex, build, serialize, counts, gapCounts,
};

if (require.main === module) main();
