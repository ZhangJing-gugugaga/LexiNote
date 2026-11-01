import { LexiAppearancePicker } from './LexiAppearancePicker';
import { LexiHeroHeading } from './LexiNoteCard';

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
  }
}
