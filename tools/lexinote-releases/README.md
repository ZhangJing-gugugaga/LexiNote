# lexinote-releases

LexiNote 社区插件索引仓库(结构对齐 [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases))。

客户端行为(与 Obsidian 同构):

- 读取根目录 `community-plugins.json` 作为插件索引(`id` / `name` / `author` / `description` / `repo`,扩展字段 `version` / `zipUrl`);
- 安装时优先使用条目中的 `zipUrl`;若缺失,客户端约定从 `<repo>/releases/latest/download/plugin.zip` 下载;
- Release 资产必须包含 `manifest.json`、`main.js`,可选 `styles.css`;
- `manifest.json` 的 `version` 必须与 Release Tag 一致;`minAppVersion` 由客户端 `versions.json` 兼容判定。

## 提交插件

1. 在插件仓库配置 Release(资产含 `manifest.json` + `main.js`,可选 `styles.css`);
2. 向本仓库 `community-plugins.json` 追加一行(保持 `id` 全局唯一);
3. CI(`.github/workflows/validate.yml`)会校验 JSON 结构、`id` 格式、仓库可达性与 Release 资产;
4. 合并后客户端市场页即可见。

## 校验

```bash
node scripts/validate.mjs      # 本地结构校验(离线)
node scripts/validate.mjs --remote   # 额外校验 GitHub 仓库与 Release 资产
```
