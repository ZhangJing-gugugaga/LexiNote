// example-view — 视图面示例(P3-007)。
// 轨面:runtime 页轨(legacy;entrypoints.service 未声明 'sandbox:')。
//   视图面在 runtime 页轨是真实实现(shim registerView → views.add RPC +
//   WorkspaceLeaf.setViewState 真把 creator 实例化挂进 DOM,P1-006 身份链);
//   沙箱轨的视图执行面尚未接入(registerView 为登记桩,workspace 叶显式拒绝)——
//   归 P4-001/P4-005 批次,本例因此不走沙箱轨声明。
// 能力对账:views.add → capabilities.workspace.views;命令 → workspace.commands。
const { Plugin, ItemView, Notice } = require('obsidian');

const VIEW_TYPE = 'example-view-panel';

class ExamplePanelView extends ItemView {
  constructor(leaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '示例面板';
  }

  async onOpen() {
    // contentEl 是真实 DOM 元素(runtime 页),createEl/createDiv/setText/empty
    // 是宿主原型补丁提供的 Obsidian 风格助手。
    const files = await this.app.vault.getMarkdownFiles();
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '示例插件面板' });
    const info = this.contentEl.createDiv({ cls: 'lexi-info' });
    info.setText('当前库笔记 ' + files.length + ' 篇');
    const button = this.contentEl.createDiv({ cls: 'lexi-row' }).createEl('button', { text: '弹出通知' });
    button.onClickEvent(() => new Notice('来自插件视图的消息'));
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class ExampleView extends Plugin {
  onload() {
    // registerView:类型注册进宿主视图注册表(views.add RPC + 扩展登记),
    // 卸载时随清理栈 views.remove。
    this.registerView(VIEW_TYPE, (leaf) => new ExamplePanelView(leaf));
    this.addCommand({
      id: 'open-panel',
      name: '视图示例:打开面板',
      callback: () => {
        // getRightLeaf().setViewState 在 runtime 页真实挂载:creator 实例化 →
        // containerEl 挂 DOM → onOpen 全链(带 leaf 归属身份)。
        this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE, active: true });
      }
    });
  }

  onunload() {
    // 视图/命令随宿主清理栈回收(views.remove + extension registry)。
  }
};
