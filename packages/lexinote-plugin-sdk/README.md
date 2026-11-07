# @lexinote/plugin-sdk

LexiNote 插件 SDK——插件作者的**类型面 + 契约快照 + 能力标签助手**。运行时实现全部由宿主提供
(`require('obsidian')` / `import ... from 'lexinote'` 命名空间,RFC §10.1),本包不含运行时代码。

## 状态:Experimental

**本包当前为实验性(experimental),不是 Stable。** API 版本锚点 `1.0.0` 与宿主
`PLUGIN_API_VERSION`、shim `API_VERSION` 三方一致(门禁
`scripts/tests/plugin-sdk-contract.cjs` S2 对账),但在宿主 API 冻结(M1 出口)之前,
类型面与方法集仍可能变动,不另行通知。方法级状态见 `schema/api-surface.json`
的 `status` 字段(stable/experimental/deprecated)。

## 包内容(发布物,`npm pack` 产物)

| 目录 | 内容 | 入口 |
|---|---|---|
| `dist/` | 编译产物(CommonJS js + d.ts)——**包入口在这里**,不是源码 ts | `main: dist/index.js`,`types: dist/index.d.ts` |
| `src/` | TS 源码(参考用;`contract.ts` 由生成器产出勿手改) | `src/index.ts` |
| `types/` | `lexinote.d.ts`——`lexinote`/`obsidian` 双别名的完整 API 类型面 | tsconfig paths 映射(见下) |
| `schema/` | 契约快照五份(api-surface / api-version / capability-map / manifest-v2.schema / codemirror-versions),与宿主 `tools/plugin-contract` 逐字节一致 | — |

## 安装(离线可用)

```bash
# 有 registry 时
npm install @lexinote/plugin-sdk

# 离线(仓库内构建 tarball)
cd packages/lexinote-plugin-sdk
npm pack                       # → lexinote-plugin-sdk-1.0.0.tgz(prepack 自动先跑 npm run build)
npm install /path/to/lexinote-plugin-sdk-1.0.0.tgz
```

安装后 `node_modules/@lexinote/plugin-sdk/` 内含 `dist/`(入口)、`types/`、`schema/`。

## 使用

插件运行时类型(`lexinote` / `obsidian`)来自 `types/lexinote.d.ts`,在项目 tsconfig 中映射:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "lexinote": ["node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts"],
      "obsidian": ["node_modules/@lexinote/plugin-sdk/types/lexinote.d.ts"]
    }
  }
}
```

```ts
import { Plugin, Notice } from 'lexinote';                       // 运行时由宿主垫片提供
import { API_VERSION, capabilityTags, methodsOf } from '@lexinote/plugin-sdk'; // 编译期常量与助手

const tags: string[] = capabilityTags({          // manifest v2 capabilities → 授权标签
  vault: { write: true },
  network: ['https://api.example.com']
});                                              // → ['clipboard'?..] 排序后 ['network:api.example.com', 'vault.write']
const vaultMethods = methodsOf('vault');         // 该域全部契约方法
```

## 开发命令(仓库内)

```bash
npm run sync    # tools/sync-sdk.cjs:宿主契约快照/类型面 → 本包(单一真源方向暂为模板→SDK,P3-002 翻转)
npm run build   # tools/build-dist.cjs:src → dist(js + d.ts,严格类型检查,错误即红)
npm test        # tests/sdk-smoke.cjs:契约常量与快照对账
```

契约对账门禁:`node scripts/tests/plugin-sdk-contract.cjs`(S1 包结构 / S2 版本锚点三方一致 /
S3 schema 逐字节 / S4 类型面 == 模板 d.ts / S5 类型检查 / S6 冒烟 / S7 dist + npm pack 离线安装消费)。

## 许可

GPL-3.0(随宿主仓库)。
