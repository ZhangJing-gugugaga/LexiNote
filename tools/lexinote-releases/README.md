# lexinote-releases

LexiNote 社区插件索引仓库。**自 P5-001/P5-006 起采用严格 schemaVersion=1 口径**——
裸数组旧形状(obsidian-releases 同构格式)在本仓库永久停用:客户端对旧形状仅兼容展示,
安装口一律拒绝缺少受信任哈希的条目(RFC LEXI-RFC-PLUGIN-001 §8.5/§18.4)。

## 索引格式(唯一真源 `community-plugins.json`)

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "example-plugin", "name": "Example", "version": "1.0.0",
      "author": "Example Developer", "description": "…", "repo": "owner/example-plugin",
      "sha256": "<64 位小写十六进制,zip 字节实测>",
      "zipUrl": "https://raw.githubusercontent.com/ZhangJing-gugugaga/lexinote-releases/master/zips/example-plugin.zip",
      "minApiVersion": "1.0.0", "isDesktopOnly": false,
      "capabilities": { "network": ["api.example.com"], "fs": true, "clipboard": false }
    }
  ]
}
```

- `sha256` 必填且必须是 zip 实际字节指纹——客户端信任闸门 `isTrustedInstallHash` 据此放行/拒绝远程安装;
- `zipUrl` 必须 https;插件 zip 存放于本仓库 `zips/<id>.zip`;
- 完整性≠来源可信:**签名/TUF 信任链(root/timestamp/snapshot/targets)接线尚未进入安装路径(P5-002/B-002)**,
  在此之前本仓库条目仅可用于开发验证,公开市场发布受 RFC §15 Phase-0 安全门槛约束。

## 提交插件(流程就绪,发布通道待信任链闭环)

1. 用 `lexi` CLI 构建并打包插件(`node ../../tools/lexi-cli/lexi.cjs plugin pack`);
2. 将 zip 放入本仓库 `zips/`,以实测字节计算 sha256;
3. 向 `community-plugins.json` 的 `plugins` 追加条目(`id` 全局唯一);
4. CI(`.github/workflows/validate.yml`)做结构校验 + `--remote` 下载 zip 实测哈希比对;
5. 合并后客户端市场页可见、可安装。

## 校验

```bash
node scripts/validate.mjs            # 离线结构校验(schemaVersion=1 严格口径)
node scripts/validate.mjs --remote   # 额外下载每个 zipUrl 实测 sha256 比对
```

主仓库对账门禁:`scripts/tests/plugin-dist-regression.cjs` 断言本仓库索引与客户端解析器、
共享 Node 校验器三方一致(能过本仓 CI ⇒ 客户端必可安装)。
