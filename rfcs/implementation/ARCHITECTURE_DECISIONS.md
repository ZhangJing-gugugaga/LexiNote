# ARCHITECTURE_DECISIONS — 编号 ADR-R{轮}-{序}

## ADR-R7-01 采纳 LEXI-RFC-PLUGIN-001 为架构基准，工程记录迁出版被忽略的 docs/

- 背景：RFC 以粘贴文档提供，仓库内不存在；历史轮次记录与八篇文档位于被 `.gitignore` 忽略的 `docs/`，门禁引用的 "RFC" 无版本控制依据（RFC P1-03）。
- 方案：RFC 全文入 `rfcs/`；执行计划/进展/决策/阻塞/测试矩阵/模块图入 `rfcs/implementation/`；`docs/` 忽略策略不动（八篇文档入 Git 另列 P0-004，做最小范围 ignore 调整）。
- 理由：满足"所有工程文件必须纳入 Git"，不触碰既有 `docs/` 约定。
- 复审：P0-004 完成时决定八篇文档最终落点。

## ADR-R7-02 远程安装信任闸门提前执行（打乱 Phase 顺序的裁定）

- 背景：RFC §16 要求 TUF/签名属 Phase 5；但 Goal §5 Step3 规定安全缺陷最高优先；审计确认 fail-open 无哈希远程安装→自动启用是当前可利用面（默认索引无 sha256）。
- 方案：**先封完整性下界**（无受信任哈希→下载前拒绝），TUF authenticity 接线留待 P5-002/密钥决策。
- 备选：a) 现在就接 LexiRegistryTrust——拒绝：需 root 密钥/签名算法真机验证决策（B-002），会把小任务变大；b) 不动分发先做沙箱——拒绝：沙箱被 B-001 阻塞，而分发缺陷今天就能封。
- 兼容性：真实市场条目在发布索引升级（P5-006）前显示「缺哈希」不可装——这是 RFC 明文要求的 fail-closed（"生产市场不得允许缺少受信任哈希的远程插件安装"），不视为回归。

## ADR-R7-03 双信任策略：远程安装 vs 本地侧载

- 决策：`installFromUrl`（市场/远程）强制 `isTrustedInstallHash`；`installZip`（用户在设置中选定本地 zip）保留空哈希跳过语义（自选文件以用户意志为信任根）。`LexiPackageVerifier.verifyHash` 的空声明跳过同理仅限本地。
- 判定唯一入口：`LexiPluginMarketModel.isTrustedInstallHash()`，宿主与 UI 复用同一函数，禁止两处各写正则（Round 7 审计指出 capabilityTags 双副本教训）。
- 演示源（http://10.0.2.2:8099）：设备回归流的 schemaVersion=1 索引自带 sha256，闸门兼容；明文 http 的 dev 标记与生产 https 强制归 P5-005。

## ADR-R7-04 契约快照锚点修正采用手工最小补丁

- 背景：本轮 .ets 插行导致 symbols.json 两个"路径:行号"锚点脱节（门禁 2 项红）；官方修法 `generate.cjs` 重生成会把 5 个正确的 shim 锚点写成错的（7 项红）——generator 与 verifier 口径不一致（B-006）。
- 决策：只手工修 2 个受影响锚点；generator 缺陷立为 P0-005；在其修复前，任何贡献者不得"顺手"跑 generate 重生成。
- 复审：P0-005 完成后恢复"生成物必须且只能由 generator 再生"纪律。

## ADR-R7-05 沙箱接入策略（提案，待 P1-001 真机验证后定案）

- 方向：不新写运行时——复用 LexiPluginExecutionContext（补 port↔身份绑定）、以 PoC 已验证的 iframe(`sandbox="allow-scripts"`, opaque origin)+每上下文 MessageChannel 形态替换共享 realm；`new Function` 从宿主运行时移除，CommonJS 插件由构建期打包 IIFE（CLI/template 已是 esbuild 链路）；workspace 轨道的既有 WebMessagePort 收敛为唯一通道形态，两 broker 合并单 Gateway（P1-007）。
- 状态：Proposed——ArkWeb 对 opaque-origin iframe 的 MessageChannel/port 转移、runJavaScriptAlternatives 的实际语义**必须**真机验证（B-001），不得以 Chromium 行为推定 HarmonyOS。
- 边界提醒：删除/替换现有运行运行时属需人工确认事项（Goal §10）——届时携真机证据另行评审。

## ADR-R8-01 ArkWeb 隔离载体：iframe 模型真机首验失败，载体选型待 P1-001a 定位后复审（Proposed→Verify）

- 背景：Round 8 首次在可用设备上验证沙箱 PoC——`lexinote_sandbox_poc.html` 加载成功，但其 `sandbox="allow-scripts"` iframe 的目标文档**无任何加载请求**、探针**无任何输出**（phone/2in1、30-35s 窗口一致）。
- 意义：RFC §3.2 的 iframe+MessageChannel 模型在 ArkWeb(API 26) 上**不可按 Chromium 语义假设**——这正是 Goal §2 预警的情形。不改变 RFC 的安全目标（独立上下文+受控通道），只把**载体选型**退回待验证状态。
- 假说（按验证成本排序）：①PoC 宿主页 CSP 缺 `frame-src`（改动最小,先证伪）；②ArkWeb 对 sandboxed iframe 的 src 解析限制（opaque origin 的 rawfile scheme 解析差异）；③页面早期 JS 异常（探针源注入 `window.LEXI_SANDBOX_PROBE_SOURCE` 若失败,建 iframe 代码是否整体跳过——PoC 的 `runtime.ready 被 fail-closed 拒绝` 真机日志提示初始化握手顺序可能相关）。
- 决策规则：①③属实现缺陷,修后继续 iframe 路线；②属平台限制,则出 ADR 评估替代载体（多 Web 组件实例 + createWebMessagePorts 已有 workspace 轨道真机先例），并同步修订 RFC §3.2 与 ADR-002/003 的实施描述（RFC 更新规则 §19.3:插件执行模型变更须记录）。
- 复审条件：P1-001a 完成即定案。
- **Round 9 结案（ADR-R9-01，取代本条待定部分）**：三层根因（内联脚本被 CSP 拦杀 / 子→宿主消息缺协议标记 / 探针 frames[0] 假阳性）全部修复后，真机 `PoC verdict: PASS contexts=2/2, vectors 10/10 blocked, credentialHits=0`。**定案：iframe(sandbox=allow-scripts)+opaque origin+DOM MessageChannel 载体在 ArkWeb API 26 可行，RFC §3.2/§3.3 无需修订**。假说②(平台限制)证伪；`origin=null`、`sourceIsParent=true`、`ports=1` 为常驻真机见证。残余注意：正式运行时消除宿主 eval（P1-003）、ping/pong 见证与里程碑打点保留为巡检信号。

## ADR-R10-01 页面身份模型收紧：回落 fail-closed + 归属令牌 WeakMap 化 + 手工入口移除

- 背景：Round 7 审计确认共享 realm 三泄露面（`LexiObsidian.currentToken()` 回落裸会话令牌；`instance.__lexiToken` 属性可被他插件 `app.plugins.getPlugin()` 盗读；`hostCall/withToken` 手工入口允许插件自带任意令牌调 RPC，配合会话回落可触控制面）。
- 方案：①`currentToken()` 栈空返回空串（宿主 anonymous fail-closed）；②归属令牌迁入闭包 `WeakMap(objectIdentityTokens)`，属性形态在代码体中永久禁绝（bridge-security R7a 扫描去注释后代码体）；③公共面删除 `currentToken/withToken/hostCall`（容器 bundle 实测零消费后删除，R6f-h 行为级断言 + R6h 保留 loadPlugin/unloadPlugin 装载口）；④布局/恢复等宿主页管理函数显式传闭包 `sessionToken`（shim 是宿主页组件，直接持有凭据合法）。
- 备选：保留 hostCall 入口但要求显式合法令牌——拒绝：入口本身就是攻击面，无正当消费方；只删别名不改回落——拒绝：定时器捕获兜底仍会把插件异步路径升格会话身份。
- 兼容性影响：**旧插件若曾直接调 `window.LexiObsidian.hostCall(...)`（不合规写法）将失效**——这正是 RFC §3.5 禁止形态；合规插件（正规 API 面）经 wrapper/api-root/captured 三类通道身份不变，identity-delivery 30/30 traced。Round 8 真机对照：onload/adapter-probe/匿名拒绝基线一致；cap-probe 证据锚点(cap.identity.forged capability_denied / self allowed=true)经正规 API 路径保持可产出。
- 残余风险(登记)：同 realm 下 `window.lexiRuntime.__receive` 仍可被他插件调用以触发 `invoke.command`(跨插件回调执行)——修复需 dispatch 通道鉴权(涉及 .ets 协议面),列 **P1-006b**;`setSessionToken` 仍可被他插件乱写(DoS 宿主回话,非提权),同场登记。
- 复审:P1-003 沙箱落地后 __receive 面自然消失,本 ADR 残余风险随之关闭。
- **R30 收口记录(P1-006b,离线 IMPLEMENTED 待设备批次)**:两项残余风险已关闭——①dispatch 通道鉴权:`LexiWebRuntime.dispatch` 每次派发铸造一次性通道凭据(mintCredential('dc'),method+payload 双绑定,凭据只存在于本次 runJavaScript 表达式,不落任何页面可读/可枚举面),shim `__receive` 门卫执行回调前必须经 `lexiHost.admitDispatch`(javaScriptProxy 同步核销口,首条核销申请即烧毁,重放/换绑定 fail-closed)——裸调/伪凭据/重放/换方法换载荷全部关闭(SEC-007 负例族 vm 行为级进门禁,bridge-security R8 + shim-regression dispatch 通道负例);**残余(与 ADR-R25-01 定案3 require 令牌同一信任级)**:同 realm 在途截获(猴补 __receive/lexiHost 拦截宿主表达式)仍可让单次派发失效(DoS)或抢在合法消费前原样重放一次,payload 绑定保证内容不可伪造——共享 realm 的平台极限,彻底关闭归沙箱轨(legacy 轨停用后 legacy dispatch 整体消失);②`setSessionToken` 作用域写一次定死(shim 闭包 `sessionTokenBound`):合法写入者只有容器引导链(channel.auth 后先于任何插件装载),首个非空令牌绑定本 realm 会话作用域,绑定后异值后写/清空一律拒绝(跨上下文写入 fail-closed),同值幂等放行——插件的会话 DoS 面关闭(门禁 bridge-security R8f/R8h + shim-regression)。P1-005 同轮把端口链调用点凭据表达式清零(callFromPort,身份纯端口化)。

## ADR-R18-01 执行上下文模型定案（P1-002）与 P1-003 实施切分

- 依据：ADR-R9-01（iframe+opaque origin+MessageChannel 载体真机可行，`origin=null`/`ports=1`/ping-pong 见证）、P1-006 身份面收口（WeakMap/手工入口删除）、Round 7 审计两轨事实。
- **定案 1·身份四元组**：`PluginExecutionIdentity { pluginId, activationId, contextId, contextKind }`（RFC §3.1 原样），宿主侧唯一记账点 = `LexiPluginLifecycleManager.createContext`（已存在，kind 全集补齐）；插件侧永不可见。
- **定案 2·传输与身份绑定**：每上下文一条 DOM MessageChannel；宿主侧新建 `contextRegistry: Map<contextId, HostContextRecord{contextId, pluginId, activationId, kind, port, createdAt, revoked}>`（RFC §3.3 HostContextRecord），port1 留宿主、port2 转移进 iframe；iframe init 载荷只含 contextId（PoC 已验证形态）。**身份 = 宿主端口表反查，不信任任何载荷字段**——取代 shim 内 WeakMap 令牌栈成为沙箱上下文的身份真源；WeakMap 机制保留给非沙箱过渡面。
- **定案 3·RPC 形态**：沙箱内 `request(method, params)` 经 port → contextRegistry 反查 → 喂给**既有 broker.authorize + 矩阵**（零新授权逻辑）；capability/fsGate/路径门全部原样生效。
- **定案 4·两轨策略**：P1-003 只动 Track1（runtime 页）；Track2（workspace 容器）现状保留、P1-004 收敛。Track1 的宿主页面移除 `unsafe-eval`，插件求值迁入 iframe；iframe 自身 CSP 保留 `unsafe-eval` 作为过渡（构建期 CommonJS→IIFE 由 CLI 模板承接，P1-003c 落地后收口）。
- **备选回退**：若真机性能基准（poc-verdict 判据）显示 iframe 内 port 双向投递不达标，回退为每插件独立 Web 组件 + native createWebMessagePorts（workspace 轨道已验证的形态）——已记录为设计内备选，不另开决策。
- **P1-003 子任务切分**：P1-003a contextRegistry+端口 RPC 网关（宿主侧，纯 ArkTS+js 可离线测）；P1-003b 沙箱页插件 API 面（obsidian namespace 的端口化重建）；P1-003c 构建期 IIFE + 宿主 CSP 收紧；P1-003d 真实业务插件（lexi-sample/calendar）真机迁移验收 + SEC 探针进业务路径（P1-009 的载体）。
- 兼容性：过渡期双轨并存（沙箱插件与共享 realm 插件可共存），旧插件无感；Track1 迁移完成前不删除任何现有路径。
- 复审条件：P1-003a/b 落地后若发现 broker 身份来源需二次抽象（端口表 vs 凭据表），回本 ADR 增补。

## ADR-R21-02 沙箱容器迁移至独立 Web 组件（方案 B）——runtime 页跨帧通道缺陷的平台事实

- 背景：P1-003b 切片在 runtime 宿主页挂 per-plugin iframe 时遭遇真机异常（证据链 r21h/r21i2/r21j）：①iframe→parent 的 window.postMessage（ready 与 request 帧）**发出不抛错但不达容器**；②容器页侧 MessageChannel port1.onmessage **不投递**；③**同一份沙箱子文档在 PoC 独立页（LexiSandboxHost）双向全通**（Round 9 verdict + 本轮对照复测）。
- 判定：非协议/标记问题（Round 9 三根因均已修复且 PoC 对照排除）；指向 ArkWeb 对**特定宿主页面形态**（1x1 headless + javaScriptProxy + 高频 runJavaScript 的 runtime 页）的跨 frame 事件投递缺陷或约束——**平台事实，需华为侧或专门 PoC 进一步定位**（B-009）。
- 决策：沙箱容器迁往**独立 Web 组件**（与 LexiSandboxHost 同构的形态——该形态下 iframe+MessageChannel+window 双向已真机验证）：新建沙箱容器 Web（承载容器页+全部插件 iframe），与宿主经自身 javaScriptProxy+runJavaScript 通信，contextRegistry/broker 复用不变。过渡期沙箱轨加运行开关（`lexiPluginSandboxTrack`，默认关），未启用时声明沙箱的插件回落旧轨（探针无害）。
- 影响面：P1-003b 的 API 面重建工作不返工（sandbox html 的 bootPlugin/最小面已就绪）；容器脚本与宿主网关（LexiContextRegistry）原样迁移。P1-004（workspace 轨收敛）不受影响。
- 复审条件：方案 B 容器组件真机贯通（帧往返+onload）即解除 B-009。

## ADR-R25-01 构建期 CJS→IIFE + runtime 页 eval 清零（P1-003c）：脚本文本注入与双通道求值

- 依据：RFC §3.2 硬规则（宿主运行页不允许 unsafe-eval；旧版 CommonJS 优先构建期打包为 IIFE）；EXECUTION_PLAN R25=P1-003c；ADR-R18-01 定案4（Track1 宿主页面移除 unsafe-eval）；真机事实——ArkWeb 强制执行 meta CSP（B-008：script-src 'self' 拦杀内联脚本），且 `script-src 'unsafe-inline'` 放行内联脚本自 Round 9 起有真机见证（sandbox.html 内联引导）。
- eval 面盘点（本决策的代码证据）：runtime 页（lexinote_plugin_runtime.html 装载 lexinote_plugin_shim.js/render.js/sandbox_container.js）唯一 eval 消费点 = shim `loadPlugin` 的 `new Function('require','module','exports', code)`（原 lexinote_plugin_shim.js:2296）——legacy 共享 realm 轨（LexiPluginRuntime.ets `dispatch('load.plugin')`，默认轨）与工作区 obsidian 兼容路由（workspace bundle `window.LexiObsidian.loadPlugin`，同一份 shim）都走它；sandbox iframe 内部 new Function（bootPlugin/evalInContext）按 ADR-R18-01 定案4 保留；workspace_shim 自有求值器（:224）属 Track2，P1-004 收敛；ArkTS VM 无 eval。
- 定案 1·包装单一真源：CJS→IIFE 包装器只实现一份——shim 内 `wrapPluginSource`（发布为 `window.lexiRuntime.__lexiWrapPluginSource`），CLI `lexi plugin build` 经 vm 复用（与 validate/publish 复用宿主解析器同一原则），模板 build 链尾追加 `lexi plugin build .`。产物形状 `/* lexi-iife:v1 */`：自执行 IIFE 自带 module/exports/require 管线、捕获求值错误、把 exports 登记进 `window.__lexiPluginRegistry[id]`；求值期宿主侧零管线。已包装产物按字节原样注入（标记判别，幂等）。
- 定案 2·双通道求值（能力探测选择，装载期一次定死，插件不可重探/改判）：①注入通道（runtime 页，CSP `script-src 'self' 'unsafe-inline'`）——包装文本经 `<script>` 元素注入执行，探测脚本 `__lexiScriptInjectOk` 判通道可用；②过渡通道（`new Function` 管线，语义与历史版本逐字节一致）——**必须保留**，因为 shim 同时挂在 lexinote_workspace.html 上且工作区 obsidian 兼容路由经 `LexiObsidian.loadPlugin` 走同一函数，而工作区页 CSP 保留 `'unsafe-eval'` 是本轮显式不动项（P1-004 收敛时删通道+收紧该页 CSP，两者同轮复审）。runtime 页的 eval 兜底由 S26 的 CSP 断言保证不生效（无 unsafe-eval 时 new Function 恒 EvalError）。
- 定案 3·require 令牌绑定不进脚本文本：注入文本可被同 realm 读取，令牌只能走闭包——装载期登记一次性 require 上下文，IIFE 以 `window.lexiRuntime.__lexiAcquireRequire(id)` 参数表达式获取令牌绑定 require；消费窗口 = loadPlugin 的同步注入段（两次 await 之间，同 realm 其他插件代码无法插队），取用即烧毁，盗调 fail-closed 抛错。闭包随插件类存活（异步 onload 里 require 仍带令牌），与旧 requireForPlugin 闭包同安全形状（ADR-R10-01 不回退）。
- 定案 4·'unsafe-inline' 的取舍：eval 移除后，动态求值的 CSP 合法通道仅剩脚本元素注入——`'unsafe-inline'` 是放行它的最小授权（备选 `blob:`/hash/strict-dynamic 因离线不可证真、真机风险高被否）。权衡：HTML 文档本体保持零内联脚本（S27 静态断言续守"引导外置"不变量）；共享 realm 插件本就能操作 DOM，注入通道不新增同 realm 攻击面，而 eval/new Function gadget 链在宿主页 fail-closed；真实隔离边界仍是沙箱 iframe（unsafe-eval 按设计保留，S29）。
- 兼容性影响：未包装旧 bundle 由 shim 在装载期补同构包装（行为等价：非严格求值语义不变、require 命名空间/令牌绑定不变、`module.exports`/`exports.default` 导出识别不变）；CLI-wrapped 产物在沙箱轨（bootPlugin）暂不可载——require 回调抛"require 不可用"，属 P1-003d 真机迁移切片的收口项；离线门禁 vm/JSDOM harness 无注入环境 → 探测判 false → 全部走过渡通道，既有断言零改动。
- 门禁锚点：plugin-context-isolation S26（runtime CSP 无 unsafe-eval）/S27（HTML 零内联脚本）/S28（runtime 页脚本 eval 对账：render/container 清零、shim new Function 恰 1 处且能力门控）/S28b（注入通道结构在案）/S29（沙箱保留 unsafe-eval+注释在案）；lexi-cli-contract C6（build 端到端+形状+vm 行为级+幂等）；plugin-shim-regression 注入通道行为级用例；net-request-url 19.3 锚点随内部命名更新（语义不变）。
- 复审条件：P1-004 收敛工作区页 CSP 时必须同轮删除过渡通道（S28 的"恰好 1 处"预期归零）；真机阶段若注入通道异常（探测 false 且无 unsafe-eval）按 fail-closed 报错暴露，不得静默回退。

## ADR-R26-01 安装不再自动 enable：授权清单展示 → 用户同意 → 启用（P5-004 / B-004 自设计,验收后请人工复审）

- 依据：RFC §4.5（安装必须展示插件名/发布者/版本/来源/签名状态/请求权限/网络与剪贴板与存储披露,建议区分必需/可选/高风险;拒绝必需权限不得启用）、§8.2 安装流程（展示权限清单在原子安装之前、任何步骤失败不得标记为已启用）、§4.6（版本更新权限不变沿用授权）。EXECUTION_PLAN R26 = P5-004（P0 安全洞:装完自动 enable 无授权）。
- 同意模型定案：**授权落账（PermissionStore.grant,指纹绑定）= 用户同意的唯一记录;启用以已落账授权为前提**。installZip/installFromUrl 只落盘,首装默认停在 installed（在盘未启用）态;MarketSheet 安装完成后弹出授权面板（元数据披露 + capabilityTagsOfV2Caps 正典标签按 classifyCapabilityTags 三档呈现:高风险/可选/必需基线,分类纯展示、不拆分授权）,「同意并启用」= consentEnablePlugin（grant→enable）,「暂不启用」= 保持未启用。enablePlugin 的「首次启用即授权」自动落账废除:not-granted 一律拒绝启用（errorState='插件权限尚未授权',停留在 RFC §4.1 installed/permission-pending 未运行面）——这条门使未同意插件经任何通路（首装/重启恢复/手动开启）都无法运行,fail-closed。
- 降级运行路径定案（本轮 documented choice）：授权为**整体性**（指纹全集,延续 P2-002 模型,PermissionStore 无 deniedCapabilities 逐能力字段）,故"未完全授权"= 不运行（permission-pending 语义,即既有 enable/disable + errorState 面）,不做部分授权的 degraded 运行;RFC §4.5 的"拒绝可选权限仍可降级运行"留给 P2-009 状态机补 degraded 态时连同 per-capability 授权一起收口。三档分类先行落 UI,届时无需改数据模型。
- 升级通路不动（§4.6）：已启用插件（enabledIds 在册,判定取在 scanPluginDir 重建记录之前）升级后经 enablePlugin 重启,权限不变沿用授权;权限增长在安装口仍被 LexiUpdatePolicy 拦成 ERR_PERMISSION_REGRANT_REQUIRED,经 P2-008 重授权确认行（grantApproved）落账后启用。撤销链（P2-010）原样:revoke → disablePlugin 立即停用,revoked 短路先于授权门,consentEnablePlugin 可重新授权。
- 内置夹具（B-004 待审项）：**内置开发夹具白名单**——lexi-sample-plugin/sandbox-probe/sandbox-sample-min 随 HAP 签名分发、不经用户安装链,首启（bundledInit 一次性标志）在代码内闭合的 bundledAllowList 逐个 grant 落账后启用;Round 22 恢复的 sandbox-probe 冷启动链不回归。用户安装插件无任何自动落账通路。备选"内置夹具也走授权面板"被否:夹具是设备验收探针,首启无人值守场景没有可交互的同意时点;若人工复审要求全量同意,删除该白名单块即可（单点回退）。
- v1 legacy：无能力声明清单不进授权门（无指纹可授,revoked 短路仍生效）;有声明清单（legacy 三标签形态）与新装 v2 同样需同意——不静默授予任何新面,与 P2-002 的 v1 指纹/diff 处理同口径。
- 门禁锚点：plugin-dist-regression +7（安装不 enable 三段结构 / enablePlugin 授权前置+自动落账废除 / consent 通道+撤销重授权真跑 / 内置白名单 / 分级呈现真跑 / 市场 UI 接线 / 设置页接线）;plugin-lifecycle-once L6.8/L6.9;plugin-manifest-v2 V6.1-V6.5;plugin-update-policy 语义不变（首装策略仍放行,授权发生在启用口）;设备流 plugin-dist-flows / adapter-probe-evidence 增加「已安装（未启用）→ 同意并启用」步进（真机验收随 P4-005）。
- 复审条件：B-004 人工确认①内置夹具白名单是否豁免同意②三档分类口径③设置页"开关即同意"（行内权限标签可见）是否需要升级为独立确认弹窗。

## ADR-R28-01 沙箱轨 require 管线收口 + lexi-sample 沙箱 opt-in + 旧共享 realm 停用开关（P1-003d/R28）

- 依据：RFC §3.6（安全 PoC 通过≠业务运行时安全,最终必须在真实业务加载路径中验证;验收表含旧共享 realm 路径停用）;EXECUTION_PLAN R28=P1-003d（范围修正:calendar 迁移归 P4-005,理由=不为迁移动画接口临时拼装 view 面）;ADR-R25-01 遗留项「CLI-wrapped 产物在沙箱轨暂不可载——require 回调抛 require 不可用」。本轮为**真机验收准备轮**:离线面全部落地并门禁固化,设备批次验收(切开关→fail-closed 验证→沙箱轨回环→SEC 报告)归主线程设备流程。
- 定案 1·沙箱轨 require 管线（bootPlugin 双分支）：沙箱页提供 window.lexiRuntime.__lexiAcquireRequire——**与宿主 shim 同名是刻意的**:CLI 包装产物文本写死该引用,同名=同一份 lexi-iife:v1 产物在两个 realm 都能按字节原样消费。分支①原生 CJS 走既有工厂管线(行为不变);分支②检测 lexi-iife:v1 标记→按字节原样进 new Function（沙箱 CSP 按设计保留 unsafe-eval,S29/ADR-R18-01 定案4 不变）→IIFE 自执行把 exports 登记进本 iframe 的 window.__lexiPluginRegistry→bootPlugin 读回。语义对齐 shim requireContextsById:每装载登记一次性上下文,取用即烧毁,盗调 fail-closed;**凭据(token)绝不进 iframe**——沙箱 require 只服务 obsidian 命名空间,请求归属由宿主 contextRegistry 按 contextId→容器网关裁定（S31b 断言钉死）。
- 定案 2·lexi-sample opt-in 形状：manifest 升 v2（严格解析,授权面板可见）+ entrypoints.service='sandbox:'（声明式 opt-in → manifest.sandboxService）+ capabilities 与其真实 RPC 面逐项对账（vault read+write / editor 三档 / workspace.commands / storage / notifications——dist-regression 行为级断言 parsePluginManifest 真跑）。**业务代码 main.js 零改动**（保持真实插件形状）。沙箱 obsidian 面补齐其求值期依赖:ItemView/PluginSettingTab 可构造最小基类（类定义期就要基类存在）、vault.on 订阅面（登记语义,事件投递仍是 P1-003b 剩余面）、vault.process 组合面（读→改写两段既有门禁 RPC,不新增宿主处理器）、workspace 叶面显式失败桩（fail-visible,view 域=P4-005）。已装设备升级路径:内置资源随应用版本覆盖清单→指纹变化→enablePlugin regrant 门拒绝→设置页重新授权一次（显式同意,符合 ADR-R26-01;新装设备走首启白名单自动落账）。
- 定案 3·旧共享 realm 停用开关（lexiPluginLegacyTrack）：决策收敛为纯函数 LexiPluginTrackPolicy.resolvePluginTrack（单一真源,门禁转译真跑两种朝向逐格断言）——sandboxService&&sandboxTrackOn→沙箱轨;否则 legacyTrack 开关开着→legacy 轨（历史回落,行为与 R27 前一致）;关死→refused（errorState+markFailed+return false,不派发 load.plugin、不静默回落沙箱轨——两个执行面互不替代）。**默认 true 的理由**:RFC §3.6 要求沙箱轨先在真实业务路径验证通过才能关旧门——R28 设备验收完成前关死会让所有 legacy 插件（含 calendar/compat-probe 等未迁移存量）全部拒载,验收本身无法对照;默认 true 保持存量行为零回归。设备验收通过后翻默认 false（届时修改 KEY_LEGACY_TRACK 默认值+本 ADR 复审,门禁锚点已就位）。设置页双面（Tab+Window）Toggle 直连 manager 存取,即刻落盘;关闭不停用已运行插件（只影响后续装载）。
- 定案 4·SEC 探针进业务路径：新增夹具 plugins/sandbox-sec-probe（v2+sandbox: 声明,与 sandbox-* 探针同批:gitignore 本地暂存+首启白名单+随 HAP 内置/发布剥离）,onload 里穷举 RFC §14 T0.2 的 10 条逃逸向量（parent-dom/parent-globals/sibling-iframe/window-opener/opaque-storage/network-fetch/network-xhr/remote-import/function-escape/credential-hunt）,报告经 saveData 业务数据通道落盘（这条 RPC 本身就是探针在业务链里活着的证据）。**离线门禁与设备共用同一份夹具源码**:plugin-context-isolation E3/E3b 在 vm 里真跑沙箱表面代码（lexinote_plugin_sandbox.html 引导脚本提取）+夹具经 bootPlugin 装载（CJS 与 shim 包装 IIFE 双分支）,断言:全向量 blocked+报告帧在案+plugin.onload.done+帧不带身份字段。E3 同时修复了既有 E1/E2 段的结构性缺陷:async 探针段此前排在 process.exit 之后,结果从未被计入汇总（本轮起 main() 统一 await,E1/E2 真正生效）。
- 门禁锚点：plugin-context-isolation S19b（夹具对账,缺席显式跳过）/S31/S31b/S32/S32b/S33/E3/E3b（76 项）;plugin-dist-regression +5（track 政策矩阵真跑/enablePlugin 接线+refused fail-closed/设置页双面/lexi-sample opt-in 对账/SEC 夹具+内置链）32 项;plugin-manifest-v2 V7(内置沙箱轨夹具清单真解析)55 项;release-gate --ci 29/29+assembleHap BUILD SUCCESSFUL。
- 复审条件：R28 设备验收（P1-003d 收口）通过后①翻 lexiPluginLegacyTrack 默认为 false②S31 随 P1-004 收敛后复看③SEC 夹具报告与 vm 门禁报告逐向量对账（设备 ArkWeb 真实行为 vs vm 模拟,差异进 BLOCKERS）。
## ADR-R29-01（草案,待人工评审）P1-004 Workspace 轨道收敛：混合模型——Track2 纳入单一轨政策真源 + 视图面沙箱化 + CM6/editor 扩展残留面进 Trusted 策略

- 状态：**Proposed（草案）**。HUMAN_QUEUE#3 人工评审批准前不得动任何代码（EXECUTION_PLAN R29 裁定:按 Goal §10 技术论证先行）。本 ADR 只产出论证,零代码改动。

### 依据（RFC 与 ADR 谱系）

- RFC §3.2 硬规则「不允许为了兼容插件而在宿主运行页面开放 unsafe-eval」；§3.6「安全 PoC 通过≠业务运行时安全,最终必须在真实业务加载路径中验证」；§5.4 第三阶段「CM6 代码如果需要在宿主编辑器上下文执行,必须进入 Trusted 扩展策略,不能让普通不可信 iframe 获得宿主编辑器对象」；§11.1 审核三级（Community/Verified/Trusted,等级不是用户授权的替代品）；§5.2 Internal=宿主内部不允许第三方依赖。
- ADR-R18-01 定案 4：两轨策略——Track1（runtime 页）已收敛（R25 eval 清零 + R28 停用开关）；Track2（workspace 容器）现状保留、P1-004 收敛。
- ADR-R21-02：runtime 宿主页形态的跨帧通道（iframe→parent postMessage、容器页 MessageChannel onmessage）静默丢帧,沙箱容器必须是**独立 Web 组件**——由此认定:在工作区页内直接嵌插件 iframe 属被真机证伪的形态,收敛设计不得重蹈。
- ADR-R25-01 复审条件:「P1-004 收敛工作区页 CSP 时必须同轮删除过渡通道（S28 的恰好 1 处预期归零）」。
- ADR-R26-01：授权同意是运行的唯一前提（not-granted 一律拒绝启用）。
- ADR-R28-01：LexiPluginTrackPolicy.resolvePluginTrack 三值单一真源；复审条件②「S31 随 P1-004 收敛后复看」。
- 平台事实备查：KI-5（runtime 页 onConsole 哑——工作区页 onConsole 正常,LexiWorkspacePage.ets:326-332）、KI-1（市场 sheet 塌陷,LexiPluginMarketSheet.ets:556）、P2-013（设置页 toggle uitest 多击——设备证据设计必须绕开）。

### 现状盘点（编辑器页第三方代码求值面,HEAD file:line 全对账）

编辑器页 = LexiWorkspacePage（手机开笔记默认路由:Index.ets:442-446 openNoteContainer → pushUrl 'workspace/LexiWorkspacePage'）→ `Web(lexinote_workspace.html)`。ArkTS 侧无 eval（onConsole 仅日志转发,LexiWorkspacePage.ets:326-332）；第三方代码求值全部发生在页面装载的脚本里,**与 CM6 编辑器、会话令牌、全部页面全局同一 realm**:

1. **CSP**：`lexinote_workspace.html:6` `script-src 'self' 'unsafe-eval'`——全应用唯一保留 unsafe-eval 的宿主页（runtime 页已清零,ADR-R25-01）。:93-94 同时装载共享 shim（lexinote_plugin_shim.js）与工作区 shim（lexinote_workspace_shim.js）。
2. **求值点 A（工作区 shim 自有求值器）**：`lexinote_workspace_shim.js:224-227` `new Function('module','exports','require', code)`；配套页内执行面:命令回调页内直调（:299-313 runCommand）、插件视图渲染直挂页面 DOM（:263-289 mountView）、会话令牌页内持有（:135-143 adoptSessionToken → window.LexiObsidian/LexiPluginShim.setSessionToken）。消费方:内联 demo 插件 `lexinote.demo-status`（源码硬编码于 WorkspacePluginCatalog.ets:12-44）+ 启动序列第一个 plugin.load 条目（tools/workspace-bundle/src/main.ts:676-682）。
3. **求值点 B（共享 shim 过渡通道）**：`lexinote_plugin_shim.js:2451-2453` new Function（loadPlugin 双通道的过渡分支）;obsidian 兼容路由 `window.LexiObsidian.loadPlugin`（:2787/:2800）由 bundle 逐插件调用（main.ts:577-584）。注入通道能力探测（:2285-2300）在工作区页恒 false——该页 CSP 无 'unsafe-inline' → **obsidian 路由今天全部走 new Function**。
4. **装载范围 = 全量已装插件**：WorkspacePluginCatalog.ets:76-98 loadFromManager 把 files/plugins/<id> 下**每一个已安装插件**的 manifest+main.js 拷入注册表（仅 errorState 非空跳过）,bundle 启动逐个 plugin.load+求值（main.ts:676-694:首个 + 其余循环）;启动序列还跑 forged-pluginId 身份自检帧（main.ts:751）。
5. **两道既有闸门在 Track2 全部失效（本 ADR 的核心事实）**：①R28 的 lexiPluginLegacyTrack 停用开关只在 enablePlugin 裁决（LexiPluginRuntime.ets:2389-2424）——WorkspaceBridge.plugin.load（WorkspaceBridge.ets:530-554）不查 LexiPluginTrackPolicy,**开关关死也拦不住编辑器页求值**;②ADR-R26-01 的同意门——installed-but-未启用（errorState 为空）的插件照样进注册表被求值。即:编辑器页今天是一个**不受轨政策、不受授权同意约束**的第三方代码执行面（验收行「编辑器页不再直接求值第三方代码」的对现状描述即此）。
6. **身份流**：channel.auth 铸会话令牌（WorkspaceBridge.ets:302-331,CSPRNG）进页面持有;每插件桥令牌随 plugin.load 描述符下发页面（WorkspaceBridge.ets:538-546）;宿主运行时凭据（sessionCredentialToken/tokenForPlugin,WorkspaceBridge.ets:679-697）保在宿主侧,经 delegate 以 LexiWebRuntime.call 第四参转发（:699-743,call 在 :721）——P1-005 的废弃形态。
7. **RPC 形态**：WorkspaceBridge 自持第二 broker 实例（:100-101）+ 自有 token 表 + delegate 转发（P1-007 的第二入口）;页面↔宿主走 createWebMessagePorts（LexiWorkspacePage.ets:194-225,真机久验形态）。
8. **依赖方**：demo-status（工作区 shim 专属 api.commands/views.register/host.call 面）;经 obsidian 路由依赖直接 DOM/CM6 访问的存量夹具 = calendar（workspace leaves/ItemView）、editor-outliner（editor 视图）、compat-probe（editor 扩展注册）;lexi-sample（workspace.getRightLeaf;沙箱轨 view 面已挂 fail-visible 桩,归 P4-005）;sandbox-*/cap-probe-* 探针（无 UI 面诉求）。

### 备选方案

**方案 A——全量迁移 runtime 轨容器模型**（workspace UI 作 manager 客户端,全部插件执行面进独立容器 Web 的 iframe）：
- 安全性质最优:与 Track1 同构,编辑器页零第三方求值,身份全走 contextRegistry 端口反查。
- 缺口一（可见性）:ItemView/workspace-leaf 类插件（calendar 等）的可见 UI 必须出现在工作区叶里,而沙箱容器 Web 是 1×1 offscreen（LexiSandboxContainerHost.ets:44-45）——可见视图要求把容器改造成可见/可布局组件或每叶一个 Web,两者都超出已验证形态;ADR-R18-01 备选回退（每插件独立 Web+native createWebMessagePorts）只证明了机制,未验证多实例的内存/状态成本。
- 缺口二（CM6）:声明 editor 扩展的插件无法在 opaque iframe 里获得宿主编辑器对象（RFC §5.4 明文）,最终仍要为 CM6 开 Trusted 面——「全量」并不全量。
- 风险:把可见布局问题与安全问题耦合进一个大迁移,一次翻车=一次大规模真机回归（ADR-R21-02 教训）。

**方案 B——页内求值保留,整页进 Trusted 策略**（RFC 的替代项,验收行后半句的极端读法）：
- 操作语义必须定义:Trusted = P6-001 审核等级（专项安全审查）+ P5-002/P5-009 签名链（依赖 B-002,当前 BLOCKED）+ manifest 显式声明高风险面 + P2-008 授权面板显式同意 + P4-004 CM6 门。
- 兼容性零损、迁移成本最低——但**作为整页策略被否决**:①信任根不存在——B-002 未决、P5-002 零接线,"Trusted"今天就等于「随 HAP 发的 + 用户侧载的」,整页安全外包给尚不存在的审核体系;②与 RFC §3.2 硬规则冲突——整页 unsafe-eval 不是"为兼容插件"的最小授权,是把所有插件（含不可信）升格 Trusted;③RFC §3.1 三级隔离在共享 realm 全不成立,插件互访仍靠约定;④与 Track1 已完成的收敛倒挂——同一插件两个执行面,一个隔离一个不隔离。
- 其**作为 CM6/editor 扩展残余面的策略框架被本 ADR 采纳**（见定案 3）。

**方案 C（推荐）——混合**:轨政策/同意门先行收口 → 可见视图面沙箱化（已验证载体形态）→ 求值器退役+CSP 收紧 → CM6/editor 扩展残留面进 Trusted 策略（P4-004 域）。终态:普通插件代码在编辑器页零求值;唯一残余求值面 = Trusted 级 editor 扩展（RFC §5.4 明文允许的形态,验收行「或该面进入 Trusted 策略」的后半句）,且过渡期信任根 = 随 HAP 分发的内置白名单（ADR-R26-01 同款纪律,不依赖 B-002）。

### 定案（草案,每条待人工批准）

1. **Track2 纳入单一轨政策真源（第一优先,纯 ArkTS 可先行）**：WorkspaceBridge.plugin.load / WorkspacePluginRegistry.loadFromManager 接 resolvePluginTrack + ADR-R26-01 授权态——sandbox 声明插件代码不再下发页面（其命令/事件经既有 manager 端口链）;legacy 轨关死时编辑器页同样拒绝装载;未获同意（not-granted）不下发。此切片独立成立,后续切片无论如何调整均不返工。
2. **可见视图/命令执行面收敛到已验证载体**：可见插件视图不进编辑器页 realm——按 ADR-R18-01 备选形态（独立 Web 组件 + native createWebMessagePorts;本页自家通道即该形态）做可见视图容器实验,设备先行 PoC 裁决「单可见容器 Web 多 iframe vs 每叶一 Web」（真机布局/内存证据,裁决补记 ADR）;headless 面（命令/vault/事件）走既有容器 Web 端口链,零新载体;任何新 Web 组件从第一天挂 onConsole（KI-5 教训）。
3. **CM6/editor 扩展残留面 = Trusted 策略（P4-004 域）**：操作定义——manifest v2 新增 editor 扩展声明面 + 审核等级 Trusted（P6-001）+ 签名验证（P5-002/009）+ 用户显式同意（ADR-R26-01 面）+ 运行时门:非 Trusted 级插件的编辑器扩展注册调用 fail-visible 拒绝。**过渡信任根 = 内置白名单**（与 R26 夹具同纪律）:B-002 落地前只有随 HAP 分发的夹具可进该面,第三方一律拒绝。编辑器扩展本体求值仍在页内（Trusted 级专属）,故工作区页 CSP 最终保留**仅服务 Trusted 面的最小求值通道**——通道形态（保留 unsafe-eval 供白名单 vs 复用 ADR-R25-01 的 'unsafe-inline' 注入机制）随切片真机证据定,是留给实施轮的决策点,本 ADR 不预设。
4. **工作区 shim/求值器退役路径**：lexinote_workspace_shim.js:224 求值器与共享 shim 过渡分支（lexinote_plugin_shim.js:2451）在视图面就绪后删除;lexinote_workspace.html CSP 同轮收紧（兑现 ADR-R25-01 复审条件,context-isolation 工作区页断言 eval 计数归零）;demo-status 夹具迁移到端口化视图面（workspace-tools-regression 锚点随迁）——若迁移成本超预算,备选是 demo 暂入 Trusted 白名单残留面（需人工点头,见开放问题 4）。
5. **身份/端口（P1-005 接口约定）**：本 ADR 的一切新通道禁止新增「报文带身份字段」形态;工作区上下文（view/editor kind）进 contextRegistry 记账;桥 token 表只减不增;P1-005 落地时 Track2 与 Track1 同按「端口↔身份」结算。本 ADR 不提前实现 P1-005,只保证不产生新的迁移负债。

### 迁移切片与验收证据（设备先行纪律,每片有独立验收）

- **S1 轨政策+同意门收口（纯 ArkTS）**：门禁 = plugin-dist-regression 轨矩阵扩 Track2 行 + workspace-tools-regression 扩断言;真机 = ①legacy 开关关死→工作区页 plugin.load 拒载（errorState/日志可见,零求值）②开关开→行为 diff 零回归③未同意插件在编辑器页不求值（与 ADR-R26-01 共用证据面）。注意 P2-013:开关置位用设置直写或键盘,不用 uitest 单击。
- **S2 可见视图载体 PoC（设备轮）**：真机证据 = 工作区叶内可见视图渲染 + 帧往返 + 布局/内存数据;产出载体选型补记。
- **S3 求值器退役+CSP 收紧+demo 迁移**：门禁 = context-isolation 新增工作区页断言（CSP 无 unsafe-eval/eval 计数归零,对齐 S26-S29 形状）+ workspace-tools-regression 迁移后断言;真机 = 编辑器页冷启零 eval 违规 + demo 新路径行为等价（或残留白名单形态经批准）。
- **S4 CM6 Trusted 面（P4-004 域,排期属 Phase 4）**：门禁 = 非 Trusted 拒注册负例;真机 = calendar/editor-outliner 兼容定级（并入 P4-005 夹具批次）。

### 与 P1-005/P1-007 的编排（执行顺序裁定 R29-R31 的衔接）

S1 先于 R30（P1-005）落地:Track2 先并入单一政策真源,P1-005 的端口↔身份结算只需面对一条桥;P1-007（Gateway 归一）在 Track2 不再有独立 broker 分支后成本大降——WorkspaceBridge 第二 broker（:100）与 token 表按 S1/S3 节奏裁撤。本 ADR 不改变 R30/R31 轮次,只要求两任务设计把 Track2 计入。

### 明示开放问题（须人工裁决,均不阻塞 S1 批准本身）

1. **残留面规模**：验收行允许「或该面进入 Trusted 策略」——请确认 CM6/editor 扩展保留页内求值（Trusted 门内）可接受为终态;若要求编辑器页**零**第三方求值,editor 扩展面须整体延期至可行方案出现,calendar/editor-outliner 类兼容降级为不可用（P4-005 C 级定级口径随之改变）。
2. **过渡信任根**：B-002 前以「随 HAP 签名分发的内置白名单」充当 Trusted 信任根,是否可接受（与 ADR-R26-01 夹具白名单同构,单点回退=删白名单块）。
3. **可见视图载体**：单可见容器 Web 多 iframe vs 每叶一 Web——需设备 PoC 预算（本轮不动设备,仅申请下一轮设备批次时加入）。
4. **demo-status 夹具归宿**：迁移端口化视图面（推荐,成本高）vs 暂入 Trusted 白名单残留面（成本低,留一个页内求值特例）vs 退役（门禁锚点改挂新夹具）。
5. **工作区 shim 容器 API 的公开性**：api.commands/views.register/host.call 是否继续作为第三方公开面,还是收归 Internal（RFC §5.2:宿主内部不允许第三方依赖）——影响 SDK 面承诺与 P3 阶段文档。

### 未决声明

本 ADR 不决定：可见视图载体的最终选型（S2 证据后补记）；工作区页 CSP 的最终通道形态（S3 证据后定）；P4-004 Trusted 等级的审核清单细则（P6-001 域）；任何代码改动（本轮零代码）。

### 复审条件

- 本 ADR 获人工批准（HUMAN_QUEUE#3）后 S1 才可进代码轮;S2/S3 依赖 S1 验收;S4 属 Phase 4 排期。
- B-002 落地后 Trusted 信任根从白名单切换到签名链,定案 3 回访。
- P4-004 实施时回读定案 3 的通道形态决策点。
- ADR-R25-01 复审条件（S28 计数归零）在 S3 验收;ADR-R28-01 复审条件②（S31 复看）随 S1;ADR-R26-01 的同意门在 Track2 的适用性随 S1 落地闭合。

## 历史决策登记（迁移自既有代码语义,防遗失）

- Manifest v1 无 capabilities → `capabilitiesDeclared=false` → 跳过 T2.2 授权门且 legacy 分支放行 fs。此为兼容策略,但等于"旧插件默认高权"——P2 权限闭环须将其收敛为显式兼容权限集（RFC §18.1）。
- `LexiUpdatePolicy` 首装不询问（注释明示走启用即授权）——与 P5-004（安装即展示权限清单）的衔接点,已复审收口:见 ADR-R26-01（授权发生在启用口,不在安装口拦截）。
