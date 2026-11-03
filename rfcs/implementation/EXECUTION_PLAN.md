# EXECUTION_PLAN — 插件生态工程任务树

基线：`main @ c1863ff`（= RFC 审查基线）。最后更新：2026-11-03（Round 8）。

状态词汇见 `../README.md`。优先级 P0（安全缺陷）→ P4（上层功能）。
依赖顺序不得颠倒（RFC §16）；安全缺陷允许提前于所属 Phase 执行（Goal §5 Step 3）。

## Phase 0 — 源码审计与架构基线

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P0-001 | 全量源码审计（四 P0 主张逐条核实） | VERIFIED | P0 | — | 全部插件模块 | 审计结论有 file:line 证据，落入 MODULE_MAP；与 RFC 差异有 ADR ✔(Round 7) |
| P0-002 | rfcs/ 工程管理体系建立并进 Git | IMPLEMENTED | P0 | — | rfcs/ | 8 份记录文件齐备、`git check-ignore` 不命中、门禁全绿 ✔(Round 7；待提交授权) |
| P0-003 | 根仓库 CI（`.github/workflows/` 五道门禁） | TODO | P1 | P0-002 | `.github/`, release-gate | PR 触发 release-gate --ci 等价物；不再依赖人工手敲 |
| P0-004 | 八篇公开开发者文档纳入 Git | TODO | P1 | — | `docs/`→`rfcs/` 或解除 docs 忽略 | 公开克隆可得全部 8 篇；忽略规则调整最小范围 |
| P0-005 | 修 `tools/contract/generate.cjs` 解析器与对账器不一致缺陷（Round 7 发现：重生成会弄坏 shim 锚点，7 项假脱节） | TODO | P2 | — | tools/contract | `generate.cjs` 产物直接过 `plugin-contract-matrix`；幂等 |
| P0-006 | 测试入口健壮化：Windows 下 node 坏 shim、LEXI_TYPESCRIPT 探测、统一 `test` 入口 | TODO | P2 | — | scripts/, tools/plugin-dist | 新环境按 README 一条命令可跑 28 门禁 |

## Phase 1 — 安全执行环境（RFC P0-01/P0-02，总目标 3.1）

现状（审计确认）：两条业务轨道（headless runtime + workspace 容器）都在**共享 realm** 里
`new Function` 执行插件；iframe+MessageChannel 沙箱只在 PoC 里；PoC 宿主已挂载跑探针。

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P1-001 | ArkWeb 沙箱能力真机验证（iframe sandbox=allow-scripts opaque origin、MessageChannel、postMessage 转移端口、CSP 'unsafe-eval' 移除可行性） | IN_PROGRESS | P0 | P1-001a | LexiSandboxHost, lexinote_* | 载体核心能力**已证（Round 9 verdict PASS 2/2×10 向量,ADR-R9-01）**；剩余项:'unsafe-eval' 移除可行性 + 性能驻留基准(poc-verdict) |
| P1-001a | 沙箱 PoC 静默根因插桩定位 | **VERIFIED** | P0 | — | poc.html/js, sandbox.html, probe.js, context-isolation 门禁 | **Round 9 结案**：三根因(内联 CSP 拦杀/标记缺失/探针 frames[0] 假阳性)修复,真机 `verdict PASS contexts=2/2 vectors=20/20 blocked credentialHits=0` ✔ |
| P1-002 | 正式执行上下文模型定案（contextId×kind、port↔身份绑定落点）+ ADR | TODO | P0 | P1-001 | LexiPluginExecutionContext, LexiPluginLifecycleManager | ADR 评审通过，字段与绑定职责明确 |
| P1-003 | Runtime 轨道沙箱接入：每插件独立 iframe 取代共享 realm `new Function`；构建期 IIFE 优先 | TODO | P0 | P1-002 | lexinote_plugin_runtime.html, lexinote_plugin_shim.js, LexiPluginRuntime.ets | 业务插件在无 'unsafe-eval' 的独立上下文中加载运行；SEC 探针全过 |
| P1-004 | Workspace 轨道收敛：插件执行面从编辑器页面剥离/同构接入 | TODO | P0 | P1-002, P1-003 | LexiWorkspacePage, WorkspaceBridge, lexinote_workspace_shim.js | 编辑器页不再直接求值第三方代码，或该面进入 Trusted 策略 |
| P1-005 | 宿主端 port↔PluginExecutionIdentity 绑定；废弃 credential 第四参经页面传递的形态 | TODO | P0 | P1-003 | LexiWebRuntime.call, WorkspaceBridge | 插件侧报文不含任何身份字段；身份仅由端口解析 |
| P1-006 | **移除页面级身份暴露面**（Round 7 审计确认可本地做）：`LexiObsidian.currentToken()` 回落裸 sessionToken、`app.plugins.getPlugin()` 暴露他插件 `__lexiToken`、`window.lexiHost`/`hostCall` 可被插件直接调用 | TODO | **P0 安全缺陷** | — | lexinote_plugin_shim.js, plugin-bridge-security.cjs R5 扩展 | 恶意探针拿不到任何非自属凭据；bridge-security 新增负向用例并全绿 |
| P1-007 | RPC 入口归一：两 broker 实例（runtime+bridge）合并到单一 Gateway；未知方法/payload schema 校验 | TODO | P1 | P1-005 | LexiPluginRuntime, WorkspaceBridge, LexiPermissionBroker | 100% RPC 经同一入口；契约测试对账 |
| P1-008 | 执行环境销毁闭环：停用→关端口→销毁 iframe→吊销凭据→清 pending | TODO | P1 | P1-003..005 | LifecycleManager, ExtensionRegistry | 卸载后旧通道 RPC 一律拒绝（SEC-009/013 自动化） |
| P1-009 | 真实业务路径安全测试套件（RFC §13.4 SEC-001..008/011..013 自动化） | TODO | P0 | P1-003 | scripts/tests | 每条 SEC 有正/负用例，进 release-gate |
| P1-010 | Phase 1 真机安全验收 | BLOCKED | P0 | P1-001..009 | — | 依赖可用设备（B-001） |

## Phase 2 — 权限与生命周期闭环（RFC P0-03，总目标 3.2/3.3）

现状（审计确认）：v2 细粒度视图在 `LexiPluginManifest.ets:125-141` 边界被销毁；broker 只有
fs-write（粗）与 network host 真执行；`vault.read` 零门槛；storage 配额反向绑 vault.write；
clipboard/notifications/editor 分级未接线；授权 UI 缺失（`grant/revokePluginPermissions` 零调用方）。

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P2-001 | `LexiPluginManifest` 携带 v2 细粒度视图（prerequisite） | TODO | P0 | — | LexiPluginManifest.ets | v2 paths/methods/quota/notifications 可在执行面读取 |
| P2-002 | 能力标签唯一正典 `capabilityTagsOfV2Caps`（两份重复实现归一）+ 指纹 SCHEMA_VERSION 升级与已授权插件迁移 | TODO | P0 | P2-001 | LexiPluginRuntime.ets:1618, LexiPluginInstaller.ets:291, LexiPermissionStore | 权限扩张（editor/notify/quota/delete）改变指纹→触发重新授权；迁移不粗暴打回全部旧授权 |
| P2-003 | Broker 授权泛化：role-only 的 kind 增加 capability 维度（vault-read/editor-*/notify/storage-write） | TODO | P0 | P2-001,002 | LexiPermissionBroker | 每个 RPC 绑定授权规则；authz-matrix 覆盖未声明→拒绝 |
| P2-004 | Vault 路径级授权（read/write paths 前缀+glob 宿主端执行） | TODO | P1 | P2-003 | fsGate/handler 层 | 越路径读写被拒并有错误码（SEC-008/009） |
| P2-005 | Editor 分级授权（readActive/writeSelection/writeDocument） | TODO | P1 | P2-003 | editor.* handlers | 未声明 editor.write* 不能改文档 |
| P2-006 | Network methods/请求响应字节上限执行 | TODO | P1 | P2-001 | LexiNetProbe | GET/POST 之外与超限请求拒绝 |
| P2-007 | Storage 配额、notifications、clipboard 面接线（含反向绑定修复：只声明 storage 的 v2 插件应可用 data.json） | TODO | P1 | P2-003 | data.save, ui.notice | 配额宿主端强制；未声明即拒 |
| P2-008 | 用户权限管理 UI：安装权限清单、grant/revoke、regrant 通道（含 `optionsJson.grantApproved` 透传修复） | TODO | P1 | P2-002 | LexiPluginMarketSheet/Settings + Runtime | 用户可视化增删授权；新增权限必须重问；撤销立即生效 |
| P2-009 | 生命周期状态机补全（verified/permission-pending/degraded/quarantined/revoked 可达且有转出原因） | TODO | P2 | P2-008 | LexiPluginLifecycleManager | 状态转换表+测试；quarantine 由安全事件触发 |
| P2-010 | 撤销立即生效：权限撤销/插件撤销后既有通道与注册资源失效 | TODO | P1 | P2-008, P1-008 | Broker, Registry | SEC 用例：撤销后 RPC 全拒 |
| P2-011 | RPC↔权限矩阵 100% 对账测试进门禁（RFC §17.1） | TODO | P1 | P2-003 | plugin-authz-matrix.cjs | 每个公开方法有正/负授权用例 |
| P2-012 | KI-4：运行时安装插件生命周期记账（scanPluginDir 补 discovered→installed，接线断言钉死） | VERIFIED | P0 | — | LexiPluginRuntime.ets, dist-regression §6, known-issues.md | 真机 install 四流程全绿(2026-11-03 213058) ✔(Round 8) |

## Phase 3 — SDK 与开发者基础设施（RFC P1-02，总目标 3.4）

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P3-001 | SDK 构建/发布成型（编译 dist、入口非源码 ts、README 悬空字段、可安装性） | TODO | P2 | P2-00x（API 稳定前不打 Stable） | packages/lexinote-plugin-sdk | `npm pack` 产物可在模板中安装使用 |
| P3-002 | 类型单一真源方向修正：SDK 为源、模板消费（当前 sync 方向是模板→SDK） | TODO | P2 | P3-001 | tools/…/sync-sdk.cjs, template/tsconfig | 模板不再维护类型副本；对账脚本校验同源 |
| P3-003 | sdk-contract 门禁改真类型检查（现 transpileModule 只查语法） | TODO | P2 | P3-001 | scripts/tests/plugin-sdk-contract.cjs | 注入类型错误必须红 |
| P3-004 | CLI 补全 dev/build/test/inspect/doctor/compatibility | TODO | P2 | — | tools/lexi-cli | 每命令有契约测试；create→pack 全链离线可跑 |
| P3-005 | 本地开发模式与热重载（依赖 P1 通道收敛后设计） | TODO | P3 | P1-004 | runtime, CLI | 改码→重载不重启宿主；dev 信任显式标记 |
| P3-006 | Plugin Inspector 完整化（RPC 流水、生命周期记录、权限拒绝审计，脱敏红线） | TODO | P3 | P2-010 | LexiPluginInspector.ets | 能回答 RFC §12 七问 |
| P3-007 | 示例工程组（命令/Vault/视图/Markdown/设置五类）+ 每例可 CLI 构建校验 | TODO | P2 | P3-001..004 | template/examples | CI 构建全部示例 |
| P3-008 | 外部开发者验收：不读宿主源码，仅公开仓库+SDK+文档完成全流程 | TODO | P2 | P0-004, P3-001..007 | — | 一次真实演练记录 |

## Phase 4 — API 与 Obsidian 兼容（RFC P1-01，总目标 3.5）

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P4-001 | Modal / Menu / Setting Builder 实现（不只类型声明） | TODO | P3 | P1-004（UI 隔离策略） | shim/compat, host UI API | 夹具插件用出真实交互 |
| P4-002 | Suggest 系（PopoverSuggest 等） | TODO | P3 | P4-001 | 同上 | 同上 |
| P4-003 | Markdown postProcessor/Renderer 完整面 | Partial | P3 | — | markdown pipeline (Round 5 已部分完成) | 符号矩阵 unsupported→implemented 有证据 |
| P4-004 | CM6 Trusted 扩展策略（不进普通 iframe 默认权） | TODO | P2 | P1-002, P2-009 | codemirror compat | 高风险面独立授权与审核等级 |
| P4-005 | Calendar/Outliner/Tasks/Minimal 夹具真机回归（C0-C4 定级） | BLOCKED | P3 | P1-010, B-001 | tools/plugins-fixtures | 兼容等级有真机证据 |
| P4-006 | 兼容性报告生成器（symbols.json→矩阵文档，报告 unsupported） | TODO | P3 | P3-002 | tools/contract | 报告与契约逐字节可再生 |

## Phase 5 — 可信分发与市场（RFC P0-04，总目标 3.6）

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| **P5-001** | **远程安装 fail-closed 信任闸门**：installFromUrl 下载前强制受信任 sha256；UI 同判定；warnings 上屏 | **VERIFIED**（Round 8：真机四流程 install/upgrade/rollback/uninstall 全绿；篡改包→integrity_mismatch 零残留；合法哈希安装成功） | **P0** | — | LexiPluginMarketModel/Runtime/MarketSheet + dist/market-regression | 空/非法哈希远程安装必拒；本地侧载语义不变；28/28 绿 ✔（UI"缺哈希"分支仍为离线断言，设备索引无此类条目——待首个真实条目补验） |
| P5-006 | 发布仓库索引升级到 schemaVersion=1 + sha256 | **IMPLEMENTED**（本地镜像+校验器+三方一致门禁，`83be122`）；发布动作未执行 | P0 | P5-001 | tools/lexinote-releases/ | **Round 8 事实修正:GitHub 上 lexinote-releases 仓库不存在,默认市场 URL 一直是死链——"上线前提"改判为"发布决策"(B-003):新建公开仓+推索引属 ADR-015 门槛,待用户明确授权** |
| P5-004 | 安装不再自动 enable：授权清单展示→用户同意→启用（含 P2-008 通道） | TODO | P0 | P2-008 | Runtime.installZip 链, MarketSheet | 未授权插件不能运行；降级运行路径可用 |
| P5-002 | LexiRegistryTrust 接入 fetchMarketIndex/installFromUrl（签名验证实现 + root key 常量） | TODO | P1 | P5-009(密钥), B-002 | LexiRegistryTrust, Runtime, Installer | verifyChain/verifyPackageTarget 在生产路径被真实调用；registry-trust 门禁加接线断言 |
| P5-003 | 撤销数据源接线（revocations 注入 installer，撤销插件拒绝启用/更新） | TODO | P1 | P5-002 | LexiPluginRuntime.ets:627, Installer, UpdatePolicy | 撤销条目安装/更新被拒（SEC-017） |
| P5-005 | 演示源/开发安装明确标记 + 生产路径 https 强制（debug 才允许 http 侧载） | TODO | P1 | P5-001 | MarketSheet, Settings | dev 安装带醒目状态；生产构建拒绝 http |
| P5-007 | KI-1 市场 UI 重构（独立滚动区/虚拟列表/更新回滚入口） | TODO | P2 | — | LexiPluginMarketSheet | `plugin-dist-flows --market-repro` N=3..8 reachable=true（真机，B-001） |
| P5-008 | KI-2 幽灵已安装条目定位与修复（列表与磁盘同源） | BLOCKED | P1 | B-001 | Installer/Registry | 复现路径→修复→自动化回归 |
| P5-009 | 生产签名体系：Ed25519（或平台签名能力）替换 CLI HMAC 缝；密钥管理/轮换 | BLOCKED | P1 | B-002 | tools/lexi-cli, LexiPackageVerifier | 真非对称验签在 ArkWeb/ArkTS 实测；私钥不落客户端 |
| P5-010 | 更新与回滚闭环对账（含同版本不同哈希的拒绝语义修正，Round 7 审计发现的不对称） | TODO | P2 | P5-002 | LexiUpdatePolicy | RFC §9.2 十五步可走通并有测试 |

## Phase 6 — 生态成熟化（总目标 3.6/E）

| ID | 任务 | 状态 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| P6-001 | 审核等级（Community/Verified/Trusted）与审核项目自动化清单 | TODO | P3 | P5-002 | 审核门禁跑通 |
| P6-002 | API 废弃流程 + Experimental/Stable 标记入契约 | TODO | P3 | P4-006 | 版本策略文档+工具 |
| P6-003 | 安全公告与漏洞处理流程（SEC advisory 模板） | TODO | P3 | — | 流程文档 |
| P6-004 | 社区贡献指南与维护者机制 | TODO | P4 | P3-008 | CONTRIBUTING |
| P6-005 | 市场运营能力（搜索/分类/统计/举报） | DEFERRED | P4 | P5-* | Phase5 闭环后评估 |

## 执行顺序裁定（当前, Round 8 后）

1. ~~P5-001~~、~~P5-006 本地准备~~、~~KI-4/P2-012~~、~~P1-001a（Round 9：真机 verdict PASS,载体定案 iframe 路线）~~。
2. **P1-006**（本地身份暴露面安全缺陷,优先级 P0——当前第一颗未拆的安全雷）。
3. **P2-001+P2-002**（权限闭环先决两步）。
4. **P5-004**（安装后不自动启用+授权 UI,真机回归链已可用）。
5. 快速赢面：P0-003（CI）、P0-005（generator 缺陷,本轮又手工修锚点×1）。
6. ~~公开发布决策~~：Round 9 起 `lexinote-releases` 公开仓已建立（**空严格索引,非开放市场**——无任何条目可安装,受 P5-002/004 完成前不得添加条目的纪律约束）。
