import { AbilityConstant, common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { LexiContinuationData, LexiContinuationDraft } from './LexiContinuationData';

/** Only the visible/focused editor may supply the source draft. No filesystem path is transferred. */
export class LexiContinuationSession {
  private static owner: string = '';
  private static getter: (() => LexiContinuationDraft) | undefined;
  private static ownerCounter: number = 0;

  static newOwner(): string { return `editor-${Date.now()}-${++LexiContinuationSession.ownerCounter}`; }

  static activate(context: common.UIAbilityContext, owner: string, getter: () => LexiContinuationDraft): void {
    if (context.abilityInfo.name !== 'EntryAbility') { return; }
    LexiContinuationSession.owner = owner; LexiContinuationSession.getter = getter;
    context.setMissionContinueState(AbilityConstant.ContinueState.ACTIVE).catch((): void => {});
  }

  static deactivate(context: common.UIAbilityContext, owner: string): void {
    if (context.abilityInfo.name !== 'EntryAbility') { return; }
    if (LexiContinuationSession.owner !== owner) { return; }
    LexiContinuationSession.owner = ''; LexiContinuationSession.getter = undefined;
    context.setMissionContinueState(AbilityConstant.ContinueState.INACTIVE).catch((): void => {});
  }

  static export(): string {
    const getter = LexiContinuationSession.getter;
    if (!getter) { throw new Error('请先打开一篇笔记，再使用系统接续'); }
    const draft = getter(); draft.transferId = util.generateRandomUUID(true);
    const raw = JSON.stringify(draft); LexiContinuationData.decode(raw); return raw;
  }

  static current(): LexiContinuationDraft | undefined { return LexiContinuationSession.getter ? LexiContinuationSession.getter() : undefined; }

  static publishIncoming(raw: string): void {
    LexiContinuationData.decode(raw);
    AppStorage.setOrCreate('lexiContinuationIncoming', raw);
  }
}
