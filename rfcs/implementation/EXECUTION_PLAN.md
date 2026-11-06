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
| P0-008 | **新(Round 10)**:手工门禁 bit-rot 修复——`plugin-shim-regression.cjs` 在 HEAD 上即红(harness 缺 document/DOM 链 stub,ViewShim 构造 ReferenceError;非本轮引入,stash 对照证实)。同类:手动批次 15 个脚本无 CI 覆盖,bit-rot 无人知 | **VERIFIED**(Round 25:harness 补 DOM stub+host-first 顺序+启动预热,8/8 确定性绿×2;根因含 267ad04 后契约漂移) | P2 | P0-003 | scripts/tests/plugin-shim-regression.cjs | harness 补 DOM stub 后全绿;或明确退役并入现有 CI 门禁 ✔(修复本体);CI 纳管归 P0-003 |
| P4-007 | **新(Round 25,P0-008 修复中发现,仅登记未修)**:shim vault 同步索引两缺陷——①rename 分支 `knownFiles.delete(rawFile.path)` 误删(主机发的是重命名后路径,与 payload.file.path 相同,`lexinote_plugin_shim.js:301-304`+`LexiVaultFacade.ets:67-78`),重命名文件直到下一 vault 事件前对 getAbstractFileByPath/getMarkdownFiles 不可见;②注释承诺"启动拉一次 vault.files"(`:815-816`)但无启动拉取,冷启首调 getMarkdownFiles 返回 `[]`(惰性拉取仅在全空时触发) | TODO | P2 | — | lexinote_plugin_shim.js | rename 后索引可见性回归用例;启动拉取补齐(或注释修正)+getMarkdownFiles 首调语义定案 |
| P0-009 | **新(Round 10)**:`plugin-dist-flows.cjs` 单进程 `--flow all` 在默认市场源上线后首步即失联(演示源列表空;独立进程链式 install→upgrade→rollback→uninstall 同构建全绿,23:07-23:09 证据)。怀疑 server/状态机跨流程复用或时序缺陷;需最小复现定位 | TODO | P3 | — | scripts/tests/plugin-dist-flows.cjs | `--flow all` 单进程四流程 PASS,或文档化"必须分进程链式运行"并改 --ci 计划 |
| P0-010 | **新(Round 25)**:`plugin-route-coverage.cjs` 门禁在 HEAD 即红——vault.getByPath 登记为"未登记孤儿"(调用点在 `lexinote_plugin_view_shim.js:339`,该门禁不扫 view_shim;shim 本体 0 引用)。处置:要么门禁纳管 view_shim,要么显式登记该孤儿(停用/保留理由) | **VERIFIED**(Round 26:门禁纳管 view_shim 为第二调用源,orphan 判定收紧,vault.getByPath 诚实重分类,无弱化);**R30 重开(盲区复发)**:R27 editor.applyChanges/replace/selection 宿主 handlers 的调用点在 sandbox.html 沙箱 Editor request 链,门禁第三调用源缺失→3 孤儿假阳性 FAIL——纳管 sandbox.html 为第三源即绿 | P2 | — | scripts/tests/plugin-route-coverage.cjs | 第一源修复 ✔;R30 重开:第三源纳管 |
| P0-011 | **新(Round 25)**:`workspace-tools-regression.cjs` 模块加载即崩(HEAD 即红;断言 .ets 源码形状,工作树未动 .ets 也崩)——手工批次 bit-rot 第二例(P0-008 同类) | **VERIFIED**(Round 26:双层根因=①硬编码 mac typescript 路径(改 manifest-compat 候选约定,LEXI_TYPESCRIPT 优先)②section 标记硬编码 \n 而 .ets 工作副本 CRLF(读入归一化);结构契约本身完好,12 组全过;PASS×2 确定性) | P2 | — | scripts/tests/workspace-tools-regression.cjs | 崩溃根因定位+修复,恢复可运行 ✔ |

## Phase 1 — 安全执行环境（RFC P0-01/P0-02，总目标 3.1）

现状（审计确认）：两条业务轨道（headless runtime + workspace 容器）都在**共享 realm** 里
`new Function` 执行插件；iframe+MessageChannel 沙箱只在 PoC 里；PoC 宿主已挂载跑探针。

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P1-001 | ArkWeb 沙箱能力真机验证（iframe sandbox=allow-scripts opaque origin、MessageChannel、postMessage 转移端口、CSP 'unsafe-eval' 移除可行性） | IN_PROGRESS | P0 | P1-001a | LexiSandboxHost, lexinote_* | 载体核心能力**已证（Round 9 verdict PASS 2/2×10 向量,ADR-R9-01）**；剩余项:'unsafe-eval' 移除可行性 + 性能驻留基准(poc-verdict) |
| P1-001a | 沙箱 PoC 静默根因插桩定位 | **VERIFIED** | P0 | — | poc.html/js, sandbox.html, probe.js, context-isolation 门禁 | **Round 9 结案**：三根因(内联 CSP 拦杀/标记缺失/探针 frames[0] 假阳性)修复,真机 `verdict PASS contexts=2/2 vectors=20/20 blocked credentialHits=0` ✔ |
| P1-002 | 正式执行上下文模型定案（contextId×kind、port↔身份绑定落点）+ ADR | VERIFIED | P0 | P1-001 | LexiPluginExecutionContext, LexiPluginLifecycleManager | **Round 18 定案(ADR-R18-01)**:身份四元组+contextRegistry 端口表+既有 broker 复用+两轨策略+回退备选 ✔ |
| P1-003a | contextRegistry + 端口 RPC 网关（宿主侧:HostContextRecord/反查/喂既有 broker;离线可测） | **VERIFIED** | P0 | P1-002 | LexiContextRegistry.ets(新), RuntimeHost 端口实装, runtime 集成 | **Round 20 结案**:端口对真机建立(page-side attached)+enable 注册/disable 吊销接线+帧裁决链复用 call();门禁 15 项+29/29 ✔ |
| P1-003b | 沙箱页插件 API 面(obsidian namespace 端口化重建;CSP unsafe-eval 仅 iframe) | IN_PROGRESS(第一切片+双插件并发+命令回环+**editor 执行面(R27)均 VERIFIED**) | P0 | P1-003a | sandbox host html+container+bootPlugin(就绪) | Round 22 方案 B 全链真机贯通(onload+data 往返铁证);Round 24 双 iframe 并发+命令回环;Round 27 editorCallback 执行面+SandboxEditor(对齐旧轨形状)+真机 data.json `{"writes":1,...}`+宿主文档 0→2 字符铁证;剩余面=view/settings 归后续切片 |
| P1-003c | 构建期 CommonJS→IIFE + 宿主页面 CSP 收紧（移除 unsafe-eval） | **VERIFIED**(Round 25,ADR-R25-01) | P0 | P1-003b | tools/lexi-cli, template, runtime.html CSP | 宿主页面无 eval ✔(S26-S29+C6,48 项);真机:新 CSP 下 lexi-sample 装载运行+沙箱轨回归×4 冷启零违规(差分证明注入通道);残差:通道直接标记(console 观测哑 KI-5)、legacy 命令回环未再驱动(路径不在 diff) |
| P1-003d | 真实业务插件迁移验收（lexi-sample/calendar 真机 + SEC 探针进业务路径;范围修正:calendar 归 P4-005） | **VERIFIED**(R28:离线面+真机验收表三件套全过——①lexi-sample v2 opt-in 沙箱轨真机 ctx-6 bootPlugin+8 命令注册(首启容器未就绪回落 legacy=开关 ON 设计行为,重启用即上沙箱轨)②SEC 探针业务路径 data.json **10/10 blocked credentialHits=0** passed=true③legacy 停用开关 fail-closed 真机拒载(`插件装载被拒(legacy 轨停用)…fail-closed` 零派发);沙箱轨 require 管线收口 ADR-R25-01 遗留(IIFE 直载+一次性 require 上下文,E3/E3b vm 行为级);**开关默认翻转=ADR-R28-01 复审条件待人工(HUMAN_QUEUE)**;残差:事件投递+workspace 叶面桩在案;E1/E2 vacuous 门禁缺陷顺手修复) | P0 | P1-003a..c | 设备批次 | RFC §3.6 验收表通过 ✔;旧共享 realm 路径停用=开关落地+fail-closed 已证,默认翻转待 ADR 复审 |
| P2-013 | **新(R28)**:设置页 Toggle 在 uitest 单击下产生 2-3 次 onChange(legacy 轨开关无法经 UI 稳定置位,偶数次净零变化;真实触摸/键盘待验)——P1-003d 开关的可用性缺陷 | TODO | P2 | — | LexiSettingsTab/Window toggle 接线 | 单击=单次切换;开关 UI 可稳定操作(真机触摸验证) |
| P1-004 | Workspace 轨道收敛：插件执行面从编辑器页面剥离/同构接入 | **ADR 草案就绪待评审**（R29=ADR-R29-01,混合模型:Track2 纳入轨政策真源+视图面沙箱化+CM6 残留面 Trusted;HUMAN_QUEUE#3 五项开放问题待裁决;批准前零代码） | P0 | P1-002, P1-003a, P1-003b | LexiWorkspacePage, WorkspaceBridge, lexinote_workspace_shim.js | 编辑器页不再直接求值第三方代码，或该面进入 Trusted 策略 |
| P1-005 | 宿主端 port↔PluginExecutionIdentity 绑定；废弃 credential 第四参经页面传递的形态 | TODO | P0 | P1-003a | LexiWebRuntime.call, WorkspaceBridge | 插件侧报文不含任何身份字段；身份仅由端口解析 |
| P1-006 | **移除插件可及身份暴露面**（方案见 ADR-R10-01；含 restore-leaf 会话凭据修复） | VERIFIED | P0 | — | lexinote_plugin_shim.js, cap-probe fixtures, bridge-security/identity-model/delivery | bridge-security 34/34、identity-delivery 30/30 traced、真机四流程链全 PASS(230728-231445)+冷启 denied 无新模式 ✔(Round 10) |
| P1-006b | 残余暴露面(ADR-R10-01 登记):①`window.lexiRuntime.__receive` 可被他插件调用触发 invoke.command 跨插件回调执行——需 dispatch 通道鉴权(.ets 协议面,技术论证先行);②`setSessionToken` 他插件可乱写(DoS 回话,非提权) | TODO | P1 | — | LexiWebRuntime.dispatch + shim __receive 门卫 | SEC-007 负向用例进门禁;dispatch 携带不可读的一次性通道凭据 |
| P1-007 | RPC 入口归一：两 broker 实例（runtime+bridge）合并到单一 Gateway；未知方法/payload schema 校验 | TODO | P1 | P1-005 | LexiPluginRuntime, WorkspaceBridge, LexiPermissionBroker | 100% RPC 经同一入口；契约测试对账 |
| P1-008 | 执行环境销毁闭环：停用→关端口→销毁 iframe→吊销凭据→清 pending | TODO | P1 | P1-003..005 | LifecycleManager, ExtensionRegistry | 卸载后旧通道 RPC 一律拒绝（SEC-009/013 自动化） |
| P1-009 | 真实业务路径安全测试套件（RFC §13.4 SEC-001..008/011..013 自动化） | TODO | P0 | P1-003 | scripts/tests | 每条 SEC 有正/负用例，进 release-gate |
| P1-010 | Phase 1 真机安全验收 | BLOCKED | P0 | P1-001..009 | — | 依赖可用设备（B-001） |
| P1-011 | **新(R29,ADR-R29-01 勘察发现)**:Track2(workspace 页)同时绕过 R28 轨政策与 R26 授权门——`WorkspaceBridge.ets:530 onPluginLoad` 无 resolvePluginTrack 查阅、无 permissionState 门,已装未授权插件在工作区 bundle 被自动求值(WorkspacePluginCatalog.ets:76-98 + workspace bundle tools/workspace-bundle/src/main.ts:676-694);**P5-004"未授权插件不能运行"验收仅在 runtime 轨成立**。S1 修补=把已定案的 ADR-R26-01/ADR-R28-01 既有机制接到该旁路 caller(非新架构,不受 P1-004 评审 gate 约束) | **IMPLEMENTED**(R29-S1,离线面:WorkspaceBridge.onPluginLoad 接 pluginLoadRefusal 双门——①轨:沙箱声明插件不发进工作区页(ADR-R21-02 无 iframe,错误信息引 P4-005/视图面待收敛),非沙箱声明按 resolvePluginTrack 单一真源,lexiPluginLegacyTrack 关死时 Track2 同样 fail-closed;②同意:未启用不下发 + 声明型清单 permissionStateOf 必须 granted(与设置页同一判定);内联 demo 不套门(内置白名单同纪律),陈旧注册表条目(卸载后快照)拒发;拒载 fail-visible(plugin_track_refused/plugin_consent_required 错误码+WorkspaceLog.plugin.load.track/consent),plugin.list 保持全量列出避免静默缺席;WorkspacePluginCatalog 未改(唯一源码下发口=onPluginLoad,目录过滤会造成静默缺席);门禁 dist-regression 38/38(+6 Track2 行为级真跑)+workspace-tools-regression 扩形状锚;release-gate 29/29+assembleHap 绿。设备批次(开关关死→工作区拒载/未同意不求值,注意 P2-013 绕开 uitest 单击)待主线程) | P1 | — | WorkspaceBridge.ets, WorkspacePluginCatalog.ets | 未授权/被拒轨插件在工作区页 fail-visible 拒载;门禁断言两闸在 Track2 生效 |

## Phase 2 — 权限与生命周期闭环（RFC P0-03，总目标 3.2/3.3）

现状（审计确认）：v2 细粒度视图在 `LexiPluginManifest.ets:125-141` 边界被销毁；broker 只有
fs-write（粗）与 network host 真执行；`vault.read` 零门槛；storage 配额反向绑 vault.write；
clipboard/notifications/editor 分级未接线；授权 UI 缺失（`grant/revokePluginPermissions` 零调用方）。

| ID | 任务 | 状态 | 优先级 | 依赖 | 涉及模块 | 验收标准 |
|---|---|---|---|---|---|---|
| P2-001 | `LexiPluginManifest` 携带 v2 细粒度视图（prerequisite） | VERIFIED | P0 | — | LexiPluginManifest.ets | V4.4/V5.1 断言+真机冷启无回归 ✔(Round 11) |
| P2-002 | 能力标签唯一正典 `capabilityTagsOfV2Caps`（两份重复实现归一）+ 指纹 SCHEMA_VERSION 升级与已授权插件迁移 | VERIFIED | P0 | P2-001 | LexiPluginRuntime.ets, LexiPluginInstaller.ets, LexiPermissionStore | **Round 11 结案**:正典函数落 V2 文件,双副本归一;指纹变化天然触发 regrant(无需迁移代码,v1 插件零打扰,真机证实);V5/P5 行为门禁 39+28 全绿 ✔ |
| P2-003 | Broker 授权泛化：role-only 的 kind 增加 capability 维度（vault-read/editor-*/notify/storage-write） | VERIFIED | P0 | P2-001,002 | LexiPermissionBroker.ets, LexiPluginRuntime.ets | **Round 12 结案**:capabilityGate 可选 seam(未注入=旧行为)+runtime 域映射;M2b 9 条+双 seam 独立性断言;data.* 解绑;delete 独立键 ✔ |
| P2-004 | Vault 路径级授权（read/write paths 前缀+glob 宿主端执行） | VERIFIED | P1 | P2-003 | LexiPluginManifest.ets(vaultPathAllowed), fsGate/vaultReadGate | **Round 12 结案**:写 6 handler+rename 双端+读 2 handler 接线;V5b glob 语义 4 条;真机 v1 基线零扰动 ✔ |
| P2-005 | Editor 分级授权（readActive/writeSelection/writeDocument） | **VERIFIED**(Round 27:tags→tier→capabilityGate 映射+editorReplaceGate 选区等值精判+**双防读旁路脱敏**(命令帧快照+写回包);authz-matrix M2.50-54;真机写链 data.json+文档 0→2 字符铁证;v1 零扰动) | P1 | P2-003 | editor.* handlers | 未声明 editor.write* 不能改文档 ✔ |
| P2-006 | Network methods/请求响应字节上限执行 | VERIFIED | P1 | P2-001 | LexiNetProbe | **Round 15 结案**:方法白名单(空=只读默认)+请求/响应字节上限,拒发不留半发;net gate +7 断言(83 全绿);真机 v1 基线零扰动 ✔ |
| P2-007 | Storage 配额、notifications、clipboard 面接线（含反向绑定修复：只声明 storage 的 v2 插件应可用 data.json） | VERIFIED | P1 | P2-003 | data.save, ui.notice(broker gate) | **Round 12/13**:notifications 经 broker gate ✔、data 解绑 ✔、**配额宿主端强制(P2-005, Round 13) ✔**;clipboard 无 RPC handler(不适用,登记) |
| P2-008 | 用户权限管理 UI：安装权限清单、grant/revoke、regrant 通道（含 `optionsJson.grantApproved` 透传修复） | IMPLEMENTED | P1 | P2-002 | LexiPluginMarketSheet/Settings + Runtime | **Round 14**:grantApproved 落账+启用闭环、重授权确认行、权限标签展示、撤销授权按钮;dist-regression +4;真机 install 流 PASS。**正例(v2 权限增长)设备证据待 P4-005 v2 夹具** |
| P2-009 | 生命周期状态机补全（verified/permission-pending/degraded/quarantined/revoked 可达且有转出原因） | TODO | P2 | P2-008 | LexiPluginLifecycleManager | 状态转换表+测试；quarantine 由安全事件触发 |
| P2-010 | 撤销立即生效：权限撤销/插件撤销后既有通道与注册资源失效 | IMPLEMENTED | P1 | P2-008, P1-008 | revokePluginPermissions→disablePlugin(revokePluginTokens 内建), enablePlugin 版本门修复 | **Round 16**:revoked 前置短路修复(v1 也生效)+顺序断言;token/资源回收链核实内建;设备负例待 P4-005 撤销夹具 |
| P2-011 | RPC↔权限矩阵 100% 对账测试进门禁（RFC §17.1） | VERIFIED | P1 | P2-003 | plugin-authz-matrix.cjs | **Round 17 结案**:M2c 全矩阵扫描(68 方法×角色=282 格真跑对账,fs-write 双身份特例)全绿 ✔ |
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
| P5-004 | 安装不再自动 enable：授权清单展示→用户同意→启用（含 P2-008 通道） | **VERIFIED**(R26 实现+R26 末 P0-012 回填设备全链:真机 install→"已安装(未启用,待授权)"→授权面板同意→"已安装并启用" PASS,升级路径同样经授权面板复现;ADR-R26-01 待人工复审=HUMAN_QUEUE#3;升级重复同意 UX 问题见该表) | P0 | P2-008 | Runtime.installZip 链, MarketSheet | 未授权插件不能运行；降级运行路径可用（本轮:未完全授权=不运行;per-capability 降级留 P2-009）✔ |
| P0-012 | **新(R26)**:plugin-dist-flows 脚手架重标定——R8 后 UI 漂移三层叠加:①x1<1000 锚点误点宽卡片(已修:findByTextNarrowest+onboarding 跳过)②模拟器长会话 NAT TCP 代理失效(环境侧已定位,重启恢复,KI-6)③远程条目被已安装列表挤出视口,滚动轮询已加但 sheet 内滚动容器未标定(手动滑动会关面板);upgrade/rollback/uninstall 段 rowAction 点击待重标定;R26 的授权步进(「已安装(未启用)→同意并启用」)随本任务回填验收 | **VERIFIED**(R26 末:四流程真机全 PASS——install 19/0、upgrade 11/0、rollback 7/0、uninstall 6/0,evidence 20261107-041154;重标定=滚动容器发现/行内 rowAction 最近行配对/授权面板 reveal/演示源 busy 竞态/夹具收纳法绕市场列塌陷;断言零弱化;附产品发现:市场条目区在已安装列表溢出时整体塌陷 LexiPluginMarketSheet.ets:556→归 P5-007) | P1 | — | scripts/tests/plugin-dist-flows.cjs | 四流程全 PASS 真机 ✔;P5-004 全链设备证据回填 ✔ |
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

## 执行顺序裁定（Round 24 后, 2026-11-06 修订）

已完成主干：P0-001/002、P1-001a/002/003a/006、P1-003b 双插件并发+命令回环(R24)、P2-001..004/006/007/011、P5-001、P2-012/KI-4、B-001/B-008/B-009/B-009b。

**近期轮次序列（R25→R33, Phase 1 收口）**：
1. **R25 = P1-003c**（构建期 CJS→IIFE + runtime.html CSP 移除 unsafe-eval;S20 类断言覆盖）。
2. **R26 = P5-004**（P0 安全洞:装完自动 enable 无授权——依赖 P2-008 已就绪;B-004 呈现按 RFC §4.5 先行自设计,验收后请审）。
3. **R27 = P1-003b 编辑器切片 + P2-005**（editorCallback 执行面 + readActive/writeSelection/writeDocument 分级门禁,互锁任务同轮）。
4. **R28 = P1-003d（范围修正）**：lexi-sample 沙箱轨真机验收 + SEC 探针进业务路径 + 旧共享 realm 停用开关。**calendar 迁移移出本轮**——其 ItemView 依赖 view 面(P4-001 域),归 P4-005 夹具批次(理由:不为迁移动画接口临时拼装 view 面)。
5. **R29 = P1-004**（workspace 轨道收敛;涉编辑器页执行模型,按 Goal §10 技术论证先行,ADR 后动代码）。
6. **R30 = P1-005 + P1-006b**（身份纯端口化;__receive dispatch 鉴权 + SEC-007 负例进门禁）。
7. **R31 = P1-007**（双 broker 归一 Gateway,契约对账）。
8. **R32 = P1-008 + P2-009**（销毁闭环 SEC-009/013 自动化;quarantine 由安全事件触发可达）。
9. **R33 = P1-009 + P1-010**（SEC 全表进门禁;**Phase 1 出口评审**,RELEASE_READINESS 复核——P1-010 的 B-001 阻塞已解除,状态改判可执行）。

**并行快速赢面**（填构建等待/设备空档,不占主轮）：P0-003 根 CI（29 步手工门禁 bit-rot 风险,P0-008/010/011 教训）、P0-005 generate.cjs、P0-006 统一测试入口、~~P0-008 shim harness~~(Round 25 完成)、P0-010/011 门禁 bit-rot、P0-009 flows --flow all、P4-007 shim vault 索引、P5-007 KI-1 规模档、P5-008 KI-2 定位。

**中远期**：R34-36 Phase 3（P3-001..004/007 + P0-004 文档入 Git;M1 出口前不标 Stable）→ R37-38 Phase 4（P4-001 Modal/Menu/Settings + P4-005 夹具 C 级定级,含 calendar）→ Phase 5 分发半边（P5-002/003/009 **依赖 B-002 用户决策**;P5-005/010 独立先行）→ Phase 6 治理 → 最终按原 RFC 全量对照校验（用户收尾要求）。

**人工决策点（执行前必须确认）**：B-002 生产签名密钥体系；ADR-015 公开市场开放（纪律：plugins[] 保持空至 P5-002+P5-004 闭环）；P1-004 收敛方案评审；不可逆 git 操作一律先请示。
