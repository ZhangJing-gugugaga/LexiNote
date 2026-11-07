# 插件安全模型

> 权威条目见 RFC §3/§12；本文是开发者视角摘要。

- **身份**：所有 RPC 凭据由宿主 CSPRNG 铸造（256bit），未知凭据一律 anonymous fail-closed；
  调用方字符串不作身份（P0-01 修复）。会话令牌只进不出（插件读不到原值）。
- **授权矩阵**：每个 RPC 方法登记在 `LexiPermissionBroker`（12 类，默认拒绝），
  `ERR_UNAUTHORIZED`（角色）与 `ERR_PERMISSION_DENIED`（权限/归属）区分；跨插件删除资源一律拒绝。
- **能力声明**：v2 manifest 未声明即无能力；升级新增权限必须重新授权；用户可撤销。
- **安装安全**：路径穿越/符号链接/重复路径/超预算/压缩炸弹/非预期二进制全拒
  （`LexiPackageVerifier`）；完整性 `ERR_HASH_MISMATCH`；发布者签名 `ERR_SIGNATURE_INVALID`。
- **分发信任链**：root→timestamp→snapshot→targets 四角色（TUF 风格），撤销表命中即整链拒绝。
- **沙箱**：插件执行上下文 opaque origin + CSP connect-src 'none'，唯一宿主入口为专属
  MessagePort；错误码统一 §12.3（ERR_PERMISSION_DENIED / ERR_PLUGIN_CRASH / …）。
