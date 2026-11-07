# example-markdown — Markdown 渲染面示例(P3-007)

演示 LexiNote 插件的 **Markdown 面**:`registerMarkdownCodeBlockProcessor(language, handler)`
(围栏代码块 → 自定义渲染)与 `registerMarkdownPostProcessor(processor)`(阅读视图渲染
产物增量改写,示例把 `<mark>任务:xxx</mark>` 徽标化)。

## 运行轨面与边界(诚实声明)

- `track: legacy (runtime page)` — 清单 `entrypoints.service: "main.js"`。Markdown 渲染
  管线(T3.1)在 runtime 页轨**真实实现**:代码块处理器走 `codeblocks.register` RPC +
  页内注册表;后处理器真委托 `LexiReading` 注册表(稳定顺序 + 失败隔离,handler 带
  令牌身份执行)。
- `sandbox-track: pending (markdown faces = P4-001/P4-005)` — 沙箱轨
  `registerMarkdownCodeBlockProcessor` 为登记桩、`registerMarkdownPostProcessor` 缺席。
  本例因此**不走沙箱轨声明**。
- 依赖运行开关:`lexiPluginLegacyTrack != 'false'`(当前默认 true)。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `registerMarkdownCodeBlockProcessor` | `editor.extensions: "declarative"`(未声明时 `codeblocks.register` 被宿主拒绝) |
| `registerMarkdownPostProcessor` | 无独立 capability(页内注册表,随渲染管线授权语义) |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-markdown
lexi plugin build    examples/example-markdown   # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-markdown
lexi plugin pack     examples/example-markdown
```

门禁:`scripts/tests/plugin-examples.cjs` 对本例跑同一条链并做 onload 行为级 boot 校验
(渲染回调的触发属阅读视图链,设备验收面归 P4-005)。
