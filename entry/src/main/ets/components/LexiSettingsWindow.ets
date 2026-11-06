// Obsidian-style settings window: one surface, left category rail, right content pane.
// Replaces the old scattered "我的" page + sheets: appearance, editor, plugins,
// plugin settings, community market, data and about all live here.

import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { LexiAppearancePicker } from './LexiAppearancePicker';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { LexiPluginMarketSheet } from './plugin/LexiPluginMarketSheet';
import { LexiPluginSettingsSheet } from './plugin/LexiPluginSettingsSheet';

@Observed
class LexiSettingsPluginRow {
  id: string = '';
  name: string = '';
  version: string = '';
  enabled: boolean = false;
  detail: string = '';
  canToggle: boolean = true;
  hasSettings: boolean = false;
  permissionNote: string = '';
}

@Component
struct LexiSettingsPluginRowView {
  @ObjectLink row: LexiSettingsPluginRow;
  onToggleRow: (id: string, enabled: boolean) => void = (_id: string, _enabled: boolean): void => {};
  onOpenRowSettings: (id: string, name: string) => void = (_id: string, _name: string): void => {};

  build() {
    Row({ space: 10 }) {
      Column({ space: 3 }) {
        Row({ space: 6 }) {
          Text(this.row.name).fontSize(13).fontColor($r('app.color.text_primary'))
          Text(`v${this.row.version}`).fontSize(10).fontColor($r('app.color.text_secondary'))
        }
        Text(this.row.detail)
          .fontSize(11)
          .fontColor(this.row.enabled ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        // P2-008/P5-004:行内权限标签展示(开启开关 = 对该清单的显式同意)。
        if (this.row.permissionNote.length > 0) {
          Text(this.row.permissionNote)
            .fontSize(9)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.row.hasSettings) {
        Button('设置', { type: ButtonType.Normal })
          .height(30).fontSize(11).borderRadius(9)
          .enabled(this.row.enabled)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick((): void => { this.onOpenRowSettings(this.row.id, this.row.name); })
      }

      Toggle({ type: ToggleType.Switch, isOn: this.row.enabled })
        .id(`settings-window-toggle-${this.row.id}`)
        .enabled(this.row.canToggle)
        .selectedColor($r('app.color.brand'))
        .onChange((isOn: boolean): void => { this.onToggleRow(this.row.id, isOn); })
    }
    .width('100%')
    .padding(10)
    .backgroundColor($r('app.color.soft_surface'))
    .borderRadius(12)
  }
}

class LexiSettingsCategory {
  id: string = '';
  label: string = '';
  icon: string = '';
}

@Component
export struct LexiSettingsWindow {
  @Prop theme: string = 'system';
  @Prop defaultTier: string = 'simple';
  @Prop arkuiEditorOpen: boolean = false;
  @Prop wideOpenTarget: string = '';
  @Prop busy: boolean = false;
  @Prop dataStatus: string = '';
  @Prop lastBackup: string = '';
  onSelectTheme: (theme: string) => void = (_theme: string): void => {};
  onSelectTier: (tier: string) => void = (_tier: string): void => {};
  onToggleArkuiEditor: (on: boolean) => void = (_on: boolean): void => {};
  onResetWideOpen: () => void = (): void => {};
  onExportBackup: () => void = (): void => {};
  onExportMarkdown: () => void = (): void => {};
  onImportFiles: () => void = (): void => {};
  onRebuildIndex: () => void = (): void => {};
  onOpenHelp: () => void = (): void => {};
  onOpenTrash: () => void = (): void => {};
  onShowInfo: (title: string, message: string) => void = (_title: string, _message: string): void => {};
  onClose: () => void = (): void => {};

  @State private category: string = 'appearance';
  @State private pluginRows: LexiSettingsPluginRow[] = [];
  @State private pluginSafeMode: boolean = false;
  // P1-003d(R28):旧共享 realm 轨开关 UI 态(默认 true,随 manager 读回)。
  @State private pluginLegacyTrack: boolean = true;
  @State private pluginBusy: boolean = false;
  @State private pluginHint: string = '';
  @State private settingsPluginId: string = '';
  @State private settingsPluginName: string = '';

  private categories: LexiSettingsCategory[] = [
    { id: 'appearance', label: '外观', icon: 'sun' },
    { id: 'editor', label: '编辑器', icon: 'note' },
    { id: 'plugins', label: '插件', icon: 'shield' },
    { id: 'market', label: '社区插件市场', icon: 'search' },
    { id: 'data', label: '数据与备份', icon: 'export' },
    { id: 'about', label: '关于与帮助', icon: 'info' }
  ];

  aboutToAppear(): void {
    this.refreshPlugins();
  }

  private refreshPlugins(): void {
    const manager = LexiPluginManager.shared;
    if (!manager) {
      this.pluginHint = '插件内核尚未就绪';
      this.pluginRows = [];
      return;
    }
    this.pluginHint = '';
    this.pluginSafeMode = manager.isSafeMode();
    this.pluginLegacyTrack = manager.isLegacyTrackEnabled();
    const existing: Map<string, LexiSettingsPluginRow> = new Map();
    for (const row of this.pluginRows) { existing.set(row.id, row); }
    const rows: LexiSettingsPluginRow[] = [];
    for (const plugin of manager.installedPlugins()) {
      if (!plugin.manifest.id || !plugin.manifest.name) { continue; }
      let row = existing.get(plugin.manifest.id);
      if (!row) {
        row = new LexiSettingsPluginRow();
        row.id = plugin.manifest.id;
      }
      row.name = plugin.manifest.name;
      row.version = plugin.manifest.version;
      row.enabled = plugin.enabled;
      row.canToggle = !this.pluginBusy && !this.pluginSafeMode;
      row.hasSettings = manager.hasPluginSettings(plugin.manifest.id);
      row.detail = plugin.errorState.length > 0 ? plugin.errorState :
        (plugin.enabled ? `已启用 · v${plugin.manifest.version}` : '已停用');
      // P2-008/P5-004:行内权限标签;未授权的声明型插件标出"待授权"。
      const tags = manager.permissionTagsOf(plugin.manifest.id);
      const tagsLine = tags.length > 0 ? '权限: ' + tags.join(' · ') : '权限: 未声明能力';
      row.permissionNote = manager.permissionStateOf(plugin.manifest.id) !== 'granted' && plugin.manifest.capabilitiesDeclared
        ? '待授权 · ' + tagsLine : tagsLine;
      rows.push(row);
    }
    this.pluginRows = rows;
  }

  private async togglePlugin(id: string, enabled: boolean): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) { return; }
    const current = manager.installedPlugins().find((plugin): boolean => plugin.manifest.id === id);
    if (!current || current.enabled === enabled) {
      this.refreshPlugins();
      return;
    }
    this.pluginBusy = true;
    for (const row of this.pluginRows) {
      if (row.id === id) { row.enabled = enabled; }
    }
    this.pluginRows = this.pluginRows.slice();
    try {
      if (enabled) {
        // P5-004:未授权的声明型插件,开关 = 同意行内展示的权限清单(consentEnablePlugin
        // = grant 落账 + enable);已授权/无能力声明的插件保持原 enablePlugin 通路。
        if (manager.permissionStateOf(id) !== 'granted' &&
          current.manifest.capabilitiesDeclared) {
          await manager.consentEnablePlugin(id);
        } else {
          await manager.enablePlugin(id);
        }
      } else {
        await manager.disablePlugin(id);
      }
    } finally {
      this.pluginBusy = false;
      this.refreshPlugins();
    }
  }

  private async toggleSafeMode(safeMode: boolean): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) { return; }
    this.pluginBusy = true;
    try {
      await manager.setSafeMode(safeMode);
    } finally {
      this.pluginBusy = false;
      this.refreshPlugins();
    }
  }

  /** P1-003d(R28):legacy 共享 realm 轨开关(关闭 = 非沙箱轨装载 fail-closed)。 */
  private async toggleLegacyTrack(enabled: boolean): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) { return; }
    this.pluginBusy = true;
    try {
      await manager.setLegacyTrackEnabled(enabled);
    } finally {
      this.pluginBusy = false;
      this.refreshPlugins();
    }
  }

  private async installFromPicker(): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.pluginBusy) { return; }
    const context = getContext(this) as common.Context;
    this.pluginBusy = true;
    try {
      const docPicker = new picker.DocumentViewPicker(context);
      const uris = await docPicker.select({ fileSuffixFilters: ['插件安装包|.zip'], maxSelectNumber: 1 });
      if (!uris || uris.length === 0) { return; }
      const pluginId = await manager.installZip(uris[0]);
      // P5-004:安装不再自动 enable——侧载插件停在待授权,在插件列表开启即同意权限清单。
      this.getUIContext().getPromptAction().showToast({ message: `已安装插件（未启用，请到插件列表授权后启用）: ${pluginId}` });
    } catch (error) {
      this.getUIContext().getPromptAction().showToast({ message: '安装失败: ' + String(error) });
    } finally {
      this.pluginBusy = false;
      this.refreshPlugins();
    }
  }

  @Builder
  private categoryItem(item: LexiSettingsCategory) {
    Row({ space: 8 }) {
      Text(item.label)
        .fontSize(13)
        .fontColor(this.category === item.id ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
        .fontWeight(this.category === item.id ? FontWeight.Medium : FontWeight.Regular)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(38)
    .padding({ left: 12, right: 10 })
    .borderRadius(8)
    .backgroundColor(this.category === item.id ? $r('app.color.workspace_selection') : Color.Transparent)
    .onClick((): void => { this.category = item.id; })
  }

  @Builder
  private pluginSection() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text('已安装插件')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Text(`${this.pluginRows.length}`).fontSize(12).fontColor($r('app.color.text_secondary'))
      }
      .width('100%')

      Row({ space: 8 }) {
        Button('从文件安装 (.zip)', { type: ButtonType.Normal })
          .layoutWeight(1).height(38).fontSize(12).borderRadius(10)
          .enabled(!this.pluginBusy)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => { this.installFromPicker(); })
        Button('浏览社区插件', { type: ButtonType.Normal })
          .layoutWeight(1).height(38).fontSize(12).borderRadius(10)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick((): void => { this.category = 'market'; })
      }
      .width('100%')

      Button('插件工作区（实验）', { type: ButtonType.Normal })
        .id('plugin-workspace-entry')
        .width('100%').height(38).fontSize(12).borderRadius(10)
        .backgroundColor($r('app.color.soft_surface'))
        .fontColor($r('app.color.text_primary'))
        .onClick((): void => {
          this.getUIContext().getRouter().pushUrl({ url: 'workspace/LexiWorkspacePage' })
            .catch((): void => {
            });
        })

      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text('安全模式').fontSize(13).fontColor($r('app.color.text_primary'))
          Text('停用全部插件，并以禁用状态启动').fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
        Toggle({ type: ToggleType.Switch, isOn: this.pluginSafeMode })
          .enabled(!this.pluginBusy)
          .selectedColor($r('app.color.brand'))
          .onChange((isOn: boolean): void => { this.toggleSafeMode(isOn); })
      }
      .width('100%')

      // P1-003d(R28):旧共享 realm 轨(runtime 页共享求值面)停用开关。默认开(沙箱轨
      // 真机验收完成前行为不回归);关闭后未声明沙箱轨的插件装载一律 fail-closed。
      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text('旧版插件轨(共享 realm)').fontSize(13).fontColor($r('app.color.text_primary'))
          Text('关闭后仅沙箱轨插件可装载，其余拒绝启用（fail-closed）').fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
        Toggle({ type: ToggleType.Switch, isOn: this.pluginLegacyTrack })
          .id('plugin-legacy-track-toggle')
          .enabled(!this.pluginBusy)
          .selectedColor($r('app.color.brand'))
          .onChange((isOn: boolean): void => { this.toggleLegacyTrack(isOn); })
      }
      .width('100%')

      if (this.pluginHint.length > 0) {
        Text(this.pluginHint).fontSize(12).fontColor($r('app.color.text_secondary'))
      }

      ForEach(this.pluginRows, (row: LexiSettingsPluginRow) => {
        LexiSettingsPluginRowView({
          row: row,
          onToggleRow: (id: string, enabled: boolean): void => { this.togglePlugin(id, enabled); },
          onOpenRowSettings: (id: string, name: string): void => {
            this.settingsPluginId = id;
            this.settingsPluginName = name;
            this.category = 'plugin-settings';
          }
        })
      }, (row: LexiSettingsPluginRow): string => row.id)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private appearanceSection() {
    Column({ space: 12 }) {
      Text('外观').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      LexiAppearancePicker({
        theme: this.theme,
        onSelect: (value: string): void => { this.onSelectTheme(value); }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  private wideTargetLabel(): string {
    if (this.wideOpenTarget === 'container') { return '宽屏点击笔记：插件工作区容器'; }
    if (this.wideOpenTarget === 'arkui') { return '宽屏点击笔记：ArkUI 编辑器'; }
    return '宽屏点击笔记：下次点击时询问';
  }

  @Builder
  private editorSection() {
    Column({ space: 12 }) {
      Text('默认编辑工具').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      Row({ space: 8 }) {
        ForEach([['simple', '简洁'], ['study', '学习'], ['pro', '专业']], (item: string[]) => {
          Button(item[1], { type: ButtonType.Normal })
            .layoutWeight(1).height(40).fontSize(13).borderRadius(12)
            .fontWeight(this.defaultTier === item[0] ? FontWeight.Bold : FontWeight.Medium)
            .backgroundColor(this.defaultTier === item[0] ? $r('app.color.brand') : $r('app.color.soft_surface'))
            .fontColor(this.defaultTier === item[0] ? $r('app.color.inverse_text') : $r('app.color.text_primary'))
            .onClick((): void => { this.onSelectTier(item[0]); })
        }, (item: string[]): string => item[0])
      }
      .width('100%')

      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text('用 ArkUI 编辑器打开笔记').fontSize(13).fontColor($r('app.color.text_primary'))
          Text('关闭时笔记在插件工作区容器里打开').fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
        Toggle({ type: ToggleType.Switch, isOn: this.arkuiEditorOpen })
          .id('settings-arkui-editor-toggle')
          .selectedColor($r('app.color.brand'))
          .onChange((isOn: boolean): void => { this.onToggleArkuiEditor(isOn); })
      }
      .width('100%')

      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text('宽屏默认打开方式').fontSize(13).fontColor($r('app.color.text_primary'))
          Text(this.wideTargetLabel()).fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button('重新询问', { type: ButtonType.Normal })
          .id('settings-wide-open-reset')
          .height(30).fontSize(13).borderRadius(10)
          .backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.brand'))
          .onClick((): void => { this.onResetWideOpen(); })
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private dataSection() {
    Column({ space: 12 }) {
      Text('数据与备份').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      if (this.lastBackup.length > 0) {
        Text(`最近备份：${this.lastBackup}`).fontSize(12).fontColor($r('app.color.brand'))
      }
      if (this.dataStatus.length > 0) {
        Text(this.dataStatus)
          .fontSize(12).fontColor($r('app.color.text_secondary'))
          .padding(10).width('100%')
          .backgroundColor($r('app.color.soft_surface')).borderRadius(10)
      }
      Button('导出完整备份 (.json)', { type: ButtonType.Normal })
        .width('100%').height(42).fontSize(13).borderRadius(12)
        .enabled(!this.busy)
        .backgroundColor($r('app.color.brand'))
        .fontColor($r('app.color.inverse_text'))
        .onClick((): void => { this.onExportBackup(); })
      Button('导出 Markdown 合集 (.md)', { type: ButtonType.Normal })
        .width('100%').height(42).fontSize(13).borderRadius(12)
        .enabled(!this.busy)
        .backgroundColor($r('app.color.brand_soft'))
        .fontColor($r('app.color.brand'))
        .onClick((): void => { this.onExportMarkdown(); })
      Row({ space: 8 }) {
        Button('导入 / 恢复备份', { type: ButtonType.Normal })
          .layoutWeight(1).height(40).fontSize(12).borderRadius(10)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => { this.onImportFiles(); })
        Button('重建索引', { type: ButtonType.Normal })
          .layoutWeight(1).height(40).fontSize(12).borderRadius(10)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => { this.onRebuildIndex(); })
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private aboutSection() {
    Column({ space: 12 }) {
      Text('关于与帮助').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      Button('使用说明 →', { type: ButtonType.Normal })
        .width('100%').height(40).fontSize(13).borderRadius(10)
        .backgroundColor($r('app.color.soft_surface'))
        .fontColor($r('app.color.brand'))
        .onClick((): void => { this.onOpenHelp(); })
      Button('回收站 →', { type: ButtonType.Normal })
        .width('100%').height(40).fontSize(13).borderRadius(10)
        .backgroundColor($r('app.color.soft_surface'))
        .fontColor($r('app.color.text_primary'))
        .onClick((): void => { this.onOpenTrash(); })
      Row({ space: 8 }) {
        Button('隐私说明', { type: ButtonType.Normal })
          .layoutWeight(1).height(38).fontSize(12).borderRadius(10)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => {
            this.onShowInfo('隐私说明', '默认离线可用，无需账号，不申请无关权限。笔记、思维导图与索引均保存在本机。');
          })
        Button('数据格式说明', { type: ButtonType.Normal })
          .layoutWeight(1).height(38).fontSize(12).borderRadius(10)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => {
            this.onShowInfo('数据格式说明', '笔记以标准 Markdown 文件存储，数据库仅保存可随时重建的索引。');
          })
      }
      .width('100%')
      Text('知萤 LexiNote · 插件底座 v1')
        .fontSize(11).fontColor($r('app.color.text_secondary'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Row({ space: 0 }) {
      Column({ space: 4 }) {
        Row({ space: 8 }) {
          Text('设置')
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
        }
        .width('100%')
        .height(56)
        .padding({ left: 6 })

        ForEach(this.categories, (item: LexiSettingsCategory) => {
          this.categoryItem(item)
        }, (item: LexiSettingsCategory): string => item.id)

        if (this.category === 'plugin-settings') {
          Column({ space: 4 }) {
            Text(this.settingsPluginName).fontSize(11).fontColor($r('app.color.text_secondary')).maxLines(1)
            Text('插件设置').fontSize(12).fontColor($r('app.color.brand'))
          }
          .width('100%')
          .padding(10)
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(8)
          .alignItems(HorizontalAlign.Start)
        }
      }
      .width(220)
      .height('100%')
      .padding({ left: 14, right: 12, top: 16, bottom: 16 })
      .backgroundColor($r('app.color.workspace_sidebar'))
      .border({ width: { right: 0.5 }, color: $r('app.color.workspace_line') })

      Column({ space: 12 }) {
        Row({ space: 8 }) {
          Text(this.category === 'plugin-settings' ? `${this.settingsPluginName} · 设置` :
            (this.category === 'market' ? '社区插件市场' :
              (this.categories.find((item: LexiSettingsCategory): boolean => item.id === this.category)?.label ?? '设置')))
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
          Button('关闭', { type: ButtonType.Normal })
            .height(34).fontSize(12).borderRadius(9)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick((): void => { this.onClose(); })
        }
        .width('100%')

        Scroll() {
          Column({ space: 16 }) {
            if (this.category === 'appearance') {
              this.appearanceSection()
            } else if (this.category === 'editor') {
              this.editorSection()
            } else if (this.category === 'plugins') {
              this.pluginSection()
            } else if (this.category === 'market') {
              LexiPluginMarketSheet({
                onInstalled: (_pluginId: string): void => { this.refreshPlugins(); }
              })
            } else if (this.category === 'plugin-settings') {
              LexiPluginSettingsSheet({ pluginId: this.settingsPluginId })
            } else if (this.category === 'data') {
              this.dataSection()
            } else {
              this.aboutSection()
            }
          }
          .width('100%')
          .constraintSize({ maxWidth: 860 })
          .padding({ bottom: 24 })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.TopStart)
      }
      .layoutWeight(1)
      .height('100%')
      .padding({ left: 24, right: 24, top: 16 })
    }
    .width('100%')
    .height('100%')
    .padding({ top: 52 })
    .backgroundColor($r('app.color.workspace_page'))
  }
}