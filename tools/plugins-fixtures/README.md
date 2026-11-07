# 插件夹具（真实第三方插件四件套）

本目录只放**清单、脚本、报告**。第三方插件的源码与构建产物一律落在仓库根的 `.fixtures-out/`（已在 `.gitignore` 里，不进库），所以任何人 clone 之后都只有这份 lock 与脚本，没有别人的代码。

链路是三段：**拉取**（按锁定 commit sha 从 codeload 取源码 zip / raw 取单文件）→ **构建**（esbuild / 插件自带 rollup / 无需构建）→ **校验与统计**（逐文件 sha256 + API 使用面扫描）。

## 为什么不用官方 release 产物

本机 `github.com:443` 不通（`curl` code=000），`https://github.com/<repo>/releases/latest/download/main.js` 这类资产拉不下来；可用的只有 `codeload.github.com` 与 `raw.githubusercontent.com`（code=200）。所以夹具一律走"取源码 + 本地构建"，**产物 sha256 是本地构建指纹，不是官方 release 资产的指纹**。要复核同一份源码，锁的是 commit sha，不是分支名。

## 四件套分别验证什么

| 夹具 | 角色 | 上游（锁定 sha） | 验证的能力面 | 许可 |
| --- | --- | --- | --- | --- |
| `view-calendar` | 视图型 | `liamcain/obsidian-calendar-plugin` @ `ef3f2696da11` | `ItemView` 子类 + `registerView` + `workspace.getLeaf/setViewState` + 视图内 DOM 渲染（`createEl/createDiv`）+ 插件自带 `styles.css` 注入 | MIT / Liam Cain |
| `editor-outliner` | 编辑器增强型 | `vslinko/obsidian-outliner` @ `b51918d4eaa7` | CodeMirror 6：`ViewPlugin.fromClass`、`StateField.define`、`Decoration.*`、`EditorView.dispatch`、`EditorState.create/transaction`，以及 `registerEditorExtension` 与 `Editor.getValue/setValue/replaceRange/listSelections` | MIT / Viacheslav Slinko |
| `markdown-postprocessor-tasks` | Markdown 后处理器（阅读视图） | `obsidian-tasks-group/obsidian-tasks` @ `83f54fbba0c6` | `registerMarkdownPostProcessor` 全链路：`MarkdownPostProcessorContext`（`sourcePath` / `getSectionInfo` / `frontmatter` / `addChild`）+ `new MarkdownRenderChild` + `MarkdownRenderer.render` + `element.findAll`（HTMLElement 原型补丁）+ `setIcon` | MIT / Clare Macrae, Ilyas Landikov, Martin Schenck |
| `theme-minimal` | 主题 | `kepano/obsidian-minimal` @ `93321bdc23fc` | 纯 CSS：宿主是否提供 Obsidian 主题变量层（`--background-primary`、`--text-normal`、`--font-text-*`、`--radius-*`、`body.theme-dark/light`）与 DOM 类名层（`.cm-*`、`.markdown-preview-view`、`.workspace-leaf` …） | MIT / Steph Ango (@kepano) |

前三件是**本地构建出的 main.js**（Markdown 后处理器也产出 `styles.css`）；主题是**原样 CSS**，没有 main.js。

阅读视图的验收物必须是 `markdown-postprocessor-tasks`：它是四件里唯一调用 `registerMarkdownPostProcessor` 的插件，报告第 5 节把这条链路逐符号拆开（M2 的输入契约）。

## 怎么跑

```bash
# 默认：按 lock 拉取 + 构建 + 校验 + 回写 artifacts + 重算 API 报告
node scripts/tests/plugin-fixtures-fetch.cjs

# 只校验磁盘上已有产物是否与 lock 的 sha256/体积一致（不联网、不构建）
node scripts/tests/plugin-fixtures-fetch.cjs --check

# 单件；--force 丢弃源码缓存重新拉取与安装；--update-lock 把实测 artifacts 写回 lock
node scripts/tests/plugin-fixtures-fetch.cjs --only editor-outliner --force --update-lock

# 只做主流程，不跑 API 报告
node scripts/tests/plugin-fixtures-fetch.cjs --no-report
```

- 产物：`.fixtures-out/<id>/{manifest.json,main.js,styles.css}`（主题没有 main.js）。
- 源码缓存：`.fixtures-out/.cache/<id>/src`（下次复用，除非 `--force`）。
- 校验失败或构建失败一律非 0 退出，且**不写 lock**——lock 里的 artifacts 只会是实测成功的那一份。
- 纯 Node 实现：zip 解压（中央目录 + `inflateRaw`）与下载都是内置模块，**没有新增依赖**。

## 构建怎么处理"需要 npm install"

| 夹具 | 依赖策略 | 原因 |
| --- | --- | --- |
| `view-calendar` | `npm install --no-audit --no-fund --no-package-lock`，再 `node node_modules/rollup/dist/bin/rollup -c` | 它的构建链就是 rollup + `@rollup/plugin-typescript` + `rollup-plugin-svelte`，绕不开真实安装 |
| `editor-outliner` | **不装依赖**，复用 `tools/workspace-bundle/node_modules/esbuild`（0.24.2）打包，`external` 只留 `obsidian`；`@codemirror/{state,view,language}` 经 `sharedCm` 别名桩随包打进产物（加载期优先取宿主注册表 `__lexiCmModules`，注册表缺席才用打包副本），依赖解析走 `vendoredNodePaths` 指到的 `tools/workspace-bundle/node_modules`，`minifyWhitespace` 压注释（P4-006b：宿主两轨都按 fail-closed 拒绝外部模块，依赖必须随 main.js 打包） | 它的 devDependencies 带 husky，`prepare` 脚本在没有 `.git` 的解压树里会失败；产物只需要一个 cjs bundle，esbuild 一把梭 |
| `markdown-postprocessor-tasks` | 用**它自己的** `esbuild.config.mjs`：`npm install --legacy-peer-deps` → `node esbuild.config.mjs production`（约 12 分钟，node_modules 顶层 881 包） | 上游构建链是 esbuild + esbuild-svelte（Svelte 5 单文件组件）+ esbuild-sass-plugin（`styles.scss`），换成本机 esbuild 0.24.2 无法编译这个 Svelte 版本；`--legacy-peer-deps` 见 patch 3 |
| `theme-minimal` | 无构建 | 纯 CSS |

细节：

- `npm install` 加 `--no-package-lock`：不把上游 lockfile 写进缓存树，避免"锁文件与实测不一致"的假象；真正锁定的是 commit sha + 产物 sha256。
- 不跑插件自带的 `npm run build`：`view-calendar` 的 build 是 `npm run lint && rollup -c`，前置的 `svelte-check`/eslint 与产物无关，只会引入额外失败面。
- 依赖装不上就是失败，不降级、不伪造产物：脚本非 0 退出，`--check` 会明确报 not ready。
- esbuild 的 `define` 支持从源码树取值（`package.json:version`、`file:CHANGELOG.md`），对应 outliner 自己 rollup 配置里的 `@rollup/plugin-replace`。

## 构建允许改什么（业务源码零改动）

只允许改**依赖声明**与**构建配置**，不许碰 `src/**`。每一处改动都写进 `manifest.lock.json` 的 `build.patches`（`file` / `find` / `replace` / `why`），当前三条：

1. `view-calendar` `package.json`：`"obsidian": "obsidianmd/obsidian-api#master"` → `"obsidian": "1.14.4"`。原依赖是 GitHub 上的 git 依赖，安装要走 `github.com:443`，本机不通；换成 npm 上的 `obsidian@1.14.4`——正是本轨契约基线 `tools/contract/symbols.json` 用的同一份 `obsidian.d.ts`，而且 rollup 把 `obsidian` 列为 external，不进产物。
2. `view-calendar` `rollup.config.js`：`typescript({ sourceMap: env.env === "DEV" })` → `typescript({ sourceMap: env.env === "DEV", include: ["**/*.ts", "**/*.tsx"] })`。`@rollup/plugin-typescript@8.2.1` 默认 include 是 `['*.ts+(|x)','**/*.ts+(|x)']`，它内部的 `@rollup/pluginutils@3.1.0` + `picomatch@2.3.2` 对 `+(|x)` 这个 extglob 在本机返回 false（实测同一 id：`**/*.ts+(|x)` → false，`**/*.ts` → true），于是 transform 从不执行，rollup 把 `.ts` 当 JS 解析并报 `Unexpected token`。显式 include 只改匹配规则，不改任何编译选项。
3. `markdown-postprocessor-tasks` `package.json`：`"obsidian": "1.13.1"` → `"obsidian": "1.14.4"`。把它对齐到契约基线 `tools/contract/symbols.json` 的同一份 `obsidian.d.ts`；`obsidian` 在它的 `esbuild.config.mjs` 里是 `external`，不进产物。此外它**不需要改源码**但装依赖会冲突：上游 devDependency `typescript ^6.0.3` 与 `i18next@24.2.3` / `i18next-parser@9.4.0` 的 `peerOptional typescript@"^5"` 撞车，`npm install` 报 `ERESOLVE could not resolve`；对策写在 lock 的 `build.installArgs: ["--legacy-peer-deps"]`，不动任何依赖版本。

## 证据（本机实测，可复算）

| 夹具 | 来源 commit | 构建命令 | exit | 产物 | 体积 | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| `view-calendar` | `ef3f2696da11aa1d11a272179caea062d6144640` | `npm install` + `node node_modules/rollup/dist/bin/rollup -c` | 0 | `main.js` | 142387 B | `2be4abe5cdf8d4a76858bb22b256d92df4574e724fdbb028aeb1257b8cb0be16` |
| `view-calendar` | 同上 | 同上 | 0 | `manifest.json` | 306 B | `3ec2e2666d37fdef152b5e04f07588a143ab44befcd9e03e2838f68212587de4` |
| `view-calendar` | 同上 | 同上 | 0 | `styles.css` | 194 B | `b52f02b77f723fda3d267b355dc580203e4ef48359c26e82316ba172eda6c6e6` |
| `editor-outliner` | `b51918d4eaa75223780a404c40f2d9406df6a3c0` | `esbuild src/ObsidianOutlinerPlugin.ts --bundle --format=cjs --target=es2018`（external: obsidian；sharedCm 别名桩把 @codemirror/{state,view,language} 随包内联 + vendoredNodePaths + minifyWhitespace，P4-006b） | 0 | `main.js` | 548725 B | `76533b17bc279b7961b8f9c18ad8a5016aec9e85e260fccfc95209d781a2dccc` |
| `editor-outliner` | 同上 | 同上 | 0 | `manifest.json` | 286 B | `277a8887eb959cc7a4ae047608421153b359bdf451c2d66caab91c35ca98b93f` |
| `editor-outliner` | 同上 | 同上 | 0 | `styles.css` | 2169 B | `7922a264883894e69f22c37f549744f7d46d1de926fc802aa4e94c75cd2fbceb` |
| `markdown-postprocessor-tasks` | `83f54fbba0c6b9a89952b8bd64172b51b3567c09` | `npm install --legacy-peer-deps` + `node esbuild.config.mjs production` | 0 | `main.js` | 1053970 B | `cf8039c0a2c759ef595a5d06cd68a1313c6acb337bcc5e13f81c1ec75773d1ad` |
| `markdown-postprocessor-tasks` | 同上 | 同上 | 0 | `manifest.json` | 518 B | `2efc88df9e973247360d486b420791c266c8824516919303b948d0192e159127` |
| `markdown-postprocessor-tasks` | 同上 | 同上 | 0 | `styles.css` | 28060 B | `d70d8ebd41fc23bfd5d59873b1a93ed9554b154546a3e637bd4e042e62d1cf23` |
| `theme-minimal` | `93321bdc23fc879966e1e3aa0cfeda77012f540f` | 无（raw 取 `obsidian.css` 作 `styles.css`） | 0 | `styles.css` | 505243 B | `19fa8e88f8da24450c67a49d99a3484603c1abf24f40b8ba16f06a4b914cf5b3` |
| `theme-minimal` | 同上 | 无（raw 取 `manifest.json`） | 0 | `manifest.json` | 200 B | `67a4ff8e848607644a3092bb5b016c934dba0672a3411143e314348ac6d4f7e7` |

`node scripts/tests/plugin-fixtures-fetch.cjs --check` 当前输出「夹具全部就绪（4 件）」（exit 0），逐文件与上表一致。

## 编辑器增强型是怎么挑的

选 `vslinko/obsidian-outliner` @ `b51918d4eaa7`：

- **真的构建期依赖 CodeMirror 6**：源码里 `@codemirror/{state,view,language}` 是 bare import（50 个 `.ts`，138626 B），产物里能数到 `ViewPlugin.fromClass/define` ×1、`StateField.define` ×2、`Decoration.*`／`EditorView.decorations|theme|domEventHandlers` ×9、`EditorView` 构造/静态 ×3、`.dispatch(` ×5、`EditorState.create/transaction/readOnly` ×1。不是"顺手引一个类型"，而是整套 CM6 扩展模型在用。
- **产物（CM 外置时代）108865 B ≤ 300 KB**，codeload 可取，带 `manifest.json` + `styles.css`，MIT。P4-006b 后依赖随包内联，产物涨到 548725 B（含随包的 `@codemirror/{state,view,language}` 与其 `@lezer`/`style-mod`/`w3c-keyname` 传递依赖），仍以同一份源码 + vendored 依赖离线可重建。
- 不新增依赖：本机已有 esbuild 0.24.2 与 `@codemirror/*`（`tools/workspace-bundle/node_modules` vendored）。

被否的候选：**`artisticat1/obsidian-latex-suite`**。它的 `package.json` `postinstall` 会执行 `npm run generator:latex`（`jiti` + `lezer-generator` 现生成 lezer 语法解析器），意味着构建前必须先跑代码生成，再装上完整工具链；一旦上游生成脚本或工具链版本漂移，夹具就不再"可重复拉取 + 构建"。不符合本轨对夹具的要求，故否。

## Markdown 后处理器是怎么挑的

阅读视图这一品类必须真的调 `registerMarkdownPostProcessor`，所以先取源码 grep 再决定，不看 README 宣传：

```bash
curl -sL https://api.github.com/repos/<owner>/<repo>/commits/HEAD  # 取 head sha（github.com 不通，api.github.com 通）
curl -sL https://codeload.github.com/<owner>/<repo>/zip/<sha>      # 取源码
```

| 候选 | 源码里的真实命中 | 结论 |
| --- | --- | --- |
| `obsidian-tasks-group/obsidian-tasks` @ `83f54fbba0c6` | `src/Obsidian/InlineRenderer.ts:31` → `plugin.registerMarkdownPostProcessor((el, ctx) => {` | **选中**：唯一真在阅读视图里挂后处理器，并且把 ctx 用全了 |
| `blacksmithgu/obsidian-dataview` @ `5ad0994ff384` | `src/main.ts:200` → `let registered = this.registerMarkdownPostProcessor(processor);` | 次选，未用：命中更浅（后处理器在 `processor` 里，阅读视图面被它自己的查询引擎盖住） |
| `platers/obsidian-linter` | —— | 否：它是编辑器侧（保存时改写文本），不是渲染后处理器，覆盖不到阅读视图 |

grep 时注意：这两个仓库都自带 sample vault，里面塞着别的插件**压缩过的 main.js**，直接 `Select-String` 会吐出一整行几 MB 的垃圾。按 `Length -lt 2e6` 过滤并截断输出，才看得出真正的源码命中。

它把后处理器上下文用到了这个程度（源码位置来自缓存树 `.fixtures-out/.cache/markdown-postprocessor-tasks/src/`）：

| 调用 | 位置 |
| --- | --- |
| `plugin.registerMarkdownPostProcessor((el, ctx) => {` | `src/Obsidian/InlineRenderer.ts:31` |
| `plugin.app.workspace.onLayoutReady(async () => {` | `src/Obsidian/InlineRenderer.ts:32` |
| `const childComponent = new MarkdownRenderChild(element);` | `src/Obsidian/InlineRenderer.ts:47` |
| `context.addChild(childComponent);` | `src/Obsidian/InlineRenderer.ts:48` |
| `element.findAll('.task-list-item')` | `src/Obsidian/InlineRenderer.ts:50` |
| `const path = context.sourcePath;` | `src/Obsidian/InlineRenderer.ts:82` |
| `this.app.vault.getFileByPath(path)` | `src/Obsidian/InlineRenderer.ts:83` |
| `const section = context.getSectionInfo(element);` | `src/Obsidian/InlineRenderer.ts:86` |
| `MarkdownRenderer.render…` | `src/Renderer/QueryRenderer.ts:136`、`src/Renderer/TaskLineRenderer.ts:85`/`:94`、`src/ui/QuickSearchTasksModal.ts:134` |
| `setIcon(…)` | `src/Config/SettingsTab.ts:157`/`:352`/`:546`、`src/Config/PresetsSettingsUI.ts:103` |

对照 `tools/contract/symbols.json`：`MarkdownPostProcessor`、`MarkdownPostProcessorContext` 是 `unsupported`/`needs-architecture`（宿主侧 `registerMarkdownPostProcessor` 只 `console.warn`）；`MarkdownRenderChild` 是 `partial`（`containerEl` 是桩）；`MarkdownRenderer` 是 `stub`（`render` 直接 reject）；`setIcon` 是 `stub`/`low-risk`（空函数）。所以这份产物是 M2 阅读视图**最好的输入契约**：它把"后处理器要拿到什么"写死在代码里。逐条清单见 `api-surface.report.md` 第 5、6 节。

依赖与产物：10 个运行时依赖（`@floating-ui/dom`、`boon-js`、`chrono-node 2.3.9`、`eventemitter2`、`flatpickr`、`i18next`、`mustache`、`mustache-validator`、`rrule`、`safe-regex2`）全部内联进 `main.js`，所以产物 1.03 MB。上游 `external` 列了 17 个模块（`obsidian`、`electron`、`codemirror`、`@codemirror/{autocomplete,closebrackets,commands,fold,gutter,history,language,rangeset,rectangular-selection,search,state,stream-parser,text,view}`），但产物里**实际只剩两条 `require`**：`require("obsidian")` 与 `require("@codemirror/view")`——没被引用的 external 不会生成 `require`。另外它调用了 43 次 `window.moment(...)` 却**没有**内联 moment、也没有 `require("moment")`，即依赖宿主注入全局 `window.moment`（已记在 lock 的 `build.hostGlobals`）。

## 主题怎么被宿主加载（现状：这就是缺口）

CSS 不需要构建：Obsidian 侧主题 = 一份 `styles.css` + 一份 `manifest.json`。注意 `kepano/obsidian-minimal` 的 manifest **没有 `id` 字段**，只有 `name: Minimal` / `version: 9.1.4` / `minAppVersion: 1.14.0`——主题的标识来自目录名，不是 manifest id，宿主解析时不能强求 `id`。

LexiNote 当前基线只有一份 CSS：`entry/src/main/resources/rawfile/plugins/lexi-sample-plugin/styles.css`（1101 B），**且只注入单个视图槽**，没有主题级注入点。实测宿主侧 token 命中：`--background-primary` 10 处、`--text-normal` 12 处、`--font-text*` 4 处、`--radius*` 6 处、`theme-dark`/`theme-light` 各 2 处；而 `.cm-editor`、`.workspace-leaf`、`.markdown-preview-view`、`.markdown-rendered`、`--color-accent` 全是 0 处。所以 Minimal 这份 505 KB 的主题拿到 LexiNote 上会大面积失效——这不是夹具的问题，是宿主缺变量层与 DOM 类名层（详见 `api-surface.report.md` 第 4 节）。

## API 使用面报告

`node tools/plugins-fixtures/api-surface.cjs`（拉取脚本跑完会自动调它），产出：

- `api-surface.report.md` / `api-surface.report.json`：每个夹具的契约符号 top 15、调用点标记全量表、主题 CSS 契约表、跨夹具缺口排名 top 10。
- 第 5 节是**阅读视图契约（M2 输入）**：`registerMarkdownPostProcessor` 链路的每个符号 → status/gap/产物命中次数/源码 `文件:行`，包含矩阵没收录的三条（`element.findAll(`、`vault.getFileByPath(`、`workspace.onLayoutReady(`）。
- 第 6 节是**每个夹具用到的 unsupported/stub 清单**，第 7 节是**依赖树与外置项**（谁要 `@codemirror/*` 实例、谁要 `window.moment`）。
- 同名噪声被剔除：`Array`/`String`/`Tasks` 这类标识符在压缩产物里出现几百次但没有一次是调宿主 API，第 6 节与第 8 节都按黑名单跳过，判据以「调用点」精确正则为淮。
- 三类输入统一 join `tools/contract/symbols.json`（`obsidian@1.14.4`，334 条）的 `status` / `gap`。
- `@codemirror/*` 那一族在 `obsidian.d.ts` 里根本不存在，矩阵没有对应符号，报告把它们标成"（d.ts 之外）"，自带 `unsupported` / `needs-architecture`。
- 计数口径是近似：契约符号按同名标识符计数（局部变量同名会高估），调用点标记是精确正则。排序看同名计数，判定缺口看调用点标记。

## 踩过的坑（都已解决，复跑不会再遇到）

1. **calendar 的 `obsidian` 依赖是 GitHub git 依赖**：`npm install` 直接卡在 `github.com:443`。改成 npm 的 `obsidian@1.14.4`（patch 1）。
2. **rollup 报 `Unexpected token src/main.ts (1:12) import type`**：不是 TS 版本问题，是 `@rollup/pluginutils@3.1.0` + `picomatch@2.3.2` 对 `+(|x)` extglob 失配，导致 `@rollup/plugin-typescript` 的 `transform` 一次都没被调用。用 node 探针把 `createFilter` 单独测出来才能确诊（`**/*.ts+(|x)` → false，`**/*.ts` → true），然后显式传 include（patch 2）。
3. **outliner 装依赖会挂在 husky `prepare`**：解压树里没有 `.git`，husky 直接失败。夹具不装它的依赖，改用本机 esbuild。
4. **outliner 产物需要两个编译期全局量**：`PLUGIN_VERSION`、`CHANGELOG_MD`（它原配置用 `@rollup/plugin-replace` 注入），esbuild 侧用 `--define`，值从源码树的 `package.json:version` 与 `CHANGELOG.md` 现取，避免手写版本号漂移。
5. **calendar 的 `npm run build` 会先跑 lint**：`svelte-check` + `eslint` 与产物无关却最容易失败。夹具直接调 rollup，不经过它的 build 脚本。
6. **outliner 用了 `obsidian.d.ts` 里没有的 API**：整套 `@codemirror/{state,view,language}`（`Decoration`、`ViewPlugin`、`StateField`、`EditorState`、`EditorView`）在 d.ts 里都不存在，契约矩阵也没有对应符号。报告里这类行标"（d.ts 之外）"，并统一按 `unsupported` / `needs-architecture` 处理——这正是编辑器增强型的核心缺口。
7. **主题 manifest 没有 `id` 字段**：`obsidian-minimal` 的 manifest 只有 `name/version/minAppVersion`，宿主若强校验 `id` 会把主题判成非法。
8. **tasks 装依赖报 `ERESOLVE`**：`npm error peerOptional typescript@"^5" from i18next@24.2.3` 与上游 `typescript ^6.0.3` 冲突。它是 `peerOptional`（不影响运行时产物），所以只加 `--legacy-peer-deps`，不降级任何依赖——降级会改变产物字节。
9. **`--update-lock` 会重写整个 lock**（缩进 4→8 空格、字段顺序重排）。所以"先跑 `--update-lock`、再手工补字段"的顺序有坑：手工补之前必须重新读文件、按实际缩进匹配，否则报 `old_string was not found`。
10. **压缩产物里 `new MarkdownRenderChild(` 搜不到**：esbuild 把标识符重命名成 `new sP.MarkdownRenderChild(t)`，前置的 `new ` 匹配会失败。统计标记必须用 `\bMarkdownRenderChild\b` 这种"只认标识符"的写法，否则会把真实命中数报成 0。

## 许可与不进库约定

- 四件全是 MIT，作者见上表；`LICENSE` 留在各自上游仓库，**未复制进本仓库**。
- 第三方源码、构建产物、源码缓存一律只在 `.fixtures-out/`（`gitignore` 第 29 行 `/.fixtures-out/`）。仓库里能提交的只有 `tools/plugins-fixtures/**`（lock + 报告 + 本文件 + `api-surface.cjs`）与 `scripts/tests/plugin-fixtures-fetch.cjs`。
- 换成别的夹具时同样只加 lock 条目，不往仓库里放代码。

## 明确边界：这四件套现在还跑不通

运行时轨未完成，本轨只交付**可构建、可拉取、可统计**的夹具。真正的断点（都不是夹具能补的）：

- 视图型：`ItemView`/`View` 在契约矩阵里是 `partial`/`needs-architecture`，`WorkspaceLeaf` 是 `stub`——`registerView`+`getLeaf('tab')`+`setViewState` 这条链路宿主还没实现。
- 编辑器增强型：宿主没有把真实 `@codemirror/view`/`state` 实例交给插件，`registerEditorExtension` 注册进去的 `ViewPlugin`/`StateField`/`Decoration` 无处挂载。
- Markdown 后处理器（阅读视图）：宿主的 `registerMarkdownPostProcessor` 只 `console.warn`、`MarkdownPostProcessorContext` 是 `unsupported`，所以 tasks 的后处理器连第一次调用都拿不到；就算挂上，`MarkdownRenderer.render` 会 reject、`MarkdownRenderChild.containerEl` 是桩、`window.moment` 也没人注入。
- 主题：宿主缺 `--background-primary` 等变量层与 `.markdown-preview-view` 等 DOM 类名层，CSS 进来会大面积不生效。

所以本目录下任何"构建成功"都不等于"插件在设备上可运行"。
