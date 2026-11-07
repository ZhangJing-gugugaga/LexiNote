# example-ui — 交互面示例(R37/P4-001)

演示 LexiNote 插件的**三条交互面**:Modal(宿主原生弹层)、Menu(宿主原生菜单)、
Setting Builder(声明式设置控件收集 → 宿主设置页原生渲染)。

## 运行轨面与边界(诚实声明)

- `track: sandbox` — 清单声明 `entrypoints.service: "sandbox:"`,沙箱轨
  (opaque-origin iframe)装载。
- `faces: all-real` — 本例用到的每一个 API 面在沙箱轨均已实现(P4-001):
  `addCommand`、`Modal`(open/close + setTitle/setContent + onClose)、
  `Menu`(addItem/addSeparator/showAtPosition/hide + onClick/onHide)、
  `Setting` Builder(setName/setDesc/addToggle/addText/addTextArea/addDropdown/addSlider
  + setValue/getValue/setPlaceholder/setLimits/addOption/onChange + setKey)、
  `PluginSettingTab`(display/onSettingsChanged/setControlValue)、`addSettingTab`、
  `Notice`、`loadData`/`saveData`。
- 端口链纪律:iframe 不持有任何宿主 DOM/UI 句柄——交互面以**内容描述符**经既有
  request 链出站(`ui.modal.open` / `ui.menu.show` / `settings.register`),宿主以原生
  组件渲染;用户关闭/点选/设置值变更经容器回推帧(`sandbox.ui`)回流 iframe,插件侧
  回调(onClose/onClick/onHide/控件 onChange/onSettingsChanged)与 Promise 在那里兑现。
- **能力对账**:`ui.modal.*`/`ui.menu.*` 与 Notice 同属 `notifications` 能力域(清单未
  声明则宿主拒绝,fail-visible);`settings.register` 按 register 类别落账(身份绑定);
  设置值持久化走 `data.json`(`storage` 域)。
- 设置寻址键:`setKey('…')` 是 LexiNote 声明式机制的 key(Obsidian Setting 本无 key);
  缺 key 的数据控件不进声明式定义(按钮类本就无 key)。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `addCommand` | `workspace.commands: true` |
| `Modal`/`Menu` 打开 | `notifications: true`(与 Notice 同域) |
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
行为级执行(stub 世界里 Modal.open/Menu.showAtPosition 计数)。真机验收(弹层/菜单
出现 + 用户操作回流)归设备批次 P4-005。
