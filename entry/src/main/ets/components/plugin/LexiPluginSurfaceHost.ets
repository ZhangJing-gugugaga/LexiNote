// P4-001:插件 Modal/Menu 宿主原生渲染面(沙箱插件交互面的宿主执行端)。
// 形态纪律:观察 lexiPluginRevision 修订号(与 Ribbon 行同款),从 manager 读在途交互面表;
// 渲染用宿主自身组件(Stack/Column/Button)——iframe 不持有任何宿主 UI 句柄,插件只递交
// 内容描述符(ui.modal.open / ui.menu.show),用户关闭/点选经 manager.dismiss/choose 落账
// 并回推沙箱(sandbox.ui 帧),插件侧回调(onClose/onClick/onHide)在 iframe 兑现。
// 诚实边界:本组件覆盖"弹层/菜单出现 + 用户操作回流"的最小真实面;菜单坐标按插件递交的
// x/y 钳制呈现(沙箱侧坐标与宿主视口无换算基准,精确锚定归设备批次校准)。

import { LexiPluginManager, LexiPluginModalSurface, LexiPluginMenuSurface } from '../../core/plugin/LexiPluginRuntime';

interface LexiPluginMenuItemState {
  index: number;
  title: string;
  checked: boolean;
  disabled: boolean;
  separator: boolean;
}

@Component
export struct LexiPluginSurfaceHost {
  @StorageProp('lexiPluginRevision') @Watch('surfacesChanged') private pluginRevision: number = 0;
  @State private modal: LexiPluginModalSurface | null = null;
  @State private menu: LexiPluginMenuSurface | null = null;
  @State private menuItems: LexiPluginMenuItemState[] = [];
  @State private menuX: number = 24;
  @State private menuY: number = 96;

  aboutToAppear(): void {
    this.refresh();
  }

  private surfacesChanged(): void {
    this.refresh();
  }

  private refresh(): void {
    const manager = LexiPluginManager.shared;
    if (!manager) {
      this.modal = null;
      this.menu = null;
      this.menuItems = [];
      return;
    }
    const modals: LexiPluginModalSurface[] = manager.pluginModalSurfaces();
    this.modal = modals.length > 0 ? modals[0] : null;
    const menus: LexiPluginMenuSurface[] = manager.pluginMenuSurfaces();
    this.menu = menus.length > 0 ? menus[0] : null;
    const items: LexiPluginMenuItemState[] = [];
    if (this.menu !== null) {
      try {
        const parsed = JSON.parse(this.menu.itemsJson) as Object[];
        for (const raw of parsed) {
          if (!raw || typeof raw !== 'object') { continue; }
          const record = raw as Record<string, Object>;
          const item: LexiPluginMenuItemState = {
            index: typeof record['index'] === 'number' ? record['index'] as number : items.length,
            title: typeof record['title'] === 'string' ? record['title'] as string : '',
            checked: record['checked'] === true,
            disabled: record['disabled'] === true,
            separator: record['separator'] === true
          };
          items.push(item);
        }
      } catch {
        /* 条目载荷解析失败按空菜单呈现(外点关闭仍可用) */
      }
      this.menuX = Math.min(Math.max(16, this.menu.x), 420);
      this.menuY = Math.min(Math.max(80, this.menu.y), 520);
    }
    this.menuItems = items;
  }

  private dismissModal(): void {
    const current = this.modal;
    const manager = LexiPluginManager.shared;
    if (!current || !manager) { return; }
    manager.dismissPluginModal(current.pluginId, current.modalId, 'user');
  }

  private dismissMenu(): void {
    const current = this.menu;
    const manager = LexiPluginManager.shared;
    if (!current || !manager) { return; }
    manager.dismissPluginMenu(current.pluginId, current.menuId, 'user');
  }

  private chooseItem(item: LexiPluginMenuItemState): void {
    const current = this.menu;
    const manager = LexiPluginManager.shared;
    if (!current || !manager || item.disabled || item.separator) { return; }
    manager.choosePluginMenuItem(current.pluginId, current.menuId, item.index);
  }

  @Builder
  private modalLayer() {
    Column() {
      Column({ space: 12 }) {
        Text(this.modal?.title || '')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text(this.modal?.content || '')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
        Button('关闭', { type: ButtonType.Normal })
          .width('100%')
          .height(40)
          .fontSize(14)
          .borderRadius(12)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.inverse_text'))
          .onClick((): void => { this.dismissModal(); })
      }
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(18)
      .width(280)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('rgba(0,0,0,0.45)')
    .onClick((): void => { this.dismissModal(); })
  }

  @Builder
  private menuLayer() {
    // 全屏近乎透明的捕捉层:点外关闭(与 Obsidian 菜单 dismiss 语义一致)。
    Column() {
      Column({ space: 2 }) {
        ForEach(this.menuItems, (item: LexiPluginMenuItemState) => {
          if (item.separator) {
            Divider()
              .strokeWidth(1)
              .color($r('app.color.soft_surface'))
              .margin({ left: 8, right: 8, top: 2, bottom: 2 })
          } else {
            Row({ space: 6 }) {
              Text(item.checked ? '•' : '')
                .fontSize(13)
                .fontColor($r('app.color.brand'))
                .width(14)
              Text(item.title)
                .fontSize(14)
                .fontColor(item.disabled ? $r('app.color.text_secondary') : $r('app.color.text_primary'))
              Blank()
            }
            .width('100%')
            .padding({ left: 10, right: 10, top: 9, bottom: 9 })
            .borderRadius(8)
            .opacity(item.disabled ? 0.45 : 1)
            .onClick((): void => { this.chooseItem(item); })
          }
        }, (item: LexiPluginMenuItemState): string => item.index.toString())
      }
      .backgroundColor($r('app.color.surface'))
      .borderRadius(14)
      .padding(6)
      .width(216)
      .margin({ left: this.menuX, top: this.menuY })
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('rgba(0,0,0,0.001)')
    .onClick((): void => { this.dismissMenu(); })
  }

  build() {
    Stack() {
      if (this.modal !== null) {
        this.modalLayer()
      }
      if (this.menu !== null) {
        this.menuLayer()
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.modal !== null || this.menu !== null ? HitTestMode.Default : HitTestMode.None)
  }
}
