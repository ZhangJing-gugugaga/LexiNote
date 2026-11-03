# BLOCKERS — 阻塞与外部依赖

| ID | 问题 | 影响 | 状态 | 需要什么 | 临时绕行 | 阻塞整个 Phase? |
|---|---|---|---|---|---|---|
| B-001 | ~~HarmonyOS 模拟器不可用（错误 00801005 / OOM）~~ **RESOLVED 2026-11-03(Round 8)**:操作事实=实例 `lexi_2in1`(宽布局,flows 自动化标定形态)`Emulator.bat -start lexi_2in1 -noWindow` → `hdc tconn 127.0.0.1:5555`;`lexi_phone` 窄布局无 profile dock,flows 不适配(测试形态错配非产品缺陷);两实例勿同跑(4GB 内存争用) | — | **RESOLVED** | — | — | 否——真机批次恢复,dist-flows 四流程已跑通 |
| B-002 | 生产签名密钥与 root 信任锚未建立（算法选型 Ed25519 vs 平台能力未实测；密钥保管/轮换属外部决策） | P5-002 TUF 接线、P5-009 生产签名、公开市场前置 | OPEN | 用户决策：密钥体系与发布信任模型；平台签名 API 实测 | CLI HMAC dev 缝仅限开发；P5-001 先封死无哈希远程安装 | Phase 5 的 authenticity 半边 |
| B-003 | ~~发布通道缺失~~ **RESOLVED(Round 9)**:`lexinote-releases` 公开仓已建立并验证可达(raw 索引/CI 工作流就绪)。**纪律:plugins[] 保持为空,直至 P5-002(TUF)+P5-004(授权 UI)闭环——添加任何可安装条目=事实上的开放市场,须走完整发布验收**。 | — | RESOLVED | — | — | 否 |
| B-004 | 安装授权 UI 的交互决策（RFC §4.5 必需/可选/高风险分级呈现） | P5-004 去自动启用、P2-008 权限管理 UI | TODO 设计 | 无外部依赖,需设计评审后实现 | 现状：装完自动 enable（安全缺口,列 P0 任务） | 否 |
| B-005 | Windows 开发机差异：PATH `node` 为坏 shim；`scripts/build.sh` macOS-only；DevEco 路径与 mac 门禁默认值不同 | 测试入口摩擦 | 已知,绕行有效 | 统一入口脚本（P0-006） | 绝对路径 node.exe + LEXI_TYPESCRIPT 显式导出 | 否 |
| B-006 | `generate.cjs` 解析器与对账器对 shim 锚点口径不一致（重生成引入 7 处假脱节） | 契约快照再生流程 | OPEN（Round 7 发现） | 修 generator（P0-005） | 本轮手工只修自己造成的 2 个锚点 | 否 |
| B-007 | `docs/` 被 gitignore,八篇公开文档与历史 round 记录不在版本库 | 外部开发者拿不到文档（P1-03）;门禁 docs-contract 依赖本地 docs | OPEN | 最小范围 ignore 调整方案（P0-004） | 工程记录已迁 `rfcs/`（进 Git） | 否 |
| B-008 | ~~沙箱 PoC 在 ArkWeb API 26 静默~~ **RESOLVED(Round 9)**:三层根因——①宿主页内联脚本被自家 CSP script-src 'self' 拦杀(引导逻辑外置 poc.js,门禁 S20/S21 固化);②子→宿主 postToHost 缺 __lexiSandbox 协议标记被宿主过滤静默丢(修复,S22 固化);③探针 frames[0] 对首上下文即自身,致假阳性 LEAKED(改全量枚举+排除自身)。终验:真机 verdict PASS contexts=2/2,20/20 vectors blocked,credentialHits=0;origin=null(opaque origin)+ports=1 转移+双向投递=平台可行性坐结(ADR-R9-01) | — | **RESOLVED** | — | 真机巡检信号保留:ping/pong+里程碑打点 | 否 |
| B-009 | **新(Round 21)**:runtime 宿主页跨 frame 事件投递缺陷——①iframe→parent window.postMessage 不抛错但不达;②容器页 MessageChannel port1 不投递;**同份沙箱子文档在 PoC 独立页双向全通**(对照复测)。证据链 /tmp/r21{h,i2,j}.log 摘录已入 PROGRESS Round 21 | **P1-003b 沙箱轨在 runtime 页不可用**;P1-003 整体延后于方案 B | OPEN | 独立容器 Web 组件(方案 B,ADR-R21-02)——复用已验证形态;或华为侧 ArkWeb 定位 | 沙箱轨运行开关默认关(探针回落旧轨);旧轨/现有功能零影响 | **是——P1-003b/c/d 阻塞至方案 B 贯通** |

## 历史真机问题（tools/plugin-dist/known-issues.md 台账,未闭环即不得遗忘）

- KI-1 市场 Sheet 已安装列表挤占致远程条目不可达 → 任务 P5-007,验收 `plugin-dist-flows --market-repro` N=3..8 reachable=true。
- KI-2 幽灵已安装条目（obsidian-outliner 无磁盘目录,卸载报"插件目录不存在"）根因未定位 → P5-008（依赖 B-001）。
- KI-3 shell 无写权限入应用私有目录（数据预置不可行）→ 已绕行（probe 插件 onload 自写标记）,保持记录。
