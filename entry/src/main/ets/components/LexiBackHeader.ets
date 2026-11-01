import { uiMaterial } from '@kit.ArkUI';
import { LexiIcon } from './LexiIcon';
import { LexiTitleBackdrop } from './LexiTitleBackdrop';

@Component
export struct LexiBackHeader {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @StorageProp('lexiWindowButtonsInset') windowButtonsInset: number = 0;
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop actionLabel: string = '';
  onBack: () => void = () => {};
  onAction: () => void = () => {};
  @State private immersiveSupported: boolean = false;
  private readonly backMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
    materialColor: $r('app.color.title_chip_surface'),
    interactive: true,
    applyShadow: true,
    lightEffect: { color: $r('app.color.dock_light') }
  });
  private readonly actionMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
    materialColor: $r('app.color.title_chip_active'),
    interactive: true,
    applyShadow: true,
    lightEffect: { color: $r('app.color.dock_light') }
  });

  aboutToAppear(): void {
    try {
      this.immersiveSupported = uiMaterial.isImmersiveMaterialSupported();
    } catch {
      this.immersiveSupported = false;
    }
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      LexiTitleBackdrop()
      Row({ space: 12 }) {
        Button({ type: ButtonType.Circle, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          LexiIcon({ name: 'back', iconSize: 22 })
        }
        .id('secondary-back')
        .width(40)
        .height(40)
        .padding(0)
        .backgroundColor(this.immersiveSupported ? Color.Transparent : $r('app.color.surface'))
        .systemMaterial(this.immersiveSupported ? this.backMaterial : undefined)
        .accessibilityText('返回')
        .onClick(() => {
          this.onBack();
        })

        Column({ space: 2 }) {
          Text(this.title)
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .fontColor($r('app.color.text_primary'))
          if (this.subtitle.length > 0) {
            Text(this.subtitle)
              .fontSize(11)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontColor($r('app.color.text_secondary'))
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        if (this.actionLabel.length > 0) {
          Button(this.actionLabel, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
            .height(38)
            .constraintSize({ minWidth: 68 })
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.brand'))
            .backgroundColor(this.immersiveSupported ? Color.Transparent : $r('app.color.brand_soft'))
            .borderRadius(19)
            .systemMaterial(this.immersiveSupported ? this.actionMaterial : undefined)
            .padding({ left: 14, right: 14 })
            .onClick(() => {
              this.onAction();
            })
        }
      }
      .width('100%')
      .height('100%')
      .padding({ top: this.viewportWidth < 840 ? this.titleTopInset : 0, left: 16, right: 20 + (this.viewportWidth < 840 ? this.windowButtonsInset : 0) })
    }
    .width('100%')
    .height('100%')
    .clip(false)
  }
}
