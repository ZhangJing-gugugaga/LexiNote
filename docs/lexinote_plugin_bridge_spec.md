# 插件底座改造 · 桥协议与文件归属（v1，实施依据）

> **身份缺口状态（评审口径）：** `net.requestUrl` 的身份投递静态审计曾报告 0 gaps，但这不能单独证明权限判定不依赖 payload 身份。桥接规范 §13、§17.3 所述身份绑定及伪造身份负向验证按未关闭处理；需复核当前实现并取得对应证据后再更新结论。


目标：把 LexiNote 插件底座重做为 Obsidian 等价底座。A 轨=编辑器与工作区进常驻 ArkWeb 页，插件与宿主 UI 共享同一 DOM；原生编辑器保留为降级兜底。C 轨（声明式原生插件）本轮不实施，只在 manifest 留位置。

## 1. 组件与文件归属（并行开发不重叠的边界）

| 区域 | 归属 | 文件 |
|---|---|---|
| 契约与矩阵 | 契约轨 | tools/contract/**、scripts/tests/plugin-contract-matrix.cjs |
| 工作区宿主页 + CM6 打包 + Web 侧运行时 | 宿主轨 | tools/workspace-bundle/**、entry/src/main/resources/rawfile/lexinote_workspace.{html,js}、rawfile/lexinote_workspace_shim.js、entry/src/main/ets/workspace/** |
| 原 RPC/Runtime/身份/事件（阶段二起接管新工作区容器） | 运行时轨 | entry/src/main/ets/core/plugin/**、rawfile/lexinote_plugin_shim.js、rawfile/lexinote_plugin_view_shim.js（阶段二；view_shim 是 DOM 助手与 CM6 能力真正所在，其符号 owner 记为运行时轨） |
| 分发与审核 | 分发轨 | LexiPluginManifest.ets、LexiPluginInstaller.ets、LexiPluginMarketModel.ets、exports/**、scripts/tests/plugin-dist-*.cjs |

## 2. 桥协议 v1（目标态；现状见本节末差异表）

通道：ArkWeb 的 WebMessagePort 双向异步通道为主；javaScriptProxy 仅保留一个握手方法 __lexiHandshake()，其余一律走端口帧（避免字符串 eval 与同步阻塞）。

帧格式（JSON 文本）：
- 请求 `{v:1, id:<string>, token:<string>, method:<string>, payload:<object|string>}`
- 应答 `{v:1, id, ok:true, data}` / `{v:1, id, ok:false, error:{code,message}}`
- 事件 `{v:1, type:'event', topic, payload}`（宿主 → Web，单向）
- 批量：一帧可带 `calls:[{id,method,payload}]`，单批上限 64，宿主按序回复各自 id。

端口必须成对用：`controller.createWebMessagePorts()` 返回的是 **entangled pair**——`postMessage(tag,[ports[0]])` 把 ports[0] 交给页面，宿主只在 **ports[1]** 上 `onMessageEvent`/`postMessageEvent`。两侧误用同一端口的现象是页面→宿主帧被静默丢弃（页面永久卡在「等待握手」，hilog 里连 channel.frame.in 都没有），极难排查，已踩过一次。

身份：宿主在装载插件时为每个 pluginId 生成一枚 sessionToken，只在 Web 侧构造 facade 时闭包捕获，不挂到任何全局对象上；facade 发出的每帧自动带 token。宿主按 token 反查 pluginId，**payload 里出现的 pluginId 一律忽略**。token 随插件卸载立即失效。

超时：单次调用 20s（load.plugin 同额），超时回 error.code=timeout 且不影响后续调用。

现状差异（阶段二落地前，契约矩阵里相关符号一律记 partial，不得记 implemented）：现状是 javaScriptProxy 单入口 `window.lexiHost.call(callId, method, raw)` 三参、无 token、无批量、无超时帧语义，事件用 `method==='event'` 走同一入口（lexinote_plugin_shim.js:648 附近动态分派）。本节的 v1 帧格式是阶段二的验收目标，不是既有实现。

## 3. 单实例容器语义（修掉现状的结构性缺陷）

- 一个 Web 页 = 一个插件运行时；插件类只实例化一次，缓存 key=`<id>@<version>`。
- 视图与代码块只接受 `render(el, ctx)`：宿主给 DOM 容器，插件往里画；**禁止**在槽位里重新 eval 插件源码。
- plugin 对象单例；ctx 每视图新建（轻量视图上下文）。
- 任一插件 onload 抛错 → 该插件进 broken 状态，其余插件不受影响（现状已有，保留）。

## 4. 目录与版本

- 安装布局：`files/plugins/<id>/{manifest.json,main.js,styles.css,data.json}`；data.json 单例，升级保留。
- 版本布局：`files/plugins/.versions/<id>/<version>/` + `current.json` 指针；卸载=删目录，回滚=切指针，均为原子操作。

## 5. manifest v2

必填 `id,name,version,minApiVersion,author`；新增 `capabilities:{network:[<host>],fs:boolean,clipboard:boolean}`、`sha256`（包哈希，由安装器写入）、`isMobileSupported`（替代 isDesktopOnly）。旧 `isDesktopOnly` 读入时映射，写出时不保留。

`minApiVersion` 语义先钉死：它指 **LexiNote 插件 API 版本**（当前 `1.0.0`，取自 shim 的 API_VERSION），**不是** Obsidian 版本；宿主只按它做兼容拦截。Obsidian 侧兼容性（本底座对标 1.14.4）由契约矩阵表达，不进 manifest，避免拿 1.14.x 去校验 1.0.0 的宿主而误拒全部插件。`requireApiVersion` 必须真实导出，按同一语义返回布尔。

## 6. 市场索引 v1（单一 schema）

`{schemaVersion:1, plugins:[{id,name,version,author,description,repo,zipUrl,sha256,minApiVersion,capabilities,updatedAt}]}`。客户端与运营侧共用同一份校验（JSON Schema 文件放 exports/ 下，CI 校验 releases 仓库的索引）。`exports/cdn-market.json` 的 ZCode schema 停止使用。

## 7. 契约矩阵 schema

`tools/contract/symbols.json`：`{generatedFrom:'obsidian@1.14.4', symbols:[{symbol,kind,status,owner,note,gap}]}`，status ∈ implemented|partial|stub|unsupported。

Web 侧实现索引的形态（唯一口径，防各轨自建索引漂移）：对 rawfile 下插件 shim 做静态扫描，收集 function 声明、var/const/let 声明、成员赋值（`X.y = ...`）、对象字面量方法键、`window.z = ...` 挂载名，得到名字集合；现状规模 473 名。

证据标记：status=implemented 的 note 必须含 `H:<宿主处理器名>` 或 `W:<索引名>`，且该名字在对应索引里真实存在（门禁逐条核验）。

gap（缺口性质，决定排期，不是装饰）：`low-risk`（纯字符串/YAML/编解码/小工具，宿主已有等价实现，可直接补）| `needs-architecture`（需新架构面：CM6 扩展、Settings 2.0 分组分页、多 pane 布局、Bases 值系统）| `out-of-scope`（本轮明确不做，见 §9）。implemented 条目 gap 必须为 null；partial/stub/unsupported 必须带 gap 且 note 写清「缺什么 / 谁来补」。

判定口径（防各轨各判一套）：

- status 按「最小可信面」定：只要当真能跑通的最小行为面成立就算 partial/stub，不按工作量拍。
- gap 按「要不要动架构」定，与工作量无关：需要新的架构面（编辑器扩展、布局、值系统、DOM 组件库）才是 needs-architecture，纯补充导出/回填的一律 low-risk。
- `out-of-scope` 的 owner 恒为「未排期」，不得写轨名——写轨名会让报表看起来像已排期。
- gap=null 仅属于 implemented；统计时 null 单列，不计入三值分布（报表口径：三值之和 = 334 − implemented）。
- 官方 `@deprecated` 的符号，note 以 `[deprecated]` 开头标注（文档约定，门禁不强制），以便区分「官方不要了」与「我们不做」。

CI 强制：d.ts 里的符号全部有条目；implemented 证据可核验；gap 枚举合法且与 status 自洽；不允许出现无 note 的 stub。

## 8. 验收门禁（全部可本地跑，CI 红灯即停止合入）

1. `node scripts/tests/plugin-channel-audit.cjs` → 死通道 0（现为 7）。

   清零方式只有一种：**在宿主补 handler**。禁止为了让门禁变绿去删 shim 里的调用——死通道里有被真实 UI 依赖的（ui.placeholder 被 Modal.open 与 addStatusBarItem 依赖），删调用等于改可见行为。确实无意义的 API 必须先走矩阵登记 unsupported 并注明替代路径，才允许移出调用面。
2. `node scripts/tests/plugin-contract-matrix.cjs` → 矩阵覆盖 100%，无空注 stub。
3. `node scripts/tests/plugin-dist-audit.cjs` → 索引 schema 校验、sha256 必填、能力声明合法、禁止未声明域名与 eval 动态代码。
4. `hvigorw assembleHap` + `hdc install` + 启动 + 抓日志无插件相关异常（模拟器）。抓日志有硬要求：`hdc shell hilog -x` 事后取基本取不到（环形缓冲区只有数百行、几秒即被冲掉），必须后台 `hdc shell hilog | Out-File <本地文件>` 持续落盘后再读；且必须用 pwsh 调 hdc（bash/MSYS 会改写设备路径）。设备证据要由脚本产出，不能只靠人工截图：见门禁 4b。
4b. `node scripts/tests/workspace-slice-evidence.cjs` → 自动完成 安装→启动→进入工作区页→后台抓日志→按**顺序**校验关键打点（握手/鉴权/装载/单实例/命令/Notice），缺任一步即 exit 1，并把日志与截图落盘到 gitignore 目录。
5. 真实插件三件套跑通：视图型、编辑器增强型、主题各一，业务代码零改动。

## 10. 与三类真实插件的兼容边界（由夹具实测得出，非推测）

夹具见 `tools/plugins-fixtures/manifest.lock.json`（view-calendar @ef3f2696 / editor-outliner @b51918d4 / theme-minimal @93321bdc），产物落 `.fixtures-out/`（gitignore），API 使用面见 `tools/plugins-fixtures/api-surface.report.md`。构建成功 ≠ 设备可运行，当前断点如下，按此排期：

1. **视图型（calendar）**：`registerView + getLeaf('tab') + setViewState` 链路未实现，`ItemView` 只到 partial、`WorkspaceLeaf` 是 stub。宿主必须提供 leaf/视图状态机（openView/closeView/setViewState/getLeavesOfType/getActiveViewOfType），否则任何视图插件都装不上。
2. **编辑器增强型（outliner）**：插件把 `@codemirror/{state,view,language}` 标为 external，运行时要靠宿主的模块注册表解析——**`require('@codemirror/*')` 必须能取到与工作区编辑器同一份 CM6 实例**（同版本 singleton，不能是第二份副本，否则 ViewPlugin 挂不上）。同时 `registerEditorExtension` 要把返回的 Extension 真装进 EditorView。
3. **主题（minimal）**：主题 = `styles.css` + manifest，且 **manifest 没有 id**（id 取目录名，宿主不得强求 id 字段）。Minimal 实测：背景/文字变量 353 处 vs 宿主现有 22、工作区 DOM 类 661 vs 0、Markdown 视图 DOM 类 528 vs 0、编辑器 `.cm-*` 96 vs 26。结论：主题要能用，必须补**两层**——CSS 变量层（`--background-primary`/`--text-normal`/`--font-text*`/`--radius*`/`--color-accent`）与 **DOM 类名层**（`.workspace-leaf`/`.markdown-preview-view`/`.markdown-rendered` 等与 Obsidian 同名的类）。只注入单个视图槽的 styles.css 永远做不成主题。
4. **CM6 符号不在这份契约里**：`Decoration/ViewPlugin/StateField/EditorState/EditorView` 等 d.ts 之外的 API，矩阵覆盖不到。它们的可用性由"模块注册表 + 同实例"保证，不另立矩阵门禁；但任何声称"支持编辑器扩展"的表述，必须以 outliner 零改动跑通为准。
5. **三件套 3/3 共同缺口为 0 条**是口径事实（主题无 main.js），不要把"共同缺口 0"读成"没缺口"；排期看两件/单件缺口与前 10 名。

## 11. 跨上下文与版本一致性（增量裁定）

工作区容器与旧 slot 上下文（plugin_shim / view_shim）曾各自实现同一批 obsidian 符号，由此产生三个必须钉死的口径：

1. **apiVersion 只有一个来源**。现状矛盾：`rawfile/lexinote_plugin_shim.js:24` 是 `var API_VERSION = '1.0.0'`（由宿主注入口径），而 `rawfile/lexinote_plugin_view_shim.js:797` 硬编码 `apiVersion: '1.1.0'`。同一个插件在两个上下文里 `requireApiVersion()` 可能得到不同答案，会直接改变插件分支走向。规则：**任何 shim 的 apiVersion 都不得硬编码**，只能取宿主注入值；发现第二处硬编码即视为门禁红灯（契约轨请把这条加进 `plugin-contract-matrix.cjs`）。与 §5 一致：这里的"版本"是 LexiNote 插件 API 版本，不是 Obsidian 版本。
2. **跨上下文的符号判定口径**：status 以**主上下文（工作区容器 plugin_shim）**为准；某个符号在 view_shim 侧仍是空实现时，不得因此降级 status，但 **note 必须写明差异并带 W: 证据**（例如 view_shim 的 `getLeaf/getMostRecentLeaf` 返回 null、`iterateAllLeaves` 是空函数）。反过来，若某符号**只**在 view_shim 有实现而主上下文没有，按未实现记。
3. **view_shim 的执行面正在退役**（M1-C1）：一旦它不再 eval 第三方源码，其中所有空实现都失去意义；note 里的差异描述届时以"该上下文已退役"替代，不得继续罗列空实现细节误导后来者。

（`DataAdapter`/`FileSystemAdapter` 的 note 另外裁定：类本身仍是 stub（不可构造），但 `vault.adapter` 实例是真实现且被真实插件依赖——note 必须同时说清这两件事，不能只留"无文件系统直访通道"这句半真半假的话。）

## 12. 证据粒度与快照时效（矩阵可信度的两个漏洞）

实测暴露的问题：`W:MiniMoment` 这种容器级标记只能证明"这个对象存在"，不能证明 note 里列的 `calendar/localeData/isoWeekday` 真的在——而 moment 这类"按插件真实调用逐条补"的符号最容易漂移（本轮 shim 实现索引 567→673，就是补 moment 造成的）。**散文 claim 无法被机器校验，就一定会滞后于实现**。两条规则：

1. **覆盖清单（机器可读，替代散文 claim）**：策略符号的 note 必须含一行 `members: a, b, c`（或 `members(excludes): tz, duration` 表示明确不支持）。门禁逐个解析 `members:` 里的名字，**必须在实现索引里存在**（不存在 → 红灯"覆盖清单与实现脱节"）。散文可以照写，但散文不参与判定。
   - 不采用 `W:MiniMoment#calendar` 逐成员标记写进正文：那会把校验耦合进散文，而散文会被随手改；结构化清单不会。
2. **快照时效**：策略符号的 note 必须以 `[截至 YYYY-MM-DD @ <commit7>]` 开头，并在同一行写覆盖的插件清单（例：`覆盖插件: obsidian-calendar-plugin`）。理由：`partial` 是当下快照，不是稳定契约；不标时间与来源，后来者会把两年前的"已通"当现状。
3. **策略符号表**在 `tools/contract/generate.cjs` 里**显式声明**（`NOTE_POLICY`），禁止用"note 里逗号多就算清单型"这类启发式判定。当前策略符号：`moment`、`App`、`Workspace`、`Vault`、`MetadataCache`、`MarkdownView`。新增符号进表时必须同时给出该符号的门禁红灯自证。
4. 两条规则只管 note 的可信度，**不改变 status/gap 的判定口径**（§7）。
5. **新鲜度是流程属性，不是门禁属性**（裁定：不升级为 git 比对）。时效头是手工快照，门禁只证明"格式合规 + 清单与当前实现无脱节"，**证明不了"快照还新鲜"**。拒绝把 `commit7` 与 shim 最后改动 commit 做门禁比对的理由：未提交的实现改动它看不见，CI 与本地结论会不一致，且实现面每轮都在动（本轮实测 shim 实现索引 673→689），门禁会在每个实现提交上变红并被下一个人关掉。
   - 采用的办法：门禁每次打印实现面索引计数（当前 53 处理器 / 689 shim 实现），**dispatcher 在每个里程碑验收时重盖 6 条策略符号的时效头**，并把"时效头未更新"视为验收不通过项。责任落在人（评审者），不落在脚本。
   - 这条是明确的技术债：只要 note 靠人刷新，它就会滞后；把它写在这里，是为了让后来者知道"绿门禁 ≠ 快照新鲜"，而不是误以为矩阵会自我保鲜。

## 9. 本轮明确不做

Bases/Canvas 插件 API、Electron/Node API、多窗 split、付费与分成体系、C 轨声明式 DSL。


## 13. 能力归属与分发信任边界（新增，裁定）

1. **能力判定的身份必须来自会话，不来自 payload**。`net.requestUrl` 现读 `rpcString(request,'pluginId')`（`LexiPluginRuntime.ets:1288`）再 `checkNetworkCapability(this.manifestFor(pluginId), url)`（:1289）——任何插件都能填别人的 id 借用其网络能力，能力声明退化成自述。正确形态：容器在 token→pluginId 处解析身份（M1-B 已建立，证据 `frame.identity claimed=forged-identity ignored=true`），把**可信 pluginId 作为参数**传入能力判定，payload 里的 pluginId 一律忽略。验收要负向证据：插件 A（未声明网络）发送 `pluginId=B`（已声明）→ 必须 `capability_denied`。`fsGate`（:870）同一处毛病，同一标准。
2. **v1 清单的能力默认值**：Obsidian 当前没有能力模型，存量 v1 插件无 `capabilities` 字段。规则固定为——网络 **fail-closed**（v1 也拒，除非声明）；文件系统与剪贴板对 v1 放行、对 v2 严格，且每次放行必须落一行日志（可审计，不是静默）。这条是兼容性让步，不是安全模型，写在这里防止后来者当成设计。
3. **市场索引 schema 的落点**：`/exports/` 在 .gitignore:25 里，schema 放那儿等于不入库；正典放 `tools/plugin-dist/market-index-v1.schema.json` + `market-index-v1.cjs`（唯一实现），`exports/market-index-v1.json` 只是生成产物。ArkTS 侧解析必须与 Node 侧逐条对齐，回归里要有「两侧结果一致」的断言——历史上正是两侧不一致让 52 条变 0 条。
4. **release 产物不得含第三方代码**：`tools/plugin-dist/release-gate.cjs` 当前如实红（HAP 141 条目中 8 处 + 资源目录 3 处违规）。红线固定在 CI 顺序：stage 夹具 → 跑各门禁 → build → release-gate 必须 0 → 发布前 `--strip --apply`。`--strip-staging` 尚未真跑过，属未验证路径。


## 14. 主题验证后的两个结构性结论（新增，裁定）

1. **宿主基础层仍有 ID 特异性，主题对"整个应用"的覆盖只到编辑面板**。`lexinote_theme.css:444-519` 用 `#palette`/`#notices`/`#boot-error`（1,0,0）承载命令面板、通知与启动错误——而 Minimal 里对应的选择器是 `.prompt`/`.prompt-input`/`.suggestion-container`/`.notice`/`.modal-container`（类，0,1,0），既类名不存在、特异性又高于主题，一律落空。修法固定为两层：给这些节点补 Obsidian 同名类，并把宿主样式从 ID 降级为类；门禁要断言"主题开关时命令面板与 Notice 的计算色变化"。在此之前，任何"主题已全量生效"的说法都不成立。
2. **容器没有阅读视图，Markdown 后处理插件品类整体不可用**。证据：`lexinote_plugin_shim.js:1592-1593` 的 `registerMarkdownPostProcessor` 只 `console.warn`；`.markdown-preview-view` 仅出现在旧视图槽的 `shim.js:2253` 类名串里，没有真实的预览渲染路径。这意味着 Obsidian 里最高频的一类插件（Dataview、Charts 渲染、任务美化等）在 LexiNote 上无处挂载，Minimal 里 262 处预览类规则也全部落空。这是 M2 的首位缺口，不是主题轨的问题。
3. **主题轨道验收口径**：18/18 断言 + 两张截图平均色差 > 8 为通过线；变量覆盖允许有未定义项，但必须逐条打印（当前 224 引用 / 203 定义 / 21 未定义）。缺失项靠"塞假节点让计数好看"来消除的一律不接受。

## 15. 门禁自身的诚实性（新增，裁定；四条都已落地）

这一节记录的是**门禁骗过我们四次**之后定下的规则。它们与插件质量无关，与"我们凭什么相信自己绿了"有关。

1. **禁止黑名单，只允许白名单**。`release-gate.cjs:38` 原是 `FORBIDDEN_PLUGINS = ['calendar','editor-outliner','compat-probe']`（3 个 id），而 `rawfile/plugins/` 已有 6 个目录——运行时轨新加的 `cap-probe-open`/`cap-probe-unauth` 共 4 个 HAP 条目随包发出，门禁照样报 8 处。黑名单永远比现实慢一步。现为 `ALLOWED_SHIPPING = ['lexi-sample-plugin']` + `forbiddenStagedDirs()` 作为扫描/`--strip`/`--strip-staging` 的唯一判定；修后同一 HAP 报 17 处。**任何"禁止清单"形式的门禁都按此条驳回。**
2. **断言只认单一正典形态，禁止"两种都算"**。`plugin-dist-regression.cjs` 曾把 `/\.fsGate\((?:request|identity)\)/` 放宽成两形态都认，理由是"接受更好的实现"，实际后果是半途回退（2 处 request + 4 处 identity）照样绿。现为两条独立断言：`fsGate(identity)` ≥6 且 `fsGate(request)` ==0。**当实现改进了，改断言而不是放宽断言。**
3. **修复类命令的退出码必须反映修复后的产物**。`--strip --apply` 曾成功写出 `*.stripped.hap` 却仍 exit 1（拿源包违规数当结论），CI 里"修成功"与"修失败"同码。现为写后自动重扫、以重扫结果定退出码（`report.strippedClean`），源包违规降级为信息行；预演模式仍 exit 1。
4. **恒红必须能区分"已知夹具"与"真漏"**。默认模式必红的前提是"红=有夹具"，一旦真漏一个目录，它和 5 个夹具长得一样。现由 `classifyStagedDirs()` 用 `git check-ignore` 二分：已知夹具 5 处 / 未登记目录 0 处；未登记项打印"准事故"并单独使 gate 失败。git 不可用时 `isGitIgnored()` fail-closed（视为未忽略）。
5. **CI 顺序必须是可执行入口，不是散文**：`release-gate.cjs --ci` 三步——① stage 分类（未登记必须 0）② 5 道依赖夹具门禁（channel-audit / contract-matrix / dist-audit --all / dist-regression / market-regression）③ 剥离自检（复制 HAP 到临时目录、strip、重扫须 0 违规）。实测 7/7 exit 0；造一个未登记目录 → 1/7 exit 1。人工等价顺序写在 `tools/plugin-dist/README.md`。
6. **孤儿集合必须受祝福，自动扩容即红**（2026-11-02 追加，落点 `scripts/tests/plugin-route-coverage.cjs` 的 `BLESSED_ORPHANS`）。判据本身会反向放水：orphan-retained 的定义就是「处理器存在但没有调用方」，于是**谁删掉一个带令牌的调用点，对应处理器就静默降级成「保留能力、不计入缺口」**，门禁照绿而 API 悄悄死了——这是黑名单滞后同一个病，方向相反。现为显式常量 + `orphan-retained: N (blessed: M)` 固定打印：多出成员报「未登记的孤儿（疑似调用点被删 → 能力静默失效）」，成员消失报「受祝福孤儿已接线（必须带令牌并删除登记）」，两个方向都 exit 1。与 `plugin-identity-delivery` 互补：后者管「有调用点但没带令牌」，前者管「调用点没了、能力静默死亡」，只用其中一个都能被绕过（红灯实测：删 `ui.removeRibbon` 的唯一调用点，identity-delivery 站点 22→21 仍 PASS、exit 0）。
7. **仍未验证的一格**：`--strip-staging --apply`（把真实 `rawfile/plugins/` 目录 renameSync 进 `.fixtures-out/strip-trash/`）从未真跑。它是 release 链上唯一空白，设备轮到分发轨时执行一次受控运行（搬走 → build → gate clean → 搬回），并要求 rawfile 恢复 6 个目录的证据。

## 16. 门禁必须跑产品路由（新增，裁定；2026-11-02）

**结论先说：M1-A..D 五组门禁全绿，绿的是一条用户点不到的路由；而产品实际装载插件的路由当时完全不通，任何插件（含内置 `lexi-sample-plugin`）都装不活。**

事实（逐条可复核）：

1. **产品路由 = 旧 `LexiPluginRuntimeHost`**。`entry/src/main/ets/pages/Index.ets:1298` 在主 Stack 里常驻挂载 `LexiPluginRuntimeHost()`（注释：应用级单例，手机/桌面全形态生效），其 `Web` 指向 `rawfile/lexinote_plugin_runtime.html`，该 html `:6` 只引 `lexinote_plugin_shim.js`；`LexiPluginRuntimeHost.ets:34-39` 的 `javaScriptProxy({object: manager.runtime, name:'lexiHost', methodList:['call']})` —— **这条路由没有任何令牌铸造点**。
2. **工作区容器是实验入口**。`LexiWorkspacePage` 只从 `LexiSettingsWindow.ets:246-252` 的「插件工作区（实验）」按钮 `.id('plugin-workspace-entry')` 进入；五组门禁的 uitest 点的就是这个实验入口。
3. **一次真实安装在 hilog 里的分布**：`LexiWorkspace` 标签 0 行、`A01051/LexiPlugin` 39 行 + `ARKWEB-CONSOLE` 报 `onload error` → 容器页面全程未参与。
4. **断点**：`LexiPluginRuntime.ets:1473-1482` 组装 `load.plugin` 的 payload 只有 `{id, manifest, size}`（源码其实已 `readTextFile` 进 `pluginSources`，:1470-1471），没有 token；shim `:2174 sourceToken = message.token`（空）→ `:2176 hostCall('plugin.sourceChunk', ...)` 省略第三参 → 回落 `currentToken()` = 会话令牌 `''`（`WorkspaceBridge.ets:60 SESSION_PLUGIN_ID=''`）→ 宿主 `:870-872 pluginSources.get(identity) || ''` 取到空串 → `throw '插件源码读取失败'`。hilog `.fixtures-out/evidence/20261102-063810/flows/install/hilog.log`:23642 源码就绪 6978 字符、:23726 与 :15674（内置）同错。

据此定三条规则：

1. **任何插件装载/执行类门禁，断言名里必须写明它跑的是哪条路由**（`[route:product]` / `[route:container]`）。跑实验入口的绿灯不得当作产品可用性的证据。
2. **产品路由必须有独立门禁**（`scripts/tests/product-route-evidence.cjs` 或同等物）：不点 `plugin-workspace-entry`，冷启 → 安装一个插件 → 断言 `onload.done` 出现且 `onload.error` 为 0 → 命令可见。它和 `workspace-slice-evidence`（跑容器）必须是两个文件，否则红了分不清哪条路。
3. **M2 的交付定义里必须包含「把产品路由切到容器」**。否则容器侧所有工作（单实例、CM6、事件、主题）在出货应用里都是死代码。在此之前，容器门禁的价值是「未来路由已就绪」，不是「现在可用」。

配套（下轮交）：静态门禁 `scripts/tests/plugin-identity-delivery.cjs` —— 凡 `registerHandler` 回调带 identity 第二参的处理器，其调用方必须有可追到 `message.token` 或 bridge 铸造点的显式令牌表达式；第三参省略后静默回落会话令牌的形态必须被判红（这正是本次 bug 的真实形态，不是「少写一个参数」）。
## 17. M2 交付定义（裁定；2026-11-02）——路由切换 + 阅读视图

§16 第 3 条说「M2 必须含切路由」，这一节把它展开成可验收的定义。M2 只交付两条主轨加一条收口，不做 Bases/Canvas/多窗/付费。

### 17.1 M2-A：默认打开笔记的路由切到工作区容器

- 现状：打开笔记走 ArkUI 页（`entry/src/main/ets/pages/NoteEditorPage.ets:54` 的 `struct NoteEditorPage`，入口在 `:30`），容器页只能从 `LexiSettingsWindow.ets:246-252` 的实验入口进。
- 目标：从笔记列表/卡片打开笔记 = 进容器页；容器必须支持按文件路径装载文档并有返回栈。ArkUI 编辑器保留为降级开关（设置项「用 ArkUI 编辑器打开笔记」，默认关），这是用户已拍板的兜底。
- 硬约束：①切换后插件装载仍走身份化路径（令牌由容器 mint，禁止在页面侧自填 pluginId）；②不得删旧路由门禁——`product-route-evidence.cjs` 改为断言新路由，同时保留旧路由用例并标 `[route:product:fallback]`；③门禁必须用 uitest 真点击从列表进笔记，禁止直接 `pushUrl` 到页面（否则又变成验证一条用户点不到的路）。
- 验收：①`[route:product]` 冷启 → 从列表打开一篇已有笔记 → 容器内可见内容 → 插件 `onload.done` 且 `onload.error` = 0 → 命令可见；②`[route:product:fallback]` 打开降级开关 → 仍能编辑保存且插件在旧路由装载成功；③返回栈不丢未保存改动（dirty 保护）；④新建/重命名/删除后列表与容器状态一致。

### 17.2 M2-B：阅读视图 + 后处理真实现

- 渲染：markdown-it（≈96KB）打进 `rawfile/lexinote_reading_*.js`，独立 DOM 而非 CM6 只读；骨架 `.markdown-preview-view > .markdown-preview-sizer > .markdown-rendered > .markdown-preview-section[data-heading-level]`。
- 契约：`registerMarkdownPostProcessor(handler, sortOrder)` 真注册并执行，ctx 提供 `el/getSectionInfo/sourcePath/frontmatter/addChild`；`MarkdownRenderChild` 是真类（`containerEl` 为真节点、有 load/unload 生命周期）；`MarkdownRenderer.render(app, markdown, el, sourcePath, component)` 真实现（现状是直接 reject）。
- 验收物：`obsidian-tasks` 夹具零改动跑通（它用到 registerMarkdownPostProcessor / workspace.onLayoutReady / new MarkdownRenderChild / context.addChild / element.findAll / sourcePath / getSectionInfo / MarkdownRenderer.render）。断言：任务行渲染成带 checkbox 的结构、点 checkbox 回写源文件、第三方插件异常数 = 0（沿用 `exceptions must be 0` 口径）。
- 增量：section 级重渲染并与 metadataCache 的 `changed` 对齐——改一行只重渲染该 section，全量重渲染视为未通过（否则大文档每次编辑都整篇重排）。

### 17.3 收口项（M2 出口门槛）

1. `plugin-identity-delivery --strict` exit 0（known gaps 0；当前剩 `net.requestUrl` 一条）。
2. `net.requestUrl` 身份化 + `capability.net` 日志 + 未声明能力拒绝，单独一轮验收。
3. 主题第三轮（`.menu`/`.modal` 内层结构 + `is-mobile`）不阻塞 A/B，但出口前要么关掉内层结构缺口，要么写进 `tools/plugin-dist/known-issues.md`。
4. 孤儿集合受祝福机制（§15 第 6 条）：`BLESSED_ORPHANS` 双向不一致都 exit 1，理由写死——orphan 的判据就是「没有调用方」，自动扩容会把「能力死亡」读成「能力从未存在」。

### 17.4 不做与风险

- 不做：Bases、Canvas、多窗 split、付费分成、C 轨 DSL、Electron/Node。
- 风险一：容器接管默认打开路径后，若 CM6 在长文档/中文输入上退化，回退开关（设置项「用 ArkUI 编辑器打开笔记」，`arkuiEditorOpen`）是唯一安全阀。**M2-A 已于 2026-11-02 上线**（`Index.ets:429-445`），而拼音组合态人工确认仍未验——这条从「上线前置」降级为「出口前必过」，在此登记为欠账，不许被当成已完成。
- 风险二：阅读视图引入第二个渲染器，与编辑器的滚动同步/锚点可能错位；验收只认 tasks 夹具的真实交互，不认截图。

### 17.5 已知缺口登记（M2-A 出口时点）

1. `product-route-evidence.cjs` C8 要求「所有 `reason=edit` 的写回都落在本次打开的 path 上」。当前模型（容器内一次只装一篇、无切笔记入口）成立；**将来支持容器内切笔记并在切换时 flush 上一篇，必须改成按 noteId 分段锚定**，否则正确行为会被判红。
2. C9 只焊 `[note.route] noteId` ↔ `[note.open.initial] noteId`，**不焊 id→path 映射**：若 `vault.fileForNoteId` 把 id 映射到错的 path，两侧 id 一致仍会全绿。要闭合需在 `note.open.initial` 里带一个独立校验源（标题/首行 hash），未做。
3. 容器内无切笔记入口（D1 不做）：切笔记必须先回列表；`note.open.conflict` 保留本地版本，外部改动后再打开看不到新内容。
4. 宽屏路由已交付（2026-11-02 run10：`scripts/tests/wide-open-choice.cjs` 58/58，静态 22 + 设备 36）：`wideOpenTarget` 取 `''/'container'/'arkui'`，`Index.ets:456-464 requestNoteOpen` 在 `arkuiEditorOpen || wideOpenTarget==='arkui'` 时打 `target=arkui ... reason=wide-tab` 并 `return false` 由桌面就地开标签，`container` 直接进容器，其余弹一次询问后落盘。两条**有意豁免**（不是缺陷，改它们要单独下单）：① 恢复上次会话走 `LexiDesktopWorkspace.ets:178-180` 的 `openDocument(recent.id,false)`，不询问也不经 `requestNoteOpen`——会话恢复不是用户点击；② 弹窗取消（`Index.ets:475-481` `catch { return; }`）不落盘、不路由、下次点击重新询问，该路径仅读码，未在设备实测。
5. 门禁自身的「命中/未命中」文案必须可区分：`wide-open-choice.cjs:167` 曾让 36 条 pass 里有 7 条 detail 写着「hilog 缺少 …」（helper 恒存失败文案），读日志的人会把它当失败。凡门禁输出，绿行必须能一眼看出命中了哪一行。
### 17.6 插件兼容级别（`minAppVersion` 的语义修正）

**问题**：`LexiPluginManifest.ets:42` 的 `APP_VERSION = '1.1.0'` 是我们的产品版本号，而 manifest 里的 `minAppVersion` 是**插件要求的 Obsidian 版本**。拿 1.13.1 比 1.1.0 会拒绝 obsidian-tasks 8.6.0 这类所有现代插件，且发生在读 `main.js` 之前（`LexiPluginRuntime.ets:1544` 提前 `return false`），设备上表现为「连装都装不了」，与真实兼容性毫无关系。

**决策**（2026-11-02，用户不可达时按 G8 以假设推进，见下「如何推翻」）：

1. 引入 `OBSIDIAN_API_COMPAT = '1.14.4'`，语义是「本应用模拟到 Obsidian 1.14.4 的 API 面」，取值基线是仓库契约 `obsidian.d.ts` 的版本，不是为了让某个插件过线而挑的魔法值。
2. `manifestCompatible()` 用 `minAppVersion` 比 `OBSIDIAN_API_COMPAT`；高于它仍拒绝，文案同时给出两侧版本（「本应用模拟 Obsidian API 1.14.4，该插件要求 1.15.0」）。
3. 声明与实现不一致时的处置：宁可声明后**运行期暴露缺口**（`plugin.onload.error` + 缺口表），不用版本号假装兼容。已登记的缺口以 `tools/contract/symbols.json` 与 `gap-report.md` 为准。
4. 已知会因此放行的插件：`obsidian-tasks` 8.6.0（`minAppVersion 1.13.1`）。版本闸门修完后，失败点必须**向后移动**——2026-11-02 真机已验证后移：`hilog 37285 插件源码就绪 1050842 字符`（连 main.js 都读了），随后停在 `插件沙箱不支持模块: @codemirror/view`（§17.7）。**注意 `EditorSuggest` 只是 jsdom 阶梯里的失败点，不是真机的**：真机根本没走到那里，把两者当同一条链排期是错的。

**如何推翻**：若后续认定不应「模拟 Obsidian 版本」，替代方案是给 manifest 增加独立的 `lexinoteApiLevel` 字段并在市场侧转换；届时 `OBSIDIAN_API_COMPAT` 降级为该字段缺省时的回退值，并对已装插件重算一次兼容结论（不许静默改判）。

### 17.7 模块解析闸门（`@codemirror/*` 等宿主提供的模块）

**真机事实**（2026-11-02，`obsidian-tasks` 8.6.0 跑在 127.0.0.1:5555）：

- 版本闸门放行后，宿主读到插件源码：`hilog 37285 插件源码就绪: obsidian-tasks-plugin 1050842 字符`。
- 随后死在模块解析，而不是缺失 API：`hilog 38760 [CONSOLE:2298] "[lexinote] onload error Error: 插件沙箱不支持模块: @codemirror/view(依赖请随 main.js 打包)"`。抛点是一条硬拒：`entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2173` `throw new Error('插件沙箱不支持模块: ' + name + '(依赖请随 main.js 打包)')`。
- 我扫过该 bundle 的外部依赖面：`@codemirror/*` 只出现 `@codemirror/view` 一次，`node:`/`electron` 零次；符号只用到 `ViewPlugin.fromClass(class extends …)` 一处（`EditorView`/`Decoration`/`WidgetType`/`EditorState` 全为 0 次）。**一个模块、一个静态方法，挡住整个插件。**

**为什么这条必须单独立章**：离线阶梯（jsdom）把失败链推到了 `ctx.addChild`，而真机连模块解析都过不去；两条链真实但不同层，排期不能互相替代。jsdom 里的失败点只说明「补到那一步才能继续」，不说明设备上的顺序。

**当前决策（默认保持硬拒，等待证据）**：不先写桩。理由是这座底座已经吃过一次「两端都实现、中间没人接线、门禁只验一端 → 全绿而不通」的亏（见 §15 第 3 条同族经验），给一个静默空桩等于把「插件加载成功」变成假绿。

**三种候选与判据**（数字来自 `tools/ecosystem-scan` 的 24 件样本扫描，未出结果前不许拍板）：

1. **保持硬拒**：插件加载失败，`onload.error` 明确。代价=依赖 `@codemirror/*` 的插件一律不可用。适用于扫描证明这类插件占比很低。
2. **声明式兼容模块**：为频次表里的符号写最小实现（`ViewPlugin.fromClass` 返回可注册的扩展描述符），**每次被真实使用都记一条 `plugin.capability.unsupported` 并在插件详情里可见**，且这些符号在 `tools/contract/symbols.json` 里必须保持 `stub`/`unsupported` 状态、不得计入 `implemented`。适用于扫描证明这类插件占比高、且缺口集中在少数符号。
3. **真接 CM6**：把编辑器侧的 CM6 暴露给插件页。代价最高（插件页与编辑器页不是同一个 JS realm），只有在 ② 的降级被证明不可接受时才做。

**不许做的三件事**：① 把桩计入 `implemented`（那会让 `--strict` 的 known gaps 归零变成谎言）；② 用「插件已启用」掩盖 `onload.error`（§17.5 第 6 条之外单列：这是同一类谎，只是发生在市场面板而不是门禁）；③ 用 `require` 期抛错的堆栈当作「插件质量差」的结论——当前是我们不支持，不是插件有 bug。级为默认回退值，`manifest-compat` 门禁的畸形输入表仍然有效。
