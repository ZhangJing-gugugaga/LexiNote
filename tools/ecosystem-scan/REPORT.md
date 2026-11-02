# Obsidian 社区插件 main.js 静态依赖扫描报告

- 生成时间: 2026-11-02T12:35:02.265Z
- 抽样源: https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json
- 抽样规则: 按该 JSON 顺序取前 24 个（不人工挑选）
- 下载缓存: `.fixtures-out/eco-scan/cache/<id>/main.js`（幂等：缓存命中不重复下载）
- 最近一次运行: 缓存命中 24 个 / 实际下载 0 次；下载成功 24 个，失败 0 个
- 累计（2 次运行）: 网络下载 24 次、11013937 字节 (10.50 MB)；当前缓存文件合计 11013937 字节 (10.50 MB)
- 扫描方式: 从原始 bundle 文本提取 `require("...")` / `from "..."` / `import("...")` 的字面量说明符；非相对且非 `obsidian` 的视为宿主模块依赖。

## 1. 逐插件结果

| # | id | repo | main.js 字节 | 分类 | 命中的外部模块与符号 | 下载状态 |
|---|----|------|--------------|------|----------------------|----------|
| 1 | hotkeysplus-obsidian | argenos/hotkeysplus-obsidian | 55946 | A | 仅 obsidian | ok |
| 2 | nldates-obsidian | obsidian-community/nldates | 1376761 | A | 仅 obsidian 全局: moment | ok |
| 3 | obsidian-git | vinzent03/obsidian-git | 813552 | D | fs/promises; @lezer/highlight; fs; path; child_process; os; node:child_process; node:path; node:events; node:crypto; node:http; node:util; @codemirror/state(StateField,StateEffect,RangeSet,EditorState,RangeSetBuilder,Prec,Facet,Compartment,Text,Transaction,ChangeSet); @codemirror/view(EditorView,Decoration,GutterMarker,WidgetType,ViewPlugin,gutter,lineNumbers,drawSelection,keymap,showPanel); @codemirror/language; @codemirror/commands(history); @codemirror/search(search,highlightSelectionMatches) [try/catch 内可选: path] 全局: activeDocument | ok |
| 4 | url-into-selection | denolehov/obsidian-url-into-selection | 8085 | C | path | ok |
| 5 | table-editor-obsidian | tgrosinger/advanced-tables-obsidian | 272036 | C | util; @codemirror/state(Prec); @codemirror/view(keymap) [try/catch 内可选: util] 全局: activeWindow,activeDocument | ok |
| 6 | note-refactor-obsidian | lynchjames/note-refactor-obsidian | 852677 | A | 仅 obsidian 全局: moment | ok |
| 7 | calendar | liamcain/obsidian-calendar-plugin | 489435 | A | 仅 obsidian 全局: moment | ok |
| 8 | obsidian-reading-time | avr/obsidian-reading-time | 15701 | A | 仅 obsidian | ok |
| 9 | mrj-jump-to-link | mrjackphil/obsidian-jump-to-link | 138158 | B | @codemirror/state(EditorSelection); @codemirror/view(Decoration,WidgetType,ViewPlugin,EditorView) 全局: activeDocument | ok |
| 10 | mrj-text-expand | mrjackphil/obsidian-text-expand | 244113 | D | eta; fs; path | ok |
| 11 | todoist-sync-plugin | jamiebrynes7/obsidian-todoist-plugin | 768842 | D | @emotion/is-prop-valid [try/catch 内可选: @emotion/is-prop-valid] | ok |
| 12 | obsidian-vimrc-support | esm7/obsidian-vimrc-support | 177880 | A | 仅 obsidian 全局: activeWindow,CodeMirror(CM5) | ok |
| 13 | shortcuts-extender | ryjjin/Obsidian-shortcuts-extender | 13083 | A | 仅 obsidian | ok |
| 14 | mrj-crosslink-between-notes | mrjackphil/obsidian-crosslink-between-notes | 52235 | A | 仅 obsidian | ok |
| 15 | darlal-switcher-plus | darlal/obsidian-switcher-plus | 135733 | C | electron [try/catch 内可选: electron] 全局: window.require | ok |
| 16 | obsidian-day-planner | ivan-lednev/obsidian-day-planner | 1664694 | A | 仅 obsidian 全局: moment | ok |
| 17 | review-obsidian | ryanjamurphy/review-obsidian | 190925 | A | 仅 obsidian 全局: moment | ok |
| 18 | obsidian-discordrpc | lukeleppan/obsidian-discordrpc | 214785 | C | electron; events; timers; net | ok |
| 19 | templater-obsidian | silentvoid13/Templater | 454294 | C | util; child_process; @codemirror/language(StreamLanguage); @codemirror/state(Prec) 全局: moment,window.require,activeDocument,CodeMirror(CM5) | ok |
| 20 | convert-url-to-iframe | fhachez/obsidian-convert-url-to-iframe | 220616 | A | 仅 obsidian | ok |
| 21 | searchpp | nhaouari/searchpp | 61008 | A | 仅 obsidian | ok |
| 22 | better-word-count | lukeleppan/better-word-count | 2655549 | B | @codemirror/state(StateField,Transaction,EditorState,RangeSetBuilder,StateEffect); @codemirror/view(Decoration,ViewPlugin,WidgetType); @codemirror/language(syntaxTree) 全局: moment | ok |
| 23 | workbench-obsidian | ryanjamurphy/workbench-obsidian | 121709 | A | 仅 obsidian | ok |
| 24 | obsidian-latex-environments | raineszm/obsidian-latex-environments | 16120 | A | 仅 obsidian | ok |

## 2. 分类计数与可加载率

| 分类 | 含义 | 数量 |
|------|------|------|
| A | 只依赖 obsidian（沙箱当前即可加载） | 14 |
| B | 需要 @codemirror/* | 2 |
| C | 需要 electron / node 内建 | 5 |
| D | 需要其他未提供模块 | 3 |
| U | 含动态 require，无法静态判定 | 0 |
| FAIL | 下载失败（未参与分类） | 0 |

**可加载率 = A / (A+B+C+D) = 14 / 24 = 58.3%**（U 与 FAIL 不计入分母，见第 5 节）。

这个数字的口径是「模块依赖只落在 obsidian 包内」。A 类里还有 6 个插件引用了宿主全局（见 2.1）：nldates-obsidian(moment)、note-refactor-obsidian(moment)、calendar(moment)、obsidian-vimrc-support(activeWindow,CodeMirror(CM5))、obsidian-day-planner(moment)、review-obsidian(moment)。
若沙箱未注入 moment / CodeMirror(CM5)，这 6 个里引用这两个全局的插件实际也加载不了，可加载率会降到 (14-6)/24 = 33.3%（下限，未验证）。

### 2.1 宿主全局依赖（obsidian 包之外需要注入的全局）

| 插件 | 命中的全局 |
|------|------------|
| nldates-obsidian | moment |
| obsidian-git | activeDocument |
| table-editor-obsidian | activeWindow, activeDocument |
| note-refactor-obsidian | moment |
| calendar | moment |
| mrj-jump-to-link | activeDocument |
| obsidian-vimrc-support | activeWindow, CodeMirror(CM5) |
| darlal-switcher-plus | window.require |
| obsidian-day-planner | moment |
| review-obsidian | moment |
| templater-obsidian | moment, window.require, activeDocument, CodeMirror(CM5) |
| better-word-count | moment |

共 12 / 24 个插件引用至少一个宿主全局。其中 moment 与 CodeMirror(CM5) 属于沙箱当前未注入的全局；activeWindow/activeDocument 是 Obsidian 的 DOM 别名，window.require 是 Electron 连通性标志（已同时命中 C 类模块依赖）。

## 3. B 类 @codemirror/* 符号频次表

| 模块 | 符号 | 提及次数 | 使用该符号的插件数 | 插件 |
|------|------|----------|------------------|------|
| @codemirror/view | Decoration | 6 | 2 | mrj-jump-to-link, better-word-count |
| @codemirror/view | ViewPlugin | 3 | 2 | mrj-jump-to-link, better-word-count |
| @codemirror/view | WidgetType | 2 | 2 | mrj-jump-to-link, better-word-count |
| @codemirror/state | EditorSelection | 2 | 1 | mrj-jump-to-link |
| @codemirror/language | syntaxTree | 2 | 1 | better-word-count |
| @codemirror/view | EditorView | 1 | 1 | mrj-jump-to-link |
| @codemirror/state | StateField | 1 | 1 | better-word-count |
| @codemirror/state | Transaction | 1 | 1 | better-word-count |
| @codemirror/state | EditorState | 1 | 1 | better-word-count |
| @codemirror/state | RangeSetBuilder | 1 | 1 | better-word-count |
| @codemirror/state | StateEffect | 1 | 1 | better-word-count |

### 3.1 参考：全部引用 @codemirror/* 的插件（含 B/C/D 类）的符号频次

这一节不改变分类，只用于判断兼容模块该写哪些符号；B 类之外的插件还缺别的模块，补 @codemirror/* 不会让它们可加载。

| 模块 | 符号 | 提及次数 | 使用该符号的插件数 | 插件 |
|------|------|----------|------------------|------|
| @codemirror/view | Decoration | 23 | 3 | obsidian-git, mrj-jump-to-link, better-word-count |
| @codemirror/view | WidgetType | 6 | 3 | obsidian-git, mrj-jump-to-link, better-word-count |
| @codemirror/state | Prec | 5 | 3 | obsidian-git, table-editor-obsidian, templater-obsidian |
| @codemirror/view | ViewPlugin | 5 | 3 | obsidian-git, mrj-jump-to-link, better-word-count |
| @codemirror/view | EditorView | 19 | 2 | obsidian-git, mrj-jump-to-link |
| @codemirror/state | StateField | 13 | 2 | obsidian-git, better-word-count |
| @codemirror/state | StateEffect | 10 | 2 | obsidian-git, better-word-count |
| @codemirror/state | EditorState | 7 | 2 | obsidian-git, better-word-count |
| @codemirror/state | RangeSetBuilder | 6 | 2 | obsidian-git, better-word-count |
| @codemirror/state | Transaction | 3 | 2 | obsidian-git, better-word-count |
| @codemirror/view | keymap | 3 | 2 | obsidian-git, table-editor-obsidian |
| @codemirror/state | RangeSet | 6 | 1 | obsidian-git |
| @codemirror/view | GutterMarker | 4 | 1 | obsidian-git |
| @codemirror/state | Facet | 2 | 1 | obsidian-git |
| @codemirror/state | Compartment | 2 | 1 | obsidian-git |
| @codemirror/state | Text | 2 | 1 | obsidian-git |
| @codemirror/view | gutter | 2 | 1 | obsidian-git |
| @codemirror/view | lineNumbers | 2 | 1 | obsidian-git |
| @codemirror/view | drawSelection | 2 | 1 | obsidian-git |
| @codemirror/search | search | 2 | 1 | obsidian-git |
| @codemirror/state | EditorSelection | 2 | 1 | mrj-jump-to-link |
| @codemirror/language | syntaxTree | 2 | 1 | better-word-count |
| @codemirror/state | ChangeSet | 1 | 1 | obsidian-git |
| @codemirror/view | showPanel | 1 | 1 | obsidian-git |
| @codemirror/commands | history | 1 | 1 | obsidian-git |
| @codemirror/search | highlightSelectionMatches | 1 | 1 | obsidian-git |
| @codemirror/language | StreamLanguage | 1 | 1 | templater-obsidian |

## 4. 最小兼容模块集与重算

### 4.1 每个 B 类插件各自需要的最小符号集

| 插件 | 符号数 | 所需符号 | 只解锁该插件后的可加载率 |
|------|--------|----------|--------------------------|
| mrj-jump-to-link | 5 | @codemirror/state:EditorSelection, @codemirror/view:Decoration, @codemirror/view:EditorView, @codemirror/view:ViewPlugin, @codemirror/view:WidgetType | (14+1)/24 = 62.5% |
| better-word-count | 9 | @codemirror/language:syntaxTree, @codemirror/state:EditorState, @codemirror/state:RangeSetBuilder, @codemirror/state:StateEffect, @codemirror/state:StateField, @codemirror/state:Transaction, @codemirror/view:Decoration, @codemirror/view:ViewPlugin, @codemirror/view:WidgetType | (14+1)/24 = 62.5% |

最便宜的单插件解锁: **mrj-jump-to-link（5 个符号）**，可加载率 62.5%（同一批样本重算）。

### 4.2 覆盖全部 B 类插件的最小符号集（并集，11 个符号）

- `@codemirror/state`: EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction
- `@codemirror/view`: Decoration, EditorView, ViewPlugin, WidgetType
- `@codemirror/language`: syntaxTree

### 4.3 按顺序补齐时的覆盖率里程（同一批样本重算，非估算）

顺序 = 先补被最多 B 类插件用到的符号（同频次按提及次数降序）；只列覆盖率发生变化的行。

| 已补符号数 | 本次加入 | 完全可加载的 B 类插件 | 可加载率 |
|------------|----------|------------------------|----------|
| 6 | @codemirror/view:EditorView | 1 (mrj-jump-to-link) | (14+1)/24 = 62.5% |
| 11 | @codemirror/state:StateEffect | 2 (mrj-jump-to-link, better-word-count) | (14+2)/24 = 66.7% |

**结论（同一批样本）**: 只补最便宜的单插件集 → 62.5%；补齐全集 11 个符号 → (14+2)/24 = **66.7%**。

注意 obsidian-tasks 8.6.0 只用 `ViewPlugin.fromClass`，属于本表 @codemirror/view 的低频符号——它不在这 24 个样本里，所以「补 ViewPlugin 能解锁 tasks」与「覆盖本表符号集能提升多少比例」是两件事，不要混算。

## 5. 我没能确定的

- **非字面量 require 无法静态判定**: 1 个插件出现 `require(变量)` 或 `window.require(变量)`（参数不是字符串字面量，静态无法确定目标模块）。这些插件**没有**被默认算进 A 类。
  - U 类计数 = 0：只有当某插件除动态 require 外没有其它可识别的外部模块时才归 U；若它还有静态外部依赖，按优先级已归入 B/C/D，但仍计入下面这个「含动态 require 的插件数」。
  - templater-obsidian（分类 C）: window.require @offset 185614 · t i=l=>window.require&&window.require(l),n={},a={exports:n},s=await th
- **宿主全局的可用性未验证**: 上表列出 moment / CodeMirror(CM5) / activeWindow / activeDocument / window.require 的引用，但沙箱是否已注入这些全局、注入后语义是否完整，本轮没有验证（未上设备）。
- **try/catch 可选依赖按严格口径计入分类**: 4 个插件的外部模块位于 try/catch 内（见第 1 节标注），沙箱抛错可能被 catch 住从而仍能加载；本表没有把这种情况算作 A，属于偏保守。
- **下载失败**: 0 个，已从分母剔除，未当作 A 类；失败项本身可能改变比例。
- 静态扫描只能证明「代码里引用了某模块」，不能证明运行时真的执行到；也不能证明补了模块后行为正确（API 语义可能缺失）。
- 符号提取依赖 CodeMirror 导出名白名单 + `var X = require(...)` 绑定识别，可能漏掉解构别名/间接传递用到的符号。
- 样本 24 个，且是文件顺序最前面的一批（偏早期插件），**不可外推**为整个生态的比例。

## 6. 复现

```
node tools/ecosystem-scan/fetch.cjs   # 幂等下载，缓存命中不重复下载
node tools/ecosystem-scan/scan.cjs    # 扫描缓存并生成 result.json / REPORT.md
```
