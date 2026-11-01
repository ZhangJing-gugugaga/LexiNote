/*
 * LexiNote sample plugin. Compiled output shape identical to an Obsidian
 * esbuild bundle: CommonJS single file exporting a Plugin subclass.
 */
const { Plugin, Notice, moment, normalizePath } = require('obsidian');

const DEFAULT_SETTINGS = { greeting: 'LexiNote 插件底座已就绪', showStats: true };

module.exports = class SamplePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});

    this.addCommand({
      id: 'sample-notice',
      name: '示例:统计当前笔记库',
      callback: async () => {
        const files = await this.app.vault.getMarkdownFiles();
        const today = moment().format('YYYY-MM-DD');
        new Notice(`${this.settings.greeting}\n当前笔记数:${files.length}\n${today}`);
        if (this.settings.showStats) {
          this.settings.lastRunAt = Date.now();
          await this.saveData(this.settings);
        }
      }
    });

    this.addCommand({
      id: 'sample-create',
      name: '示例:创建插件日志笔记',
      callback: async () => {
        const date = moment().format('YYYY-MM-DD');
        const target = normalizePath(`插件日志/${date}.md`);
        const existing = await this.app.vault.getAbstractFileByPath(target);
        if (existing) {
          await this.app.vault.process(existing, (content) => `${content}\n- ${moment().format('HH:mm')} 插件运行正常`);
          new Notice('已在今日插件日志追加记录');
          return;
        }
        await this.app.vault.create(target, `# 插件日志 ${date}\n\n- ${moment().format('HH:mm')} 首次由插件创建`);
        new Notice('已创建今日插件日志');
      }
    });

    // 验证事件总线:文档保存时插件收到 modify 事件(3 秒节流避免刷屏)
    let lastNoticeAt = 0;
    this.registerEvent(this.app.vault.on('modify', (file) => {
      const now = Date.now();
      if (now - lastNoticeAt < 3000) { return; }
      lastNoticeAt = now;
      new Notice(`插件收到修改事件:${file && file.name ? file.name : '文档'}`);
    }));

    this.addCommand({
      id: 'wrap-selection',
      name: '示例:高亮选中文本（编辑器命令）',
      editorCallback: (editor) => {
        const selected = editor.getSelection();
        if (selected) {
          editor.replaceSelection(`==${selected}==`);
        } else {
          editor.replaceSelection('==插件已接管编辑==');
        }
      }
    });

    this.addCommand({
      id: 'editor-stats',
      name: '示例:读取编辑器状态',
      editorCallback: (editor) => {
        const text = editor.getValue();
        const cursor = editor.getCursor();
        new Notice(`字符数:${text.length} 行数:${editor.lineCount()} 光标:${cursor.line}:${cursor.ch}`);
      }
    });

    this.registerInterval(window.setInterval(() => { /* heartbeat */ }, 5 * 60 * 1000));
  }

  onunload() {
    // All commands, intervals and subscriptions are removed by the kernel cleanup stack.
  }
};
