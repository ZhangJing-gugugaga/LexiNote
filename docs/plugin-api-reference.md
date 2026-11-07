# LexiNote 插件 API 参考（自动生成）

> 生成器：`tools/plugin-contract/generators/gen-api-reference.cjs`；真源：`tools/plugin-contract/api-surface.json`。勿手改本文件。
> API 版本：**1.0.0**（与宿主 PLUGIN_API_VERSION / shim API_VERSION 三方一致，门禁钉死）。

kind 为授权矩阵类别（见 `capability-map.json` 与 `LexiPermissionBroker`）；roles 为允许角色。

## app

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `app.isDarkMode` | public | host/session/plugin/anonymous | stable | ✓ |  |
| `app.localStorage.get` | ui-domain | session/plugin | stable | ✓ |  |
| `app.localStorage.set` | ui-domain | session/plugin | stable | ✓ |  |
| `channel.auth` | public | host/session/plugin/anonymous | stable |  | ✓ |
| `channel.hello` | public | host/session/plugin/anonymous | stable |  | ✓ |
| `debug.delay` | control-plane | session | stable | ✓ |  |
| `demo.ping` | demo-plugin | plugin | stable |  | ✓ |
| `demo.ready` | demo-plugin | plugin | stable |  | ✓ |
| `log.event` | public | host/session/plugin/anonymous | stable |  | ✓ |
| `runtime.ready` | public | host/session/plugin/anonymous | stable | ✓ |  |

## commands

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `commands.add` | register | plugin | stable | ✓ |  |
| `commands.execute` | ui-domain | session/plugin | stable | ✓ |  |
| `commands.list` | ui-domain | session/plugin | stable | ✓ |  |
| `commands.remove` | plugin-owned | session/plugin | stable | ✓ |  |

## editor

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `editor.applyChanges` | editor-write | plugin | stable | ✓ |  |
| `editor.replace` | editor-write | plugin | stable | ✓ |  |
| `editor.selection` | editor-write | plugin | stable | ✓ |  |
| `editor.state` | fs-read | session/plugin | stable | ✓ |  |

## events

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `events.off` | plugin-owned | session/plugin | stable | ✓ |  |
| `events.on` | ui-domain | session/plugin | stable | ✓ |  |

## markdown

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `codeblocks.register` | register | plugin | stable | ✓ |  |
| `codeblocks.unregister` | plugin-owned | session/plugin | stable | ✓ |  |

## metadata

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `metadata.firstLink` | fs-read | session/plugin | stable | ✓ |  |
| `metadata.get` | fs-read | session/plugin | stable | ✓ |  |
| `metadata.getAllProperties` | fs-read | session/plugin | stable | ✓ |  |
| `metadata.graph` | fs-read | session/plugin | stable | ✓ |  |
| `metadata.resolved` | fs-read | session/plugin | stable | ✓ |  |

## network

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `net.requestUrl` | net | plugin | stable | ✓ |  |

## plugin

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `plugin.list` | control-plane | session | stable |  | ✓ |
| `plugin.load` | control-plane | session | stable |  | ✓ |
| `plugin.onload.done` | public | host/session/plugin/anonymous | stable | ✓ |  |
| `plugin.onload.error` | public | host/session/plugin/anonymous | stable | ✓ |  |
| `plugin.sourceChunk` | plugin-source | plugin | stable | ✓ |  |
| `plugin.sourceSize` | plugin-source | plugin | stable | ✓ |  |
| `plugin.unload` | control-plane | session | stable |  | ✓ |
| `plugin.unload.done` | public | host/session/plugin/anonymous | stable | ✓ |  |

## storage

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `data.load` | plugin-storage | plugin | stable | ✓ |  |
| `data.save` | plugin-storage | plugin | stable | ✓ |  |

## theme

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `theme.config` | control-plane | session | stable |  | ✓ |
| `theme.install` | control-plane | session | stable |  | ✓ |
| `theme.list` | control-plane | session | stable |  | ✓ |
| `theme.load` | control-plane | session | stable |  | ✓ |
| `theme.setActive` | control-plane | session | stable |  | ✓ |

## ui

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `settings.register` | register | plugin | stable | ✓ |  |
| `settings.unregister` | register | plugin | stable | ✓ |  |
| `ui.addIcon` | ui-domain | session/plugin | stable | ✓ |  |
| `ui.addRibbon` | ui-domain | session/plugin | stable | ✓ |  |
| `ui.notice` | ui-domain | session/plugin | stable | ✓ |  |
| `ui.placeholder` | ui-domain | session/plugin | stable | ✓ |  |
| `ui.removeRibbon` | ui-domain | session/plugin | stable | ✓ |  |

## vault

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `vault.append` | fs-write | plugin | stable | ✓ |  |
| `vault.create` | fs-write | plugin | stable | ✓ |  |
| `vault.delete` | fs-write | plugin | stable | ✓ |  |
| `vault.files` | fs-read | session/plugin | stable | ✓ |  |
| `vault.getByPath` | fs-read | session/plugin | stable | ✓ |  |
| `vault.modify` | fs-write | plugin | stable | ✓ |  |
| `vault.read` | fs-read | session/plugin | stable | ✓ |  |
| `vault.rename` | fs-write | plugin | stable | ✓ |  |

## workspace

| 方法 | kind | 角色 | status | 宿主处理器 | 桥面 |
|---|---|---|---|---|---|
| `views.add` | register | plugin | stable | ✓ |  |
| `views.remove` | plugin-owned | session/plugin | stable | ✓ |  |
| `workspace.closeView` | plugin-owned | session/plugin | stable | ✓ |  |
| `workspace.layoutReady` | public | host/session/plugin/anonymous | stable | ✓ | ✓ |
| `workspace.loadLayout` | control-plane | session | stable | ✓ |  |
| `workspace.onLayoutReady` | public | host/session/plugin/anonymous | stable | ✓ | ✓ |
| `workspace.openLinkText` | ui-domain | session/plugin | stable | ✓ |  |
| `workspace.openView` | ui-domain | session/plugin | stable | ✓ |  |
| `workspace.saveLayout` | control-plane | session | stable | ✓ |  |

