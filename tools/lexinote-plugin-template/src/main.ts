import {
	Editor,
	ItemView,
	Notice,
	Plugin,
	WorkspaceLeaf,
	moment,
	normalizePath,
} from 'lexinote';

const VIEW_TYPE = 'lexinote-sample-panel';

export default class SamplePlugin extends Plugin {
	async onload() {
		// 1) A command that reads the vault.
		this.addCommand({
			id: 'vault-stats',
			name: '统计当前库',
			callback: async () => {
				const files = await this.app.vault.getMarkdownFiles();
				new Notice(`当前库笔记：${files.length} 篇 · ${moment().format('YYYY-MM-DD')}`);
			},
		});

		// 2) An editor command (only visible while a document is open).
		this.addCommand({
			id: 'wrap-selection',
			name: '高亮选中文本',
			editorCallback: (editor: Editor) => {
				const selected = editor.getSelection();
				editor.replaceSelection(selected ? `==${selected}==` : '==插件已接管编辑==');
			},
		});

		// 3) A custom view rendered in an ArkWeb slot (real DOM + styles.css).
		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new SamplePanelView(leaf));
		this.addCommand({
			id: 'open-panel',
			name: '打开示例面板',
			callback: () => {
				this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE, active: true });
			},
		});

		// 4) React to vault changes.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				// Keep noise low: real plugins can debounce or inspect the file path.
				void file;
			}),
		);

		// 5) Persist plugin settings in data.json.
		const data = (await this.loadData()) as { lastRun?: number } | null;
		await this.saveData({ ...(data || {}), lastRun: Date.now() });
	}

	onunload() {
		// Commands, views and listeners are removed by the host cleanup stack.
	}
}

class SamplePanelView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return '示例面板';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: '示例插件面板' });

		const info = contentEl.createDiv({ cls: 'lexi-info' });
		info.setText('正在读取知识库…');
		try {
			const files = await this.app.vault.getMarkdownFiles();
			info.setText(`当前库笔记：${files.length} 篇`);
		} catch (error) {
			info.setText(`读取失败：${String(error)}`);
		}

		const row = contentEl.createDiv({ cls: 'lexi-row' });
		const notifyBtn = row.createEl('button', { text: '弹出通知' });
		notifyBtn.onClickEvent(() => new Notice('来自插件视图的消息'));

		const openBtn = row.createEl('button', { text: '新建插件笔记' });
		openBtn.onClickEvent(async () => {
			const target = normalizePath(`插件笔记/${moment().format('YYYY-MM-DD')}.md`);
			const existing = await this.app.vault.getAbstractFileByPath(target);
			if (existing) {
				await this.app.vault.modify(existing as never, `# 插件笔记\n\n更新于 ${moment().format('HH:mm')}\n`);
				new Notice('已更新今日插件笔记');
			} else {
				await this.app.vault.create(target, `# 插件笔记\n\n创建于 ${moment().format('HH:mm')}\n`);
				new Notice('已创建今日插件笔记');
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
