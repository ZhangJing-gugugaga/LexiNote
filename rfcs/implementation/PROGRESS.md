# PROGRESS — 逐轮工程进展

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

最近更新时间：2026-11-04（Round 22）。

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
