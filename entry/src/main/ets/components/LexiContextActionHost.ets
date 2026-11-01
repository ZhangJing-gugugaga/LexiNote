import { common } from '@kit.AbilityKit';
import { CanvasBoard, LexiProject, MindMapDoc, NoteItem, NoteRevision, VaultItem } from '../core/LexiModels';
import { LexiContextCommand, LexiContextTarget } from '../core/LexiContextModels';
import { LexiStorageService as Storage } from '../core/LexiStorageService';
import { LexiFileActions } from '../core/LexiFileActions';
import { MarkdownEngine } from '../core/MarkdownEngine';

@Component
export struct LexiContextActionHost {
  @StorageProp('lexiContextCommand') @Watch('received') private commandText: string = '';
  @State private showPanel: boolean = false;
  @State private panelTitle: string = '';
  @State private phase: string = '';
  @State private target: LexiContextTarget = new LexiContextTarget();
  @State private working: boolean = false;
  @State private message: string = '';
  @State private nameText: string = '';
  @State private vaults: VaultItem[] = [];
  @State private projects: LexiProject[] = [];
  @State private notes: NoteItem[] = [];
  @State private revisions: NoteRevision[] = [];
  @State private selectedVault: string = '';
  @State private selectedProject: string = '';
  @State private selectedNote: string = '';
  @State private selectedRevision: string = '';
  @State private searchText: string = '';
  onOpen: (id: string, mode: string) => void = (_id: string, _mode: string): void => {};
  onSearch: (target: LexiContextTarget) => void = (_target: LexiContextTarget): void => {};
  private processingCommand: boolean = false;
  private nameDialogId: number = -1;
  private async openNameDialog(): Promise<void> {
    this.nameDialogId = await this.getUIContext().getPromptAction().openCustomDialog({
      builder: (): void => { this.nameForm(); }, alignment: DialogAlignment.Center,
      width: Math.min(420, (AppStorage.get<number>('lexiViewportWidth') || 390) - 48),
      backgroundColor: $r('app.color.surface'), backgroundBlurStyle: BlurStyle.NONE,
      cornerRadius: 24, autoCancel: true,
      onDidDisappear: (): void => { this.nameDialogId = -1; }
    });
  }
  private closeNameDialog(): void {
    if (this.nameDialogId >= 0) { this.getUIContext().getPromptAction().closeCustomDialog(this.nameDialogId); this.nameDialogId = -1; }
  }
  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  private toast(text: string): void { this.getUIContext().getPromptAction().showToast({ message: text }); }
  private notify(): void { AppStorage.setOrCreate('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1); }
  private received(): void {
    if (!this.commandText || AppStorage.get<string>('lexiContextLastHandled') === this.commandText) { return; }
    AppStorage.setOrCreate('lexiContextLastHandled', this.commandText);
    if (this.processingCommand || this.working) { this.toast('正在处理上一项操作，请稍候'); return; }
    this.processingCommand = true;
    this.handle(JSON.parse(this.commandText) as LexiContextCommand).catch((error: Error): void => {
      this.toast(error.message || '操作失败，请重试');
    }).finally((): void => { this.processingCommand = false; });
  }
  private async handle(command: LexiContextCommand): Promise<void> {
    if (this.working) { return; }
    await Storage.flushPendingWrites(); this.target = command.target; this.message = ''; this.searchText = '';
    const action = command.action;
    const spatial = this.target.kind === 'mindmap' || this.target.kind === 'canvas';
    if (action.startsWith('open-') && action !== 'open-external') {
      if (action === 'open-window') {
        await this.context().startAbility({ bundleName: 'com.lovexjy.lexinote', abilityName: 'DocumentAbility',
          parameters: { noteId: spatial ? `${this.target.kind === 'mindmap' ? 'map' : 'canvas'}:${this.target.id}` : this.target.id } });
      } else { this.onOpen(spatial ? `${this.target.kind === 'mindmap' ? 'map' : 'canvas'}:${this.target.id}` : this.target.id, action === 'open-group' ? 'group' : 'tab'); }
      return;
    }
    if (action === 'search') { this.onSearch(this.target); return; }
    if (action === 'save-template' && this.target.kind === 'note') {
      await Storage.saveNoteAsTemplate(this.target.id);
      this.toast('已添加到独立模板库，可在“模板”中编辑'); return;
    }
    if (action === 'copy-path' || action === 'copy-relative') {
      await LexiFileActions.copyPath(this.context(), this.target, action === 'copy-relative'); this.toast('路径已复制'); return;
    }
    if (action === 'reveal' || action === 'open-external') {
      try {
        if (action === 'reveal') { await LexiFileActions.reveal(this.context(), this.target); }
        else { await LexiFileActions.openExternal(this.context(), this.target); }
      } catch (error) {
        if (action === 'open-external') { throw new Error('系统没有可打开此 Markdown 文件的应用。可先打开笔记，再从工具中导出文件。'); }
        this.phase = 'location'; this.panelTitle = '所在文件夹';
        this.message = (error as Error).message || '系统无法打开此文件夹';
        this.nameText = await LexiFileActions.path(this.context(), this.target);
        this.selectedNote = this.target.kind === 'note' ? this.target.id : '';
        this.notes = (await Storage.getNotes(this.target.vaultId)).filter((note: NoteItem): boolean => note.trashedAt === 0 &&
          (note.projectId || '') === this.target.projectId && (this.target.kind !== 'folder' || note.notebook === this.target.notebook));
        if (this.target.kind === 'note') {
          const parent = this.nameText.substring(0, this.nameText.lastIndexOf('/'));
          this.notes = this.notes.filter((note: NoteItem): boolean => note.path.substring(0, note.path.lastIndexOf('/')) === parent);
        }
        this.showPanel = true;
      }
      return;
    }
    if (action === 'new-folder' || action === 'rename') {
      this.phase = action; this.panelTitle = action === 'rename' ? '重命名' : '新建文件夹';
      this.nameText = action === 'rename' ? this.target.title : ''; await this.openNameDialog(); return;
    }
    if (action === 'move' || action === 'merge') {
      this.vaults = await Storage.getVaults(); this.projects = await Storage.getProjects();
      this.notes = (await Storage.getNotes(this.target.vaultId)).filter((n: NoteItem): boolean => n.id !== this.target.id && n.trashedAt === 0);
      this.selectedVault = this.target.vaultId; this.selectedProject = this.target.projectId; this.selectedNote = '';
      if (this.target.kind === 'workspace') { this.selectedVault = ''; this.selectedProject = ''; }
      this.phase = action; this.panelTitle = action === 'merge' ? '合并到另一篇笔记' : '移动到'; this.showPanel = true; return;
    }
    if (action === 'history') {
      this.revisions = await Storage.getNoteHistory(this.target.id); this.selectedRevision = '';
      this.phase = 'history'; this.panelTitle = '版本历史'; this.showPanel = true; return;
    }
    if (action === 'delete') {
      const note = this.target.kind === 'note' || this.target.kind === 'folder';
      this.getUIContext().showAlertDialog({ title: spatial ? '删除这个文件？' : note ? '移到回收站？' : '从列表移除？',
        message: spatial ? `「${this.target.title}」将被删除，此操作无法撤销。` : note ? `「${this.target.title}」中的笔记可从回收站恢复。` : '原文件与内容保留。可在工作区管理的“已移除”区域重新启用。',
        primaryButton: { value: '取消', action: (): void => {} },
        secondaryButton: { value: spatial ? '删除' : note ? '移到回收站' : '移除', fontColor: $r('app.color.error'),
          action: (): void => { this.runImmediate('delete'); } } }); return;
    }
    await this.runImmediate(action);
  }
  private scopeNotes(): NoteItem[] {
    return this.notes.filter((note: NoteItem): boolean => (!this.target.projectId || (note.projectId || '') === this.target.projectId) &&
      (this.target.kind !== 'folder' || note.notebook === this.target.notebook));
  }
  private async runImmediate(action: string): Promise<void> {
    if (this.working) { return; } this.working = true;
    try {
      if (this.target.kind === 'mindmap' || this.target.kind === 'canvas') {
        const opened = await LexiFileActions.spatialAction(this.context(), this.target, action);
        if (opened) { this.onOpen(opened, 'tab'); }
        this.notify(); return;
      }
      if (action === 'new-note' || action === 'new-table' || action === 'new-canvas') {
        const id = await LexiFileActions.create(this.context(), this.target, action); this.onOpen(id, 'tab');
      } else if (action === 'duplicate') {
        if (this.target.kind === 'note') {
          const copy = await Storage.duplicateNote(this.context(), this.target.id); this.onOpen(copy.id, 'tab');
        } else { await LexiFileActions.duplicateScope(this.context(), this.target); }
        this.toast('副本已创建');
      } else if (action === 'favorite') {
        if (this.target.kind === 'note') { await Storage.toggleNoteFavorite(this.context(), this.target.id); }
        else if (this.target.kind === 'folder') {
          this.notes = await Storage.getNotes(this.target.vaultId); const scope = this.scopeNotes();
          const favorite = !scope.every((n: NoteItem): boolean => n.favorite);
          for (const n of scope) { if (n.favorite !== favorite) { await Storage.toggleNoteFavorite(this.context(), n.id); } }
        } else { await Storage.updateScope(this.target.kind, this.target.id, '', !this.target.favorite); }
      } else if (action === 'delete') {
        if (this.target.kind === 'note') { await Storage.setNoteTrash(this.context(), this.target.id, true); }
        else if (this.target.kind === 'folder') {
          this.notes = await Storage.getNotes(this.target.vaultId);
          for (const n of this.scopeNotes()) { await Storage.setNoteTrash(this.context(), n.id, true); }
        } else { await Storage.updateScope(this.target.kind, this.target.id, '', undefined, true); }
        this.toast(this.target.kind === 'note' || this.target.kind === 'folder' ? '已移到回收站' : '已移除，原文件保留');
      }
      this.notify();
    } catch (error) { this.toast((error as Error).message || '操作失败，原内容已保留'); }
    finally { this.working = false; }
  }
  private async commit(): Promise<void> {
    if (this.working) { return; } this.working = true; this.message = '';
    try {
      if (this.phase === 'new-folder') { await Storage.createInternalProject(this.context(), this.target.vaultId, this.nameText); }
      else if (this.phase === 'rename') {
        if (!this.nameText.trim()) { throw new Error('名称不能为空'); }
        if (this.target.kind === 'mindmap' || this.target.kind === 'canvas') {
          await LexiFileActions.spatialAction(this.context(), this.target, 'rename', this.nameText);
        } else if (this.target.kind === 'note') { await Storage.renameNote(this.context(), this.target.id, this.nameText); }
        else if (this.target.kind === 'folder') { await Storage.renameNotebook(this.context(), this.target.vaultId, this.target.projectId, this.target.notebook, this.nameText); }
        else { await Storage.updateScope(this.target.kind, this.target.id, this.nameText); }
      } else if (this.phase === 'merge') {
        const saved = await Storage.mergeNotes(this.context(), this.target.id, this.selectedNote); this.onOpen(saved.id, 'tab');
      } else if (this.phase === 'history') {
        await Storage.restoreNoteRevision(this.context(), this.target.id, this.selectedRevision); this.toast('已恢复，恢复前的内容也已保留在历史中');
      } else if (this.phase === 'move') { await this.move(); }
      this.notify(); this.showPanel = false; this.closeNameDialog();
    } catch (error) { this.message = (error as Error).message || '操作失败，请重试'; }
    finally { this.working = false; }
  }
  private async move(): Promise<void> {
    if (!this.selectedVault) { throw new Error('请选择目标工作区'); }
    if (this.target.kind === 'note') {
      await Storage.moveNote(this.context(), this.target.id, this.selectedVault, this.selectedProject);
    } else if (this.target.kind === 'project') {
      await Storage.updateScope('project', this.target.id, '', undefined, undefined, this.selectedVault);
    } else {
      const notes = (await Storage.getNotes(this.target.vaultId)).filter((n: NoteItem): boolean => this.target.kind === 'workspace' ||
        ((!this.target.projectId || (n.projectId || '') === this.target.projectId) && n.notebook === this.target.notebook));
      if (this.target.kind === 'workspace' && this.selectedVault === this.target.vaultId) { throw new Error('请选择另一个工作区'); }
      for (const note of notes) {
        if (this.target.kind === 'workspace' && note.projectId) { continue; }
        const moved = await Storage.moveNote(this.context(), note.id, this.selectedVault, this.selectedProject);
        if (this.target.kind === 'folder') { moved.notebook = this.target.notebook; await Storage.saveNote(this.context(), moved); }
      }
      if (this.target.kind === 'workspace') {
        for (const project of await Storage.getProjects(this.target.vaultId)) {
          await Storage.updateScope('project', project.id, '', undefined, undefined, this.selectedVault);
        }
        for (const map of await Storage.getMindMaps(this.target.vaultId)) {
          if (!map.projectId) { map.vaultId = this.selectedVault; map.projectId = this.selectedProject; await Storage.saveMindMap(this.context(), map); }
        }
        for (const board of await Storage.getCanvases(this.target.vaultId)) {
          if (!board.projectId) { board.vaultId = this.selectedVault; board.projectId = this.selectedProject; await Storage.saveCanvas(this.context(), board); }
        }
        await Storage.syncScopeCatalog(this.target.vaultId);
        await Storage.updateScope('workspace', this.target.id, '', undefined, true);
      }
    }
  }
  private selectionNotes(): NoteItem[] {
    return this.notes.filter((n: NoteItem): boolean => !this.searchText || MarkdownEngine.displayTitle(n).includes(this.searchText));
  }
  @Builder
  private destination() {
    Text('选择工作区和目标文件夹').fontSize(14).fontColor($r('app.color.text_secondary')).width('100%')
    if (this.selectedVault && this.selectedVault !== this.target.vaultId && this.target.kind === 'note') {
      Text('各工作区的标题链接独立解析，跨区移动后需要重新关联相关笔记。').fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary'))
    }
    if (this.target.kind === 'project') {
      Text('将项目归入目标工作区，已绑定的磁盘目录保持原位置。').fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary'))
    }
    if (this.target.kind === 'workspace') {
      Text('将内容移入另一个工作区，完成后移除原工作区入口。').fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary'))
    }
    ForEach(this.vaults.filter((vault: VaultItem): boolean => this.target.kind !== 'workspace' || vault.id !== this.target.vaultId), (vault: VaultItem) => {
      Button(`${vault.id === this.selectedVault ? '✓  ' : ''}${vault.name}`, { type: ButtonType.Normal })
        .id(`context-destination-${vault.id}`).height(48).width('100%').borderRadius(12).fontSize(15)
        .backgroundColor(vault.id === this.selectedVault ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
        .fontColor($r('app.color.text_primary')).onClick((): void => { this.selectedVault = vault.id; this.selectedProject = ''; })
    }, (vault: VaultItem): string => vault.id)
    if (this.selectedVault && this.target.kind !== 'project') {
      Button(this.selectedProject ? '工作区根目录' : '✓  工作区根目录', { type: ButtonType.Normal }).height(44).width('100%')
        .backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.text_primary')).borderRadius(12)
        .onClick((): void => { this.selectedProject = ''; })
      ForEach(this.projects.filter((project: LexiProject): boolean => project.vaultId === this.selectedVault), (project: LexiProject) => {
        Button(`${project.id === this.selectedProject ? '✓  ' : ''}${project.name}`, { type: ButtonType.Normal }).height(44).width('100%')
          .id(`context-project-${project.id}`).backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.text_primary')).borderRadius(12)
          .onClick((): void => { this.selectedProject = project.id; })
      }, (project: LexiProject): string => project.id)
    }
  }
  @Builder
  private nameForm() {
    Column({ space: 16 }) {
      Text(this.panelTitle).fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).width('100%')
      TextInput({ text: this.nameText, placeholder: '请输入名称' }).id('context-name-input').height(48).width('100%')
        .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface')).borderRadius(12)
        .onChange((text: string): void => { this.nameText = text; })
        .enterKeyType(EnterKeyType.Done).onSubmit((): void => { this.getUIContext().getFocusController().clearFocus(); this.commit(); })
      if (this.phase === 'rename' && (this.target.kind === 'workspace' || this.target.kind === 'project')) {
        Text('修改应用内显示名称，磁盘目录保留原名。').fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary')).width('100%')
      }
      if (this.message) { Text(this.message).fontSize(13).fontColor($r('app.color.error')).width('100%'); }
      Button(this.working ? '正在处理…' : '确定', { type: ButtonType.Normal }).id('context-confirm')
        .width('100%').height(48).fontSize(15).borderRadius(14).enabled(!this.working && !!this.nameText.trim())
        .fontColor($r('app.color.inverse_text')).backgroundColor($r('app.color.brand'))
        .onClick((): void => { this.getUIContext().getFocusController().clearFocus(); this.commit(); })
      Button('取消', { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(40).fontSize(14)
        .fontColor($r('app.color.text_secondary')).onClick((): void => { this.closeNameDialog(); })
    }.width('100%').padding(24)
  }

  @Builder
  private panel() {
    if (this.phase === 'rename' || this.phase === 'new-folder') { this.nameForm(); } else {
    Column({ space: 16 }) {
      Scroll() {
        Column({ space: 12 }) {
          if (this.phase === 'rename' || this.phase === 'new-folder') {
            TextInput({ text: this.nameText, placeholder: '请输入名称' }).id('context-name-input').height(48).width('100%')
              .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface')).borderRadius(12)
              .onChange((text: string): void => { this.nameText = text; })
            if (this.phase === 'rename' && (this.target.kind === 'workspace' || this.target.kind === 'project')) {
              Text('修改应用内显示名称，已绑定的磁盘目录保留原名。').fontSize(13).lineHeight(22).fontColor($r('app.color.text_secondary'))
            }
          } else if (this.phase === 'move') { this.destination(); }
          else if (this.phase === 'merge' || this.phase === 'location') {
            if (this.phase === 'merge') {
              Text('将正文追加到目标笔记，原笔记移入回收站，相关标题链接同步更新。').fontSize(13).lineHeight(22).fontColor($r('app.color.text_secondary'))
              TextInput({ text: this.searchText, placeholder: '搜索目标笔记' }).height(44).width('100%')
                .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
                .onChange((text: string): void => { this.searchText = text; })
            } else {
              Text(this.nameText).fontSize(13).lineHeight(22).fontColor($r('app.color.text_secondary')).width('100%').copyOption(CopyOptions.LocalDevice)
              Text('以下显示应用中的内容。').fontSize(13).fontColor($r('app.color.text_secondary'))
            }
            ForEach(this.selectionNotes(), (note: NoteItem) => {
              Button(`${this.selectedNote === note.id ? '✓  ' : ''}${MarkdownEngine.displayTitle(note)}`, { type: ButtonType.Normal })
                .id(`context-note-${note.id}`).width('100%').height(48).fontSize(14).borderRadius(12)
                .backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.text_primary'))
                .onClick((): void => {
                  if (this.phase === 'location') { this.showPanel = false; this.onOpen(note.id, 'tab'); } else { this.selectedNote = note.id; this.getUIContext().getFocusController().clearFocus(); }
                })
            }, (note: NoteItem): string => `${note.id}-${note.updatedAt}`)
          } else if (this.phase === 'history') {
            Text('保留最近 20 次正文或标题修改。恢复版本前的内容会继续保留。').fontSize(13).lineHeight(22).fontColor($r('app.color.text_secondary'))
            if (this.revisions.length === 0) {
              Text('还没有历史版本。后续修改并保存后，旧版本会自动出现在这里。').fontSize(14).lineHeight(24).fontColor($r('app.color.text_primary'))
            }
            ForEach(this.revisions, (revision: NoteRevision) => {
              Button(`${this.selectedRevision === revision.id ? '✓  ' : ''}${new Date(revision.savedAt).toLocaleString()}`, { type: ButtonType.Normal })
                .id(`context-revision-${revision.id}`).width('100%').height(48).fontSize(14).borderRadius(12)
                .backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.text_primary'))
                .onClick((): void => { this.selectedRevision = revision.id; })
              if (this.selectedRevision === revision.id) {
                Text(revision.snapshot.content || '空白正文').width('100%').fontSize(14).lineHeight(23)
                  .fontColor($r('app.color.text_primary')).padding(16).backgroundColor($r('app.color.soft_surface')).borderRadius(12)
              }
            }, (revision: NoteRevision): string => revision.id)
          }
        }.width('100%')
      }.width('100%').layoutWeight(1).align(Alignment.Top)
      if (this.message) { Text(this.message).fontSize(13).fontColor($r('app.color.error')).width('100%'); }
      if (this.phase !== 'location') {
        Button(this.working ? '正在处理…' : this.phase === 'history' ? '恢复此版本' : this.phase === 'merge' ? '确认合并' : '确定', { type: ButtonType.Normal })
          .id('context-confirm').height(48).width('100%').fontSize(15).borderRadius(14)
          .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
          .enabled(!this.working && (this.phase !== 'merge' || !!this.selectedNote) && (this.phase !== 'history' || !!this.selectedRevision))
          .onClick((): void => { this.commit(); })
      }
    }.width('100%').height('100%').padding({ left: 24, right: 24, top: 12, bottom: 24 })
    }
  }
  build() {
    Column().width(0).height(0).bindSheet($$this.showPanel, this.panel, {
      height: SheetSize.LARGE, keyboardAvoidMode: SheetKeyboardAvoidMode.TRANSLATE_AND_RESIZE, dragBar: true, showClose: true, title: { title: this.panelTitle }, backgroundColor: $r('app.color.surface')
    })
  }
}
