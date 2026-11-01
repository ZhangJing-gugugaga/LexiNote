import { vibrator } from '@kit.SensorServiceKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { LexiContextAction, LexiContextBridge, LexiContextTarget } from '../core/LexiContextModels';

@Builder
function emptyContextContent() {}

@Component
export struct LexiContextSurface {
  @StorageProp('lexiViewportWidth') private viewportWidth: number = 390;
  @State private pressActive: boolean = false;
  @State private phoneMenuVisible: boolean = false;
  @State private phoneMenuX: number = 0;
  @State private phoneMenuY: number = 0;
  private showPhoneMenu(event: GestureEvent): void {
    if (this.phoneMenuVisible) { return; }
    const finger = event.fingerList[0];
    this.phoneMenuX = finger ? finger.localX : 0;
    this.phoneMenuY = finger ? finger.localY : 0;
    this.pressActive = false;
    this.phoneMenuVisible = true;
    if (canIUse('SystemCapability.Sensors.MiscDevice')) {
      try { vibrator.startVibration({ type: 'time', duration: 10 }, { usage: 'touch' }).catch((): void => {}); } catch {}
    }
  }
  @Prop tabletCard: boolean = false;
  @Prop contextEnabled: boolean = true;
  @Prop target: LexiContextTarget = new LexiContextTarget();
  @BuilderParam content: () => void = emptyContextContent;
  beforeAction: () => Promise<void> = async (): Promise<void> => {};

  private desktop(): boolean { return deviceInfo.deviceType === '2in1'; }
  private inlineMenu(): boolean { return deviceInfo.deviceType === 'tablet' || (!this.desktop() && this.viewportWidth >= 840); }
  private file(): boolean { return ['note', 'mindmap', 'canvas'].includes(this.target.kind); }
  private primary(action: LexiContextAction): boolean {
    return this.file() ? ['open-tab', 'duplicate', 'move', 'favorite', 'save-template', 'rename'].includes(action.id) : action.group === '创建';
  }
  private secondary(): LexiContextAction[] {
    return LexiContextBridge.actions(this.target, false).filter((action: LexiContextAction): boolean =>
      !this.primary(action) && action.id !== 'delete' && (this.file() || action.id !== 'rename'));
  }
  private async run(action: string): Promise<void> {
    try { await this.beforeAction(); LexiContextBridge.send(action, this.target); }
    catch { this.getUIContext().getPromptAction().showToast({ message: '保存未完成，请重试。' }); }
  }
  @Builder
  private moreMenu() {
    Menu() {
      ForEach(this.secondary(), (action: LexiContextAction) => {
        MenuItem({ content: action.label }).id(`context-${action.id}`).height(48).borderRadius(0).contentFont({ size: 15 })
          .contentFontColor($r('app.color.text_primary')).border({ width: { bottom: 0.5 }, color: $r('app.color.divider') })
          .onClick((): void => { this.run(action.id); })
      }, (action: LexiContextAction): string => action.id)
    }.width(240).borderRadius(24).backgroundColor($r('app.color.surface'))
  }
  @Builder
  private menu() {
    Menu() {
      if (this.desktop()) {
        ForEach(['打开', '创建', '整理', '文件', '管理'], (group: string) => {
          if (LexiContextBridge.actions(this.target, true).some((action: LexiContextAction): boolean => action.group === group)) {
            MenuItemGroup() {
              ForEach(LexiContextBridge.actions(this.target, true).filter((action: LexiContextAction): boolean => action.group === group),
                (action: LexiContextAction) => {
                  MenuItem({ content: action.label }).id(`context-${action.id}`)
                    .contentFontColor(action.id === 'delete' ? $r('app.color.error') : $r('app.color.text_primary'))
                    .onClick((): void => { this.run(action.id); })
                }, (action: LexiContextAction): string => action.id)
            }
          }
        }, (group: string): string => group)
      } else {
        ForEach(LexiContextBridge.actions(this.target, false).filter((action: LexiContextAction): boolean => this.primary(action)),
          (action: LexiContextAction) => {
            MenuItem({ content: action.label }).id(`context-${action.id}`).height(48).borderRadius(0).contentFont({ size: 15 })
              .contentFontColor($r('app.color.text_primary')).border({ width: { bottom: 0.5 }, color: $r('app.color.divider') })
              .onClick((): void => { this.run(action.id); })
          }, (action: LexiContextAction): string => action.id)
        if (this.secondary().length > 0) {
        MenuItem({ content: '更多操作', endIcon: $r('app.media.ic_chevron_muted'), builder: this.moreMenu }).id('context-more').height(48).borderRadius(0).contentFont({ size: 15 })
          .contentFontColor($r('app.color.text_primary')).border({ width: { bottom: 0.5 }, color: $r('app.color.divider') })
        }
        if (!this.file()) {
          MenuItem({ content: '重命名' }).id('context-rename').height(48).borderRadius(0).contentFont({ size: 15 })
            .contentFontColor($r('app.color.text_primary')).border({ width: { bottom: 0.5 }, color: $r('app.color.divider') })
            .onClick((): void => { this.run('rename'); })
        }
        MenuItem({ content: LexiContextBridge.actions(this.target, false).find((action: LexiContextAction): boolean => action.id === 'delete')?.label ?? '删除…' })
          .id('context-delete').height(48).borderRadius(0).contentFont({ size: 15 }).contentFontColor($r('app.color.error'))
          .onClick((): void => { this.run('delete'); })
      }
    }.width(this.desktop() ? 220 : 230).borderRadius(this.desktop() ? 14 : 24).backgroundColor($r('app.color.surface'))
      .onDisAppear((): void => { this.pressActive = false; })
  }
  build() {
    Column() {
      if (!this.contextEnabled) { this.content(); }
      else if (this.inlineMenu()) {
        Stack({ alignContent: this.tabletCard ? Alignment.TopEnd : Alignment.End }) {
          Column() { this.content(); }.width('100%')
          Button('⋯', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
            .id(`context-trigger-${this.target.kind}-${this.target.id}`).width(44).height(44).padding(0).fontSize(22)
            .fontColor($r('app.color.text_secondary')).backgroundColor(Color.Transparent).borderRadius(12)
            .margin({ top: this.tabletCard ? 6 : 0, right: this.tabletCard ? 6 : 0 })
            .accessibilityText(this.file() ? '文件操作' : '工作区或文件夹操作').bindMenu(this.menu)
        }.width('100%').constraintSize({ minHeight: 44 }).bindContextMenu(this.menu, ResponseType.RightClick)
      } else if (this.desktop()) {
        Column() { this.content(); }.width('100%').bindContextMenu(this.menu, ResponseType.RightClick)
      } else {
        Column() { this.content(); }.width('100%').opacity(this.pressActive ? 0.82 : 1)
          .animation({ duration: 120, curve: Curve.EaseOut })
          .onTouch((event: TouchEvent): void => {
            if (event.type === TouchType.Down) { this.pressActive = true; }
            else if (event.type === TouchType.Up || event.type === TouchType.Cancel) { this.pressActive = false; }
          })
          .priorityGesture(LongPressGesture({ duration: 350, repeat: false })
            .onAction((event: GestureEvent): void => { this.showPhoneMenu(event); }))
          .bindContextMenu(this.phoneMenuVisible, this.menu, {
            anchorPosition: { x: this.phoneMenuX, y: this.phoneMenuY },
            onDisappear: (): void => { this.phoneMenuVisible = false; this.pressActive = false; }
          })
      }
    }.width('100%')
  }
}
