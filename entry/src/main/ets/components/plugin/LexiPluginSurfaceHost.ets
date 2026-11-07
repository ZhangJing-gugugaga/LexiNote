// P4-001/P4-002:插件 Modal/Menu/Suggest 宿主原生渲染面(沙箱插件交互面的宿主执行端)。
// 形态纪律:观察 lexiPluginRevision 修订号(与 Ribbon 行同款),从 manager 读在途交互面表;
// 渲染用宿主自身组件(Stack/Column/Button)——iframe 不持有任何宿主 UI 句柄,插件只递交
// 内容描述符(ui.modal.open / ui.menu.show / ui.suggest.show),用户关闭/点选经
// manager.dismiss/choose 落账并回推沙箱(sandbox.ui 帧),插件侧回调(onClose/onClick/
// onHide/selectSuggestion)在 iframe 兑现。
// 诚实边界:本组件覆盖"弹层/菜单/建议浮层出现 + 用户操作回流"的最小真实面;菜单坐标按
// 插件递交的 x/y 钳制呈现,Suggest 浮层用固定钳制锚点(沙箱侧坐标与宿主视口无换算基准,
// 编辑器光标级精确锚定归设备批次校准)。

import { LexiPluginManager, LexiPluginModalSurface, LexiPluginMenuSurface,
  LexiPluginSuggestSurface } from '../../core/plugin/LexiPluginRuntime';

interface LexiPluginMenuItemState {
  index: number;
  title: string;
  checked: boolean;
  disabled: boolean;
  separator: boolean;
}

interface LexiPluginSuggestionState {
  index: number;
  title: string;
  detail: string;
}

@Component
export struct LexiPluginSurfaceHost {
  @StorageProp('lexiPluginRevision') @Watch('surfacesChanged') private pluginRevision: number = 0;
  @State private modal: LexiPluginModalSurface | null = null;
  @State private menu: LexiPluginMenuSurface | null = null;
  @State private menuItems: LexiPluginMenuItemState[] = [];
  @State private menuX: number = 24;
  @State private menuY: number = 96;
  @State private suggest: LexiPluginSuggestSurface | null = null;
  @State private suggestions: LexiPluginSuggestionState[] = [];

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
      this.suggest = null;
      this.suggestions = [];
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
    // P4-002:Suggest 浮层(显示描述符 {index,title,detail,icon};建议值从不进宿主)。
    const suggests: LexiPluginSuggestSurface[] = manager.pluginSuggestSurfaces();
    this.suggest = suggests.length > 0 ? suggests[0] : null;
    const rows: LexiPluginSuggestionState[] = [];
    if (this.suggest !== null) {
      try {
        const parsed = JSON.parse(this.suggest.itemsJson) as Object[];
        for (const raw of parsed) {
          if (!raw || typeof raw !== 'object') { continue; }
          const record = raw as Record<string, Object>;
          rows.push({
            index: typeof record['index'] === 'number' ? record['index'] as number : rows.length,
            title: typeof record['title'] === 'string' ? record['title'] as string : '',
            detail: typeof record['detail'] === 'string' ? record['detail'] as string : ''
          });
        }
      } catch {
        /* 描述符解析失败按空浮层呈现(外点关闭仍可用) */
      }
    }
    this.suggestions = rows;
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

  private dismissSuggest(): void {
    const current = this.suggest;
    const manager = LexiPluginManager.shared;
    if (!current || !manager) { return; }
    manager.dismissPluginSuggest(current.pluginId, current.suggestId, 'user');
  }

  private chooseSuggestion(row: LexiPluginSuggestionState): void {
    const current = this.suggest;
    const manager = LexiPluginManager.shared;
    if (!current || !manager) { return; }
    manager.choosePluginSuggestion(current.pluginId, current.suggestId, row.index);
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

  @Builder
  private suggestLayer() {
    // P4-002:编辑器锚定建议浮层。固定钳制锚点呈现(沙箱坐标与宿主视口无换算基准,
    // 光标级锚定归设备批次校准);全屏近透明捕捉层:点外关闭(Obsidian suggest 语义)。
    Column() {
      Column({ space: 2 }) {
        Text(this.suggest?.query && this.suggest.query.length > 0 ? '建议: ' + this.suggest.query : '建议')
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .padding({ left: 10, right: 10, top: 4, bottom: 2 })
        ForEach(this.suggestions, (row: LexiPluginSuggestionState) => {
          Column({ space: 1 }) {
            Text(row.title)
              .fontSize(14)
              .fontColor($r('app.color.text_primary'))
              .width('100%')
            if (row.detail.length > 0) {
              Text(row.detail)
                .fontSize(11)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')
            }
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding({ left: 10, right: 10, top: 7, bottom: 7 })
          .borderRadius(8)
          .onClick((): void => { this.chooseSuggestion(row); })
        }, (row: LexiPluginSuggestionState): string => row.index.toString())
      }
      .backgroundColor($r('app.color.surface'))
      .borderRadius(14)
      .padding(6)
      .width(240)
      .margin({ left: 24, top: 96 })
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('rgba(0,0,0,0.001)')
    .onClick((): void => { this.dismissSuggest(); })
  }

  build() {
    Stack() {
      if (this.modal !== null) {
        this.modalLayer()
      }
      if (this.menu !== null) {
        this.menuLayer()
      }
      if (this.suggest !== null) {
        this.suggestLayer()
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.modal !== null || this.menu !== null || this.suggest !== null
      ? HitTestMode.Default : HitTestMode.None)
  }
}
