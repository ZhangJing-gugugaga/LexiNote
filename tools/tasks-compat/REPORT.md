# obsidian-tasks 8.6.0 × LexiNote 页面运行时 —— 零改动兼容轨报告

## 0. 一句话结论

**本轨未达成"零改动跑通"**：obsidian-tasks 8.6.0 的 `main.js` 在**模块求值阶段**（onload 之前）就抛出
`Class extends value undefined is not a constructor or null`，根因是我们发布的 `obsidianNamespace` 里没有
`EditorSuggest`（`obsidian-tasks/main.js:602` 的 `class dy extends To.EditorSuggest`）。
因此 onload 从未被调用，后处理器注册、任务行渲染、checkbox 回写这三条断言在当前底座上**不可达**，
门禁以 `PENDING` 标注（不是 PASS，也不是粉饰的绿灯）。

另外还有一条**更前置的硬拒绝**（对设备路径而言）：manifest 的 `minAppVersion: 1.13.1` 会被我们的
`manifestCompatible` 判为不兼容，插件在读到 `main.js` 之前就被拒（详见 §5）。

## 1. 夹具指纹（逐字节）

| 文件 | 字节 | sha256 |
|---|---|---|
| `tools/plugins-fixtures/local/obsidian-tasks/main.js` | 1,051,096 | `500F8106D05DDB483BBFEC135CAC7948022BF6BA7386D1851B28F4D087866E8F` |
| `tools/plugins-fixtures/local/obsidian-tasks/manifest.json` | 518 | `2EFC88DF9E973247360D486B420791C266C8824516919303B948D0192E159127` |

来源 `.fixtures-out/probe-net/{main.js,manifest.json}`，搬家用 `Copy-Item`，未格式化 / 未裁剪 / 未加注释；
门禁每次运行都重算并与常量比对（第 1 条断言），不一致直接 exit 1。

## 2. 运行方式与关键输出

`~
node scripts/tests/plugin-tasks-compat.cjs                 # 门禁（契约模式）
node scripts/tests/plugin-tasks-compat.cjs --require-full  # 目标未达成时强制 exit 1
node scripts/tests/plugin-tasks-compat.cjs --redlight=sha256|registry|writeback
`~

harness 做的事（`tools/tasks-compat/harness.cjs`）：jsdom 里按发布顺序 eval
`lexinote_plugin_shim.js` → `lexinote_workspace_shim.js` → `lexinote_reading.js` → `lexinote_workspace.js`，
装上 `window.lexiHost`（ArkTS 侧 javaScriptProxy 的替身）后，用 `lexiRuntime.__receive('load.plugin', ...)`
把**未改动的** main.js 交给我们的 `loadPlugin`（`lexinote_plugin_shim.js:2165`）。

关键输出：

`~
[PASS] 01 fixture byte-identical ... 500F8106...6E8F 1051096 B
[PASS] 02 main.js was really executed - factory executed, its own frame:
       at eval (lexinote-plugin-obsidian-tasks-plugin.js:604:32)
[PENDING] 03 registerMarkdownPostProcessor reached our registry - unreachable:
          EditorSuggest missing from obsidianNamespace (lexinote_plugin_shim.js:2433)
[PENDING] 03b task lines rendered as real DOM checkboxes
[PENDING] 04 checkbox click writes the source line back
[PASS] 05 gap table written - 11 gaps {"missing":9,"stub":2}
`~

宿主调用序列（失败前全部）：`runtime.ready`, `events.on`, `plugin.onload.error`。
`plugin.onload.done` 从未出现 ⇒ onload 未执行。

**行号换算**：V8 对 `new Function` 的函数体多算 2 行（函数头一行 + 参数收尾一行），harness 用一次标定调用
实测 `lineOffset = 2`，故 `604:32 → main.js:602:32`。该处源码开头为 `,1e4)}var dy=class extends To.EditorSuggest{constructor(t,e,n){super(t),...`
列 32 正落在 `To.EditorSuggest` 的 `E` 上，与运行时错误互相印证。

## 3. 缺口表（前 15 条 + 统计）

完整版：`.fixtures-out/tasks-compat/gap-report.json`（机器读）与 `gap-report.md`（人读）。

| # | api | calledFrom | ourState | error |
|---|---|---|---|---|
| 1 | obsidian.EditorSuggest | main.js:602 | missing | Class extends value undefined is not a constructor or null @ ...:604:32 |
| 2 | obsidian.getLinkpath | main.js:609 | missing | 未触达（静态投影） |
| 3 | obsidian.getLanguage | main.js:220 | missing | 未触达（静态投影） |
| 4 | obsidian.parseFrontMatterTags | main.js:220 | missing | 未触达（静态投影） |
| 5 | obsidian.getAllTags | main.js:220 | missing | 未触达（静态投影） |
| 6 | obsidian.setTooltip | main.js:534 | missing | 未触达（静态投影） |
| 7 | obsidian.ConfirmationModal | main.js:599 | missing | 未触达（静态投影） |
| 8 | obsidian.sanitizeHTMLToDom | main.js:599 | missing | 未触达（静态投影） |
| 9 | obsidian.displayTooltip | main.js:599 | missing | 未触达（静态投影） |
| 10 | Plugin.registerMarkdownPostProcessor | shim 侧 | stub | 丢弃式实现，只 warn（`lexinote_plugin_shim.js:1667`；workspace 页由 `lexinote_workspace.js:441` 覆盖，插件视图页没有：`lexinote_plugin_view_shim.js:295` 是空函数） |
| 11 | obsidian.setIcon | shim 侧 | stub | 空实现 `function () {}`（`lexinote_plugin_shim.js:2500`），图标静默不出现 |

**按 ourState 统计：missing 9，stub 2，共 11 条。**

其中第 1 条是**运行实测**（有真实堆栈）；第 2–9 条是**静态投影**（把 bundle 里对 obsidian 模块的取名与
`obsidianNamespace` 的 66 个导出做差集：31 个模块别名、30 个用到的名字、9 个缺失）。静态条目不代表
"下一个必崩"，只代表"一旦执行到就是 undefined"。

**能定死的硬崩点只有一个**：bundle 里 `extends <obsidianVar>.<Name>` 共 12 处，只有 `To.EditorSuggest`
（main.js:602）指向我们没导出的名字；其余 11 处（Modal ×4、SuggestModal、Menu、MarkdownRenderChild、
PluginSettingTab、Plugin）我们都有导出。也就是说 **补上 `EditorSuggest` 就能越过类定义期的硬崩，之后才会进入 onload**
——但那属于改底座，本轨不许改。

## 4. 我们两个 shim 的指纹：开工 vs 收工（底座被别的轨改过）

| 版本 | lexinote_plugin_shim.js | lexinote_plugin_view_shim.js |
|---|---|---|
| 开工（本轨开始时） | 123,137 B / `278CBC352D76C0B3C6CFCCB921EAB8FD502300C31CC7B41FA11980C9F864F471` | 42,041 B / `C2CDC44BC33C5EA5851B0ACEB51BD3A9EF89BE116DE9529833E5808525E337EA` |
| 中途（第一轮结论基于此） | 124,409 B / `445B10FDDBEDF3408EE72220E90CD06A125A1998237BE65E6A891A71528BC897` | 42,765 B / `AB2A56BB76C9DE98E619A923EB2E71BC3568E1BE2902AEDCF035FDBA52C9BD53` |
| 收工（最终三次 exit code 与缺口表基于此） | **124,783 B / `22F47422298B927E84E229F48AFF32ACE4B847DC92968B860F060ECFD9A93010`** | **43,007 B / `6196751DF7DC806A676422FFB09E6F536177134641F5536E10DA61DA2EFBE16C`** |

**指纹变了两次**：其它轨在本轨期间持续改这两个 shim（新增 `PluginShim.prototype.registerEditorSuggest`，
`lexinote_plugin_shim.js:1684`，空实现；视图侧 `:299` 同样新增空实现）。**本报告与门禁的全部结论都基于表中"收工"版本**，
三次 exit code 也是在该版本上重跑的。基线常量写在门禁的 `SHIM_BASELINE` 里，指纹再变只打印 `[WARN] base shim changed`，
不会静默通过，也不会把过期结论当成现值。
关键一点：这些新增的是"注册入口"，不是 `EditorSuggest` 基类导出本身，所以崩溃点仍是 `main.js:602`、
`onload` 仍未执行——这一判断来自收工版本上重跑的第 02/03 条断言，不是沿用上一版输出。

## 5. minAppVersion 1.13.1 的判定：**拒绝**

- `entry/src/main/ets/core/plugin/LexiPluginManifest.ets:42` `const APP_VERSION: string = '1.1.0';`
- `:138-146` `versionParts`（按点切、`parseInt`、补足 3 位）
- `:149-157` `comparePluginVersion`（逐位比较，返回 -1 / 0 / 1）
- `:160-162` `manifestCompatible` = `comparePluginVersion(manifest.minAppVersion, APP_VERSION) <= 0`
- 判定：`[1,13,1]` vs `[1,1,0]` → 第 2 位 13 > 1 → 返回 1 → `false` ⇒ **不兼容**
- 调用点：`entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:1539-1542`
  - `:1540` errorState = "需要 LexiNote ${manifest.minAppVersion} 及以上" ⇒ 界面文案 **"需要 LexiNote 1.13.1 及以上"**
  - `:1541` `pluginError('插件版本不兼容: ' + pluginId + ' 需要 ' + ...minAppVersion)` ⇒ 日志 **"插件版本不兼容: obsidian-tasks-plugin 需要 1.13.1"**
  - `:1542` `return false`（在 `:1544` 读 main.js 之前）

即：设备上 Tasks 8.6.0 **连 main.js 都不会被读到**；本报告里的 jsdom 缺口是"绕过 manifest 闸门之后"的第二道墙。
建议（只报告，未改动）：要么把 `APP_VERSION` 提到与所声称兼容的 Obsidian 版本一致（如 `1.13.1`），
要么在 `:160` 明确"我们声称兼容到哪个 Obsidian 版本"。这是产品口径决定，不是 bug 修复。

## 6. 门禁三次 exit code

| 运行 | 结果 | exit |
|---|---|---|
| 首次（默认契约模式） | 4 pass / 0 fail / 3 pending，`RESULT: PENDING` | **0** |
| 红灯 `--redlight=registry` | `[FAIL] 03 registerMarkdownPostProcessor reached our registry - registry empty: the registration path is dead` + `RESULT: FAIL` | **1** |
| 红灯 `--redlight=sha256` | `[FAIL] 01 fixture byte-identical ... expected DEADBEEF...` + `RESULT: FAIL` | **1** |
| `--require-full`（标定"目标未达成"） | `RESULT: GOAL_NOT_MET (3 acceptance criteria unreachable on the current base)` | **1** |
| 还原后重跑 | 4 pass / 0 fail / 3 pending，`RESULT: PENDING` | **0** |

（上表五次 exit code 全部在 §4 的"收工"版本上重跑取得，不是沿用中途版本的结果。）

红灯点名的是门禁自己的第 03 条断言（不是靠改断言变绿，也没有 skip 掉任何检查）；
红灯为注入式（`--redlight=`），不落地改文件，因此"还原"就是不带参数重跑。

## 7. 没有证明的东西（单独一段，必须读）

1. **onload 从未执行过**：本轨所有"跑通了"的部分只到"装载流程 + 真实堆栈定位"，没有任何一行 Tasks 的业务逻辑跑过。
2. **后处理器注册 / 任务行渲染 / checkbox 回写三条断言全部不可达**，门禁里是 `PENDING` 占位，不是通过。
3. **宿主是桩**：`window.lexiHost` 是 harness 写的替身（真实设备上由 ArkTS 的 `javaScriptProxy` 提供）；
   `vault.read/modify`、`metadata.get`、`data.load/save`、`events.on` 都返回固定值，真实主机的鉴权、令牌、错误文案一条都没被验证。
4. **DOM 桩：0 个**。断言只依赖 jsdom + 我们发布的产物，没有补 `findAll` 之类 Obsidian 原型方法。
   （副作用：CM6 在 jsdom 里报 `TypeError: ...getClientRects is not a function`，属测量 API 缺失，未影响本轨结论。）
5. **只在 jsdom 成立、设备上未知**：页面脚本 eval 顺序、`window.__lexiCmModules` 提供 `@codemirror/*` 的方式、
   `LexiReading` 的注册表行为。ArkWeb 上的分片源码加载路径（`plugin.sourceChunk`）本轨没走（直接传 code）。
6. **第 2–9 条缺口是静态投影**，不是运行证据：只说明"用到但没导出"，不说明执行顺序与是否真会崩。
7. **manifest 闸门结论是读码结论**：没有设备 / ArkTS 运行时可以执行 `manifestCompatible`，行号与文案是逐行读出来的，未运行。
8. 底座在本轨期间被别的轨改动过（§4）；若之后 `EditorSuggest` 被补上，本报告的"onload 不可达"结论立即过期，需重跑门禁。

## 8. 建议改法（只报告，未改动任何 rawfile / ets）

1. `entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2433` `obsidianNamespace` 缺 `EditorSuggest`。
   没有它，任何"编辑器内建议"类插件（Tasks 的日期/状态补全正是这条路）在**类定义阶段**直接崩。
2. 同上 `:2500` `setIcon` 是空实现；`:1667` `registerMarkdownPostProcessor` 在 shim 里丢弃
   （workspace 页靠 `lexinote_workspace.js:441` 兜住，插件视图页 `lexinote_plugin_view_shim.js:295` 没有兜）。
3. `entry/src/main/ets/core/plugin/LexiPluginManifest.ets:42` 的 `APP_VERSION='1.1.0'` 与真实生态版本号不同源，导致 `minAppVersion: 1.13.1` 被拒（§5）。
## 9. 失败阶梯（HARNESS-ONLY，2026-11-02 补测）

§0 的结论对本报告发布时的 rawfile 仍然成立。本节回答的是**另一个问题**：把 `EditorSuggest` 补上以后，
后面还有几个点，以及终点在哪。做法是在 jsdom harness 内逐级补最小 stub（`tools/tasks-compat/ladder-stubs.cjs`，
注入 `window.LexiObsidian.namespace`），崩一次补一级，**rawfile 一个字节没改**。

阶梯表（原文见 `.fixtures-out/tasks-compat/gap-ladder.md`）：

| level | crashPoint(file:line) | missingSymbol | harnessStub | nextError |
|---|---|---|---|---|
| 1 | main.js:602 | EditorSuggest | `class EditorSuggest { constructor(app) }` + close/open/setInstructions 空实现 | `(0 , QS.getLanguage) is not a function` @ main.js:220 |
| 2 | main.js:220 | getLanguage | `getLanguage() => 'en'` | `(0 , yr.sanitizeHTMLToDom) is not a function` @ main.js:599 |
| 3 | main.js:602 | app.scope (App keymap Scope) | `app.scope = new Scope()`；`Scope.prototype.register/unregister` 空实现 | none — `plugin.onload.done` reached |

**阶梯止于第 3 级之后**：补到第 3 级时 host 收到 `plugin.onload.done`，`reading.postProcessor.register` 观测到 1 次注册，
但首次渲染立刻撞上**架构级缺口**：

- 缺的符号：`ctx.addChild`，现状错误 `e.addChild is not a function`；
- 位置：`entry/src/main/resources/rawfile/lexinote_reading.js` 的 post-processor 上下文构造函数 `An`，只给 `el/sourcePath/frontmatter/getSectionInfo`；
- 对照：`ComponentShim.prototype.addChild` 本身存在（`lexinote_plugin_shim.js:1532` / `lexinote_plugin_view_shim.js:261`），缺的是把 ctx 接到组件生命周期的那一层；
- 插件侧形状：`_markdownPostProcessor` 第一步就 `new MarkdownRenderChild(el)` 再 `e.addChild(child)`，所以它一次都没跑进 `.task-list-item` 处理；
- 产品侧要改什么：在 `lexinote_reading.js` 的 `An` 里补 `addChild/removeChild`（挂到 MarkdownRenderChild 的 load/unload 生命周期，元素卸载时 unload）。harness 不补——伪造 `addChild` 等于替插件伪造组件归属；
- 影响面：所有在 post-processor 里 `ctx.addChild` 的插件都会在第一步死掉；reading 页看到的仍是未加工 markdown。

门禁形态与三次 exit code：

```
node scripts/tests/plugin-tasks-compat.cjs --ladder                        -> EXIT 0   （6 pass / 0 fail / 2 pending）
node scripts/tests/plugin-tasks-compat.cjs --ladder --ladder-redlight=3    -> EXIT 1   （[red-light] removed level 3 (app.scope) → 红在 Cannot read properties of null (reading 'register') @ main.js:602）
node scripts/tests/plugin-tasks-compat.cjs --ladder                        -> EXIT 0
```

非 `--ladder` 路径与本报告发布时一致（4 pass / 0 fail / 3 pending，`--require-full` 仍 exit 1）：
阶梯补丁只在 `--ladder` 分支里生效，不改变 §0 的判定。

### 这张表没有证明的东西

1. 每级 stub 都遮蔽一条真实缺口；设备上这 3 条**一条都没补**。
2. 只在 jsdom 成立：`window.lexiHost` 是桩（只回一条固定 markdown），没有真实 vault/workspace/编辑器，
   `getClientRects`、flatpickr 日历、CM6 输入这些路径没跑。
3. `plugin.onload.done` 只证明 loader 把 onload 调完并回来了，不证明插件可用（命令面板 / 设置页 / 编辑期实时更新都没验）。
4. 页面上那 2 个 checkbox 是 markdown 渲染器自带的，不是插件产物；点击后 `sourceBefore == sourceAfter`，没有 `vault.modify`。
5. 缺口之后的缺口数**未知**：停在这里后仍残留两条被插件自己吞掉的错误（`main.js:599 sanitizeHTMLToDom`、`metadataCache.getAllProperties`），按边界没有继续爬。
