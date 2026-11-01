# LexiNote 插件模板

面向 LexiNote 的 Obsidian 风格插件模板:TypeScript 源码,build 产物是单个 `main.js`(CommonJS),宿主通过运行时垫片提供 `lexinote` / `obsidian` 模块。

## 快速开始

```bash
npm install
npm run build        # 输出 main.js(与 manifest.json、可选 styles.css 同一目录)
```

把以下文件放进设备插件目录(LexiNote 设置 → 插件 可知目录),重启或重新启用插件:

```
<lexinote 沙箱>/plugins/<your-plugin-id>/
  manifest.json
  main.js
  styles.css   (可选)
  data.json    (运行时自动生成)
```

## 模板包含的示例

- `addCommand` 普通命令(读 Vault)
- `addCommand` + `editorCallback` 编辑器命令(改写选区)
- `registerView` + `ItemView` 自定义面板(ArkWeb 槽位内真实 DOM,`styles.css` 生效)
- `vault.on('modify')` 事件订阅
- `loadData/saveData` 持久化

## 契约

- 类型声明:`lexinote.d.ts`(tsconfig 中把 `lexinote`/`obsidian` 都映射到这里)
- 只声明**已实现**的 API;未实现项(Modal/Menu/Suggest/Setting builder/代码块处理器/Bases/CM6 扩展)不声明,导入即类型报错,运行时也不保证。
- Editor API 为 v1:单选区、偏移模型;读方法同步(快照),写方法返回 Promise。

## 分发(规划)

`lexinote-releases` 索引仓库将采用与 Obsidian `community-plugins.json` 同构的结构:
`{ id, name, author, description, repo }`,客户端从 GitHub Release 拉取 `manifest.json` / `main.js` / `styles.css`,并按 `versions.json` 解析最低兼容版本。
