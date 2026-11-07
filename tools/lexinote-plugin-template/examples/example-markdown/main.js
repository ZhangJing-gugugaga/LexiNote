// example-markdown — Markdown 渲染面示例(P3-007)。
// 轨面:runtime 页轨(legacy;entrypoints.service 未声明 'sandbox:')。
//   Markdown 渲染管线(T3.1)在 runtime 页轨是真实实现:
//     registerMarkdownCodeBlockProcessor → codeblocks.register RPC + 页内注册表;
//     registerMarkdownPostProcessor → 真委托 LexiReading 注册表(稳定顺序 + 失败隔离)。
//   沙箱轨两者均未接入(registerMarkdownCodeBlockProcessor 为登记桩、
//   registerMarkdownPostProcessor 缺席)——归 P4-001/P4-005 批次,本例不走沙箱轨声明。
// 能力对账:codeblocks.register → capabilities.editor.extensions != 'none'
//   (本例声明 'declarative';未声明时宿主拒绝注册)。
const { Plugin } = require('obsidian');

module.exports = class ExampleMarkdown extends Plugin {
  onload() {
    // 代码块处理器:```lexi-counter``` 围栏块 → 渲染成计数卡片。
    // language 小写归一;注销(codeblocks.unregister)随宿主清理栈。
    this.registerMarkdownCodeBlockProcessor('lexi-counter', (source, el) => {
      const start = parseInt(String(source).trim(), 10);
      const value = Number.isFinite(start) ? start : 0;
      const card = el.createDiv({ cls: 'lexi-counter-card' });
      card.createEl('h3', { text: '计数卡片' });
      card.createDiv({ cls: 'lexi-counter-value' })
        .setText('start=' + value + ' · next=' + (value + 1));
    });
    // 阅读视图后处理器:对渲染产物做增量改写 —— 把 <mark>任务:xxx</mark> 徽标化。
    // handler 带 token 身份执行(P1-006);onunload 反注册随 _cleanups。
    this.registerMarkdownPostProcessor((el) => {
      const marks = typeof el.findAll === 'function' ? el.findAll('mark') : [];
      for (const mark of marks) {
        const text = mark.getText();
        if (text.indexOf('任务:') === 0) {
          mark.setText('[' + text.slice(3).trim() + ']');
          mark.addClass('lexi-task-badge');
        }
      }
    });
  }

  onunload() {
    // 代码块/后处理器注册随宿主清理栈回收(codeblocks.unregister + 反注册)。
  }
};
