# LexiNote 插件示例工程组(P3-007)

五类各一例,与 `tools/lexinote-plugin-template/` 同构建链(esbuild CJS → `lexi plugin build`
IIFE)。每例只用**真实已实现**的 API 面;未接入的轨面在各自 README「运行轨面与边界」中如实
标注(不假造)。离线门禁:`scripts/tests/plugin-examples.cjs`(release-gate --ci 步骤之一)
对每例跑真实 CLI 链 `validate → build → inspect → pack` 并断言 IIFE 产物。

| 示例 | 类别 | 装载轨 | 沙箱轨 |
| --- | --- | --- | --- |
| `example-commands` | 命令(callback + editorCallback) | `sandbox:` 可装载 | ✅ 面全实现 |
| `example-vault` | Vault 读写 + 路径白名单 | `sandbox:` 可装载 | ✅ 面全实现 |
| `example-view` | registerView + ItemView 面板 | runtime 页(legacy) | ⛔ pending(P4-001/P4-005) |
| `example-markdown` | 代码块处理器 + 后处理器 | runtime 页(legacy) | ⛔ pending(P4-001/P4-005) |
| `example-settings` | 声明式设置页 + data.json 值链 | runtime 页(legacy) | ⛔ pending(P4-001/P4-005) |

runtime 页(legacy)示例依赖运行开关 `lexiPluginLegacyTrack != 'false'`(当前默认 true);
沙箱轨视图/Markdown/设置执行面随 P4-001/P4-005 接入后迁移。
