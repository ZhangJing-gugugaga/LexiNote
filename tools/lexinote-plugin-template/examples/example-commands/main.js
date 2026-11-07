// example-commands — 命令面示例(P3-007)。
// 轨面:沙箱轨可装载(entrypoints.service='sandbox:')。只使用沙箱轨已实现的真实面:
//   Plugin / addCommand(callback + editorCallback) / Notice / loadData / saveData。
// 能力对账:commands.add → capabilities.workspace.commands;ui.notice → notifications;
//   编辑器命令快照按 editor 档位(readActive/writeSelection)脱敏;data.* → storage。
module.exports = class ExampleCommands extends require('obsidian').Plugin {
  async onload() {
    const { Notice } = require('obsidian');
    const self = this;
    // 持久化状态走插件私有 data.json(data.load/data.save,他人不可达)。
    this.state = Object.assign({ runs: 0 }, (await this.loadData()) || {});
    // 普通命令:命令面板可见,无编辑器上下文也可执行。
    this.addCommand({
      id: 'count-run',
      name: '命令示例:计数一次运行',
      callback: async () => {
        self.state.runs = (self.state.runs || 0) + 1;
        self.state.lastRunAt = Date.now();
        await self.saveData(self.state);
        new Notice('命令示例:已记录第 ' + self.state.runs + ' 次运行');
      }
    });
    // 编辑器命令(editorOnly):仅文档打开时可见/可执行;回调由宿主按清单档位
    // 脱敏后回推编辑器快照(沙箱轨 Editor 快照形态,写方法返回 Promise)。
    this.addCommand({
      id: 'wrap-selection',
      name: '命令示例:高亮选中文本',
      editorCallback: async (editor) => {
        const selected = editor.getSelection();
        await editor.replaceSelection(selected ? '==' + selected + '==' : '==命令示例==');
        new Notice('命令示例:选区已改写');
      }
    });
  }

  onunload() {
    // 命令/通知资源随宿主清理栈回收(P1-002 生命周期语义),这里无需手工注销。
  }
};
