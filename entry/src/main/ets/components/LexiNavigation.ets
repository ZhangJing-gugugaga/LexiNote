import { uiMaterial } from '@kit.ArkUI';
import { LexiIcon } from './LexiIcon';

@Component
export struct LexiNavigation {
  @Prop active: number = 0;
  onSelect: (index: number) => void = () => {};
  @State private immersiveSupported: boolean = false;
  private readonly activeNavMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
    materialColor: $r('app.color.title_chip_active'),
    interactive: true,
    applyShadow: true,
    lightEffect: { color: $r('app.color.dock_light') }
  });
  private readonly inactiveNavMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
    interactive: true,
    applyShadow: false,
    lightEffect: { color: $r('app.color.dock_light') }
  });

  aboutToAppear(): void {
    try {
      this.immersiveSupported = uiMaterial.isImmersiveMaterialSupported();
    } catch {
      this.immersiveSupported = false;
    }
  }

  @Builder
  navigationItem(index: number, title: string, icon: string) {
    Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
      Row({ space: 8 }) {
        LexiIcon({ name: icon, iconSize: 20, muted: this.active !== index })
        Text(title)
          .fontSize(15)
          .fontWeight(this.active === index ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.active === index ? $r('app.color.brand') : $r('app.color.text_secondary'))
      }
      .padding({ left: 16, right: 16 })
    }
    .height(40)
    .borderRadius(20)
    .backgroundColor(
      this.immersiveSupported
        ? Color.Transparent
        : this.active === index
          ? $r('app.color.brand_soft')
          : Color.Transparent
    )
    .systemMaterial(
      this.immersiveSupported
        ? this.active === index
          ? this.activeNavMaterial
          : this.inactiveNavMaterial
        : undefined
    )
    .accessibilityText(title)
    .accessibilityDescription(this.active === index ? '已选中' : `前往${title}`)
    .onClick(() => {
      this.onSelect(index);
    })
  }

  build() {
    Row({ space: 8 }) {
      Row({ space: 10 }) {
        Image($r('app.media.lexi_logo'))
          .width(34)
          .height(34)
          .borderRadius(10)
        Text('LexiNote')
          .fontSize(23)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
      }
      .margin({ right: 28 })

      this.navigationItem(0, '首页', 'home')
      this.navigationItem(1, '知识库', 'vault')
      this.navigationItem(2, '关联', 'explore')
      this.navigationItem(3, '设置', 'profile')
    }
    .height(56)
    .width('auto')
  }
}
