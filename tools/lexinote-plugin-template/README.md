# LexiNote 插件模板

面向 LexiNote 的 Obsidian 风格插件模板:TypeScript 源码,build 产物是单个 `main.js`——esbuild 先产出 CommonJS bundle,再由 `lexi plugin build` 包装成自执行 IIFE(`/* lexi-iife:v1 */`,P1-003c/RFC §3.2:宿主运行页不再以 `new Function` 求值原始源码),宿主通过运行时垫片提供 `lexinote` / `obsidian` 模块。

## 快速开始

```bash
npm install
npm run build        # 输出 main.js(esbuild CJS → lexi-iife:v1 自执行包装;与 manifest.json、可选 styles.css 同一目录)
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

## SDK 包(可选,P3-001)

类型与契约快照已随 `@lexinote/plugin-sdk` 发布为可安装包(**Experimental**,M1 出口前不打 Stable)。
离线安装与消费方式:

```bash
cd packages/lexinote-plugin-sdk && npm pack   # → lexinote-plugin-sdk-<version>.tgz(dist 编译产物)
npm install <path>/lexinote-plugin-sdk-<version>.tgz
```

- 常量与助手入口:`main: dist/index.js`(编译产物,非源码 ts)——`API_VERSION` / `SDK_METHODS` / `methodsOf` / `capabilityTags`。
- 运行时类型面仍由模板内 `lexinote.d.ts` 提供;指向 SDK 版本的 tsconfig paths 写法见
  `packages/lexinote-plugin-sdk/README.md`(类型单一真源翻转归 P3-002,本轮模板仍自带副本)。
- 安装+消费已固化进门禁:`scripts/tests/plugin-sdk-contract.cjs` S7(离线 pack→install→require→类型编译)。

## 分发(规划)

`lexinote-releases` 索引仓库将采用与 Obsidian `community-plugins.json` 同构的结构:
`{ id, name, author, description, repo }`,客户端从 GitHub Release 拉取 `manifest.json` / `main.js` / `styles.css`,并按 `versions.json` 解析最低兼容版本。
