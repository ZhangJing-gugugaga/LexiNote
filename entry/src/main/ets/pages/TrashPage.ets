import { common } from '@kit.AbilityKit';
import { LexiBackHeader } from '../components/LexiBackHeader';
import { LexiIcon } from '../components/LexiIcon';
import { NoteItem } from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiStorageService } from '../core/LexiStorageService';

@Builder
export function trashPageBuilder() {
  TrashPage()
}

@Component
export struct TrashPage {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @State private deletedNotes: NoteItem[] = [];
  @State private working: boolean = false;
  @State private loadError: string = '';
  private pathStack: NavPathStack = new NavPathStack();

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private async refresh(): Promise<void> {
    try {
      await LexiStorageService.init(this.context());
      this.deletedNotes = (await LexiStorageService.getNotes('')).filter((note: NoteItem): boolean => note.trashedAt > 0)
        .sort((first: NoteItem, second: NoteItem): number => second.trashedAt - first.trashedAt);
      this.loadError = '';
    } catch { this.loadError = '读取回收站失败，请重试'; }
  }

  private toast(message: string): void {
    this.getUIContext().getPromptAction().showToast({ message: message });
  }

  private async restore(note: NoteItem): Promise<void> {
    if (this.working) { return; }
    this.working = true;
    try {
      await LexiStorageService.setNoteTrash(this.context(), note.id, false);
      await this.refresh();
      this.toast('笔记已恢复');
    } catch { this.toast('恢复失败，请重试'); }
    finally { this.working = false; }
  }

  private async remove(notes: NoteItem[]): Promise<void> {
    if (this.working || notes.length === 0) { return; }
    this.working = true;
    try {
      const choice = await this.getUIContext().getPromptAction().showDialog({
        title: notes.length === 1 ? '永久删除这篇笔记？' : '清空回收站？',
        message: notes.length === 1 ? `「${MarkdownEngine.displayTitle(notes[0])}」将被永久删除，此操作无法撤销。` :
          `${notes.length} 篇笔记将被永久删除，此操作无法撤销。`,
        buttons: [{ text: '取消', color: $r('app.color.text_secondary') },
          { text: '永久删除', color: $r('app.color.error') }]
      });
      if (choice.index !== 1) { return; }
      for (const note of notes) { await LexiStorageService.deleteNotePermanently(note.id); }
      await this.refresh();
      this.toast('已永久删除');
    } catch { await this.refresh(); this.toast('未能完成删除，请重试'); }
    finally { this.working = false; }
  }

  @Builder
  private titleBar() {
    LexiBackHeader({ title: '回收站', subtitle: `${this.deletedNotes.length} 篇已删除笔记`,
      actionLabel: this.deletedNotes.length > 0 && !this.working ? '清空' : '',
      onBack: (): void => { this.pathStack.pop(); },
      onAction: (): void => { this.remove(this.deletedNotes.slice()); } })
  }

  build() {
    NavDestination() {
      Scroll() {
        Column({ space: 14 }) {
          Text('删除的笔记会保留在这里，可恢复或永久删除。')
            .fontSize(13).lineHeight(22).fontColor($r('app.color.text_secondary')).width('100%')
          if (this.loadError) {
            Button(this.loadError).id('trash-retry').onClick((): void => { this.refresh(); })
          } else if (this.deletedNotes.length === 0) {
            Column({ space: 12 }) {
              LexiIcon({ name: 'trash', iconSize: 36, muted: true })
              Text('回收站是空的').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            }.width('100%').padding({ top: 72, bottom: 72 })
          } else {
            ForEach(this.deletedNotes, (note: NoteItem) => {
              Column({ space: 12 }) {
                Text(MarkdownEngine.displayTitle(note)).fontSize(17).fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.text_primary')).width('100%').maxLines(2)
                Text(MarkdownEngine.extractSnippet(note)).fontSize(13).lineHeight(21)
                  .fontColor($r('app.color.text_secondary')).width('100%').maxLines(3)
                Row({ space: 12 }) {
                  Button('恢复', { buttonStyle: ButtonStyleMode.TEXTUAL }).id(`trash-restore-${note.id}`)
                    .height(44).fontColor($r('app.color.brand')).enabled(!this.working)
                    .onClick((): void => { this.restore(note); })
                  Button('永久删除', { buttonStyle: ButtonStyleMode.TEXTUAL }).id(`trash-delete-${note.id}`)
                    .height(44).fontColor($r('app.color.error')).enabled(!this.working)
                    .onClick((): void => { this.remove([note]); })
                }.width('100%')
              }.width('100%').padding(20).borderRadius(20).backgroundColor($r('app.color.surface'))
            }, (note: NoteItem): string => `${note.id}-${note.trashedAt}`)
          }
        }.width('100%').constraintSize({ maxWidth: 960 }).padding({ left: 24, right: 24, top: 20, bottom: 24 + this.bottomInset })
      }.width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Off)
    }.hideBackButton(true)
      .title({ builder: (): void => { this.titleBar(); }, height: 56 + (this.viewportWidth < 840 ? this.titleTopInset : 0) })
      .backgroundColor($r('app.color.background'))
      .onReady((context: NavDestinationContext): void => { this.pathStack = context.pathStack; })
      .onShown((): void => { this.refresh(); })
  }
}
