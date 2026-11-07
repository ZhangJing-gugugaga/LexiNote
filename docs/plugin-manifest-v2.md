# 插件 Manifest v2 指南

> 契约真源：`tools/plugin-contract/schema/manifest-v2.schema.json`；解析器：`LexiPluginManifestV2.ets`（严格模式）。

## 必填字段

`manifestVersion: 2`、`id`（小写字母/数字/连字符）、`name`、`version`（x.y.z）、`author`。

## 能力声明（capabilities）

未声明能力 = 没有能力。**不认识的 capability 会被拒绝**（顶层与嵌套同罚），可用键：
`vault`（read/write/delete，write 支持 paths 白名单）、`editor`（readActive/writeSelection/
writeDocument/extensions: none|declarative|trusted-cm6）、`workspace`（commands/views）、
`network`（origins/methods/限额）、`clipboard`、`storage`（quotaBytes）、`notifications`。

## 禁止事项

- manifest 不得携带自身 `sha256`——完整性指纹归签名 Registry Target Metadata（§8.1）。
- 未知顶层字段/未知 entrypoint/未知 platform 一律拒绝（fail-closed）。

## v1 → v2 迁移

`minAppVersion→compatibility.obsidianApiLevel`、`fs→vault.write`、`network[]→origins`、
`clipboard→clipboard`、`isDesktopOnly→platforms`。迁移产物带 `legacyProfile=true`：
宿主沿用 legacy 语义，旧权限不自动继承为 Native 权限（升级引入新权限必须重新授权，见 §9.5）。

## 验证

`lexi plugin validate <dir>`（与宿主同一解析器）。
