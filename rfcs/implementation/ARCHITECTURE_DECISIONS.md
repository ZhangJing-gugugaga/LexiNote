# ARCHITECTURE_DECISIONS — 编号 ADR-R{轮}-{序}

## ADR-R7-01 采纳 LEXI-RFC-PLUGIN-001 为架构基准，工程记录迁出版被忽略的 docs/

- 背景：RFC 以粘贴文档提供，仓库内不存在；历史轮次记录与八篇文档位于被 `.gitignore` 忽略的 `docs/`，门禁引用的 "RFC" 无版本控制依据（RFC P1-03）。
- 方案：RFC 全文入 `rfcs/`；执行计划/进展/决策/阻塞/测试矩阵/模块图入 `rfcs/implementation/`；`docs/` 忽略策略不动（八篇文档入 Git 另列 P0-004，做最小范围 ignore 调整）。
- 理由：满足"所有工程文件必须纳入 Git"，不触碰既有 `docs/` 约定。
- 复审：P0-004 完成时决定八篇文档最终落点。

## ADR-R7-02 远程安装信任闸门提前执行（打乱 Phase 顺序的裁定）

- 背景：RFC §16 要求 TUF/签名属 Phase 5；但 Goal §5 Step3 规定安全缺陷最高优先；审计确认 fail-open 无哈希远程安装→自动启用是当前可利用面（默认索引无 sha256）。
- 方案：**先封完整性下界**（无受信任哈希→下载前拒绝），TUF authenticity 接线留待 P5-002/密钥决策。
- 备选：a) 现在就接 LexiRegistryTrust——拒绝：需 root 密钥/签名算法真机验证决策（B-002），会把小任务变大；b) 不动分发先做沙箱——拒绝：沙箱被 B-001 阻塞，而分发缺陷今天就能封。
- 兼容性：真实市场条目在发布索引升级（P5-006）前显示「缺哈希」不可装——这是 RFC 明文要求的 fail-closed（"生产市场不得允许缺少受信任哈希的远程插件安装"），不视为回归。

## ADR-R7-03 双信任策略：远程安装 vs 本地侧载

- 决策：`installFromUrl`（市场/远程）强制 `isTrustedInstallHash`；`installZip`（用户在设置中选定本地 zip）保留空哈希跳过语义（自选文件以用户意志为信任根）。`LexiPackageVerifier.verifyHash` 的空声明跳过同理仅限本地。
- 判定唯一入口：`LexiPluginMarketModel.isTrustedInstallHash()`，宿主与 UI 复用同一函数，禁止两处各写正则（Round 7 审计指出 capabilityTags 双副本教训）。
- 演示源（http://10.0.2.2:8099）：设备回归流的 schemaVersion=1 索引自带 sha256，闸门兼容；明文 http 的 dev 标记与生产 https 强制归 P5-005。

## ADR-R7-04 契约快照锚点修正采用手工最小补丁

- 背景：本轮 .ets 插行导致 symbols.json 两个"路径:行号"锚点脱节（门禁 2 项红）；官方修法 `generate.cjs` 重生成会把 5 个正确的 shim 锚点写成错的（7 项红）——generator 与 verifier 口径不一致（B-006）。
- 决策：只手工修 2 个受影响锚点；generator 缺陷立为 P0-005；在其修复前，任何贡献者不得"顺手"跑 generate 重生成。
- 复审：P0-005 完成后恢复"生成物必须且只能由 generator 再生"纪律。

## ADR-R7-05 沙箱接入策略（提案，待 P1-001 真机验证后定案）

- 方向：不新写运行时——复用 LexiPluginExecutionContext（补 port↔身份绑定）、以 PoC 已验证的 iframe(`sandbox="allow-scripts"`, opaque origin)+每上下文 MessageChannel 形态替换共享 realm；`new Function` 从宿主运行时移除，CommonJS 插件由构建期打包 IIFE（CLI/template 已是 esbuild 链路）；workspace 轨道的既有 WebMessagePort 收敛为唯一通道形态，两 broker 合并单 Gateway（P1-007）。
- 状态：Proposed——ArkWeb 对 opaque-origin iframe 的 MessageChannel/port 转移、runJavaScriptAlternatives 的实际语义**必须**真机验证（B-001），不得以 Chromium 行为推定 HarmonyOS。
- 边界提醒：删除/替换现有运行运行时属需人工确认事项（Goal §10）——届时携真机证据另行评审。

## 历史决策登记（迁移自既有代码语义,防遗失）

- Manifest v1 无 capabilities → `capabilitiesDeclared=false` → 跳过 T2.2 授权门且 legacy 分支放行 fs。此为兼容策略,但等于"旧插件默认高权"——P2 权限闭环须将其收敛为显式兼容权限集（RFC §18.1）。
- `LexiUpdatePolicy` 首装不询问（注释明示走启用即授权）——与 P5-004（安装即展示权限清单）的衔接点,届时复审。
