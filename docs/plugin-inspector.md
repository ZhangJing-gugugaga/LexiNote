# Plugin Inspector

宿主 `inspectPlugin(pluginId)` 返回每插件观察报告（`LexiPluginInspector`）：
生命周期状态、当前激活、扩展数量、授权状态、能力标签、错误摘要、RPC 拒绝/匿名调用计数。

**隐私边界（§10.3）**：报告不包含 session token、用户笔记内容、其他插件私有数据；
错误摘要截断到 120 字符（完整错误在宿主日志）。
