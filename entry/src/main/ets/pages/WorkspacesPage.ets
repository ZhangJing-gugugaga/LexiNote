import { deviceInfo } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { LexiBackHeader } from '../components/LexiBackHeader';
import { LexiContextSurface } from '../components/LexiContextSurface';
import { LexiContextTarget } from '../core/LexiContextModels';
import { LexiIcon } from '../components/LexiIcon';
import { LexiProject, NoteItem, VaultItem } from '../core/LexiModels';
import { LexiFolderStore } from '../core/LexiFolderStore';
import { LexiStorageService } from '../core/LexiStorageService';

@Builder
export function workspacesPageBuilder() { WorkspacesPage() }

@Component
export struct WorkspacesPage {
  @StorageProp('lexiTopInset') topInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @StorageProp('lexiWorkspaceRevision') @Watch('scopeUpdated') private scopeRevision: number = 0;
  @State private removedVaults: VaultItem[] = [];
  @State private removedProjects: LexiProject[] = [];
  private scopeUpdated(): void { this.reload().catch((): void => { this.message = '刷新失败，请重试'; }); }
  private async restoreScope(kind: string, id: string): Promise<void> {
    await LexiStorageService.updateScope(kind, id, '', undefined, false); await this.reload(); this.notifySelection();
  }
  @State private vaults: VaultItem[] = [];
  @State private projects: LexiProject[] = [];
  @State private activeVaultId: string = '';
  @State private activeProjectId: string = '';
  @State private formKind: string = '';
  @State private draftName: string = '';
  @State private draftFolder: string = '';
  @State private draftPermission: string = '';
  @State private createChild: boolean = false;
  @State private working: boolean = false;
  @State private message: string = '';
  private pathStack: NavPathStack = new NavPathStack();
  private pageScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    this.reload().catch((error: Error): void => { this.message = error.message || '读取工作区失败'; });
  }

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  private currentVault(): VaultItem | undefined { return this.vaults.find((vault: VaultItem): boolean => vault.id === this.activeVaultId); }
  private currentProjects(): LexiProject[] { return this.projects.filter((project: LexiProject): boolean => project.vaultId === this.activeVaultId); }
  private notifySelection(): void {
    AppStorage.setOrCreate('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
  }

  private async reload(): Promise<void> {
    await LexiStorageService.init(this.context());
    this.vaults = await LexiStorageService.getVaults();
    this.projects = await LexiStorageService.getProjects();
    this.removedVaults = (await LexiStorageService.getVaults(true)).filter((vault: VaultItem): boolean => vault.archived);
    this.removedProjects = (await LexiStorageService.getProjects('', true)).filter((project: LexiProject): boolean => project.archived);
    this.activeVaultId = await LexiStorageService.getActiveVaultId();
    this.activeProjectId = await LexiStorageService.getActiveProjectId(this.activeVaultId);
  }

  private beginForm(kind: string): void {
    this.formKind = kind; this.draftName = ''; this.message = '';
    const vault = this.currentVault();
    this.draftFolder = kind === 'project' && vault ? vault.folderUri || '' : '';
    this.draftPermission = kind === 'project' && vault ? vault.permissionUri || vault.folderUri || '' : '';
    this.createChild = kind === 'project' && !!this.draftFolder;
    this.pageScroller.scrollEdge(Edge.Top);
  }

  private async chooseFolder(): Promise<void> {
    if (this.working) { return; }
    this.working = true;
    try {
      const uri = await LexiFolderStore.choose(this.context(), this.draftFolder);
      if (uri) {
        this.draftFolder = uri; this.draftPermission = uri; this.createChild = false;
        if (!this.draftName.trim()) { this.draftName = LexiFolderStore.folderName(uri); }
      }
    } catch (error) { this.message = (error as Error).message || '选择文件夹失败'; }
    finally { this.working = false; }
  }

  private async submit(): Promise<void> {
    if (this.working) { return; }
    if (!this.draftFolder) { this.message = '请先选择文件夹'; return; }
    if (!this.draftName.trim()) { this.message = '请输入名称'; return; }
    this.working = true; this.message = '正在扫描文件夹中的 Markdown 文件…';
    try {
      let scannedCount = 0;
      if (this.formKind === 'workspace') {
        const created = await LexiStorageService.createFolderWorkspace(this.draftName, this.draftFolder, this.createChild, this.draftPermission);
        scannedCount = (await LexiStorageService.getNotes(created.id)).filter((item: NoteItem): boolean => item.trashedAt === 0).length;
      } else {
        const createdProject = await LexiStorageService.createFolderProject(this.activeVaultId, this.draftName, this.draftFolder, this.createChild, this.draftPermission);
        scannedCount = (await LexiStorageService.getNotes(this.activeVaultId)).filter((item: NoteItem): boolean => item.trashedAt === 0 && item.projectId === createdProject.id).length;
      }
      await this.reload(); this.formKind = '';
      this.message = `已保存并扫描完成，共导入 ${scannedCount} 篇 Markdown 文件。`;
      this.notifySelection();
    } catch (error) { this.message = (error as Error).message || '打开文件夹失败，已有内容已保留'; }
    finally { this.working = false; }
  }

  private async selectWorkspace(vaultId: string): Promise<void> {
    if (this.working) { return; }
    this.working = true; this.message = '';
    try {
      await LexiStorageService.setActiveVaultId(vaultId);
      try { await LexiStorageService.refreshFolders(vaultId); } catch (error) { this.message = (error as Error).message; }
      await this.reload(); this.notifySelection();
    } catch (error) { this.message = (error as Error).message || '切换工作区失败'; }
    finally { this.working = false; }
  }

  private async selectProject(projectId: string): Promise<void> {
    if (this.working) { return; }
    this.working = true;
    try {
      await LexiStorageService.setActiveProjectId(this.activeVaultId, projectId);
      this.notifySelection(); this.pathStack.pop();
    } catch (error) { this.message = (error as Error).message || '打开项目失败'; }
    finally { this.working = false; }
  }

  private async refreshFolders(): Promise<void> {
    if (this.working) { return; }
    this.working = true; this.message = '正在刷新文件夹…';
    try {
      await LexiStorageService.refreshFolders(this.activeVaultId);
      await this.reload(); this.notifySelection(); this.message = '文件夹内容已更新';
    } catch (error) { this.message = (error as Error).message || '刷新失败，缓存笔记仍然保留'; }
    finally { this.working = false; }
  }

  private async reauthorize(id: string, project: boolean): Promise<void> {
    if (this.working) { return; }
    this.working = true;
    try {
      const target = project ? this.projects.find((item: LexiProject): boolean => item.id === id) : undefined;
      const vault = !project ? this.vaults.find((item: VaultItem): boolean => item.id === id) : undefined;
      const original = target ? target.folderUri : vault ? vault.folderUri : '';
      const uri = await LexiFolderStore.choose(this.context(), original);
      if (uri) {
        await LexiStorageService.reauthorizeFolder(id, project, uri);
        await this.reload(); this.notifySelection(); this.message = '文件夹授权已更新';
      }
    } catch (error) { this.message = (error as Error).message || '授权失败'; }
    finally { this.working = false; }
  }

  @Builder
  private editForm() {
    Column({ space: 14 }) {
      Text(this.formKind === 'workspace' ? '添加工作区' : '添加项目').fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      TextInput({ text: this.draftName, placeholder: this.formKind === 'workspace' ? '工作区名称' : '项目名称' })
        .id('workspace-name-input').width('100%').height(44).fontSize(14).fontColor($r('app.color.text_primary'))
        .placeholderColor($r('app.color.text_secondary')).backgroundColor($r('app.color.soft_surface')).borderRadius(8)
        .enabled(!this.working).onChange((text: string): void => { this.draftName = text; })
      Button(this.draftFolder ? LexiFolderStore.path(this.draftFolder) : '选择文件夹', { type: ButtonType.Normal })
        .id('workspace-folder-picker').width('100%').constraintSize({ minHeight: 44 }).fontSize(13).borderRadius(8)
        .padding(12).fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.workspace_selection'))
        .enabled(!this.working).onClick((): void => { this.chooseFolder(); })
      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Checkbox, isOn: this.createChild })
          .id('workspace-create-child').width(28).height(28).selectedColor($r('app.color.brand'))
          .accessibilityText('在所选目录下新建同名文件夹').enabled(!this.working)
          .onChange((checked: boolean): void => { this.createChild = checked; })
        Text('在所选目录下新建同名文件夹').fontSize(13).fontColor($r('app.color.text_primary')).layoutWeight(1)
          .constraintSize({ minHeight: 44 }).onClick((): void => { if (!this.working) { this.createChild = !this.createChild; } })
      }.width('100%')
      Text('选择已有文件夹会读取其中的 Markdown 笔记，编辑时保存回原文件。')
        .fontSize(12).lineHeight(21).fontColor($r('app.color.text_secondary')).width('100%')
      Row({ space: 12 }) {
        Button(this.working ? '正在处理…' : '保存', { type: ButtonType.Normal })
          .id('workspace-submit').height(40).fontSize(13).borderRadius(8).padding({ left: 24, right: 24 })
          .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text')).enabled(!this.working)
          .onClick((): void => { this.submit(); })
        Button('取消', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('workspace-cancel').height(40).fontSize(13).borderRadius(8).fontColor($r('app.color.text_secondary'))
          .enabled(!this.working).onClick((): void => { this.formKind = ''; this.message = ''; })
      }.width('100%')
    }.width('100%').padding(20).borderRadius(12).backgroundColor($r('app.color.workspace_sidebar')).alignItems(HorizontalAlign.Start)
  }

  @Builder
  private folderActionMenu(id: string, project: boolean) {
    Menu() {
      MenuItem({ content: '重新授权文件夹' }).enabled(!this.working)
        .onClick((): void => { this.reauthorize(id, project); })
    }
  }

  @Builder
  private folderActions(id: string, project: boolean) {
    Button('授权', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
      .id(`folder-actions-${id}`).width(44).height(40).fontSize(12).padding(0).borderRadius(7)
      .fontColor($r('app.color.text_secondary')).backgroundColor(Color.Transparent).accessibilityText('文件夹操作')
      .bindMenu(this.folderActionMenu(id, project))
  }

  @Builder
  private pageTitle() {
    LexiBackHeader({ title: '工作区与项目', onBack: (): void => { this.pathStack.pop(); } })
  }

  build() {
    NavDestination() {
      Scroll(this.pageScroller) {
        Column({ space: 24 }) {
          if (this.message) {
            Text(this.message).id('workspace-status').fontSize(13).lineHeight(22).fontColor($r('app.color.brand_ink'))
              .width('100%').padding(12).borderRadius(8).backgroundColor($r('app.color.workspace_selection'))
          }
          if (this.formKind) { this.editForm(); }
          Row() {
            Text('工作区').fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1)
            Button('添加工作区', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .id('workspace-add').height(38).fontSize(13).fontColor($r('app.color.brand_ink')).enabled(!this.working)
              .onClick((): void => { this.beginForm('workspace'); })
          }.width('100%')
          Column({ space: 6 }) {
            ForEach(this.vaults, (vault: VaultItem) => {
              Row({ space: 12 }) {
                Column() {
                LexiContextSurface({ target: LexiContextTarget.scope('workspace', vault.id, vault.id, '', vault.name, vault.favorite) }) {
                Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                  Row({ space: 12 }) {
                    LexiIcon({ name: 'folder', iconSize: 22 })
                    Column({ space: 5 }) {
                      Text(`${vault.favorite ? '★  ' : ''}${vault.name}`).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
                      Text(vault.folderUri ? LexiFolderStore.path(vault.folderUri) : '应用内工作区')
                        .fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                    if (vault.id === this.activeVaultId) { Text('当前').fontSize(11).fontColor($r('app.color.brand_ink')); }
                  }.width('100%')
                }.id(`workspace-card-${vault.id}`).width('100%').constraintSize({ minHeight: 72 }).padding({ left: 12, right: deviceInfo.deviceType === 'tablet' ? 56 : 12, top: 12, bottom: 12 }).borderRadius(9)
                  .backgroundColor(vault.id === this.activeVaultId ? $r('app.color.workspace_selection') : $r('app.color.workspace_sidebar'))
                  .enabled(!this.working).onClick((): void => { this.selectWorkspace(vault.id); })
                }
                }.layoutWeight(1)
                if (vault.folderUri) {
                  this.folderActions(vault.id, false)
                }
              }.width('100%')
            }, (vault: VaultItem): string => `${vault.id}-${vault.folderUri}-${vault.name}-${vault.favorite}`)
          }.width('100%')
          Row() {
            Text('当前工作区的项目').fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1)
            Button('添加项目', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .id('project-add').height(38).fontSize(13).fontColor($r('app.color.brand_ink')).enabled(!this.working)
              .onClick((): void => { this.beginForm('project'); })
          }.width('100%')
          Column({ space: 8 }) {
            Button('浏览整个工作区', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .id('project-all').height(40).width('100%').fontSize(13).borderRadius(8).fontColor($r('app.color.brand_ink'))
              .backgroundColor(!this.activeProjectId ? $r('app.color.workspace_selection') : Color.Transparent)
              .enabled(!this.working).onClick((): void => { this.selectProject(''); })
            ForEach(this.currentProjects(), (project: LexiProject) => {
              Row({ space: 12 }) {
                Column() {
                LexiContextSurface({ target: LexiContextTarget.scope('project', project.id, project.vaultId, project.id, project.name, project.favorite) }) {
                Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                  Column({ space: 6 }) {
                    Text(project.name).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
                    Text(project.folderUri ? LexiFolderStore.path(project.folderUri) : '应用内项目').fontSize(12).fontColor($r('app.color.text_secondary'))
                      .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                  }.width('100%').alignItems(HorizontalAlign.Start)
                }.id(`project-card-${project.id}`).width('100%').constraintSize({ minHeight: 70 }).padding({ left: 14, right: deviceInfo.deviceType === 'tablet' ? 56 : 14, top: 14, bottom: 14 }).borderRadius(8)
                  .backgroundColor(this.activeProjectId === project.id ? $r('app.color.workspace_selection') : $r('app.color.workspace_sidebar'))
                  .enabled(!this.working).onClick((): void => { this.selectProject(project.id); })
                }
                }.layoutWeight(1)
                if (project.folderUri) {
                  this.folderActions(project.id, true)
                }
              }.width('100%')
            }, (project: LexiProject): string => `${project.id}-${project.folderUri}-${project.name}-${project.favorite}`)
            if (this.currentProjects().length === 0) {
              Text('还没有项目。添加一个文件夹，把相关的笔记放在一起。').fontSize(13).lineHeight(22)
                .fontColor($r('app.color.text_secondary')).width('100%').padding({ top: 8, bottom: 8 })
            }
          }.width('100%')
          if (this.removedVaults.length > 0 || this.removedProjects.length > 0) {
            Column({ space: 10 }) {
              Text('已移除').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
              Text('原文件保留，可重新启用。').fontSize(13).fontColor($r('app.color.text_secondary')).width('100%')
              ForEach(this.removedVaults, (removedVault: VaultItem) => {
                Button(`重新启用工作区：${removedVault.name}`, { buttonStyle: ButtonStyleMode.TEXTUAL }).height(44)
                  .fontColor($r('app.color.brand')).onClick((): void => { this.restoreScope('workspace', removedVault.id); })
              }, (removedVault: VaultItem): string => removedVault.id)
              ForEach(this.removedProjects, (removedProject: LexiProject) => {
                Button(`重新启用文件夹：${removedProject.name}`, { buttonStyle: ButtonStyleMode.TEXTUAL }).height(44)
                  .fontColor($r('app.color.brand')).onClick((): void => { this.restoreScope('project', removedProject.id); })
              }, (removedProject: LexiProject): string => removedProject.id)
            }.width('100%')
          }
          Button('刷新文件夹内容', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
            .id('workspace-refresh-folders').fontSize(13).height(40).fontColor($r('app.color.brand_ink')).enabled(!this.working)
            .onClick((): void => { this.refreshFolders(); })
        }.width('100%').constraintSize({ maxWidth: 960 }).padding({ left: 28, right: 28, top: 24, bottom: 40 + this.bottomInset })
      }.width('100%').height('100%').align(Alignment.Top).scrollBar(BarState.Auto)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    }.hideBackButton(true).backgroundColor($r('app.color.workspace_page'))
      .title({ builder: (): void => { this.pageTitle(); }, height: 56 + (this.viewportWidth < 840 ? this.topInset : 0) })
      .onReady((context: NavDestinationContext): void => { this.pathStack = context.pathStack; })
  }
}
