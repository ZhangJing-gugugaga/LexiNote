// example-vault — Vault 面示例(P3-007)。
// 轨面:沙箱轨可装载(entrypoints.service='sandbox:')。只使用沙箱轨已实现的真实面:
//   vault.getMarkdownFiles / getAbstractFileByPath / read / create / modify / process
//   + normalizePath / moment / Notice / addCommand。
// 能力对账:vault.read.paths=[](全库读),vault.write.paths=['插件笔记/'](写路径白名单,
//   P2-004:白名单外路径宿主直接拒绝,`capability.path … allowed=false`)。
module.exports = class ExampleVault extends require('obsidian').Plugin {
  async onload() {
    const { Notice, normalizePath, moment } = require('obsidian');
    const self = this;
    // 只读统计:走 vault.files(fs-read 档位)。
    this.addCommand({
      id: 'vault-stats',
      name: 'Vault 示例:统计当前库',
      callback: async () => {
        const files = await self.app.vault.getMarkdownFiles();
        new Notice('Vault 示例:当前库笔记 ' + files.length + ' 篇 · ' + moment().format('YYYY-MM-DD'));
      }
    });
    // 白名单内写入:只允许写 插件笔记/ 目录(manifest vault.write.paths)。
    this.addCommand({
      id: 'daily-note',
      name: 'Vault 示例:写今日插件笔记',
      callback: async () => {
        const target = normalizePath('插件笔记/' + moment().format('YYYY-MM-DD') + '.md');
        const existing = await self.app.vault.getAbstractFileByPath(target);
        const stamp = moment().format('HH:mm');
        if (existing) {
          const content = await self.app.vault.read(existing);
          await self.app.vault.modify(existing, String(content) + '\n- 更新于 ' + stamp);
        } else {
          await self.app.vault.create(target, '# 插件笔记\n\n- 创建于 ' + stamp);
        }
        // process = 读→改写组合面:两段各走 vault.read / vault.modify 既有门禁,
        // 宿主侧授权语义不变,插件侧少写一次往返。
        await self.app.vault.process(target, (text) => String(text).replace(/\s*$/, '') + '\n- process ok\n');
        new Notice('Vault 示例:已写入 ' + target);
      }
    });
    // 故意的白名单负例(演示宿主 fail-closed):插件笔记/ 之外写入会被宿主拒绝。
    // 打开下面注释即可在真机观察到 capability.path 拒绝路径;默认关闭,保持装载链干净。
    // this.addCommand({
    //   id: 'outside-whitelist',
    //   name: 'Vault 示例:白名单外写入(预期被宿主拒绝)',
    //   callback: async () => { await self.app.vault.create('根目录越权.md', '应被拒绝'); }
    // });
  }

  onunload() {}
};
