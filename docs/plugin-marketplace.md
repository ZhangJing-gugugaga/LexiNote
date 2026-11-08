# 插件市场与发布

- **索引**：社区索引走 v1 schema（`market-index-v1.schema.json`），条目必须携带 64 位十六进制
  sha256；重复 id 拒绝。
- **发布**：`lexi plugin pack`（zip+sha256）→ `lexi plugin sign`（开发缝 HMAC；生产签名归
  服务侧/TUF）→ `lexi plugin publish`（产出 targets 元数据，形状经 `LexiRegistryTrust`
  verifyPackageTarget 校验）。
- **信任链**：root→timestamp→snapshot→targets；客户端验证新鲜度/一致性/防回滚；
  撤销表（`pluginId@version` / `pluginId@*`）命中即下架。
- **版本不可变**：同一 pluginId+version 不允许替换不同字节；降级安装默认拒绝。
- **权限变化**：升级新增权限时用户必须再次授权（`ERR_PERMISSION_REGRANT_REQUIRED`）。
