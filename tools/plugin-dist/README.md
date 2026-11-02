# 插件分发轨：门禁与产物

第三方插件夹具（calendar / editor-outliner / theme-minimal 等）是**构建输入**，不是产品。
它们通过 rawfile/plugins/<id>/ 进 HAP，所以 release 产物里一个都不许留。

## release-gate.cjs

```
node tools/plugin-dist/release-gate.cjs                    # 扫已构建的 HAP + 资源目录（默认，CI 前的体检）
node tools/plugin-dist/release-gate.cjs --ci               # CI 入口：见下
node tools/plugin-dist/release-gate.cjs --hap <f.hap> --dir <dir> --json <out.json>
node tools/plugin-dist/release-gate.cjs --strip            # 预演：会移走哪些条目
node tools/plugin-dist/release-gate.cjs --strip --apply    # 在 HAP 旁写 <name>.stripped.hap
node tools/plugin-dist/release-gate.cjs --strip --strip-staging --apply   # 同时把资源目录里未获许可的插件目录
                                                           # 移进 .fixtures-out/strip-trash/<ts>/（可逆）
```

判定规则是 **deny-by-default**：`ALLOWED_SHIPPING`（当前只有 `lexi-sample-plugin`）之外的一切
`rawfile/plugins/<dir>` 都是违规。加新插件随包发布 = 显式改这一行，不能靠"没进黑名单"混过去。

退出码：

| 场景 | 0 | 1 |
|---|---|---|
| 默认 | 无违规 | 有违规（含资源目录里的夹具） |
| `--strip`（预演） | 没什么可移 | 有东西会/该被移走 |
| `--strip --apply` | **剥离产物**复检 0 处违规 | 剥离产物仍有违规 / 没产出剥离副本 |

`--strip --apply` 的结论以**写出来的 `*.stripped.hap`** 为准（写完立刻重扫），源包的违规数只是信息行——
否则"剥离成功"和"剥离失败"共用同一个退出码，红灯会被无视。

## 资源目录的两个分类

默认模式会扫 `entry/src/main/resources/rawfile/plugins/`，并分两类打印：

- `已知夹具(已 gitignore): N 处` — 被 `.gitignore` 覆盖，属于正常的测试夹具，预期会红；
- `未登记目录(未 ignore): M 处` — 既不在 `ALLOWED_SHIPPING`、也没进 `.gitignore`。这是**准事故**
  （有人把插件塞进了随包资源树，而且 git 里根本看不到），会单独一行点名，并让结论带上更严重的理由。

判别用 `git check-ignore`（fail-closed：查不到 git 就按"未登记"算）。

## CI 顺序（`--ci`）

夹具是别的门禁的输入，剥离会打断它们，所以顺序不能靠人记。`node tools/plugin-dist/release-gate.cjs --ci`
把顺序写死在代码里，每一步都打印名字与结论，任一环节红即 exit 1：

1. **stage 分类** — 未登记目录必须为 0（已知夹具多少无所谓）。
2. **依赖夹具的门禁** — `plugin-channel-audit` / `plugin-contract-matrix` / `plugin-dist-audit --all` /
   `plugin-dist-regression` / `plugin-market-regression`，逐个跑、逐个报 exit。
   仓库里没有夹具时这一步会红，那是在提示先跑 `plugin-fixtures-fetch` + `plugin-fixtures-stage`。
3. **release 产物剥离自检** — 把每个已构建 HAP 复制到临时目录、strip 一份、重扫，必须 0 处违规。

没装 TypeScript 时 `--ci` 会提示设置 `LEXI_TYPESCRIPT`（指向 hvigor 自带的
`node_modules/typescript`），否则 dist-regression / market-regression 只能去 require 各自默认路径。

人工顺序（等价）：

```
node scripts/tests/plugin-fixtures-fetch.cjs && node scripts/tests/plugin-fixtures-stage.cjs
node tools/plugin-dist/release-gate.cjs --ci      # 含所有离线门禁 + 剥离自检
hvigorw assembleHap --no-daemon
node tools/plugin-dist/release-gate.cjs           # 此时应只剩"已知夹具"的红，不含任何未登记目录
node tools/plugin-dist/release-gate.cjs --strip --apply
```

## 其他工具

- `market-index-v1.schema.json` + `market-index-v1.cjs` — 市场索引 v1 的唯一实现，导出侧
  （`export-market-index.cjs`）与客户端解析共用它。
- `deprecate-zcode-market.cjs` — 把旧的 ZCode `exports/cdn-market.json` 包成显式 deprecated。
- `zip-store.cjs` — 确定性 zip 读写（回归用它造包、release-gate 用它剥离）。
- `samples/malicious-plugin/` — `plugin-dist-audit.cjs --all` 的恶意对照样本（必须 critical）。
## 受控剥离七步（发版前的可回滚序列）

目标：交付一份**不含夹具**的 release 产物，并证明剥离之后的门禁语义。

| 步 | 命令 | 期望 |
| --- | --- | --- |
| 0 | `node tools/plugin-dist/release-gate.cjs` | 红：HAP 里 12 处 + 资源目录 5 处（共 17），这就是要修的东西 |
| 1 | `node tools/plugin-dist/release-gate.cjs --strip-staging --apply` | 把 `rawfile/plugins/{calendar,editor-outliner,compat-probe,cap-probe-open,cap-probe-unauth}` 移进 `.fixtures-out/strip-trash/<ts>/`；输出「资源目录: …」逐条点名。**不需要 `--strip`**；此时 exit 1 是预期（磁盘上的旧 HAP 里还有 12 处） |
| 2 | `hvigorw assembleHap --no-daemon` | BUILD SUCCESSFUL；新 HAP 已不含夹具条目 |
| 3 | `node tools/plugin-dist/release-gate.cjs --hap <新HAP>` | exit 0（0 处违规）——**发布判据看的是这一步**，不是步 0 |
| 4 | `node tools/plugin-dist/release-gate.cjs --ci` | exit 0，全部 ✓；夹具已搬走时 contract-matrix 走默认跳过模式，那行 `fixture citations skipped: N` 仍要打印出来。剥离自检对**已无夹具**的 HAP 判「无需剥离（未产出副本）」为 ✓，不再要求必须先剥掉点什么 |
| 5 | `node tools/plugin-dist/release-gate.cjs --restore-staging --apply` | 把 5 个夹具目录搬回 `rawfile/plugins/`（只补空缺，不覆盖更新的目录）。**单独执行即可，不需要 `--strip`**；exit 1 是预期——夹具回来了，默认扫描重新变成红 |
| 6 | 再 `hvigorw assembleHap --no-daemon` + 五道离线门禁 + `release-gate` | 门禁全绿；默认模式重新回到 17 处红（夹具回来了，这是预期） |

**候选 HAP 不含 `*.stripped.hap`**：那是 `--strip` 写在自己源包旁边的工具产物，不是待评判的产物；
把它留在候选里，后一次运行就会去自检上一次的输出（`listHaps` 已排除，构建输出目录里既有文件不删）。
剥离自检两种判据：源包 0 处违规 → 无需剥离即 ✓；源包有违规 → 必须写出剥离副本且复检 0 处违规才 ✓。

**顺序为什么不能反**：夹具是 `plugin-dist-audit --all` / 契约矩阵的输入，剥离会把它们从资源树里拿走。
所以 CI 的顺序是「先 stage → 跑依赖夹具的门禁 → 最后一刻才剥离」，而不是先剥离再跑门禁。
`--ci` 的剥离自检是在临时副本上做的，不会破坏工作区。

**两个搬动开关都单步可用**：`--strip-staging` 与 `--restore-staging` 各自独立作用于资源树，都不要求同时给
`--strip`（`--strip` 只管 HAP）。修复类命令必须能被单步调用——否则"回来的路"会依赖一个文档里没写的开关。
它们的退出码描述的是**修复之后的树**：搬走夹具后只剩 HAP 的红，搬回夹具后红数回到剥离前。

**任一步失败**：立刻 `--restore-staging --apply` 把夹具搬回来，再复跑 `release-gate` 确认回到 17 处红，
不要带着半剥离的资源树去 build（那会把"缺夹具"当成产品缺陷发布出去）。
