/*
 * LexiNote sample plugin. Compiled output shape identical to an Obsidian
 * esbuild bundle: CommonJS single file exporting a Plugin subclass.
 */
const { Plugin, ItemView, PluginSettingTab, Notice, moment, normalizePath } = require('obsidian');

const DEFAULT_SETTINGS = { greeting: 'LexiNote 插件底座已就绪', showStats: true, logFolder: '插件日志' };
const SAMPLE_VIEW = 'sample-panel';

class SampleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
  }

  getSettingDefinitions() {
    const current = this.plugin.settings || DEFAULT_SETTINGS;
    return [
      { type: 'heading', name: '示例插件设置' },
      { type: 'text', name: '问候语', desc: '统计命令通知中显示的文字', key: 'greeting', default: current.greeting },
      { type: 'toggle', name: '显示统计', desc: '执行统计命令时同时写入 data.json', key: 'showStats', default: current.showStats },
      { type: 'text', name: '日志文件夹', desc: '创建插件日志使用的文件夹路径', key: 'logFolder', default: current.logFolder }
    ];
  }

  onSettingsChanged(values) {
    Object.assign(this.plugin.settings, values);
  }
}

class SamplePanelView extends ItemView {
  getViewType() { return SAMPLE_VIEW; }
  getDisplayText() { return '示例面板'; }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '示例插件面板' });
    contentEl.createEl('p', {
      text: '这个视图运行在 ArkWeb 槽位中：真实 DOM、插件 styles.css 与 Obsidian 风格的 createEl 帮助函数都可用。'
    });
    const info = contentEl.createDiv({ cls: 'lexi-sample-info' });
    info.setText('正在读取知识库…');
    try {
      const files = await this.app.vault.getMarkdownFiles();
      info.setText(`当前库笔记：${files.length} 篇`);
    } catch (err) {
      info.setText('读取失败：' + (err && err.message ? err.message : String(err)));
    }
    const row = contentEl.createDiv({ cls: 'lexi-sample-row' });
    const notifyBtn = row.createEl('button', { text: '弹出通知' });
    notifyBtn.onClickEvent(() => new Notice('来自插件视图的消息'));
    const statBtn = row.createEl('button', { text: '读取元数据' });
    statBtn.onClickEvent(async () => {
      try {
        const files = await this.app.vault.getMarkdownFiles();
        const first = files[0];
        if (!first) { new Notice('当前库还没有笔记'); return; }
        const cache = await this.app.metadataCache.getFileCache(first);
        const tags = cache && cache.tags ? cache.tags.length : 0;
        const links = cache && cache.links ? cache.links.length : 0;
        new Notice(`${first.name}：标签 ${tags} · 链接 ${links}`);
      } catch (err) {
        new Notice('元数据读取失败：' + (err && err.message ? err.message : String(err)));
      }
    });
    contentEl.createEl('p', { text: '本视图的命令与设置同样来自插件底座。', cls: 'lexi-sample-hint' });

    // 视图 -> 宿主通道自检:打开后自动弹一条原生通知
    setTimeout(() => new Notice('示例面板已就绪（来自插件视图）'), 600);
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class SamplePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});

    this.registerView(SAMPLE_VIEW, (leaf) => new SamplePanelView(leaf));
    this.addSettingTab(new SampleSettingTab(this.app, this));

    this.addCommand({
      id: 'open-panel',
      name: '示例:打开示例面板',
      callback: async () => {
        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: SAMPLE_VIEW, active: true });
      }
    });

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
        const folder = (this.settings.logFolder || '插件日志').replace(/^\/+|\/+$/g, '');
        const target = normalizePath(`${folder}/${date}.md`);
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
