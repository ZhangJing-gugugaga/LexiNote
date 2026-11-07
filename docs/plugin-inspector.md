# Plugin Inspector

宿主 `inspectPlugin(pluginId)` 返回每插件观察报告（`LexiPluginInspector`）：
生命周期状态、当前激活、扩展数量、授权状态、能力标签、错误摘要、RPC 拒绝/匿名调用计数。

**隐私边界（§10.3）**：报告不包含 session token、用户笔记内容、其他插件私有数据；
错误摘要截断到 120 字符（完整错误在宿主日志）。

**脱敏红线（§12）**：自由文本字段（错误摘要/账目原因/隔离原因/超时标签）经凭据形状
脱敏——凡「短前缀-长十六进制」凭据形状（`tk-`/`st-`/`dc-` 等宿主铸造形状）一律只剩
尾 6 位（与 `LexiWebRuntime.tokenTail` 同纪律）；RPC 审计只有 method/code/at，
无载荷、无凭据。

## RFC §12 七问 → 数据源 → 报告字段

| # | 问题 | 数据源（宿主只读组装） | 报告字段 |
|---|------|------------------------|----------|
| 1 | 插件为什么启动失败？ | 生命周期账目（`historyOf` 的 starting→failed 行）+ activation.failReason + errorState | `failReason` / `lastFailureAt` / `journal` |
| 2 | 插件请求了什么权限？ | `permissionStore.grantOf`（状态/指纹/时间/版本）+ manifest 能力标签 | `permissionState` / `capabilityTags` / `permissionFingerprint` / `permissionGrantedAt` / `permissionRevokedAt` / `permissionVersion` |
| 3 | 哪个 RPC 被拒绝？ | `rpcDenies` 计数 + `rpcDenyJournal`（method+code+at，与 authz.denied 同点追加） | `rpcDeniedCount` / `rpcDeniedRecent` / `rpcAnonymousCount` |
| 4 | 插件是否超时？ | `rpcTimeouts` 记账（onload/onunload/invoke.* 既有失败出口）+ 账目超时原因 | `timeoutCount` / `lastTimeoutLabel` / `lastTimeoutAt` |
| 5 | 插件占用了多少资源？ | `contextRegistry.aliveCountOf` + extensionRegistry + activationCount + data.json 大小（fs.stat）+ storage.quotaBytes | `contextsAlive` / `extensionCount` / `activationCount` / `storageUsageBytes` / `storageQuotaBytes` |
| 6 | 插件卸载时是否清理完整？ | 账目（onunload-complete）+ 存活上下文/视图会话/扩展残留只读盘点 | `cleanupComplete` / `cleanupLeftovers` |
| 7 | 插件为什么被隔离？ | `record.quarantineReason` + 账目 quarantined 行 | `quarantined` / `quarantineReason` |

`LexiPluginInspector.answersOf(report)` 把七问折成 7 行应答文本（只由已脱敏字段拼装），
设备侧 UI/日志可直接消费。兼容性报告（§12 必备面）：`compatOk` / `minApiVersion` /
`apiCompatLine`（宿主模拟 Obsidian API 线）。
