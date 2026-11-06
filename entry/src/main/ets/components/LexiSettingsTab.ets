import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { LexiAppearancePicker } from './LexiAppearancePicker';
import { LexiHeroHeading } from './LexiNoteCard';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import {
  LexiPluginMarketSheet,
  pluginFailureKind,
  pluginFailureLabel,
  pluginFailureSummary
} from './plugin/LexiPluginMarketSheet';
import { LexiPluginSettingsSheet } from './plugin/LexiPluginSettingsSheet';

@Observed
class LexiPluginSettingRow {
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
struct LexiPluginRowView {
  @ObjectLink row: LexiPluginSettingRow;
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
          .id(`plugin-settings-${this.row.id}`)
          .height(32)
          .fontSize(11)
          .borderRadius(9)
          .enabled(this.row.enabled)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick((): void => {
            this.onOpenRowSettings(this.row.id, this.row.name);
          })
      }

      Toggle({ type: ToggleType.Switch, isOn: this.row.enabled })
        .id(`plugin-toggle-${this.row.id}`)
        .enabled(this.row.canToggle)
        .selectedColor($r('app.color.brand'))
        .onChange((isOn: boolean): void => {
          this.onToggleRow(this.row.id, isOn);
        })
    }
    .width('100%')
    .padding(10)
    .backgroundColor($r('app.color.soft_surface'))
    .borderRadius(12)
  }
}

@Component
export struct LexiSettingsTab {
  @Prop isWide: boolean = false;
  @Prop pagePadding: number = 24;
  @Prop bottomInset: number = 0;
  @Prop titleCollapsed: boolean = false;
  @Prop theme: string = 'system';
  @Prop defaultTier: string = 'simple';
  @Prop busy: boolean = false;
  @Prop dataStatus: string = '';
  @Prop lastBackup: string = '';
  onSelectTheme: (theme: string) => void = (_theme: string): void => {};
  onSelectTier: (tier: string) => void = (_tier: string): void => {};
  onExportBackup: () => void = () => {};
  onExportMarkdown: () => void = () => {};
  onImportFiles: () => void = () => {};
  onRebuildIndex: () => void = () => {};
  onOpenHelp: () => void = () => {};
  onOpenTrash: () => void = () => {};
  onShowInfo: (title: string, message: string) => void = (_title: string, _message: string): void => {};
  @State private pluginRows: LexiPluginSettingRow[] = [];
  @State private pluginSafeMode: boolean = false;
  // P1-003d(R28):旧共享 realm 轨开关 UI 态(默认 true,随 manager 读回)。
  @State private pluginLegacyTrack: boolean = true;
  @State private pluginBusy: boolean = false;
  @State private pluginHint: string = '';
  @State private sheetOpen: boolean = false;
  @State private sheetMode: string = 'market';
  @State private settingsPluginId: string = '';
  @State private settingsPluginName: string = '';

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
    // 按 id 复用行对象,保证 @ObjectLink 绑定稳定,属性变更可触发局部重渲染
    const existing: Map<string, LexiPluginSettingRow> = new Map();
    for (const row of this.pluginRows) { existing.set(row.id, row); }
    const rows: LexiPluginSettingRow[] = [];
    for (const plugin of manager.installedPlugins()) {
      if (!plugin.manifest.id || !plugin.manifest.name) { continue; }
      let row = existing.get(plugin.manifest.id);
      if (!row) {
        row = new LexiPluginSettingRow();
        row.id = plugin.manifest.id;
      }
      row.name = plugin.manifest.name;
      row.version = plugin.manifest.version;
      row.enabled = plugin.enabled;
      row.canToggle = !this.pluginBusy && !this.pluginSafeMode;
      row.hasSettings = manager.hasPluginSettings(plugin.manifest.id);
      // 失败态复用插件市场的同一套纯函数:标签 + 单行摘要,不在设置页另写判
      const failureText: string = pluginFailureKind(plugin.errorState) !== 'normal'
        ? `${pluginFailureLabel(plugin.errorState)} · ${pluginFailureSummary(plugin.errorState)}`
        : '';
      row.detail = failureText.length > 0 ? failureText : (plugin.enabled ? `已启用 · v${plugin.manifest.version}` : '已停用');
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
    // 幂等守卫:受控 Toggle 在重渲染时可能补发一次反向事件,状态已一致则忽略
    const current = manager.installedPlugins().find((plugin): boolean => plugin.manifest.id === id);
    if (!current || current.enabled === enabled) {
      this.refreshPlugins();
      return;
    }
    this.pluginBusy = true;
    // 乐观更新行状态,让绑定值立即跟随用户意图,避免开关回弹
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

  private openMarket(): void {
    this.sheetMode = 'market';
    this.sheetOpen = true;
  }

  private openPluginSettings(pluginId: string, pluginName: string): void {
    this.settingsPluginId = pluginId;
    this.settingsPluginName = pluginName;
    this.sheetMode = 'settings';
    this.sheetOpen = true;
  }

  @Builder
  private marketSheet() {
    if (this.sheetMode === 'settings') {
      LexiPluginSettingsSheet({ pluginId: this.settingsPluginId })
    } else {
      LexiPluginMarketSheet({
        onInstalled: (_pluginId: string): void => { this.refreshPlugins(); }
      })
    }
  }

  build() {
    Column({ space: 16 }) {
      LexiHeroHeading({
        headingId: 'primary-heading-3',
        title: '我的',
        subtitle: '',
        isWide: this.isWide,
        collapsed: this.titleCollapsed
      })

      Button('回收站  →', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
        .id('settings-trash-entry').width('100%').height(52).fontSize(15).borderRadius(18)
        .backgroundColor($r('app.color.surface')).fontColor($r('app.color.brand_ink'))
        .onClick((): void => { this.onOpenTrash(); })

      Column({ space: 10 }) {
        Text('外观')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        LexiAppearancePicker({
          theme: this.theme,
          onSelect: (val: string): void => {
            this.onSelectTheme(val);
          }
        })
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(22)

      Column({ space: 10 }) {
        Text('默认编辑工具')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Row({ space: 8 }) {
          ForEach(
            [
              ['simple', '简洁'],
              ['study', '学习'],
              ['pro', '专业']
            ],
            (item: string[]) => {
              Button(item[1], { type: ButtonType.Normal })
                .layoutWeight(1)
                .height(40)
                .fontSize(13)
                .fontWeight(this.defaultTier === item[0] ? FontWeight.Bold : FontWeight.Medium)
                .borderRadius(12)
                .backgroundColor(this.defaultTier === item[0] ? $r('app.color.brand') : $r('app.color.soft_surface'))
                .fontColor(this.defaultTier === item[0] ? $r('app.color.inverse_text') : $r('app.color.text_primary'))
                .onClick(() => {
                  this.onSelectTier(item[0]);
                })
            },
            (item: string[]): string => item[0]
          )
        }
        .width('100%')
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(22)

      Column({ space: 12 }) {
        Row({ space: 8 }) {
          Text('插件')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
          Text(`已安装 ${this.pluginRows.length}`)
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .width('100%')

        Row({ space: 10 }) {
          Column({ space: 3 }) {
            Text('安全模式').fontSize(13).fontColor($r('app.color.text_primary'))
            Text('停用全部插件，并以禁用状态启动').fontSize(11).fontColor($r('app.color.text_secondary'))
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)

          Toggle({ type: ToggleType.Switch, isOn: this.pluginSafeMode })
            .id('plugin-safemode-toggle')
            .enabled(!this.pluginBusy)
            .selectedColor($r('app.color.brand'))
            .onChange((isOn: boolean): void => {
              this.toggleSafeMode(isOn);
            })
        }
        .width('100%')

        // P1-003d(R28):旧共享 realm 轨(runtime 页共享求值面)停用开关。默认开(沙箱轨
        // 真机验收完成前行为不回归);关闭后未声明沙箱轨的插件装载一律 fail-closed。
        Row({ space: 10 }) {
          Column({ space: 3 }) {
            Text('旧版插件轨(共享 realm)').fontSize(13).fontColor($r('app.color.text_primary'))
            Text('关闭后仅沙箱轨插件可装载，其余拒绝启用（fail-closed）').fontSize(11).fontColor($r('app.color.text_secondary'))
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)

          Toggle({ type: ToggleType.Switch, isOn: this.pluginLegacyTrack })
            .id('plugin-legacy-track-toggle')
            .enabled(!this.pluginBusy)
            .selectedColor($r('app.color.brand'))
            .onChange((isOn: boolean): void => {
              this.toggleLegacyTrack(isOn);
            })
        }
        .width('100%')

        Row({ space: 8 }) {
          Button('从文件安装插件 (.zip)', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(40)
            .fontSize(12)
            .borderRadius(12)
            .enabled(!this.pluginBusy)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick((): void => {
              this.installFromPicker();
            })

          Button('社区插件市场', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(40)
            .fontSize(12)
            .borderRadius(12)
            .enabled(!this.pluginBusy)
            .backgroundColor($r('app.color.brand_soft'))
            .fontColor($r('app.color.brand'))
            .onClick((): void => {
              this.openMarket();
            })
        }
        .width('100%')

        if (this.pluginHint.length > 0) {
          Text(this.pluginHint)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
        }
        if (this.pluginRows.length === 0 && this.pluginHint.length === 0) {
          Text('还没有安装插件。插件目录：应用沙箱 plugins/')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .padding(10)
            .backgroundColor($r('app.color.soft_surface'))
            .borderRadius(10)
        }
        ForEach(this.pluginRows, (row: LexiPluginSettingRow) => {
          LexiPluginRowView({
            row: row,
            onToggleRow: (id: string, enabled: boolean): void => {
              this.togglePlugin(id, enabled);
            },
            onOpenRowSettings: (id: string, name: string): void => {
              this.openPluginSettings(id, name);
            }
          })
        }, (row: LexiPluginSettingRow): string => row.id)
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(22)

      Column({ space: 12 }) {
        Text('数据与备份')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .width('100%')

        if (this.lastBackup.length > 0) {
          Text(`最近备份：${this.lastBackup}`)
            .fontSize(12)
            .fontColor($r('app.color.brand'))
            .width('100%')
        }
        if (this.dataStatus.length > 0) {
          Text(this.dataStatus)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .padding(10)
            .width('100%')
            .backgroundColor($r('app.color.soft_surface'))
            .borderRadius(10)
        }

        Button('导出完整备份 (.json)', { type: ButtonType.Normal })
          .width('100%')
          .height(44)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .borderRadius(14)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.inverse_text'))
          .onClick(() => {
            this.onExportBackup();
          })

        Button('导出 Markdown 合集 (.md)', { type: ButtonType.Normal })
          .width('100%')
          .height(44)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .borderRadius(14)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.onExportMarkdown();
          })

        Row({ space: 8 }) {
          Button('导入 / 恢复备份', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(42)
            .fontSize(12)
            .borderRadius(12)
            .enabled(!this.busy)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.onImportFiles();
            })

          Button('重建索引', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(42)
            .fontSize(12)
            .borderRadius(12)
            .enabled(!this.busy)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.onRebuildIndex();
            })
        }
        .width('100%')
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(22)

      Column({ space: 10 }) {
        Text('关于与帮助')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .width('100%')

        Button('使用说明 →', { type: ButtonType.Normal })
          .width('100%')
          .height(42)
          .fontSize(13)
          .borderRadius(12)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.onOpenHelp();
          })

        Row({ space: 8 }) {
          Button('隐私说明', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(40)
            .fontSize(12)
            .borderRadius(12)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.onShowInfo(
                '隐私说明',
                '默认离线可用，无需账号，不申请无关权限。笔记、思维导图与索引均保存在本机。'
              );
            })

          Button('数据格式说明', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(40)
            .fontSize(12)
            .borderRadius(12)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.onShowInfo(
                '数据格式说明',
                '笔记以标准 Markdown 文件存储，数据库仅保存可随时重建的索引。重命名笔记时自动更新双向链接与导图引用。'
              );
            })
        }
        .width('100%')
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(22)
    }
    .width('100%')
    .constraintSize({ maxWidth: 1080 })
    .padding({ left: this.pagePadding, right: this.pagePadding, bottom: (this.isWide ? 36 : 88) + this.bottomInset })
    .bindSheet($$this.sheetOpen, this.marketSheet(), {
      height: 560,
      dragBar: false,
      showClose: true,
      title: { title: this.sheetMode === 'settings' ? `${this.settingsPluginName} · 设置` : '社区插件市场' },
      backgroundColor: $r('app.color.surface')
    })
  }
}
