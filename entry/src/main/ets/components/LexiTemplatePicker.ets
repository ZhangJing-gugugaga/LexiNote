import { NoteItem } from '../core/LexiModels';
import { LexiTemplateItem } from '../core/LexiTemplateLibrary';
import { MarkdownEngine } from '../core/MarkdownEngine';

@Component
export struct LexiTemplatePicker {
  @Prop templates: LexiTemplateItem[] = [];
  @Prop defaultTemplateId: string = '';
  @Prop templateBusy: boolean = false;
  @State private newTitle: string = '';
  @State private localBusy: boolean = false;
  @State private messageText: string = '';
  onCreate: (templateId: string, title: string) => void = (_id: string, _title: string): void => {};
  onSetDaily: (id: string) => void = (_id: string): void => {};
  onNewTemplate: () => void = (): void => {};
  onEdit: (id: string) => void = (_id: string): void => {};
  onDelete: (id: string) => Promise<void> = async (_id: string): Promise<void> => {};

  private busy(): boolean { return this.templateBusy || this.localBusy; }

  private confirmDelete(template: LexiTemplateItem): void {
    if (this.busy()) { return; }
    this.getUIContext().showAlertDialog({ title: `删除「${template.title || '未命名模板'}」？`,
      message: '此操作只删除模板，不影响已经用它创建的笔记。' +
        (template.builtIn ? '内置模板删除后也不会自动恢复。' : '') +
        (this.defaultTemplateId === template.id ? '当前日记默认模板也会被清除。' : ''),
      primaryButton: { value: '取消', action: (): void => {} },
      secondaryButton: { value: '删除模板', fontColor: $r('app.color.error'),
        action: (): void => { this.deleteTemplate(template.id); } } });
  }

  private async deleteTemplate(id: string): Promise<void> {
    if (this.busy()) { return; }
    this.localBusy = true; this.messageText = '';
    try { await this.onDelete(id); }
    catch (error) { this.messageText = (error as Error).message || '模板删除失败，请重试。'; }
    finally { this.localBusy = false; }
  }

  private snippet(template: LexiTemplateItem): string {
    if (!MarkdownEngine.parseFrontmatter(template.content).body.trim()) { return '空白模板'; }
    const note = new NoteItem(); note.title = template.title; note.content = template.content;
    return MarkdownEngine.extractSnippet(note) || '空白模板';
  }

  build() {
    Column({ space: 16 }) {
      Text('选择一个模板开始记录，也可以编辑内置模板，或创建自己的模板。')
        .fontSize(13).lineHeight(20).fontColor($r('app.color.text_secondary')).width('100%')
      if (this.messageText) {
        Text(this.messageText).id('template-status-message').fontSize(12).lineHeight(19)
          .fontColor($r('app.color.error')).width('100%')
      }
      TextInput({ text: this.newTitle, placeholder: '新笔记标题（可选）' }).id('template-note-title')
        .height(44).width('100%').borderRadius(12).padding({ left: 14, right: 14 }).enabled(!this.busy())
        .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface'))
        .onChange((text: string): void => { this.newTitle = text; })
      Flex({ wrap: FlexWrap.Wrap }) {
        Button('新建模板', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('template-new')
          .height(38).fontSize(13).padding({ left: 16, right: 16 }).borderRadius(12)
          .fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.brand_soft'))
          .margin({ right: 8 }).enabled(!this.busy()).onClick(this.onNewTemplate)
        Button('清除日记默认', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('template-clear-daily')
          .height(38).fontSize(12).fontColor($r('app.color.text_secondary')).enabled(!this.busy() && !!this.defaultTemplateId)
          .onClick((): void => { this.onSetDaily(''); })
      }.width('100%')
      Scroll() {
        Column({ space: 16 }) {
          ForEach(this.templates, (template: LexiTemplateItem) => {
            Column({ space: 12 }) {
              Text(template.title || '未命名模板').fontSize(16).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary')).width('100%').maxLines(2)
              Flex({ wrap: FlexWrap.Wrap }) {
                Text(template.builtIn ? '内置' : '自建').fontSize(10).fontColor($r('app.color.brand_ink'))
                  .padding({ left: 7, right: 7, top: 3, bottom: 3 }).borderRadius(6)
                  .backgroundColor($r('app.color.brand_soft')).margin({ right: 6, bottom: 4 })
                Text(template.category || '通用').fontSize(10).fontColor($r('app.color.text_secondary'))
                  .padding({ left: 7, right: 7, top: 3, bottom: 3 }).borderRadius(6)
                  .backgroundColor($r('app.color.surface')).margin({ right: 6, bottom: 4 })
                if (this.defaultTemplateId === template.id) {
                  Text('日记默认').fontSize(10).fontColor($r('app.color.brand_ink'))
                    .padding({ left: 7, right: 7, top: 3, bottom: 3 }).borderRadius(6)
                    .backgroundColor($r('app.color.brand_soft')).margin({ right: 6, bottom: 4 })
                }
              }.width('100%')
              Text(this.snippet(template)).fontSize(12).lineHeight(19).maxLines(3)
                .fontColor($r('app.color.text_secondary')).width('100%')
              Row({ space: 6 }) {
                Button('使用模板').id(`template-use-${template.id}`).layoutWeight(1)
                  .enabled(!this.busy()).height(38).fontSize(13).padding({ left: 10, right: 10 })
                  .borderRadius(10).fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.brand_soft'))
                  .onClick((): void => { this.onCreate(template.id, this.newTitle); })
                Button('编辑', { buttonStyle: ButtonStyleMode.TEXTUAL }).id(`template-edit-${template.id}`)
                  .height(38).fontSize(12).padding({ left: 10, right: 10 }).enabled(!this.busy())
                  .onClick((): void => { this.onEdit(template.id); })
                Button('删除', { buttonStyle: ButtonStyleMode.TEXTUAL }).id(`template-delete-${template.id}`)
                  .height(38).fontSize(12).padding({ left: 10, right: 10 }).fontColor($r('app.color.error'))
                  .enabled(!this.busy()).onClick((): void => { this.confirmDelete(template); })
              }.width('100%')
              Button(this.defaultTemplateId === template.id ? '日记默认 ✓' : '设为日记默认', { buttonStyle: ButtonStyleMode.TEXTUAL })
                .id(`template-daily-${template.id}`).width('100%').height(34).fontSize(12)
                .fontColor(this.defaultTemplateId === template.id ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
                .enabled(!this.busy() && this.defaultTemplateId !== template.id)
                .onClick((): void => { this.onSetDaily(template.id); })
            }.id(`template-card-${template.id}`).width('100%').padding(18).borderRadius(20)
              .backgroundColor($r('app.color.surface'))
              .border({ width: 0.5, color: $r('app.color.workspace_line') })
          }, (template: LexiTemplateItem): string => `${template.id}-${template.updatedAt}-${template.title}-${template.category}`)
          if (this.templates.length === 0) {
            Text('模板库还没有内容。点击「新建模板」开始，或将已有笔记保存为模板。').fontSize(14).lineHeight(22)
              .fontColor($r('app.color.text_secondary')).padding(20).width('100%')
          }
        }.width('100%')
      }.width('100%').layoutWeight(1).align(Alignment.TopStart)
    }.width('100%').height('100%').padding({ left: 24, right: 24, top: 8, bottom: 24 })
  }
}
