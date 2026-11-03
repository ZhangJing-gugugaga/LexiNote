# 分发链已知问题 / 待修项

记录的是**已经用真机证据坐实、但本轮按边界不修**的问题。每条都有：现象、证据、影响、修复验收标准。

---

## KI-1 市场面板远端列表在"已安装"占满可视区后被裁剪，装第 8 个插件后点不到安装

**现象**：社区插件市场 sheet 里"已安装"区块在最上，远端索引条目（分发探针 / 安装按钮）排在它下面。已安装 9 条时，索引条目被推到 sheet 可视区之外，且**无法通过滚动到达**（滚动事件被吞或根本没有滚动容器）。

**证据（真机，127.0.0.1:15555，com.lovexjy.lexinote）**
- dump 外包关系：sheet 外层 Column bounds `[978,496][2560,1675]`，内层 Column `[978,496][2560,1630]`。
- "已安装"9 条 Row 的实际 y 从 `718` 一路排到 `1675`（= 外壳下边界），把剩余空间吃干净。
- 三次滚动全部返回**逐字节相同**的 dump（可见文本 99 条，内容零变化）：
  - `uitest uiInput swipe 1200 1500 1200 800 500`
  - `uitest uiInput swipe 1200 1500 1200 700 900`
  - x=1700 连续 6 次 reveal 滚动（每次都拿到同尺寸 303344 字节 layout）
- 反证（因果坐实，不是"可能"）：用 UI 逐条点"卸载"把 8 个测试装包真卸掉后，已安装剩 3 条（obsidian-outliner、lexi-sample-plugin、calendar），**同一张 sheet 立刻渲染出** `REMOTE=["已安装","分发探针","已签名哈希","安装"]`。卸掉的 8 个 id：cap-probe-unauth、cap-probe-open、market-demo、compat-probe、calendar-beta、obsidian-charts、obsidian-text-format、obsidian-pangu。

**影响**：装上 7–8 个插件之后，用户点不到"安装"按钮 —— 市场功能对重度用户等于不可用。四流程回归也因此只能在"已安装 ≤3 条"的状态下跑。

**为什么不本轮修**：`entry/src/main/ets/components/plugin/LexiPluginMarketSheet.ets` 需要整体重做（分区 + 滚动/虚拟化 + 搜索过滤 + 更新/回滚入口 + capabilities 展示 + sha256 提示 + 卸载确认）。只塞一个 Scroll 是把"第 7 个插件点不到安装"变成"第 20 个照样卡"，不是修复。

**修复验收标准（写死在回归里）**：已安装 8 条时，同一张 sheet 仍能滚到远端索引区块并点中"安装"；`node scripts/tests/plugin-dist-flows.cjs --run --market-repro` 在 N=3..8 各档位都打印 `reachable=true`。

**当前可用的临时手段**：`node scripts/tests/plugin-dist-flows.cjs --run --market-repro`（只打印可达性，不硬断言，也不进 `--ci`）。

---

## KI-2 obsidian-outliner 出现在"已安装"列表里，磁盘上却没有目录

**现象**：点它的"卸载"报 `卸载失败：插件目录不存在: obsidian-outliner`，但它一直显示在已安装区块（v4.10.2）。

**证据**：`hdc shell ls /data/app/el2/100/base/com.lovexjy.lexinote/haps/entry/files/plugins` 的输出里没有 `obsidian-outliner`（同一次实测里只有 calendar、editor-outliner、lexi-sample-plugin 等）；UI 那一行的文本是 `Outliner v4.10.2 obsidian-outliner`。

**状态**：**待定位**。列表来源（enabled 列表 / 注册表 / 缓存）与磁盘扫描不同源，需要单独查"列表为什么保留了已不存在的 id"。本轮只记录，不修。

---

## KI-3 壳层（hdc shell）对应用私有目录无写权限

**现象**：`hdc shell "echo … > …/files/plugins/<id>/data.json"` → `Permission denied`；`hdc file send` 同路径 → `[Fail]Error opening file: permission denied`。目录本身是 777，但 shell 用户仍被挡。

**影响**：回归脚本不能用 shell 预置插件数据。绕法：探针插件自己在 onload 里经 `data.save` 写标记（`scripts/tests/plugin-dist-flows.cjs` 的 `dataBootstrap()`），升级后磁盘上的标记属于哪个版本就是 preserveDataFile 的直接证据。

---

## KI-4 运行时安装的插件"装得上却永不 onload"（生命周期记账缺口）【已修】

**现象**（Round 8 真机，2in1 实例 127.0.0.1:5555，API 26）：市场安装成功（hilog `插件安装完成: dist-flow-probe v1.0.0`），但启用被状态机拒绝：
`插件启动被拒 dist-flow-probe: 非法迁移: discovered → starting`；data.json 未写出，hilog 无 `onload 完成`/`命令注册` 锚点（`.fixtures-out/evidence/20261103-212226/flows/install/hilog.log`）。

**根因**：`scanPluginDir()` 只登记 `this.plugins`，不做生命周期记账；全仓唯一 `markInstalled` 调用点在启动路径 `init()`（`LexiPluginRuntime.ets:765`）。运行时 `installZip→scanPluginDir→enablePlugin` 序列里插件状态恒为隐式 `discovered`，而迁移表只允许 `installed/disabled → starting`（`LexiPluginLifecycleManager.ets:45,47`）。离线 lifecycle 门禁直接驱动 LifecycleManager，绕开了 Runtime 接线，所以 28 步全绿也测不出——典型离线/真机口径差。

**修复**：`scanPluginDir` 对每个成功解析的插件调 `this.lifecycle.markInstalled(...)`（幂等，boot 路径不受影响）；`plugin-dist-regression` §6 加接线断言钉死。

**修复证据**（20261103-213058）：install 全流程 PASS——`onload 完成`、`命令注册 dist-flow-probe:insert-demo-block`、`data.json={"marker":"keep-me-from-1.0.0"}` 全部达成。

**影响面**：这个缺陷影响**所有运行时安装路径**（市场安装与设置页侧载后的即时启用），此前从未在真机上跑通过完整四流程（Round 5/6 设备批次因模拟器 00801005 未闭环）。
