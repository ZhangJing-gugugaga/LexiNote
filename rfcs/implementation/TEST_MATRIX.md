# TEST_MATRIX — 能力→测试→证据

运行方式：`LEXI_TYPESCRIPT=<ts> node scripts/tests/<name>.cjs`；全量 `node tools/plugin-dist/release-gate.cjs --ci`。
"真机" 列：有 HarmonyOS 设备证据 = ✔；仅离线证据 = ✘（离线门禁不能证明真机行为，RFC/Goal §7.5）。

| 能力 | 测试 | 层级 | 最近结果(Round 7) | 真机 | 缺口/备注 |
|---|---|---|---|---|---|
| 远程安装完整性闸门 (P5-001) | plugin-dist-regression §3（19/19）+ **真机 dist-flows 四流程** | 契约+接线+**集成(设备)** | PASS；**真机 PASS(Round 8,2in1)** | ✔ | 篡改包→UI integrity_mismatch 零残留、合法哈希安装/升级/回滚/卸载全绿(证据 20261103-213058..213656)；UI"缺哈希"分支仍离线断言(设备索引无此类条目)；authenticity 归 P5-002 |
| 发布镜像=客户端=共享校验器 三方一致 (P5-006) | plugin-dist-regression 新用例 + 镜像仓 validate.mjs | 契约 | PASS 19/19 | ✘ | --remote 实测哈希待真实 zip 条目（发布纪律：索引保持空至 P5-002/004 闭环） |
| 默认市场 URL 可达性 (Round 9) | curl raw lexinote-releases/community-plugins.json | 集成 | **PASS**：`{"schemaVersion":1,"plugins":[]}`（公开仓+validate 工作流已建立） | ✔ | 设备市场页"市场为空"展示随下轮 flows 顺带确认 |
| 生命周期安装记账 (KI-4/P2-012) | dist-regression §6 接线断言 + 真机 flows install | 接线+**设备** | **真机 PASS(Round 8)**：onload/命令注册/data.json 全达成 | ✔ | 教训:离线 28 步测不出该缺陷——设备批次纳入常规 |
| 索引 schema 裁决 (ArkTS=Node 双实现一致) | plugin-dist-regression §3 + plugin-market-regression | 单元/契约 | PASS 4/4, parity ok | ✘ | 新增"旧版可展示但不可信"用例 |
| 授权矩阵 (方法→kind) | plugin-authz-matrix | 契约 | PASS | ✘ | fsAuthorizer 为 stub——capability 真实注入未测(P2-011) |
| 权限存储/指纹 | plugin-permission-store | 单元 | PASS | ✘ | 指纹输入是字面量非真实 tagsOf(P2-002 连带) |
| Manifest v2 解析 | plugin-manifest-v2 | 契约 | PASS | ✘ | 证明解析,不证明执行面(P2-003..007) |
| 沙箱隔离 | plugin-context-isolation + **真机 PoC verdict** | 安全(PoC 面,离线 40 项+真机 hilog) | **PASS 40/40(Round 24 +S23/24/25 回落/留痕/命令表断言)；真机 PASS(Round 9)**：contexts=2/2, vectors 20/20 blocked, credentialHits=0；origin=null/ports=1/ping-pong 为常驻见证 | ✔(载体级) | **B-008 关闭,ADR-R9-01 iframe 载体定案**；业务轨道共享 realm 未覆盖(P1-003/009);SEC 全表待接入 |
| 业务插件沙箱执行(P1-003b) | 真机双插件并发链(容器页 hilog + data.json 落盘) | 集成(设备) | **PASS(Round 24)**：probe+sample-min 双 iframe 并发装载,帧交错双向零丢失;sample-min 全链(loadData/saveData/addCommand×2/vault.files/onload.done);命令面板→容器→iframe window 通道回环 `record-run count=1`;data.json `{"runCount":1,"bootOk":true,"lastRunAt":…}` 铁证;probe 回归 `{"marker":"sandbox-probe-ok"}` 不变 | ✔ | **B-009b 关闭(误诊)**;view/settings/editor 执行面后续切片 |
| 身份面 | plugin-bridge-security | 安全(真实宿主) | **PASS 34/34(Round 10,+8 断言:R6f-h 行为级 vm、R7a-d WeakMap/fail-closed/显式凭据)**;真机佐证见下 | ✔(负面路径 Round 8/10) | P1-006 收口:currentToken/withToken/hostCall 入口删除、WeakMap 归属令牌、栈空 anonymous;残余 `__receive` 面登记 P1-006b |
| 身份投递静态对账 | plugin-identity-delivery --strict | 静态审计 | **PASS 30/30 traced 0 gaps(Round 10,分类器识别 objectToken 包装形态)** | ✘ | KNOWN_GAPS 台账机制保留 |
| 令牌下发一致性 | plugin-identity-delivery --strict | 静态审计 | PASS | ✘ | KNOWN_GAPS 台账 |
| Registry 信任链 | plugin-registry-trust | 单元 | PASS | ✘ | 模块宿主零引用→需加接线断言(P5-002) |
| 更新/回滚/降级策略 | plugin-update-policy, plugin-dist-regression §5 | 单元+真FS | PASS | ✘ | 同版本异哈希不对称未修(P5-010) |
| 包结构校验 | plugin-package-verifier | 单元 | PASS | ✘ | 空哈希跳过被固化为期望→仅限本地侧载语义,P5-001 已在外围封死远程 |
| 生命周期/所有权 | plugin-lifecycle-once, plugin-extension-ownership | 契约 | PASS | ✘ | quarantine 等状态不可达(P2-009) |
| 契约三脚架/矩阵 | plugin-contract-tripod, plugin-contract-matrix | 契约 | PASS(锚点修正后) | ✘ | generate.cjs 缺陷 P0-005 |
| SDK/CLI/Inspector/Docs | sdk-contract, lexi-cli-contract, inspector, docs-contract | 契约 | PASS | ✘ | SDK"类型检查"实为语法检查(P3-003) |
| 市场 UI 全流程(KI-1/2/3, 安装升级回滚卸载) | plugin-dist-flows --run | 集成(设备) | **PASS ×4(Round 8, lexi_2in1)** | ✔ | KI-1 规模档位 `--market-repro N=3..8` 仍 NOT RUN；KI-2 幽灵条目仍需真机定位(设备已可用,排 P5-008) |
| 沙箱性能与驻留(PoC 判据) | plugin-poc-verdict | 真机判据 | NOT RUN | ✘ | 需真机 JSON 输入(B-001) |
| HAP 构建 | hvigorw assembleHap | 构建 | **PASS**(本轮 BUILD SUCCESSFUL) | ✘ | 签名缺省(仅 unsigned) |
| 全量门禁 | release-gate --ci | CI | **PASS 28/28** | ✘ | 无根仓库 CI 自动触发(P0-003) |

## SEC 计划编号映射（RFC §13.4 现状）

已覆盖(离线,PoC 或宿主面)：SEC-002 部分(bridge-security)、SEC-003 部分(context-isolation)。
未覆盖：SEC-001/004/005 在业务轨道(P1-006/009)、SEC-006..008/011/012 部分、SEC-009 路径(P2-004)、
SEC-010 origin 之外的 method/size(P2-006)、SEC-013 卸载残留(P1-008)、SEC-014..017 信任链(P5-002/003/009)。
