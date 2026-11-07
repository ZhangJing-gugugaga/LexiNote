// example-ui — 交互面示例(R37/P4-001)。
// 轨面:沙箱轨(entrypoints.service='sandbox:')。只使用沙箱轨已实现的真实面:
//   Plugin / addCommand / Modal / Menu / Setting Builder / PluginSettingTab /
//   addSettingTab / Notice / loadData / saveData。
// 三条交互面的端口链(与宿主 lexinote_plugin_sandbox.html 同一实现):
//   Modal:open() 把 {modalId,title,content} 经 ui.modal.open 递交宿主原生弹层;
//          用户关闭 → 宿主回推 sandbox.ui{kind:modal} → onClose 回调 + open() Promise 兑现。
//   Menu:  showAtPosition() 把条目表经 ui.menu.show 递交宿主原生菜单;用户点选/点外关闭
//          → 回推 sandbox.ui{kind:menu} → 条目 onClick 与 onHide 兑现(show() Promise)。
//   Setting:addSettingTab 在收集窗口跑 display(),Setting Builder 的声明式控件
//          (type/key/default/options/min/max/step)经 settings.register 递交宿主设置页
//          原生渲染,值持久化 data.json;宿主写值后回推 sandbox.ui{kind:settings,values}
//          → 控件 onChange + onSettingsChanged(R36 调查的"运行中值回推"缺口已收口)。
// 能力对账:ui.modal.*/ui.menu.* → notifications(与 Notice 同域);commands.add →
//   workspace.commands;settings.register → register(身份绑定);data.* → storage。
// 注意:交互面类(本文件底部)在模块顶层 extends PluginSettingTab,display() 里引用
// Setting——解构必须落在模块顶层(onload 局部解构对类体不可见)。
const { Modal, Menu, Setting, PluginSettingTab, Notice } = require('obsidian');

module.exports = class ExampleUi extends require('obsidian').Plugin {
  async onload() {
    const self = this;
    this.state = Object.assign({ opens: 0, menus: 0, changes: 0 }, (await this.loadData()) || {});
    this.addCommand({
      id: 'hello-modal',
      name: '交互示例:打开 Modal',
      callback: () => {
        const modal = new Modal();
        modal.setTitle('交互示例');
        modal.setContent('这是插件经端口链打开的宿主原生弹层。');
        modal.onClose = () => {
          self.state.modalClosedAt = Date.now();
          return self.saveData(self.state);
        };
        self.state.opens = (self.state.opens || 0) + 1;
        return self.saveData(self.state).then(() => modal.open());
      }
    });
    this.addCommand({
      id: 'hello-menu',
      name: '交互示例:弹出 Menu',
      callback: () => {
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('标记为重要').onClick(() => {
            self.state.menuPick = 'star';
            return self.saveData(self.state);
          });
        });
        menu.addItem((item) => {
          item.setTitle('归档').onClick(() => {
            self.state.menuPick = 'archive';
            return self.saveData(self.state);
          });
        });
        menu.onHide = () => {
          self.state.menuClosedAt = Date.now();
          return self.saveData(self.state);
        };
        self.state.menus = (self.state.menus || 0) + 1;
        return self.saveData(self.state).then(() => menu.showAtPosition({ x: 24, y: 96 }));
      }
    });
    this.addSettingTab(new ExampleUiSettingTab(this.app, self));
    new Notice('交互示例:已注册 Modal/Menu/设置三个交互命令');
  }

  onunload() {}
};

// Setting Builder 面:display() 里 new Setting 收集声明式控件(宿主按 key 原生渲染);
// setKey 是 LexiNote 声明式机制的寻址键(Obsidian Setting 无 key 概念,宿主按 key 写值)。
class ExampleUiSettingTab extends PluginSettingTab {
  display() {
    const plugin = this.plugin;
    new Setting(this.containerEl)
      .setName('显示徽标')
      .setDesc('阅读视图显示插件徽标')
      .addToggle((toggle) => {
        toggle.setValue(plugin.state.showBadge === true).onChange(() => {});
      })
      .setKey('showBadge');
    new Setting(this.containerEl)
      .setName('界面级别')
      .addDropdown((dropdown) => {
        dropdown.addOption('simple', '简洁').addOption('pro', '专业')
          .setValue(plugin.state.uiLevel || 'simple').onChange(() => {});
      })
      .setKey('uiLevel');
    new Setting(this.containerEl)
      .setName('条目上限')
      .addSlider((slider) => {
        slider.setLimits(1, 50, 1).setValue(plugin.state.maxItems || 10).onChange(() => {});
      })
      .setKey('maxItems');
  }

  onSettingsChanged(values) {
    this.plugin.state.changes = (this.plugin.state.changes || 0) + 1;
    this.plugin.state.lastChanged = values && typeof values === 'object' ? values : {};
    return this.plugin.saveData(this.plugin.state);
  }
}
