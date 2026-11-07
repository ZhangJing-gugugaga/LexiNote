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
| 沙箱隔离 | plugin-context-isolation + **真机 PoC verdict** | 安全(PoC 面,离线 86 项+真机 hilog) | **PASS 86/86(Round 32 +S41 销毁面)；真机 PASS(Round 9)**：contexts=2/2, vectors 20/20 blocked, credentialHits=0；origin=null/ports=1/ping-pong 为常驻见证 | ✔(载体级) | **B-008 关闭,ADR-R9-01 iframe 载体定案**；业务轨道共享 realm 未覆盖(P1-003/009);SEC 全表已接入(P1-009/R33,见下方映射) |
| 宿主页 eval 清零(P1-003c/ADR-R25-01) | S26-S29(context-isolation) + C6.1-4(cli-contract) + shim-regression 注入通道用例 + **真机差分** | 契约+行为(vm)+**设备** | **PASS(Round 25)**:runtime CSP 无 unsafe-eval(S26)/HTML 零内联脚本(S27)/runtime 页脚本 eval 对账+shim 过渡通道恰 1 处门控(S28/S28b)/沙箱保留有据(S29);CLI build IIFE 幂等+vm 行为级(C6) | ✔(差分) | 真机×4 冷启:新 CSP 下 lexi-sample 装载运行+沙箱轨回归,零违规;判定=差分(沙箱 iframe eval 可用 vs runtime 页无 eval 仍装载→必经注入);直接标记缺失=KI-5(runtime 页 onConsole 哑);workspace 页过渡通道删除断点=P1-004 |
| 业务插件沙箱执行(P1-003b) | 真机双插件并发链(容器页 hilog + data.json 落盘) | 集成(设备) | **PASS(Round 24)**：probe+sample-min 双 iframe 并发装载,帧交错双向零丢失;sample-min 全链(loadData/saveData/addCommand×2/vault.files/onload.done);命令面板→容器→iframe window 通道回环 `record-run count=1`;data.json `{"runCount":1,"bootOk":true,"lastRunAt":…}` 铁证;probe 回归 `{"marker":"sandbox-probe-ok"}` 不变 | ✔ | **B-009b 关闭(误诊)**;view/settings/editor 执行面后续切片 |
| 身份面 | plugin-bridge-security | 安全(真实宿主) | **PASS 34/34(Round 10,+8 断言:R6f-h 行为级 vm、R7a-d WeakMap/fail-closed/显式凭据)**;真机佐证见下 | ✔(负面路径 Round 8/10) | P1-006 收口:currentToken/withToken/hostCall 入口删除、WeakMap 归属令牌、栈空 anonymous;残余 `__receive` 面登记 P1-006b |
| 身份投递静态对账 | plugin-identity-delivery --strict | 静态审计 | **PASS 30/30 traced 0 gaps(Round 10,分类器识别 objectToken 包装形态)** | ✘ | KNOWN_GAPS 台账机制保留 |
| 令牌下发一致性 | plugin-identity-delivery --strict | 静态审计 | PASS | ✘ | KNOWN_GAPS 台账 |
| Registry 信任链 | plugin-registry-trust | 单元 | PASS | ✘ | 模块宿主零引用→需加接线断言(P5-002) |
| 更新/回滚/降级策略 | plugin-update-policy(47:U1 更新策略/U2 同版本对称/U3 §9.2 十五步对账/W1 接线), plugin-dist-regression §4b(P5-010 包哈希记录行为级) | 单元+真FS | **PASS(R42)**:同版本异哈希不对称已修(包哈希记录同域比对,幂等重装放行/侧载拒绝话术如实);§9.2 十五步逐条对账 | ✘ | 同版本覆盖/回滚链真机负例待批次;S3 发布者身份验证接线归 P5-002(B-002) |
| 包结构校验 | plugin-package-verifier | 单元 | PASS | ✘ | 空哈希跳过被固化为期望→仅限本地侧载语义,P5-001 已在外围封死远程 |
| 生命周期/所有权 | plugin-lifecycle-once, plugin-extension-ownership | 契约 | PASS | ✘ | quarantine 等状态不可达(P2-009) |
| 契约三脚架/矩阵 | plugin-contract-tripod, plugin-contract-matrix | 契约 | PASS(锚点修正后) | ✘ | generate.cjs 缺陷 P0-005 |
| SDK/CLI/Inspector/Docs | sdk-contract, lexi-cli-contract, inspector, docs-contract, **examples** | 契约 | **PASS(R34/R35/R36;R44 扩)**:sdk-contract 30→**37**（+S7 P3-001:dist 构建→npm pack→离线 npm install→require+ts.createProgram 双通道消费）→**39**（R35 真类型检查+S4.1 同源对账）→**49**（R44 +S8 P6-002 版本策略与废弃对账十项）;cli-contract 18→**45**（+C7-C12 P3-004:dev/test/inspect/doctor/compatibility 每命令行为级+create→build→pack 全链 C12）;examples **51**（R36/P3-007 新门禁:五类示例逐例真实 CLI validate→build→inspect→pack+IIFE 产物断言+vm boot 全链,沙箱面清单自宿主源提取做严格对账,负例注入实测红）;docs-contract 17→**32**（R44 +D5 审核分级清单对账/D6 安全流程文档对账） | ✘ | 示例的视图/Markdown/设置执行面+命令回环+设置页原生渲染真机行为归 P4-005 设备批次（示例已如实标注 pending） |
| 生态治理三件（P6-001 审核分级/P6-002 版本策略/P6-003 安全公告） | docs-contract D5/D6, sdk-contract S8, report.cjs 稳定性节（contract-matrix 漂移检查覆盖） | 契约（文档对账,离线） | **PASS(R44)**:审核清单↔release-gate gates 数组**双向对账**（发明/遗漏/步骤数漂移即红,发明门禁负例实测红）;M1 未出口⇒包锚 experimental（包锚翻转 stable 负例 S7.2+S8.3 双红实测）;快照 deprecated↔登记册双向一致（现空）;公告模板字段+embargo 90 天+人工发布门 needle;compat-matrix.md 稳定性与废弃节逐字节可再生 | ✘ | Trusted 进入通道前置 B-002/P5-002/009（文档前瞻定义,现无候选）;安全入口渠道待 ADR-015/B-003 公开仓启用;方法级 status 重标定归 P3-003 |
| 市场 UI 全流程(KI-1/2/3, 安装升级回滚卸载) | plugin-dist-flows --run | 集成(设备) | **PASS ×4(Round 8, lexi_2in1)** | ✔ | KI-1 规模档位 `--market-repro N=3..8` 仍 NOT RUN；KI-2 幽灵条目仍需真机定位(设备已可用,排 P5-008) |
| 沙箱性能与驻留(PoC 判据) | plugin-poc-verdict | 真机判据 | NOT RUN | ✘ | 需真机 JSON 输入(B-001) |
| HAP 构建 | hvigorw assembleHap | 构建 | **PASS**(本轮 BUILD SUCCESSFUL) | ✘ | 签名缺省(仅 unsigned) |
| 网络宿主代理面(SEC-010/011) | net-request-url(83 断言:origin/method/size/identity/timeout) | 契约+行为(真模块) | **PASS(R33 起进 release-gate)**:未声明拒/越 origin 拒/令牌错配拒/方法白名单(P2-006a-b)/请求响应字节上限(P2-006c-d)/net_timeout 与 transport_failed 可区分 | ✘ | 设备直接外传负例已真机(R28 fetch/XHR blocked);宿主代理面设备负例随下批补(SEC-010 判 covered 的口径见 sec-coverage 矩阵) |
| SEC 覆盖矩阵(P1-009/R33) | plugin-sec-coverage:RFC §13.4 SEC-001..018 全表 → 证据(门禁+用例 needle+设备指针)逐条对账 | 矩阵门禁 | **PASS 282 项(R33)**:covered=4(SEC-001/003/004/010) partial=14 uncovered=0;用例被删/证据指针腐烂即红 | 部分 | 设备负例缺口逐条写明 blocker(见矩阵输出/RELEASE_READINESS Phase 1 出口评审) |
| 全量门禁 | release-gate --ci | CI | **PASS 32/32(R44 复跑全绿;R36 起 32 步=examples 进账;R44 治理三件折入 sdk-contract/docs-contract,步骤数不变)** | ✘ | 无根仓库 CI 自动触发(P0-003) |

## SEC 计划编号映射（RFC §13.4 现状,P1-009/R33 起由 plugin-sec-coverage.cjs 机器对账）

机器可对账真源 = `scripts/tests/plugin-sec-coverage.cjs`(进 release-gate --ci 第 30 步):SEC→门禁+用例 needle→逐条对账,用例被删/改名或工程记录证据指针腐烂即红。下表为 R33 快照(covered=4 / partial=14 / uncovered=0):

| 编号 | 场景 | verdict | 离线证据(门禁:行为级正/负用例) | 设备证据 | 缺口 blocker |
|---|---|---|---|---|---|
| SEC-001 | 父窗口 DOM 访问 | **covered** | context-isolation S4/S5/S6/S14/S11/E1c/E1d + dist-reg 探针向量清单 | R9 verdict + R28 业务路径 10/10(parent-dom/window-opener blocked) | — |
| SEC-002 | 宿主全局对象访问 | partial | bridge-security R1/R5/R6/R7/R8g.1 + context-isolation S14/S26/S28/S31b + identity-delivery | R9+R28 沙箱轨(parent-globals/function-escape blocked, credentialHits=0) | Track2 工作区页执行面未收敛(P1-004/ADR-R29-01 待评审);视图/设置叶面=P1-003b 剩余切片 |
| SEC-003 | 跨插件 iframe 访问 | **covered** | context-isolation S7/S11/S12/S13/S41a + dist-reg sibling-iframe | R24 双 iframe 并发 + R28 sibling-iframe + R9 contexts=2/2 | — |
| SEC-004 | Session Token 获取 | **covered** | bridge-security R2/R5/R6/R7/R8e + net-request-url 4.x/5.x + S30c + identity-delivery | R28 credential-hunt 扫描 0 命中(+R9 credentialHits=0) | — |
| SEC-005 | 伪造 pluginId | partial | context-registry R1.1/R3.1/R3.2/D3 + bridge R3a/R3b + authz M2.14/M4.10 + net 5.x | 待批次 | 伪造身份/越权帧真机拒绝断言待设备批次 |
| SEC-006 | 跨插件存储读取 | partial | authz M2.5/M2.32/M2.33/M2.45 + context-registry R3.1b(R33 新增) + dist-reg data 解绑锚+fsGate 行为级 | 待批次 | 跨插件存储归属真机断言待批次(设备现证仅 opaque-storage API 面) |
| SEC-007 | 跨插件命令删除 | partial | authz M2.14/2.15/2.17/2.18/2.39/M3.4 + bridge R8a/R8b/R8g.1-5 | 待批次 | 跨插件删除/盗用通道凭据真机断言待批次(R30 落地待设备复核) |
| SEC-008 | 未授权 Vault 写入 | partial | authz M2.22/2.23/2.24/M2.40 + manifest-v2 V5.6/V5.9 + dist-reg fsGate 行为级(R33 新增) | 待批次 | 未授权 vault 写真机拒绝断言待设备批次 |
| SEC-009 | 路径穿越 | partial | package-verifier A1.2/A1.4 + manifest-v2 V5.7/V5.8 + context-registry D3 + dist-reg fsGate 穿越形态拒(R33 新增) | 待批次 | 穿越路径真机拒绝断言待设备批次 |
| SEC-010 | 未授权网络请求 | **covered** | net-request-url 83 断言全套(origin/method/size/identity/timeout,R33 起进 release-gate) + authz M2.30/M2.31 + dist-reg | R28 fetch/XHR 直接外传 blocked | —(代理面设备负例随下批补,宿主进程独占执行不构成开口) |
| SEC-011 | 大请求资源耗尽 | partial | net P2-006c/d(8b.5/8b.7) + package-verifier A1.6-A1.14 + dist-reg storageQuotaGate 行为级(R33 新增)+配额锚 + manifest-v2 V5.5 + permission-store P5.3 | 待批次 | 大载荷/配额超限真机断言待设备批次 |
| SEC-012 | RPC 超时 | partial | net 10.x/11.x + dist-reg withTimeout 行为级(R33 新增) + lifecycle-once L6.7/L9.4 | 待批次 | 真机 RPC 超时/挂起恢复断言待设备批次 |
| SEC-013 | 恶意插件卸载残留 | partial | context-registry D1-D8(行为级) + context-isolation S41a-d + lifecycle-once L9.1/9.2/9.5/9.6 | 待批次 | 卸载→旧通道 RPC 真机拒绝(P1-008 验收行设备半边,R32/R33 登记待批次) |
| SEC-014 | 签名篡改 | partial | package-verifier A2.1-A2.6 + dist-reg 篡改字节→integrity_mismatch + registry-trust T2.8 | R8 flows 篡改包(integrity_mismatch 零残留) | authenticity=B-002(P5-002/009 未接,生产签名链不可测) |
| SEC-015 | 元数据回滚 | partial | registry-trust T1.1/T2.2/T2.3/T2.8 + update-policy U1.1 | 待批次 | 发布链未接 TUF/快照持久化(P5-002,B-002) |
| SEC-016 | 插件版本降级 | partial | update-policy U1.3/U2(同版本对称)/W1.1-W1.4 + dist-reg 降级必须被拦 + §9.2 十五步对账(R42) | 待批次 | 降级安装真机负例待批次(同版本异哈希不对称已修=R42 离线) |
| SEC-017 | 发布者密钥撤销 | partial | registry-trust T2.6 + update-policy U1.7 | 待批次 | 撤销数据源未接生产(P5-003;P5-002/009=B-002) |
| SEC-018 | 恶意依赖与包内容 | partial | package-verifier A1 组(预算/穿越/symlink/炸弹/扩展名白名单) + dist-audit 恶意样本 critical | R26 flows 安装链正向 | 包结构负例待设备批次(未单独上真机) |
