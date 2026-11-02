# LexiNote 阅读视图渲染内核（reading bundle）

离线渲染内核：把 markdown-it 打成单文件 bundle，产出 `window.LexiReading`，供「工作区容器」阅读视图后续接线使用。
**本里程碑不接线**：没有修改任何 `entry/src/main/ets/**`、`lexinote_workspace.*`、`lexinote_plugin_shim.js`、`lexinote_plugin_view_shim.js`、`lexinote_theme.*`。

## 产物

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `tools/reading-bundle/bundles/reading.js` | 140897 | `dd27c8a26cec71c85c1a679bd065234cfd7372233fa6e0ace78ef5c6c6a075dc` |
| `entry/src/main/resources/rawfile/lexinote_reading.js` | 140897 | `dd27c8a26cec71c85c1a679bd065234cfd7372233fa6e0ace78ef5c6c6a075dc` |
| `entry/src/main/resources/rawfile/lexinote_reading.css` | 2392 | `8300e0465afd898cd7a048e15d5e2bd75b293d6cd065a9d14b2b91e1a313ecd3` |

gzip 后 bundle 为 57281 字节。上限 150KB（gzip 前），实际 137.6KB。

```
node tools/reading-bundle/build.mjs        # 构建 + 复制到 rawfile，打印字节/sha256
node scripts/tests/reading-render.cjs      # 离线门禁：jsdom 真渲染 + 真跑 postprocessor
```

`build.mjs` 是确定性的：同样的源码连跑两次，`sha256(bundles/reading.js)` 恒为 `dd27c8a2…6f88dc`。改源码后必须更新上表的 sha。

## 依赖（版本钉死，不用 `^`）

- `markdown-it@14.1.0`、`markdown-it-footnote@4.0.0`、`markdown-it-task-lists@2.1.1`
- `esbuild@0.28.2`（构建）、`jsdom@27.4.0`（门禁用，装在 `tools/reading-bundle/node_modules`）

任务列表 checkbox、表格、代码围栏、脚注全部由 markdown-it 原生或官方插件产出，没有任何正则替换式伪渲染。

## API 契约（`window.LexiReading`）

```js
window.LexiReading = {
  version: '0.1.0',
  render(markdown, { sourcePath, frontmatter }) -> { html, sections },
  applyPostProcessors(el, ctx),
  rerenderSection(index, source),
  registerPostProcessor(handler, sortOrder)
}
```

### `render(markdown, opts)`

输入：
- `markdown: string` — 整篇 Markdown 源文，可含 `---` 包裹的 frontmatter 头块。
- `opts: { sourcePath?: string, frontmatter?: object }` — `sourcePath` 原样进入后处理器 ctx；`opts.frontmatter` 与解析出的 frontmatter 合并（调用方传入的键优先，用于宿主侧已有元数据）。

输出：
- `html: string` — 整个容器的 `outerHTML`（以 `.markdown-preview-view` 起）。
- `sections: Section[]` — 每个 section 一项，见下。
- 另外附带 `containerEl`（容器元素，可直接 append 到宿主）与 `frontmatter`（解析出的对象）。

DOM 骨架严格是：

```
.markdown-preview-view
  .markdown-preview-sizer
    .markdown-rendered
      .markdown-preview-section[data-heading-level][data-line-start][data-line-end][data-render-count]
      .markdown-preview-section[…]
```

每个 section 自成 `.markdown-preview-section`：从某个标题开始，到下一个标题之前结束；首个标题之前的正文是 `data-heading-level` 为 0 的 preamble section（有内容才生成）。`renderCount` 记录该 section 被渲染的次数，用于增量验收。
### `Section`

```js
{
  index, level,            // level: 0=preamble, 2=h2, 3=h3 …
  heading,                 // 标题纯文本，preamble 为 ''
  el,                      // 该 section 的 DOM 元素（已挂 Obsidian 风格助手方法）
  lineStart, lineEnd,      // 相对「剥离 frontmatter 后」的源文行号
  renderCount,
  source,                  // 该 section 的 Markdown 原文
  getSectionInfo()         // -> { text, lineStart, lineEnd }
}
```

元素上可用的助手方法（Obsidian 兼容子集）：`find(sel)`、`findAll(sel)`、`createEl(tag, opts)`、`createDiv(opts)`、`createSpan(opts)`、`empty()`、`addClass` / `removeClass` / `hasClass`、`setAttr` / `getAttr`、`appendText`。`findAll` 返回真数组。

### `registerPostProcessor(handler, sortOrder)`

- `handler(el, ctx)` 或 `handler(el, ctx, section)`，可以返回 Promise（会 await）。
- `sortOrder: number`，升序执行，默认 0，同序按注册顺序。
- 返回一个注销函数 `() => void`。
- `ctx = { el, sourcePath, frontmatter, getSectionInfo() }`：`el` 是容器元素，`getSectionInfo()` 返回「`el` 所属 section」的信息（`el` 不带 section 归属时返回 null）。
- 单个 handler 抛错不会中断其余 handler，错误收集在 `applyPostProcessors` 的返回值 `{ errors: [{ handler, error }] }` 里。

### `applyPostProcessors(el, ctx)`

对 `el` 所属的 section 依次执行全部已注册 handler（await 完成）。`ctx` 可省略，缺省由 section 补齐 `sourcePath` / `frontmatter` / `getSectionInfo`。

### `rerenderSection(index, source)`

**真增量**：只重解析 `source`（必须恰好切出 1 个 section，否则抛 `expected exactly one section, got N`），复用同一个 section 对象与同一个 DOM 元素（节点引用不变），只替换该 section 的 `innerHTML`、更新 `renderCount`（+1）与 `data-line-*`，然后只对该 section 重跑后处理器。其余 section 的节点与渲染计数完全不动。

`source` 是新 section 的完整 Markdown（含它自己的标题行）；因为 `source` 变了，`lineStart/lineEnd` 是相对这份新文本的行号，宿主若需要绝对行号要自己加偏移。

## frontmatter

`---` 头块被剥离为对象返回，不进 HTML 正文。支持扁平标量（字符串 / 引号字符串 / 布尔 / null / 数字）、行内 `[a, b]` 列表，以及 `key:` 换行接 `- item` 的块列表；嵌套映射、多行块标量、锚点别名不在支持范围（会退化成字符串）。剥离时把 frontmatter 区域替换成等量空行，因此正文行号与原文一致。

## 已知边界（未证明 / 不支持）

- 没有在 ArkWeb 里跑过：全部验证只在 Node + jsdom 中完成，Web 引擎差异（`innerHTML` 解析、事件模型）未验证。
- 没有接线：阅读视图、CodeMirror6 联动、滚动同步、主题变量（`lexinote_theme.*`）都没有接。
- `markdown-it` 配置为 `html: true`：笔记里的内嵌 HTML 会原样进 DOM 并可执行脚本，接线方必须自行做可信度判断或改配置。
- `markdown-it-footnote` 的脚注块由最后一段 section 承载（不在文档末尾单独建容器）。
- 没有 wiki-link / embed / callout 规则，`[[...]]` 按普通文本渲染。
- 没有性能数据：大文档（数千行、上百 section）的渲染与重渲染耗时未测量。
- 没有跑真实 obsidian-tasks / Dataview：门禁里的 postprocessor 是 tasks 风格的等价实现，不是插件本体。

## 门禁

`scripts/tests/reading-render.cjs` 在 jsdom 里 `window.eval` **已发布**的 `rawfile/lexinote_reading.js`（不是源码），27 条断言逐条打印 PASS/FAIL，失败时打印「期望/实际」，任一失败则 `process.exitCode = 1`。覆盖：标题层级与 `data-heading-level`、无序/有序列表、任务列表与 checkbox、代码围栏语言类名、表格、链接、行内代码、加粗斜体、引用块、frontmatter 剥离、section 切分、postprocessor 调用与注入、回写回调收到的源文本、section 级增量重渲染（第 1/3 段节点与计数不变，第 2 段 +1）。
