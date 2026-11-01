@Entry
@Component
struct LexiQuickCard {
  @LocalStorageProp('vaultId') private cardVaultId: string = '';
  @LocalStorageProp('noteCount') private cardNoteCount: number = 0;
  @LocalStorageProp('statusText') private cardStatusText: string = '打开应用以同步本机笔记';
  @LocalStorageProp('dailyNoteId') private cardDailyNoteId: string = '';

  private openAction(action: string, noteId: string = ''): void {
    postCardAction(this, {
      action: 'router', abilityName: 'EntryAbility',
      params: { lexiFormAction: action, vaultId: this.cardVaultId, noteId: noteId,
        lineIndex: -1, expectedLine: '', checked: false, requestId: `card-${Date.now()}` }
    });
  }

  build() {
    Column({ space: 6 }) {
      Row() {
        Text('知萤 · 灵感').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1)
        Text(`${this.cardNoteCount} 篇`).fontSize(10).fontColor($r('app.color.text_secondary'))
      }.width('100%')
      Text(this.cardStatusText).fontSize(11).lineHeight(15).fontColor($r('app.color.text_secondary'))
        .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
      Blank()
      Row({ space: 8 }) {
        Button() {
          Text('＋ 速记').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.inverse_text'))
        }.height(42).layoutWeight(1).padding(0).borderRadius(12).backgroundColor($r('app.color.brand'))
          .onClick((): void => { this.openAction('quick'); })
        Button() {
          Text('语音').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.brand_ink'))
        }.height(42).layoutWeight(1).padding(0).borderRadius(12).backgroundColor($r('app.color.soft_surface'))
          .onClick((): void => { this.openAction('voice'); })
      }.width('100%')
      Button() {
        Text('今日笔记  →').fontSize(12).fontColor($r('app.color.brand_ink'))
      }.width('100%').height(26).padding(0).backgroundColor(Color.Transparent)
        .onClick((): void => { this.openAction('daily', this.cardDailyNoteId); })
    }.width('100%').height('100%').padding(12).alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.surface'))
  }
}
