# RELEASE_READINESS — 发布就绪清单

## RFC 基线对照校验(用户要求的"基于最开始的文档校验",第一遍 2026-11-04 Round 12)

对照 `rfcs/third-party-plugin-ecosystem-rfc.md` §1.2 已确认架构问题逐条复核:

| RFC 条目 | Round 7 审计判定 | Round 8-12 后现状 | 证据 |
|---|---|---|---|
| P0-01 业务插件未进沙箱(共享 realm `new Function`) | 证实(且低估:两条轨道) | **未修**(Phase 1 主体 P1-003 待做);但载体可行性已真机定案(ADR-R9-01),身份面先行收口 | B-008 关闭记录;MODULE_MAP |
| P0-02 身份令牌暴露面 | 部分证实 | **已收口**(ADR-R10-01):回落 fail-closed/WeakMap/手工入口删除/restore 修复;残余 `__receive` 面登记 P1-006b | bridge-security 34/34;真机四流程链 |
| P0-03 Manifest v2 能力未进授权链 | 证实(且更糟) | **主体已修**:P2-001 透传+P2-002 标签正典+P2-003 broker capability+P2-004 路径级+delete 独立键+data 解绑;**残余**:storage 配额执行(P2-005)、notifications/clipboard 执行面已有 gate(data)、管理面方法缺 v2 键(已登记) | manifest-v2 39、authz-matrix M2b、dist-regression |
| P0-04 Registry Trust 未进市场主流程 | 证实(现行) | **部分修**:fail-closed 哈希闸门真机 VERIFIED(P5-001)、发布镜像严格 v1(P5-006);**TUF/签名 authenticity 未接(P5-002,依赖 B-002 密钥决策)** | dist-flows 四流程;发布仓 |
| P1-01 Obsidian 兼容不足 | 证实 | 未动(P4 阶段任务) | EXECUTION_PLAN P4-* |
| P1-02 SDK 未独立发行 | 证实 | 未动(P3 阶段任务) | 同上 |
| P1-03 文档不在 Git | 证实 | **部分修**:RFC+工程记录已入 Git;八篇开发者文档仍在 docs/(P0-004) | rfcs/ |
| P1-04 市场 UI 真机问题 KI-1/2/3 | 证实 | 未修;新增 KI-4 已修;真机批次恢复 | known-issues.md |

RFC §17.1 安全量化 DoD 现状:RPC 进权限矩阵 ✔(M1.2/1.3 对账+capability 域);敏感 RPC 正负用例 ✔(authz-matrix+V5b);插件可读会话凭据 **0**(P1-006 后);跨插件资源操作 **0**(plugin-owned 原有+M2 组);指纹 Schema 一致 ✔;卸载上下文销毁 **部分**(P1-008 待做);撤销立即生效 **部分**(store 层 ✔,通道失效 P2-010 待做)。

结论(同前):公开市场不得开放;开发/侧载链路可用且已大幅收紧。

## 门禁状态

## 门禁状态

| 项 | 状态 | 备注 |
|---|---|---|
| release-gate --ci 28 步 | PASS（本机） | 无根仓库 CI 自动触发（P0-003） |
| HAP 构建 | PASS | 仅 default unsigned product |
| 真机批次 | **Round 8 恢复**:dist-flows 四流程 PASS(2in1);沙箱 PoC 真机**静默 FAIL**(B-008);KI-1 规模/KI-2 定位/兼容夹具回归待排 | B-001 已解除;新证据需求转入具体任务 |

## 阻断项（开放生产市场前必须全部关闭）

1. **P0 安全**：远程安装无受信任哈希 fail-open —— Round 7 已封（P5-001, IMPLEMENTED;真机 UI 验证待 B-001）。
2. **P0 安全**：安装后自动启用、无授权清单/同意流程（P5-004）。
3. **P0 安全**：业务插件共享 realm + 页面级身份暴露面（P1-003/006）。
4. **P0 分发**：来源真实性：TUF 接线 + 生产签名 + root 锚（P5-002/009, 依赖 B-002 决策）。
5. **P1 分发**：发布索引升级 schemaVersion=1+sha256（P5-006, 推送需授权 B-003）；撤销数据源（P5-003）。
6. **P1 权限**：细粒度 capability 真实执行与重授权闭环（P2-001..008, 010）。
7. **P1 质量**：KI-1/KI-2 真机回归（P5-007/008）。
8. **文档**：八篇开发者文档进 Git（P0-004）+ 外部开发者演练（P3-008）。

## 已具备的真实能力（有测试证据的部分）

严格 Manifest v2 解析与未知能力拒绝；RPC 方法矩阵与默认拒绝；CSPRNG 凭据与宿主侧身份映射（fail-closed）；
网络 origin 白名单执行；包结构校验与预算（路径穿越/symlink/炸弹比）；不可变版本目录安装/回滚/卸载 +
降级拒绝；权限指纹存撤销记录模型；Inspector 报告缝；离线安全回归套件（PoC 面 + 宿主面）；28 步门禁。

## 量化 DoD 差距速览（RFC §17）

- 100% RPC 进权限矩阵：**未达**（矩阵有,但多数 kind 仅 role-only,capability 维度缺失）。
- 0 插件可访问宿主会话凭据：**未达**（currentToken 回落/`__lexiToken` 暴露面, P1-006）。
- 100% 正式市场包验证 SHA-256：**未达**（远程 fail-closed 已实现但发布索引尚未升级;authenticity 未接）。
- 真机证据：0 项 VERIFIED（全部离线证据）。
