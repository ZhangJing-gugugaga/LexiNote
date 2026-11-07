import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { LexiOfflineSpeech } from '../core/LexiOfflineSpeech';
import { LexiShareService } from '../core/LexiShareService';

// A separate ability gives each requested document its own native desktop window.
export default class DocumentAbility extends UIAbility {
  private documentId: string = '';
  private mainWindow: window.Window | undefined;
  private windowKey: string = `DocumentAbility:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
  onBackground(): void {
    LexiOfflineSpeech.interruptAll();
    LexiShareService.unregisterWindow(this.windowKey);
  }
  onForeground(): void {
    LexiShareService.registerWindow(this.windowKey, this.context, this.mainWindow);
  }
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.documentId = (want.parameters?.noteId as string) || '';
  }
  onWindowStageCreate(stage: window.WindowStage): void {
    const storage = new LocalStorage();
    storage.setOrCreate<string>('documentNoteId', this.documentId);
    stage.loadContent('pages/DocumentWindow', storage).then((): void => {
      const main = stage.getMainWindowSync();
      this.mainWindow = main;
      main.setWindowDecorHeight(52); main.setWindowDecorVisible(false);
      LexiShareService.registerWindow(this.windowKey, this.context, this.mainWindow);
    }).catch((): void => { this.context.terminateSelf(); });
  }
  onWindowStageDestroy(): void {
    LexiShareService.unregisterWindow(this.windowKey);
    this.mainWindow = undefined;
  }
}
