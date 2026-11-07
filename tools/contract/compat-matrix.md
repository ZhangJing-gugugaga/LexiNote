# 兼容性矩阵报告（obsidian@1.14.4）

> 由 `node tools/contract/report.cjs` 从 `tools/contract/symbols.json` 渲染，逐字节可再生：同输入 → 同字节
> （无时间戳、符号按字典序、节与字段序固定、LF + 结尾单换行）。改了 symbols.json 必须重跑该命令，
> 否则 `scripts/tests/plugin-contract-matrix.cjs` 的漂移检查红灯。矩阵口径与字段语义见 `tools/contract/README.md`，
> 权威约束见 `docs/lexinote_plugin_bridge_spec.md` 第 7 节。
>
> 本文件是符号级全量矩阵（官方 `obsidian.d.ts` 逐符号定级）；"插件实际用面"报告（夹具驱动、随夹具集变化、
> 带生成时间）见 `tools/plugins-fixtures/api-surface.report.md` —— 两者互补不重复。

## 汇总

- 符号总数：334
- status：implemented 33 / partial 67 / stub 19 / unsupported 215
- gap：low-risk 69 / needs-architecture 173 / out-of-scope 59 / null 33（null = implemented 专属）
- owner：运行时轨 144 / 宿主轨 83 / 分发轨 0 / 未排期 107

### status × owner

| status | 运行时轨 | 宿主轨 | 分发轨 | 未排期 | 合计 |
| --- | --- | --- | --- | --- | --- |
| implemented | 25 | 8 | 0 | 0 | 33 |
| partial | 59 | 8 | 0 | 0 | 67 |
| stub | 19 | 0 | 0 | 0 | 19 |
| unsupported | 41 | 67 | 0 | 107 | 215 |

## unsupported（215）——完全没导出或明确不做；插件调用会 TypeError 或走 undefined

| 符号 | kind | gap | owner | note |
| --- | --- | --- | --- | --- |
| `AbstractTextComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `AjaxOptions` | interface | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `Array` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `ArrayConstructor` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `BaseComponent` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `BasesAllOptions` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesConfigFile` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesConfigFileFilter` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesConfigFileView` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesDropdownOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesEntry` | class | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesEntryGroup` | class | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesFileOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesFolderOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesFormulaOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesMultitextOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesOptionGroup` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesOptions` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesProperty` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesPropertyId` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesPropertyOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesPropertyType` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesQueryResult` | class | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesSliderOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesSortConfig` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesTextOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesToggleOption` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesView` | abstract class | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesViewConfig` | class | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesViewFactory` | type | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BasesViewRegistration` | interface | `out-of-scope` | 未排期 | spec 第 9 节明确本轮不做 Bases 插件 API。 |
| `BlockCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `BlockSubpathResult` | interface | `needs-architecture` | 运行时轨 | 链接子路径（#标题 / #^块 / ^脚注）解析未实现，metadata.firstLink 只给目标文件。证据 H:metadata.firstLink |
| `BooleanValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ButtonComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `CapacitorAdapter` | class | `out-of-scope` | 未排期 | 无文件系统直访通道；spec 第 5 节要求一切文件操作走 vault 通道。 |
| `CliData` | interface | `out-of-scope` | 未排期 | 桌面 CLI 参数模型，移动端无 CLI 入口。 |
| `CliFlag` | interface | `out-of-scope` | 未排期 | 桌面 CLI 参数模型，移动端无 CLI 入口。 |
| `CliFlags` | type | `out-of-scope` | 未排期 | 桌面 CLI 参数模型，移动端无 CLI 入口。 |
| `CliHandler` | type | `out-of-scope` | 未排期 | 桌面 CLI 参数模型，移动端无 CLI 入口。 |
| `ColorComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `ConfirmationButton` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `ConfirmationModal` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `Constructor` | type | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `DataAdapter` | interface | `out-of-scope` | 未排期 | 类本身是 stub（stubClass，new 出来没有任何方法，也不可构造出可用实例）；但 vault.adapter 实例是真实现：exists/read/write/append/process/list/stat/remove/rename（目录存在性由 vault.files 路径前缀推导，readBinary/copy 仍 reject，stat 无 size/mtime 且如实返回 0）。真实插件（obsidian-text-format 等）依赖的是 vault.adapter，请直接用它而不是构造 DataAdapter。证据 W:adapter |
| `DataWriteOptions` | interface | `out-of-scope` | 未排期 | 无文件系统直访通道；spec 第 5 节要求一切文件操作走 vault 通道。 |
| `DateValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `DisplayValueComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `DropdownComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `DurationValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `EditableFileView` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `EditorCommandName` | type | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `EditorSuggest` | abstract class | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `EditorSuggestContext` | interface | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `EditorSuggestTriggerInfo` | interface | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `EmbedCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `ExtraButtonComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `FileSystemAdapter` | class | `out-of-scope` | 未排期 | 类本身是 stub（无 getBasePath/getFullPath/读写实现，不可构造）；移动端没有本地文件系统直访，一切文件访问走 vault.adapter 实例（能力见 DataAdapter）。证据 W:adapter |
| `FileValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `FileView` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `FootnoteCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `FootnoteRefCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `FootnoteSubpathResult` | interface | `needs-architecture` | 运行时轨 | 链接子路径（#标题 / #^块 / ^脚注）解析未实现，metadata.firstLink 只给目标文件。证据 H:metadata.firstLink |
| `FormulaContext` | interface | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `FrontMatterInfo` | interface | `low-risk` | 运行时轨 | frontmatter 边界信息（from/to/正文字符串）未导出，宿主只回传 parsed frontmatter 对象。证据 H:metadata.get |
| `FrontmatterLinkCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `HSL` | interface | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `HTMLValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `HeadingSubpathResult` | interface | `needs-architecture` | 运行时轨 | 链接子路径（#标题 / #^块 / ^脚注）解析未实现，metadata.firstLink 只给目标文件。证据 H:metadata.firstLink |
| `HexString` | type | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `HistoryHandler` | interface | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `Hotkey` | interface | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `HoverLinkSource` | interface | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `HoverParent` | interface | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `HoverPopover` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `ISuggestOwner` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `IconValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ImageValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `Instruction` | interface | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `KeymapContext` | interface | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `KeymapEventHandler` | interface | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `KeymapEventListener` | type | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `KeymapInfo` | interface | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `LinkValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ListItemCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `ListValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ListedFiles` | interface | `out-of-scope` | 未排期 | 无文件系统直访通道；spec 第 5 节要求一切文件操作走 vault 通道。 |
| `LivePreviewStateType` | interface | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `MarkdownEditView` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `MarkdownFileInfo` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `MarkdownPostProcessor` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `MarkdownPostProcessorContext` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `MarkdownPreviewEvents` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `MarkdownPreviewRenderer` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `MarkdownPreviewView` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `MarkdownSectionInformation` | interface | `needs-architecture` | 宿主轨 | 渲染后处理与编辑器 suggest 面缺失：registerMarkdownPostProcessor 只 console.warn、registerEditorSuggest 是空实现，源码已记录。证据 W:PluginShim |
| `MarkdownSubView` | interface | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `MarkdownViewModeType` | type | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `Math` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `MenuPositionDef` | interface | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `MenuSeparator` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `Modifier` | type | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `MomentFormatComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `NotNullValue` | abstract class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `NullValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `NumberConstructor` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `NumberValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ObjectConstructor` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `ObjectValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ObsidianProtocolData` | interface | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `ObsidianProtocolHandler` | type | `needs-architecture` | 未排期 | 协议回跳/悬浮预览/版本历史面未实现（registerObsidianProtocolHandler 当前是空实现）。 |
| `OpenViewState` | interface | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `PaneType` | type | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `Point` | interface | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `PopoverState` | enum | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `PopoverSuggest` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `PrimitiveValue` | abstract class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ProgressBarComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `QueryController` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `RGB` | interface | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `ReferenceLinkCache` | interface | `needs-architecture` | 运行时轨 | 宿主解析器未产出 blocks/listItems/embeds/footnotes/frontmatterLinks，对应段落会被插件当成空。证据 H:metadata.get |
| `RegExpValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `RelativeDateValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `RenderContext` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `SearchComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `SearchResult` | interface | `needs-architecture` | 未排期 | 搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。 |
| `SearchResultContainer` | interface | `needs-architecture` | 未排期 | 搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。 |
| `SecretComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `SecretStorage` | class | `needs-architecture` | 未排期 | 无凭据存储；manifest capabilities 也未定义 secret 能力。证据 W:PluginShim |
| `SettingGroup` | class | `needs-architecture` | 宿主轨 | 设置 2.0 的分组/分页容器未实现，宿主设置页仍是单页列表。 |
| `SettingGroupItem` | type | `needs-architecture` | 宿主轨 | 设置 2.0 的分组/分页容器未实现，宿主设置页仍是单页列表。 |
| `SettingPage` | abstract class | `needs-architecture` | 宿主轨 | 设置 2.0 的分组/分页容器未实现，宿主设置页仍是单页列表。 |
| `Side` | type | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `SliderComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `SplitDirection` | type | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `String` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `StringConstructor` | interface | `low-risk` | 宿主轨 | Obsidian 的原型补丁（Object.isEmpty/Array.combine/String.isString/Math.clamp 等）未安装，插件直接调用会抛 TypeError；在 installDomHelpers 里补即可。 |
| `StringValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `SubpathResult` | interface | `needs-architecture` | 运行时轨 | 链接子路径（#标题 / #^块 / ^脚注）解析未实现，metadata.firstLink 只给目标文件。证据 H:metadata.firstLink |
| `TExternalFile` | class | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `Tasks` | class | `out-of-scope` | 未排期 | Obsidian 内部任务队列，未导出；插件无并发调度入口。 |
| `TextAreaComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `TextComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `TextFileView` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `ToggleComponent` | class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `TooltipOptions` | interface | `needs-architecture` | 宿主轨 | tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。 |
| `TooltipPlacement` | type | `needs-architecture` | 宿主轨 | tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。 |
| `Touch` | interface | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `UIEvent` | interface | `low-risk` | 未排期 | 几何/颜色/事件补丁类型无运行时实现（UIEvent.targetNode/win/doc、Touch.touchType 未安装）。 |
| `UrlValue` | class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `UserEvent` | type | `needs-architecture` | 运行时轨 | 键位绑定未建立：commands.add 只透传 hotkeys，宿主无键位注册表。 |
| `Value` | abstract class | `out-of-scope` | 未排期 | Bases 公式值系统，随 Bases 一并排期（spec 第 9 节）。 |
| `ValueComponent` | abstract class | `needs-architecture` | 宿主轨 | Obsidian 的 UI 组件/DOM 视图类未移植；需宿主轨在常驻 Web 页提供 DOM 组件库（插件侧 addSettingTab 目前只能走声明式设置）。 |
| `ViewCreator` | type | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `ViewState` | interface | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `ViewStateResult` | interface | `needs-architecture` | 未排期 | 布局/视图状态/悬浮内部类型；宿主没有 pane 模型与视图状态持久化（spec 第 9 节排除多窗 split）。 |
| `WorkspaceContainer` | abstract class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceFloating` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceItem` | abstract class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceMobileDrawer` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceParent` | abstract class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceRibbon` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceRoot` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceSidedock` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceSplit` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceTabs` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceWindow` | class | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `WorkspaceWindowInitData` | interface | `needs-architecture` | 未排期 | 多 pane/页签布局模型未建立，spec 第 9 节排除多窗 split。 |
| `ajax` | function | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `ajaxPromise` | function | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `arrayBufferToBase64` | function | `low-risk` | 运行时轨 | 二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。 |
| `arrayBufferToHex` | function | `low-risk` | 运行时轨 | 二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。 |
| `base64ToArrayBuffer` | function | `low-risk` | 运行时轨 | 二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。 |
| `createSvg` | function | `low-risk` | 宿主轨 | Node.createSvg 未安装（installDomHelpers 只装了 HTML 侧），SVG 图标渲染会抛错。 |
| `displayTooltip` | function | `needs-architecture` | 宿主轨 | tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。 |
| `editorEditorField` | const | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `editorInfoField` | const | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `editorLivePreviewField` | const | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `editorViewField` | const | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `finishRenderMath` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `getAllTags` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `getBlobArrayBuffer` | function | `low-risk` | 运行时轨 | 二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。 |
| `getFrontMatterInfo` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `getLinkpath` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `hexToArrayBuffer` | function | `low-risk` | 运行时轨 | 二进制编解码工具未导出；宿主已有等价实现，补导出即可，属低风险缺口。 |
| `htmlToMarkdown` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `isBoolean` | function | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `iterateCacheRefs` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `iterateRefs` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `livePreviewState` | const | `needs-architecture` | 宿主轨 | 需 CM6 编辑器扩展/编辑器 suggest 面，宿主轨负责；registerEditorSuggest 目前是空实现。 |
| `loadMathJax` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `loadMermaid` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `loadPdfJs` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `loadPrism` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `nextFrame` | function | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `parseFrontMatterAliases` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `parseFrontMatterEntry` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `parseFrontMatterStringArray` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `parseFrontMatterTags` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `parseLinktext` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `parsePropertyId` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `ready` | function | `low-risk` | 宿主轨 | 全局工具函数未导出；可用 Promise/setTimeout/requestUrl 等价替代（ajax 已在官方废弃）。 |
| `renderMatches` | function | `needs-architecture` | 未排期 | 搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。 |
| `renderMath` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `renderResults` | function | `needs-architecture` | 未排期 | 搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。 |
| `request` | function | `low-risk` | 运行时轨 | 官方已废弃的 requestUrl 前身，未导出；迁移到 requestUrl 即可。证据 W:requestUrl |
| `requireApiVersion` | function | `low-risk` | 运行时轨 | 未导出，插件调用即 TypeError；且 apiVersion 恒 1.0.0，即便补上也会把 1.14.x 插件误判为高版本要求。证据 W:apiVersion |
| `resolveSubpath` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `sanitizeHTMLToDom` | function | `needs-architecture` | 未排期 | 数学/图表/PDF/语法高亮渲染管线未接入。 |
| `setTooltip` | function | `needs-architecture` | 宿主轨 | tooltip 机制未接入，元素 setAttribute(title) 可用但无 Obsidian 样式 tooltip。 |
| `sortSearchResults` | function | `needs-architecture` | 未排期 | 搜索结果 UI 与排序工具未移植（仅 prepareFuzzySearch 的 matcher 面已实现）。 |
| `stringifyYaml` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `stripHeading` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |
| `stripHeadingForLink` | function | `low-risk` | 运行时轨 | 纯字符串/YAML 工具未导出；宿主已有等价解析（LexiFrontmatter/MarkdownEngine），补导出即可，属低风险缺口。 |

## stub（19）——有导出、能构造，但内部空转或只打日志，插件以为成功实则无效果

| 符号 | kind | gap | owner | note |
| --- | --- | --- | --- | --- |
| `AbstractInputSuggest` | abstract class | `needs-architecture` | 运行时轨 | 别名到空 SuggestModal，未与输入框绑定。证据 W:SuggestModalShim |
| `EditorScrollInfo` | interface | `needs-architecture` | 运行时轨 | getScrollInfo 恒返回 0，无滚动同步。证据 W:EditorProxy |
| `FuzzySuggestModal` | abstract class | `needs-architecture` | 运行时轨 | getSuggestions 恒空数组，模糊匹配与渲染均未实现。证据 W:FuzzySuggestModal |
| `Keymap` | class | `needs-architecture` | 运行时轨 | 只导出 isModifier 且恒 false，键位注册表不存在。证据 W:Keymap |
| `MarkdownRenderer` | abstract class | `needs-architecture` | 运行时轨 | render/renderMarkdown 直接 reject（entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2191（`MarkdownRenderer`）），嵌入与代码块渲染未实现。obsidian-tasks 有 3 处真实调用点：fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:136（`MarkdownRenderer.render`）、fixture:markdown-postprocessor-tasks/src/Renderer/TaskLineRenderer.ts:85（`MarkdownRenderer.render`）、fixture:markdown-postprocessor-tasks/src/ui/QuickSearchTasksModal.ts:134（`MarkdownRenderer.render`）——查询结果块与每条任务行都走它，stub 等于 tasks 的列表渲染整体抛错，不是可拖项（夹具报告把 TaskLineRenderer 第 94 行也算一个调用点，但那行是 `renderMarkdown()` 的文档注释，不是调用）。证据 W:MarkdownRenderer |
| `MarkdownView` | class | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: 无（本仓无插件依赖该视图；宿主编辑器页承担正文编辑）。空构造（FileViewShim 子类，editor 与 previewMode 恒 null），无编辑/预览双模：打开即空白容器，无 Markdown 渲染管线、无预览滚动同步、无编辑态。证据 W:MarkdownView W:MarkdownViewShim members: MarkdownView, MarkdownViewShim members(excludes): editor, previewMode, onMarkdownContextMenu, onInternalDrop |
| `Menu` | class | `needs-architecture` | 运行时轨 | addItem 只收集 item，showAtMouseEvent 仅打印告警，不渲染菜单。证据 W:Menu |
| `MenuItem` | class | `needs-architecture` | 运行时轨 | addItem 回调拿到的 item 是内联空壳，setTitle/setIcon/setChecked 只返回 this。证据 W:Menu |
| `Modal` | class | `needs-architecture` | 运行时轨 | open() 只发 ui.placeholder（该通道当前无宿主处理器），titleEl/contentEl 恒 null，无 DOM 容器。证据 W:Modal |
| `PluginManifest` | interface | `low-risk` | 运行时轨 | 仅空构造占位；manifest 由宿主透传，插件侧无运行时校验。证据 W:PluginManifest |
| `Scope` | class | `needs-architecture` | 运行时轨 | 空构造，按键作用域与 register 未实现。证据 W:Scope |
| `Setting` | class | `needs-architecture` | 运行时轨 | setName/setDesc/addText 等全部空壳（回调收到空桩组件）；设置 UI 实际由 settings.register 声明式渲染。证据 W:Setting H:settings.register |
| `SettingTab` | abstract class | `needs-architecture` | 运行时轨 | 空构造占位，未接设置页。证据 W:SettingTab |
| `SuggestModal` | abstract class | `needs-architecture` | 运行时轨 | 继承空 Modal，无输入框、无候选列表、无键盘导航。证据 W:SuggestModalShim |
| `WorkspaceLeaf` | class | `needs-architecture` | 运行时轨 | 空构造；插件视图拿到的 leaf 是 makePluginLeaf 的假对象。证据 W:WorkspaceLeaf |
| `getIcon` | function | `low-risk` | 运行时轨 | 恒返回 null。证据 W:getIcon |
| `getIconIds` | function | `low-risk` | 运行时轨 | 恒返回空数组。证据 W:getIconIds |
| `removeIcon` | function | `low-risk` | 运行时轨 | 空函数。证据 W:removeIcon |
| `setIcon` | function | `low-risk` | 运行时轨 | 空函数，元素上不渲染图标。证据 W:setIcon |

## partial（67）——主路径通，但有明确缺失点（缺成员、返回值语义不同、只支持部分参数）

| 符号 | kind | gap | owner | note |
| --- | --- | --- | --- | --- |
| `App` | class | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: lexi-sample-plugin（本仓样例）、compat-probe（本仓探针）。vault/metadataCache/workspace/commands/fileManager/isDarkMode 已挂载；loadLocalStorage/saveLocalStorage 已通（app.localStorage.get/set，宿主落 filesDir/local-storage.json，读回自动 JSON.parse）；仍缺 setting/plugins/internalPlugins，keymap 与 scope 为 null 占位。证据 H:app.localStorage.get H:app.localStorage.set W:loadLocalStorage members: app.localStorage.get, app.localStorage.set, app.isDarkMode, loadLocalStorage, saveLocalStorage members(excludes): app.setting, app.plugins, app.internalPlugins, app.keymap, app.scope |
| `CacheItem` | interface | `needs-architecture` | 运行时轨 | 部分字段由 metadata.get 回填，但 references 聚合结构不完整、搜索命中位置无来源。证据 H:metadata.get |
| `CachedMetadata` | interface | `needs-architecture` | 运行时轨 | 产出 headings/links/tags/sections/frontmatter/frontmatterPosition；blocks/listItems/embeds/footnotes/references 未产出。证据 H:metadata.get |
| `Debouncer` | interface | `low-risk` | 运行时轨 | cancel 可用，run 未实现。证据 W:debounce |
| `Document` | interface | `low-risk` | 宿主轨 | 未装 Document.on/off 事件委托，_EVENTS 不存在。证据 W:installDomHelpers |
| `DocumentFragment` | interface | `low-risk` | 宿主轨 | Node 侧补丁可用，find/findAll 未安装。证据 W:installDomHelpers |
| `Editor` | abstract class | `needs-architecture` | 运行时轨 | 读写/选区/替换/transaction 已通；undo/redo/exec/processLines/wordAt/getScrollInfo 为桩，无 CM6 扩展面。证据 W:EditorProxy H:editor.replace H:editor.selection |
| `EditorChange` | interface | `needs-architecture` | 运行时轨 | 只透传 from/to/text，annotated ranges 丢弃。证据 W:EditorProxy |
| `Element` | interface | `low-risk` | 宿主轨 | 已装 getText/setText/addClass/addClasses/removeClass/removeClasses/toggleClass/hasClass/setAttr/setAttrs/getAttr；缺 matchParent/getCssPropertyValue/isActiveElement/find/findAll/findAllSelf。find/findAll 不是可选助手：obsidian-tasks 的后处理器第一步就是 fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:50（`element.findAll`），不装就在阅读视图渲染时直接 TypeError（installDomHelpers 定义在 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:151（`installDomHelpers`））。证据 W:installDomHelpers |
| `FileManager` | class | `low-risk` | 运行时轨 | generateMarkdownLink/renameFile 可用；processFrontMatter 直接 reject。证据 W:app |
| `FrontMatterCache` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `FrontmatterValue` | type | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `FuzzyMatch` | interface | `low-risk` | 运行时轨 | score/matches 字段存在，但与官方打分口径不同。证据 W:prepareFuzzySearch |
| `HTMLElement` | interface | `low-risk` | 宿主轨 | 已装 show/hide/toggle/setCssStyles/setCssProps/onClickEvent/on/off/trigger；缺 toggleVisibility/isShown/onNodeInserted/onWindowMigrated。证据 W:installDomHelpers |
| `HeadingCache` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `ItemView` | abstract class | `needs-architecture` | 运行时轨 | 视图槽内以 ItemViewShim 提供容器与 onOpen/onClose；缺 addAction/getViewType/getDisplayText 完整语义。证据 W:ItemViewShim |
| `LinkCache` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `MarkdownRenderChild` | class | `needs-architecture` | 运行时轨 | 基于 ComponentShim 的容器子节点，containerEl 为桩对象。证据 W:MarkdownRenderChildStub |
| `MetadataCache` | class | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。getFileCache/getCache/getFirstLinkpathDest/事件已通；仍缺 getBacklinksForFile/listLinks/unresolvedLinks（宿主只建正向链接索引，无反向链接表），产出无 blocks/listItems/embeds/footnotes、无 heading 层级 patch 信息；缓存只能按需单文件拉取，无全量预热。证据 H:metadata.get H:metadata.firstLink W:getCache members: metadata.get, metadata.firstLink, metadata.resolved, metadata.graph, getCache, getFileCache, getFirstLinkpathDest members(excludes): getBacklinksForFile, listLinks, unresolvedLinks, resolvedLinks |
| `Node` | interface | `low-risk` | 宿主轨 | 已装 createEl/createDiv/createSpan/appendText/detach/empty/setChildrenInPlace；缺 createSvg/insertAfter/indexOf/instanceOf。证据 W:installDomHelpers |
| `Notice` | class | `low-risk` | 运行时轨 | 构造即经 ui.notice 送达宿主；setMessage 不刷新已显示的提示、hide 为空实现。证据 H:ui.notice W:Notice |
| `PluginSettingTab` | abstract class | `needs-architecture` | 运行时轨 | display/hide 空实现，但 getSettingDefinitions 经 settings.register 下发宿主渲染；宿主仅支持 heading/toggle/text/textarea/dropdown/slider 六类。证据 H:settings.register W:PluginSettingTab |
| `Reference` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `ReferenceCache` | interface | `needs-architecture` | 运行时轨 | 部分字段由 metadata.get 回填，但 references 聚合结构不完整、搜索命中位置无来源。证据 H:metadata.get |
| `RequestUrlResponse` | interface | `low-risk` | 运行时轨 | status/headers/text/json 可用；arrayBuffer 缺失。证据 W:requestUrl H:net.requestUrl |
| `RequestUrlResponsePromise` | interface | `low-risk` | 运行时轨 | text/json 属性可用，arrayBuffer 恒 reject。证据 W:requestUrl |
| `SVGElement` | interface | `low-risk` | 宿主轨 | 只继承 Element 侧补丁，无 SvgElementInfo 的 setCssStyles/setCssProps。证据 W:installDomHelpers |
| `SearchMatchPart` | type | `needs-architecture` | 运行时轨 | 部分字段由 metadata.get 回填，但 references 聚合结构不完整、搜索命中位置无来源。证据 H:metadata.get |
| `SearchMatches` | type | `needs-architecture` | 运行时轨 | 部分字段由 metadata.get 回填，但 references 聚合结构不完整、搜索命中位置无来源。证据 H:metadata.get |
| `SectionCache` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `SettingColorControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingControl` | type | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingControlBase` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinition` | type | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionAction` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionAddItem` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionBase` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionEmpty` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionGroup` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionItem` | type | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionList` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionPage` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDefinitionRender` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingDropdownControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingFileControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingFolderControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingNumberControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingSecretControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingSliderControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingTextAreaControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingTextControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SettingToggleControl` | interface | `needs-architecture` | 运行时轨 | 定义经 settings.register 下发并由宿主 parseSettingDefinitions 解析；宿主只认 heading/toggle/text/textarea/dropdown/slider 六类，其余丢弃。证据 H:settings.register |
| `SvgElementInfo` | interface | `low-risk` | 宿主轨 | 属性映射已有，但 createSvg 未安装，SVG 元素仍建不出来。证据 W:applyInfo |
| `TAbstractFile` | abstract class | `low-risk` | 运行时轨 | 基类 LexiFileData 提供 path/name/vault，缺官方抽象语义（isRoot 等）。证据 W:LexiFileData |
| `TFolder` | class | `low-risk` | 运行时轨 | 字段齐全但 children 恒空，目录树未回填。证据 W:TFolder |
| `TagCache` | interface | `needs-architecture` | 运行时轨 | 宿主 metadata.get 已产出 headings/links/tags/sections/frontmatter 字段，字段集未与官方接口逐项对齐。证据 H:metadata.get |
| `TagValue` | class | `low-risk` | 运行时轨 | frontmatter 值原样透传，未见对多值标签归一化的处理。证据 H:metadata.get |
| `Vault` | class | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。read/modify/create/append/delete/rename/files/getByPath 已通；getFileByPath 也已通：shim 在 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:893（`getFileByPath`） 基于宿主回传的文件索引缓存同步返回 TFile，宿主处理器用 entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:2078（`manager.vault.getFileByPath`） 解析（obsidian-tasks 有 3 处依赖：fixture:markdown-postprocessor-tasks/src/Obsidian/File.ts:202（`getFileByPath`）、fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:83（`getFileByPath`）、fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:76（`getFileByPath`））；adapter 已实现（exists/read/write/append/process/list/stat/remove/rename，目录存在性由 vault.files 路径前缀推导，stat 无 size/mtime 时如实返回 0）；仍缺 getName/configDir，createBinary/readBinary 直接 reject，getAbstractFileByPath 已改成同步（entry/src/main/resources/rawfile/lexinote_plugin_shim.js:892（`getAbstractFileByPath`），内部走 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:866（`knownAbstractFile`），目录按「有笔记落在该前缀下」合成 TFolder，传空串得 vault 根）。证据 H:vault.read H:vault.files W:adapter members: vault.read, vault.files, vault.create, vault.modify, vault.append, vault.delete, vault.rename, vault.getByPath, adapter, getFileByPath, getFolderByPath, getAbstractFileByPath, knownAbstractFile, getMarkdownFiles members(excludes): getName, configDir, createBinary, readBinary, copy |
| `View` | abstract class | `needs-architecture` | 运行时轨 | 视图槽映射到 ItemViewShim，内核上下文映射到 ComponentShim，无 containerEl/leaf 语义。证据 W:ItemViewShim |
| `Window` | interface | `low-risk` | 宿主轨 | 已装 activeDocument/activeWindow/createEl/createDiv/createSpan/createFragment/fish/fishAll；缺 window.sleep/window.nextFrame。证据 W:installDomHelpers |
| `Workspace` | class | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）、lexi-sample-plugin（本仓样例）。openView/closeView/事件、getActiveFile/getActiveViewOfType/getLeavesOfType、iterateAllLeaves/iterateRootLeaves/getMostRecentLeaf、openLinkText（宿主经 metadata.getFirstLinkpathDest 解析后触发 file-open）均已通；onLayoutReady 也已实现，宿主在 entry/src/main/ets/core/plugin/LexiPluginRuntime.ets:1880（`workspace.onLayoutReady`） 注册处理器、旧宿主路径直接放行——夹具报告把它算成「矩阵未收录」是符号级 vs 成员级的口径差（它没有独立顶层符号），不是缺实现；obsidian-tasks 拿它当首屏闸门（3 处）：fixture:markdown-postprocessor-tasks/src/Obsidian/InlineRenderer.ts:32（`onLayoutReady`）、fixture:markdown-postprocessor-tasks/src/Renderer/QueryRenderer.ts:45（`onLayoutReady`）、fixture:markdown-postprocessor-tasks/src/Obsidian/Cache.ts:101（`onLayoutReady`）；仍缺 splitLeaf/createLeafBySplit/getLayout 布局树，revealLeaf 只 resolve 不切页，getLeaf/getRightLeaf 返回新建子叶而非宿主真实 pane。证据 H:workspace.openLinkText H:workspace.onLayoutReady W:iterateAllLeaves W:getMostRecentLeaf members: workspace.openLinkText, workspace.openView, workspace.closeView, workspace.onLayoutReady, workspace.layoutReady, workspace.loadLayout, workspace.saveLayout, openLinkText, iterateAllLeaves, iterateRootLeaves, getMostRecentLeaf, getLeavesOfType, getActiveFile, getActiveViewOfType, revealLeaf members(excludes): splitLeaf, createLeafBySplit, getLayout, getLeaf, getRightLeaf, activeLeaf |
| `apiVersion` | let | `low-risk` | 运行时轨 | 值为 1.0.0，而契约基线是 1.14.4，requireApiVersion 会误判低版本并让插件走降级分支。证据 W:apiVersion |
| `getLanguage` | function | `low-risk` | 运行时轨 | 视图侧恒返回 zh，未读系统语言。证据 W:getLanguage |
| `moment` | const | `needs-architecture` | 运行时轨 | [截至 2026-11-01 @ 48f164a] 覆盖插件: obsidian-calendar-plugin（rawfile/plugins/calendar）。本项目 moment 是 MiniMoment 子集，不是完整 moment：实例侧已通 format/add/subtract/startOf/endOf/diff/unix/valueOf/toDate/toISOString/clone/isValid/isBefore/isAfter/isSame/isSameOrBefore/isSameOrAfter/calendar/locale/localeData/utc/local 与七个取值设值字段、day/weekday/isoWeekday/week/dayOfYear/daysInMonth；静态侧已通 moment(input)/isMoment/utc/unix/now/locale/localeData/updateLocale/defineLocale/locales/months/monthsShort/weekdays/weekdaysShort/weekdaysMin。这些是按 calendar 的真实调用逐条补齐的，不是按 moment 文档铺开：format 只认 YYYY/YY/MMMM/MMM/MM/M/DD/D/Do/dddd/ddd/dd/HH/H/hh/mm/ss/SSS/A/a，diff 只能按毫秒/秒/分/时/天，calendar 恒返回 YYYY-MM-DD 而非今天/昨天文案，locale 与 localeData 恒报 zh-cn。换一个用到未覆盖 API 的插件会在使用处直接抛 TypeError（xxx is not a function），装载期不会提示。宿主必须提供全局 window.moment：obsidian-tasks 产物里 43 处 moment( 调用点（夹具 API 面报告口径；我直接数其 main.js 得 51 处 window.moment 字面量、TS 源 49 处），既不内联 moment 也不 require("moment")，tools/workspace-bundle/node_modules 里也没有 moment——现在靠 entry/src/main/resources/rawfile/lexinote_plugin_shim.js:1544（`window.moment`） 把 MiniMoment 挂成全局兜住，所以那 43 处调用实际落在 MiniMoment 子集上，MiniMoment 没覆盖的写法同样会在使用处 TypeError。证据 W:MiniMoment W:moment members: format, add, subtract, startOf, endOf, diff, unix, calendar, localeData, isoWeekday, daysInMonth, updateLocale, defineLocale, locales, monthsShort, weekdaysMin, clone, toDate, toObject, isValid members(excludes): tz, duration, fromNow, toNow, toJSON, utcOffset, isDST, parseZone |
| `prepareFuzzySearch` | function | `low-risk` | 运行时轨 | 仅做小写包含匹配，score 为命中下标，与官方打分/分词不同。证据 W:prepareFuzzySearch |
| `prepareSimpleSearch` | function | `low-risk` | 运行时轨 | 直接复用 fuzzy 实现，非官方 SimpleSearch 语义。证据 W:prepareSimpleSearch |

## implemented（33）——官方签名上的主要用途可用，插件按文档写就能跑通

| 符号 | kind | gap | owner | note |
| --- | --- | --- | --- | --- |
| `Command` | interface | — | 运行时轨 | id/name/icon/checkCallback/callback/editorCallback 原样存入 commandTable 并上报宿主。证据 H:commands.add W:PluginShim |
| `Component` | class | — | 运行时轨 | load/unload/register/registerEvent/registerDomEvent/registerInterval/addChild/removeChild 均已实现。证据 W:ComponentShim |
| `DomElementInfo` | interface | — | 宿主轨 | cls/text/title/placeholder/href/value/attr 均由 applyInfo 落地。证据 W:applyInfo |
| `EditorPosition` | interface | — | 运行时轨 | pos↔offset 双向换算已实现。证据 W:EditorProxy |
| `EditorRange` | interface | — | 运行时轨 | from/to 参与 replaceRange/getRange。证据 W:EditorProxy |
| `EditorRangeOrCaret` | interface | — | 运行时轨 | to 缺省时折叠为 from。证据 W:EditorProxy |
| `EditorSelection` | interface | — | 运行时轨 | anchor/head 映射到宿主选区并经 editor.selection 回写。证据 W:EditorProxy H:editor.selection |
| `EditorSelectionOrCaret` | interface | — | 运行时轨 | 按 anchor/head 归一化，缺 head 时折叠为单点。证据 W:EditorProxy |
| `EditorTransaction` | interface | — | 运行时轨 | changes+selections 合成一帧经 editor.applyChanges 提交。证据 W:EditorProxy H:editor.applyChanges |
| `EventListenerInfo` | interface | — | 宿主轨 | 委托监听记录在 __delegated 上。证据 W:delegatedOn |
| `EventRef` | interface | — | 运行时轨 | 引用对象带 off()，可直接交给 Component.registerEvent。证据 W:makeHostRef |
| `Events` | class | — | 运行时轨 | on/off/trigger 本地实现，宿主事件经 events.on/events.off 订阅并按 topic 派发。证据 W:LocalEmitter H:events.on H:events.off |
| `FileStats` | interface | — | 运行时轨 | ctime/mtime/size 由 vault.* 响应回传并写入 file.stat。证据 H:vault.files |
| `IconName` | type | — | 运行时轨 | 字符串别名，addIcon 接受任意值并原样上报。证据 H:ui.addIcon |
| `Loc` | interface | — | 运行时轨 | line/col/offset 由 lineOffsets 计算。证据 W:lineOffsets |
| `Platform` | const | — | 运行时轨 | 移动端常量表（isMobile/isPhone/isAndroidApp=false 等需与真机核对）。证据 W:Platform |
| `Plugin` | abstract class | — | 运行时轨 | 生命周期、命令、Ribbon、设置页、视图注册、代码块处理器、数据读写均已接通。证据 H:commands.add H:data.load W:PluginShim |
| `Pos` | interface | — | 运行时轨 | line/ch 由 offsetToPos 产出，与 Editor 共用。证据 W:offsetToPos |
| `RequestUrlParam` | interface | — | 运行时轨 | url/method/headers/body 透传宿主。证据 H:net.requestUrl |
| `Stat` | interface | — | 运行时轨 | 与 FileStats 同源，宿主回传 ctime/mtime/size。证据 H:vault.files |
| `TFile` | class | — | 运行时轨 | path/name/basename/extension/stat/noteId 由宿主回传填充并缓存为单例。证据 W:TFile H:vault.getByPath |
| `addIcon` | function | — | 运行时轨 | 转发宿主图标注册。证据 H:ui.addIcon |
| `createDiv` | function | — | 宿主轨 | 继承 createEl 的 div 快捷方式。证据 W:createDiv |
| `createEl` | function | — | 宿主轨 | 视图页以 installDomHelpers 安装 Node.createEl 并挂 window.createEl。证据 W:createEl |
| `createFragment` | function | — | 宿主轨 | DocumentFragment + 回调。证据 W:createFragment |
| `createSpan` | function | — | 宿主轨 | 继承 createEl 的 span 快捷方式。证据 W:createSpan |
| `debounce` | function | — | 运行时轨 | 含 cancel，run 为空实现。证据 W:debounce |
| `fish` | function | — | 宿主轨 | querySelector 包装。证据 W:fish |
| `fishAll` | function | — | 宿主轨 | querySelectorAll 转数组。证据 W:fishAll |
| `normalizePath` | function | — | 运行时轨 | 统一分隔符并去掉重复/首尾斜杠。证据 W:normalizePath |
| `parseYaml` | function | — | 运行时轨 | 视图侧自实现 YAML 子集解析（标量/行内数组/嵌套键）。证据 W:parseYaml |
| `requestUrl` | function | — | 运行时轨 | 身份与能力双门禁：宿主按插件令牌反查身份（无令牌/令牌归属不符一律 fail-closed 且不触网），并要求清单声明 capability.net 且 host 在列；放行后 GET/POST + headers/body 透传，2xx 与非 2xx 都原样回包，超时报 net_timeout。arrayBuffer 仍恒 reject（占位 promise）。证据 W:requestUrl H:net.requestUrl |
| `sleep` | function | — | 运行时轨 | setTimeout Promise。证据 W:sleep |

