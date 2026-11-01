@Component
export struct LexiAppearancePicker {
  @Prop theme: string = 'system';
  onSelect: (theme: string) => void = (_theme: string): void => {};

  build() {
    Row({ space: 4 }) {
      Button({ type: ButtonType.Normal }) {
        Text('跟随系统')
          .fontSize(13)
          .fontWeight(this.theme === 'system' ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.theme === 'system' ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .maxLines(2)
          .width('100%')
      }
      .id('theme-system')
      .layoutWeight(1)
      .constraintSize({ minHeight: 44 })
      .padding({ left: 4, right: 4, top: 10, bottom: 10 })
      .borderRadius(12)
      .backgroundColor(this.theme === 'system' ? $r('app.color.brand_soft') : Color.Transparent)
      .accessibilityText('外观：跟随系统')
      .accessibilitySelected(this.theme === 'system')
      .onClick((): void => {
        this.onSelect('system');
      })

      Button({ type: ButtonType.Normal }) {
        Text('浅色')
          .fontSize(13)
          .fontWeight(this.theme === 'light' ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.theme === 'light' ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .maxLines(2)
          .width('100%')
      }
      .id('theme-light')
      .layoutWeight(1)
      .constraintSize({ minHeight: 44 })
      .padding({ left: 4, right: 4, top: 10, bottom: 10 })
      .borderRadius(12)
      .backgroundColor(this.theme === 'light' ? $r('app.color.brand_soft') : Color.Transparent)
      .accessibilityText('外观：浅色')
      .accessibilitySelected(this.theme === 'light')
      .onClick((): void => {
        this.onSelect('light');
      })

      Button({ type: ButtonType.Normal }) {
        Text('深色')
          .fontSize(13)
          .fontWeight(this.theme === 'dark' ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.theme === 'dark' ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .maxLines(2)
          .width('100%')
      }
      .id('theme-dark')
      .layoutWeight(1)
      .constraintSize({ minHeight: 44 })
      .padding({ left: 4, right: 4, top: 10, bottom: 10 })
      .borderRadius(12)
      .backgroundColor(this.theme === 'dark' ? $r('app.color.brand_soft') : Color.Transparent)
      .accessibilityText('外观：深色')
      .accessibilitySelected(this.theme === 'dark')
      .onClick((): void => {
        this.onSelect('dark');
      })
    }
    .width('100%')
    .padding(4)
    .backgroundColor($r('app.color.soft_surface'))
    .borderRadius(16)
  }
}
