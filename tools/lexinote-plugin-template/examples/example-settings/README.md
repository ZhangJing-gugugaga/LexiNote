# example-settings — 设置面示例(P3-007)

演示 LexiNote 插件的**声明式设置面**:`addSettingTab(new PluginSettingTab 子类)` +
`getSettingDefinitions()`(声明式定义数组)→ 宿主设置页原生渲染
(toggle / text / slider / dropdown / textarea / heading)→ 值变更写回插件私有
`data.json`。

## 运行轨面与边界(诚实声明)

- `track: legacy (runtime page)` — 清单 `entrypoints.service: "main.js"`。声明式设置链
  在 runtime 页轨**真实实现**:`addSettingTab` → `settings.register` RPC(宿主落账 +
  扩展登记)→ 宿主设置页(`LexiPluginSettingsSheet`)原生渲染 → `writePluginData`
  写回 `data.json`。
- `sandbox-track: pending (settings face = P4-001/P4-005)` — 沙箱轨 `addSettingTab` 为
  登记桩。本例因此**不走沙箱轨声明**。
- **值回推未接通(诚实边界)**:SDK 类型里的 `onSettingsChanged(values)` /
  `setControlValue(key, value)` 是前瞻声明——宿主当前**没有**运行中回推通道。本例不依赖
  回推:设置值真源是 `data.json`,插件在下次 `onload`(重启用/重启)时经 `loadData`
  读回新值;`onSettingsChanged` 在示例里只做防御性实现。
- 依赖运行开关:`lexiPluginLegacyTrack != 'false'`(当前默认 true)。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `addSettingTab` | 无独立 capability(`settings.register` 按 register 类别落账,身份绑定) |
| `addCommand` | `workspace.commands: true` |
| `Notice` | `notifications: true` |
| `loadData`/`saveData`(设置值真源) | `storage`(示例配额 `quotaBytes: 16384`) |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-settings
lexi plugin build    examples/example-settings   # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-settings
lexi plugin pack     examples/example-settings
```

门禁:`scripts/tests/plugin-examples.cjs` 对本例跑同一条链并做 onload 行为级 boot 校验
(getSettingDefinitions 序列化进 settings.register stub;设置页渲染与值写入属宿主
原生面,设备验收归 P4-005)。
