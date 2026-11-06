# PROGRESS — 逐轮工程进展

## Round 24 — 2026-11-06（B-009b 复盘定案：**误诊证伪 + 三缺陷修复 + 双插件并发沙箱真机验收**）

**当前 Phase：** Phase 1。P1-003b 多插件并发装载解锁。

### 本轮完成

1. **B-009b 证伪（核心成果）**：重审 Round 23 证据日志（/tmp/r23d.log 幸存）+ 双夹具源码对比，判定"第二个及之后 iframe postMessage 丢帧"为**误诊**——
   - 日志铁证：两个 iframe 的 init 均 `port=MISSING`（容器轨对**任何** iframe 都不转移 port）；`bootPlugin: sandbox-sample-min` 已执行（宿主→容器→iframe 装载链对第二 iframe 完好）；probe 成功用帧是 `id=w1`（=parentRequest window 通道前缀），与其"第一/第二"序位无关。
   - 真根因①（主因）：`SandboxPlugin.loadData/saveData/addCommand/Notice/vault` 全走 port 路 `request()`，而 `postToHost` 在 `port` 缺失时**先静默 return 再打日志** → 帧从未发出、`await loadData()` 挂死 onload → "零帧零日志"假象。probe 正常纯因其夹具直接调 `app.request`(=parentRequest)。
   - 真根因②：容器网关把 `call()` 的 RPC 响应封套 `{ok,result,error,code}` 整个塞进 frame.data，iframe 未解封套 → `loadData` 把封套当数据体（磁盘铁证：data.json 出现 `{"runCount":0,"ok":true,"result":null,...}` 噪声）。
   - 真根因③：`sandboxCommands` 误置于 `bootPlugin` 函数作用域（跨作用域引用必 ReferenceError）+ window listener 缺 `sandbox.command` 分支（容器轨命令回环必断）。
2. **修复（单文件 `lexinote_plugin_sandbox.html`，5 处）**：①`request()` port 缺失回落 `parentRequest`（window 通道，身份仍由容器 event.source 反查覆写，语义不变）；②`postToHost` port 缺失留痕丢弃（不再静默）；③window 响应分支解一层 RPC 封套（两轨语义对齐，loadData/vault/metadata 全部消费者受益）；④命令表提升 IIFE 级 + 双通道共用 `runSandboxCommand`；⑤parentRequest 发送留痕 + 假 "sandbox.boot posted" 日志改诚实。
3. **门禁固化**：plugin-context-isolation.cjs +S23（回落语义）/S24（丢弃留痕）/S25（命令表两通道共用）→ 40/40；symbols.json 修复 Round 23 遗留 2 处行号锚点（LexiPluginRuntime.ets 1538→1540、1345→1348，invokePluginCommand 收窄位移所致，非本轮引入）。
4. **真机验收（lexi_2in1，全链 hilog + 磁盘铁证）**：
   - **双 iframe 并发**：probe(ctx-2) 与 sample-min(ctx-3) 帧交错双向零丢失（`->arkts ctx-2/ctx-3` 交错出现、各自 `<-arkts id=wN ok=true` 独立配对）——**"ArkWeb 同页多 sandboxed iframe 丢帧"命题被正面证伪**；
   - sample-min 全链：data.load→data.save→commands.add×2（宿主注册 `record-run`/`create-log`）→vault.files→onload done；
   - **命令回环端到端**：命令面板点击 → 容器 `命令已回推沙箱` → iframe **window 通道新分支** `命令执行: sandbox-sample-min:record-run` → 回调 saveData → 插件自证 `record-run: count=1`；
   - 磁盘铁证：sample-min data.json = `{"runCount":1,"bootOk":true,"lastRunAt":…}`（封套修复后契约形状精确）；probe data.json = `{"marker":"sandbox-probe-ok"}` 回归无污染。

### 修改文件

`entry/src/main/resources/rawfile/lexinote_plugin_sandbox.html`、`scripts/tests/plugin-context-isolation.cjs`、`tools/contract/symbols.json`（2 锚点）、rfcs/implementation 四记录。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-context-isolation.cjs` ×2（每次修改后） | **PASS 40/40** |
| `plugin-contract-matrix.cjs --fixtures-required` | 首轮 2 锚点脱节（Round 23 遗留）→修正后 **PASS** |
| `release-gate --ci` ×2（含封套修复后复跑） | **PASS 29/29** |
| `hvigorw assembleHap` ×2 | **BUILD SUCCESSFUL** |
| 真机双插件并发链+命令回环（2in1） | **PASS**（铁证见上；首轮 MCP install 未替换，改 `bm install -r` 后正常——设备流程记入 quirk） |

### 兼容性影响

- 沙箱轨 API 面行为修复，旧轨（PoC port 通道）路径零改动；宿主 ArkTS/网关零改动；夹具零改动。
- `loadData` 语义修正为返回内层数据（与旧轨宿主页行为一致）——沙箱轨尚无第三方存量，无迁移负担。

### 尚存风险

- 容器网关响应仍以封套字符串过 runJavaScript（双编码形态）——已在 iframe 侧对齐,若后续扩 RPC 面（流式/二进制）需重估该契约。
- 命令回环的编辑器命令执行面（editorCallback）未实现（Round 23 登记,后续切片）。
- sample-min `vault.files=0` 为空库真值,路径级 vault 授权（P2-004）未在沙箱轨专项验证。

### 下一轮

**P1-003c**：构建期 CommonJS→IIFE + 宿主页面 CSP 收紧（移除 unsafe-eval）——沙箱轨已可承载验收。备选并行：P2-009 生命周期状态机补全。

最近更新时间：2026-11-06（Round 24）。

---

## Round 7 — 2026-11-03（基线 `main @ c1863ff`）

**当前 Phase：** Phase 0 完成（P0-001/P0-002 交付）；进入 Phase 1/5 安全任务流。

### 本轮完成

1. **P0-001 全量审计（VERIFIED）**：三路并行源码审计，RFC P0-01..P0-04 全部证实并补充更严重事实：
   - P0-01 证实且低估——除 headless runtime 轨道外，workspace 轨道（手机默认打开笔记路径）同样共享 realm `new Function`；沙箱 PoC 组件被 Index.ets 挂载但仅跑探针。
   - P0-02 部分证实——宿主 credential→pluginId 映射为 CSPRNG 且 fail-closed；但 `LexiObsidian.currentToken()` 回落裸 sessionToken、`app.plugins.getPlugin()` 暴露他插件 `__lexiToken`（身份盗用面）。
   - P0-03 证实且更糟——v2 细粒度视图在 `LexiPluginManifest` 边界销毁；`vault.read` 零 capability；`storage.quotaBytes` 反向绑 vault.write；指纹只覆盖 3 类标签→权限扩张静默继承。
   - P0-04 证实且现行——默认生产索引为无 sha256 裸数组；空哈希跳过比对（fail-open）；装完自动 enable 无授权 UI；`LexiRegistryTrust` 宿主零引用；撤销列表永不填充；一键明文 http 演示源。
   - 定位修正：`LexiSandboxHost.ets` 在 `entry/src/main/ets/components/plugin/`；无 `LexiPluginManager.ets` 文件（类在 `LexiPluginRuntime.ets:409`）；更新策略文件为 `LexiUpdatePolicy.ets`。
2. **P0-002 工程体系（IMPLEMENTED）**：本目录 8 份记录 + `rfcs/third-party-plugin-ecosystem-rfc.md` 全文进仓库（`docs/` 被 gitignore，RFC 与记录不得依赖 docs/）。
3. **P5-001 远程安装 fail-closed 信任闸门（IMPLEMENTED，真机 UI 待验）**：
   - `LexiPluginMarketModel.ets`：新增唯一判定 `isTrustedInstallHash()`（64 位小写 hex）。
   - `LexiPluginRuntime.ets`：`installFromUrl` 在**下载之前**拒绝空/非法哈希（本地 `installZip` 侧载保留空哈希语义——双信任策略）；`fetchMarketIndex` 记录 warnings。
   - `LexiPluginMarketSheet.ets`：安装口同判定拦截 + 按钮禁用 + 「哈希已校验/旧版·缺哈希」标识 + 旧版索引 warnings 上屏。
   - 测试：dist-regression +2 用例（判定语义 + 接线/顺序断言）18/18；market-regression +1 用例（旧版可展示但不可信）4/4。

### 修改文件

`entry/src/main/ets/core/plugin/LexiPluginMarketModel.ets`、`entry/src/main/ets/core/plugin/LexiPluginRuntime.ets`、
`entry/src/main/ets/components/plugin/LexiPluginMarketSheet.ets`、`scripts/tests/plugin-dist-regression.cjs`、
`scripts/tests/plugin-market-regression.cjs`、`tools/contract/symbols.json`（仅手工修正因行号位移脱节的 2 个锚点：
1459→1467、1271→1279；**未**采用 `generate.cjs` 重生成，因其解析器与对账器不一致会弄坏另外 5 个 shim 锚点——缺陷记 P0-005）、
新增 `rfcs/` 全部文件。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `node scripts/tests/plugin-market-regression.cjs` | PASS 4/4 |
| `node scripts/tests/plugin-dist-regression.cjs` | PASS 18/18 |
| `node tools/plugin-dist/release-gate.cjs --ci` | 首轮 27/28（contract-matrix 因我的行号位移报 2 处锚点脱节）→修正后 **PASS 28/28** |
| `hvigorw.bat assembleHap --mode module -p product=default` | **BUILD SUCCESSFUL**（CompileArkTS 通过） |
| `node scripts/tests/plugin-contract-matrix.cjs --fixtures-required` | PASS（锚点修正后） |
| 真机（plugin-dist-flows 市场 UI 全流程） | BLOCKED——模拟器错误 00801005（B-001），且演示源索引已带 sha256 不受闸门影响（flows 脚本 server 语义核对过） |

### 兼容性影响（重要）

- **行为变化：** 现行发布索引 `tools/lexinote-releases/community-plugins.json` 为无哈希裸数组 → 升级后市场条目显示「缺哈希」不可安装。这是 RFC P0-04 要求的 fail-closed 语义，但**真实市场恢复可用需要 P5-006 升级发布索引**（涉及对外仓库推送，需用户授权）。
- 本地侧载、演示源（schemaVersion=1 带哈希）不受影响；旧 API 未动。

### 尚存风险

- 自述哈希只保证完整性，不保证来源（authenticity）——TUF 接线在 P5-002；明文 http 演示源仍在（P5-005）。
- 装完自动 enable + 无授权 UI 未变（P5-004，下一个安全 P0）。
- 沙箱主缺陷（P0-01/P0-02）仅新增审计定位，代码未动（P1 序列）。

### 下一轮任务

1. **P5-006**（发布索引升级到 schemaVersion=1+sha256 的本地准备 + 提请推送授权）。
2. **P1-006**（页面级身份暴露面移除，纯本地安全缺陷）。
3. 视进展 P2-001/002。

---

## Round 8 — 2026-11-03（基线 `main @ c1863ff` → `29abe91`/`83be122` + 本轮）

**当前 Phase：** P5-001 **VERIFIED（离线+真机四流程）**；Phase 1 获得首条决定性真机证据（沙箱 PoC 静默失效）。

### 本轮完成

1. **Round 7 提交**（用户授权）：`c8fd04c` rfcs 体系、`29abe91` P5-001。
2. **P5-006 本地准备（IMPLEMENTED）**：`83be122` — 发布镜像改严格 `schemaVersion=1`（空 plugins，删除指向不存在仓库的 market-demo 死条目）；`validate.mjs` 重写为客户端同口径（sha256 必填/https/id 格式）+ `--remote` 实测 zip 字节哈希；README/工作流同步。门禁新三方一致用例（客户端=共享校验器=发布仓 CI 校验器）。**发现：GitHub 上 `lexinote-releases`/`lexinote-market-demo` 均不存在（404）——默认市场 URL 一直是死链，不存在"升级破坏真实用户"的问题；公开发布=新建公开仓库，属 ADR-015/§10 决策点，未执行。**
3. **真机批次首次跑通（B-001 解除）**：环境事实：实例 `lexi_2in1`（桌面宽布局，flows 自动化标定形态），`Emulator.bat -start lexi_2in1 -noWindow` + `hdc tconn 127.0.0.1:5555`；**`lexi_phone` 窄布局首页没有 `workspace-action-dock-profile`，flows 不适用于 phone 实例**（非产品缺陷，测试形态错配）。
4. **P5-001 真机验收 PASS**：`plugin-dist-flows --run --flow install|upgrade|rollback|uninstall` 全部通过（证据 `.fixtures-out/evidence/20261103-213058`…`-213656`）：哈希合法条目正常安装；篡改 zip → UI `integrity_mismatch`、指针不动、无残留；升级保数据、回滚可再 onload、卸载入 `.trash` 重启不复活。
5. **KI-4 定位并修复（真机新缺陷,当日闭环）**：运行时安装的插件"装得上却永不 onload"——`scanPluginDir` 不做 `discovered→installed` 记账（全仓唯一 `markInstalled` 在启动路径 `init():765`），`enablePlugin` 被迁移表拒绝。修复 4 行 + dist-regression 接线断言钉死；`hilog.log:31902` `插件 onload 完成: dist-flow-probe` 为修复证据。**教训：28 步离线全绿测不出 Runtime 接线级缺陷——设备批次必须重新进门禁计划（P0-003 时纳入）。**
6. **P1-001 首条真机结论（关键负面证据）**：ArkWeb API 26 上沙箱 PoC **完全静默**——`lexinote_sandbox_poc.html` 加载后，iframe 目标文档 `lexinote_plugin_sandbox.html` **零资源请求**、零 `[lexinote][sandbox]` console 输出（phone/2in1 双实例一致）。RFC 的 `iframe sandbox="allow-scripts"` 隔离模型在 ArkWeb 上不可按 Chromium 语义假设。假说清单（下轮插桩定位）：a) PoC 页 CSP 缺 `frame-src`；b) ArkWeb 对 sandboxed iframe 的 src 加载限制；c) JS 早期异常吞掉建 iframe 代码。新增 B-008/P1-001a。

### 修改文件

`entry/.../LexiPluginRuntime.ets`（scanPluginDir 记账）、`scripts/tests/plugin-dist-regression.cjs`（+1 接线断言）、`tools/contract/symbols.json`（+4 行位移的 2 锚点手工再修）、`tools/lexinote-releases/*`（P5-006）、`tools/plugin-dist/known-issues.md`（KI-4）、rfcs 记录。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-flows --run --flow install`（2in1 修复前/后各一次） | 前：**1 FAIL（KI-4）**；后：**PASS** |
| `plugin-dist-flows --run --flow upgrade / rollback / uninstall`（2in1） | **PASS×3** |
| `hvigorw assembleHap` | **PASS**（21:30 产物即上机包） |
| `release-gate --ci` | 首轮 27/28（锚点位移）→ **PASS 28/28** |
| 沙箱 PoC hilog 取证（phone 30s + 2in1 35s） | **FAIL/静默**（见上,已立项 B-008） |
| `validate.mjs --remote` | NOT RUN（zipUrl 指向未发布的仓库；发布时由该仓 CI 执行） |
| KI-1 `--market-repro` N=3..8 | NOT RUN（本轮未做规模复现） |

### 兼容性影响

- 镜像索引改为空 v1：客户端市场页显示"市场为空"（此前为 404 报错），语义改善无回归。
- `scanPluginDir` 记账对启动路径幂等无副作用；broken 目录不记账（维持不可启用）。

### 尚存风险 / 下一轮

1. **P1-001a（最高优先）**：沙箱 PoC 静默根因插桩定位（CSP frame-src 假说优先，改动最小、可离线复现于设备）；产出 ADR 决定隔离载体（iframe vs 其他 ArkWeb 原语）。
2. **P1-006**：页面级身份暴露面移除（`currentToken()` 回落/`__lexiToken`）。
3. **P5-004**：安装后不自动启用 + 授权清单 UI（真机证据链已具备回归条件）。
4. 用户决策点：是否新建并公开 `lexinote-releases` 仓库（ADR-015 建议：安全闭环前保持不发布；当前闸门+空索引已可支撑私有演练）。

---

## Round 9 — 2026-11-03（P1-001a：沙箱 PoC 真机静默根因定位 → **真机 verdict PASS**）

**当前 Phase：** Phase 1 关键解锁——RFC §3.2 隔离载体（sandboxed iframe + opaque origin + DOM MessageChannel）**已在 ArkWeb API 26 真机验证可行**；B-008 关闭。

### 本轮完成

1. **B-008 根因战（三层缺陷，逐层真机插桩定位）**：
   - **根因①（完全静默）**：宿主页引导逻辑内联，而该页 CSP `script-src 'self'` 标准语义拦杀内联 → `boot()` 从未执行 → iframe 从未创建。离线门禁 S4-S8 只扫 html 文本，逻辑内联时"全绿却真机静默"。**修复**：逻辑外置 `lexinote_sandbox_poc.js`；CSP 补 `child-src/frame-src 'self'`（防御性；实测 ArkWeb 未拦 iframe——`origin=null` 见证 opaque origin 成立）；门禁加 S20/S20b/S21 结构断言。
   - **根因②（boot 抵达却被丢）**：子上下文 `postToHost()` 不带 `__lexiSandbox` 协议标记，宿主首行标记过滤 → 沙箱→宿主端口消息全部静默丢弃。修复一行 + 门禁 S22 钉死。
   - **根因③（首份真机 verdict 的假阳性）**：探针 sibling-iframe 向量只测 `frames[0]`——对第一个上下文那是**自己**，读自己 DOM 被误报"兄弟泄漏"。修复：全量枚举 + `f === window` 排除自身；E1/E2 离线语义回归通过。
2. **真机终验（22:09，hilog 铁证）**：`PoC verdict: PASS contexts=2/2`，双上下文各 `vectors=10/10 blocked credentialHits=0`；里程碑链完整（bootstrap→bound(ports=1,sourceIsParent=true)→boot(leaks=0)→ping/pong→verdict）。**ADR-R8-01 关闭**：ArkWeb API 26 支持 sandboxed iframe 加载、opaque origin、端口转移与双向投递、`event.source` 校验——**iframe 路线可行，RFC §3.2/§3.3 模型无需修订**；ping/pong 与里程碑打点作为常驻真机见证保留。
3. **发布通道接通（用户总授权）**：`lexinote-releases` 公开仓库创建并推送（空 `plugins[]` 严格 v1 索引——无任何条目可安装，非"开放市场"；市场页从 404 变为"市场为空"）。默认 URL `raw.githubusercontent.com/ZhangJing-gugugaga/lexinote-releases/master/community-plugins.json` 实际可达性验证见测试表。

### 修改文件

`lexinote_sandbox_poc.html`（重写：外置+CSP frame 面）、`lexinote_sandbox_poc.js`（新建：引导逻辑+ping/pong 见证）、`lexinote_plugin_sandbox.html`（标记修复+里程碑打点）、`lexinote_sandbox_probe.js`（V3 假阳性修复）、`plugin-context-isolation.cjs`（S20/S20b/S21/S22，36 项）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-context-isolation.cjs` | **PASS 36/36**（+5 断言） |
| `hvigorw assembleHap` + `hdc install -r` ×3（定位迭代） | **PASS** |
| 真机 hilog 取证 ×4 | 终轮 **verdict PASS** |
| `release-gate --ci` 全量 | 见收尾提交（rawfile 变更由 context-isolation 门禁覆盖） |
| 默认市场 URL 可达性 | 见收尾（发布后 curl 验证） |

### 尚存风险 / 下一轮

- 沙箱页 `unsafe-eval` 仅限 PoC 实验载体；正式运行时（P1-003）必须按 RFC §3.2 消除宿主 eval（构建期 IIFE）。
- 10 向量 ≠ SEC 全表；SEC-006/007/013 待业务运行时接入后补（P1-009）。
- 下一轮：**P1-006**（页面级身份暴露面移除——P0 安全缺陷，本地可做）→ P0-003（根 CI）→ P2-001/002。

最近更新时间：2026-11-03（Round 9）。

---

## Round 10 — 2026-11-03（P1-006：插件可及身份暴露面收口）

**当前 Phase：** Phase 1。身份面安全缺陷（RFC P0-02 的页面侧半边）离线闭环+真机回归中。

### 本轮完成

1. **P1-006 实施（见 ADR-R10-01）**：
   - `currentToken()` 栈空回落 `sessionToken` → **空串**（宿主 anonymous fail-closed；同时封死"裸异步排定时器→捕获会话身份→控制面可达"升格链）。
   - `__lexiToken` 属性形态（插件实例/leaf/EditorProxy）**全部迁入闭包 WeakMap** `objectIdentityTokens`（`setObjectToken/objectToken`），代码体属性形态被 bridge-security R7a 永久禁绝。
   - 公共面删除 `currentToken/withToken/hostCall`（容器 bundle 实测零消费）；`loadPlugin/unloadPlugin` 装载口保留（R6h 防误删）。
   - 布局管理面（persistLayout/restoreLayout/saveLayout/markLayoutReady）**显式携带闭包 sessionToken**——宿主页自身组件用自有凭据，与插件兜底路径彻底分离；视图创建/关闭全链经 leaf 归属令牌执行。
   - 攻击探针 cap-probe-unauth/open 升级为 P1-006 语义：入口面自检（三个 typeof 必须 undefined）+ 冒名走正规 requestUrl（`capability_denied` 证据锚点保持）+ 新增 `cap.identity.stolen` 盗读回归探针 + `NO_MANUAL_ENTRYPOINT` 结论分支。
2. **门禁**：bridge-security 34/34（新增 R6f/R6g/R6h 行为级、R7a-d 静态）；identity-model 分类器识别 WeakMap 包装形态（wrapper 判定本质不变=同步栈有令牌）；identity-delivery --strict **30/30 traced, 0 gaps**。channel-audit 曾被注释里的 `hostCall('note.write'…)` 字面量误报死通道——改写注释措辞（门禁字面量匹配教训记录进台账）。
3. **真机回归（Round 10 收尾更新）**：独立进程链式 **install→upgrade→rollback→uninstall 四流程全 PASS**（证据 20261103-230728/230828/230855/231445；rollback 断言 previousVersion=1.1.0、重启后 onload+命令执行全绿——身份新语义完整闭环）。期间发现并修复一处真实回归：**容器 restoreLayout 路径 makePluginLeaf 现场捕获空栈** → 恢复视图的 openView/closeView 匿名化；修复为恢复循环内 `setObjectToken(leaf, sessionToken)`（与 persistLayout 同理：容器管理动作显式会话凭据）。修复后重装冷启：**denied 分布与基线一致**（仅预存在的 adapter-probe vault.files 匿名一条，无新模式）。另立 **P0-009**：单进程 `--flow all` 在默认市场源上线后首步失联（同构建分进程链式全绿→flows 工具跨流程状态缺陷，非产品缺陷）。
4. **新登记**：**P1-006b**（残余面：同 realm `__receive` 可被触发 invoke.command 跨插件回调——需 dispatch 通道鉴权,.ets 协议面,技术论证先行）；**P0-008**（shim-regression 手工门禁 bit-rot：HEAD 上即红，harness 缺 DOM stub，stash 对照证实非本轮引入）。

### 修改文件

`lexinote_plugin_shim.js`（身份模型）、`plugins/cap-probe-unauth/main.js`、`plugins/cap-probe-open/main.js`、`scripts/tests/plugin-bridge-security.cjs`、`scripts/tests/plugin-identity-model.cjs`、`tools/contract/symbols.json`（6 锚点 +15 位移修正）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-bridge-security.cjs` | **PASS 34/34** |
| `plugin-identity-delivery.cjs --strict` | **PASS**（traced 30/30） |
| `release-gate --ci` | **PASS 28/28** |
| `plugin-shim-regression.cjs` | FAIL——**bit-rot 预存在**（HEAD 即红，已登记 P0-008，非本轮） |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启 hilog | onload（sample/adapter-probe）✔、匿名拒绝基线一致；tasks `@codemirror/view` 为 P4-004 已知 |
| 真机 flows install | **PASS**；rollback 前置污染已识别,重跑收尾（见上） |

### 尚存风险 / 下一轮

- flows rollback/upgrade 重跑结论落地后才把 P1-006 记 VERIFIED。
- P1-006b（__receive 门卫）→ 下一轮候选，含技术论证。
- 下一轮主任务：**P2-001+P2-002**（v2 细粒度视图透传 + 能力指纹正典化与迁移——权限闭环先决两步，本地可验证）。

最近更新时间：2026-11-03（Round 10）。

---

## Round 11 — 2026-11-04（P2-001 + P2-002：权限闭环先决两步）

**当前 Phase：** Phase 2 启动。v2 细粒度能力从"解析器私有"变为"执行面与授权链可见"。

### 本轮完成

1. **P2-001 视图透传**：`LexiPluginManifest` 新增 `v2: LexiManifestV2Caps` 字段，`manifestFromV2` 透传 `normalized.v2`——此前在解析边界被销毁的 paths/methods/quota/notifications 现在执行面可读（P0-03 机械根因消除）；v1 清单保持默认全关（§8.2 旧权限不自动细粒度化）。
2. **P2-002 标签唯一正典**：`LexiPluginManifestV2.capabilityTagsOfV2Caps()` 按 RFC §4.4 全维度产出标签（vault.read/write[:path]、vault.delete、editor.*、workspace.*、network:origin、netmethod/netreq/netres、clipboard.read/write、storage.quota、notifications）；runtime `capabilityTagsOf` 与 installer `manifestCapabilityTags` 两份粗粒度副本**归一为同一函数的 v2 分支**（v1 保持 legacy 三标签）。
3. **指纹语义（零迁移代码的正确解）**：数字上限恒入标签 ⇒ 配额/方法/路径扩张必然改变指纹 ⇒ `decisionFor` 自动 regrant-required——审计担心的"权限扩张静默继承"（P0-03 后果）由数据结构天然封死；v1/无声明插件标签集为空 ⇒ 指纹不变 ⇒ 用户零打扰。**无需 SCHEMA bump**：旧记录载入后指纹不匹配即触发一次性重确认，安全语义自动成立。
4. **门禁**：manifest-v2 新增 V4.4/V4.5 接线断言 + **V5 行为段**（真转译 Manifest+V2 双文件：穿透断言、v1 不继承、11 维标签产出、扩张/配额/方法变更必改标签集）39 项全绿；permission-store 新增 **P5 指纹级行为段**（真实正典标签 → fingerprintOf → decisionFor：同能力延续/编辑器写扩张重问/配额扩张重问/撤销即拒）28 项全绿。

### 修改文件

`LexiPluginManifest.ets`、`LexiPluginManifestV2.ets`、`LexiPluginRuntime.ets`、`LexiPluginInstaller.ets`、`plugin-manifest-v2.cjs`、`plugin-permission-store.cjs`、`tools/contract/symbols.json`（1 锚点 +1 位移）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-manifest-v2.cjs` | **PASS 39/39**（+8） |
| `plugin-permission-store.cjs` | **PASS 28/28**（+4 行为断言） |
| `release-gate --ci` | **PASS 28/28**（锚点修正后） |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启（装机+启动 50s 窗口） | **PASS**：onload 2/2、**regrant 触发 0**（v1 基线无扰动）、denied=1 与基线一致 |

### 尚存风险 / 下一轮

- v2 插件的 regrant 通道仍缺 UI（P2-008：grant/revoke API 零调用方、regrant-required 仅 errorState 文案）——用户侧闭环是 Phase 2 下一个大块。
- P2-003（broker capability 泛化）依赖本两步已就绪：execution 面现在能读 `manifest.v2`。
- 下一轮：**P2-003 + P2-004**（broker capability 授权面扩展 + vault 路径级授权——首个真正消费 `manifest.v2.paths` 的执行面）。

最近更新时间：2026-11-04（Round 11）。

---

## Round 12 — 2026-11-04（P2-003 + P2-004：capability 授权面 + vault 路径级授权）

**当前 Phase：** Phase 2。`manifest.v2` 首批真实消费点上线，未声明=拒绝开始生效（仅 v2 清单；存量 v1 零扰动）。

### 本轮完成

1. **P2-003 broker capability seam**：`LexiPermissionBroker` 新增第二可选注入 `LexiCapabilityGate`（未注入=既有纯角色行为，旧门禁/调用方零破坏）；runtime 注入 `capabilityAllowedFor`（方法→能力域→manifest.v2：vault.read/metadata→vault.read.enabled、editor.state→readActive、editor.replace/applyChanges→writeDocument、editor.selection→writeSelection、commands.add→workspace.commands、views.add→workspace.views、codeblocks.register→editor.extensions、ui.notice→notifications）；**fs-write 与 capabilityGate 是两个独立 seam**（M2.48 断言互不干扰）；`fsAllowedByManifest` 升级为 delete 独立键（v2 只声明 write 不能删除——P0-03 收口）；**data.load/save 与 vault.write 解绑**（审计确认的反向绑定修复：只声明 storage 的 v2 插件可用自己的 data.json，v1 保持旧门）。
2. **P2-004 路径级授权**：`LexiPluginManifest.vaultPathAllowed()` 单一正典（前缀/单段通配/跨段通配/精确；enabled=false 一律拒；空 patterns=全库）；写路径在 `fsGate(identity, method, path)`（6 handler 全接线；**rename 源与目标双检查**——防借改名把内容移出白名单）；读路径在 `vaultReadGate`（vault.read/vault.getByPath）；broker gate 判域声明 + handler 判路径——两层纵深。
3. **门禁**：authz-matrix 新增 M2b 组 9 条（gate 放行/拒绝/按方法区分/session 豁免/未注入兼容/双 seam 独立）；manifest-v2 新增 V5b 组 4 条（glob 语义真跑，含 SEC-009 相关的"单段不跨段"）；dist-regression §6 新增 4 条接线断言（双 seam 注入、vaultReadGate、rename 双端、data.* 解绑）。
4. **过程教训（记录）**：ArkTS doc 注释内写 `'**/*.md'` 示例——`*/` 序列把块注释提前闭合导致转译崩（已改写措辞）；gate 类测试的模块导出层是 `mod.exports` 不是外壳。

### 修改文件

`LexiPermissionBroker.ets`、`LexiPluginRuntime.ets`、`LexiPluginManifest.ets`、`plugin-authz-matrix.cjs`（+9）、`plugin-manifest-v2.cjs`（+4）、`plugin-dist-regression.cjs`（+4）、`tools/contract/symbols.json`（2 锚点）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-authz-matrix.cjs` | **PASS**（+M2b 9 条） |
| `plugin-manifest-v2.cjs` | **PASS**（+V5b 4 条） |
| `plugin-dist-regression.cjs` | **PASS 19/19**（+4 接线断言） |
| `release-gate --ci` | **PASS 28/28**（锚点修正后） |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启冒烟 | **PASS**：onload 2/2、denied=1 与基线一致、capability.path 触发 0（v1 零扰动）、无新装载失败 |

### 尚存风险 / 下一轮

- v2 收紧面尚无真实 v2 插件消费（设备存量全 v1）——P4-005 夹具梯需造 v2 夹具验证收紧路径的正/负例。
- 管理面方法（ui.addRibbon/app.localStorage/settings.*）暂无 v2 键→放行（EXECUTION_PLAN 已登记待 manifest 键补齐收口）。
- 下一轮：**P2-005（storage 配额执行）+ P2-008（权限 UI：授权清单/grant/revoke/regrant 通道）**。

最近更新时间：2026-11-04（Round 12）。

---

## Round 13 — 2026-11-04（P2-005：storage 配额宿主端强制执行）

**当前 Phase：** Phase 2。

### 本轮完成

1. **P2-005**：`storageQuotaGate`——data.save 落盘前按 `manifest.v2.storage.quotaBytes` 拒绝超限写入（`capability.quota` 审计行 + `ERR_PERMISSION_DENIED` 错误码）；v1/legacy 沿用无配额旧语义；字节账按 UTF-16 码元近似（注释声明，精确字节账随编码器接入校准）。RFC §10.1"配额必须由宿主强制执行，不能只在 manifest 声明"落地。
2. **门禁**：dist-regression §6 +2 接线断言（gate 存在 + data.save 落盘前调用）。
3. 附带修正：contract-matrix 2 锚点位移（+5/+5）手工再修。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-regression.cjs` | **PASS 19/19**（+2） |
| `release-gate --ci` | **PASS 28/28** |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启 | **PASS**：onload 2/2、quota 触发 0（v1 基线）、denied=1 与基线一致 |

### 下一轮

**P2-008 权限管理 UI**（授权清单展示 + grant/revoke/regrant 通道 + `optionsJson.grantApproved` 透传）——Phase 2 用户侧闭环的最大块；随后 P2-009/P2-010。

最近更新时间：2026-11-04（Round 13）。

---

## Round 14 — 2026-11-04（P2-008：权限管理 UI 与 grantApproved 通道闭环）

**当前 Phase：** Phase 2。

### 本轮完成

1. **grantApproved 死端修复（审计 Round 7 确认的缝）**：`installZip(zipSource, expectedSha256, optionsJson)` 与 `installFromUrl(..., optionsJson)` 透传安装选项；**grantApproved 安装按新清单落账授权再启用**（`permissionStore.grant(manifest.id, version, capabilityFingerprintOf(manifest))` + persist）——否则 enablePlugin 授权门仍会打回 regrant-required（此前 UI 永远无法确认，§9.5 通道死端）。
2. **MarketSheet UI 闭环**：升级遇 `ERR_PERMISSION_REGRANT_REQUIRED` 不再只是失败文案——`pendingGrantEntry` 暂存 + 显式"重新授权并安装"确认行（点击后以 grantApproved 重装）；已安装行新增**权限标签展示**（`manager.permissionTagsOf` → '权限: vault.write · network:api.example.com …'，空集显示"未声明能力"）与**撤销授权按钮**（`revokePluginPermissions` → 立即停用）。
3. **门禁**：dist-regression §6 +4 接线断言（installZip/installFromUrl 三参、grantApproved→grant 落账锚、permissionTagsOf）；旧锚 installFromUrl 双参签名同步更新。
4. 过程记录：多行正则锚的转义改用一次性 node 脚本处理（shell 内联转义易错）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-regression.cjs` | **PASS 19/19**（+4） |
| `plugin-error-visible.cjs` / `plugin-update-policy.cjs` | PASS（UI 文案与更新策略不回归） |
| `release-gate --ci` | **PASS 28/28**（锚点修正后） |
| `hvigorw assembleHap` | **PASS** |
| 真机 `flows --flow install` | **PASS**（新 UI 下市场自动化不回归；无 regrant 场景确认行不渲染） |

### 尚存风险 / 下一轮

- grantApproved 正例（真实 v2 权限增长安装）需 v2 探针夹具——P4-005 夹具轮补设备证据；离线链路已由接线断言+update-policy 真跑覆盖。
- 下一轮：**P2-006（network methods/字节上限执行）+ P2-009/P2-010（生命周期状态机补全 + 撤销立即生效）**。

最近更新时间：2026-11-04（Round 14）。

---

## Round 15 — 2026-11-04（P2-006：network 方法白名单与字节上限执行）

**当前 Phase：** Phase 2。

### 本轮完成

1. **P2-006**：`LexiNetProbe` 三道既有门禁（令牌归属/一致性/origin 白名单）之后新增 P2-006 两类约束——①**方法白名单**：v2 清单 `network.methods`（空声明=只读默认仅 GET；声明清单外方法拒绝；v1 保持 GET/POST 双法语义）；②**字节上限**：请求体超 `maxRequestBytes` 拒发（传输 0 次）、响应体超 `maxResponseBytes` 弃包不交付。全部在触碰传输前判定（"拒绝即不留半发"语义延续）。
2. **门禁**：net-request-url 新增 8b 组 7 条（白名单拒/空声明只读/请求超限/响应弃包，全部真跑假传输）；18.8 结构锚更新为单一 manifestFor 形态（消重复调用）。**83 断言全绿**。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `net-request-url.cjs` | **PASS 83 断言**（+7） |
| `release-gate --ci` | **PASS 28/28** |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启 | **PASS**：onload 3、denied=1 基线、net 拒绝 0（v1 插件无网络声明，不触发新门） |

### 下一轮

**P2-009/P2-010（生命周期状态机补全 + 撤销立即生效：token 吊销接线）**；随后 Phase 2 exit criteria 复核 → 进入 P1-003 沙箱主改造。

最近更新时间：2026-11-04（Round 15）。

---

## Round 16 — 2026-11-04（P2-010：撤销立即生效——版本门短路修复）

**当前 Phase：** Phase 2。

### 本轮完成

1. **P2-010 核心缺口修复**：审计确认 `enablePlugin` 授权门包在 `capabilitiesDeclared` 内——**v1 插件被用户撤销后仍可重新启用**（撤销语义被版本门短路）。修复：`revoked` 状态检查前置到版本门之前（`grantOf(pluginId).state === 'revoked'` → 拒绝启用 + errorState），对全部清单版本生效；指纹级 regrant 与首启落账仍只对声明型清单（v1 存量"启用即授权"语义不变）。
2. **撤销通道现状盘点**（本轮核实）：撤销 → `permissionStore.revoke` + `disablePlugin` → **token 吊销已内建**（`revokePluginTokens` 在 disable 回收序中）→ 既有通道后续 RPC 按 anonymous fail-closed；扩展/视图/命令回收同链。UI 通道（撤销授权按钮）Round 14 已接。剩余待办：撤销后既有 MessagePort 的消息面清理——随 P1-003/005 沙箱通道收敛一并处理（已在本任务备注）。
3. **门禁**：dist-regression §6 +1（revoked 检查必须先于版本门的顺序断言）；PERMISSION_REVOKED import 清理（改为直接状态查询）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-regression.cjs` | **PASS 19/19**（+1） |
| `release-gate --ci` | **PASS 28/28** |
| `hvigorw assembleHap` | **PASS** |
| 真机冷启 | **PASS**：onload 3、denied=1 基线、revoke-deny=0（设备无已撤销插件，负例待 v2/v1 撤销夹具 P4-005） |

### 下一轮

Phase 2 收尾复核（exit criteria 对照）→ **P1-002/P1-003 沙箱主改造启动**（执行上下文模型定案 ADR → Runtime 轨道 iframe 接入）。

最近更新时间：2026-11-04（Round 16）。

---

## Round 17 — 2026-11-04（P2-011：RPC↔权限 100% 行为对账 + Phase 2 复核）

**当前 Phase：** Phase 2 收尾。

### 本轮完成

1. **P2-011 全矩阵扫描**：authz-matrix 新增 M2c 段——对 broker 全部 68 个登记方法 × 4 种角色（anonymous/session/plugin/owner）**真跑 authorize**，结果逐一对照 kind 语义表（282 格全对账，非抽样）；fs-write 特例对 fsAuthorizer 两种插件身份分别对表。RFC §17.1"100% RPC 进权限矩阵 + 正负用例"现在有行为级自动化证据。
2. **扫描器自身两处语义 bug 在首跑被抓**（owner 伪角色未映射 role='plugin'；plugin-owned 格误用自身资源）——修正后全绿；这正是"对账而非手写"的价值。
3. **Phase 2 exit criteria 复核**（对照 RFC §15 Phase 1 验收段）：能力→执行入口 ✔（M1.2/1.3 + P2-003/004/006 消费链）；新增权限重问 ✔（指纹+grantApproved）；撤销全版本生效 ✔（P2-010）；**未闭环项**：P2-009（quarantined/degraded 状态可达）、设置页权限管理入口（现仅市场 Sheet）、管理面 v2 键。Phase 2 不宣布 VERIFIED，按 §8 诚实留缺口。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-authz-matrix.cjs` | **PASS 65/65**（M2c 282 格 + 规模断言） |

### 下一轮

**P1-002（执行上下文模型 ADR 定案）→ P1-003（Runtime 轨道 iframe 沙箱接入）**——Phase 1 主体；P2-009 随 P2 残余项并行排程。

最近更新时间：2026-11-04（Round 17）。

---

## Round 18/19 — 2026-11-04（P1-002 ADR 定案 + P1-003a contextRegistry 端口网关）

**当前 Phase：** Phase 1 主体开工。

### Round 18（ADR 轮）
- **ADR-R18-01 定案**：身份四元组（LifecycleManager 记账）+ 每上下文 MessageChannel + **宿主侧 contextRegistry 作为沙箱 RPC 身份真源**（取代 shim 内令牌栈成为沙箱身份通道）+ 既有 broker/矩阵零改动复用 + Track1 先行两轨策略 + 每插件独立 Web 组件回退备选；P1-003 切分为 a/b/c/d 子任务（P1-004/005 依赖同步修正）。`1ded847`。

### Round 19（P1-003a 实现）
1. **新模块 `LexiContextRegistry.ets`**（零 kit 依赖）：HostContextRecord（contextId/pluginId/activationId/kind/revoked）；`create/revoke/revokePlugin/aliveCount`；**帧裁决 `adjudicate`**——未注册 contextId 拒（context_unregistered）、吊销后拒（context_revoked，P2-010 的载体级形态）、协议版本/非请求帧/缺字段拒（context_bad_frame）、**载荷自证 pluginId 剥离**、放行结论携带记录反查的可信身份；§3.4 响应帧组装（ok/data/error{code,message,retryable}）。
2. **网关与既有授权零缝隙协同**：adjudicate → contextOf(role=plugin, 身份=记录) → 既有 broker.authorize → 既有 handler——矩阵/capability/fsGate/路径门全部原样生效（R3.3/R3.4 用例证明双 seam 行为）。
3. **新门禁 `plugin-context-registry.cjs` 15 项全绿**并**正式纳入 release-gate CI**（现 29 步）；测试自身两处断言错误首跑被抓后修正。
4. 设备接线（Track1 页面 port 转移实装）留 Round 20（P1-003a 收尾 + P1-003b 开工）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-context-registry.cjs` | **PASS 15/15**（新门禁） |
| `release-gate --ci` | **PASS 29/29** |
| `hvigorw assembleHap` | **PASS** |

### 下一轮

**P1-003a 收尾（ArkWeb 组件端口转移实装）+ P1-003b 沙箱页 API 面开工**。

最近更新时间：2026-11-04（Round 19）。

---

## Round 20 — 2026-11-04（P1-003a 收尾：ArkWeb 端口转移实装 + registry 生命周期接线）

**当前 Phase：** Phase 1。**P1-003a 完成**。

### 本轮完成

1. **`LexiPluginRuntimeHost` 端口对实装**：`onPageEnd` → `createWebMessagePorts()` → ports[0] 经 `postMessage('lexi-context-port')` 转移给 runtime 页、ports[1] 宿主 `onMessageEvent` → `manager.handleContextPortFrame`（workspace 轨道同款形态，真机已证可行）。
2. **runtime 侧集成**：manager 持有 `contextRegistry`；`attachContextPort`（幂等）/`handleContextPortFrame`（帧→contextId 反查→adjudicate→既有 broker→**经 `tokenForPlugin` credential 复用 `call()` 全链**——身份/strip/authorize 与 javaScriptProxy 路径一致）/`postContextFrame`；`enablePlugin` 成功即 `contextRegistry.create(pluginId, activationId, 'service')`；`disablePlugin` 的回收序在 `revokePluginTokens` 旁同步 `revokePlugin(pluginId)`（P2-010 联动，卸载经 disable 覆盖）。
3. **页面侧**：runtime html 增端口接收脚本（`window.lexiContextPort`），现有 javaScriptProxy 路径不变——**双通道并存**直至 P1-003b 迁移完成（旧插件无感）。
4. **安全定位（诚实声明，代码注释同步）**：插件仍在共享 realm 时 contextId 可被同页代码伪造——通道的完整安全语义在 P1-003b iframe 隔离后成立；门禁覆盖 registry 层行为。
5. **ArkTS 修正**：`Object=null` 禁用（改为 try-parse 省略 data）、`WebMessagePort` 发送 API 为 `postMessageEvent`；contract-matrix 锚点 +4/+4 再修。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-regression.cjs` | **PASS 19/19**（+6 接线断言） |
| `plugin-context-registry.cjs` | **PASS 15/15** |
| `release-gate --ci` | **PASS 29/29**（锚点修正后） |
| `hvigorw assembleHap` | **PASS**（首轮 3 个 ArkTS 编译错误当场修复） |
| 真机冷启 | **PASS**：`context port attached(页面侧)` + onload 3/3 注册 + denied=1 基线 |

### 下一轮

**P1-003b 沙箱页 API 面开工**（runtime 页 iframe 化：per-plugin iframe + 沙箱内 shim API 面以端口身份重建）。

最近更新时间：2026-11-04（Round 20）。

---

## Round 21 — 2026-11-04（P1-003b 切片：沙箱轨贯通至 bootPlugin + 跨帧通道缺陷立案）

**当前 Phase：** Phase 1。**重大平台发现（B-009/ADR-R21-02）**。

### 本轮完成

1. **沙箱轨全链实现（代码就绪）**：声明式 opt-in（`entrypoints.service='sandbox:'` → `manifest.sandboxService`）；`LexiContextRegistry.ensureService`（幂等，沙箱轨 dispatch 前置）；`LexiWebRuntime.dispatchSandboxBoot`（runJavaScript 直传容器）；**容器脚本 `lexinote_sandbox_container.js`**（per-plugin iframe 创建/端口接收/帧路由/身份覆写——iframe 永不自报身份）；**沙箱内最小 API 面**（`bootPlugin`：Plugin 基类 + app.request）；探针夹具 sandbox-probe（v2，storage 声明）。
2. **真机贯通证据**：`sandbox context created: ctx-2-sandbox-probe` → `context wired` → **`bootPlugin: sandbox-probe`**（iframe 内插件代码执行）——宿主 dispatch → 容器 → iframe 的装载链全通；CSP frame-src 教训二次验证（runtime 页同款拦截，S16b 断言固化）。
3. **平台缺陷立案（B-009，ADR-R21-02）**：runtime 宿主页上**两条跨帧回路均静默丢帧**——①iframe→parent 的 window.postMessage（不抛错不达）；②容器页 MessageChannel port1.onmessage 不投递；**同一份沙箱子文档在 PoC 独立页双向全通**（对照复测）。排除协议/标记因素（Round 9 三根因已修复+PoC 对照）。判定指向 ArkWeb 对 runtime 页形态（1x1+javaScriptProxy+高频 runJavaScript）的跨 frame 投递缺陷。
4. **决策（ADR-R21-02）**：沙箱容器迁往**独立 Web 组件**（PoC 同构=已验证形态），contextRegistry/broker 复用；过渡期沙箱轨加运行开关 `lexiPluginSandboxTrack`（默认关→探针回落旧轨，系统零影响）；P1-003b 的 API 面工作不返工。
5. 过程修正：sandbox-probe manifest 的 v2 兼容（minApiVersion→compatibility.min，v2 严格解析拒 v1 字段）；探针从首启自动启用移除（其最小面依赖沙箱轨）；.gitignore 登记 sandbox-probe 夹具；contract 锚点 +15 位移修复；dist-regression 断言更新（ensureService）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-context-isolation.cjs` | **PASS**（+S16b） |
| `plugin-dist-regression.cjs` | **PASS 19/19** |
| `plugin-manifest-v2.cjs` | **PASS 39/39** |
| `release-gate --ci` | **PASS 29/29**（锚点/断言修正后） |
| `hvigorw assembleHap` ×多轮 | **PASS** |
| 真机沙箱链 | **贯通至 bootPlugin**；跨帧回路缺陷立案 B-009 |
| 真机回归（开关关） | 探针回落旧轨失败（预期，最小面不兼容）+其余基线保持；最终轮抓取窗口被 PoC verdict 输出截断，sample 链以 Round 16 证据为准 |

### 下一轮

**Round 22：方案 B——独立沙箱容器 Web 组件**（LexiSandboxHost 同构形态新建容器页/组件，迁移容器脚本与网关对接，探针真机 onload 闭环）。**P1-003b 整体 BLOCKED 于 B-009**（随方案 B 解除）。

最近更新时间：2026-11-05（Round 23）。

---

## Round 23 — 2026-11-05（P1-003b 续：容器页命令回环 + obsidian 面扩容第一组 + 新平台发现 B-009b）

### 本轮完成

1. **沙箱内面扩容第一组**：Plugin.loadData/saveData（data 帧）、addCommand（callback 型：沙箱命令表 + 宿主 commands.add 元数据注册）、Notice→ui.notice、vault 最小集（getMarkdownFiles/getAbstractFileByPath/create/modify/read）、normalizePath/moment 最小实现；编辑器命令元数据注册（执行面后续切片）。
2. **宿主命令回环分流**：invokePluginCommand 按插件轨分流——沙箱轨插件经容器页 `window.lexiSandboxCommand` 回推（容器按 pluginId 路由进对应 iframe 的 window 通道）。
3. **新验收夹具 sandbox-sample-min**（v2：vault.read+workspace.commands+storage；真实业务插件形态：CJS Plugin 子类+异步 onload+两命令+数据往返）。
4. **真机结果**：probe 全链再次闭环（->arkts data.save→<-arkts ok→data.json 落盘铁证）；**sample-min 装载至 bootPlugin 后其帧静默丢失**——立案 **B-009b**：容器页上第二个及之后的 iframe 的 postMessage 不达容器（首 iframe 全链正常；无丢弃日志无异常）。证据链 /tmp/r23d.log。
5. 过程修正：invokePluginCommand 的 ArkTS undefined 收窄；BUNDLED 列表/首启块/.gitignore 登记夹具。

### 下一轮

**B-009b 定位或绕行**（优先方向：单 iframe 串行队列——一次仅一个沙箱上下文，排队装载；或定位 ArkWeb 多 iframe 投递限制）。P1-003c/d 验收可用单插件模式推进。

最近更新时间：2026-11-05（Round 23）。

---

## Round 22 — 2026-11-04（方案 B 实施：独立沙箱容器 Web 组件 → **B-009 解除,沙箱轨真机全链贯通**）

### 本轮完成

1. **新容器页/组件**：`lexinote_sandbox_host.html` + `LexiSandboxContainerHost.ets`（1x1，LexiSandboxHost 同构形态，挂 Index）——**全部通道使用真机已验证机制**：页内 iframe↔页 window.postMessage（PoC verdict 验证）、页→ArkTS javaScriptProxy `sandboxHost.call`（Track1 久经验证）、ArkTS→页 runJavaScript `sandboxHostInbox`（Track1 久经验证）——**零未知通道**。
2. **manager 网关接入**：`LexiSandboxProxyFace`（proxy 面）→ `handleSandboxProxyCall`（adjudicate→broker→tokenForPlugin credential 复用 call()）→ `dispatchSandboxResponse`（runJavaScript 回推 inbox）；`attachSandboxController` 登记 controller（boot 派发改走容器页）；`waitForSandboxContainer`（onPageEnd 竞态兜底，超时 fail-closed 拒装）。
3. **真机四轮迭代定位三断点**（全部当日闭环）：①容器在 appendChild 前缓存 contentWindow=null→load 后重取；②proxy 帧的 frame 须以**字符串**过网关（adjudicate 契约）；③响应回推须对字符串二次 JSON 编码（对象字面量被页侧当 object）。
4. **终验铁证（04:53:48-50）**：`已启用(沙箱轨)` → `->arkts data.save` → `<-arkts id=w1 ok=true` → **`plugin onload done`** → `->arkts plugin.onload.done` → `<-arkts ok=true` → **data.json = {"marker":"sandbox-probe-ok"} 落盘**——**业务插件在 per-plugin iframe 内以端口身份完成 onload+数据往返，P1-003b 第一验收点达成，B-009 解除**。
5. 探针恢复首启自动启用（沙箱轨可用，失败仅 errorState）；沙箱轨条件=容器就绪||显式设置（生产语义成立）。

### 修改文件

`lexinote_sandbox_host.html`(新)、`lexinote_sandbox_container.js`(方案 B 重写)、`LexiSandboxContainerHost.ets`(新)、`LexiPluginRuntime.ets`(proxy/网关/等待/条件)、`Index.ets`(挂载)、`plugins/sandbox-probe/*`、tools/contract/symbols.json(锚点 ×2 轮)。

### 测试

| 命令 | 结果 |
|---|---|
| `release-gate --ci` | **PASS 29/29** |
| `hvigorw assembleHap` ×5 轮 | **PASS**（ArkTS 错误即时修复：WebRuntime 字段等） |
| 真机沙箱链终验 | **PASS**（铁证如上） |

### 下一轮

P1-003b 继续（沙箱内 obsidian 面扩容→sample 完整迁移）；观测点 slog 清理随迁移轮。

最近更新时间：2026-11-04（Round 22）。

---

## Round 25 — 2026-11-07（P1-003c:构建期 CJS→IIFE + runtime 页 CSP 移除 unsafe-eval → **VERIFIED**；并行 P0-008 修复收口）

**当前 Phase：** Phase 1 收口推进。**P1-003c 完成**（ADR-R25-01）。

### 本轮完成

1. **ADR-R25-01 定案**：eval 面盘点——runtime 页唯一 eval 消费点 = shim `loadPlugin` 的 `new Function`（legacy 轨 + workspace obsidian 兼容路由共用；sandbox iframe 内 eval 按 ADR-R18-01 定案4 保留；ArkTS VM 无 eval）。定案：①CJS→IIFE 包装单一真源（shim `wrapPluginSource`，CLI `lexi plugin build` 经 vm 复用，产物 `/* lexi-iife:v1 */` 自带 module/exports/require 管线，登记 `window.__lexiPluginRegistry[id]`，幂等）；②双通道求值（装载期能力探测一次定死）：runtime 页走**脚本文本注入**（CSP `script-src 'self' 'unsafe-inline'`，'unsafe-eval' 移除；'unsafe-inline' 为放行注入通道的最小授权，HTML 文档本体零内联脚本 S27 续守）、workspace 页过渡通道 `new Function` 保留（P1-004 收敛时同轮删除，S28 钉死"恰好 1 处"）；③require 令牌绑定不进脚本文本（一次性 `__lexiAcquireRequire`，同步注入段消费即烧毁，盗调 fail-closed）。
2. **门禁扩容**：plugin-context-isolation +S26（runtime CSP 无 unsafe-eval）/S27（HTML 零内联脚本）/S28（runtime 页脚本 eval 对账：render/container 清零、shim new Function 恰 1 处且能力门控）/S28b（注入通道结构在案）/S29（沙箱按设计保留 unsafe-eval+注释在案）→ **48 项 PASS**（原 43）；lexi-cli-contract +C6.1-4（build 端到端/形状/vm 行为级/幂等）→ 18 项；plugin-shim-regression +注入通道行为级用例 → 9 passed（叠加 P0-008 修复的 8 项基线）。
3. **模板链**：tools/lexinote-plugin-template build 尾追加 `lexi plugin build .`，README 同步。
4. **真机验收（lexi_2in1，四连冷启全绿）**：新 CSP（无 unsafe-eval）下 lexi-sample legacy 轨装载+运行（onload 完成+8 命令注册+启用）×4；sandbox-probe/sample-min 沙箱轨数据往返不变×4；全程零 CSP 违规/零 EvalError/零 function-fallback。判定逻辑=差分证明：沙箱 iframe（CSP 放行 eval）new Function 正常 → 引擎不整体禁 eval；runtime 页（CSP 禁 eval）插件照常装载 → 必经注入通道（ArkWeb 强制 CSP 已由 B-008 真机定案）。
5. **新平台发现（KI-5）**：runtime 页 Web 组件 `.onConsole` 从不投递（LexiSandboxHost 同款 handler 真机有输出，本组件无条件日志/过滤/error 级均零输出）——runtime 页 console 观测哑，通道选择直接标记不可经 console 获得登记为残差；已补 onConsole handler（正确形态，随 API 升级可能生效）。legacy 轨命令执行回环未再驱动（路径不在本轮 diff，实例创建由 onload+命令注册证明）——记为 R25 残差。
6. **并行快速赢面 P0-008 收口（独立提交 d322199）**：shim-regression harness 补 DOM stub+host-first 顺序+启动预热，8/8 确定性绿×2；根因含 267ad04 后契约漂移；发现 shim vault 同步索引两缺陷登记 **P4-007**（rename 误删+启动拉取缺失，仅登记未修）。
7. **预存红核实（防假完成）**：plugin-route-coverage FAIL（vault.getByPath 孤儿，view_shim 调用点门禁盲区，HEAD 即红）→ 登记 **P0-010**；workspace-tools-regression 模块加载即崩（HEAD 即红）→ 登记 **P0-011**。均不在 release 29 步内。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `release-gate --ci`（主线独立复跑×2，含最终树） | **PASS 29/29** |
| `plugin-context-isolation.cjs` | **PASS 48/48**（+S26-S29） |
| `lexi-cli-contract.cjs` | **PASS 18/18**（+C6） |
| `plugin-shim-regression.cjs` | **PASS 9/9**（P0-008 后 8+注入通道 1） |
| `hvigorw assembleHap` ×3 | **PASS** |
| 真机冷启 ×4（lexi_2in1） | **PASS**：3/3 插件 onload、零违规（见上） |

### 残差与下一轮

- 残差：注入通道直接标记（console 观测哑，KI-5）；legacy 命令执行回环未再驱动。
- **下一轮 = R26 = P5-004**（装完不自动 enable：权限清单→同意→启用；B-004 按 RFC §4.5 自设计）。

最近更新时间：2026-11-07（Round 25）。

---

## Round 26 — 2026-11-07（P5-004 安装授权同意流 IMPLEMENTED（离线全绿）+ 设备全链自动化 BLOCKED 立牌 P0-012；并行 P0-010/011 收口）

**当前 Phase：** Phase 5 安全半边推进。**P5-004 离线 VERIFIED，设备全链自动化未通（BLOCKED，见下）——诚实裁定不虚标**。

### 本轮完成

1. **ADR-R26-01 定案（B-004 自设计，待人工复审）**：授权落账=同意唯一记录（PermissionStore.grant 指纹绑定）；enablePlugin 首次启用即授权自动落账**废除**——not-granted 一律拒绝（fail-closed，errorState 提示走授权面板）；installZip/installFromUrl 只落盘，首装停在 installed（在盘未启用）态；`consentEnablePlugin`/`permissionStateOf` 新面；市场面板授权披露（RFC §4.5 三档：`classifyCapabilityTags` 高风险/可选/必需，纯展示不拆分授权）；v1 无声明清单不进授权门（无指纹可授），有声明清单与新装 v2 同需同意。
2. **降级语义（本轮定案）**：授权为指纹整体性 ⇒ 未完全授权=不运行（permission-pending）；§4.5"拒绝可选权限仍降级运行"留 P2-009 状态机连同 per-capability 授权收口。
3. **内置夹具白名单（B-004 待审项）**：lexi-sample-plugin/sandbox-probe/sandbox-sample-min 随 HAP 签名分发、首启代码内闭合 `bundledAllowList` 逐个 grant 后启用（gate 断言白名单闭合）；用户安装插件无任何自动落账通路。
4. **门禁扩容**：dist-regression +7（26/26：首装不启用/同意启用/未同意拒启/撤销链完好）、lifecycle-once +L6.8/6.9（37 项）、manifest-v2 +V6.1-6.5（48 项，classifyCapabilityTags 真跑）；release-gate **29/29**（主线独立复跑）。
5. **设备证据（部分，真机 lexi_2in1）**：授权待定态 UI 正确渲染——`待授权·未启用 · cap-probe-open · 权限: network:127.0.0.1`（装机后未获任何同意的插件跨多轮冷启均未自动运行=negative 案例真机成立）；bundled 白名单插件（sandbox-probe/lexi-sample）多轮冷启正常启用，沙箱/legacy 双轨零回归。
6. **设备全链自动化 BLOCKED（立牌 P0-012）**：plugin-dist-flows 全链（install→面板→同意→启用→upgrade/rollback/uninstall）未通，重试超限后按纪律停手。根因三层：①R8 时代 `x1<1000` 锚点在 2in1 宽布局下点中宽卡片非侧栏行（已修：findByTextNarrowest 最窄匹配）；②**模拟器长会话 NAT TCP 代理失效**——10.0.2.2 ICMP 通但 TCP 不转发宿主，市场永远"市场为空"；重启 lexi_2in1 即恢复（已证：修复后面板显示"共 1 个插件/演示源（使用中）"）→ **KI-6**；③远程条目被已安装列表挤出视口（KI-1 在自动化链路的化身），已加滚动轮询但 sheet 内滚动容器行为仍未标定（手动滑动会关闭面板）。upgrade/rollback/uninstall 段的 rowAction 点击标定同属 P0-012。
7. **并行 P0-010/011 收口（独立提交 0e2cc80）**：route-coverage 纳管 view_shim 为第二调用源（vault.getByPath 诚实重分类"仅视图面/fail-closed"，无弱化）；workspace-tools-regression 双层根因修复（mac 硬编码路径→候选约定、CRLF 归一化）；双门禁 PASS×2 确定性。
8. 过程修正：symbols.json 两处 .ets 行号锚点手工修复（未跑 generate.cjs）；flows 的 adapter-probe-evidence 同步授权步进。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `release-gate --ci`（主线独立复跑） | **PASS 29/29** |
| `plugin-dist-regression.cjs` | **PASS 26/26**（+7 授权流用例） |
| `plugin-lifecycle-once.cjs` / `plugin-manifest-v2.cjs` / `plugin-permission-store.cjs` | PASS 37 / 48 / 28 |
| `hvigorw assembleHap` | PASS（HAP 00:54 新鲜度核实） |
| 真机（lexi_2in1） | 待授权态 UI 渲染 ✔、白名单冷启 ✔、市场源拉取 ✔（NAT 修复后）；**全链 flows 4 FAIL（P0-012）** |

### 下一轮

**R27 = P1-003b 编辑器切片 + P2-005**（editorCallback 进沙箱 + editor readActive/writeSelection/writeDocument 分级门禁，互锁同轮）。P0-012（flows 重标定）进并行快速赢面池。

最近更新时间：2026-11-07（Round 26）。

### Round 26 追记（同日,P0-012 收口 + P5-004 设备证据回填）

P0-012 并行工人以 6 次流程运行收口：**四流程真机全 PASS**（install 19/0、upgrade 11/0、rollback 7/0、uninstall 6/0，evidence `20261107-041154`，断言零弱化）。重标定内容：滚动容器发现+容器内滑动（替代硬编码 y 坐标——原 y=1700 在 sheet 底 1675 之外）、rowAction 最近行配对（|Δcy|≤70px,行距 132px）、授权面板 reveal（R26 面板在视口顶部而安装点击后视口在底部）、演示源 busy 竞态等待（默认源占 busy 20-30s,点击被静默吞）、市场行锚点改 /哈希已校验/（避免已安装行同名假阳）、**夹具收纳法**（市场条目 Scroll 因产品塌陷 bug 高度归零——用真实 UI 卸载 6 个内置夹具腾位,finally 复原）。**P5-004 设备全链证据回填**：install→"已安装（未启用）：分发探针 — 请确认权限清单后启用"→授权面板同意→"已安装并启用：分发探针" 全 PASS;升级路径同样落在待授权+面板复现。产品发现（仅登记）：①市场条目区在已安装列表溢出时整体塌陷（`LexiPluginMarketSheet.ets:556` height('100%')+layoutWeight(1) 负空间→条目 Scroll 不渲染,归 P5-007/KI-1 机制面）;②`hdc install -r` 间歇重置应用数据（模拟器 quirk）;③升级在权限不变时仍要求重新同意（fail-closed 下可辩护,UX 决策入 HUMAN_QUEUE#3 附注）。

---

## Round 27 — 2026-11-07（P1-003b 编辑器切片 + P2-005 分级授权 → **VERIFIED**（离线全绿+真机全链铁证））

**当前 Phase：** Phase 1 收口推进。P1-003b 剩余面=view/settings（editor 切片本轮完成）。

### 本轮完成

1. **沙箱 editor 执行面**：`SandboxEditor`（逐方法对齐旧轨 EditorProxy 的宿主 RPC 形状，无自造 API；读=命令帧快照、写=既有 request 链）；`addCommand({editorCallback})` 双轨命令表；`runSandboxCommand(fullId, editorState)` 组装 Editor 调回调——链路 ArkTS `invokeEditorCommand`→容器 `lexiSandboxCommand`（身份字段绝不进 iframe）→iframe `sandbox.command`。
2. **P2-005 三档授权**：tags→tier→broker capabilityGate（`editor.state→readActive;editor.selection→writeSelection;editor.applyChanges→writeDocument;editor.replace→writeSelection||writeDocument`）；`editorReplaceGate` 选区等值精判（writeSelection-only 插件获 replaceSelection,任意区间仍拒,no half-writes）；**两条防读旁路脱敏**——命令帧快照脱敏（未声明 readActive 不携带正文/仅 writeSelection 给偏移不给文本/两者皆无 `active:false`）+写回包脱敏（未声明 readActive 只回 active/selection,写选区≠免费读全文）；v1 旧语义零扰动。
3. **新夹具 sandbox-editor-min**（v2 声明 editor 三档;`editor-snapshot`/`editor-write` 两条 editorCallback 命令,结果落 data.json）入 BUNDLED+白名单+gitignore。
4. **门禁扩容**：authz-matrix +M2.50-54 档位行（**70 项**）、context-isolation +S30/S30b/S30c（**51 项**）、manifest-v2 +V5.10/11（**50 项**）、dist-regression +接线+白名单（**27/27**）、shim-regression 9 保持绿（legacy 零回归）、contract-matrix 绿（symbols.json 手修 2 处锚点）。
5. **真机铁证（lexi_2in1）**：面板过滤→两条命令执行——`派发编辑器命令: sandbox-editor-min:editor-write 编辑器=5af482b9`→`命令已回推沙箱`→`命令执行: ...(editor)`→`req(win) -> editor.replace`→`identity.token method=editor.replace`→`<-arkts ok=true`→`data.save ok=true`；**data.json 落盘** `{"snapshots":1,"writes":1,"lastWrite":{"textAfter":"〔〕","selectionAfter":[...]}}`；**宿主文档真实变更 0→2 字符**（沙箱插件经端口写改宿主文档的直接证据）；快照命令同链执行成功。负例（未声明档位拒绝）由 authz-matrix 70 项离线覆盖。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `release-gate --ci`（主线独立复跑） | **PASS 29/29** |
| `plugin-authz-matrix` / `context-isolation` / `manifest-v2` / `dist-regression` | **70 / 51 / 50 / 27-27 全 PASS** |
| `hvigorw assembleHap` | PASS（HAP 新鲜度核实） |
| 真机编辑器命令回环 | **PASS（铁证如上）** |

### 并行：P0-012 四流程全绿收口（8d331f4）

install 19/0、upgrade 11/0、rollback 7/0、uninstall 6/0（evidence `20261107-041154`，断言零弱化）；**P5-004 设备全链证据回填**（未授权待定→面板同意→启用，升级路径复现）。产品发现登记：市场条目区塌陷（P5-007）、`hdc install -r` 间歇重置数据（KI）、升级重复同意 UX（HUMAN_QUEUE#3b）。

### 下一轮

**R28 = P1-003d（范围修正版）**：lexi-sample 沙箱轨真机验收 + SEC 探针进业务路径 + 旧共享 realm 停用开关（calendar 归 P4-005）。

最近更新时间：2026-11-07（Round 27）。

---

## Round 28 — 2026-11-07（P1-003d 范围修正版 → **VERIFIED**（离线全绿 + 真机验收表三件套））

### 本轮完成

1. **沙箱轨 require 管线收口（ADR-R25-01 遗留）**：sandbox.html 提供 `window.lexiRuntime.__lexiAcquireRequire`（与宿主 shim 同名=同一份 `lexi-iife:v1` 产物两 realm 按字节消费）；bootPlugin 双分支（原生 CJS 工厂管线不变 / IIFE 标记→new Function→registry 读回）；一次性 require 上下文对齐 shim 纪律；凭据绝不进 iframe（归属由 contextRegistry 按 contextId→容器网关裁定）。vm 双路验证 lexi-sample 原码+CLI 包装产物 onload+8 命令+editor 回环零 evalError。
2. **lexi-sample v2 opt-in**：manifest 升 v2（`entrypoints.service:'sandbox:'`）+ capabilities 与真实 RPC 面逐项对账，main.js 零改动；沙箱 obsidian 面补齐求值期依赖（ItemView/PluginSettingTab 最小基类、vault.on 登记语义、vault.process 组合、workspace 叶面 fail-visible 桩）。
3. **旧共享 realm 停用开关**：新零依赖纯函数 `LexiPluginTrackPolicy.resolvePluginTrack`（单一真源,sandbox/legacy/refused 三值;开关关死=refused fail-closed 不派发不静默回落）;设置页 Tab+Window 双面 Toggle;默认 ON（RFC §3.6:沙箱轨过真实业务验收前不关旧门;ADR-R28-01 复审条件=验收通过后翻默认）。
4. **SEC 探针进业务路径**：新夹具 sandbox-sec-probe（10 逃逸向量,onload 穷举,经 saveData 业务通道落 data.json）;门禁与设备共用同一夹具源码（E3/E3b vm 真跑沙箱表面+夹具双分支装载）;**顺手修复既有门禁缺陷:E1/E2 探针段原排在 process.exit 之后从未计入（vacuous）**——修复后真跑全绿。既有 S 断言零削弱。
5. **门禁**：context-isolation **76 项**、dist-regression **32/32**、manifest-v2 **55 项**、contract-matrix 绿、shim-regression 9、release-gate **29/29**（主线独立复跑）、构建绿。

### 真机验收（lexi_2in1,RFC §3.6 三件套）

| 项 | 证据 |
|---|---|
| lexi-sample 沙箱轨 | 设置页重载→`沙箱轨装载: lexi-sample context=ctx-6`→`bootPlugin: lexi-sample-plugin`→8 命令注册（首启时容器未就绪走 legacy 回落=开关 ON 设计行为;重启用即上沙箱轨） |
| SEC 探针业务路径 | **data.json: `{"passed":true,"total":10,"blockedCount":10,"credentialHits":0}`** — 10 逃逸向量（parent-dom/sibling-iframe/credential-hunt/network-fetch/xhr/remote-import 等）在真实业务沙箱链上全阻断 |
| legacy 停用 fail-closed | 开关 false→启用 legacy-only cap-probe-open→**`插件装载被拒(legacy 轨停用)…装载被拒绝(fail-closed)`** 零派发 |

### 产品发现（本轮登记）

- **P2-013（新）**：设置页 Toggle 在 uitest 单击下产生 2-3 次 onChange（legacy 开关无法经 UI 稳定置位,偶数次净零变化）;真实触摸/键盘待验。归 Phase 2 设置 UI。
- 沙箱轨已知残差（在案）：事件投递未接入（vault.on 登记语义）、workspace 叶面 fail-visible 桩——lexi-sample `open-panel` 命令沙箱轨收到明确错误通知,其余 7 命令可用。

### 实际执行的测试

`release-gate --ci` 29/29 ×2、context-isolation 76、dist-reg 32/32、manifest-v2 55、`hvigorw assembleHap` PASS、真机三件套如上。

### 下一轮

**R29 = P1-004 技术论证+ADR（不动代码——人工评审 gate 在 HUMAN_QUEUE#3）**。

最近更新时间：2026-11-07（Round 28）。

---

## Round 29 — 2026-11-07（P1-004 技术论证 + ADR-R29-01 草案 → **待人工评审**（ADR 轮,零代码改动））

**当前 Phase：** Phase 1 收口推进。P1-004 仍为 TODO（本 ADR 不标 VERIFIED——Goal §10 技术论证先行,HUMAN_QUEUE#3 批准后才动代码）。

### 本轮完成

1. **现状盘点（编辑器页第三方求值面,file:line 全对账）**：编辑器页（LexiWorkspacePage→lexinote_workspace.html,手机开笔记默认路由 Index.ets:442-446）CSP 保留 unsafe-eval（lexinote_workspace.html:6,全应用唯一宿主页残留）;两个页内求值点——工作区 shim 自有求值器（lexinote_workspace_shim.js:224 new Function,demo 路由+首个 plugin.load 条目）与共享 shim 过渡通道（lexinote_plugin_shim.js:2451,obsidian 路由经 window.LexiObsidian.loadPlugin,注入探测在该页恒 false 故今天全走 new Function）;装载范围=全量已装插件（WorkspacePluginCatalog.ets:76-98,bundle 启动逐个求值,tools/workspace-bundle/src/main.ts:676-694）。**核心事实：R28 的 lexiPluginLegacyTrack 停用开关与 ADR-R26-01 同意门在 Track2 全部失效**——WorkspaceBridge.plugin.load（:530-554）不查 LexiPluginTrackPolicy、installed-but-未启用（errorState 空）插件照样被求值,编辑器页今天是不受轨政策/授权约束的第三方代码执行面。
2. **ADR-R29-01 草案定稿**（ARCHITECTURE_DECISIONS.md）：三方案对比（A 全量迁容器模型——可见性+CM6 双缺口,否;B 整页 Trusted——信任根不存在+违反 RFC §3.2,否;**C 混合（推荐）**:S1 Track2 纳入单一轨政策真源+同意门 → S2 可见视图载体设备 PoC（独立 Web+native ports,ADR-R18-01 备选形态,不碰 ADR-R21-02 证伪的页内 iframe）→ S3 求值器退役+工作区页 CSP 收紧（兑现 ADR-R25-01 复审条件）→ S4 CM6 Trusted 面（P4-004 域,过渡信任根=内置白名单,不依赖 B-002））;五项开放问题明示;与 P1-005/P1-007 编排（S1 先行,R30/R31 设计须把 Track2 计入）。
3. **登记文件更新**：HUMAN_QUEUE#3 改指向 ADR-R29-01 并列明 5 项待裁决问题；EXECUTION_PLAN P1-004 状态改「ADR 草案就绪待评审」（非 VERIFIED）。

### 明确不做（本轮纪律）

- 零代码改动（.ets/rawfile/门禁全部未触碰）；不动设备；不跑有写副作用的命令。release-gate --ci 只读复跑确认树未动绿（结果见下）。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `release-gate --ci`（只读复跑,确认树未动） | **PASS 29/29** |

### 下一轮

**R30 = P1-005 + P1-006b**（身份纯端口化 + __receive dispatch 鉴权）——前提:HUMAN_QUEUE#3 对 ADR-R29-01 完成评审;若 S1（Track2 轨政策收口,纯 ArkTS）获批,可与 R30 并行排入（本 ADR 编排节）。

最近更新时间：2026-11-07（Round 29）。

---

## Round 30 — 2026-11-07（P1-011 S1 + P1-005 + P1-006b → 离线全绿 + 设备链定案；P1-011 Track2 负例设备项受 P2-013 阻）

### 本轮完成

1. **R30-A/P1-011 S1（b005813）**：Track2 双旁路闸（详前报）。设备：boot 健康零拒收误伤。
2. **R30-B/P1-005 身份纯端口化**：新增 `LexiWebRuntime.callFromPort(callId,method,payload,identity)` 为端口链唯一入口（contextRegistry 反查身份，凭据宿主内存补铸**绝不经过页面**）；两个端口调用点凭据表达式清零（dist-reg `doesNotMatch` 钉死）；兼容定案=credential 第 4 参经页面形态仅剩 legacy 轨（随 `lexiPluginLegacyTrack` 整体退役,TRACK_REFUSED 先于载荷构建,S40f 钉源序）+ Track2 委托（本轮未动,归 P1-004/R31）。
3. **R30-B/P1-006b**：`dispatch()` 每次铸造一次性通道凭据（CSPRNG,method+payload 双绑定,60s TTL）→ shim 门卫经 **`lexiHost.admitDispatch` javaScriptProxy 同步核销口**首用即烧毁——裸调/伪凭据/重放/换绑定 fail-closed（残余:同 realm 猴补可抢先原样重放一次=ADR-R25-01 定案3 同信任级,登记在案）；`setSessionToken` 写一次定死（容器引导链绑定,异值拒绝/同值幂等/跨上下文 fail-closed）。
4. **门禁**：bridge-security **50**（+16:R8 静态+9 行为级 SEC-007 负例）、context-isolation **82**（+S40a-f）、shim-regression **12**（+3 负例）、dist-reg **38/38**（协议锚升级,强于旧断言）、authz 70、**release-gate 29/29 ×2**（主线独立复跑）、构建绿。symbols.json 8 锚手修。

### 真机（lexi_2in1,bm clean 首启）

- 5 插件 onload、7 命令注册、**零 dispatch 拒收误伤**（合法路径凭据链透明）。
- 编辑器命令端到端：`派发编辑器命令`→容器→iframe→`editor.replace`（identity=ctx 端口链）→**CEF 日志实证 `admitDispatch` javaScriptProxy 同步核销发生**→ok→data.json `{"writes":1,"lastWrite":{"textAfter":"〔〕"}}`。
- Track2 拒载负例设备复现受 **P2-013**（Toggle 多次触发,UI 无法稳定置位）阻——离线 vm 行为级 6 用例为凭据,登记残差。

### 实际执行的测试

release-gate 29/29 ×2、bridge-security 50、context-isolation 82、shim-reg 12、dist-reg 38/38、assembleHap PASS、真机如上。

### 下一轮

**R31 = P1-007**（双 broker 归一单 Gateway,契约对账）。

最近更新时间：2026-11-07（Round 30）。
