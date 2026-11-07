// example-settings — 设置面示例(P3-007)。
// 轨面:runtime 页轨(legacy;entrypoints.service 未声明 'sandbox:')。
//   声明式设置链在 runtime 页轨是真实实现:
//     addSettingTab → settings.register RPC(definitions 序列化落账宿主)
//     → 宿主设置页原生渲染(toggle/text/slider/dropdown/textarea)
//     → 值变更写回插件私有 data.json(writePluginData)。
//   沙箱轨 addSettingTab 为登记桩——归 P4-001/P4-005 批次,本例不走沙箱轨声明。
// 诚实边界:值变更的**运行中回推**(SDK 类型里的 onSettingsChanged/setControlValue)
//   宿主侧尚无通道——本例不依赖回推;新值经 data.json 在插件下次 onload(重启用/重启)
//   时由 loadData 读回。
const { Plugin, PluginSettingTab, Notice } = require('obsidian');

const DEFAULTS = { showBadge: true, badgePrefix: '示例', maxItems: 10 };

class ExampleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
  }

  // 声明式定义:宿主按此数组原生渲染;heading 行只做分组标题(不需要 key)。
  getSettingDefinitions() {
    return [
      { type: 'heading', name: '示例插件设置' },
      { type: 'toggle', name: '显示徽标', key: 'showBadge', desc: '在阅读视图显示插件徽标', default: true },
      { type: 'text', name: '徽标前缀', key: 'badgePrefix', desc: '徽标文案前缀', default: '示例' },
      { type: 'slider', name: '最大条目数', key: 'maxItems', desc: '列表渲染上限', min: 1, max: 50, step: 1, default: 10 }
    ];
  }

  // 防御性实现:宿主未来接通回推通道时自动生效;当前版本宿主不会调用它。
  onSettingsChanged(values) {
    this.plugin.settings = Object.assign({}, DEFAULTS, values || {});
  }
}

module.exports = class ExampleSettings extends Plugin {
  async onload() {
    const self = this;
    // 设置值真源 = 插件 data.json:宿主设置页写入的值在这里读回(下次装载生效)。
    this.settings = Object.assign({}, DEFAULTS, (await this.loadData()) || {});
    // 注册声明式设置页(settings.register;卸载时 settings.unregister 随清理栈)。
    this.addSettingTab(new ExampleSettingTab(this.app, this));
    this.addCommand({
      id: 'show-settings',
      name: '设置示例:显示当前设置',
      callback: () => {
        new Notice('设置示例:showBadge=' + self.settings.showBadge +
          ' · prefix=' + self.settings.badgePrefix + ' · maxItems=' + self.settings.maxItems);
      }
    });
    await this.saveData(this.settings);
  }

  onunload() {}
};
