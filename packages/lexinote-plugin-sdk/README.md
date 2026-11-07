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
npm run sync    # tools/sync-sdk.cjs:契约快照 → 本包;本包 types/lexinote.d.ts → 模板生成副本(P3-002:SDK 为类型单一真源)
npm run build   # tools/build-dist.cjs:src → dist(js + d.ts,严格类型检查,错误即红)
npm test        # tests/sdk-smoke.cjs:契约常量与快照对账
```

契约对账门禁:`node scripts/tests/plugin-sdk-contract.cjs`(S1 包结构 / S2 版本锚点三方一致 /
S3 schema 逐字节 / S4 模板 d.ts 副本 == SDK 类型(单一真源对账) / S5 SDK 源码真类型检查 +
注入错误必须红 / S6 冒烟 / S7 dist + npm pack 离线安装消费与消费端类型检查(注入错误必须红) /
S8 版本策略与废弃对账(P6-002:M1 锚点/包级 stability/废弃登记册))。

## 废弃(Deprecation)约定

生命周期与时间线的权威口径在 `rfcs/plugin-api-evolution-rfc.md`(Experimental → Stable →
Deprecated → Removed);SDK 侧的标记约定:

1. **JSDoc 标记形状**(types/lexinote.d.ts 与 src/*.ts 中的废弃 API 必须按此标注):

   ```ts
   /**
    * …原说明…
    * @deprecated LexiNote <弃用发生的版本> — 改用 `<迁移目标>`;移除计划: <major 版本>(见 rfcs/plugin-api-evolution-rfc.md 登记册)。
    */
   ```

   `@deprecated` 后三要素(**版本号 + 迁移目标 + 移除计划**)缺一即标记不完整,
   门禁 sdk-contract S8 的登记册对账会红。

2. **移除政策**:Deprecated 最短保留 2 个 minor 版本或 1 个 major 周期(取更晚者);方法移除
   仅发生在 major 边界,移除前一个 minor 起宿主对被移除方法返回显式错误(fail-visible)。
   包级锚点 `lexinote.stability` 在 M1 出口评审完成前保持 `experimental`(不标 Stable)。

3. **登记册**:每一个 deprecated/removed 方法同步登记进
   `rfcs/plugin-api-evolution-rfc.md` 第 5 节(方法级 status 字段同轮改值,sync-sdk 刷新
   `schema/` 与 `src/contract.ts`);快照与登记册双向对账漂移即红。当前登记册为空
   (本 SDK 尚无任何废弃条目)。

## 许可

GPL-3.0(随宿主仓库)。
