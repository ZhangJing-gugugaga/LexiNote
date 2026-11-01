@Entry
@Component
struct LexiTodayCard {
  @LocalStorageProp('vaultId') private cardVaultId: string = '';
  @LocalStorageProp('dateKey') private cardDateKey: string = '';
  @LocalStorageProp('dailyNoteId') private cardDailyNoteId: string = '';
  @LocalStorageProp('pendingCount') private cardPendingCount: number = 0;
  @LocalStorageProp('todayHint') private cardTodayHint: string = '打开应用同步今日待办';
  @LocalStorageProp('taskStatus') private cardTaskStatus: string = '点选待办即可保存';
  @LocalStorageProp('task1Text') private firstTaskText: string = '';
  @LocalStorageProp('task1NoteId') private firstTaskNoteId: string = '';
  @LocalStorageProp('task1LineIndex') private firstTaskLineIndex: number = -1;
  @LocalStorageProp('task1ExpectedLine') private firstTaskExpectedLine: string = '';
  @LocalStorageProp('task1Checked') private firstTaskChecked: boolean = false;
  @LocalStorageProp('task2Text') private secondTaskText: string = '';
  @LocalStorageProp('task2NoteId') private secondTaskNoteId: string = '';
  @LocalStorageProp('task2LineIndex') private secondTaskLineIndex: number = -1;
  @LocalStorageProp('task2ExpectedLine') private secondTaskExpectedLine: string = '';
  @LocalStorageProp('task2Checked') private secondTaskChecked: boolean = false;
  @LocalStorageProp('reviewNoteId') private cardReviewNoteId: string = '';
  @LocalStorageProp('reviewTitle') private cardReviewTitle: string = '回顾旧笔记';
  @LocalStorageProp('reviewSnippet') private cardReviewSnippet: string = '积累笔记后，在这里重新遇见旧想法。';

  private openAction(action: string, noteId: string): void {
    postCardAction(this, {
      action: 'router', abilityName: 'EntryAbility',
      params: { lexiFormAction: action, vaultId: this.cardVaultId, noteId: noteId,
        lineIndex: -1, expectedLine: '', checked: false, requestId: `card-${Date.now()}` }
    });
  }

  private requestTask(first: boolean): void {
    // The visible state is changed only after the app has safely saved the line
    // and sent a new snapshot. A card tap never pretends a write succeeded.
    postCardAction(this, {
      action: 'message',
      params: { lexiFormAction: 'toggle-todo', vaultId: this.cardVaultId,
        noteId: first ? this.firstTaskNoteId : this.secondTaskNoteId,
        lineIndex: first ? this.firstTaskLineIndex : this.secondTaskLineIndex,
        expectedLine: first ? this.firstTaskExpectedLine : this.secondTaskExpectedLine,
        checked: first ? !this.firstTaskChecked : !this.secondTaskChecked,
        requestId: `card-task-${Date.now()}` }
    });
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text('今日待办').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
        Text(`${this.cardPendingCount} 项待办`).fontSize(11).fontColor($r('app.color.text_secondary')).layoutWeight(1)
        Text(this.cardDateKey.substring(5)).fontSize(11).fontColor($r('app.color.text_secondary'))
        Button() { Text('↻').fontSize(18).fontColor($r('app.color.brand_ink')) }
          .width(28).height(24).padding(0).backgroundColor(Color.Transparent)
          .onClick((): void => { postCardAction(this, { action: 'message', params: { event: 'refresh' } }); })
      }.width('100%')
      Row({ space: 12 }) {
        Column({ space: 3 }) {
          if (this.firstTaskText) {
            Button() {
              Row({ space: 7 }) {
                Text(this.firstTaskChecked ? '☑' : '□').fontSize(19).fontColor($r('app.color.brand_ink'))
                Text(this.firstTaskText).fontSize(12).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  .fontColor($r('app.color.text_primary')).layoutWeight(1)
              }.width('100%')
            }.width('100%').height(30).padding(0).borderRadius(4).backgroundColor(Color.Transparent)
              .onClick((): void => { this.requestTask(true); })
          }
          if (this.secondTaskText) {
            Button() {
              Row({ space: 7 }) {
                Text(this.secondTaskChecked ? '☑' : '□').fontSize(19).fontColor($r('app.color.brand_ink'))
                Text(this.secondTaskText).fontSize(12).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  .fontColor($r('app.color.text_primary')).layoutWeight(1)
              }.width('100%')
            }.width('100%').height(30).padding(0).borderRadius(4).backgroundColor(Color.Transparent)
              .onClick((): void => { this.requestTask(false); })
          }
          if (!this.firstTaskText) {
            Text(this.cardTodayHint).fontSize(12).lineHeight(20).fontColor($r('app.color.text_secondary')).width('100%')
          }
          Blank()
          Button() { Text('打开今日笔记 →').fontSize(11).fontColor($r('app.color.brand_ink')) }
            .width('100%').height(22).padding(0).backgroundColor(Color.Transparent)
            .onClick((): void => { this.openAction('daily', this.cardDailyNoteId); })
          Text(this.cardTaskStatus).fontSize(9).fontColor($r('app.color.text_secondary')).maxLines(2).width('100%')
        }.layoutWeight(1).height('100%').alignItems(HorizontalAlign.Start)
        Divider().vertical(true).width(1).height('100%').color($r('app.color.divider'))
        Button() {
          Column({ space: 6 }) {
            Text('随机回顾').fontSize(11).fontColor($r('app.color.brand_ink')).width('100%')
            Text(this.cardReviewTitle).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
            Text(this.cardReviewSnippet).fontSize(11).lineHeight(16).fontColor($r('app.color.text_secondary'))
              .maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
          }.width('100%').alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).height('100%').padding(0).backgroundColor(Color.Transparent).borderRadius(4)
          .enabled(this.cardReviewNoteId.length > 0)
          .onClick((): void => { this.openAction('open-note', this.cardReviewNoteId); })
      }.width('100%').layoutWeight(1).alignItems(VerticalAlign.Top)
    }.width('100%').height('100%').padding(12).alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.surface'))
  }
}
