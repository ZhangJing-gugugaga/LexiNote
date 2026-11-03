# BLOCKERS — 阻塞与外部依赖

| ID | 问题 | 影响 | 状态 | 需要什么 | 临时绕行 | 阻塞整个 Phase? |
|---|---|---|---|---|---|---|
| B-001 | HarmonyOS 模拟器不可用（错误 00801005 / OOM），真机批次全停 | P1-001 ArkWeb 沙箱验证、P1-010 验收、P4-005 兼容真机回归、P5-007/008、dist-flows、poc-verdict | OPEN（docs round5/6 均有记录） | 可用模拟器镜像或真机（带 hdc） | 离线静态+vm 门禁；PoC 探针在 vm 中仿真 | **是——Phase 1 无法 VERIFIED** |
| B-002 | 生产签名密钥与 root 信任锚未建立（算法选型 Ed25519 vs 平台能力未实测；密钥保管/轮换属外部决策） | P5-002 TUF 接线、P5-009 生产签名、公开市场前置 | OPEN | 用户决策：密钥体系与发布信任模型；平台签名 API 实测 | CLI HMAC dev 缝仅限开发；P5-001 先封死无哈希远程安装 | Phase 5 的 authenticity 半边 |
| B-003 | 对外发布仓库 `lexinote-releases` 推送需用户授权 | P5-006 索引升级上线（P5-001 生效后市场条目"缺哈希"不可装） | OPEN | 授权推送或提供发布流程 | 本地先把索引与校验工具准备好 | 否（可先准备） |
| B-004 | 安装授权 UI 的交互决策（RFC §4.5 必需/可选/高风险分级呈现） | P5-004 去自动启用、P2-008 权限管理 UI | TODO 设计 | 无外部依赖,需设计评审后实现 | 现状：装完自动 enable（安全缺口,列 P0 任务） | 否 |
| B-005 | Windows 开发机差异：PATH `node` 为坏 shim；`scripts/build.sh` macOS-only；DevEco 路径与 mac 门禁默认值不同 | 测试入口摩擦 | 已知,绕行有效 | 统一入口脚本（P0-006） | 绝对路径 node.exe + LEXI_TYPESCRIPT 显式导出 | 否 |
| B-006 | `generate.cjs` 解析器与对账器对 shim 锚点口径不一致（重生成引入 7 处假脱节） | 契约快照再生流程 | OPEN（Round 7 发现） | 修 generator（P0-005） | 本轮手工只修自己造成的 2 个锚点 | 否 |
| B-007 | `docs/` 被 gitignore,八篇公开文档与历史 round 记录不在版本库 | 外部开发者拿不到文档（P1-03）;门禁 docs-contract 依赖本地 docs | OPEN | 最小范围 ignore 调整方案（P0-004） | 工程记录已迁 `rfcs/`（进 Git） | 否 |

## 历史真机问题（tools/plugin-dist/known-issues.md 台账,未闭环即不得遗忘）

- KI-1 市场 Sheet 已安装列表挤占致远程条目不可达 → 任务 P5-007,验收 `plugin-dist-flows --market-repro` N=3..8 reachable=true。
- KI-2 幽灵已安装条目（obsidian-outliner 无磁盘目录,卸载报"插件目录不存在"）根因未定位 → P5-008（依赖 B-001）。
- KI-3 shell 无写权限入应用私有目录（数据预置不可行）→ 已绕行（probe 插件 onload 自写标记）,保持记录。
