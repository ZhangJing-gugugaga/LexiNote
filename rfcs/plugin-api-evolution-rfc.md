# API 版本策略与废弃流程（P6-002）

状态：IMPLEMENTED（离线；工具面对账进 sdk-contract S8 + contract-matrix/report.cjs 稳定性节，见第 6 节）。
依据：`third-party-plugin-ecosystem-rfc.md` §5.2（API 稳定等级）/ §13.3（契约一致性：缺任意一项不允许进入 Stable）/ §19.3（RFC 更新规则）；`tools/plugin-contract/api-version.json`（statuses 词表）；`packages/lexinote-plugin-sdk/package.json`（`lexinote.stability` 锚点，R34）；`EXECUTION_PLAN.md` P6-002 与"M1 出口前不标 Stable"约束（P3-001 行）。
放置说明：RFC §19.1 明文预留 `rfcs/plugin-api-evolution-rfc.md` 作为 API 演进专项文档位，本文档即该位的落地；受众 = SDK 维护者 + 插件作者（废弃窗口影响其升级决策），故为 rfcs/ 公开治理文档而非 docs/ 八篇开发者指南。

## 0. 两条稳定性轴线（现状口径，不混淆）

本仓库的 API 稳定性由两条独立轴线表达，语义不同：

| 轴线 | 载体 | 当前值 | 语义 |
|---|---|---|---|
| **包级锚点** | `packages/lexinote-plugin-sdk/package.json` → `lexinote.stability` | `experimental` | SDK 包整体的对外承诺。M1 出口前不得为 `stable`（P3-001/R34 约束，sdk-contract S7.2/S8 钉死）。 |
| **方法级 status** | `tools/plugin-contract/api-surface.json` → `methods[].status`（同步进 SDK `schema/`、`src/contract.ts`、`docs/plugin-api-reference.md` status 列） | 全部 `stable` | RPC 方法登记字段。**现状口径：该字段当前为 M0 期生成器占位**（`sync-contract.cjs` 硬编码 `stable`），**不构成 Stable 兼容承诺**——包级锚点 `experimental` 为准；方法级重标定（逐方法 Experimental/Stable 定级）归 P3-003 类型硬化（PROGRESS R34 登记在案），不在本文档轮执行，避免把两轴语义搅在一起。 |

契约一致性门禁（contract-tripod C5.1、docs-contract D2.2）当前按方法级字段的 `stable` 子集做对账，语义是"登记进快照的方法必须有宿主处理器/有文档"，与稳定性承诺无关——两轴分离后这些检查继续按字段现状运行，字段重标定（P3-003）时同轮复核其对账子集，防止门禁被重标定悄悄架空。

## 1. 生命周期状态机

生命周期状态机: Experimental → Stable → Deprecated → Removed

| 阶段 | 含义（RFC §5.2） | 兼容承诺 |
|---|---|---|
| Experimental | 实验功能 | 允许变更（含破坏性），不另行通知 |
| Stable | 正式开放 | 向后兼容（semver minor/patch 内零破坏） |
| Deprecated | 即将废弃 | 提供迁移窗口；仍可用，仅告警 |
| Removed | 已移除 | 调用即失败；只存在于历史版本 |

进入/退出标准：

| 流向 | 进入标准 |
|---|---|
| → Experimental | 方法进 api-surface.json（默认起点）；SDK 文档明示 experimental |
| Experimental → Stable | ①RFC §13.3 全项在案：类型声明/RPC/参数 Schema/返回 Schema/权限规则/错误码/文档/自动化测试缺一不可；②宿主处理器行为级用例进 release-gate --ci；③API 版本号按第 2 节规则递增；④M1 已出口（第 3 节标记） |
| Stable → Deprecated | 废弃理由成立（被替代/设计缺陷/安全）；登记册入第 5 节；迁移路径可用 |
| Deprecated → Removed | 仅 major 边界；且 deprecated 窗口期满（第 2 节） |

禁止事项（RFC §5.2 原文口径）：禁止把 Internal API 暴露成 SDK 公开类型；禁止把 Experimental API 误标为 Stable。

## 2. 时间线承诺

- **Experimental**：无时间线承诺。破坏性变更在 changelog + `docs/plugin-api-reference.md` 记录即可，不保证迁移窗口。
- **Stable**：向后兼容。破坏性变更必须先降级为 Deprecated（不得直接 Stable→Removed）。
- **Deprecated**：最短保留 **2 个 minor 版本或 1 个 major 周期**（取更晚者）。弃用公告出现在：登记册（第 5 节）+ SDK README + api-reference status 列 + 兼容矩阵稳定性节（report.cjs）。
- **Removed**：仅在 major 版本边界执行；移除前一个 minor 版本起，宿主对被移除方法返回显式错误（fail-visible，不静默 no-op）。
- **API 版本号**（`PLUGIN_API_VERSION`/shim/SDK 三方一致，sdk-contract S2 钉死）：新增方法或破坏性变更 → minor 递增；移除方法 → major 递增。 Experimental→Stable 晋级不单独动版本号，随其所在的变更按上述规则走。

## 3. M1 出口前不标 Stable（机器可读约束）

M1 出口评审（内核里程碑：工作区宿主页 + 单实例插件容器 + 身份化 RPC + 契约门禁；见 `docs/lexinote_plugin_m0_poc.md` M1 行）完成之前，**任何 Stable 宣称都不允许**。本约束的机器表达：

M1 出口状态: 未出口

- 本行是 sdk-contract S8 的解析锚点，取值仅允许 `未出口` / `已出口`。
- `未出口` 期间，S8 断言：SDK 包级锚点 `lexinote.stability === 'experimental'`；SDK README 保留"Experimental/不是 Stable"声明。
- `已出口` 的翻转程序 = M1 出口评审记录写入 `RELEASE_READINESS.md`（引用具体门禁读数），同轮：①本行改 `已出口`；②SDK 包级锚点按第 1 节标准重定级；③sdk-contract S7.2 的包级硬编码断言同轮复核（S7.2 写死 `experimental`——它是翻转时的**故意绊线**：M1 出口评审若只改文档不改门禁，CI 红给评审者看，防止"文档出口、门禁未议"的半截翻转）。
- 当前事实（2026-11-07）：M1 未出口；P5-002/004 等分发链任务未闭环；SDK 保持 experimental。无任何例外登记。

## 4. 废弃标记约定（SDK 与契约）

### 4.1 SDK 源码（JSDoc 标记）

SDK 类型面（`types/lexinote.d.ts` / `src/*.ts`）对废弃 API 的 JSDoc 标记形状：

```ts
/**
 * …原说明…
 * @deprecated LexiNote 1.2.0 — 改用 `requestUrl`；移除计划: 2.0.0（见 rfcs/plugin-api-evolution-rfc.md 登记册）。
 */
```

约定：`@deprecated` 后必须跟 **LexiNote 版本号（弃用发生版本）+ 迁移目标 + 移除计划版本**；三者缺一视为标记不完整，sdk-contract S8 的登记册对账会红。当前 SDK 无任何 `@deprecated` 标记（登记册为空），本节为约定预定义——首个废弃条目出现时，标记与登记册同轮落库。

### 4.2 契约快照（status 字段）

- 方法废弃：`api-surface.json` 对应 `methods[].status` 改 `deprecated`（由 `sync-contract.cjs` 真源重生成/快照同轮手修，contract-tripod C2 对账防漂移）；同步刷新 SDK 副本（sync-sdk）与 api-reference。
- 方法移除：status 改 `removed`，并在移除发生的 major 版本里从 SDK 类型面删除导出。
- `status` 取值域 = `api-version.json` 的 `statuses` 词表（`['stable','experimental','deprecated','removed']`），S8 断言快照内取值不越表。

### 4.3 文档披露面（自动）

- `tools/contract/report.cjs` 在兼容矩阵渲染"稳定性与废弃"节（第 6 节）：方法级 status 分布 + 废弃/移除方法清单 + 包级锚点，逐字节可再生，漂移即 contract-matrix 门禁红。
- `docs/plugin-api-reference.md` 的 status 列由 gen-api-reference.cjs 从快照渲染。
- `lexi plugin compatibility` 输出 API 面状态分布（cli-contract C11 钉读数）。

## 5. 废弃登记册

机器对账表（sdk-contract S8）：快照中 status=deprecated|removed 的方法必须出现在本表，本表条目也必须是快照中的 deprecated/removed 方法——双向一致，漂移即红。当前为空（无任何废弃条目）：

| 方法 | 弃用于 | 迁移目标 | 移除计划 | 备注 |
|---|---|---|---|---|

## 6. 工具面对账语义（P6-002 的"工具"交付）

| 工具 | 变更 | 对账语义 |
|---|---|---|
| `tools/contract/report.cjs` | 兼容矩阵新增"稳定性与废弃"节（输入 = api-surface.json + SDK 包锚点，不含时间戳，双重渲染自检不变） | contract-matrix 漂移检查覆盖全文件：快照方法/状态变化未重渲染 → 红 |
| `scripts/tests/plugin-sdk-contract.cjs`（S8 新节） | M1 标记解析、包锚点 experimental 强制、README 声明、词表一致、登记册双向对账 | 第 3/4/5 节全部机器化；语义见第 3/5 节 |
| `scripts/tests/plugin-contract-matrix.cjs` | 无语义变更（其逐字节漂移检查天然覆盖新节） | — |
| `packages/lexinote-plugin-sdk/README.md` | 新增"废弃（Deprecation）约定"节（JSDoc 形状 + 移除政策） | S8 needle 校验该节存在 |

## 7. 诚实边界

- 本文档定义的是**流程与工具**（P6-002 验收行"版本策略文档+工具"）；仓库当前没有任何 Deprecated/Removed 条目，登记册为空是真实现状，不是省略。
- 方法级 status 字段的硬编码现状（第 0 节）是登记在案的债务（P3-003），本文档的 S8 对账不依赖其取值，只校验其不越词表——防止在债务清偿前把门禁绑死在错误的语义上。
