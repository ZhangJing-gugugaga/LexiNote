# 插件夹具 API 使用面报告

> 由 `node tools/plugins-fixtures/api-surface.cjs` 生成（`plugin-fixtures-fetch.cjs` 跑完会自动调它）。
> 输入：`tools/plugins-fixtures/manifest.lock.json` 锁定的源码 commit 构建出的产物 + `tools/contract/symbols.json`（obsidian@1.14.4，334 条）。
> 生成时间：2026-11-01T23:02:08.158Z；产物目录：`.fixtures-out/`（gitignore，不进仓库）。

## 0. 结论摘要

- 4 件夹具都是锁定 commit 的真实产物（`view-calendar`、`editor-outliner`、`markdown-postprocessor-tasks`、`theme-minimal`）：除主题外都是源码零改动、本地构建出的 main.js，主题是原样 CSS。
- 阅读视图（Markdown 后处理器）由 `markdown-postprocessor-tasks` 承担：它调 `registerMarkdownPostProcessor(` ×1、`new MarkdownRenderChild(` ×0、`ctx.getSectionInfo(` ×1；而宿主侧这条链路整体是 `unsupported/needs-architecture`（第 5 节逐条对账）。
- 视图型最大缺口：`this.app`×24 → partial、`app.workspace.*`×15 → partial、`moment(`×12 → partial、`window.moment(`×9 → partial。
- 编辑器增强型最大缺口：`registerEditorExtension(`×11、`Decoration.* / EditorView.decorations|theme|domEventHandlers`×9、`.dispatch(`×5、`EditorView（构造/静态方法）`×3、`StateField.define`×2、`ViewPlugin.fromClass/define`×1、`EditorState.create/transaction/readOnly`×1，这些 CodeMirror 6 对象根本不在 obsidian.d.ts 里，宿主必须把真实 @codemirror 实例交给插件。
- 主题夹具没有 JS，它对宿主的要求全在 CSS 契约上：`主题背景/文字变量`（宿主 87 处 vs 主题 353 处）、`字体变量`（宿主 17 处 vs 主题 39 处）、`圆角/间距变量`（宿主 20 处 vs 主题 37 处）、`明暗主题类（body.theme-dark/light）`（宿主 19 处 vs 主题 351 处）、`编辑器 DOM 类（.cm-*）`（宿主 31 处 vs 主题 96 处）、`Markdown 视图 DOM 类`（宿主 5 处 vs 主题 528 处）、`工作区 DOM 类`（宿主 16 处 vs 主题 661 处）、`视图外壳 DOM 类`（宿主 3 处 vs 主题 226 处）。
- 全部 4 件夹具同时命中的缺口 0 条；合并排名前 10 见第 8 节。主题不参与 JS 侧交集（它没有 main.js），它的 CSS 缺口单独成行参与合并排名。

## 1. 夹具概览

| 夹具 | 角色 | 来源 | commit | 许可 | 产物 | 调用点标记 | 契约符号 | CSS 契约 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `view-calendar` | view | liamcain/obsidian-calendar-plugin | `ef3f2696da11` | MIT | `main.js` 142387B<br>`manifest.json` 306B<br>`styles.css` 194B | 17 | 20 | 1 |
| `editor-outliner` | editor | vslinko/obsidian-outliner | `b51918d4eaa7` | MIT | `main.js` 108865B<br>`manifest.json` 286B<br>`styles.css` 2169B | 18 | 12 | 3 |
| `markdown-postprocessor-tasks` | markdown-postprocessor | obsidian-tasks-group/obsidian-tasks | `83f54fbba0c6` | MIT | `main.js` 1053970B<br>`manifest.json` 518B<br>`styles.css` 28060B | 27 | 46 | 3 |
| `theme-minimal` | theme | kepano/obsidian-minimal | `93321bdc23fc` | MIT | `manifest.json` 200B<br>`styles.css` 505243B | 0 | 0 | 8 |

产物 sha256 以 `manifest.lock.json` 为准，`--check` 逐个文件比对。

## 2. 每个夹具实际用到的契约符号 top 15

计数方式：把 main.js 切成标识符后与契约符号名做精确同名计数——是**近似值**（同名局部变量也会计入），用于排序而非断言调用次数。已剔除同名噪声（`Array/String/Object/Math/Number/Promise/Date/Map/Set/RegExp/Error/JSON/Tasks/TasksFile/Instruction/Modifier/displayTooltip/renderResults/request/ready`：JS 内建名与插件自有类型名），它们的计数与宿主 API 无关。

### `view-calendar`（view）

| # | 符号 | 命中 | status | gap | owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `moment` | 30 | partial | needs-architecture | 运行时轨 |
| 2 | `createEl` | 10 | implemented | — | 宿主轨 |
| 3 | `Setting` | 8 | stub | needs-architecture | 运行时轨 |
| 4 | `normalizePath` | 4 | implemented | — | 运行时轨 |
| 5 | `Notice` | 3 | partial | low-risk | 运行时轨 |
| 6 | `ConfirmationModal` | 2 | unsupported | needs-architecture | 宿主轨 |
| 7 | `createDiv` | 2 | implemented | — | 宿主轨 |
| 8 | `FileView` | 2 | unsupported | needs-architecture | 宿主轨 |
| 9 | `TFile` | 2 | implemented | — | 运行时轨 |
| 10 | `Vault` | 2 | partial | needs-architecture | 运行时轨 |
| 11 | `getIcon` | 1 | stub | low-risk | 运行时轨 |
| 12 | `ItemView` | 1 | partial | needs-architecture | 运行时轨 |
| 13 | `Modal` | 1 | stub | needs-architecture | 运行时轨 |
| 14 | `parseFrontMatterTags` | 1 | unsupported | low-risk | 运行时轨 |
| 15 | `Plugin` | 1 | implemented | — | 运行时轨 |

### `editor-outliner`（editor）

| # | 符号 | 命中 | status | gap | owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `Setting` | 10 | stub | needs-architecture | 运行时轨 |
| 2 | `Notice` | 3 | partial | low-risk | 运行时轨 |
| 3 | `createEl` | 2 | implemented | — | 宿主轨 |
| 4 | `Platform` | 2 | implemented | — | 运行时轨 |
| 5 | `Command` | 1 | implemented | — | 运行时轨 |
| 6 | `editorInfoField` | 1 | unsupported | needs-architecture | 宿主轨 |
| 7 | `MarkdownView` | 1 | stub | needs-architecture | 运行时轨 |
| 8 | `Modal` | 1 | stub | needs-architecture | 运行时轨 |
| 9 | `Plugin` | 1 | implemented | — | 运行时轨 |
| 10 | `PluginSettingTab` | 1 | partial | needs-architecture | 运行时轨 |

### `markdown-postprocessor-tasks`（markdown-postprocessor）

| # | 符号 | 命中 | status | gap | owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `moment` | 58 | partial | needs-architecture | 运行时轨 |
| 2 | `createEl` | 33 | implemented | — | 宿主轨 |
| 3 | `createDiv` | 26 | implemented | — | 宿主轨 |
| 4 | `Notice` | 17 | partial | low-risk | 运行时轨 |
| 5 | `Plugin` | 11 | implemented | — | 运行时轨 |
| 6 | `setIcon` | 10 | stub | low-risk | 运行时轨 |
| 7 | `createSpan` | 9 | implemented | — | 宿主轨 |
| 8 | `ButtonComponent` | 8 | unsupported | needs-architecture | 宿主轨 |
| 9 | `setTooltip` | 8 | unsupported | needs-architecture | 宿主轨 |
| 10 | `HTMLElement` | 7 | partial | low-risk | 宿主轨 |
| 11 | `Modal` | 7 | stub | needs-architecture | 运行时轨 |
| 12 | `MarkdownView` | 6 | stub | needs-architecture | 运行时轨 |
| 13 | `Setting` | 6 | stub | needs-architecture | 运行时轨 |
| 14 | `debounce` | 4 | implemented | — | 运行时轨 |
| 15 | `Element` | 4 | partial | low-risk | 宿主轨 |

### `theme-minimal`（theme）

（没有 main.js，主题夹具不参与此项）

## 3. 每个夹具的调用点标记（全量）

标记是人工整理的 API 调用面正则（`registerView(`、`editorCallback`、`ViewPlugin.fromClass` 之类），比"同名标识符计数"更贴近真实用法；每行都 join 到契约矩阵的 status/gap。

### `view-calendar`（view）

| 标记 | 命中 | 能力域 | 契约符号 | status | gap |
| --- | --- | --- | --- | --- | --- |
| `this.app` | 24 | app-object | `App` | partial | needs-architecture |
| `app.workspace.*` | 15 | workspace | `Workspace` | partial | needs-architecture |
| `createEl/createDiv/createSpan` | 12 | dom | `DomElementInfo` | implemented | — |
| `moment(` | 12 | time | `moment` | partial | needs-architecture |
| `window.moment(` | 9 | time | `moment` | partial | needs-architecture |
| `app.vault.*` | 7 | vault-read | `Vault` | partial | needs-architecture |
| `vault.modify/create/delete/adapter` | 6 | vault-write | `Vault` | partial | needs-architecture |
| `loadData(/saveData(` | 3 | persistence | `Plugin` | implemented | — |
| `addCommand(` | 3 | commands | `Plugin` | implemented | — |
| `TFile / TFolder` | 2 | files | `TFile` | implemented | — |
| `app.fileManager.*` | 1 | file-manager | `FileManager` | partial | low-risk |
| `registerView(` | 1 | view-registration | `ItemView` | partial | needs-architecture |
| `ItemView（继承/引用）` | 1 | view-registration | `ItemView` | partial | needs-architecture |
| `setViewState(` | 1 | workspace-leaf | `WorkspaceLeaf` | stub | needs-architecture |
| `addSettingTab(` | 1 | settings-ui | `PluginSettingTab` | partial | needs-architecture |
| `setIcon(` | 1 | icons | `setIcon` | stub | low-risk |
| `ctx.frontmatter` | 1 | markdown-postprocessor | `MarkdownPostProcessorContext` | unsupported | needs-architecture |

### `editor-outliner`（editor）

| 标记 | 命中 | 能力域 | 契约符号 | status | gap |
| --- | --- | --- | --- | --- | --- |
| `Editor.getValue/setValue/replaceRange/listSelections` | 20 | editor-api | `Editor` | partial | needs-architecture |
| `registerEditorExtension(` | 11 | editor-cm6 | `Plugin` | implemented | — |
| `Decoration.* / EditorView.decorations|theme|domEventHandlers` | 9 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `addCommand(` | 7 | commands | `Plugin` | implemented | — |
| `this.app` | 7 | app-object | `App` | partial | needs-architecture |
| `editorCallback/editorCheckCallback/editorPaste` | 6 | editor-callback | `Plugin` | implemented | — |
| `.dispatch(` | 5 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `EditorView（构造/静态方法）` | 3 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `app.vault.*` | 2 | vault-read | `Vault` | partial | needs-architecture |
| `StateField.define` | 2 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `loadData(/saveData(` | 2 | persistence | `Plugin` | implemented | — |
| `createEl/createDiv/createSpan` | 2 | dom | `DomElementInfo` | implemented | — |
| `Platform.*` | 2 | platform | `Platform` | implemented | — |
| `app.workspace.*` | 1 | workspace | `Workspace` | partial | needs-architecture |
| `getActiveViewOfType(` | 1 | workspace | `Workspace` | partial | needs-architecture |
| `ViewPlugin.fromClass/define` | 1 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `EditorState.create/transaction/readOnly` | 1 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `addSettingTab(` | 1 | settings-ui | `PluginSettingTab` | partial | needs-architecture |

### `markdown-postprocessor-tasks`（markdown-postprocessor）

| 标记 | 命中 | 能力域 | 契约符号 | status | gap |
| --- | --- | --- | --- | --- | --- |
| `createEl/createDiv/createSpan` | 77 | dom | `DomElementInfo` | implemented | — |
| `moment(` | 43 | time | `moment` | partial | needs-architecture |
| `this.app` | 42 | app-object | `App` | partial | needs-architecture |
| `window.moment(` | 42 | time | `moment` | partial | needs-architecture |
| `app.vault.*` | 11 | vault-read | `Vault` | partial | needs-architecture |
| `app.workspace.*` | 9 | workspace | `Workspace` | partial | needs-architecture |
| `app.metadataCache.*` | 9 | metadata | `MetadataCache` | partial | needs-architecture |
| `setIcon(` | 6 | icons | `setIcon` | stub | low-risk |
| `ctx.frontmatter` | 6 | markdown-postprocessor | `MarkdownPostProcessorContext` | unsupported | needs-architecture |
| `addCommand(` | 5 | commands | `Plugin` | implemented | — |
| `getLeaf(` | 4 | workspace-leaf | `WorkspaceLeaf` | stub | needs-architecture |
| `TFile / TFolder` | 4 | files | `TFile` | implemented | — |
| `MarkdownRenderer.render*` | 3 | markdown-render | `MarkdownRenderer` | stub | needs-architecture |
| `editorCallback/editorCheckCallback/editorPaste` | 3 | editor-callback | `Plugin` | implemented | — |
| `Editor.getValue/setValue/replaceRange/listSelections` | 3 | editor-api | `Editor` | partial | needs-architecture |
| `vault.modify/create/delete/adapter` | 2 | vault-write | `Vault` | partial | needs-architecture |
| `loadData(/saveData(` | 2 | persistence | `Plugin` | implemented | — |
| `ctx.sourcePath` | 2 | markdown-postprocessor | `MarkdownPostProcessorContext` | unsupported | needs-architecture |
| `ctx.addChild(` | 2 | markdown-postprocessor | `MarkdownPostProcessorContext` | unsupported | needs-architecture |
| `MarkdownRenderChild（new / extends）` | 2 | markdown-render | `MarkdownRenderChild` | partial | needs-architecture |
| `app.fileManager.*` | 1 | file-manager | `FileManager` | partial | low-risk |
| `registerMarkdownPostProcessor(` | 1 | markdown-render | `MarkdownPostProcessor` | unsupported | needs-architecture |
| `registerEditorExtension(` | 1 | editor-cm6 | `Plugin` | implemented | — |
| `ViewPlugin.fromClass/define` | 1 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `.dispatch(` | 1 | editor-cm6 | （d.ts 之外） | unsupported | needs-architecture |
| `addSettingTab(` | 1 | settings-ui | `PluginSettingTab` | partial | needs-architecture |
| `ctx.getSectionInfo(` | 1 | markdown-postprocessor | `MarkdownPostProcessorContext` | unsupported | needs-architecture |

### `theme-minimal`（theme）

（没有 main.js）

## 4. 主题夹具：CSS 契约（主题侧 vs 宿主侧）

主题不含 JS，能验证的只有"宿主的 CSS 变量层与 DOM 类名层"。宿主侧计数是本次实测：扫 `entry/` + `rawfile/` 里 151 个 css/ets/ts/json5 文件（排除 node_modules / build / .fixtures-out）。

| CSS 契约 | 主题引用 | 宿主现有 | status | gap |
| --- | --- | --- | --- | --- |
| 主题背景/文字变量 | 353 | 87 | partial | needs-architecture |
| 字体变量 | 39 | 17 | partial | needs-architecture |
| 圆角/间距变量 | 37 | 20 | partial | needs-architecture |
| 明暗主题类（body.theme-dark/light） | 351 | 19 | partial | needs-architecture |
| 编辑器 DOM 类（.cm-*） | 96 | 31 | partial | needs-architecture |
| Markdown 视图 DOM 类 | 528 | 5 | partial | needs-architecture |
| 工作区 DOM 类 | 661 | 16 | partial | needs-architecture |
| 视图外壳 DOM 类 | 226 | 3 | partial | needs-architecture |

判定规则（可复算）：宿主侧 0 处 → `unsupported`；宿主有但少于主题引用数 → `partial`；不少于 → `implemented`。

## 5. 阅读视图契约（M2 输入）：registerMarkdownPostProcessor 全链路

这条链路是"阅读视图验收门禁"的唯一判据，也是本轨新加第四件夹具的全部理由。口径三列：**产物命中**（压缩后属性名不变，可静态计数）、**源码位置**（锁定 commit 的原始源码，扫 `.fixtures-out/.cache/<id>/src`，排除 node_modules/docs/resources/tests，单文件 >512KB 跳过）、**status/gap**（直接取自 `tools/contract/symbols.json`，不是本报告推断）。

夹具：`markdown-postprocessor-tasks` — obsidian-tasks-group/obsidian-tasks@`83f54fbba0c6`；源码扫描 217 个 .ts/.tsx/.svelte/.js 文件，下表源码位置**相对夹具源码根**（``）。

| 契约条目 | 符号 | status | gap | 产物命中 | 源码位置 |
| --- | --- | --- | --- | --- | --- |
| `registerMarkdownPostProcessor(` | `MarkdownPostProcessor` | unsupported | needs-architecture | 1 | src/Obsidian/InlineRenderer.ts:31 |
| `ctx.getSectionInfo(` | `MarkdownPostProcessorContext` | unsupported | needs-architecture | 1 | src/Obsidian/InlineRenderer.ts:86 |
| `ctx.sourcePath` | `MarkdownPostProcessorContext` | unsupported | needs-architecture | 2 | src/Obsidian/InlineRenderer.ts:82<br>src/Renderer/QueryRenderer.ts:60 |
| `.frontmatter（ctx 或缓存对象）` | `MarkdownPostProcessorContext` | unsupported | needs-architecture | 6 | src/Scripting/TasksFile.ts:23<br>src/Scripting/TasksFile.ts:36<br>src/Scripting/TasksFile.ts:100<br>src/Scripting/TasksFile.ts:142 |
| `ctx.addChild(` | `MarkdownPostProcessorContext` | unsupported | needs-architecture | 2 | src/Obsidian/InlineRenderer.ts:48<br>src/Renderer/QueryRenderer.ts:71 |
| `MarkdownRenderChild` | `MarkdownRenderChild` | partial | needs-architecture | 2 | src/Obsidian/InlineRenderer.ts:2<br>src/Obsidian/InlineRenderer.ts:47<br>src/Renderer/QueryRenderer.ts:6<br>src/Renderer/QueryRenderer.ts:86 |
| `MarkdownRenderer.render*` | `MarkdownRenderer` | stub | needs-architecture | 3 | src/Renderer/QueryRenderer.ts:136<br>src/Renderer/TaskLineRenderer.ts:85<br>src/Renderer/TaskLineRenderer.ts:94<br>src/ui/QuickSearchTasksModal.ts:134 |
| `setIcon(` | `setIcon` | stub | low-risk | 6 | src/Config/PresetsSettingsUI.ts:103<br>src/Config/SettingsTab.ts:157<br>src/Config/SettingsTab.ts:352<br>src/Config/SettingsTab.ts:546 |
| `MarkdownView` | `MarkdownView` | stub | needs-architecture | 6 | src/Commands/CreateEditorCallback.ts:1<br>src/Commands/CreateEditorCallback.ts:65<br>src/Commands/CreateEditorCallback.ts:67<br>src/Commands/CreateEditorCallback.ts:76 |
| `ctx.docId` | `MarkdownPostProcessorContext` | unsupported | needs-architecture | 0 | — |
| `element.findAll(` | （矩阵未收录） | missing | needs-architecture | 1 | src/Obsidian/InlineRenderer.ts:50 |
| `vault.getFileByPath(` | （矩阵未收录） | missing | needs-architecture | 3 | src/Obsidian/File.ts:202<br>src/Obsidian/InlineRenderer.ts:83<br>src/Renderer/QueryRenderer.ts:76 |
| `workspace.onLayoutReady(` | （矩阵未收录） | missing | needs-architecture | 3 | src/Obsidian/Cache.ts:101<br>src/Obsidian/InlineRenderer.ts:32<br>src/Renderer/QueryRenderer.ts:45 |

宿主侧现状（逐条，来自契约矩阵）：

- `MarkdownPostProcessor` → `unsupported` / gap=needs-architecture（宿主轨）：渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim
- `MarkdownPostProcessorContext` → `unsupported` / gap=needs-architecture（宿主轨）：渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim
- `MarkdownRenderChild` → `partial` / gap=needs-architecture（运行时轨）：基于 ComponentShim 的容器子节点，containerEl 为桩对象。证据 W:MarkdownRenderChildStub
- `MarkdownRenderer` → `stub` / gap=needs-architecture（运行时轨）：render/renderMarkdown 直接 reject，嵌入与代码块渲染未实现。证据 W:MarkdownRenderer
- `MarkdownView` → `stub` / gap=needs-architecture（运行时轨）：[截至 2026-11-01 @ 48f164a] 覆盖插件: 无（本仓无插件依赖该视图；宿主编辑器页承担正文编辑）。空构造（FileViewShim 子类，editor 与 previewMode 恒 null），无编辑/预览双模：打开即空白容器，无 Markdown 渲染管线、无预览滚动同步、无编辑态。证据 W:MarkdownView W:MarkdownViewShim
members: MarkdownView, MarkdownViewShim
members(excludes): editor, previewMode, onMarkdownContextMenu, onInternalDrop
- `MarkdownPreviewView` → `unsupported` / gap=needs-architecture（宿主轨）：Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。
- `MarkdownSubView` → `unsupported` / gap=needs-architecture（宿主轨）：Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。
- `setIcon` → `stub` / gap=low-risk（运行时轨）：空函数，元素上不渲染图标。证据 W:setIcon
- `Component` → `implemented` / gap=—（运行时轨）：load/unload/register/registerEvent/registerDomEvent/registerInterval/addChild/removeChild 均已实现。证据 W:ComponentShim

- 矩阵未收录：`element.findAll(` — Obsidian 给 HTMLElement 打的原型补丁（和 Object.isEmpty/String.isString 同类），契约矩阵没有收录；后处理器第一步就是 element.findAll(".task-list-item")，不 patch 就直接 TypeError。
- 矩阵未收录：`vault.getFileByPath(` — 矩阵的 Vault 条目没有 getFileByPath（只有 TFile 与 MetadataCache.getFirstLinkpathDest 之类）；宿主必须支持按 path 直接取 TFile。
- 矩阵未收录：`workspace.onLayoutReady(` — 矩阵的 Workspace 条目没有 onLayoutReady；插件用它把首次渲染推迟到布局就绪之后。

**结论**：这条链路在宿主上整体是 `unsupported/needs-architecture` —— `registerMarkdownPostProcessor(` 现在只 `console.warn`（证据 W:PluginShim）。所以第四件夹具"能构建、能被宿主加载、但渲染后处理不会执行"：阅读视图的 DOM 上不会出现任何任务控件。M2 要补的最小面是：①真 post-processor 注册表（按 sourcePath 过滤）②ctx 对象（`docId` / `sourcePath` / `frontmatter` / `getSectionInfo` / `addChild`）③Markdown 渲染完成后把 el + ctx 交给每个 processor ④`MarkdownRenderChild` 的生命周期挂到视图 unload（现在基于 ComponentShim，containerEl 是桩）。

## 6. 每个夹具用到的 unsupported / stub 条目清单

口径：只统计该夹具产物里**真实命中**（计数 > 0）的契约符号与调用点标记，`status ∈ {unsupported, stub}` 单列；`partial` 另计一行（partial 表示宿主有实现但不完整，语义见契约矩阵的 note）。

已剔除同名噪声：`Array/String/Object/Math/Number/Promise/Date/Map/Set/RegExp/Error/JSON/Tasks/TasksFile/Instruction/Modifier/displayTooltip/renderResults/request/ready`——它们是 JS 内建名或插件自有类型名（如 tasks 自己的 `Tasks`/`TasksFile`），在压缩产物里出现几百次但没有一次是调用宿主 API，计进缺口只会虚增。**判据以「调用点」行为准**（精确正则），「契约符号」行只是量级参考。

| 夹具 | 条目 | 类别 | 命中 | status | gap | 契约矩阵说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `view-calendar` | `Setting` | 契约符号 | 8 | stub | needs-architecture | setName/setDesc/addText 等全部空壳（回调收到空桩组件）；设置 UI 实际由 settings.register 声明式渲染。证据 W:Setting H:settings.register |
| `view-calendar` | `ConfirmationModal` | 契约符号 | 2 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `view-calendar` | `FileView` | 契约符号 | 2 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `view-calendar` | `getIcon` | 契约符号 | 1 | stub | low-risk | 恒返回 null。证据 W:getIcon |
| `view-calendar` | `Modal` | 契约符号 | 1 | stub | needs-architecture | open() 只发 ui.placeholder（该通道当前无宿主处理器），titleEl/contentEl 恒 null，无 DOM 容器。证据 W:Modal |
| `view-calendar` | `parseFrontMatterTags` | 契约符号 | 1 | unsupported | low-risk | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `view-calendar` | `setIcon` | 契约符号 | 1 | stub | low-risk | 空函数，元素上不渲染图标。证据 W:setIcon |
| `view-calendar` | `setViewState(` | 调用点 | 1 | stub | needs-architecture | 空构造；插件视图拿到的 leaf 是 makePluginLeaf 的假对象。证据 W:WorkspaceLeaf |
| `view-calendar` | `setIcon(` | 调用点 | 1 | stub | low-risk | 空函数，元素上不渲染图标。证据 W:setIcon |
| `view-calendar` | `ctx.frontmatter` | 调用点 | 1 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `view-calendar` | `（partial 汇总）` | 合计 | 114 | partial | needs-architecture | 15 条：moment、Notice、Vault、ItemView、PluginSettingTab、this.app … |
| `editor-outliner` | `Setting` | 契约符号 | 10 | stub | needs-architecture | setName/setDesc/addText 等全部空壳（回调收到空桩组件）；设置 UI 实际由 settings.register 声明式渲染。证据 W:Setting H:settings.register |
| `editor-outliner` | `Decoration.* / EditorView.decorations|theme|domEventHandlers` | 调用点 | 9 | unsupported | needs-architecture | — |
| `editor-outliner` | `.dispatch(` | 调用点 | 5 | unsupported | needs-architecture | — |
| `editor-outliner` | `EditorView（构造/静态方法）` | 调用点 | 3 | unsupported | needs-architecture | — |
| `editor-outliner` | `StateField.define` | 调用点 | 2 | unsupported | needs-architecture | 同上：StateField 依赖宿主持有的 EditorState 类型，跨实例会因构造函数不同而失效。 |
| `editor-outliner` | `editorInfoField` | 契约符号 | 1 | unsupported | needs-architecture | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `editor-outliner` | `MarkdownView` | 契约符号 | 1 | stub | needs-architecture | [截至 2026-11-01 @ 48f164a] 覆盖插件: 无（本仓无插件依赖该视图；宿主编辑器页承担正文编辑）。空构造（FileViewShim 子类，editor 与 previewMode 恒 null），无编 |
| `editor-outliner` | `Modal` | 契约符号 | 1 | stub | needs-architecture | open() 只发 ui.placeholder（该通道当前无宿主处理器），titleEl/contentEl 恒 null，无 DOM 容器。证据 W:Modal |
| `editor-outliner` | `ViewPlugin.fromClass/define` | 调用点 | 1 | unsupported | needs-architecture | CM6 运行时对象不在 obsidian.d.ts 里；宿主必须把同一份 @codemirror/view 实例交给插件，插件才能把 ViewPlugin 挂到真实编辑器上。 |
| `editor-outliner` | `EditorState.create/transaction/readOnly` | 调用点 | 1 | unsupported | needs-architecture | — |
| `editor-outliner` | `（partial 汇总）` | 合计 | 36 | partial | needs-architecture | 8 条：Notice、PluginSettingTab、Editor.getValue/setValue/replaceRange/listSelections、this.app、app.vault.*、app.workspace.* … |
| `markdown-postprocessor-tasks` | `setIcon` | 契约符号 | 10 | stub | low-risk | 空函数，元素上不渲染图标。证据 W:setIcon |
| `markdown-postprocessor-tasks` | `ButtonComponent` | 契约符号 | 8 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `markdown-postprocessor-tasks` | `setTooltip` | 契约符号 | 8 | unsupported | needs-architecture | tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。 |
| `markdown-postprocessor-tasks` | `Modal` | 契约符号 | 7 | stub | needs-architecture | open() 只发 ui.placeholder（该通道当前无宿主处理器），titleEl/contentEl 恒 null，无 DOM 容器。证据 W:Modal |
| `markdown-postprocessor-tasks` | `MarkdownView` | 契约符号 | 6 | stub | needs-architecture | [截至 2026-11-01 @ 48f164a] 覆盖插件: 无（本仓无插件依赖该视图；宿主编辑器页承担正文编辑）。空构造（FileViewShim 子类，editor 与 previewMode 恒 null），无编 |
| `markdown-postprocessor-tasks` | `Setting` | 契约符号 | 6 | stub | needs-architecture | setName/setDesc/addText 等全部空壳（回调收到空桩组件）；设置 UI 实际由 settings.register 声明式渲染。证据 W:Setting H:settings.register |
| `markdown-postprocessor-tasks` | `setIcon(` | 调用点 | 6 | stub | low-risk | 空函数，元素上不渲染图标。证据 W:setIcon |
| `markdown-postprocessor-tasks` | `ctx.frontmatter` | 调用点 | 6 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `markdown-postprocessor-tasks` | `getLeaf(` | 调用点 | 4 | stub | needs-architecture | 空构造；插件视图拿到的 leaf 是 makePluginLeaf 的假对象。证据 W:WorkspaceLeaf |
| `markdown-postprocessor-tasks` | `MarkdownRenderer` | 契约符号 | 3 | stub | needs-architecture | render/renderMarkdown 直接 reject，嵌入与代码块渲染未实现。证据 W:MarkdownRenderer |
| `markdown-postprocessor-tasks` | `MarkdownRenderer.render*` | 调用点 | 3 | stub | needs-architecture | render/renderMarkdown 直接 reject，嵌入与代码块渲染未实现。证据 W:MarkdownRenderer |
| `markdown-postprocessor-tasks` | `TextAreaComponent` | 契约符号 | 2 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `markdown-postprocessor-tasks` | `ctx.sourcePath` | 调用点 | 2 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `markdown-postprocessor-tasks` | `ctx.addChild(` | 调用点 | 2 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `markdown-postprocessor-tasks` | `ConfirmationModal` | 契约符号 | 1 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `markdown-postprocessor-tasks` | `editorInfoField` | 契约符号 | 1 | unsupported | needs-architecture | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `markdown-postprocessor-tasks` | `EditorSuggest` | 契约符号 | 1 | unsupported | needs-architecture | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `markdown-postprocessor-tasks` | `getAllTags` | 契约符号 | 1 | unsupported | low-risk | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `markdown-postprocessor-tasks` | `getLinkpath` | 契约符号 | 1 | unsupported | low-risk | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `markdown-postprocessor-tasks` | `Keymap` | 契约符号 | 1 | stub | needs-architecture | 只导出 isModifier 且恒 false，键位注册表不存在。证据 W:Keymap |
| `markdown-postprocessor-tasks` | `parseFrontMatterTags` | 契约符号 | 1 | unsupported | low-risk | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `markdown-postprocessor-tasks` | `sanitizeHTMLToDom` | 契约符号 | 1 | unsupported | needs-architecture | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `markdown-postprocessor-tasks` | `SuggestModal` | 契约符号 | 1 | stub | needs-architecture | 继承空 Modal，无输入框、无候选列表、无键盘导航。证据 W:SuggestModalShim |
| `markdown-postprocessor-tasks` | `TextComponent` | 契约符号 | 1 | unsupported | needs-architecture | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `markdown-postprocessor-tasks` | `registerMarkdownPostProcessor(` | 调用点 | 1 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `markdown-postprocessor-tasks` | `ViewPlugin.fromClass/define` | 调用点 | 1 | unsupported | needs-architecture | CM6 运行时对象不在 obsidian.d.ts 里；宿主必须把同一份 @codemirror/view 实例交给插件，插件才能把 ViewPlugin 挂到真实编辑器上。 |
| `markdown-postprocessor-tasks` | `.dispatch(` | 调用点 | 1 | unsupported | needs-architecture | — |
| `markdown-postprocessor-tasks` | `ctx.getSectionInfo(` | 调用点 | 1 | unsupported | needs-architecture | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:Plugi |
| `markdown-postprocessor-tasks` | `（partial 汇总）` | 合计 | 259 | partial | needs-architecture | 22 条：moment、Notice、HTMLElement、Element、MarkdownRenderChild、getLanguage … |
| `theme-minimal` | — | — | — | — | — | 无 unsupported/stub 命中 |

## 7. 依赖树与外置项（M2 容器要提供的实例）

口径：**external** 取 lock 的 `build.external`（构建时真正标记为外置的模块：产物里是 `require(...)` 而不是内联代码，宿主必须在运行时给出同一份实例）；**锁定版本**取 lock 的 `build.resolved`（npm install 之后回写）；**声明范围**取该 commit 的 package.json。

| 夹具 | 产物 | 外置模块 | 一级依赖（声明 → 锁定） | node_modules 顶层包数 |
| --- | --- | --- | --- | --- |
| `view-calendar` | `main.js` 142387B<br>`manifest.json` 306B<br>`styles.css` 194B | — | `obsidian` 1.14.4 → 1.14.4<br>`obsidian-calendar-ui` 0.3.12 → （未记录）<br>`obsidian-daily-notes-interface` 0.9.0 → （未记录）<br>`svelte` 3.35.0 → 3.35.0<br>`tslib` 2.1.0 → （未记录） | 537 |
| `editor-outliner` | `main.js` 108865B<br>`manifest.json` 286B<br>`styles.css` 2169B | `obsidian`<br>`@codemirror/state`<br>`@codemirror/view`<br>`@codemirror/language` | — | — |
| `markdown-postprocessor-tasks` | `main.js` 1053970B<br>`manifest.json` 518B<br>`styles.css` 28060B | `obsidian`<br>`electron`<br>`codemirror`<br>`@codemirror/autocomplete`<br>`@codemirror/closebrackets`<br>`@codemirror/commands`<br>`@codemirror/fold`<br>`@codemirror/gutter`<br>`@codemirror/history`<br>`@codemirror/language`<br>`@codemirror/rangeset`<br>`@codemirror/rectangular-selection`<br>`@codemirror/search`<br>`@codemirror/state`<br>`@codemirror/stream-parser`<br>`@codemirror/text`<br>`@codemirror/view` | `@floating-ui/dom` ^1.7.6 → 1.8.0<br>`boon-js` ^2.0.5 → 2.0.5<br>`chrono-node` 2.3.9 → 2.3.9<br>`eventemitter2` ^6.4.5 → 6.4.9<br>`flatpickr` ^4.6.13 → 4.6.13<br>`i18next` ^24.2.1 → 24.2.3<br>`mustache` ^4.2.0 → 4.2.0<br>`mustache-validator` ^0.2.0 → （未记录）<br>`rrule` ^2.8.1 → 2.8.1<br>`safe-regex2` ^5.1.1 → 5.1.2 | 1071 |
| `theme-minimal` | `manifest.json` 200B<br>`styles.css` 505243B | — | — | — |

- `editor-outliner`：4 个 external，其中 CodeMirror 相关 3 个（`@codemirror/state`、`@codemirror/view`、`@codemirror/language`）—— 宿主必须提供**同一份** `@codemirror/state`/`@codemirror/view` 实例，否则插件 import 到的类与宿主编译器里的不是同一个构造函数，ViewPlugin/StateField 会静默失效；moment 不在 external，若产物里出现 moment 引用就是内联打包。
- `markdown-postprocessor-tasks`：17 个 external，其中 CodeMirror 相关 15 个（`codemirror`、`@codemirror/autocomplete`、`@codemirror/closebrackets`、`@codemirror/commands`、`@codemirror/fold`、`@codemirror/gutter`、`@codemirror/history`、`@codemirror/language`、`@codemirror/rangeset`、`@codemirror/rectangular-selection`、`@codemirror/search`、`@codemirror/state`、`@codemirror/stream-parser`、`@codemirror/text`、`@codemirror/view`）—— 宿主必须提供**同一份** `@codemirror/state`/`@codemirror/view` 实例，否则插件 import 到的类与宿主编译器里的不是同一个构造函数，ViewPlugin/StateField 会静默失效；moment 不在 external，若产物里出现 moment 引用就是内联打包。
- 现在宿主的实际情况：`tools/workspace-bundle/node_modules` 里**没有** `moment`（本报告生成时实测），也还没有给插件注入 `@codemirror/*` 实例的通道；这就是"external 列表"对 M2 的待办清单。

## 8. 缺口排名 top 10（跨夹具合并）

口径：把"契约符号 / 调用点标记 / CSS 契约"三类行统一，过滤掉 status=implemented 与同名噪声（见第 6 节黑名单），按命中夹具数、再按总频次排序取前 10。全部夹具共同命中的缺口共 0 条（若不足 10 条，后面用两件套/单件套缺口补齐，逐夹具列里能看出谁命中）。

| # | 缺口 | 类别 | 命中夹具数 | 总频次 | 逐夹具 | status | gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `this.app` | 调用点 | 3 | 73 | `view-calendar`:24 / `editor-outliner`:7 / `markdown-postprocessor-tasks`:42 / `theme-minimal`:0 | partial | needs-architecture |
| 2 | `app.workspace.*` | 调用点 | 3 | 25 | `view-calendar`:15 / `editor-outliner`:1 / `markdown-postprocessor-tasks`:9 / `theme-minimal`:0 | partial | needs-architecture |
| 3 | `Setting` | 契约符号 | 3 | 24 | `view-calendar`:8 / `editor-outliner`:10 / `markdown-postprocessor-tasks`:6 / `theme-minimal`:0 | stub | needs-architecture |
| 4 | `Notice` | 契约符号 | 3 | 23 | `view-calendar`:3 / `editor-outliner`:3 / `markdown-postprocessor-tasks`:17 / `theme-minimal`:0 | partial | low-risk |
| 5 | `app.vault.*` | 调用点 | 3 | 20 | `view-calendar`:7 / `editor-outliner`:2 / `markdown-postprocessor-tasks`:11 / `theme-minimal`:0 | partial | needs-architecture |
| 6 | `Modal` | 契约符号 | 3 | 9 | `view-calendar`:1 / `editor-outliner`:1 / `markdown-postprocessor-tasks`:7 / `theme-minimal`:0 | stub | needs-architecture |
| 7 | `addSettingTab(` | 调用点 | 3 | 3 | `view-calendar`:1 / `editor-outliner`:1 / `markdown-postprocessor-tasks`:1 / `theme-minimal`:0 | partial | needs-architecture |
| 8 | `PluginSettingTab` | 契约符号 | 3 | 3 | `view-calendar`:1 / `editor-outliner`:1 / `markdown-postprocessor-tasks`:1 / `theme-minimal`:0 | partial | needs-architecture |
| 9 | `moment` | 契约符号 | 2 | 88 | `view-calendar`:30 / `editor-outliner`:0 / `markdown-postprocessor-tasks`:58 / `theme-minimal`:0 | partial | needs-architecture |
| 10 | `moment(` | 调用点 | 2 | 55 | `view-calendar`:12 / `editor-outliner`:0 / `markdown-postprocessor-tasks`:43 / `theme-minimal`:0 | partial | needs-architecture |

## 9. 方法与局限

- 扫描对象是**构建产物**而非源码：被 tree-shake 掉的 import 不会计入，这比读 src 更贴近运行时真实调用面。
- 契约符号计数是同名标识符近似，会高估（局部变量同名）。调用点标记（第 3 节）是精确正则：排序看第 2 节，判定缺口看第 3 节。
- `@codemirror/*` 相关能力在 obsidian.d.ts 里不存在，矩阵没有对应符号；这类行标"（d.ts 之外）"并自带 status/gap。
- 本报告只回答"插件用了什么、宿主缺什么"，不回答"能不能跑起来"——运行时轨道未完成。

