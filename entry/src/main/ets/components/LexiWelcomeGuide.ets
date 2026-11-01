import { curves } from '@kit.ArkUI';
import { LexiIcon } from './LexiIcon';

@Component
export struct LexiWelcomeGuide {
  @Prop @Watch('motionPreferenceChanged') reduceMotion: boolean = false;
  @Prop topInset: number = 0;
  @Prop bottomInset: number = 0;
  @Prop windowButtonsInset: number = 0;
  @Prop wideScreen: boolean = false;
  @State private guideStep: number = 0;
  @State private motionPhase: number = 0;
  private motionTimer: number = -1;
  private readonly demoSpring: curves.ICurve = curves.springMotion(0.42, 0.86);
  onFinish: () => void = () => {};

  aboutToDisappear(): void {
    if (this.motionTimer >= 0) { clearTimeout(this.motionTimer); }
  }

  private motionPreferenceChanged(): void { this.playDemo(); }

  private playDemo(): void {
    if (this.motionTimer >= 0) { clearTimeout(this.motionTimer); this.motionTimer = -1; }
    if (this.reduceMotion) {
      this.motionPhase = 1;
      return;
    }
    this.motionPhase = 0;
    this.motionTimer = setTimeout((): void => {
      this.motionTimer = -1;
      this.getUIContext().animateTo({ curve: this.demoSpring }, (): void => { this.motionPhase = 1; });
    }, 32);
  }

  private goToStep(index: number): void {
    this.guideStep = Math.max(0, Math.min(2, index));
    this.playDemo();
  }

  private heading(): string {
    return ['从一条想法开始', '用文件夹收纳项目', '让想法自由连接'][this.guideStep];
  }

  private explanation(): string {
    if (this.guideStep === 0) { return '点击「新建」写下第一条笔记。'; }
    if (this.guideStep === 1) {
      return this.wideScreen ? '在左下角打开「工作区与项目」，绑定本地文件夹与项目。' :
        '在「知识库」打开「工作区与项目」，绑定本地文件夹与项目。';
    }
    return '用导图整理分支，用白板摆放卡片，拖动即可调整位置。';
  }

  @Builder
  private noteDemo() {
    Stack() {
      Column({ space: 15 }) {
        Row({ space: 8 }) {
          LexiIcon({ name: 'note', iconSize: 20 })
          Text('你的第一条想法').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
        }.width('100%')
        Column().width(168).height(7).borderRadius(4).backgroundColor($r('app.color.brand_soft'))
          .scale({ x: 0.45 + this.motionPhase * 0.55, y: 1, centerX: 0 })
        Column().width(124).height(7).borderRadius(4).backgroundColor($r('app.color.workspace_line'))
          .scale({ x: 0.4 + this.motionPhase * 0.6, y: 1, centerX: 0 })
        Column().width(92).height(7).borderRadius(4).backgroundColor($r('app.color.workspace_line'))
          .scale({ x: 0.4 + this.motionPhase * 0.6, y: 1, centerX: 0 })
      }.width(248).padding(24).borderRadius(22).backgroundColor($r('app.color.surface'))
        .border({ width: 1, color: $r('app.color.workspace_line') }).alignItems(HorizontalAlign.Start)
        .translate({ y: 6 - this.motionPhase * 10 })
      Row({ space: 6 }) {
        LexiIcon({ name: 'plus', iconSize: 16 })
        Text('新建').fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.brand_ink'))
      }.padding({ left: 14, right: 14, top: 10, bottom: 10 }).borderRadius(12)
        .backgroundColor($r('app.color.workspace_selection')).position({ x: 208, y: 26 })
        .scale({ x: 1 + this.motionPhase * 0.04, y: 1 + this.motionPhase * 0.04 })
    }.width(300).height(230)
  }

  @Builder
  private folderDemo() {
    Column({ space: 18 }) {
      Row({ space: 10 }) {
        LexiIcon({ name: 'folder', iconSize: 27 })
        Text('我的工作区').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
      }.padding(20).borderRadius(18).backgroundColor($r('app.color.surface'))
        .border({ width: 1, color: $r('app.color.workspace_line') })
      Row({ space: 12 }) {
        Column({ space: 8 }) {
          LexiIcon({ name: 'folder', iconSize: 28 })
          Text('项目一').fontSize(12).fontColor($r('app.color.text_secondary'))
        }.width(94).padding(15).borderRadius(16).backgroundColor($r('app.color.workspace_selection'))
          .translate({ x: 12 - this.motionPhase * 12, y: 10 - this.motionPhase * 10 })
        Column({ space: 8 }) {
          LexiIcon({ name: 'folder', iconSize: 28 })
          Text('项目二').fontSize(12).fontColor($r('app.color.text_secondary'))
        }.width(94).padding(15).borderRadius(16).backgroundColor($r('app.color.workspace_selection'))
          .translate({ x: this.motionPhase * 12 - 12, y: 10 - this.motionPhase * 10 })
      }
    }.width(300).height(230).justifyContent(FlexAlign.Center)
  }

  @Builder
  private spatialDemo() {
    Stack() {
      Column().width(166).height(2).backgroundColor($r('app.color.brand_soft'))
        .rotate({ angle: this.motionPhase * -8 }).translate({ y: -8 - this.motionPhase * 10 })
      Column({ space: 9 }) {
        LexiIcon({ name: 'mindmap', iconSize: 24 })
        Text('一个想法').fontSize(13).fontColor($r('app.color.text_primary'))
      }.width(106).height(92).justifyContent(FlexAlign.Center).borderRadius(18)
        .backgroundColor($r('app.color.surface')).border({ width: 1, color: $r('app.color.workspace_line') })
        .translate({ x: -70, y: 12 })
      Column({ space: 9 }) {
        LexiIcon({ name: 'canvas', iconSize: 24 })
        Text('新的连接').fontSize(13).fontColor($r('app.color.brand_ink'))
      }.width(106).height(92).justifyContent(FlexAlign.Center).borderRadius(18)
        .backgroundColor($r('app.color.workspace_selection')).border({ width: 1, color: $r('app.color.brand_soft') })
        .translate({ x: 48 + this.motionPhase * 25, y: 18 - this.motionPhase * 48 })
      LexiIcon({ name: 'plus', iconSize: 20 })
        .translate({ x: 95 + this.motionPhase * 25, y: 63 - this.motionPhase * 48 })
    }.width(300).height(230)
  }

  build() {
    Column() {
      Row({ space: 9 }) {
        Image($r('app.media.lexi_logo')).width(28).height(28).borderRadius(7)
        Text('知萤 LexiNote').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
        Blank()
        Button('跳过', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('welcome-skip').height(44).fontSize(13).fontColor($r('app.color.text_secondary'))
          .onClick((): void => { this.onFinish(); })
      }.width('100%').height(58).padding({ left: 24, right: 24 + this.windowButtonsInset })
      Scroll() {
        Column({ space: 20 }) {
          Stack() {
            if (this.guideStep === 0) { this.noteDemo(); }
            else if (this.guideStep === 1) { this.folderDemo(); }
            else { this.spatialDemo(); }
          }.width('100%').height(260).backgroundColor($r('app.color.workspace_sidebar')).borderRadius(28)
            .accessibilityLevel('no-hide-descendants')
          Row({ space: 7 }) {
            ForEach([0, 1, 2], (step: number) => {
              Column().width(step === this.guideStep ? 24 : 7).height(7).borderRadius(4)
                .backgroundColor(step === this.guideStep ? $r('app.color.brand') : $r('app.color.workspace_line'))
                .animation({ duration: this.reduceMotion ? 0 : 180, curve: Curve.EaseOut })
            }, (step: number): string => `welcome-step-${step}`)
          }.accessibilityText(`第 ${this.guideStep + 1} 步，共 3 步`)
          Text(this.heading()).id('welcome-heading').fontSize(28).fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary')).textAlign(TextAlign.Center).width('100%')
          Text(this.explanation()).fontSize(15).lineHeight(25).fontColor($r('app.color.text_secondary'))
            .textAlign(TextAlign.Center).width('100%').constraintSize({ minHeight: 76 })
          Row({ space: 12 }) {
            if (this.guideStep > 0) {
              Button('上一步', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
                .id('welcome-back').height(48).fontSize(14).fontColor($r('app.color.text_secondary'))
                .onClick((): void => { this.goToStep(this.guideStep - 1); })
            }
            Button(this.guideStep === 2 ? '进入工作区' : '下一步', { type: ButtonType.Normal })
              .id('welcome-next').layoutWeight(1).height(48).fontSize(15).borderRadius(14)
              .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
              .onClick((): void => { if (this.guideStep < 2) { this.goToStep(this.guideStep + 1); } else { this.onFinish(); } })
          }.width('100%')
        }.width('100%').constraintSize({ maxWidth: 480 }).padding({ left: 24, right: 24, top: 24, bottom: 36 })
      }.width('100%').layoutWeight(1).align(Alignment.Center).scrollBar(BarState.Off)
    }.id('welcome-guide').width('100%').height('100%').padding({ top: this.topInset, bottom: this.bottomInset })
      .backgroundColor($r('app.color.workspace_page')).onAppear((): void => { this.playDemo(); })
  }
}
