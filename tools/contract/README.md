# tools/contract —— 契约矩阵（官方 obsidian API vs 本项目实现）

以官方 `obsidian@1.14.4` 的 `obsidian.d.ts` 为唯一契约基线，逐符号登记本项目的实现状态与缺口性质，
供 PR review、排期与 CI 门禁使用。权威约束见 `docs/lexinote_plugin_bridge_spec.md` 第 7 节。

## 文件

| 文件 | 作用 |
| --- | --- |
| `symbols.json` | 派生产物（入库）：每个 d.ts 符号一行状态。符号按字典序、字段序固定，重跑无 diff。 |
| `generate.cjs` | 生成/刷新 `symbols.json`；内含逐符号定级 `OVERRIDES`、缺口覆盖 `GAPS`、家族规则 `RULES`。 |
| `report.cjs` | P4-006：`symbols.json` → `compat-matrix.md` 兼容性矩阵文档（unsupported/stub/partial/implemented 分节全量表）。逐字节可再生：无时间戳、字典序、固定节序，双重渲染自检。 |
| `compat-matrix.md` | 派生产物（入库）：由 `report.cjs` 渲染的矩阵文档。改了 `symbols.json` 必须重跑 `node tools/contract/report.cjs`，否则门禁漂移检查红灯。 |
| `../scripts/tests/plugin-contract-matrix.cjs` | 门禁：矩阵与 d.ts 对账 + 格式/schema/gap/证据校验 + 报告漂移检测。 |

`obsidian.d.ts` **不入库**（官方版权文件，只作为生成时的输入）。

## 用法

```bash
# 拉取契约基线（一次性，约 1.5 MB）
mkdir -p /tmp/obs && cd /tmp/obs && npm pack obsidian@1.14.4 && tar -xzf obsidian-1.14.4.tgz
# → /tmp/obs/package/obsidian.d.ts（Windows 下 /tmp 解析到当前盘根的 tmp）

node tools/contract/generate.cjs                    # 重写 symbols.json 并打印 status/gap 分布
node tools/contract/report.cjs                      # 重写 compat-matrix.md（symbols.json 变了必跑，漂移即门禁红）
node tools/contract/report.cjs --check              # 报告与矩阵逐字节比对（门禁内置同一检查）
node scripts/tests/plugin-contract-matrix.cjs       # 门禁 check（CI 用）
node scripts/tests/plugin-contract-matrix.cjs --generate   # 等价于生成
node scripts/tests/plugin-contract-matrix.cjs --fixtures-required   # CI 夹具 job：夹具侧引用必须真校验（跳过=失败）
```

d.ts 查找顺序：`$LEXINOTE_OBSIDIAN_DTS` → `tools/contract/.obsidian/obsidian.d.ts` →
`/tmp/obs/package/obsidian.d.ts` → `C:/tmp/obs/package/obsidian.d.ts`。
找不到时生成器直接退出 1 并打印拉取命令，不会静默产出空矩阵。

## symbols.json 格式

```json
{
  "generatedFrom": "obsidian@1.14.4",
  "symbols": [
    { "symbol": "Plugin", "kind": "class", "status": "implemented", "owner": "运行时轨", "note": "…证据 H:commands.add W:PluginShim", "gap": null },
    { "symbol": "parseLinktext", "kind": "function", "status": "unsupported", "owner": "运行时轨", "note": "纯工具未导出…", "gap": "low-risk" }
  ]
}
```

- `symbol`：d.ts 顶层导出名，或 `declare global` 里的原型/DOM 补丁名（按名字去重）。
- `kind`：`abstract class|class|interface|function|const|let|var|enum|type`。
- `status`：见下表。
- `owner`：`运行时轨` / `宿主轨` / `分发轨` / `未排期`（对应 spec 第 1 节的文件归属）。
- `note`：一句话说清"到哪一步、缺什么 / 谁来补"。必填，禁止空注。
- `gap`：缺口性质（决定排期），见下节。字段顺序固定为 symbol→kind→status→owner→note→gap。

### status 语义

| status | 含义 | 例子 |
| --- | --- | --- |
| `implemented` | 官方签名上的主要用途可用，插件按文档写就能跑通 | `Plugin`、`TFile`、`Component` |
| `partial` | 主路径通，但有明确缺失点（缺成员、返回值语义不同、只支持部分参数） | `Vault`（缺 createBinary/getName）、`moment`（MiniMoment 子集） |
| `stub` | 有导出、能构造，但内部空转或只打日志，插件以为成功实则无效果 | `Modal.open` 只发 `ui.placeholder`、`MarkdownRenderer.render` reject |
| `unsupported` | 完全没导出或明确不做；插件调用会 `TypeError` 或走 `undefined` | `createSvg`、`requireApiVersion` |

### gap 语义（缺口性质）

不是装饰：status 说"差多少"，gap 说"补起来是什么性质的工作量"，排期看它。

| gap | 判定标准 | 典型 |
| --- | --- | --- |
| `low-risk` | 在现有通道/现有 shim 内可补齐：不动协议、不动宿主架构。纯字符串/YAML/编解码/小工具、缺字段回填、语义微调、补一个 `registerHandler` 或一个 DOM 补丁 | `parseLinktext`、`stripHeading`、`getLinkpath`、`arrayBufferToBase64`、`isBoolean`、`ready`、`nextFrame`、`createSvg`、`requireApiVersion` |
| `needs-architecture` | 需要新的能力面或改宿主架构：CM6 编辑器扩展、Settings 2.0 分组分页、多 pane 布局、Bases 值系统、宿主 DOM 组件库、解析器扩展、键位体系、tooltip 机制、完整 moment 打包 | `Editor.undo/exec`、`SuggestModal`、`SettingGroup`、`MetadataCache.blocks` |
| `out-of-scope` | 本轮明确不做，或平台不存在（spec 第 9 节） | `Bases*`、`*Value`（Bases 公式）、`CliFlag`、`DataAdapter`/`FileSystemAdapter`、`Tasks` |
| `null` | 仅 `status=implemented` 允许，且必须为 `null` | — |

判不出来时一律 `needs-architecture` 并在 `note` 里写明待定——宁可高估，不要把一个架构级缺口记成低风险。

### 证据标记（`implemented` 必填）

note 里用两种标记指向真实实现，门禁会逐个核对：

- `H:<通道名>`：必须存在于宿主 `registerHandler('…')` 表（扫描 `entry/src/main/ets/**`）。
- `W:<名字>`：必须存在于 shim 实现索引（`lexinote_plugin_shim.js` / `lexinote_plugin_view_shim.js`
  里的 `function X`、`var X =`、`.X = function`、`X: function`，以及导出面的对象键
  `X: IDENT,` / `X: {`，例如 `apiVersion: API_VERSION`、`Keymap: { ... }`）。

`implemented` 条目必须至少命中一个；`partial`/`stub` 必须至少带一个，且**引用的每个 H:/W: 都要能解析**。
写了却查不到，门禁直接红——这是"别拿自我声明当实现、别让 note 说假话"的防线。

### 策略符号与覆盖清单（spec 第 12 节）

`partial` 是**当下快照**，不是稳定契约——这一轮 shim 实现索引从 567 涨到 741 就是活证。
因此有 6 个符号被列进 `generate.cjs` 的 `NOTE_POLICY`：`moment`、`App`、`Workspace`、
`Vault`、`MetadataCache`、`MarkdownView`。它们的 note 形状固定：

```
[截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）。散文照写…证据 W:MiniMoment W:moment
members: format, add, subtract, startOf, endOf, diff, unix, calendar, localeData, isoWeekday, daysInMonth
members(excludes): tz, duration, fromNow, toNow, toJSON
```

- 名单**显式声明**在 `generate.cjs` 的 `NOTE_POLICY`，禁止用"逗号多就算清单型"之类的启发式；
  加符号就加到这张表并补清单。
- `members:` 是"已实现且被真实验证过"的条目名，逐项过门禁（查实现索引）；写名字就是承诺。
- `members(excludes):` 是"明确不支持"的记录，门禁只计数不判失败——把"不做"写清楚比留空更有用。
- 时效头里的日期与 commit7 是**手工快照**（生成器不自动盖戳，否则每次提交都改矩阵、重跑必 diff）。
  改了实现或装了新插件后要重跑生成器前，先核对这 6 条 note 的时效是否还成立。

### 行为证据引用（spec 第 12 节）

散文里说"某某插件用了它"不算证据，必须给出**可核对的行号**，门禁会真的去读那一行：

```
repo 文件：entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:1054（`workspace.onLayoutReady`）
夹具文件：fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:50（`element.findAll`）
```

- `<相对仓库根的路径>:<行号>` 后面必须紧跟全角括号包住的反引号标识符；门禁读那一行，不含该标识符即红
  （"note 与代码脱节"）。文件不存在、行号越界同样红。
- 夹具是下载缓存（`.fixtures-out/.cache/<夹具名>/`，不入库），路径以 `fixture:` 开头、夹具内相对路径
  相对 `<夹具>/src/`；夹具未就位时计入"跳过"不算失败（`$LEXINOTE_FIXTURES` 可覆盖根目录）。
- 只是随口提到某个行号时别写成 `path:line` 形状（例如"第 94 行是文档注释"），否则门禁会要求你补标识符。
- 每条红都跟一行可直接照抄的替换：`↳ 改成 <路径>:<真实行号>（`标识符`）`——门禁在那文件里 grep 该标识符，
  最多 3 个候选，且**优先给代码行**（只出现在注释里的行会把 note 指向一句注释，已过滤）。刷 note 是照抄，不是排查。
- 夹具侧引用**永远显式打印跳过度**：`fixture citations skipped: N (must be 0 in fixtures job)`。
  CI 的夹具 job（plugin-fixtures-stage 之后）必须带 `--fixtures-required`：跳过即红并逐处点名。
  跳过可以是流程属性（本地没装夹具），但不能是隐形属性（CI 里假装绿）。

## 门禁检查什么

`node scripts/tests/plugin-contract-matrix.cjs`（无参数 = check）：

1. `generatedFrom` 是否仍为 `obsidian@1.14.4`；
2. d.ts 的符号是否 100% 有条目（漏登记）、矩阵是否有多余符号（d.ts 已删）；
3. 重复符号、符号未按字典序（保证重跑无 diff）；
4. `status`/`owner`/`kind` 合法，`note` 非空；
5. `gap` 存在且只取三值枚举（或 `null`）；
6. `status=implemented` ⇒ `gap` 必须 `null`；`status≠implemented` ⇒ `gap` 必须非 `null`；
7. `status=implemented` 的 note 证据能否落到真实实现（见上）；
8. `status=partial|stub` 的 note 必须带证据，且不能出现"查无实现"的悬空 `H:`/`W:` 标记
   （注解说"某能力已通"却指向不存在的处理器，比缺条目更危险）；
9. `apiVersion` 只能来自宿主注入的 `API_VERSION` 常量：扫 `rawfile/**/*shim.js` 里的
   `apiVersion: <值>`，值不是 `*API_VERSION` 标识符即红灯（spec 第 11 节：两个 Web 上下文
   各报一个版本会让 `requireApiVersion` 结论随上下文漂移）；
10. 策略符号（`NOTE_POLICY`）的 note 必须带时效头 `[截至 YYYY-MM-DD @ <commit7>]` 与
    「覆盖插件:」清单，并给出 `members:` / `members(excludes):` 两行（spec 第 12 节）；
11. `members:` 里的每个名字都必须能在实现索引（宿主处理器 ∪ shim 实现）里查到，否则红灯
    "覆盖清单与实现脱节"；`members(excludes):` 只记录"明确不支持"，不判失败；
    `generate.cjs` 的 `NOTE_POLICY` 与门禁里的镜像表不一致也红灯（防止悄悄少校验一个符号）；
12. note 里出现的每个「`路径:行号`（`标识符`）」都真实存在、且那一行确实含该标识符；夹具路径以
    `fixture:` 打头，未就位时跳过（spec 第 12 节：note 不许与代码脱节）。
13. 兼容性报告（P4-006）：`compat-matrix.md` 必须等于 `symbols.json` 的新鲜渲染——改了矩阵不重跑
    `node tools/contract/report.cjs` 即红；且渲染器同一输入渲染两次必须逐字节相同（无时间戳、无遍历序
    等非确定源，"报告与契约逐字节可再生"）。

任一条不满足 → 打印差异清单并 `exit 1`（每类最多列 20 条，超出只报总数）。
全绿 → `exit 0`，并打印 status 分布、gap 分布与实现面索引规模。

## 加/改一个映射

判定顺序（先具体后笼统，越靠前越优先）：

1. `GAPS`：逐符号的 gap 覆盖，只写与家族规则结论不同的条目；
2. `OVERRIDES`：逐符号的 status/owner/note 特例；
3. `RULES`：家族规则（正则），按数组顺序**首命中**生效，规则自带 status/owner/note/gap；
4. 兜底：`unsupported` + `needs-architecture`，并在生成时打印"未命中映射规则"要求逐条确认。

流程：

1. 新符号先跑 `node tools/contract/generate.cjs`。若末尾出现"⚠ 未命中映射规则"或
   "⚠ 非 implemented 缺 gap"，说明该符号没被覆盖，已兜底，必须补定级。
2. 单符号特例写 `OVERRIDES` + `GAPS`；同类家族加 `RULES`（记得同时给 `gap`）。
3. 重新生成 → 跑门禁 → 两者都绿再提 PR。

**不要机械按家族一刀切**：同一家族里"明确不做"与"可补"混在一起时逐符号判（例如 `Tasks` 是
`out-of-scope`，同族的其它符号未必如此）；`GAPS` 里已删除符号的残留条目会在生成时被点名清理。

## 当前快照（`obsidian@1.14.4`，334 个符号）

- `status`：implemented 32 / partial 68 / stub 19 / unsupported 215
- `gap`：low-risk 70 / needs-architecture 173 / out-of-scope 59 / null 32
- 实现面索引：宿主处理器 53 条、shim 实现 741 个名字
- 策略符号：6 条（members 63 项 / excludes 32 项），时效头 `[截至 2026-11-01 @ 48f164a]`
- 行为证据引用：18 处（仓库 8 处 / 夹具 10 处），覆盖 obsidian-calendar-plugin、obsidian-tasks、lexi-sample-plugin
- `apiVersion` 站点：3 处，全部走 `API_VERSION` 常量（`lexinote_plugin_shim.js:2034`、`:2128`、
  `lexinote_plugin_view_shim.js:805`），门禁绿
- 符号集合口径：d.ts 顶层 export 声明 301 个 + `declare global` 补丁按名去重 33 个 = 334。
  （37 条补丁声明里 `Node`×2、`Element`×2、`HTMLElement`×3，去重后 33。）
