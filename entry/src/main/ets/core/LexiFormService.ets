import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { formBindingData, formProvider } from '@kit.FormKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NoteItem } from './LexiModels';
import { LexiFormBinding, LexiFormData, LexiFormSnapshot } from './LexiFormData';
import { LexiStorageLock } from './LexiStorageLock';

// The app and native extensions share one atomic snapshot. The same OS lock as
// storage serializes preference flushes; native host calls run after releasing it.
export class LexiFormService {
  private static readonly preferenceName: string = 'lexinote_form_snapshot_v1';
  private static pending: Promise<void> = Promise.resolve();

  static async sync(context: common.Context, notes: NoteItem[], vaultId: string): Promise<void> {
    const snapshot = LexiFormData.build(notes, vaultId);
    const operation = LexiFormService.pending.then(async (): Promise<void> => {
      await LexiStorageLock.run<void>(context, async (): Promise<void> => {
        const appContext = context.getApplicationContext();
        preferences.removePreferencesFromCacheSync(appContext, LexiFormService.preferenceName);
        const store = await preferences.getPreferences(appContext, LexiFormService.preferenceName);
        const previous = await store.get('snapshot', '') as string;
        if (previous) {
          try { if (LexiFormData.decode(previous).updatedAt > snapshot.updatedAt) { return; } } catch {}
        }
        await store.put('snapshot', JSON.stringify(snapshot)); await store.flush();
      });
      if (!canIUse('SystemCapability.Ability.Form')) { return; }
      try {
        const forms = await formProvider.getPublishedRunningFormInfos();
        for (const info of forms) {
          if (info.abilityName !== 'LexiFormAbility') { continue; }
          try { await LexiFormService.update(context, info.formId); }
          catch { hilog.warn(0x1050, 'LexiForm', 'A desktop card could not be refreshed'); }
        }
      } catch { hilog.warn(0x1050, 'LexiForm', 'Desktop cards will read the saved snapshot when updated'); }
    });
    LexiFormService.pending = operation.catch((): void => {}); await operation;
  }

  static read(context: common.Context): LexiFormBinding {
    try {
      const appContext = context.getApplicationContext();
      preferences.removePreferencesFromCacheSync(appContext, LexiFormService.preferenceName);
      const store = preferences.getPreferencesSync(appContext, { name: LexiFormService.preferenceName });
      const raw = store.getSync('snapshot', '') as string;
      return LexiFormData.binding(raw ? LexiFormData.decode(raw) : new LexiFormSnapshot());
    } catch {
      hilog.warn(0x1050, 'LexiForm', 'No readable desktop snapshot; open the app to synchronize');
      return LexiFormData.binding(new LexiFormSnapshot());
    }
  }

  static async update(context: common.Context, formId: string, message: string = ''): Promise<void> {
    const data = LexiFormService.read(context);
    if (message) { data.taskStatus = message; }
    await formProvider.updateForm(formId, formBindingData.createFormBindingData(data));
  }
}
