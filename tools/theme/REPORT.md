# Minimal 主题 · 零改动生效 + 长期门禁 · 交付报告

日期：2026-11-02　设备：127.0.0.1:15555（唯一模拟器）　包名：com.lovexjy.lexinote
主题：Minimal 5.3.2 归档副本（manifest name=Minimal version=9.1.4，**无 id 字段**，id 取目录名 theme-minimal）
主题文件：`.fixtures-out/theme-minimal/styles.css` → 505243 字节，sha256 `19fa8e88f8da24450c67a49d99a3484603c1abf24f40b8ba16f06a4b914cf5b3`

## 0. 结论

| 项 | 结果 |
| --- | --- |
| Minimal styles.css 原样生效 | 是（注入 505243 字节，sha256 与 manifest.lock.json 逐位相同，页面侧重算一致） |
| 主题文件被改动 | 没有。整份文件 = fixture 原件，未裁剪/重排/子集化/加 !important |
| 变量层 | 宿主定义 203 个 Obsidian 同名变量（Minimal 引用 224 个），未定义 21 个如实列出 |
| 类名层 | 26 个 Obsidian 结构类全部落在真实 DOM 上，计数表见 §4 C5 |
| 明暗联动 | body 上 theme-dark/theme-light + minimal-default-dark/light 与宿主 app.isDarkMode 联动 |
| build | exit 0，`BUILD SUCCESSFUL` |
| 既有三道门禁 | 全绿（见 §3） |
| 新门禁 scripts/tests/theme-evidence.cjs | 第一轮 18/18；第二轮扩到 **23/23** 断言全绿，exit 0（见 §11.4） |
| 三条红灯 | 全部自造 → 变红 → 还原（见 §6） |

## 1. 为什么主题 CSS 一字不改也能覆盖（A5 第一问）

主题能生效靠三件事，全在宿主侧，没有一处去动主题文件：

### 1.1 加载顺序：主题永远最后
页面 head 里先在 `<link rel="stylesheet" href="lexinote_theme.css">`（宿主基础层）里定义变量与骨架结构；
页面 JS 在启用主题时创建 `<style id="lexinote-theme">` 并 `document.head.appendChild(style)` —— **追加到 head 末尾**，
因此它是文档中最后一张样式表。证据（hilog 第 59933 行 `theme.inject`）：
```
"styleLast": true,
"order": " > lexinote_theme.css >  > svelte-pcimu8-style > svelte-1vwr9dd-style > svelte-156w7na-style > svelte-q3wqg9-style > lexinote-theme"
```
`styleLast=true` 是页面自己遍历 `document.head` 里所有 `link[rel=stylesheet]` 与 `style` 节点算出来的，不是猜的。
同特异性时后者胜 —— 这是级联顺序（CSS Cascade 第 4 步）直接给出的，不需要 `!important`。

### 1.2 特异性：宿主只用到 0,1,0，主题在暗色下就是 0,1,0，靠顺序赢
- 宿主基础层 `lexinote_theme.css` 现在只有两种选择器：`:root { … }`（0,1,0）与单类选择器（0,1,0），**没有 ID 选择器、没有 !important**。
  - **更正（第二轮）**：第一轮这句是假的。当时只删了 `#editor`/`#sidebar`，`#palette`/`#palette-panel`/`#palette-input`/`#palette-list`/`#notices`/`#boot-error` 仍在用 ID 选择器（旧 444-519 行），ID 的 (1,0,0) 压住 Minimal 的 `.prompt`/`.modal` 单类规则，于是"主题对整个应用生效"只成立于编辑面板。第二轮把这些节点补了 Obsidian 同名类、宿主样式降级成类选择器，并给门禁加了 C4b（静态扫描源码，ID 选择器数量必须为 0，红了两次都能复现）。
- 第一版宿主暗色层写成 `body.theme-dark { … }`（0,1,1），结果压住了 Minimal 的 `.theme-dark`（0,1,0）：实测 run8 里 `theme.probe.on.bg` 仍是宿主的 `#1e1e24`，而 `1e1e24` 这个字符串在 Minimal 里一次都没出现。改成 `.theme-dark { … }`（0,1,0）后，主题的 `.theme-dark/.minimal-dark-*/.minimal-default-dark` 全部按顺序覆盖宿主的默认值，实测 run11/最终跑 `on.bg = hsl(0,0%,15%)`、`sample.color = rgb(33,33,33)`（Minimal 的值），而不是宿主的 `#1e1e24`。
- 宿主**没有**提高特异性去"抢"回控制权；需要宿主自己的布局时，用的也是单类选择器，把优先级让给主题。

### 1.3 变量层：把 Obsidian 的变量名当成宿主的公开接口
`lexinote_theme.css` 的 `:root` 定义了 203 个 Obsidian 同名变量（`--background-primary/-secondary/-secondary-alt/-primary-alt`、`--background-modifier-border/-border-hover/-hover/-box-shadow`、`--text-normal/-muted/-faint/-on-accent/-accent/-accent-hover`、`--color-accent`、`--interactive-accent/-accent-hover`、`--font-text/-interface/-monospace/-text-size`、`--line-height/-normal`、`--radius-s/-m/-l/-xl`、`--divider-width`、`--scrollbar-*`、`--bg1/2/3`、`--tx1..--tx4`、`--ui1/2/3`、`--h1-size..--h6-size` 等），宿主所有颜色/字体/圆角/间距都只经由这些变量渲染，没有一处硬编码颜色。
主题里的规则形如 `color: var(--text-normal)`，只要变量在场就能取到值；主题要改观感时自己重定义同名变量即可（Minimal 内部就重定义了 276 个），宿主不需要知道。

### 1.4 类名层：在与 Obsidian 对应的位置补同名类
`lexinote_workspace.html` 被重排成 Obsidian 的容器骨架（只加类和包裹层，DOM 语义与既有交互不变，所有原有 id/按钮文案保持不变）：
```
body.theme-*
└ .app-container
  └ .horizontal-main-container
    ├ .workspace-ribbon > .workspace-ribbon-inner > button.clickable-icon#btn-theme-panel
    ├ .workspace > .workspace-split.mod-root > .workspace-tabs.mod-active
    │   ├ .workspace-tab-header-container > .workspace-tab-header.is-active
    │   └ .workspace-leaf.mod-active > .workspace-leaf-content[data-type=markdown]
    │       ├ .view-header > .view-header-title#brand
    │       └ .view-content > .view-body > #editor.markdown-source-view.cm-s-editor.mod-cm6（CM6 自己长出 .cm-editor/.cm-scroller/.cm-content）
    └ #sidebar.workspace-split.mod-right-sidedock.workspace-sidenav > .workspace-leaf-content#views …
.status-bar#status-bar > .status-bar-item ×3
```
实测计数（hilog 第 60243 行，页面在每个容器上 `querySelectorAll` 数出来的）：
```
app-container=1 horizontal-main-container=1 workspace=1 workspace-split=2 workspace-ribbon=1
workspace-ribbon-inner=1 workspace-tabs=1 workspace-tab-header-container=2 workspace-tab-header=3
workspace-leaf=3 workspace-leaf-content=4 workspace-sidenav=1 view-header=1 view-header-title=1
view-content=3 view-body=6 markdown-source-view=1 cm-editor=1 cm-scroller=1 cm-content=1
status-bar=1 status-bar-item=4 mod-root=1 mod-active=2 is-active=1 clickable-icon=1
__missing="" __mode="theme-dark"
```
（`workspace-leaf=3`/`view-body=6` 比 HTML 里多，是插件视图与 obsidian 兼容层自己也挂了这些类 —— 说明类名层与插件层天然对齐。）

## 2. 主题的存储根与装载通道（任务要求 4）

- **存储根**：`${filesDir}/themes/<id>/`，与 `${filesDir}/plugins` 分开。理由：主题不是插件（没有 main.js、manifest 也允许没有 id），塞进 plugins 目录会让 `LexiPluginRuntime` 的扫描器把它当成"坏插件"报错；而 `themes/` 由新增的 `WorkspaceThemeCatalog`（entry/src/main/ets/workspace/WorkspaceThemeCatalog.ets）独立管理，活动主题记在 `themes/theme-active.json`。
- **装载通道**：走插件式的"目录 → 读 styles.css → 注入"，**没有**把 Minimal 内容硬编码进 rawfile（硬编码等于把夹具打进 HAP）。安装是 `theme.install {source}` → 宿主 `http.createHttp` 下载 → 写 `themes/<id>/styles.css` → 从落盘文件重算字节数 + sha256 → 回给页面。源 URL 由页面输入框展示（默认 `http://127.0.0.1:18080/theme-minimal/styles.css`，见 `DEFAULT_THEME_SOURCE`），本机够不着任何公网时也能换成本地/局域网的地址。
- **为什么必须走 HTTP**：hdc 写不进应用沙箱（SELinux 拦截，见 §8），设备 shell 也没有 wget/nc，所以只有"宿主进程自己下载"这一条路。

## 3. 门禁：命令原文与退出码

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `& E:\dev-tools\harmonyos\command-line-tools\bin\hvigorw.bat assembleHap --no-daemon` | 0 | `> hvigor BUILD SUCCESSFUL in 1 min 7 s 515 ms`（日志 .fixtures-out/build-restored.log） |
| 2 | `node scripts/tests/plugin-channel-audit.cjs` | 0 | 死通道 0（日志 .fixtures-out/gate-channel-audit.log） |
| 3 | `node scripts/tests/plugin-contract-matrix.cjs` | 0 | `✓ 契约矩阵一致：符号集合 100% 覆盖，gap 齐全且合法，实现证据齐全，格式稳定`（日志 .fixtures-out/gate-contract-matrix.log） |
| 4 | `node scripts/tests/workspace-slice-evidence.cjs` | 0 | `result: PASS`，五组里程碑全绿：goal 10/10、real 5/5、protocol 10/10、layout-lifecycle 4/4、editor-extension 8/8，`[negative] clean`（日志 .fixtures-out/gate-slice-live.log，证据 .fixtures-out/evidence/20261102-045142） |
| 5 | `node scripts/tests/workspace-slice-evidence.cjs --check-only .fixtures-out/evidence/20261102-045142` | 0 | `result: PASS (check-only)`（日志 .fixtures-out/gate-slice-checkonly.log） |
| 6 | `node scripts/tests/theme-evidence.cjs` | 0 | `[theme-evidence] 18/18 assertions green`（第一轮，日志 .fixtures-out/theme-gate-final.log）；第二轮 `23/23`，日志 .fixtures-out/theme-gate-final-r2.log（见 §11.4） |

第 4 条是"改完 HTML 之后编辑器没退化"的正面证据：它在真机上点命令面板、跑示例插件命令、装扩展、撤销重做、多 leaf、metadata 重命名、布局重启恢复，全部 PASS。

## 4. theme-evidence 的完整输出（最终跑，exit 0）

```
PASS  C1 fixture 与 manifest.lock.json 一致（原样源头）  [505243B 19fa8e88f8da2445…]
PASS  C2.pre 页面能点到"安装主题"按钮
PASS  C2 宿主落盘字节数/sha256 与 manifest.lock.json 一致  [bytes=505243 sha=19fa8e88f8da2445…]
PASS  C0 门禁先停用主题（截图前主题确实关闭，可重复跑，不依赖运行历史）  [theme.disabled 已记录]
PASS  C9.pre0 主题关闭态截图前没有命令面板浮层（避免色差来自浮层）
PASS  C7.pre 能把容器切到暗色（后续两张截图都在暗色下比较）
PASS  C9.pre 主题关闭态截图落盘  [.fixtures-out/evidence/20261102-050926/theme-off.png]
PASS  C3.pre 页面能点到"启用主题"按钮
PASS  C3 注入的 CSS = 505243 字节且 sha256 与锁一致（原样装入）  [bytes=505243 match=true]
PASS  C4 注入节点在 head 末尾（主题顺序压住宿主基础层）
PASS  C5 必需类名全部存在（表里 26 个）+ 明暗态类在场  [missing=(none) mode=theme-dark]
PASS  C6 主题关闭 vs 开启：--background-primary / --text-normal 计算值不同
PASS  C7 明暗两态下同一元素计算背景色不同  [rgb(245, 245, 245) vs rgb(33, 33, 33)]
PASS  C8 变量覆盖报告存在（未定义项已列出，不假装 100%）  [referenced=224 defined=203 undefined=21]
PASS  C9.pre2 主题开启态截图落盘  [.fixtures-out/evidence/20261102-050926/theme-on.png]
PASS  C9.pre1 主题开启态截图前没有命令面板浮层
PASS  C9 两张截图尺寸一致  [3120x2080 vs 3120x2080]
PASS  C10 同一区域平均色差 > 8（主题关闭 vs 开启）  [mean=10.165]
[theme-evidence] 18/18 assertions green
```

关键 hilog 行（路径 .fixtures-out/evidence/20261102-050926/hilog.log，tag `A00a17/LexiWorkspace`）：

| 行号 | topic | 关键内容 |
| --- | --- | --- |
| 46346 | theme.install.done | `{"id":"theme-minimal","bytes":505243,"sha256":"19fa8e88…","source":"http://127.0.0.1:18080/theme-minimal/styles.css"}` |
| 53362 | theme.disabled | `{"note":"已移除 <style id=\"lexinote-theme\">"}` |
| 57257 | theme.mode | `{"dark":true,"source":"manual","override":"dark"}` |
| 59811 | theme.css.load | `id=theme-minimal bytes=505243 chars=505215 sha256=19fa8e88…` |
| 59933 | theme.inject | `chars=505215 bytes=505243 sha256=19fa8e88… hostSha=19fa8e88… match=true styleLast=true` |
| 60003 | theme.probe | `off.bg=#ffffff on.bg=hsl(0,0%,15%) sample.color=rgb(33,33,33) classes="outliner-plugin-better-lists theme-dark minimal-default-dark"` |
| 60166 | theme.states | `light=rgb(245,245,245) dark=rgb(33,33,33) differ=true` |
| 60179 | theme.coverage | `{"referenced":224,"defined":203,"undefined":21}` |
| 60243 | theme.classes | 26 类计数表 + `__missing="" __mode="theme-dark"` |

字节数 505243 与字符数 505215 的差是文件里的多字节 UTF-8（28 字节）；页面用自己的纯 JS SHA-256 对 UTF-8 字节重算，与锁一致，所以"原样"是逐字节证明而不是看长度。

## 5. 截图客观证据（A3）

- 主题关闭：`.fixtures-out/evidence/20261102-050926/theme-off.png`（3120×2080）
- 主题开启：`.fixtures-out/evidence/20261102-050926/theme-on.png`（3120×2080）
- 度量：`node scripts/tests/theme-evidence.cjs` 自己解 PNG（zlib.inflateSync + 逐行反滤波，8bit/colorType 2/6），只比 Web 容器矩形（uitest 的 vp 按整屏宽度换算成 px：`{"x":515,"y":365,"w":2090,"h":1310}` → `515,365,2605,1675`），three-channel 平均绝对差 `mean=10.165 > 阈值 8`。
- 两张图都在暗色下拍：Minimal 亮色 `--background-primary` 就是 `white`，与宿主亮色默认 `#ffffff` 相同，亮色下开关主题底色几乎不变（较早一次实测 mean≈0.03），所以门禁强制暗色拍（C7.pre），暗色下宿主 `#1e1e24` vs Minimal `rgb(33,33,33)` 差距稳定。
- 浮层干扰已排除：页面 boot 自检会打开命令面板，早前 run9 的 mean=12.917 里就掺了"浮层被点掉"的像素变化。现在拍前用 `dismissOverlays()` 点编辑区空白处关掉浮层并断言（C9.pre0/C9.pre1），最终两张图都没有浮层。
- 已知由图可见的额外差异（不是同色块的功劳，但也都来自主题自身规则）：`.view-header`/`.theme-panel` 的间距与边框、卡片边框消失、编辑器当前行高亮条。色差断言只看同一矩形内的像素颜色，不区分这些来源，报告如实说明。

## 6. 三条红灯：自造 → 自证 → 还原（A4）

> 本节是**第一轮**（当时 18 条断言）的三条红灯，数字因此写 17/18、15/18。第二轮另造三条（缺类名 / 宿主写回 ID / 不造真通知 → C11.pre+C12 红），见 §11.7。

### 红灯 1：删掉一个必需类名 → C5 红
```
# 改前（entry/src/main/resources/rawfile/lexinote_workspace.html:13）
<div class="horizontal-main-container">
# 改后
<div class="">
& hvigorw.bat assembleHap --no-daemon      → exit 0, BUILD SUCCESSFUL in 11 s 123 ms (增量)
node scripts/tests/theme-evidence.cjs      → exit 1
  FAIL /* red */  C5 必需类名全部存在（表里 26 个）+ 明暗态类在场  [missing=horizontal-main-container mode=theme-dark]
  [theme-evidence] 17/18 assertions green
```
还原：从 `.fixtures-out/lexinote_workspace.html.bak` 拷回，`Get-FileHash` 与备份**逐位相同（True）**，重新 build exit 0（`BUILD SUCCESSFUL in 1 min 7 s 515 ms`），后续最终跑恢复 18/18 绿。
（附注：第一次红灯试的是 `status-bar` 类，没变红 —— 因为 obsidian 兼容层的 statusbar 自己也会产出 `.status-bar` 节点，删 HTML 上的类名并不能让它消失。这正好说明计数表是在真实 DOM 上数的，不是查源码字符串。）

### 红灯 2：把主题 CSS 改 1 字节 → sha 断言红
做法：复制 fixture 成 `.fixtures-out/theme-minimal-tampered/`，把 `styles.css` 偏移 252622 的字节 `0x54 → 0xC9`（`$b[$i] -bxor 0xFF`，长度仍是 505243），门禁用 `THEME_FIXTURE` 环境变量指向这个副本：
```
$env:THEME_FIXTURE='theme-minimal-tampered'; node scripts/tests/theme-evidence.cjs   → exit 1
  FAIL /* red */  C1 fixture 与 manifest.lock.json 一致（原样源头）  [505243B a21213d9eb949ac2…]
  FAIL /* red */  C2 宿主落盘字节数/sha256 与 manifest.lock.json 一致  [bytes=505243 sha=a21213d9eb949ac2…]
  FAIL /* red */  C3 注入的 CSS = 505243 字节且 sha256 与锁一致（原样装入）  [bytes=505243 match=false]
  [theme-evidence] 15/18 assertions green
```
还原：删除 `.fixtures-out/theme-minimal-tampered`，fixture 原件未被触碰（C1 一直是 19fa8e88…），下一跑恢复绿。
另有一个 `--redlight=sha`（服务端发送时 XOR 中间字节）模式，实测只让 C2 变红 —— 该模式在页面侧读到的是上一次落盘的旧文件，证据链不如上面的"副本篡改 + 环境变量换源"干净，因此**以副本篡改为准**，这个模式保留但不再作为验收证据。

### 红灯 3：两次截图用同一张 → 色差断言红
```
node scripts/tests/theme-evidence.cjs --redlight=same-shot   → exit 1
  PASS  C3 注入的 CSS = 505243 字节且 sha256 与锁一致  [bytes=505243 match=true]   （说明其余链路仍然真跑）
  redlight=same-shot: theme-on.png 被 theme-off.png 覆盖
  diff: mean=0.000 region=515,365,2605,1675
  FAIL /* red */  C10 同一区域平均色差 > 8（主题关闭 vs 开启）  [mean=0.000]
  [theme-evidence] 17/18 assertions green
```
还原：`--redlight` 只在证据目录里动手，源文件不动；下一跑（最终 18/18）恢复绿。

## 7. 仍未生效的部分（A5 第二问，如实列）

1. **阅读视图类名（`.markdown-preview-view` 262 处、`.markdown-reading-view` 9 处、`.markdown-preview-section` 19 处）完全不生效**：这个容器只有 CM6 源码视图（`#editor.markdown-source-view`），没有 Obsidian 的阅读模式实例。没有为了让计数好看去塞一个隐藏的假节点 —— 门禁的必需类表只列真实存在的类。
2. **196 处外部 `url(...)` 资源不生效**：Minimal 没有 `@import`、没有 `@font-face`，但有 196 个 `url()` 引用非 `data:`/`#` 资源（字体/图标/背景）。页面的 CSP 是 `font-src 'self'; img-src 'self' data:; connect-src 'none'`，且设备无外网 —— 这些请求全部被拦。降级结果：`--font-text`/`--font-interface`/`--font-monospace` 回落到宿主给的系统字体栈（`"HarmonyOS Sans", system-ui, sans-serif` 等），图标相关装饰不出现。
3. **432 处 `.is-mobile` 分支不生效**：宿主不是 Obsidian 的移动外壳，不会给 body 加 `is-mobile`；这些分支（移动端抽屉/手势/尺寸）走不到。桌面分支正常。
4. **依赖 JS 的主题功能不生效**：Minimal 的 Style Settings 面板（`minimal-theme`/Style Settings 插件的可视配置）、`@media (prefers-color-scheme)` 之外的运行期切换器，都需要 Obsidian 的插件运行时；这里只有 `.minimal-default-*`/`.minimal-dark-black` 这类纯 CSS 调色板类，宿主已通过 applyMode 切换 `minimal-default-dark`/`minimal-default-light`（因为 Minimal 的暗色底 `--bg1` 挂在**裸类** `.minimal-default-dark` 上，只加 `theme-dark` 是拿不到暗色底的）。
5. **21 个变量未定义**（页面报告 `referenced=224 defined=203`，`theme-coverage.json` 里有完整列表，门禁逐条打印）：
   ```
   --font-editor-override --font-text-override --editor-font-size --blockquote-size
   --font-editor --h1-font --h2-font --h3-font --h4-font --h5-font --h6-font
   --link-weight --text-primary --color-background --font-settings-title
   --text-adaptive-normal --row-color-hover --color-background-day-active
   --embedded-note-title-padding-top --embedded-note-title-padding-bottom ----text
   ```
   这些是 Minimal 引用但宿主没定义的：主题侧会回落（`var(x, fallback)` 或继承），或只在它没被使用的组件（日历/嵌入笔记标题/设置面板）里出现。`----text` 是主题自身表达式拼接出来的伪变量名，不是宿主的漏项。**没有假装 100%**。
6. **滚动条伪元素**：`--scrollbar-*` 已定义，但 ArkWeb 是 Chromium 内核、`::-webkit-scrollbar` 的表现与桌面 Obsidian（Electron）不完全一致；这一项只做到"变量在场"，没有做像素级对齐。
7. **主题设置里的"对比度变体"**（`.minimal-light-contrast`/`.minimal-dark-contrast` 这类）不会自动启用：宿主只切 `minimal-default-light/dark`，其余变体需要用户自己加类，本轮没做 UI。

## 8. 环境事实与踩过的坑（复用价值）

1. **模拟器息屏会让 uitest 完全失真**：`aa start` 报成功、`pidof` 有进程，但 `uitest dumpLayout` 只返回桌面节点（`session7/SCBDesktop_*`），`uitest screenCap` 报 `ScreenCap failed: Failed to get display pixelMap`、`file recv` 得到 0 字节。修法：`hdc shell power-shell wakeup`，再 `aa force-stop`/`aa start`。门禁里已固化成 `wake()` + 截图失败重试（<4096 字节视为失败）。
2. **端口方向必须用 `rport` 不是 `fport`**：`hdc fport tcp:18080 tcp:18080` 是"宿主 → 设备"，设备上没监听，应用侧拿到 `errCode 2300007 / tcpConnectErrno 115 (ECONNREFUSED)`。设备要访问宿主要用 `hdc rport tcp:18080 tcp:18080`，`hdc fport ls` 里会显示 `[Reverse]`（`rport ls` 不是合法命令，用 `fport ls` 看，删除用 `fport rm tcp:P tcp:P`）。
3. **hdc 写不进应用沙箱**：`/data/app/el2/100/base/com.lovexjy.lexinote/haps/entry/files` 对 shell 是 `Permission denied`，连 777 的 `files/plugins` 也拒 `mkdir`（SELinux 拦，非 DAC），设备 shell 也没有 wget/nc → 只能"宿主进程自己 HTTP 下载"。
4. **活动主题是持久化的**：`themes/theme-active.json` 会让页面 boot 自注入。门禁第一件事是显式"停用主题"（C0），否则第二跑起"关闭态"截图其实已经带主题（实测 run10 两张图 `mean=0.117`）。
5. **boot 自注入与点击注入的竞态**：`theme.inject` 可能出现两条（boot 一条、点击一条）。门禁按"点击前该 topic 的条数"取新增那条（`freshOf()`），否则会读到上一轮的旧证据。
6. **主题面板必须放在侧栏顶部**：插件视图卡片会把面板挤到视口外，uitest 仍报 bounds 但点击落空（run6 的"切换明暗"就这么丢的）；现在面板是 `#sidebar` 的第一个子节点，另外状态栏也有一个"亮色/暗色"入口。
7. **同一台设备上可能有别的轨道在跑**（本轮就遇到过 `plugin-shim-regression.cjs` 同时占用设备/18080 端口）：`EADDRINUSE` 或前台被抢都会让门禁出现假红，重跑前先确认 `Get-NetTCPConnection -LocalPort 18080` 为空。

## 9. 改动清单（git）

本轨道产出的文件全部是**新增（untracked）**；`git diff --stat` 里没有任何一项属于本轨道（那是并行轨道的改动），如实分开列：

```
# git status --short（本轨道相关行）
?? entry/src/main/ets/workspace/                      （新增 WorkspaceThemeCatalog.ets，并改 WorkspaceBridge.ets / LexiWorkspacePage.ets）
?? entry/src/main/resources/rawfile/lexinote_theme.css
?? entry/src/main/resources/rawfile/lexinote_theme.js
?? entry/src/main/resources/rawfile/lexinote_workspace.html   （重排为 Obsidian 骨架，删掉旧的 ID 内联样式）
?? scripts/tests/theme-evidence.cjs
# git diff --stat（全部属于并行轨道，非本轨道）
14 files changed, 3095 insertions(+), 324 deletions(-)
```

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| entry/src/main/ets/workspace/WorkspaceThemeCatalog.ets | 278 | 主题目录管理：list/load/measure/install/setActive + sha256（分块 updateSync）、`DEFAULT_THEME_SOURCE` |
| entry/src/main/ets/workspace/WorkspaceBridge.ets | 622 | dispatch 增加 theme.config/list/load/install/setActive（要求已 auth）+ `describeError`（ArkTS 的 BusinessError 不是 Error 子类，否则只会打印 `[object Object]`） |
| entry/src/main/ets/workspace/LexiWorkspacePage.ets | 217 | 构造 WorkspaceBridge 时注入 `WorkspaceThemeCatalog` |
| entry/src/main/resources/rawfile/lexinote_theme.css | 551 | 宿主基础层：203 个变量 + `:root`/`.theme-dark` 明暗两态 + 单类选择器骨架（无 ID、无 !important） |
| entry/src/main/resources/rawfile/lexinote_theme.js | 414 | 页面侧管线：安装/启用/停用/自检、注入 `<style id="lexinote-theme">`、纯 JS SHA-256、明暗联动、类名计数、变量覆盖报告 |
| entry/src/main/resources/rawfile/lexinote_workspace.html | 87 | Obsidian 类名骨架 + 主题面板；原 id/文案/脚本顺序全部保留 |
| scripts/tests/theme-evidence.cjs | 875 | 新门禁 23 条断言（第二轮 +5）+ 自带静态服务器 + `rport` + 自带 PNG 解码/色差 + 离线 `--check-only` + 三个 `--redlight` 模式（sha / same-shot / no-notice） |

未触碰（禁改区）：`entry/src/main/ets/core/plugin/**`、`rawfile/lexinote_plugin_shim.js`、`rawfile/lexinote_plugin_view_shim.js`、`tools/contract/**`、`scripts/tests/{plugin-channel-audit,plugin-contract-matrix,workspace-slice-evidence,plugin-fixtures-*}.cjs`、`tools/workspace-bundle/**`。

## 10. 遗留 / 未查清

- `--redlight=sha` 模式只能红 C2 不能红 C3（页面侧读到旧落盘文件的时序），已用"副本篡改 + `THEME_FIXTURE` 换源"替代作为正式证据；两个模式都留在脚本里，注释写明了差别。
- 页面 boot 自注入与用户点"启用主题"之间仍有理论上的双注入窗口（功能无害，只是多删一次旧 `<style>`），本轮只做到门禁取证不受影响，没有做去抖。
- 没有为"主题目录为空"/"styles.css 是空文件"/"HTML 里带 `@import` 的主题"做端到端反例测试（代码里有 `load() → null → theme.fail.load` 的分支，但未被门禁覆盖）。

## 11. 第二轮：把「整个应用」补齐（命令面板 / 通知 / 弹窗错层）

### 11.1 第一轮那句是假的（本轮的实质缺口）

第一轮报告写「宿主基础层只用 `:root` 和单类选择器（0,1,0），无 ID 选择器」，**不成立**：`entry/src/main/resources/rawfile/lexinote_theme.css` 旧 444-519 行仍是 `#palette`、`#palette-panel`、`#palette-input`、`#palette-list`、`#notices`、`#boot-error`。

后果：Minimal 针对命令面板/弹窗的选择器是类（`.prompt` `.prompt-input` `.prompt-results` `.suggestion-container` `.modal` `.modal-container` `.modal-content` `.modal-button-container` …），宿主那些 ID 的 (1,0,0) 把它们全压住，于是「主题对整个应用生效」只在编辑面板成立。

### 11.2 DOM：补 Obsidian 同名类，**id 全部保留**

`entry/src/main/resources/rawfile/lexinote_workspace.html:80-84`：

```html
<div id="palette" class="prompt-container" hidden>
  <div id="palette-modal" class="modal-container">
    <div id="palette-panel" class="prompt modal">
      <input id="palette-input" class="prompt-input" …>
      <ul id="palette-list" class="prompt-results suggestion-container"></ul>
</div>
<div id="notices" class="notice-container"></div>
<p id="boot-error" class="notice-container boot-error" hidden>
```

要点：**没有造假的 `.suggestion-item` 占位节点**——那些 li 是 CM6 bundle 运行时生成的，静态塞一个等于伪造 DOM；`.suggestion-item` 因此不进必需类名表，只在 C13 的 CSSOM 命中数里体现（实测 `noticeCount`/`suggestionCount` 分别为 1/0，造不出就不声称）。

### 11.3 宿主样式降级为类选择器（同视觉，不再抢权重）

| 旧（ID，0,1,0 起步但带 ID = 1,0,0） | 新（类） |
| --- | --- |
| `#palette`（硬编码 `rgba(0,0,0,0.35)` 遮罩） | `.prompt-container`（`background-color: var(--background-modifier-cover)`，变量可被主题改写） |
| `#palette-panel` | `.prompt, .modal` |
| `#palette-input` | `.prompt-input` |
| `#palette-list` / `li:hover` | `.prompt-results, .suggestion-container` / `.suggestion-item:hover, .suggestion-item.is-selected` |
| `#notices` | `.notice-container` |
| `#boot-error` | `.notice-container.boot-error` |

新增变量 `--background-modifier-cover`（`:root` 亮色 `rgba(0,0,0,0.35)`、`.theme-dark` 暗色 `rgba(0,0,0,0.6)`）——Minimal 自己在 `.theme-light`/`.theme-dark` 里就定义同名变量，所以遮罩颜色跟着主题走。

### 11.4 门禁扩到 23 条断言（exit 0）

新增：`C4b` 宿主零 ID 选择器、`C11.pre` 真实 `.notice` 在场、`C11` `#palette` 遮罩随主题变、`C12` `.notice` 背景随主题变、`C13` Minimal 的 `.prompt*`/`.modal*` 规则有 CSSOM 命中；同时把明暗切换挪到「关闭态取样」**之前**，两组取样都在暗色下，避免把明暗差异算进主题开关差异。

`.fixtures-out/theme-gate-final-r2b.log`（exit 0，最终跑）：

```
PASS  C4b 宿主基础层零 ID 选择器（静态扫描口径；ID 会压住主题的单类规则）  [ids=[]]
PASS  C11.pre 主题关闭态下真实 .notice 在场（页面通知通道造出来的）  [noticeCount=1 notice=rgb(35, 35, 41) palette=rgba(0, 0, 0, 0.6)]
PASS  C3 注入的 CSS = 505243 字节且 sha256 与锁一致（原样装入）  [bytes=505243 match=true]
PASS  C5 必需类名全部存在（表里 34 个）+ 明暗态类在场  [missing=(none) mode=theme-dark]
PASS  C11 主题关闭 vs 开启：#palette（prompt 遮罩）计算背景色不同  [off=rgba(0, 0, 0, 0.6) on=rgba(224, 224, 224, 0.7)]
PASS  C12 主题关闭 vs 开启：真实 .notice 计算背景色不同（通知由页面通道造）  [off=rgb(35, 35, 41)/1 on=rgb(33, 33, 33)/1]
PASS  C13 Minimal 的 .prompt*/.modal* 规则确实命中我们补的类（CSSOM 口径）  [prompt={"total":19,"matched":5,…} modal={"total":126,"matched":3,…} notice={"total":0,"matched":0}]
PASS  C10 同一区域平均色差 > 8（主题关闭 vs 开启）  [mean=10.230]
[theme-evidence] 23/23 assertions green
```

证据目录 `.fixtures-out/evidence/20261102-061850`（`hilog.log` / `summary.json` / `theme-off.png` / `theme-on.png` / `theme-coverage.json`）。
hilog 锚点（路径 `.fixtures-out/evidence/20261102-061850/hilog.log`，行号为各 topic 首次出现）：24773 `theme.classes`、24788 `theme.specificity`、24801 `theme.ui`、24912 `theme.rules`、25885 `theme.css.load`、26000 `theme.mode`、26393 `theme.inject`、26780 `theme.probe`、26792 `theme.states`、26802 `theme.coverage`、28579 `theme.install.done`、36461 `theme.disabled`。

离线重放：`node scripts/tests/theme-evidence.cjs --check-only .fixtures-out/evidence/20261102-061850` → `exit=0`，`[theme-evidence (offline replay)] 12/12 assertions green`（日志 `.fixtures-out/theme-checkonly-r2b.log`）。

### 11.5 Minimal 规则命中数：改前 / 改后（口径写清）

**改前**：页面 HTML 里 `prompt-container` / `modal-container` / `notice-container` 出现次数 = 0（`.fixtures-out/lexinote_workspace.html.bak` 实测 0/0/0），所以 `document.querySelector('.prompt')`、`.modal` 一律为 null —— 这三族规则命中数是 **0**，不是「少」，是没有。

**改后**（`node tools/theme/rule-miss-audit.cjs`，纯静态，不连设备）：

```
宿主 DOM 类名集合: 60 个（HTML class 属性 + bundle 运行时生成）
主题规则块: 2019 个（含 @media 内部）
[prompt] 规则 19 个 | 类名齐备(可命中) 5 | 缺类名(结构上不可能命中) 14   ← 缺 .is-mobile x7, .hider-scrollbars x2, .suggestion-flair x2 …
[modal] 规则 126 个 | 类名齐备(可命中) 2 | 缺类名 124                    ← 缺 .is-mobile x53, .mod-settings x22, .modal-button-container x19, .modal-content x18 …
[notice] 规则 0 个（Minimal 根本没有 .notice 规则）
[suggestion] 规则 28 个 | 类名齐备 7 | 缺类名 21
[menu] 规则 25 个 | 类名齐备 0 | 缺类名 25
[tooltip] 规则 2 个 | 类名齐备 0 | 缺类名 2
合计: 规则 200 | 类名齐备 14 | 缺类名 186
```

**两种口径必须一起看**：

- 静态口径（上表）= 选择器要求的**全部**类名是否都在页面 DOM 里；任何一个缺，该规则判「结构上不可能命中」。它给的是下界。
- 运行时口径（门禁 C13）= 注入的 `<style>` 的 `cssRules` 逐条 `document.querySelector(selectorText)`，给的是真实命中数：prompt `5/19`、modal `3/126`、notice `0/0`。modal 运行时 3 > 静态 2，是因为逗号选择器组只要一支命中就算命中，而静态口径把整组按最严分支判。

### 11.6 仍未匹配的部分（如实列，不假装全覆盖）

1. **`.menu*` / `.tooltip` 族完全不匹配**（25 + 2 条规则，命中 0）：我们的命令面板列表是自绘 `li`，既没有 `.menu`/`.menu-item`/`.menu-item-icon`/`.is-label`/`.is-disabled`，也没有 tooltip 节点。要做成 Obsidian 那样得重写面板 DOM，本轮不做。
2. **`.modal` 的层级结构对不上**：Obsidian 是 `.modal-container > .modal > (.modal-title + .modal-content + .modal-button-container + .modal-close-button)`；我们的面板是 `.modal-container.modal > (.prompt-input + .prompt-results)`。所以 `.modal-content`(18 条)、`.modal-button-container`(19 条)、`.modal-close-button`(10 条)、`.modal-title`(6 条) 全部落空——**这些不是「缺类名就能修」，是结构不同**。
3. **`.mod-settings` / `.mod-publish` / `.mod-confirmation` / `.dtchooser` 等 60+ 条变体规则伏空**：那是 Obsidian 设置、发布、确认框、日期选择器的专属结构，本容器没有对应的窗口。
4. **`.is-mobile` 分支（prompt 7 条 + modal 53 条 + suggestion 14 条 + menu 11 条）全部落空**：宿主 body 从不加 `.is-mobile`，桌面布局也不该加。
5. **`.suggestion-item` 实际命中 0**：`suggestionCount=0`（面板关着时列表是空的），所以 C13 里 suggestion 族只做报告不做断言，不声称「已验证样式」。
6. **Minimal 全文 0 条 `.notice` 规则**：Obsidian 的通知样式来自 app.css 而非主题。所以通知这一块**不是**「主题生效了」，而是「宿主 `.notice` 现在用变量上色（`var(--background-secondary)`），变量被主题改写后颜色跟着变」——C12 的 off `rgb(35,35,41)` → on `rgb(33,33,33)` 证明的是这一点，不能说成「Minimal 通知样式生效」。
7. 沿用第一轮的其余未生效清单（见 §7）：`.markdown-preview-view` 只读模式 262 处选择器没有对应视图、196 处外部 `url()` 被 CSP/离线挡住不回退、网格/滚动条伪元素只在极窄范围生效、21 个未定义变量等。

### 11.7 本轮三条红灯（自造 → 自证 → 还原）

| # | 造法 | 结果 | 还原 |
| --- | --- | --- | --- |
| 红灯 4 | `lexinote_workspace.html:80` 删掉 `class="modal-container"`，重建 HAP（`.fixtures-out/build-reda.log` `BUILD SUCCESSFUL in 50 s 268 ms`） | `exit=1`，`.fixtures-out/theme-gate-reda.log`：`FAIL /* red */ C5 必需类名全部存在（表里 34 个）… [missing=modal-container mode=theme-dark]`，22/23 | 用 `.fixtures-out/lexinote_workspace.html.r2bak` 还原 + 重建 `.fixtures-out/build-restore-r2.log` `BUILD SUCCESSFUL in 54 s 603 ms` |
| 红灯 5 | 把一条宿主规则写回 ID：`#palette-panel { padding: 10px; }` 追加到 `lexinote_theme.css:576`（`C4b` 扫源码，不需要重建） | `exit=1`，`.fixtures-out/theme-gate-redb.log`：`FAIL /* red */ C4b 宿主基础层零 ID 选择器… [ids=["#palette-panel"]]`，22/23 | 用 `.fixtures-out/lexinote_theme.css.r2bak` 覆盖（13800 字节，`#` 只剩颜色值） |
| 红灯 6 | `node scripts/tests/theme-evidence.cjs --redlight=no-notice`（故意不点 `Notice 自检`，即不造真实通知） | `exit=1`，`.fixtures-out/theme-gate-redc.log`：`FAIL /* red */ C11.pre … [noticeCount=0]` + `FAIL /* red */ C12 … [off=/0 on=/0]`，21/23；同时 `C11`（遮罩）仍 PASS，证明红的只是「没有真通知」这条 | 无需还原（只换运行参数） |

反例的判定都落在真实 DOM / 源码上：C5 读 `document.querySelectorAll` 计数、C4b 读宿主 CSS 源码（`tools/theme/rule-miss-audit.cjs` 同源扫描逻辑，一次扫描就能看见 `["#palette-panel","#notices li:hover"]`）、C11/C12 要求 `.notice` 节点真的由页面通知通道生成。

### 11.8 关于 CSSOM 的一处更正（避免下一轮又踩）

`lexinote_theme.js` 的 `theme.specificity` 的 host 分支在设备上永远是 `{"rules":0,…,"error":"SecurityError"}`：宿主基础层是 `<link rel="stylesheet" href="lexinote_theme.css">`，在 ArkWeb 里解析成 `resource://rawfile`，对文档而言是**跨源样式表**，`styleSheet.cssRules` 直接抛 `SecurityError`。第一版 C4b 建在它上面 = 假绿灯。现在 C4b 的判定依据是 `scanIdSelectors(HOST_CSS)`（静态扫描源码），CSSOM 结果只作为旁证打印；主题自己注入的 `<style id="lexinote-theme">` 是同源可读的，所以 C13 的规则命中数仍然走 CSSOM。

### 11.8b 离线重放的口径修正（自查发现的一处不一致）

第一次跑 `--check-only` 时 12 条里红了 1 条：`C10 [mean=6.742]`，而真跑同一对图是 `10.230`。原因不是截图有问题，是**两把尺子**：真跑用 uitest 拿到的 Web 容器 rect（515,365–2605,1675），离线重放退化成整屏 inset 0.1 的框，把窗口外的壁纸稀释进了均值。

修法：真跑把 `diff.region` 与 `rect` 一起写进 `summary.json`，`--check-only` 读回来复用同一 rect —— 重放现在 `12/12 green`、`mean=10.230`、`region=515,365,2605,1675`，与真跑逐位一致。教训：离线重放如果换了测量区域，就不是重放。

### 11.9 本轮命令原文与退出码

```
# 构建（rawfile 变化需重建，cap-probe 探针插件由运行时轨维护，未触碰）
& E:\dev-tools\harmonyos\command-line-tools\bin\hvigorw.bat assembleHap --no-daemon
  → BUILD SUCCESSFUL in 1 min 15 s 518 ms   exit=0   (.fixtures-out/build-theme-r2.log)
# 主题门禁（23 条断言，独占模拟器）
node scripts/tests/theme-evidence.cjs              → 23/23 green  exit=0  (.fixtures-out/theme-gate-final-r2b.log)
node scripts/tests/theme-evidence.cjs --check-only .fixtures-out/evidence/20261102-061850  → 12/12 green  exit=0  (.fixtures-out/theme-checkonly-r2b.log)
node scripts/tests/theme-evidence.cjs --redlight=sha       → 见 §6 红灯 2（第一轮）
node scripts/tests/theme-evidence.cjs --redlight=same-shot  → 见 §6 红灯 3（第一轮）
node scripts/tests/theme-evidence.cjs --redlight=no-notice  → 21/23  exit=1  (本轮红灯 6)
# 原有门禁（必须保持绿）
node scripts/tests/plugin-channel-audit.cjs        → exit=0  (.fixtures-out/gate-channel-audit-r2.log)
node scripts/tests/plugin-contract-matrix.cjs      → exit=0  ✓ 契约矩阵一致  (.fixtures-out/gate-contract-matrix-r2.log)
node scripts/tests/workspace-slice-evidence.cjs    → exit=0  result: PASS  evidence .fixtures-out/evidence/20261102-061356  (.fixtures-out/slice-gate-r2.log)
node tools/theme/rule-miss-audit.cjs               → exit=0（静态审计，见 §11.5）
```

切片门禁里与编辑器相关的实测仍是全绿：`probe.editor.identity {ctorSame:true,liveSame:true,hasCm:true}`、`probe.editor.ext.install {installed:true,mounts:1}`、`probe.editor.undo {editedOk:true,undoneOk:true,redoneOk:true}`、`probe.editor.outliner {extCount:11,markers:2,bodyClass:true}`、`probe.editor.leaves {leaves:3,duplicates:0}` —— 加类名/加包裹层没有动编辑器。

### 11.10 本轮改动清单

```
# 本轨道（全部 untracked，未提交）
?? entry/src/main/resources/rawfile/lexinote_workspace.html   93 行
?? entry/src/main/resources/rawfile/lexinote_theme.css       522 行
?? entry/src/main/resources/rawfile/lexinote_theme.js        531 行
?? scripts/tests/theme-evidence.cjs                          875 行
?? tools/theme/rule-miss-audit.cjs                            86 行（本轮新增）
?? tools/theme/REPORT.md
?? entry/src/main/ets/workspace/  (WorkspaceThemeCatalog.ets 254 / WorkspaceBridge.ets 591 / LexiWorkspacePage.ets 201)
# git diff --stat：14 files changed, 3285 insertions(+), 379 deletions(-)
# 全部属于并行轨道（core/plugin/** 等），本轨道一行未进 diff（文件都还是 untracked）
```
