# example-view — 视图面示例(P3-007)

演示 LexiNote 插件的**视图面**:`registerView(type, creator)` + `ItemView` 子类
(`getViewType`/`getDisplayText`/`onOpen`/`onClose`)+ 命令打开叶
(`workspace.getRightLeaf(false).setViewState`)+ 视图内真实 DOM
(`contentEl.createEl/createDiv/empty/setText`、`onClickEvent`)。

## 运行轨面与边界(诚实声明)

- `track: legacy (runtime page)` — 清单 `entrypoints.service: "main.js"`(未声明
  `sandbox:`),经 runtime 页 shim 装载。视图面在该轨是**真实实现**:
  `registerView` → `views.add` RPC(宿主视图注册表 + 扩展登记,`views.remove` 随卸载),
  叶打开时 creator 真实实例化并挂进 DOM(P1-006 身份链覆盖 onOpen)。
- `sandbox-track: pending (view face = P4-001/P4-005)` — 沙箱轨的视图执行面尚未接入
  (`registerView` 为登记桩;`workspace.getRightLeaf().setViewState` 显式拒绝并指明
  view 域归属 P4-005)。本例因此**不走沙箱轨声明**;若强行以沙箱轨装载,视图命令会得到
  宿主的显式失败(不是静默无效果)。
- 依赖运行开关:`lexiPluginLegacyTrack != 'false'`(当前默认 true;ADR-R28-01 默认翻转
  复审通过后此例需随 P4-005 迁沙箱轨)。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `registerView` | `workspace.views: true` |
| `addCommand` | `workspace.commands: true` |
| 视图内 `vault.getMarkdownFiles` | `vault.read: { enabled: true, paths: [] }` |
| 视图内 `Notice` | `notifications: true` |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-view
lexi plugin build    examples/example-view    # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-view
lexi plugin pack     examples/example-view
```

门禁:`scripts/tests/plugin-examples.cjs` 对本例跑同一条链并做 onload 行为级 boot 校验
(注册面 stub:视图 creator 登记不实例化——实例化/挂 DOM 属设备批次 P4-005 的验收面)。
