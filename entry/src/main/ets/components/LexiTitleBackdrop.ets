@Component
export struct LexiTitleBackdrop {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;

  build() {
    Column()
      .width('100%')
      .height(56 + this.titleTopInset)
      .linearGradient({
        angle: 180,
        colors: [
          [$r('app.color.title_scrim'), 0],
          [$r('app.color.title_scrim'), (48 + this.titleTopInset) / (56 + this.titleTopInset)],
          [Color.Transparent, 1]
        ]
      })
      .hitTestBehavior(HitTestMode.None)
      .accessibilityLevel('no')
  }
}
