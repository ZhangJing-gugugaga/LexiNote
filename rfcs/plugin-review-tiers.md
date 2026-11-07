# 插件审核等级与自动化审核清单（P6-001）

状态：IMPLEMENTED（离线；清单真源对账进 docs-contract D5，见第 8 节）。
依据：`third-party-plugin-ecosystem-rfc.md` §11.1（审核等级）/ §11.2（发布审核项目）/ §11.3（撤销机制）/ §13.4（SEC 测试表）/ §5.4（Trusted 面）/ §14.3（威胁模型）；`EXECUTION_PLAN.md` P6-001；ADR-015（公开市场开放决策）。
放置说明：本文档是生态**治理操作文档**（维护者/运营视角，插件作者只读受益），不是八篇开发者指南之一；RFC §19.1 将 `rfcs/` 预留给专项治理文档，且 `docs/` 白名单只覆盖八篇公开开发者文档 + 桥接规范（P0-004 口径）。故落在 `rfcs/` 根目录，与 `plugin-security-rfc.md`、`plugin-api-evolution-rfc.md` 同层。

## 0. 适用范围与生效前提（ADR-015 纪律）

本文档治理的是**未来市场条目**的审核分级。在 ADR-015 决策开放公开市场之前：

- 发布索引 `lexinote-releases` 的 `plugins[]` **保持空**（严格索引纪律），直至 P5-002（RegistryTrust 接线）+ P5-004（安装不自动 enable，授权同意门）闭环；
- 本文档定义的三级审核、清单与晋级标准**不改变这一纪律**——审核门禁现在即可离线跑通（对已有夹具与样例执行同样的自动化面），但不产生任何市场条目；
- 等级评估是**发布侧**的质量分层，不是运行侧的授权替代（见第 1 节末）。

## 1. 审核等级定义（RFC §11.1）

| 等级 | 说明 | 进入方式 |
|---|---|---|
| Community | 普通社区发布，基础自动化检查 | 提交条目即申请；通过第 4 节全部自动化清单 |
| Verified | 经过人工或增强自动化审核 | Community 之上，完成第 5 节增强自动化 + 人工审核 |
| Trusted | 高风险 API 经过专项安全审查 | Verified 之上，完成第 6 节专项安全审查（现无进入通道，见 6.3） |

两条硬规则（RFC §11.1 原文口径）：

1. **等级不是用户授权的替代品**。安装/启用以授权同意门（ADR-R26-01）为准，等级不放宽任何运行时权限判定。
2. **Verified 插件仍然需要遵守权限模型**。Manifest 声明、Permission Broker 矩阵、能力域门禁对三个等级一律生效。

## 2. 自动化门禁清单（真源对账基准）

审核清单引用的自动化面 = `tools/plugin-dist/release-gate.cjs --ci` 的真实步骤。当前共 **32 步 = 30 个门禁 + stage 分类 + release 产物剥离自检**（单 HAP 时）。下表是全量门禁清单，与 release-gate.cjs 的 gates 数组逐条对账（docs-contract D5 双向核对：清单漏门禁、或引用不存在的门禁，都红）。

<!-- gate-inventory-begin -->
release-gate --ci 步骤数: 32

| # | 门禁 | 脚本 | 审核语义（对插件条目检查什么） |
|---|---|---|---|
| 1 | stage 分类 | （release-gate 内置） | 未登记的插件目录混进发布资源树 = 准事故，红 |
| 2 | channel-audit | `scripts/tests/plugin-channel-audit.cjs` | 死通道必须 0：shim/宿主承诺面与 handler 表一致 |
| 3 | contract-matrix | `scripts/tests/plugin-contract-matrix.cjs` | 契约矩阵与官方 d.ts 逐符号一致 + 兼容报告逐字节可再生 |
| 4 | dist-audit --all | `scripts/tests/plugin-dist-audit.cjs` | 静态审计：夹具与恶意样本定性（恶意代码形态面） |
| 5 | dist-regression | `scripts/tests/plugin-dist-regression.cjs` | 分发离线回归：安装/更新/回滚/授权链行为级 |
| 6 | identity-delivery | `scripts/tests/plugin-identity-delivery.cjs` | 令牌下发点静态对账（身份不落页面可读面） |
| 7 | bridge-security | `scripts/tests/plugin-bridge-security.cjs` | 身份面安全（T0.1）：令牌不可读回/归属 WeakMap |
| 8 | context-isolation | `scripts/tests/plugin-context-isolation.cjs` | 沙箱面安全（T0.2）：iframe 隔离 + eval 面 |
| 9 | context-registry | `scripts/tests/plugin-context-registry.cjs` | 上下文网关（P1-003a）：端口身份 + 销毁闭环 |
| 10 | authz-matrix | `scripts/tests/plugin-authz-matrix.cjs` | 授权矩阵（T0.3）：方法×角色全格真跑对账 |
| 11 | net-request-url | `scripts/tests/net-request-url.cjs` | 网络宿主代理面：origin/method/字节上限/超时（SEC-010/011） |
| 12 | lifecycle-once | `scripts/tests/plugin-lifecycle-once.cjs` | 生命周期（T1.1）：状态机 14 态逐格 + 一次性语义 |
| 13 | extension-ownership | `scripts/tests/plugin-extension-ownership.cjs` | 扩展注册（T1.2）：资源所有权 |
| 14 | contract-tripod | `scripts/tests/plugin-contract-tripod.cjs` | 契约三方（T1.3）：API Contract == SDK == Runtime RPC |
| 15 | manifest-v2 | `scripts/tests/plugin-manifest-v2.cjs` | 清单契约（T2.1）：manifest v2 解析/路径白名单/配额声明 |
| 16 | permission-store | `scripts/tests/plugin-permission-store.cjs` | 权限存储（T2.2）：指纹/授权持久化 |
| 17 | vault-revision | `scripts/tests/plugin-vault-revision.cjs` | 乐观锁（T2.3）：vault 写冲突 |
| 18 | workspace-api | `scripts/tests/plugin-workspace-api.cjs` | 视图会话（T2.4） |
| 19 | markdown-pipeline | `scripts/tests/plugin-markdown-pipeline.cjs` | 渲染管线（T3.1） |
| 20 | codemirror-compat | `scripts/tests/plugin-codemirror-compat.cjs` | CM 兼容矩阵（T3.2） |
| 21 | ui-theme-contract | `scripts/tests/plugin-ui-theme-contract.cjs` | UI+主题契约（T3.3/T3.4） |
| 22 | package-verifier | `scripts/tests/plugin-package-verifier.cjs` | 安装包校验（T4.1）：包结构/预算/穿越/symlink/炸弹 |
| 23 | registry-trust | `scripts/tests/plugin-registry-trust.cjs` | 元数据信任链（T4.2）：签名/回滚/过期/撤销模型 |
| 24 | update-policy | `scripts/tests/plugin-update-policy.cjs` | 市场+更新策略（T4.3/T4.4）：降级拦截/同版本对称/十五步 |
| 25 | sdk-contract | `scripts/tests/plugin-sdk-contract.cjs` | SDK 对账（T5.1）：包锚点/类型面/版本策略（P6-002 S8） |
| 26 | cli-contract | `scripts/tests/lexi-cli-contract.cjs` | lexi CLI 契约（T5.2）：validate/build/inspect/pack 全链 |
| 27 | examples | `scripts/tests/plugin-examples.cjs` | 六类示例 CLI 构建链（每例 validate→build→inspect→pack+boot） |
| 28 | inspector | `scripts/tests/plugin-inspector.cjs` | 观察面（T5.3）：Inspector 七问 + 隐私红线 |
| 29 | docs-contract | `scripts/tests/plugin-docs-contract.cjs` | 文档对账（T5.4）：八篇在库 + 本清单对账（D5）+ 安全流程（D6） |
| 30 | market-regression | `scripts/tests/plugin-market-regression.cjs` | 市场索引解析 + 源形态判定 |
| 31 | sec-coverage | `scripts/tests/plugin-sec-coverage.cjs` | SEC 覆盖矩阵（RFC §13.4 全表 18 条对账，见第 3 节） |
| 32 | release 产物剥离自检 | （release-gate 内置） | 第三方夹具不得进 HAP：临时副本剥离后重扫必须 0 违规 |
<!-- gate-inventory-end -->

注意：以上是进 `--ci` 的门禁集。仓库里另有手工批次脚本（如 shim-regression、route-coverage 等）不在 32 步内；审核清单**只**引用上表（引用未进 CI 的门禁当 CI 门禁用 = 假保障，P1-009/R33 已把此类缺口收口）。

## 3. SEC 覆盖矩阵现读数（Trusted 级的证据底座）

`scripts/tests/plugin-sec-coverage.cjs` 把 RFC §13.4 全表 18 条（SEC-001..018）逐条映射到离线门禁用例（needle 钉死）与设备证据指针（工程记录 needle 钉死）。R33 快照：**covered=4（SEC-001/003/004/010）partial=14 uncovered=0**，282 项对账。每个 partial 的 blocker 指名设备批次欠账或未闭环任务（P1-004/B-002 等），无假覆盖。

用法：Trusted 级专项安全审查（第 6 节）要求候选插件触达的每一条 SEC 场景在该矩阵中 verdict=covered，或写明该条设备负例已在案。矩阵结论退化（uncovered 出现、证据指针腐烂）时 Trusted 审核不可进行——门禁先红，审核无从谈起。

## 4. Community 级：基础自动化清单

### 4.1 发布资料完备性（RFC §11.2 十二项 × 自动化状态）

| 发布资料 | 自动化状态 | 依据 |
|---|---|---|
| 插件 ID | 自动（manifest 校验：id 格式/唯一性） | manifest-v2 门禁 |
| 开发者身份 | **人工**（签名体系 P5-002/009 闭环前无自动身份面；现按提交者账号核对） | B-002 |
| 项目仓库 | **人工**（条目元数据字段，市场索引 schema 校验格式） | P5-006 校验器 |
| License | **人工**（依赖许可证违规列入第 5 节人工审核重点 8） | §11.2 |
| 版本 | 自动（semver + 降级拦截/同版本对称） | update-policy 门禁 |
| Manifest | 自动（v2 解析 + 能力与真实 RPC 面对账） | manifest-v2 / dist-regression |
| API 兼容版本 | 自动（lexi plugin compatibility 对账 min/maxExclusive） | cli-contract |
| 请求权限 | 自动（capability 标签 ↔ broker 矩阵逐格） | authz-matrix / capability-map |
| 发布包 SHA-256 | 自动（索引必填 + 安装前强制受信任哈希） | P5-001/P5-006 |
| 签名信息 | 部分（离线模型级 A2 组；生产签名链 B-002 未闭环） | package-verifier / registry-trust |
| 更新日志 | **人工**（人工审核项） | §11.2 |
| 隐私说明 | **人工**（对照权限清单核对声明完整性） | §11.2 |

### 4.2 审核重点（RFC §11.2 八条 × 自动化映射）

| 审核重点 | 自动化覆盖 | 残余人工面 |
|---|---|---|
| 1 恶意代码 | dist-audit 静态定性 + 沙箱隔离面（context-isolation/context-registry） | 行为级可疑模式仍需人工抽审 |
| 2 数据外传 | net-request-url 代理面（origin/方法/上限）+ SEC-010 探针面 | 声明内 origin 的语义外传需人工判断 |
| 3 不必要的权限 | capability ↔ RPC 面逐项对账（多声明即指纹变化→重新授权） | "声明了但功能不需要"需人工 |
| 4 访问其他插件资源 | 存储归属/owner 域负例（context-registry/authz-matrix M2/M3） | — |
| 5 绕过宿主网络代理 | 直接外传被 CSP+沙箱阻断（SEC-010）；代理面白名单 | 隐蔽信道（编码进合法载荷）人工抽审 |
| 6 未声明入口 | channel-audit 死通道 0 + manifest 入口声明面 | — |
| 7 恶意更新行为 | update-policy：降级拦截/单调版本/同版本异哈希拒绝 | 更新内容语义漂移人工复核 |
| 8 许可证违规依赖 | **人工**（单包无外部依赖解析面，RFC §8.4 白名单制；依赖清单人工核对） | — |

Community 出口判定：上表自动化列为"自动/部分"的项全部由 32 步门禁背书（绿）；**人工**列由 Verified 级人工审核兜底——Community 条目允许带未完成人工项上架，但市场展示层须保留等级标记（未做 Verified 即显示 Community）。

## 5. Verified 级：增强自动化 + 人工审核

在 Community 全部清单之上：

1. **§11.2 十二项发布资料全数齐备**（含 Community 允许暂缺的人工项：开发者身份/仓库/LICENSE/更新日志/隐私说明）。
2. **人工审核重点八条逐条签字**（第 4.2 表残余人工面），审核记录进工程记录（PROGRESS/审核台账），可引用门禁读数作为证据。
3. **设备批次证据**：候选插件至少完成一次真机安装→启用→核心功能→停用→再启用→更新→回滚→卸载→重启恢复链（RFC §13.5 九步；dist-flows 脚手架同款流程）。设备证据按 P1-010 台账纪律逐项登记，不接受"离线全绿"替代真机。
4. **审计记录**：安装链（hash/授权/版本）在设备上可追溯（Inspector 七问报告可导出）。

## 6. Trusted 级：高风险 API 专项安全审查

### 6.1 适用面

高风险 API = RFC §5.4 第四阶段高级兼容 + ADR-R29-01 方案 C 定义的 **CM6/editor 扩展残留面**（P4-004 域）：在编辑器页内求值、触碰宿主对象模型的扩展形态。RFC §5.2 的 Trusted 稳定等级与 §11.1 的 Trusted 审核等级在此对齐：该面**只对 Trusted 级开放**。

### 6.2 专项审查清单（Verified 全部之上）

1. **SEC 专项**：候选插件触达的每条 RFC §13.4 SEC 场景（第 3 节矩阵）verdict=covered 或设备负例在案；重点关注 SEC-002/005/006/007/008（宿主对象/伪造身份/跨插件存储/命令删除/Vault 写）。
2. **签名验证**：生产签名链（P5-002/009，Ed25519 或平台签名）已闭环并通过真机验证——B-002 未闭环前**无 Trusted 进入通道**。
3. **用户显式同意**：Trusted 权限面走独立授权 UI（ADR-R26-01 面），授权清单明示"高风险扩展"。
4. **运行时门**：非 Trusted 级插件的编辑器扩展注册调用 fail-visible 拒绝（ADR-R29-01 方案 C 第 3 切片，实施时进 dist-regression 行为级）。
5. **过渡信任根**：B-002 前仅随 HAP 分发的内置白名单可进该面（与 ADR-R26-01 夹具同纪律），第三方一律拒绝。

### 6.3 现状声明

截至 2026-11-07：P5-002/009 未闭环（B-002 用户决策在 HUMAN_QUEUE），P4-004 未实施——**Trusted 级没有可进入的候选**，第 6.2 清单是前瞻定义而非现行流程。本文档不假造 Trusted 审核案例。

## 7. 晋级、降级与撤销

| 流向 | 条件 | 记录 |
|---|---|---|
| Community → Verified | 第 5 节 1-4 全部完成 | 审核台账 + 设备证据指针（同 sec-coverage 纪律：指针可对账，不许腐烂） |
| Verified → Trusted | 第 6.2 节全部完成且签名链闭环 | ADR（ Trusted 面开放本身是 §19.3 要求的 RFC 级变更） |
| 任意级 → 撤销 | 触发 RFC §11.3：恶意行为确认/安全公告 Critical（见 plugin-security-rfc.md §6） | 撤销链：禁止新安装/禁更新/已装风险提示/按风险停用/吊销密钥/审计记录/不自动删用户数据 |
| 降级（Trusted/Verified → Community） | 高风险面 API 收缩或审核证据过期 | 市场条目等级字段更新 + 已装用户提示 |

晋级永不放宽运行时权限：等级变化不重置授权指纹，权限变更（只减不增放行、有增即 regrant）仍由 P2-009/T4.4 链路判定。

## 8. 清单真源与门禁（"审核门禁跑通"）

本清单的**机器对账真源**进 `scripts/tests/plugin-docs-contract.cjs` D5（release-gate --ci 第 29 步内，不新增步骤数）：

- D5 解析第 2 节 `gate-inventory` 标记块，提取全部 `scripts/tests/*.cjs` 引用，与 release-gate.cjs 的 gates 数组**双向集合对账**：清单引用不存在的门禁 → 红；release-gate 门禁不在清单 → 红（门禁改名/增删而清单未跟上 = name drift → 红）。
- D5 校验"release-gate --ci 步骤数: 32"行与 gates 数组实际条目数 + 2（stage 分类/剥离自检）一致。
- D5 校验三级定义、ADR-015 纪律行（plugins[] 空 + P5-002 + P5-004）、SEC 映射节在本文件中存在。

维护纪律：release-gate.cjs 的 gates 数组任何变更（改名/新增/删除）必须同轮更新第 2 节清单，否则 CI 红——这正是"清单必须引用真实门禁，不许发明"的门禁化表达。
