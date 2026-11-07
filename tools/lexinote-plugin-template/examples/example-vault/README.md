# example-vault — Vault 面示例(P3-007)

演示 LexiNote 插件的 **Vault 面**:文件枚举(`getMarkdownFiles`)、按路径取文件
(`getAbstractFileByPath`)、读(`read`)、建(`create`)、改(`modify`)、读改组合
(`process`),以及工具面 `normalizePath` / `moment`。

## 运行轨面与边界(诚实声明)

- `track: sandbox` — 清单声明 `entrypoints.service: "sandbox:"`,沙箱轨可装载;legacy
  轨(默认开启)同样可装载。
- `faces: all-real` — 上述 vault 六个方法 + `normalizePath` + `moment().format` 在沙箱轨
  均已实现(经宿主 RPC 门禁:`vault.files/getByPath/read/create/modify`)。
- **写路径白名单(P2-004)**:manifest 声明 `vault.write.paths: ["插件笔记/"]`——白名单外
  路径宿主直接拒绝(fail-closed,`capability.path … allowed=false`)。示例命令只写白名单
  内路径;README 附带的注释负例可打开验证拒绝路径。
- vault 事件投递(`vault.on('modify')` 等)在沙箱轨尚未接入(登记返回注销句柄,无回调)——
  本例**不使用**事件面。

## manifest 能力对账

| 代码面 | manifest capabilities |
| --- | --- |
| `getMarkdownFiles` / `getAbstractFileByPath` / `read` | `vault.read: { enabled: true, paths: [] }` |
| `create` / `modify` / `process` | `vault.write: { enabled: true, paths: ["插件笔记/"] }` |
| `addCommand` | `workspace.commands: true` |
| `Notice` | `notifications: true` |

## CLI 构建校验(离线,真实 CLI)

```bash
lexi plugin validate examples/example-vault
lexi plugin build    examples/example-vault    # CJS → lexi-iife:v1 自执行包装
lexi plugin inspect  examples/example-vault    # 授权标签应含 vault.write
lexi plugin pack     examples/example-vault
```

门禁:`scripts/tests/plugin-examples.cjs` 对本例跑同一条链,并以沙箱轨面清单
(自宿主 `lexinote_plugin_sandbox.html` 提取)做 onload 行为级 boot 校验。
