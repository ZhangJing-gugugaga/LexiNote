# example-ui — 交互面示例(R37/P4-001 + R41/P4-002)

演示 LexiNote 插件的**四条交互面**:Modal(宿主原生弹层)、Menu(宿主原生菜单)、
Setting Builder(声明式设置控件收集 → 宿主设置页原生渲染)、
EditorSuggest(编辑器锚定的建议浮层,点选按 index 回取原值)。

## 运行轨面与边界(诚实声明)

- `track: sandbox` — 清单声明 `entrypoints.service: "sandbox:"`,沙箱轨
  (opaque-origin iframe)装载。
- `faces: all-real` — 本例用到的每一个 API 面在沙箱轨均已实现(P4-001/P4-002):
  `addCommand`、`Modal`(open/close + setTitle/setContent + onClose)、
  `Menu`(addItem/addSeparator/showAtPosition/hide + onClick/onHide)、
  `Setting` Builder(setName/setDesc/addToggle/addText/addTextArea/addDropdown/addSlider
  + setValue/getValue/setPlaceholder/setLimits/addOption/onChange + setKey)、
  `EditorSuggest`(constructor(app)/open/close/setSuggestions/setInstructions +
  onTrigger/getSuggestions/selectSuggestion/renderSuggestion)、
  `PluginSettingTab`(display/onSettingsChanged/setControlValue)、`addSettingTab`、
  `Notice`、`loadData`/`saveData`。
- 端口链纪律:iframe 不持有任何宿主 DOM/UI 句柄——交互面以**内容描述符**经既有
  request 链出站(`ui.modal.open` / `ui.menu.show` / `ui.suggest.show` /
  `settings.register`),宿主以原生组件渲染;用户关闭/点选/设置值变更经容器回推帧
  (`sandbox.ui`)回流 iframe,插件侧回调(onClose/onClick/onHide/selectSuggestion/
  控件 onChange/onSettingsChanged)与 Promise 在那里兑现。Suggest 的建议值本身
  **不出 iframe**:`ui.suggest.show` 只带显示描述符 `{index,title,detail,icon}`,
  宿主点选只回 `itemId=index`,原值由插件侧值表回取。
- **能力对账**:`ui.modal.*`/`ui.menu.*`/`ui.suggest.*` 与 Notice 同属
  `notifications` 能力域(清单未声明则宿主拒绝,fail-visible);`settings.register`
  按 register 类别落账(身份绑定);设置值持久化走 `data.json`(`storage` 域)。
- 设置寻址键:`setKey('…')` 是 LexiNote 声明式机制的 key(Obsidian Setting 本无 key);
  缺 key 的数据控件不进声明式定义(按钮类本就无 key)。
- Suggest 触发形态:宿主没有编辑器事件流,触发 = 显式 `open(editor)`(本例静态
  trigger);编辑器命令里可从 `editor` 快照光标派生 query(见夹具 sandbox-ui-min 的
  `ui-suggest`)。浮层锚点按宿主钳制默认位置呈现,光标级精确锚定归设备批次校准。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `addCommand` | `workspace.commands: true` |
| `Modal`/`Menu`/`EditorSuggest` 打开 | `notifications: true`(与 Notice 同域) |
| `addSettingTab`/`Setting` Builder | `settings.register`(register 类别,身份绑定) |
| `loadData`/`saveData`(设置值真源) | `storage`(示例配额 `quotaBytes: 16384`) |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-ui
lexi plugin build    examples/example-ui   # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-ui
lexi plugin pack     examples/example-ui
```

门禁:`scripts/tests/plugin-examples.cjs` 对本例跑同一条链并做沙箱严格面对账
(destructure 成员 ⊆ 宿主 `lexinote_plugin_sandbox.html` 真实面)+ boot 后命令回调
行为级执行(stub 世界里 Modal.open/Menu.showAtPosition/EditorSuggest.open 计数)。
真机验收(弹层/菜单/建议浮层出现 + 用户操作回流)归设备批次 P4-005。
