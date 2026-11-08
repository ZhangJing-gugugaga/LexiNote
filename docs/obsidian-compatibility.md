# Obsidian 兼容层

- 兼容等级 C0-C5（§11.2）：本宿主实现 C0-C4（Manifest/命令/存储/Vault/视图/Markdown/CM6），
  不承诺 C5（Node/Electron 专属）。
- 参考基线：obsidian@1.14.4（`tools/contract/symbols.json` 334 符号账本）。
- 真实夹具：Calendar（C2）/Outliner（C4，CM6 恒等断言）/Tasks（C3）/Minimal（Theme）。
- 规则：`require('@codemirror/*')` 必须取宿主注册表实例（禁止自带第二份）；
  未实现 API 不出现在稳定类型声明（`lexinote.d.ts` 即账本）。
