import { common } from '@kit.AbilityKit';
import { LexiWorkspaceEditor } from '../components/LexiWorkspaceEditor';
import { LexiWorkspaceMindMap } from '../components/LexiWorkspaceMindMap';
import { LexiWorkspaceTab } from '../core/LexiWorkspaceModels';
import { MindMapDoc, NoteItem } from '../core/LexiModels';
import { LexiStorageService } from '../core/LexiStorageService';

@Entry({ useSharedStorage: true })
@Component
struct DocumentWindow {
  @LocalStorageProp('documentNoteId') private documentId: string = '';
  @StorageProp('lexiWorkspaceRevision') @Watch('refresh') private revision: number = 0;
  @State private windowWidth: number = 900;
  @State private notes: NoteItem[] = [];
  @State private tabs: LexiWorkspaceTab[] = [];
  @State private ready: boolean = false;
  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void { this.open(this.documentId); }
  private async refresh(): Promise<void> {
    const activeId = this.tabs[0]?.noteId || this.documentId;
    if (activeId.startsWith('map:')) {
      const map = await LexiStorageService.getMindMapById(activeId.substring(4));
      if (map) { this.notes = await LexiStorageService.getNotes(map.vaultId); }
      return;
    }
    const current = await LexiStorageService.getNoteById(activeId);
    if (current) { this.notes = await LexiStorageService.getNotes(current.vaultId); }
  }
  private async open(id: string): Promise<void> {
    for (const tab of this.tabs) { await tab.controller.flush(); }
    await LexiStorageService.init(this.context());
    if (id.startsWith('map:')) {
      const map = await LexiStorageService.getMindMapById(id.substring(4));
      if (!map) { this.getUIContext().getPromptAction().showToast({ message: '该思维导图已不存在' }); return; }
      this.notes = await LexiStorageService.getNotes(map.vaultId);
      this.tabs = [new LexiWorkspaceTab(id)]; this.ready = true;
      return;
    }
    const note = await LexiStorageService.getNoteById(id);
    if (!note) { this.getUIContext().getPromptAction().showToast({ message: '该笔记已不存在' }); return; }
    this.notes = await LexiStorageService.getNotes(note.vaultId);
    this.tabs = [new LexiWorkspaceTab(id)]; this.ready = true;
  }
  build() {
    Column() {
      Row({ space: 10 }) {
        Image($r('app.media.lexi_logo')).width(26).height(26)
        Text('知萤 LexiNote').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
      }.width('100%').height(52).padding({ left: 18, right: 168 }).backgroundColor($r('app.color.workspace_tabs'))
      if (this.ready) {
        Column() {
          ForEach(this.tabs, (tab: LexiWorkspaceTab) => {
            if (tab.noteId.startsWith('map:')) {
              LexiWorkspaceMindMap({
                mapId: tab.noteId.substring(4),
                editorController: tab.controller,
                paneWidth: this.windowWidth,
                vaultNotes: this.notes,
                onOpenNote: (id: string): void => { this.open(id); },
                onSavedNote: (_note: NoteItem): void => {
                  AppStorage.setOrCreate('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
                },
                onSaved: (_doc: MindMapDoc): void => {
                  AppStorage.setOrCreate('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
                }
              })
            } else {
              LexiWorkspaceEditor({ noteId: tab.noteId, editorController: tab.controller, paneWidth: this.windowWidth, vaultNotes: this.notes,
                onOpenNote: (id: string): void => { this.open(id); },
                onSaved: (_note: NoteItem): void => {
                  AppStorage.setOrCreate('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
                } })
            }
          }, (tab: LexiWorkspaceTab): string => tab.noteId)
        }.width('100%').layoutWeight(1)
      } else {
        Text('正在打开文档…').fontSize(14).fontColor($r('app.color.text_secondary')).layoutWeight(1)
      }
    }.width('100%').height('100%').backgroundColor($r('app.color.workspace_page'))
      .onAreaChange((_old: Area, current: Area): void => { this.windowWidth = Number(current.width); })
  }
}
