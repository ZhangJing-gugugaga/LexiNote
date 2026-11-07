# 插件开发指南

## 快速开始

```bash
lexi plugin create my-plugin   # 脚手架（manifest v2 + main.js + README + styles.css）
lexi plugin validate my-plugin # 与宿主同一解析器校验
lexi plugin dev my-plugin      # validate+build 单次；--watch 监视循环（改动即重跑）
lexi plugin test my-plugin     # 运行 <proj>/test|tests/*.cjs|js（真退出码汇总）
lexi plugin inspect my-plugin  # manifest/入口/打包面摘要（--json 机器面）
lexi plugin doctor my-plugin   # 环境体检：node/ts/宿主 shim/解析器/契约快照/zip-store
lexi plugin compatibility my-plugin # API 版本对账+能力标签（SDK 单一真源）+CM 矩阵
lexi plugin build my-plugin    # CJS→IIFE 包装（lexi-iife:v1，ADR-R25-01）
lexi plugin pack my-plugin     # zip + sha256
```

## 导入

```ts
import { Plugin, Notice } from 'lexinote';       // 或
const { Plugin, Notice } = require('obsidian');   // 兼容别名
```

类型面见 `packages/lexinote-plugin-sdk/types/lexinote.d.ts`（与宿主实现对账）；
方法全集与授权类别见 `packages/lexinote-plugin-sdk/schema/api-surface.json`。

## 生命周期

`onload()` 每次激活只触发一次（宿主幂等早退）；`onunload()` 逆序释放
children→intervals→cleanups→注册的扩展/后处理器；注册的一切资源随插件停用全量回收。

## 存储

`loadData()/saveData()` 写入插件私有 `data.json`（他人不可达）；vault 写入需要
`capabilities.vault.write` 声明；`getByPath → modify` 自动携带 revision 乐观锁
（并发冲突返回 `vault_conflict`，重读后重试）。

## 网络

仅允许声明过的 origins（`capabilities.network`），强制走宿主 RPC（`requestUrl`）；
页面自身 CSP `connect-src 'none'`。
