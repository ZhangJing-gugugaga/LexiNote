# BLOCKERS — 阻塞与外部依赖

| ID | 问题 | 影响 | 状态 | 需要什么 | 临时绕行 | 阻塞整个 Phase? |
|---|---|---|---|---|---|---|
| B-001 | ~~HarmonyOS 模拟器不可用（错误 00801005 / OOM）~~ **RESOLVED 2026-11-03(Round 8)**:操作事实=实例 `lexi_2in1`(宽布局,flows 自动化标定形态)`Emulator.bat -start lexi_2in1 -noWindow` → `hdc tconn 127.0.0.1:5555`;`lexi_phone` 窄布局无 profile dock,flows 不适配(测试形态错配非产品缺陷);两实例勿同跑(4GB 内存争用) | — | **RESOLVED** | — | — | 否——真机批次恢复,dist-flows 四流程已跑通 |
| B-002 | 生产签名密钥与 root 信任锚未建立（算法选型 Ed25519 vs 平台能力未实测；密钥保管/轮换属外部决策） | P5-002 TUF 接线、P5-009 生产签名、公开市场前置 | OPEN | 用户决策：密钥体系与发布信任模型；平台签名 API 实测 | CLI HMAC dev 缝仅限开发；P5-001 先封死无哈希远程安装 | Phase 5 的 authenticity 半边 |
| B-003 | 发布通道事实修正：GitHub 上 `lexinote-releases`/`lexinote-market-demo` **均不存在**——默认市场 URL 从来是 404,无真实用户在用。"推送"=新建并公开仓库,属 ADR-015 门槛("安全与签名闭环后")与 Goal §10"公开发布插件市场"确认项 | P5-006 的发布半边 | OPEN(等待明确发布决策;用户此前授权的"允许推送"基于"已存在仓库"的假设,不构成对新公开发布的授权) | 用户决策:何时公开、以什么审核门槛 | **本地准备已完成**(严格 v1 索引+校验器+三方一致门禁,`83be122`);发布通道随时可用 `gh repo create` 一条命令接通 | 否 |
| B-004 | 安装授权 UI 的交互决策（RFC §4.5 必需/可选/高风险分级呈现） | P5-004 去自动启用、P2-008 权限管理 UI | TODO 设计 | 无外部依赖,需设计评审后实现 | 现状：装完自动 enable（安全缺口,列 P0 任务） | 否 |
| B-005 | Windows 开发机差异：PATH `node` 为坏 shim；`scripts/build.sh` macOS-only；DevEco 路径与 mac 门禁默认值不同 | 测试入口摩擦 | 已知,绕行有效 | 统一入口脚本（P0-006） | 绝对路径 node.exe + LEXI_TYPESCRIPT 显式导出 | 否 |
| B-006 | `generate.cjs` 解析器与对账器对 shim 锚点口径不一致（重生成引入 7 处假脱节） | 契约快照再生流程 | OPEN（Round 7 发现） | 修 generator（P0-005） | 本轮手工只修自己造成的 2 个锚点 | 否 |
| B-007 | `docs/` 被 gitignore,八篇公开文档与历史 round 记录不在版本库 | 外部开发者拿不到文档（P1-03）;门禁 docs-contract 依赖本地 docs | OPEN | 最小范围 ignore 调整方案（P0-004） | 工程记录已迁 `rfcs/`（进 Git） | 否 |
| B-008 | **沙箱 PoC 在 ArkWeb API 26 完全静默**：`lexinote_sandbox_poc.html` 已加载,但其 iframe 目标文档 `lexinote_plugin_sandbox.html` 零资源请求、`[lexinote][sandbox]` 零输出(phone/2in1 双实例一致,30-35s 窗口) | **P1-001 及整个 Phase 1 的隔离载体选型** | OPEN(Round 8 发现) | 插桩定位(P1-001a):假说序 ①PoC 页 CSP 缺 `frame-src` ②ArkWeb 对 sandboxed iframe 的 src 加载限制 ③早期 JS 异常吞掉建 iframe 代码 | 无绕行——这正是需要得到的平台事实 | **可能——若 iframe 载体不可用,需按 RFC §2 流程出 ADR 换载体再走 P1-003** |

## 历史真机问题（tools/plugin-dist/known-issues.md 台账,未闭环即不得遗忘）

- KI-1 市场 Sheet 已安装列表挤占致远程条目不可达 → 任务 P5-007,验收 `plugin-dist-flows --market-repro` N=3..8 reachable=true。
- KI-2 幽灵已安装条目（obsidian-outliner 无磁盘目录,卸载报"插件目录不存在"）根因未定位 → P5-008（依赖 B-001）。
- KI-3 shell 无写权限入应用私有目录（数据预置不可行）→ 已绕行（probe 插件 onload 自写标记）,保持记录。
