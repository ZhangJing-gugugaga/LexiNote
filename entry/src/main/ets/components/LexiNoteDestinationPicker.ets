import { LexiProject, VaultItem } from '../core/LexiModels';
import { LexiIcon } from './LexiIcon';

@Component
export struct LexiNoteDestinationPicker {
  @Prop vaults: VaultItem[] = [];
  @Prop projects: LexiProject[] = [];
  @Prop busy: boolean = false;
  @Prop saveOnly: boolean = false;
  @State private vaultId: string = '';
  @State private projectId: string = '';
  onConfirm: (vaultId: string, projectId: string) => void = (_vaultId: string, _projectId: string): void => {};

  private projectsInWorkspace(): LexiProject[] {
    return this.projects.filter((project: LexiProject): boolean => project.vaultId === this.vaultId);
  }
  private selectedWorkspaceName(): string {
    return this.vaults.find((vault: VaultItem): boolean => vault.id === this.vaultId)?.name ?? '';
  }

  build() {
    Column({ space: 16 }) {
      Text('这篇笔记保存在哪里？').fontSize(15).fontColor($r('app.color.text_secondary')).width('100%')
      Scroll() {
        Column({ space: 10 }) {
          ForEach(this.vaults, (vault: VaultItem) => {
            Button({ type: ButtonType.Normal }) {
              Row({ space: 12 }) {
                LexiIcon({ name: 'folder', iconSize: 22 })
                Column({ space: 5 }) {
                  Text(vault.name).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
                  Text(vault.folderUri ? '保存到绑定的文件夹' : '保存在应用内').fontSize(12).fontColor($r('app.color.text_secondary'))
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                Text(this.vaultId === vault.id ? '✓' : '').fontSize(20).fontColor($r('app.color.brand'))
              }.width('100%').padding(16)
            }.id(`note-destination-workspace-${vault.id}`).width('100%').constraintSize({ minHeight: 76 })
              .borderRadius(16).backgroundColor(this.vaultId === vault.id ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
              .accessibilitySelected(this.vaultId === vault.id).enabled(!this.busy)
              .onClick(() => { this.vaultId = vault.id; this.projectId = ''; })
          }, (vault: VaultItem): string => `${vault.id}-${vault.name}`)
          if (this.vaultId && this.projectsInWorkspace().length > 0) {
            Text('保存到项目（可选）').fontSize(14).fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.text_primary')).width('100%').margin({ top: 14 })
            Button(this.projectId === '' ? '✓  工作区根目录' : '工作区根目录', { type: ButtonType.Normal })
              .id('note-destination-root').width('100%').height(48).borderRadius(13).fontSize(14)
              .backgroundColor(this.projectId === '' ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
              .fontColor($r('app.color.text_primary')).enabled(!this.busy)
              .onClick(() => { this.projectId = ''; })
            ForEach(this.projectsInWorkspace(), (project: LexiProject) => {
              Button(`${this.projectId === project.id ? '✓  ' : ''}${project.name}`, { type: ButtonType.Normal })
                .id(`note-destination-project-${project.id}`).width('100%').height(48).borderRadius(13).fontSize(14)
                .backgroundColor(this.projectId === project.id ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
                .fontColor($r('app.color.text_primary')).enabled(!this.busy)
                .onClick(() => { this.projectId = project.id; })
            }, (project: LexiProject): string => `${project.id}-${project.name}`)
          }
        }.width('100%')
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
      if (this.vaultId) {
        Text(`${this.selectedWorkspaceName()} / ${this.projectsInWorkspace().find((project: LexiProject): boolean =>
          project.id === this.projectId)?.name ?? '根目录'}`)
          .id('note-destination-summary').fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(2).width('100%')
      }
      Button(this.busy ? '正在保存…' : this.saveOnly ? '保存到这里' : '在这里新建笔记', { type: ButtonType.Normal })
        .id('note-destination-confirm').width('100%').height(48).borderRadius(15).fontSize(15)
        .fontColor($r('app.color.inverse_text')).backgroundColor($r('app.color.brand'))
        .enabled(this.vaultId.length > 0 && !this.busy)
        .onClick(() => { this.onConfirm(this.vaultId, this.projectId); })
    }.width('100%').height('100%').padding({ left: 24, right: 24, top: 12, bottom: 24 })
  }
}
