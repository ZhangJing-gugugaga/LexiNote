import { Want } from '@kit.AbilityKit';
import { FormExtensionAbility, formBindingData, formInfo } from '@kit.FormKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LexiFormService } from '../core/LexiFormService';
import { LexiFormTasks } from '../core/LexiFormTasks';

class LexiFormEvent { event: string = ''; }

export default class LexiFormAbility extends FormExtensionAbility {
  onAddForm(_want: Want): formBindingData.FormBindingData {
    return formBindingData.createFormBindingData(LexiFormService.read(this.context));
  }

  onUpdateForm(formId: string): void {
    LexiFormService.update(this.context, formId).catch((): void => {
      hilog.warn(0x1050, 'LexiForm', 'Desktop card update failed');
    });
  }

  onFormEvent(formId: string, message: string): void {
    try {
      const event = JSON.parse(message) as LexiFormEvent;
      if (event.event === 'refresh') { this.onUpdateForm(formId); }
      else {
        LexiFormTasks.handle(this.context, formId, message).catch((): void => {
          hilog.warn(0x1050, 'LexiForm', 'A desktop task could not be saved or refreshed');
        });
      }
    } catch { hilog.warn(0x1050, 'LexiForm', 'Ignored an invalid desktop card message'); }
  }

  onAcquireFormState(_want: Want): formInfo.FormState { return formInfo.FormState.READY; }
}
