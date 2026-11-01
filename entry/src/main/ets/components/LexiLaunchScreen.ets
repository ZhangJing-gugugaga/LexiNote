@Component
export struct LexiLaunchScreen {
  @Prop startupStep: number = 0;
  @Prop errorMessage: string = '';
  @Prop reduceMotion: boolean = false;
  @Prop bottomInset: number = 0;
  @State launchWidth: number = 390;
  @State launchHeight: number = 760;
  onRetry: () => void = () => {};

  private compact(): boolean {
    return this.launchHeight < 620;
  }

  private brandSize(): number {
    const preferred = this.compact() ? Math.max(104, this.launchHeight * 0.32) : 268;
    return Math.min(preferred, Math.max(80, this.launchWidth - 48));
  }

  private contentMinHeight(): number {
    const footerHeight = this.compact() ? 34 : 70;
    return Math.max(0, this.launchHeight - (this.compact() ? 16 : 24) - footerHeight - this.bottomInset);
  }

  private stepLabel(): string {
    if (this.startupStep === 1) {
      return '正在读取已保存的内容';
    }
    if (this.startupStep === 2) {
      return '正在准备你的工作台';
    }
    return '正在打开本地工作区';
  }

  @Builder
  brandMark() {
    Stack() {
      Column()
        .width(this.brandSize() * 260 / 268)
        .height(this.brandSize() * 260 / 268)
        .borderRadius(this.brandSize() / 2)
        .border({ width: 1, color: $r('app.color.divider') })
        .opacity(0.65)
      Column()
        .width(this.brandSize() * 216 / 268)
        .height(this.brandSize() * 216 / 268)
        .borderRadius(this.brandSize() / 2)
        .backgroundColor($r('app.color.brand_soft'))
        .opacity(0.36)
      Column()
        .width(this.brandSize() * 172 / 268)
        .height(this.brandSize() * 172 / 268)
        .borderRadius(this.brandSize() / 2)
        .backgroundColor($r('app.color.brand_soft'))
        .opacity(0.55)
      Image($r('app.media.lexi_logo'))
        .width(this.brandSize() * 124 / 268)
        .height(this.brandSize() * 124 / 268)
        .borderRadius(this.brandSize() * 32 / 268)
        .objectFit(ImageFit.Contain)
        .accessibilityLevel('no')
    }
    .width(this.brandSize())
    .height(this.brandSize())
    .accessibilityLevel('no')
  }

  @Builder
  progressStep(index: number) {
    Column()
      .width(this.startupStep === index ? 24 : 12)
      .height(4)
      .borderRadius(2)
      .backgroundColor(index <= this.startupStep ? $r('app.color.brand') : $r('app.color.divider'))
      .animation({ duration: this.reduceMotion ? 0 : 160, curve: Curve.EaseOut })
      .accessibilityLevel('no')
  }

  build() {
    Column() {
      Scroll() {
        Column() {
          this.brandMark()
          Text('知萤 LexiNote')
            .fontSize(this.compact() ? 26 : 30)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .letterSpacing(0.2)
            .margin({ top: 8 })

          Column({ space: this.compact() ? 12 : 16 }) {
            if (this.errorMessage.length > 0) {
              Text('知识库暂时未能打开')
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary'))
                .textAlign(TextAlign.Center)
              Text(this.errorMessage)
                .fontSize(12)
                .lineHeight(20)
                .fontColor($r('app.color.text_secondary'))
                .textAlign(TextAlign.Center)
                .constraintSize({ maxWidth: 288 })
              Button('重新打开', { type: ButtonType.Capsule })
                .height(44)
                .padding({ left: 28, right: 28 })
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .backgroundColor($r('app.color.brand'))
                .fontColor($r('app.color.inverse_text'))
                .onClick(() => {
                  this.onRetry();
                })
            } else {
              Row({ space: 6 }) {
                this.progressStep(0)
                this.progressStep(1)
                this.progressStep(2)
              }
              .height(4)
              .accessibilityLevel('no')
              Text(this.stepLabel())
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'))
                .textAlign(TextAlign.Center)
                .accessibilityText(this.stepLabel())
            }
          }
          .margin({ top: this.compact() ? 22 : 38 })
          .constraintSize({ minHeight: this.compact() ? 58 : 84 })
        }
        .width('100%')
        .constraintSize({ minHeight: this.contentMinHeight(), maxWidth: 560 })
        .justifyContent(FlexAlign.Center)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.None)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 24, right: 24, top: this.compact() ? 16 : 24, bottom: (this.compact() ? 16 : 24) + this.bottomInset })
    .backgroundColor($r('app.color.background'))
    .onAreaChange((_old: Area, current: Area) => {
      this.launchWidth = Number(current.width);
      this.launchHeight = Number(current.height);
    })
  }
}
