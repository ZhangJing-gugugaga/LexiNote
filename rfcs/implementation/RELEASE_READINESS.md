# RELEASE_READINESS — 发布就绪清单

> **身份缺口状态（评审口径）：** `net.requestUrl` 的身份投递静态审计曾报告 0 gaps，但这不能单独证明权限判定不依赖 payload 身份。桥接规范 §13、§17.3 所述身份绑定及伪造身份负向验证按未关闭处理；需复核当前实现并取得对应证据后再更新结论。


## RFC 基线对照校验(用户要求的"基于最开始的文档校验",第一遍 2026-11-04 Round 12)

对照 `rfcs/third-party-plugin-ecosystem-rfc.md` §1.2 已确认架构问题逐条复核:

| RFC 条目 | Round 7 审计判定 | Round 8-12 后现状 | 证据 |
|---|---|---|---|
| P0-01 业务插件未进沙箱(共享 realm `new Function`) | 证实(且低估:两条轨道) | **大半已修(R33 增量复核)**:沙箱轨真机贯通+双插件并发(R24)+编辑器执行面(R27)+**真实业务插件 lexi-sample 沙箱轨真机验收+SEC 探针业务路径 10/10 blocked(R28)**;runtime 页 eval 已清零(P1-003c,R25);旧共享 realm 轨停用开关 fail-closed 真机证(R28);剩余=开关默认翻转待 ADR-R28-01 复审+workspace 页收敛(P1-004,ADR 待评审) | B-008 关闭记录;ADR-R25-01;PROGRESS R24/R25/R27/R28 |
| P0-02 身份令牌暴露面 | 部分证实 | **已收口**(ADR-R10-01+R30 端口化):回落 fail-closed/WeakMap/手工入口删除/restore 修复;P1-005 端口身份纯端口化(调用点凭据表达式清零);P1-006b dispatch 一次性通道凭据+setSessionToken 写一次定死 | bridge-security 50/50;dist-regression doesNotMatch 钉死;真机四流程链 |
| P0-03 Manifest v2 能力未进授权链 | 证实(且更糟) | **主体已修**:P2-001 透传+P2-002 标签正典+P2-003 broker capability+P2-004 路径级+delete 独立键+data 解绑+P2-005 配额(R33 起行为级)+P1-007 Gateway 入口双闸(R31)+P2-009 状态机五新态(R32);**残余**:notifications/clipboard 执行面已有 gate(data);管理面方法缺 v2 键(已登记) | manifest-v2 55、authz-matrix 93、dist-regression 42(R33)、lifecycle-once 71 |
| P0-04 Registry Trust 未进市场主流程 | 证实(现行) | **部分修**:fail-closed 哈希闸门真机 VERIFIED(P5-001)、发布镜像严格 v1(P5-006);**TUF/签名 authenticity 未接(P5-002,依赖 B-002 密钥决策)** | dist-flows 四流程;发布仓 |
| P1-01 Obsidian 兼容不足 | 证实 | 未动(P4 阶段任务) | EXECUTION_PLAN P4-* |
| P1-02 SDK 未独立发行 | 证实 | 未动(P3 阶段任务) | 同上 |
| P1-03 文档不在 Git | 证实 | **部分修**:RFC+工程记录已入 Git;八篇开发者文档仍在 docs/(P0-004) | rfcs/ |
| P1-04 市场 UI 真机问题 KI-1/2/3 | 证实 | 未修;新增 KI-4 已修;真机批次恢复 | known-issues.md |

RFC §17.1 安全量化 DoD 现状(R33 增量复核):RPC 进权限矩阵 **✔**(P1-007 Gateway 归一后 100% 口径=五类传输前门收敛单一漏斗,M4.16/M4.19 对账);敏感 RPC 正负用例 **✔**(authz-matrix 93+SEC 矩阵 282 项对账);插件可读会话凭据 **0**(P1-006/005 后,设备 credentialHits=0×2 轮);跨插件资源操作 **0**(plugin-owned 原有+M2 组+R3.1b 存储面);指纹 Schema 一致 **✔**;卸载上下文销毁 **离线✔/设备待批次**(P1-008 销毁闭环 D 组行为级+S41;设备负例待批次);撤销立即生效 **离线✔/设备待批次**(store 层+revokePlugin 吊销全部通道帧,R2.2/D2)。

结论(同前):公开市场不得开放;开发/侧载链路可用且已大幅收紧。

## 门禁状态

| 项 | 状态 | 备注 |
|---|---|---|
| release-gate --ci 31 步 | PASS（R33;29→31:+net-request-url 网络代理面+sec-coverage SEC 覆盖矩阵) | 无根仓库 CI 自动触发（P0-003） |
| HAP 构建 | PASS | 仅 default unsigned product |
| 真机批次 | **Round 8 恢复**:dist-flows 四流程 PASS(2in1);沙箱 PoC 真机 PASS(R9,contexts=2/2);双插件并发(R24);授权同意链(R26);业务路径 SEC 探针 10/10(R28) | B-001 已解除;SEC 逐项设备负例欠账见 Phase 1 出口评审 |

## 阻断项（开放生产市场前必须全部关闭）

1. **P0 分发**：来源真实性：TUF 接线 + 生产签名 + root 锚（P5-002/009, 依赖 B-002 决策;SEC-014 authenticity 半边/SEC-015/017 的发布链缺口均在此）。
2. **P1 分发**：发布索引升级 schemaVersion=1+sha256（P5-006, 推送需授权 B-003）；撤销数据源（P5-003）。~~同版本异哈希不对称（P5-010）~~（R42 已修：包哈希记录同域比对+§9.2 十五步对账，离线；真机负例待批次）；生产路径 https 强制+开发源标记（P5-005, R42 离线；设备 debug 形态实测待批次）。
3. **P1 执行面**：workspace/Track2 页收敛（P1-004 ADR-R29-01 待人工评审——SEC-002 在该面仅在沙箱轨成立;S1 轨政策+同意门已接 P1-011）;沙箱轨开关默认翻转待 ADR-R28-01 复审（HUMAN_QUEUE#3）;P1-004 ADR 评审本身。
4. **P1 权限**：细粒度 capability 真实执行与重授权闭环（P2-001..008, 010 — 主体已落地,设备复核欠账）;管理面方法 v2 键。
5. **P1 质量**：KI-1/KI-2 真机回归（P5-007/008）;P2-013 设置页 Toggle uitest 连击。
6. **P1 安全**：SEC 逐项设备负例欠账（SEC-005/006/007/008/009/011/012/013/015/016/017/018 的真机断言,逐条 blocker 见 plugin-sec-coverage 矩阵;设备批次归 supervisor 排期）。
7. **文档**：八篇开发者文档进 Git（P0-004）+ 外部开发者演练（P3-008）。
8. **CI**：根仓库 GitHub Actions 自动触发（P0-003;现为手工 31 步）。

(原第 1/2/3 条"P0 安全"阻断——远程安装无哈希 fail-open、安装后自动启用无授权、业务插件共享 realm——分别由 P5-001(R7 封,真机 VERIFIED)、P5-004+P0-012(R26 实现+设备全链回填)、P1-003/006 系列(R25-R32,见上表)收敛出阻断名单,不再单列。)

## 已具备的真实能力（有测试证据的部分）

严格 Manifest v2 解析与未知能力拒绝；RPC 单一 Gateway 漏斗+入口双闸(unknown_method/bad_request,先于身份解析)；
CSPRNG 凭据与宿主侧身份映射（fail-closed）+端口身份纯端口化；dispatch 一次性通道凭据；网络 origin/方法/字节上限白名单执行；
包结构校验与预算（路径穿越/symlink/炸弹比）+哈希/签名模型校验；不可变版本目录安装/回滚/卸载+降级拒绝；权限指纹存撤销记录模型；
per-plugin 沙箱 iframe+销毁闭环（吊销→容器销毁→吊销凭据→清 pending,幂等）；生命周期状态机全量面（quarantine 由 integrity_mismatch 可达）；
Inspector 报告缝；离线安全回归套件（PoC 面+宿主面+SEC 全表矩阵）+真机批次链（PoC verdict/双插件并发/四流程/授权链/业务路径 SEC 探针）。

## 量化 DoD 差距速览（RFC §17,R33 复核）

- 100% RPC 进权限矩阵：**✔（P1-007 口径）** 五类传输前门全部收敛单一 Gateway,broker 构造点全应用对账（M4.19）;capability 细粒度维度对 v2 已接（M2.4x）,v1 清单按 legacy 语义。
- 0 插件可访问宿主会话凭据：**✔（离线+设备）** P1-006/005 收口;设备探针 credentialHits=0（R9/R28）。
- 100% 正式市场包验证 SHA-256：**未达**（远程 fail-closed 已实现且真机 VERIFIED;发布索引尚未升级;authenticity 签名链未接 B-002）。
- 100% 插件上下文独立生命周期 / 卸载销毁 / 撤销失效：**离线 ✔（D 组+L9+S41）;设备负例待批次**。
- 恶意插件测试集全部通过：**离线 ✔**（dist-audit 恶意样本 critical 全中+SEC 探针+D 组+SEC 矩阵 282 项）;真机面=业务路径探针 10/10,其余负例待批次。
- 真机证据：**不再是 0 项**——VERIFIED 有:PoC verdict(R9)、双插件并发(R24)、dist-flows 四流程(R8/R26)、授权同意全链(R26/P5-004)、业务插件沙箱轨+SEC 探针 10/10+legacy 停用 fail-closed(R28);仍为离线证据的主体=SEC-005..013/015..018 的负例（见矩阵 blocker 列）。

## Phase 1 出口评审结论草案（R33, 2026-11-07）

**范围**:P1-001..P1-011（Manifest 与权限闭环）+ Phase 0 收尾项的出口判读。依据=RFC §15 Phase 1 验收五条 + §17.1 + plugin-sec-coverage 矩阵 + R25-R32 工程记录。

### 已达成（可出口）

1. **Manifest 中每项有效能力都能追踪到具体宿主执行入口**——P1-01/02/03 归一（manifest-v2 55+contract-matrix 锚点+route-coverage 纳管三调用源）;R33 把执行面判定升级为行为级（fsGate/vaultReadGate/storageQuotaGate 真跑）。
2. **不存在未执行的虚假权限声明**——M2/M4 矩阵 93 项+capability 域门;管理面方法缺 v2 键已在案（P2 残余,不阻塞 Phase 2 开工）。
3. **所有高风险操作都有用户授权记录**——P5-004 授权同意流（R26 实现+**设备全链 VERIFIED**:install→待授权→面板同意→启用;升级路径复现）;P1-011 S1 把双门接到 Track2 旁路;P2-008 管理面。
4. **新增权限必须重新询问**——指纹绑定 regrant（U1.4+P5.3 配额扩张入指纹）;degraded 只减不增（R32）。
5. **撤销权限后插件无法继续使用原能力**——P2-010 版本门短路修复+revokePlugin 吊销全部通道帧（context-registry R2.2/D2 行为级）;设备复核待批次。
6. **RFC §13.4 SEC 全表进 release-gate**（P1-009）——18 条 SEC 全部有离线正/负用例（covered=4/partial=14/uncovered=0）,sec-coverage 门禁第 30 步机器对账,用例删除或证据指针腐烂即红。
7. **真机安全验收主体证据在案**（P1-010 的 B-001 解除后审计结果）——PoC verdict/双插件并发/四流程/授权链/业务路径 SEC 探针 10/10+legacy 停用 fail-closed,全部 fail-visible 且证据指针已入矩阵。

### 未达成（出口欠账,逐项有主）

1. **设备负例批次（欠账最大头,归 supervisor 设备排期）**:SEC-005/006/007/008/009/011/012/013 的真机拒绝断言+SEC-013 卸载→旧通道 RPC 真机拒绝（P1-008 验收行设备半边）;P1-005/P1-007/P1-011/P2-009 的设备复核（R30-R32 均标注"待设备批次"）。清单与口径=plugin-sec-coverage 矩阵 blocker 列,跑完逐条回填矩阵。
2. **P1-004 ADR 待评审（人工 gate,HUMAN_QUEUE#3）**:混合模型定 Track2 命运;评审前 Track2 面 SEC-002 不可宣covered。批准后 S2-S4 依序（视图载体 PoC→求值器退役+CSP 收紧→CM6 Trusted 面）。
3. **沙箱轨开关默认翻转**（ADR-R28-01 复审条件已满足:R28 真机验收通过,待人工复审翻默认——HUMAN_QUEUE#3 同批）。
4. **Track2/视图面残留**:view/settings 执行面切片（P1-003b 剩余面）;P2-013 Toggle uitest 连击（设备验证依赖真实触摸）。
5. **信任链半边（B-002,外部决策）**:SEC-014 authenticity/SEC-015 元数据回滚链/SEC-017 撤销数据源——Phase 5 域,不阻塞 Phase 1 出口但阻塞公开市场。
6. **观察面**:runtime 页 console 观测哑（KI-5）——SEC 探针直接标记通道不可用,当前靠 data.json 对账,设备批次沿用此口径。

### 出口建议

Phase 1 判 **"有条件出口"**:验收五条中 1-4 条已达成且有设备证据背书;第 5 条（撤销立即失效）离线行为级达成、设备复核欠账。出口动作=①设备负例批次跑完回填矩阵（把 partial→covered 的设备半边补齐）;②HUMAN_QUEUE#3 两项 ADR 复审（P1-004/R29-01、默认翻转/R28-01）;③出口后 Phase 2 开工不信任 Track2 残面（P1-004 未落地前,workspace 页仍按 Trusted-内部纪律对待,不开放第三方装载——该纪律已由 P1-011 S1 fail-closed 门强制）。
