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

## Round 31 — 2026-11-07（P1-007 RPC 入口归一 → 离线全绿；100% 口径按传输面如实裁定）

### 本轮完成

1. **单一 Gateway 模块（新 `entry/src/main/ets/core/plugin/LexiRpcGateway.ets`，纯逻辑零 @kit）**：`LexiRpcGateway.shared` 单例（与 LexiPluginManager.shared 同纪律）持有 ①全应用唯一 `LexiPermissionBroker` 实例 ②页侧 handler 表 ③敏感家族 payload schema 表 ④host→页 dispatch 面方法注册表。Gateway 是漏斗——handler 全部原位保留（registerHandler 调用点零改动），不是 handler 重写。
2. **两 broker 实例合并**：runtime 侧 `LexiWebRuntime.broker` 从自持字段降级为转发访问器（get→`rpcGateway.broker()`，set→`attachBroker`；init 处 `this.runtime.broker = new LexiPermissionBroker(...fsAllowedByManifest...capabilityAllowedFor...)` 注入点文本与语义不变，落点是 Gateway）；bridge 侧 `WorkspaceBridge` 的第二个 `LexiPermissionBroker` 实例删除，`bridgeAuthorize` 改走 `LexiRpcGateway.shared.authorize`。桥面语义不变的依据（Track2 范围裁定）：桥面方法仅 public/control-plane/demo-plugin 三类，fs/capability 两个 seam 在这三类从不触发，与旧桥内实例（默认 fail-closed）判定逐格一致；delegate 业务方法在 `runtime.call` 内本就过同一矩阵（此前双重裁决，现收敛一处）——**评估模型/装载门 pluginLoadRefusal 零改动，P1-004 残余不变**。
3. **入口双闸（先于身份解析与 authorize）**：①未知方法显式拒绝——机器码 `unknown_method`（原 failResponse 无码，升级为机器可读），不再静默 undefined；②payload schema 校验——机器码 `bad_request`，覆盖敏感家族 fs/vault（vault.read/getByPath/modify/create/delete/rename/append）、editor（replace/selection/applyChanges）、network（net.requestUrl）、commands（add/remove/execute）、data（save）、metadata.get；必需字段+类型从既有 handler 真实消费键推导（rpcString/rpcNumber/Array.isArray），与 shim/视图页/工作区页实际发送形状逐条对齐——合法流量零拦截，域级复核（fsAuthorizer/capabilityGate/fsGate/LexiNetProbe 白名单/editorReplaceGate）全部原样保留。
4. **dispatch 面归一**：`dispatch()` 新增 Gateway 方法面校验（load/unload.plugin、invoke.*、event、settings.values），未知页侧方法显式抛错（宿主内部调用点拼写错误启动即暴露）；admitDispatch 核销口原位保留（bridge-security R8a-d 锚不动）。
5. **门禁**：authz-matrix **70→93**（M3.6 改判「桥面接单一 Gateway、桥内无第二实例」+新 M4 段：真实转译 Gateway 的 unknown_method/schema 行为级负例 8 族+正例对账+authorize 单一收口+dispatch 面+收敛静态 21 项）；dist-regression **38→39**（P1-007 接线对账：五类前门收敛/broker 构造点对账 bridge 0·runtime 1·gateway 1/入口双闸/dispatch 面）；contract-matrix symbols.json 2 处行号漂移手修（:1719→:1740、:1521→:1542，按门禁提示逐条照抄）。**release-gate 29/29 ×2**（新 HAP 落地后复跑）+ assembleHap BUILD SUCCESSFUL。

### 100% 口径（如实裁定）

五类传输前门全部经单一 Gateway：①`lexiHost.call` javaScriptProxy（LexiPluginRuntimeHost / LexiPluginViewSlot / LexiPluginCodeBlockSlot 三绑定面）→`LexiWebRuntime.call`→entryReject+authorize；②`sandboxHost.call`→`handleSandboxProxyCall`→adjudicate→callFromPort→call；③context port 帧→`handleContextPortFrame`→同②；④dispatch（host→页）+`admitDispatch`（一次性通道凭据核销,不达 handler）——dispatch 面注册表进 Gateway,核销后页内回调若回呼宿主则再经①；⑤WorkspaceBridge 桥面（bridgeAuthorize→shared.authorize）+delegate（→runtime.call→Gateway）。工作区页 `hello` 握手 poke（一次性,非方法分发）不在 RPC 面。Track2 装载门/评估模型未动（P1-004 域）。

### 实际执行的测试

release-gate 29/29 ×2、authz-matrix 93、dist-reg 39/39、bridge-security 50、context-isolation 82、context-registry 15、shim-reg 12、identity-delivery、contract-tripod、extension-ownership、inspector、workspace-api、error-visible、net-request-url、core-regression、workspace-tools-regression、workspace-note-open、contract-matrix(--fixtures-required)、assembleHap PASS。

### 预存红（与本轮无关,HEAD 对照核实）

- `plugin-route-coverage`：editor.replace/selection/applyChanges 报「未登记孤儿」——R27 起 editor shim 调用点走 `_apply` 间接,非本轮引入（handler 集合与 HEAD 逐字一致,git show 对照）。
- `input-robustness-evidence`：A2/A3/A4 设备证据项（2026-11-02 会话缺 editor.change 事件）——门禁只读该日 hilog 证据,不读本轮源码。
- `plugin-tasks-compat`：PENDING（3 项 pending,夹具态）。

### 下一轮

**R32 = P1-008 + P2-009**（销毁闭环 SEC-009/013 自动化;quarantine 由安全事件触发可达）。

最近更新时间：2026-11-07（Round 31）。

## Round 32 — 2026-11-07（P1-008 + P2-009 → 离线全绿;销毁闭环五步尾序 + 状态机五新态可达 + quarantine 安全事件触发链）

### 本轮完成

1. **P1-008 执行环境销毁闭环**：`disablePlugin` 重构为「启用段（lifecycle 停用+unload 派发+宿主登记面回收,原序不变）→销毁尾序（幂等,未启用/记录缺失也执行——卸载路径旧通道无条件回收）」四步：①`contextRegistry.revokePlugin`（旧通道帧立即 context_revoked）→②容器页 iframe 销毁——`lexinote_sandbox_container.js` 新增 `window.lexiContainerTeardown(pluginId)`（按插件 id 移除 per-plugin iframe+清 pendingContexts;缺 id fail-visible、无匹配幂等 no-op;此前容器页只有 boot/inbox/command 三个入口,销毁面缺失=SEC-013 残留）,宿主经 sandboxController.runJavaScript 带存在性守卫调用→③`revokePluginTokens`（页面通道身份失配→anonymous 拒）→④清 pending——新增 `pendingOnloadFail/pendingUnloadFail` 双通道,`failPendingLifecycleWaits` 使在途 onload/onunload 等待快速失败（不再干等 LOAD_TIMEOUT）,onload.done/error、unload.done 回执双表同清。contextPort=runtime 页级共享口非 per-plugin（销毁面=registry 记录+沙箱 iframe;视图会话已 dropPlugin）,注释+L9 锚点登记。
2. **P2-009 生命周期状态机补全**：`LexiLifecycleState` 补 `permission-pending/degraded/revoked`（+既有 quarantined/verified 凑齐 RFC §4.1 全量面）；迁移表 14 状态全量+静态查询面 `canTransitStatic`；每次迁移落 `LexiLifecycleEvent` 原因账（journal 环形 256,`historyOf` 供审计/Inspector）。语义映射：verified=安装面验证通过（scan 链 markInstalled 后 markVerified）；permission-pending=R26 安装未授权（installZip 首装路径落账;enablePlugin 授权前置整体**前置于状态机 starting**——not-granted/regrant 经 rejectToPending 落 permission-pending,顺带修掉「拒绝分支卡死 starting activation」的旧缺陷;转出:同意→starting/撤销/隔离/卸载）；degraded=能力收缩升级降级运行（T4.4 只减不增放行,installer.lastRemovedCaps 快照→启用后 markDegraded）；quarantined=安全事件隔离；revoked=P2-010 链（revokePluginPermissions→disablePlugin→markRevoked;出口=卸载或重新落账后 enablePlugin 内 liftRevocation→permission-pending）。
3. **quarantine 安全事件触发链（验收行核心）**：市场安装链 options 携带 `targetPluginId`（LexiPluginMarketSheet entry.id;grantApproved 仅重授权确认行置真的 P5-004 语义保持）→ installZip catch 命中 `integrity_mismatch`（P5-001 verifyPackageHash 机器码）→ `quarantinePlugin`：先落 `record.quarantineReason` 标记（销毁途中并发 enable 一并被隔离门拒绝）→ disablePlugin 销毁闭环 → markQuarantined。enablePlugin 隔离门拒绝启用,唯一出口=卸载后重装。运行期 §4.3 强停路径（activation 级 quarantine）原样保留。
4. **门禁**：lifecycle-once **37→71**（L7 迁移表 13×13 逐格对账+五新态可达/转出/原因账行为级真跑+L9 销毁闭环接线锚点）；context-registry **15→23**（D 组 SEC-013 行为级负例:销毁后旧通道帧全拒 context_revoked、伪造身份+穿越路径帧先于身份与 fs 层被拒、重复销毁幂等无僵尸、新 contextId 不受影响、Gateway unknown_method 分层对账）；context-isolation **82→86**（S41 容器销毁面+宿主五步尾序）；dist-regression **39→40**（R32 接线对账;MarketSheet options 三目锚随实现升级,grantApproved 语义保持由新断言钉死）；contract-matrix symbols.json 2 处行号漂移手修（:1740→:1809[throw 定型后二次漂移]、:1542→:1610）。**release-gate 29/29 ×2** + assembleHap BUILD SUCCESSFUL。

### 100% 口径（如实裁定）

销毁闭环覆盖的通道面：①沙箱轨 per-plugin iframe（容器页 teardown,SEC-013 主对象）②contextRegistry 端口身份（sandboxHost.call/端口帧两条前门的身份真源）③页面凭据表（legacy 轨 credential 第 4 参形态+源码分片通道）④在途生命周期等待（onload/onunload 快速失败）。视图会话（dropPlugin）、命令/扩展/ribbon/codeblock 登记面回收在启用段原位。旧通道拒绝的机器码分层：registry 层 context_revoked（先于身份剥离与 fs/路径判定）→ Gateway 层 unknown_method/bad_request → 身份层 identity_untrusted。设备负例（卸载→旧通道 RPC 真机拒绝）待 P4-005 批次,IMPLEMENTED ≠ VERIFIED。

### 实际执行的测试

release-gate 29/29 ×2、lifecycle-once 71、context-registry 23、context-isolation 86、dist-reg 40/40、bridge-security 50、authz-matrix 93、update-policy 16、permission-store 28、shim-reg 12、kernel-reg 6、contract-matrix(--fixtures-required)、assembleHap PASS（BUILD SUCCESSFUL）。

### 预存红（与本轮无关,上轮已登记）

- `plugin-route-coverage`：editor.* 孤儿（R27 起的 `_apply` 间接,非本轮引入）。
- `input-robustness-evidence`：设备证据项(2026-11-02 会话)。
- `plugin-tasks-compat`：PENDING（夹具态）。

### 下一轮

**R33 = P1-009 + P1-010**（SEC 全表进门禁;Phase 1 出口评审,RELEASE_READINESS 复核）。设备批次补:P1-008 卸载→旧通道 RPC 真机拒绝负例。

最近更新时间：2026-11-07（Round 32）。

## Round 33 — 2026-11-07（P1-009 + P1-010 → 离线全绿;SEC 覆盖矩阵进 release-gate + Phase 1 出口评审草案 + 逐 SEC 设备证据审计）

### 本轮完成

1. **P1-009 SEC 覆盖矩阵门禁（新 `scripts/tests/plugin-sec-coverage.cjs`）**：RFC §13.4 全表 **SEC-001..018**（任务行口径 001..008/011..013,RFC 实际有 018 一并纳入,防静默漏项）逐条映射→证据→机器对账:离线证据={门禁脚本, 用例 needle 数组},每个 needle 必须仍在门禁源码中（**用例被删/改名=矩阵红,这就是"已覆盖项回归即红"的机制**）;设备证据={label, probe needle},probe 必须仍在 PROGRESS/TEST_MATRIX/RELEASE_READINESS/EXECUTION_PLAN 中（**证据指针不许静默腐烂**）。verdict 规则:covered=离线正/负用例+设备上有"实际攻击被拒"负例;partial=必须写名 blocker(正则强制指名任务号/B-编号/设备批次);uncovered=直接红（P1-009 验收行:每条 SEC 有正/负用例）。RFC §13.4 活体解析对账（RFC 增删 SEC 条目与矩阵双侧漂移都红）。矩阵快照:**covered=4（SEC-001/003/004/010）partial=14 uncovered=0,282 项对账 PASS**。
2. **离线缺口收口（不造假覆盖）**：①context-registry **23→24**:R3.1b（SEC-006 存储面同轨——data.load 帧自报他插件 id 被剥离,宿主按记录身份归属私有存储;broker 桩补 data.load 域）；②dist-regression **40→42**:新增两组行为级真跑——LexiPluginRuntime.ets 转译装载（loadEts 增 @kit/@ohos 自动桩兜底:混合 Proxy 属性链可调,显式 kits 优先,只扩可装载面不改既有判定）后从类原型真调 `fsGate`/`vaultReadGate`/`storageQuotaGate`（SEC-005 身份归属 fail-closed/SEC-008 无 fs 域拒+白名单外拒/SEC-009 穿越形态拒/SEC-006 data 域解绑正例/SEC-011 配额超限拒+边界放+v1 无配额语义,判定代码=交付的同一份编译产物）;`LexiWebRuntime.withTimeout`（SEC-012:永不完成→超时拒绝带标签/慢工作被超时胜出/快工作原样交付——全部 dispatchWithTimeout 与生命周期等待共用该 helper）；③**net-request-url（83 断言,SEC-010/011 主力门）纳入 release-gate**——此前不在 CI 集,"覆盖矩阵指向不进 CI 的门禁"=假保障,诚实性要求纳入。
3. **P1-010 逐 SEC 设备证据审计（不跑新设备,只对账 R25-R32 在案证据）**：B-001 已解除（R8 起设备批次持续在跑），行状态 BLOCKED→IN_PROGRESS。**设备已证**（SEC-001 父窗口 DOM/opener、SEC-003 sibling+双插件并发、SEC-004 凭据扫描 0 命中×2 轮、SEC-010 直接外传 fetch/XHR blocked、SEC-014 篡改包 integrity_mismatch、SEC-018 安装链正向）=R9 PoC verdict+R24 并发+R8/R26 flows+R26 授权链+R28 业务路径探针 10/10 blocked credentialHits=0+legacy 停用 fail-closed。**离线已证/设备待批次**（SEC-002 Track2 残面、SEC-005..009/011/012/013/015/016/017 的真机负例）逐条 blocker 写入矩阵;P1-005/P1-007/P1-011/P2-009 的设备复核欠账同批登记。
4. **Phase 1 出口评审结论草案**（RELEASE_READINESS 新节）:验收五条 1-4 达成有设备背书;第 5 条（撤销立即失效）离线达成设备欠账;出口判 **有条件出口**——欠账=设备负例批次+HUMAN_QUEUE#3 两项 ADR 复审(P1-004/R29-01、默认翻转/R28-01)+B-002 信任链半边;§17.1 DoD 逐行复核(100% RPC 进矩阵=✔ P1-007 口径/0 可读凭据=✔/包 SHA-256=未达发布链/上下文独立生命周期与撤销=离线✔设备欠账)、阻断项清单刷新（原 P0 安全三条收敛出名单:哈希 fail-open R7 封真机 VERIFIED/自动启用 R26 设备回填/共享 realm R25-R32）。
5. **门禁**：release-gate --ci **29→31**（+net-request-url 第 11 步、+sec-coverage 第 30 步）、sec-coverage 282 项、context-registry 24、dist-regression 42。TEST_MATRIX 主表 +2 行（net-request-url/SEC 覆盖矩阵）+SEC 映射节重写为 R33 矩阵快照。

### 本轮不做的（诚实边界）

- 不跑任何新设备用例（supervisor 职责）;设备欠账只入台账不改判 verdict。
- SEC-002 不宣 covered：沙箱轨设备负例虽在,Track2 工作区页执行面未收敛（P1-004 ADR 待评审）——残面开口必须显式可见。
- SEC-014/015/017 的 authenticity/回滚链/撤销源缺口全部如实指名 B-002/P5-002/003（Phase 5 域）,不因模型级负例在案而宣称覆盖。

### 实际执行的测试

release-gate --ci **31/31**、sec-coverage 282 项(covered=4/partial=14/uncovered=0)、context-registry 24、dist-regression 42、bridge-security 50、context-isolation 86、authz-matrix 93、net-request-url 83、update-policy 16、registry-trust 14、package-verifier 26、lifecycle-once 71、identity-delivery traced 32 gaps 0。

### 下一轮

设备批次（supervisor）:SEC 逐项真机负例（矩阵 blocker 列即清单,P1-008 卸载→旧通道 RPC 拒绝为第一优先）+P1-005/P1-007/P1-011/P2-009 设备复核。主线:R34 起 Phase 3(P3-001..004+P0-004),HUMAN_QUEUE#3 两项 ADR 复审催办。

最近更新时间：2026-11-07（Round 33）。

### Round 33 追记（同日,设备负例批次第一项）

**SEC-013 销毁闭环真机定案**（设置→市场→卸载 sandbox-editor-min）：`请求停用`→`插件已停用`→`context registry 吊销 1 个上下文`→**`sandbox context destroyed: ctx-4-sandbox-editor-min`**（容器 iframe 拆除）→`plugin tokens 吊销 1 个`→`插件已卸载 → .trash/sandbox-editor-min-<ts>`——P1-008 四步序在真实卸载路径全序触发,旧通道 context 已吊销。P1-010 台账:SEC-013 设备负例关闭;剩余设备负例（Track2 拒载受 P2-013、SEC-002 Track2 面、SEC-014..017 B-002 链）按 sec-coverage ledger 归后续批次/Phase 5。

最近更新时间：2026-11-07（Round 34）。

## Round 34 — 2026-11-07（R34 = Phase 3 开工:P3-001 SDK 构建/发布成型 + P3-004 CLI 命令补全 → 离线全绿）

### 本轮完成

1. **P3-001 SDK 构建/发布成型**：①`packages/lexinote-plugin-sdk/tools/build-dist.cjs`——src/*.ts → dist/ 编译产物（ts.createProgram 严格类型检查,**类型错误即红不发半成品**;产物 index/contract/capabilities × js+d.ts 六文件,锚点齐全,显式检查 dist 无源码 ts 混入;typescript 解析=LEXI_TYPESCRIPT→与 release-gate 同候选列,离线无新依赖）;②package.json 入口改编译产物——`main: dist/index.js`、`types: dist/index.d.ts`（原 `main: src/index.ts` 源码 ts 悬空消除）,补 `exports` 映射（. / ./types/lexinote / ./schema/* / ./package.json）与 files.dist;③**稳定性锚点不打 Stable**（P2-00x 约束）——`lexinote.stability: "experimental"`+README 顶部 Experiment 声明,版本保持 1.0.0（与宿主/shim 三方一致由 S2 继续钉死）;④README 新建零悬空字段（包内容表/入口说明/离线安装两种方式/使用含 tsconfig paths 映射/开发命令/契约对账清单;contractSource 悬空指针落指 schema/ 真源）,模板 README 增 SDK 安装节;⑤dist 入 .gitignore（prepack 按需重建,防陈旧产物入库）。**验收固化进门禁**：plugin-sdk-contract **30→37**——新 S7 四连:npm pack（prepack 自动构建）产出 tarball → 临时 fixture `npm install <tarball> --offline`（零网络）→ require 安装产物验 API_VERSION/capabilityTags/methodsOf → tsconfig paths 双路 ts.createProgram 类型消费（@lexinote/plugin-sdk 入口 + lexinote/obsidian 别名 ambient 面）。npm pack 产物=lexinote-plugin-sdk-1.0.0.tgz。
2. **P3-004 CLI 命令补全**（tools/lexi-cli/lexi.cjs,build/validate/pack/sign/publish 既有行为逐字节保持,C1-C6 零改动仍绿）：**dev**=validate+build 单次 pass;`--watch` 真 fs.watch 监视循环（debounce 120ms,只盯 main.js/manifest.json/styles.css;单次 pass 失败 fail-visible 打印不退环——坏编辑可恢复）;**test**=运行 `<proj>/test|tests/*.cjs|mjs|js` 真子进程（逐文件 ok/FAIL+退出码+失败输出透传;无测试文件=红,不假造通过）;**inspect**=manifest 摘要+入口（bytes/sha256/iife 标记来自真实文件）+pack 文件清单（与 pack 同一 walk）+授权标签（SDK capabilityTags 经同一转译法复用,单一真源）+宿主 v2 严格解析面（有 LEXI_TYPESCRIPT 则真跑,失败 fail-visible）;`--json` 机器面;**doctor**=八项环境体检（node/typescript/宿主 shim `__lexiWrapPluginSource` vm 复用/宿主解析器/契约快照/SDK schema 导出/zip-store/可选项目 arg）,三态 ok/warn/fail——ts 缺席=warn（体检不装死,退出码 0）,设了但装载失败=fail（退出码 1）;**compatibility**=manifest compatibility 对宿主 API 版本对账（min/maxExclusive 语义比较,不满足即红）+capability-map 授权类别分布+api-surface 状态分布+CM 宿主矩阵读数+能力标签。loadShimWrapper/loadHostModule 重构为抛错形态（doctor 可探针,fail-visible 语义不变）。
3. **门禁**：cli-contract **18→45**——C7 dev（单次 pass+`--watch` 子进程真跑:改 main.js 触发 change# pass+OS 级进程终止校验,注意父进程 spawnSync 阻塞事件循环时 child.exitCode 不更新、改用 process.kill(pid,0) 探活）/C8 test（无测试红/真过/真败逐文件可见）/C9 inspect（摘要真实+iife 标记+`--json` 解析+缺 manifest 红）/C10 doctor（八项在案+warn 形态）/C11 compatibility（读数+SDK 标签归一化排序+宿主不满足下界必须红+恢复回绿）/C12 **create→validate→build→inspect→pack→sign→publish 全链离线一条龙**（八步退出码+五产物落地断言）。TEST_MATRIX SDK/CLI 行与全量门禁行刷新。

### 诚实边界（IMPLEMENTED ≠ VERIFIED）

- 全部离线证据。SDK 的 npm pack→install 链证明的是**包形态可安装可消费**（真实 npm 11.9.0 离线装包+真实 tsc 4.9.5 全程序类型检查）;真实 registry 发布、外部开发者不读宿主源码的全流程演练=P3-008（依赖 P0-004 文档入 Git）。
- `stability: experimental` 是包级锚点;方法级 status 仍全部 stable（api-surface 快照面,P3-003 类型硬化时一并复核）。
- dev --watch 是本地开发循环,热重载（改码→宿主不重启重载）归 P3-005,本轮不做。
- 兼容性命令的版本对账是**声明面**对账（manifest 声明 vs 契约快照）,不做代码级 API 用量静态分析。

### 实际执行的测试

release-gate --ci **31/31**、plugin-sdk-contract **37**（+S7 npm pack/install 消费）、lexi-cli-contract **45**（C1-C12）、hvigorw assembleHap **BUILD SUCCESSFUL**（33 tasks,无签名配置=既有 WARN）。

### 下一轮

**R35 = P3-002（类型单一真源翻转:SDK 为源、模板消费,对账脚本校验同源）+ P3-003（sdk-contract 真类型检查:注入类型错误必须红）**;P0-004 文档入 Git 待人工决策（docs/ 目前 gitignore 本地账面）。设备批次欠账不变（SEC 矩阵 blocker 清单即清单）。

## Round 36 — 2026-11-07（R36 = P3-007 示例工程组五类 + 每例真实 CLI 构建校验 → 离线全绿）

### 本轮完成

1. **P3-007 示例工程组**：`tools/lexinote-plugin-template/examples/` 五例（`example-commands`/`example-vault`/`example-view`/`example-markdown`/`example-settings` + 组索引 README），每例 v2 manifest + 纯 CJS main.js（`lexi plugin build` 直接可包装）+ README「运行轨面与边界」。**轨面按诚实纪律分配，不假造**：
   - **命令/Vault=沙箱轨声明**（`entrypoints.service:'sandbox:'`）：只用沙箱轨已实现面——Plugin/addCommand(callback+editorCallback)/Notice/loadData/saveData；vault 六方法（getMarkdownFiles/getAbstractFileByPath/read/create/modify/process）+normalizePath/moment。vault 例声明 `vault.write.paths:["插件笔记/"]` 演示 P2-004 写路径白名单（README 附白名单外负例注释，注明预期宿主 `capability.path` 拒绝）。
   - **视图/Markdown/设置=runtime 页轨**（`service:'main.js'`）：这三个面的真实实现在 legacy shim——`registerView`→`views.add` RPC+`WorkspaceLeaf.setViewState` 真实例化挂 DOM、`registerMarkdownCodeBlockProcessor`→`codeblocks.register`+`registerMarkdownPostProcessor`→LexiReading 注册表、`addSettingTab`→`settings.register` 声明式链（宿主 `LexiPluginSettingsSheet` 原生渲染+值写回 data.json）。README 显式带 `sandbox-track: pending (P4-001/P4-005)` 标记与 `lexiPluginLegacyTrack` 开关依赖；设置例额外诚实标注**值运行中回推（onSettingsChanged/setControlValue）宿主尚无通道**——示例不依赖回推，值经 data.json 下次装载读回（调查结论：SDK 类型文档该段为前瞻声明）。
2. **门禁 `scripts/tests/plugin-examples.cjs`（新，进 release-gate --ci 第 27 步）**：五例各在临时目录经**真实 CLI** 独立跑 validate→build→inspect(--json 字段断言)→pack(zip+sha256)；build 产物断言 `lexi-iife:v1`+sourceURL+注册表交付+无 `new Function`；产物 vm 求值→注册表交付插件类→onload boot 全链（沙箱严格面=loadData/saveData/addCommand 真走 stub 管线）。**面清单单一真源=宿主源码**：沙箱 namespace 成员与 SandboxPlugin 原型方法自 `lexinote_plugin_sandbox.html` 正则提取（namespace 6 成员/原型 12 方法），legacy 超集自 `PluginShim.prototype`（17 方法）；沙箱例的 obsidian 解构成员必须 ⊆ 真实 namespace、Plugin 原型方法逐一显式映射（宿主扩面而门禁未跟上=红，fail-visible）。**非空洞证明**：两个负例注入实测红——①沙箱例注入 `registerMarkdownPostProcessor` 调用（legacy-only 面）→boot 红；②沙箱例解构 `Modal`（namespace 越面）→对账红；撤销后回绿。
3. **文档**：docs/plugin-development.md 增「示例工程组」节（五例索引+轨面表+门禁指引）；模板 README 增示例组节；EXECUTION_PLAN P3-007 行刷新；TEST_MATRIX SDK/CLI 行并入 examples 门禁读数。

### 诚实边界（IMPLEMENTED ≠ VERIFIED）

- 全部离线证据。示例的**运行时行为**（视图实例化挂 DOM、Markdown 渲染回调触发、设置页原生渲染+值写入、编辑器命令快照回推、命令面板回环）属设备批次 **P4-005** 验收面；本轮证明的是 manifest 契约、CLI 构建链、IIFE 产物形状与 boot 期面契约。
- runtime 页轨示例依赖 `lexiPluginLegacyTrack != 'false'`（当前默认 true；ADR-R28-01 默认翻转复审通过后随 P4-005 迁沙箱轨）。
- 沙箱面清单提取是正则锚定（`var obsidian = {`/`SandboxPlugin.prototype.`），宿主源形态大改时门禁会以"提取为空/缺锚点"红——属预期 fail-visible，不静默放行。

### 实际执行的测试

release-gate --ci **32/32**（31→32：新增 examples 步）、plugin-examples **51 项**（含负例注入红→撤销回绿）、lexi-cli-contract 45、hvigorw assembleHap **BUILD SUCCESSFUL**（33 tasks,无签名配置=既有 WARN）。

### 下一轮

Phase 3 收口复核（P3-005 热重载/P3-006 Inspector 完整化待排）；P4-001 Modal/Menu/Settings 与 P4-005 夹具批次（示例中的 pending 标记即迁移清单）。

## Round 37 — 2026-11-07（R37-A = P4-001 Modal/Menu/Setting Builder 实现 → 离线全绿）

### 本轮完成

1. **P4-001 三交互面（沙箱轨,不只类型声明）**——端口链纪律全程:iframe 零 DOM 句柄,描述符经既有 request 链出站,结果经容器回推帧回流,身份永不进 iframe（ADR-R18-01）：
   - **Modal**：`lexinote_plugin_sandbox.html` 新 `SandboxModal`（setTitle/setContent/onOpen/onClose/open/close）→ `ui.modal.open/close`（宿主 handler,身份段表键 `pluginId#modalId` 只能寻址自己的在途面）→ 新组件 `LexiPluginSurfaceHost.ets`（观察 `lexiPluginRevision`,Index.ets Stack 嵌入）原生弹层;用户关闭 → 容器 `window.lexiSandboxUiEvent`（新,按 pluginId 路由,帧零身份字段）→ iframe `sandbox.ui{kind:modal}` → onClose + open() Promise 兑现（幂等 settle,重复回推 no-op;宿主拒绝 fail-visible 落 slog）。
   - **Menu**：`SandboxMenu`（addItem 桩记录声明式条目+onClick/addSeparator/showAtPosition/showAtMouseEvent/hide/onHide）→ `ui.menu.show/hide`（payload schema: items 必须 array）→ 宿主原生菜单（钳制呈现 x/y）;点选/点外 → `sandbox.ui{kind:menu,event:item|closed,itemId}` → onClick 动作与 onHide、show() Promise 兑现。
   - **Setting Builder**：`SandboxSetting` 收集器（display() 内 `new Setting(containerEl)` 落账声明式控件 type/key/default/options/min/max/step/placeholder+onChange 回调;`setKey`=LexiNote 寻址键,缺 key 数据控件不进定义并落痕）+ `SandboxPlugin.addSettingTab` 真实化（收集窗口跑 display()→并上 getSettingDefinitions() legacy 形状→既有 `settings.register` 出站→宿主既有 `LexiPluginSettingsSheet` 原生渲染,值持久化 data.json）。**值运行中回推通道已接**（R36 调查缺口收口）:`writePluginData` → `sandbox.ui{kind:settings,values}` → 控件 onChange（按 key 寻址）+ tab.onSettingsChanged;setControlValue 同帧兑现。legacy 轨 dispatch('settings.values') 保持不动。
   - **宿主侧加固**：broker 矩阵 ui-domain 增 4 方法（capability 域映射 notifications=与 Notice 同域,未声明即拒;独立 ui.popups 域留 manifest 键轮决策）、Gateway schema 4 条、`dropPluginSurfaces` 随 P1-008 销毁尾序回收在途面、BUNDLED_PLUGIN_IDS 增 `plugins/sandbox-ui-min`。
2. **夹具+示例**：`plugins/sandbox-ui-min`（gitignore 同批本地暂存,manifest v2 sandbox: + notifications,命令 ui-modal/ui-menu 触发 Modal/Menu,PluginSettingTab 子类 display() 建 toggle/dropdown/slider 三控件+onSettingsChanged 记账);`examples/example-ui`（第六例,沙箱轨声明 `faces: all-real`,README 记录端口链语义与 capability 对账）。
3. **门禁**：context-isolation 86→**111**（S34×4 交互面静态+S42×5 宿主接线+**E4/E4b 业务链行为级探针**:真实沙箱页脚本 vm 装载 sandbox-ui-min,settings.register 定义出站/ui.modal.open 描述符/sandbox.ui 关闭回推→onClose 落账/menu.show 条目表/item 回推→onClick+onHide 落账/settings.values 回推→控件 onChange+onSettingsChanged 双路径落账/全链帧零身份,8 项×CJS+IIFE 双分支）;examples 51→**63**（六类+E0 对账+example-ui 命令回调真实执行断言）;dist-regression 42→**43**（P4-001 接线:handler/身份段表键/capability 映射/回推分流/销毁回收/渲染组件嵌入/容器帧零身份/夹具对账）;契约三份快照手改（api-surface.json+capability-map.json 67→71 方法,symbols.json 两处行锚 1809→1973/1610→1767,SDK 副本 sync-sdk.cjs 刷新）;lexi-cli-contract 45（API 面 67→71 方法）;docs-contract 17（plugin-api-reference ui 域增 4 方法行）。**examples strict boot 空转修正**:stub `load` 此前不驱动 onload,R36 的"onload 全链"断言对沙箱例空转——修为与宿主 SandboxPlugin.load 同语义真驱动(example-ui 行为断言暴露,全例回绿)。

### 诚实边界（IMPLEMENTED ≠ VERIFIED）

- 全部离线证据（vm 行为级+静态接线）。**设备批次 P4-005** 才验收:弹层/菜单真实呈现、用户点按回流、设置页改值回推、多插件并发弹层、菜单坐标精确锚定（本轮 x/y 仅钳制呈现——沙箱坐标与宿主视口无换算基准）。
- `sandbox.ui` 回推通道与 `lexiSandboxCommand` 同信任形态（容器页按 pluginId 路由+帧零身份）;容器页被攻破时同 realm 残余与 R30-B 登记同级,不在本轮夸大。
- 沙箱 UI 交互面能力域复用 notifications（最小清单改动,指纹标签已在案）;独立 ui.popups 域（清单键/指纹/SDK schema）留 manifest 键轮,届时换映射=重授权 diff。

### 实际执行的测试

release-gate --ci **32/32**、context-isolation **111**（含 E4/E4b 全链探针）、plugin-examples **63**、dist-regression **43/43**、authz-matrix **93**、shim-regression **12**、channel-audit 死通道 0、lexi-cli-contract **45**、docs-contract **17**、sdk-contract **39**、hvigorw assembleHap **BUILD SUCCESSFUL**。

### 下一轮

P4-005 夹具批次（设备验收:含本面三交互+R36 示例的 runtime 页轨面迁移）;P4-002 Suggest 系（依赖本面 Modal 载体）。

最近更新时间：2026-11-07（Round 37）。

### Round 37 追记（同日,P4-005 设备批次第一段 + R37-B）

- **R37-B/P2-013 修复收口（69da705）**：Toggle 多次触发根因=await 窗口旧值回拉+无守卫（非双注册）；重入守卫+值幂等+乐观同步；负对照复现 bug 形状。
- **allow-list 补齐**：R37-A 自述已加 sandbox-ui-min 白名单但提交代码缺失（验收差异抓获）——主线补上（与探针先例一致），dist-reg 43/43、构建绿。
- **P4-001 三面真机全定案（sandbox-ui-min）**：Modal `opens:1`+`modalClosedAt`（宿主原生弹层"沙箱交互面"经端口链）；Menu `menus:1`+`menuPick:"star"`+`menuClosedAt`（原生菜单"标记为重要/归档",onClick 经 sandbox.ui 回环）；**Setting pushback `changes:1`+`controlFired:1`+`lastChanged:{showBadge:true,uiLevel,maxItems}`**（原生设置表单改值→onChange 送达 iframe）。三面 data.json 铁证。
- **P4-005 定级进度**：sandbox 系夹具（probe/sample-min/editor-min/sec-probe/ui-min）真机证据充分（对应 C 级=沙箱原生面全用）；legacy 系（calendar/outliner/editor-outliner/compat-probe）证据采集派工中。

### Round 38（P4-005 证据批次 + 定级）

**证据**（/tmp/p4005/ 全套 dump+hilog）：①**calendar C2**——enable/onload OK,1 视图+3 命令注册,show-calendar-view 执行但视图面为"已退役"占位（P4-001 视图域证据）、open-weekly-note **静默无操作**（`LexiPluginRuntime.ets:2520 invokePluginCommand .catch(()=>{})` 吞失败=fail-visible 违例→登记 **P2-014**）、依赖 periodic-notes 缺失；②**obsidian-outliner C1**——eval 失败"不支持模块 @codemirror/view"（**fixture 未打包依赖**→登记 **P4-006**）；③**compat-probe C1**——同类(@codemirror/state)；④**附带缺陷：卸载清理身份丢失**——calendar 停用 onunload 清理 7 条 authz.denied（anonymous 无权删自有资源,identity 上下文在 teardown 丢失→登记 **P2-015**）；⑤无崩溃、P2-013 修复后开关单击=单次切换实证。**sandbox 系 5 夹具定级：沙箱原生面全用（C4 等价）**（R24-R37 data.json 铁证链）。

### Round 39-A（P2-014 + P2-015：P4-005 设备批次暴露的两个缺陷,离线修复）

**P2-014 命令失败 fail-visible**（设备证据:open-weekly-note 经命令面板=静默无操作,零 hilog 零通知）:
- 根因两层:①宿主 `LexiPluginRuntime.ets invokePluginCommand` 以 `.catch((): void => {})` 吞派发失败（原 R38 登记）;②**shim 侧失败通知通道本身匿名**——`invoke.command` 回调异常的 catch 虽发 `ui.notice`,但不带令牌→ui-domain 对匿名 fail-closed→通知被宿主拒收,失败永远不可见（这是"零通知"的完整根因,R38 未识别）。
- 修复:①宿主 `reportCommandDispatchFailure` 统一出口（pluginError+record.errorState+uiHost.toast 三面,不向上抛,成功路径零改动）;invokeEditorCommand/invokeRibbon 同类吞噬点一并接同一出口。②shim 命令/编辑器/Ribbon 回调失败的 ui.notice 补带归属令牌（commandToken/tokenForPluginId）;顺带修正编辑器分支误用命令分支悬挂变量 commandToken → editorCommandToken（原形态跨派发残留上一次命令的令牌）。

**P2-015 卸载清理身份链**（设备证据:cal_off.hilog 7 条 authz.denied）:
- 7 条两类,吊销时序无责（P2-010 吊销本就后置于 onunload 完成,disablePlugin 顺序核实无需动）:
  - 5 条 anonymous（views.remove/commands.remove×3/settings.unregister）:shim `unloadPlugin` 裸调 `instance.unload()` 无身份上下文——loadPlugin 有 `withToken(pluginToken,…)` 对称面,unload 没有;清理闭包依赖现场栈,栈空→匿名→fail-closed。
  - 2 条"资源归属不明"（events.off/workspace.closeView,identity=calendar 在案）:**宿主预检缺陷**——`LexiWebRuntime.call` 的 resource-less 预检对 plugin-owned 用 resource=null 直判 `authorize`→"归属不明"拒绝,处理器层的 authzFor（带 resource 的真正归属复查）经页面通道永远不可达。此缺陷殃及全部 plugin-owned 方法的插件身份调用,非 unload 特有。
- 修复:①shim `unloadPlugin` 先捕 `objectToken(instance)`→`withToken(pluginToken, instance.unload())`+unload.done 带令牌;五个清理闭包（views.remove/commands.remove×2 形态/ui.removeRibbon/settings.unregister/codeblocks.unregister）显式 `objectToken(self)||currentToken()`。②broker 增 `entryAuthorize(ctx, method)`:仅 plugin-owned+插件角色后置到处理器 authzFor（匿名照旧入口 fail-closed、会话照旧代管、其余 kind 与 authorize(...,null) 全矩阵逐格一致）——归属校验本身零放宽,M3.3 门禁钉死五方法带 resource 复查。

**门禁**:shim-regression 12→**14**（卸载清理链逐 RPC 断言携带装载令牌/失败命令产生可见+带身份通知,host mock 记录第 4 参凭据）;authz-matrix 93→**101**（M2d entryAuthorize 8 项,含全矩阵逐格一致性）;dist-regression 43→**44**（R39 接线:宿主三出口+无空 catch+entryAuthorize 后置+卸载身份链,含"五 owned 方法必须带 authzFor"前提断言）;symbols.json 3 处行锚手修（shim 2185→2191/runtime 1973→1974/1767→1776,R39 代码位移）。**附带**:dist-audit 扫描卫生——注释体等长留白后再扫（bridge-security R7a 同口径）:非压缩重打的 CM6 文档注释"starting from \`from\`."被 from-反引号正则误读成 import（R39-B 夹具重打暴露的审核器误报）,真实违规零漏（malicious 两 findings 原样）。

**实际执行的测试**:release-gate --ci **32/32**、shim-regression **14**、authz-matrix **101**、dist-regression **44/44**、dist-audit --all ok、hvigorw assembleHap **BUILD SUCCESSFUL**。

**诚实边界（IMPLEMENTED ≠ VERIFIED）**:全部离线证据。设备复测归主线程批次:calendar 卸载清理零 authz.denied+命令失败可见通知（P2-014 的设备面还依赖 shim 通知通道——失败命令应出现 toast）。

### Round 39 追记（同日,设备复测批次）

- **P2-015 复测通过**：calendar 启→onload→停全周期 **零 authz.denied**（R38 的 7 条清理拒绝签名消失,卸载清理以原身份成功执行）。
- **P4-006b 复测通过**：obsidian-outliner **onload 完成+已启用**（eval 失败消失,捆绑依赖生效）——C1→**C3**（视图/命令面待交互复测）;compat-probe onload 通过+探针运行（vault.rename 等如实打点,"没有同页编辑器"如实上报）——C1→**C2**。
- **P2-014 设备 toast 复测**：受 UI 定位抖动阻（列表重渲染坐标漂移,一次重试未中）——离线行为级+reportCommandDispatchFailure 机制直读已证（pluginError+errorState+toast）,余一步触发验证留台账。
- **P4-005 复定级**：calendar C2（unload 清理已修复,视图面仍占位）、obsidian-outliner **C3**、compat-probe **C2**、sandbox 系 C4 等价。

### Round 41（R41 = P4-002 Suggest 系:沙箱轨 EditorSuggest 建议浮层 → 离线全绿）

**本轮完成**:P4-002 按 R37-A(P4-001)端口链先例落地——**沙箱 EditorSuggest 基类**（`SandboxEditorSuggest`:constructor(app)/open/close/setSuggestions/setInstructions + onTrigger/getSuggestions/selectSuggestion/renderSuggestion,插件 extends 覆写）→ `ui.suggest.show/hide` 描述符出站（capability=notifications 与 Modal/Menu 同域;broker 矩阵 ui-domain + Gateway schema 各扩 2 方法）→ 宿主 `LexiPluginSurfaceHost` 新 suggestLayer 原生浮层。**值不出 iframe**:建议值永不越过端口链——show 只带显示描述符 `{index,title,detail,icon}`（_displayOf 投影）,宿主点选只回 `itemId=index`,selectSuggestion 在 iframe 按值表回取原值;点选/点外关闭经 `sandbox.ui{kind:suggest,event:item|closed}` 回推（帧零身份,容器路由零改动——itemId 既有字段直用）,open() Promise 幂等兑现（settle 一次即焚,重复回推 no-op 留痕）。**触发=显式调用**（宿主无编辑器事件流,editor.events 归后续切片）:open(editor) 驱动 onTrigger(cursor,editor),cursor 来自命令帧快照（P2-005 档位脱敏在宿主;夹具 ui-suggest 声明 editor.readActive）。**诚实边界**:SuggestModal/FuzzySuggestModal/PopoverSuggest 家族不假造导出（仍属沙箱轨未实现面）;浮层锚点=固定钳制默认位（沙箱坐标与宿主视口无换算基准,光标级精确锚定归设备批次校准）。**plugin-tasks-compat 的 EditorSuggest 缺口核查**:ladder level-1 期望形状（constructor(app)/open/close/setInstructions/onTrigger/getSuggestions/renderSuggestion/selectSuggestion）与本基类逐项一致——但该门禁判定的是 **legacy 轨 rawfile shim**（obsidianNamespace 仍无 EditorSuggest 导出,其 §0 结论口径不变）,沙箱轨补面不改其 PENDING 判定,按任务纪律不强制翻案。**夹具/示例**:sandbox-ui-min 增 `ui-suggest` 编辑器命令（open→pick→closed 全链,data.json 铁证字段 `suggests/suggestPick/suggestSettled/suggestClosedAt`）+ manifest 增 `editor.readActive` 档;example-ui 增 `hello-suggest`（ExampleSuggest extends EditorSuggest）。**门禁**:context-isolation 111→**122**（S35×2 静态+S42f/g/h 宿主接线+E4 i/j/k 建议链探针,CJS+IIFE 双分支）;plugin-examples 63（沙箱面清单 namespace 9→10 成员,严格 stub 对账 fail-visible 跟进,example-ui Modal/Menu/Suggest/Setting 四面登记断言）;dist-regression 45→**46**（P4-002 接线:handler/身份段在途表/回推双入口/销毁回收覆盖 suggestSurfaces/渲染层/网关 schema/broker 矩阵/沙箱基类形状/夹具对账）;契约三份快照手改（api-surface/capability-map 71→**73** 方法+sync-sdk 刷新 SDK 副本与 contract.ts;symbols.json runtime 行锚 1776→1838/1974→2036 手修;compat-matrix.md 重渲染逐字节一致）;cli-contract 60（C11.1 needle API 面 73 方法）;docs-contract 17（api-reference ui 域增 2 方法行）。authz-matrix 101、channel-audit 死通道 0（孤儿提示含新 handler 属既有形态,exit 0）。

**实际执行的测试**:release-gate --ci **32/32**、context-isolation **122**、plugin-examples **63**、dist-regression **46/46**、contract-tripod 19、contract-matrix ✚、docs-contract 17、sdk-contract 39、cli-contract 60、authz-matrix 101、hvigorw assembleHap **BUILD SUCCESSFUL**（33 tasks,无签名配置=既有 WARN）。

**诚实边界（IMPLEMENTED ≠ VERIFIED）**:全部离线证据（vm 行为级+静态接线）。**设备批次 P4-005** 才验收:建议浮层真实呈现、点选/点外回流的设备铁证（data.json 铁证字段即清单）、光标级锚定校准、ui-suggest 编辑器命令经真机命令面板触发。editor.events 驱动触发（输入即建议）依赖编辑器事件流,不在本轮;SuggestModal/FuzzySuggestModal（modal 锚定建议）与 PopoverSuggest 仍属沙箱轨未实现面。sandbox-ui-min manifest 增 readActive 档=能力面变化,设备重装时按重授权 diff 走。

## Round 42（R42 = P5-005 + P5-010：Phase 5 分发半边独立项 → 离线全绿）

**本轮完成**:

1. **P5-005 演示源/开发安装明确标记 + 生产路径 https 强制**:唯一判定进市场模型(转译真跑)——`marketSourceKindOf`(https/dev-http/other)+`isProductionBlockedSource(url,isDebugBuild)`(fail-closed:仅「生产构建 × 明文 http」红灯,非 http(s) scheme 不扩权由安装口白名单拒)+`PRODUCTION_HTTP_BLOCKED_MESSAGE` 宿主与 UI 共用话术。**构建形态真源**=`bundleManager.getBundleInfoForSelfSync(GET_BUNDLE_INFO_WITH_APPLICATION).appInfo.debug`(签名证书 debug/release 形态;查询失败一律按生产处理——误拒只损失演示便利,误放行是明文攻击面)。**强制点双口**:installFromUrl(先于信任哈希闸与下载)与 fetchMarketIndex(索引供给哈希=信任根,明文索引等于把信任根暴露给同网段攻击者,§10.4)。**UI 面**(MarketSheet):明文 http 条目带「开发源·http」错误色标记;演示源激活或含 dev-http 条目时顶部「开发安装警示」横幅(明示生产构建拒绝 http);演示源按钮生产构建禁用+「演示源（生产不可用）」;UI 安装口同判定先行拦截(拒绝发生在发请求之前)。**调试构建零回归**:演示源 http://10.0.2.2:8099 常量保留、debug 构建按钮文案与 flows 锚点(/^演示源$/、/^演示源（使用中）$/)逐字不变。

2. **P5-010 更新与回滚闭环对账(Round 7 不对称修正)**:不对称根因=策略输入两侧哈希域不同——已装侧取 `.versions/<v>/main.js` 文件哈希、传入侧取索引声明的 **zip 包哈希**(或侧载空串),同版本比较必然「不同」:市场同包重装永远误拒、侧载拒绝话术谎称「检测到不同字节」。**修复**:①安装器按版本落**包哈希记录** `.versions/<v>/.package.sha256`(=该版本安装时经 verifyPackageHash 验证过的 zip 摘要;宿主管记账不进投影,侧载不产生记录——没有验证就没有证据);②LexiUpdatePolicy 同版本分支对称化:记录=声明→**幂等放行**(安装器保留真实上一版本,回滚链不被自我污染),记录≠声明→ERR_PACKAGE_INVALID(话术指向真实证据),任一侧缺失→拒绝但话术如实=「无法证明一致」;③哈希入参 typeof 防御式收敛(离线夹具 plain-object 传 undefined 不再 crash)。**RFC §9.2 十五步对账**进 plugin-update-policy U3:15 步逐条断言(行为级优先+宿主源锚),S1 可信元数据→S15 失败恢复旧指针全链可走通;**S3(发布者身份)诚实裁定**:TUF 接线归 P5-002(B-002),本轮只证 LexiRegistryTrust verifyChain/verifyPackageTarget 接缝在位+UI「签名状态:包哈希已校验/本地侧载(无远端哈希比对)」如实披露,不宣称 authenticity 闭环。行为级两向对账(安装/更新/回滚)进 dist-regression P5-010 用例:幂等重装/换字节拒绝/侧载诚实拒绝/缺记录拒绝/升级-回滚-重装全链(回滚后旧版本记录仍有效,幂等重装后仍可再回滚)。

**门禁**:plugin-update-policy 36→**47**(U2 同版本对称×5+U3 十五步×19+W1.3-1.6 接线×4);plugin-dist-regression 46→**48**(+P5-010 包哈希记录行为级+P5-005 源闸接线/标记);plugin-market-regression 4→**5**(+P5-005 源形态矩阵:v1 索引 http 条目照常解析、安装口据源形态拒绝);contract-matrix 2 处行锚手修(symbols.json runtime 1838→1880/2036→2078,本轮代码位移;**未**跑 generate.cjs)+compat-matrix.md 经 report.cjs 重渲染逐字节一致。

**实际执行的测试**:release-gate --ci **32/32**、update-policy **47**、dist-regression **48/48**、market-regression **5**、contract-matrix ✚(--fixtures-required)、error-visible/package-verifier/manifest-v2/docs-contract/dist-audit --all 全绿、hvigorw assembleHap **BUILD SUCCESSFUL**(33 tasks;无签名配置=既有 WARN)。

**诚实边界(IMPLEMENTED ≠ VERIFIED)**:全部离线证据。设备欠账:①模拟器 debug 形态 `ApplicationInfo.debug=true` 实测+flows 四流程回归(演示源 http 在 debug 构建全链;若模拟器对 unsigned HAP 上报 debug=false,演示源按钮会禁用——flows 将显式红,属预期 fail-closed 行为而非缺陷);②同版本覆盖/回滚链真机负例(P5-010);③生产(release 签名)构建 http 拒绝的设备直证需 release 签名链(B-002 侧)。


## Round 43（R43 = P3-006：Plugin Inspector 完整化 → 离线全绿）

**本轮完成**:LexiPluginInspector 从 T5.3 观察面扩到 **RFC §12 七问全字段**(每问→数据源→字段映射固化在 Inspector 头注与 docs/plugin-inspector.md 表,宿主 inspectPlugin 只读组装,无行为面变化):

1. **七问映射**:问 1 启动失败(lifecycle journal starting→failed 行+activation.failReason→failReason/lastFailureAt);问 2 请求权限(permissionStore.grantOf 全貌→permissionFingerprint/GrantedAt/RevokedAt/Version+capabilityTags);问 3 拒绝 RPC(**新数据面 rpcDenyJournal**:与既有 authz.denied 记账同点追加 method+code+at,环形上限 16,零载荷零凭据→rpcDeniedRecent);问 4 超时(**新数据面 rpcTimeouts/notePluginTimeout**:onload/onunload/invoke.* 三类既有失败出口记账,成功路径零调用);问 5 资源(contextRegistry.aliveCountOf+viewSessions.openCountOf 新只读方法+activationCount+data.json fs.stat 占用+storage.quotaBytes);问 6 卸载清理(存活上下文/视图会话/扩展残留只读盘点→cleanupComplete/cleanupLeftovers,残留点名);问 7 隔离(record.quarantineReason+账目 quarantined 行)。answersOf() 把七问折成恒 7 行应答文本(只由已脱敏字段拼装);兼容性报告 compatOk/minApiVersion/apiCompatLine(§12 必备面)。
2. **脱敏红线 enforced+asserted**:自由文本字段(errorState/账目原因/隔离原因/失败原因/超时标签)经凭据形状脱敏——凡「短前缀-长十六进制」(tk-/st-/dc-/ch-/n- 等宿主铸造形状全覆盖)只剩尾 6 位(与 LexiWebRuntime.tokenTail 同纪律);RPC 拒绝行只带 method/code/at(载荷/凭据字段结构性丢弃);journal 报告截尾 32 行;errorState 120/自由文本 160 截断。门禁负例:三种凭据全值植入 errorState/journal reason/隔离原因/超时标签,报告与应答行均不得含全值、必须含尾迹;拒绝行植入 payloadJson/credential 字段必须被丢弃。
3. **门禁**:plugin-inspector **→60 项**(I1 观察面/I2 隐私边界/R 红线×9/**Q 七问真实状态面**:转译真跑 LifecycleManager+PermissionStore,P2-009 permission-pending/quarantined/revoked 状态全在案,含账目交叉证据与清理两态/R2 只读伴生模块(contextRegistry/viewSessions)/I3 接线锚点×10);symbols.json runtime 行锚手修(1880→1928/2078→2126,本轮代码位移;未跑 generate.cjs)+compat-matrix.md 经 report.cjs 重渲染逐字节一致;docs/plugin-inspector.md 增七问映射表与红线节(docs-contract 17 绿)。

**实际执行的测试**:release-gate --ci **32/32**、plugin-inspector **60**、plugin-lifecycle-once **71**、dist-regression **48/48**、docs-contract **17**、contract-matrix ✚(--fixtures-required)、hvigorw assembleHap **BUILD SUCCESSFUL**(33 tasks,无签名配置=既有 WARN)。

**诚实边界(IMPLEMENTED ≠ VERIFIED)**:全部离线证据(vm 行为级+静态接线)。设备欠账(归 supervisor 批次):①观察面七问应答在真机 UI/日志的消费路径(answersOf 面向设备消费,宿主尚无 UI 挂接点——现有消费面仍为 inspectPlugin 调用方);②超时记账的三类出口中 onload/onunload 路径为静态锚点+账目交叉证据,invoke.* 路径行为级只在 net-request-url 既有超时用例覆盖(插件命令超时账目未做设备直证);③rpcDenyJournal/authz.denied 的设备对账(拒绝注入的 hilog 链)。
