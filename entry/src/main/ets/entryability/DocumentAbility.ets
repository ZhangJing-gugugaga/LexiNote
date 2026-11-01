import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { LexiOfflineSpeech } from '../core/LexiOfflineSpeech';

// A separate ability gives each requested document its own native desktop window.
export default class DocumentAbility extends UIAbility {
  onBackground(): void { LexiOfflineSpeech.interruptAll(); }
  private documentId: string = '';
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.documentId = (want.parameters?.noteId as string) || '';
  }
  onWindowStageCreate(stage: window.WindowStage): void {
    const storage = new LocalStorage();
    storage.setOrCreate<string>('documentNoteId', this.documentId);
    stage.loadContent('pages/DocumentWindow', storage).then((): void => {
      const main = stage.getMainWindowSync();
      main.setWindowDecorHeight(52); main.setWindowDecorVisible(false);
    }).catch((): void => { this.context.terminateSelf(); });
  }
}
