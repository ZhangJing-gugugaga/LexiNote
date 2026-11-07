# example-commands — 命令面示例(P3-007)

演示 LexiNote 插件的**命令面**:普通命令(`callback`)、编辑器命令(`editorCallback`)、
通知(`Notice`)与插件私有持久化(`loadData`/`saveData` → 插件目录 `data.json`)。

## 运行轨面与边界(诚实声明)

- `track: sandbox` — 清单声明 `entrypoints.service: "sandbox:"`,沙箱轨(opaque-origin
  iframe)可装载;legacy 轨(默认开启)同样可装载。
- `faces: all-real` — 本例用到的每一个 API 面在沙箱轨均已实现:
  `addCommand(callback)`、`addCommand(editorCallback)`、`Notice`、`loadData`、`saveData`。
- 编辑器命令的执行面:宿主按 manifest `editor` 档位(`readActive`/`writeSelection`)脱敏后
  把编辑器快照回推 iframe,`editor.replaceSelection` 返回 Promise(写方法经
  `editor.applyChanges`/`editor.replace` 门禁)。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `addCommand` | `workspace.commands: true` |
| `editorCallback` 执行 | `editor.readActive` + `editor.writeSelection` |
| `Notice` | `notifications: true` |
| `loadData`/`saveData` | `storage`(示例配额 `quotaBytes: 16384`) |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-commands   # 宿主同一 v2 解析器
lexi plugin build    examples/example-commands   # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-commands   # 入口 sha256 + iife 标记 + 授权标签
lexi plugin pack     examples/example-commands   # zip + sha256
```

门禁:`scripts/tests/plugin-examples.cjs`(release-gate --ci 内)对本例跑同一条链并
断言 IIFE 产物与沙箱轨表面(自宿主 `lexinote_plugin_sandbox.html` 提取的面清单)一致。
