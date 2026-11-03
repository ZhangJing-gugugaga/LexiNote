# PROGRESS — 逐轮工程进展

## Round 7 — 2026-11-03（基线 `main @ c1863ff`）

**当前 Phase：** Phase 0 完成（P0-001/P0-002 交付）；进入 Phase 1/5 安全任务流。

### 本轮完成

1. **P0-001 全量审计（VERIFIED）**：三路并行源码审计，RFC P0-01..P0-04 全部证实并补充更严重事实：
   - P0-01 证实且低估——除 headless runtime 轨道外，workspace 轨道（手机默认打开笔记路径）同样共享 realm `new Function`；沙箱 PoC 组件被 Index.ets 挂载但仅跑探针。
   - P0-02 部分证实——宿主 credential→pluginId 映射为 CSPRNG 且 fail-closed；但 `LexiObsidian.currentToken()` 回落裸 sessionToken、`app.plugins.getPlugin()` 暴露他插件 `__lexiToken`（身份盗用面）。
   - P0-03 证实且更糟——v2 细粒度视图在 `LexiPluginManifest` 边界销毁；`vault.read` 零 capability；`storage.quotaBytes` 反向绑 vault.write；指纹只覆盖 3 类标签→权限扩张静默继承。
   - P0-04 证实且现行——默认生产索引为无 sha256 裸数组；空哈希跳过比对（fail-open）；装完自动 enable 无授权 UI；`LexiRegistryTrust` 宿主零引用；撤销列表永不填充；一键明文 http 演示源。
   - 定位修正：`LexiSandboxHost.ets` 在 `entry/src/main/ets/components/plugin/`；无 `LexiPluginManager.ets` 文件（类在 `LexiPluginRuntime.ets:409`）；更新策略文件为 `LexiUpdatePolicy.ets`。
2. **P0-002 工程体系（IMPLEMENTED）**：本目录 8 份记录 + `rfcs/third-party-plugin-ecosystem-rfc.md` 全文进仓库（`docs/` 被 gitignore，RFC 与记录不得依赖 docs/）。
3. **P5-001 远程安装 fail-closed 信任闸门（IMPLEMENTED，真机 UI 待验）**：
   - `LexiPluginMarketModel.ets`：新增唯一判定 `isTrustedInstallHash()`（64 位小写 hex）。
   - `LexiPluginRuntime.ets`：`installFromUrl` 在**下载之前**拒绝空/非法哈希（本地 `installZip` 侧载保留空哈希语义——双信任策略）；`fetchMarketIndex` 记录 warnings。
   - `LexiPluginMarketSheet.ets`：安装口同判定拦截 + 按钮禁用 + 「哈希已校验/旧版·缺哈希」标识 + 旧版索引 warnings 上屏。
   - 测试：dist-regression +2 用例（判定语义 + 接线/顺序断言）18/18；market-regression +1 用例（旧版可展示但不可信）4/4。

### 修改文件

`entry/src/main/ets/core/plugin/LexiPluginMarketModel.ets`、`entry/src/main/ets/core/plugin/LexiPluginRuntime.ets`、
`entry/src/main/ets/components/plugin/LexiPluginMarketSheet.ets`、`scripts/tests/plugin-dist-regression.cjs`、
`scripts/tests/plugin-market-regression.cjs`、`tools/contract/symbols.json`（仅手工修正因行号位移脱节的 2 个锚点：
1459→1467、1271→1279；**未**采用 `generate.cjs` 重生成，因其解析器与对账器不一致会弄坏另外 5 个 shim 锚点——缺陷记 P0-005）、
新增 `rfcs/` 全部文件。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `node scripts/tests/plugin-market-regression.cjs` | PASS 4/4 |
| `node scripts/tests/plugin-dist-regression.cjs` | PASS 18/18 |
| `node tools/plugin-dist/release-gate.cjs --ci` | 首轮 27/28（contract-matrix 因我的行号位移报 2 处锚点脱节）→修正后 **PASS 28/28** |
| `hvigorw.bat assembleHap --mode module -p product=default` | **BUILD SUCCESSFUL**（CompileArkTS 通过） |
| `node scripts/tests/plugin-contract-matrix.cjs --fixtures-required` | PASS（锚点修正后） |
| 真机（plugin-dist-flows 市场 UI 全流程） | BLOCKED——模拟器错误 00801005（B-001），且演示源索引已带 sha256 不受闸门影响（flows 脚本 server 语义核对过） |

### 兼容性影响（重要）

- **行为变化：** 现行发布索引 `tools/lexinote-releases/community-plugins.json` 为无哈希裸数组 → 升级后市场条目显示「缺哈希」不可安装。这是 RFC P0-04 要求的 fail-closed 语义，但**真实市场恢复可用需要 P5-006 升级发布索引**（涉及对外仓库推送，需用户授权）。
- 本地侧载、演示源（schemaVersion=1 带哈希）不受影响；旧 API 未动。

### 尚存风险

- 自述哈希只保证完整性，不保证来源（authenticity）——TUF 接线在 P5-002；明文 http 演示源仍在（P5-005）。
- 装完自动 enable + 无授权 UI 未变（P5-004，下一个安全 P0）。
- 沙箱主缺陷（P0-01/P0-02）仅新增审计定位，代码未动（P1 序列）。

### 下一轮任务

1. **P5-006**（发布索引升级到 schemaVersion=1+sha256 的本地准备 + 提请推送授权）。
2. **P1-006**（页面级身份暴露面移除，纯本地安全缺陷）。
3. 视进展 P2-001/002。

---

## Round 8 — 2026-11-03（基线 `main @ c1863ff` → `29abe91`/`83be122` + 本轮）

**当前 Phase：** P5-001 **VERIFIED（离线+真机四流程）**；Phase 1 获得首条决定性真机证据（沙箱 PoC 静默失效）。

### 本轮完成

1. **Round 7 提交**（用户授权）：`c8fd04c` rfcs 体系、`29abe91` P5-001。
2. **P5-006 本地准备（IMPLEMENTED）**：`83be122` — 发布镜像改严格 `schemaVersion=1`（空 plugins，删除指向不存在仓库的 market-demo 死条目）；`validate.mjs` 重写为客户端同口径（sha256 必填/https/id 格式）+ `--remote` 实测 zip 字节哈希；README/工作流同步。门禁新三方一致用例（客户端=共享校验器=发布仓 CI 校验器）。**发现：GitHub 上 `lexinote-releases`/`lexinote-market-demo` 均不存在（404）——默认市场 URL 一直是死链，不存在"升级破坏真实用户"的问题；公开发布=新建公开仓库，属 ADR-015/§10 决策点，未执行。**
3. **真机批次首次跑通（B-001 解除）**：环境事实：实例 `lexi_2in1`（桌面宽布局，flows 自动化标定形态），`Emulator.bat -start lexi_2in1 -noWindow` + `hdc tconn 127.0.0.1:5555`；**`lexi_phone` 窄布局首页没有 `workspace-action-dock-profile`，flows 不适用于 phone 实例**（非产品缺陷，测试形态错配）。
4. **P5-001 真机验收 PASS**：`plugin-dist-flows --run --flow install|upgrade|rollback|uninstall` 全部通过（证据 `.fixtures-out/evidence/20261103-213058`…`-213656`）：哈希合法条目正常安装；篡改 zip → UI `integrity_mismatch`、指针不动、无残留；升级保数据、回滚可再 onload、卸载入 `.trash` 重启不复活。
5. **KI-4 定位并修复（真机新缺陷,当日闭环）**：运行时安装的插件"装得上却永不 onload"——`scanPluginDir` 不做 `discovered→installed` 记账（全仓唯一 `markInstalled` 在启动路径 `init():765`），`enablePlugin` 被迁移表拒绝。修复 4 行 + dist-regression 接线断言钉死；`hilog.log:31902` `插件 onload 完成: dist-flow-probe` 为修复证据。**教训：28 步离线全绿测不出 Runtime 接线级缺陷——设备批次必须重新进门禁计划（P0-003 时纳入）。**
6. **P1-001 首条真机结论（关键负面证据）**：ArkWeb API 26 上沙箱 PoC **完全静默**——`lexinote_sandbox_poc.html` 加载后，iframe 目标文档 `lexinote_plugin_sandbox.html` **零资源请求**、零 `[lexinote][sandbox]` console 输出（phone/2in1 双实例一致）。RFC 的 `iframe sandbox="allow-scripts"` 隔离模型在 ArkWeb 上不可按 Chromium 语义假设。假说清单（下轮插桩定位）：a) PoC 页 CSP 缺 `frame-src`；b) ArkWeb 对 sandboxed iframe 的 src 加载限制；c) JS 早期异常吞掉建 iframe 代码。新增 B-008/P1-001a。

### 修改文件

`entry/.../LexiPluginRuntime.ets`（scanPluginDir 记账）、`scripts/tests/plugin-dist-regression.cjs`（+1 接线断言）、`tools/contract/symbols.json`（+4 行位移的 2 锚点手工再修）、`tools/lexinote-releases/*`（P5-006）、`tools/plugin-dist/known-issues.md`（KI-4）、rfcs 记录。

### 实际执行的测试

| 命令 | 结果 |
|---|---|
| `plugin-dist-flows --run --flow install`（2in1 修复前/后各一次） | 前：**1 FAIL（KI-4）**；后：**PASS** |
| `plugin-dist-flows --run --flow upgrade / rollback / uninstall`（2in1） | **PASS×3** |
| `hvigorw assembleHap` | **PASS**（21:30 产物即上机包） |
| `release-gate --ci` | 首轮 27/28（锚点位移）→ **PASS 28/28** |
| 沙箱 PoC hilog 取证（phone 30s + 2in1 35s） | **FAIL/静默**（见上,已立项 B-008） |
| `validate.mjs --remote` | NOT RUN（zipUrl 指向未发布的仓库；发布时由该仓 CI 执行） |
| KI-1 `--market-repro` N=3..8 | NOT RUN（本轮未做规模复现） |

### 兼容性影响

- 镜像索引改为空 v1：客户端市场页显示"市场为空"（此前为 404 报错），语义改善无回归。
- `scanPluginDir` 记账对启动路径幂等无副作用；broken 目录不记账（维持不可启用）。

### 尚存风险 / 下一轮

1. **P1-001a（最高优先）**：沙箱 PoC 静默根因插桩定位（CSP frame-src 假说优先，改动最小、可离线复现于设备）；产出 ADR 决定隔离载体（iframe vs 其他 ArkWeb 原语）。
2. **P1-006**：页面级身份暴露面移除（`currentToken()` 回落/`__lexiToken`）。
3. **P5-004**：安装后不自动启用 + 授权清单 UI（真机证据链已具备回归条件）。
4. 用户决策点：是否新建并公开 `lexinote-releases` 仓库（ADR-015 建议：安全闭环前保持不发布；当前闸门+空索引已可支撑私有演练）。
