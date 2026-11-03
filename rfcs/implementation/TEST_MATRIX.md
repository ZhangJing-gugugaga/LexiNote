# TEST_MATRIX — 能力→测试→证据

运行方式：`LEXI_TYPESCRIPT=<ts> node scripts/tests/<name>.cjs`；全量 `node tools/plugin-dist/release-gate.cjs --ci`。
"真机" 列：有 HarmonyOS 设备证据 = ✔；仅离线证据 = ✘（离线门禁不能证明真机行为，RFC/Goal §7.5）。

| 能力 | 测试 | 层级 | 最近结果(Round 7) | 真机 | 缺口/备注 |
|---|---|---|---|---|---|
| 远程安装完整性闸门 (P5-001) | plugin-dist-regression §3 两条新用例 | 契约+接线 | PASS 18/18 | ✘ | 真机市场 UI 全流程归 plugin-dist-flows（B-001）；authenticity 归 P5-002 |
| 索引 schema 裁决 (ArkTS=Node 双实现一致) | plugin-dist-regression §3 + plugin-market-regression | 单元/契约 | PASS 4/4, parity ok | ✘ | 新增"旧版可展示但不可信"用例 |
| 授权矩阵 (方法→kind) | plugin-authz-matrix | 契约 | PASS | ✘ | fsAuthorizer 为 stub——capability 真实注入未测(P2-011) |
| 权限存储/指纹 | plugin-permission-store | 单元 | PASS | ✘ | 指纹输入是字面量非真实 tagsOf(P2-002 连带) |
| Manifest v2 解析 | plugin-manifest-v2 | 契约 | PASS | ✘ | 证明解析,不证明执行面(P2-003..007) |
| 沙箱隔离 | plugin-context-isolation | 安全(PoC 面) | PASS | ✘ | **只测 PoC 面**;业务轨道共享 realm 未覆盖(P1-003/009) |
| 身份面 | plugin-bridge-security | 安全(真实宿主) | PASS | ✘ | R5 未覆盖 currentToken 回落/__lexiToken 暴露(P1-006) |
| 令牌下发一致性 | plugin-identity-delivery --strict | 静态审计 | PASS | ✘ | KNOWN_GAPS 台账 |
| Registry 信任链 | plugin-registry-trust | 单元 | PASS | ✘ | 模块宿主零引用→需加接线断言(P5-002) |
| 更新/回滚/降级策略 | plugin-update-policy, plugin-dist-regression §5 | 单元+真FS | PASS | ✘ | 同版本异哈希不对称未修(P5-010) |
| 包结构校验 | plugin-package-verifier | 单元 | PASS | ✘ | 空哈希跳过被固化为期望→仅限本地侧载语义,P5-001 已在外围封死远程 |
| 生命周期/所有权 | plugin-lifecycle-once, plugin-extension-ownership | 契约 | PASS | ✘ | quarantine 等状态不可达(P2-009) |
| 契约三脚架/矩阵 | plugin-contract-tripod, plugin-contract-matrix | 契约 | PASS(锚点修正后) | ✘ | generate.cjs 缺陷 P0-005 |
| SDK/CLI/Inspector/Docs | sdk-contract, lexi-cli-contract, inspector, docs-contract | 契约 | PASS | ✘ | SDK"类型检查"实为语法检查(P3-003) |
| 市场 UI 全流程(KI-1/2/3, 安装升级回滚卸载) | plugin-dist-flows --run | 集成(设备) | **BLOCKED** | ✘ | 模拟器 00801005/OOM(B-001) |
| 沙箱性能与驻留(PoC 判据) | plugin-poc-verdict | 真机判据 | NOT RUN | ✘ | 需真机 JSON 输入(B-001) |
| HAP 构建 | hvigorw assembleHap | 构建 | **PASS**(本轮 BUILD SUCCESSFUL) | ✘ | 签名缺省(仅 unsigned) |
| 全量门禁 | release-gate --ci | CI | **PASS 28/28** | ✘ | 无根仓库 CI 自动触发(P0-003) |

## SEC 计划编号映射（RFC §13.4 现状）

已覆盖(离线,PoC 或宿主面)：SEC-002 部分(bridge-security)、SEC-003 部分(context-isolation)。
未覆盖：SEC-001/004/005 在业务轨道(P1-006/009)、SEC-006..008/011/012 部分、SEC-009 路径(P2-004)、
SEC-010 origin 之外的 method/size(P2-006)、SEC-013 卸载残留(P1-008)、SEC-014..017 信任链(P5-002/003/009)。
