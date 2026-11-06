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

## 历史决策登记（迁移自既有代码语义,防遗失）

- Manifest v1 无 capabilities → `capabilitiesDeclared=false` → 跳过 T2.2 授权门且 legacy 分支放行 fs。此为兼容策略,但等于"旧插件默认高权"——P2 权限闭环须将其收敛为显式兼容权限集（RFC §18.1）。
- `LexiUpdatePolicy` 首装不询问（注释明示走启用即授权）——与 P5-004（安装即展示权限清单）的衔接点,届时复审。
