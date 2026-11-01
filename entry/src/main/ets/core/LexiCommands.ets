export class LexiCommand {
  id: string;
  title: string;
  hint: string;
  constructor(id: string, title: string, hint: string = '') {
    this.id = id; this.title = title; this.hint = hint;
  }
}

export const LEXI_COMMANDS: LexiCommand[] = [
  new LexiCommand('new', '新建 Markdown 笔记'),
  new LexiCommand('quick', '新建快速笔记'),
  new LexiCommand('study', '新建学习笔记'),
  new LexiCommand('daily', '打开今日笔记'),
  new LexiCommand('templates', '从模板新建笔记'),
  new LexiCommand('save-template', '将当前笔记保存为模板'),
  new LexiCommand('switcher', '快速切换文档', 'Ctrl / Cmd + O'),
  new LexiCommand('reading', '切换编辑与阅读', 'Ctrl / Cmd + E'),
  new LexiCommand('split', '在右侧分屏打开当前文档'),
  new LexiCommand('close-split', '关闭右侧分屏'),
  new LexiCommand('sidebar', '显示或隐藏侧边栏'),
  new LexiCommand('close-tab', '保存并关闭当前标签'),
  new LexiCommand('map', '新建思维导图'),
  new LexiCommand('canvas', '新建白板'),
  new LexiCommand('convert', '将当前笔记转为思维导图'),
  new LexiCommand('graph', '打开笔记关联'),
  new LexiCommand('library', '打开文档管理'),
  new LexiCommand('workspaces', '管理工作区与项目'),
  new LexiCommand('light', '使用浅色外观'),
  new LexiCommand('dark', '使用深色外观'),
  new LexiCommand('system', '跟随系统外观'),
  new LexiCommand('export-md', '导出工作区 Markdown'),
  new LexiCommand('backup', '导出完整备份'),
  new LexiCommand('import', '导入文件'),
  new LexiCommand('settings', '打开设置'),
  new LexiCommand('help', '打开使用说明')
];
