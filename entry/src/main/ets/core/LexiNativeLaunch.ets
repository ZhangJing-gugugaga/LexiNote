import { Want } from '@kit.AbilityKit';
import { LexiFormData, LexiFormRequest } from './LexiFormData';

export class LexiFormLaunch {
  eventId: string = '';
  request: LexiFormRequest = new LexiFormRequest();
}

export class LexiNativeLaunch {
  private static sequence: number = 0;

  static receive(want: Want): void {
    const raw = want.parameters?.params;
    if (typeof raw !== 'string') { return; }
    const request = LexiFormData.decodeRequest(raw);
    if (!request) { return; }
    const event = new LexiFormLaunch(); event.eventId = `${Date.now()}-${++LexiNativeLaunch.sequence}`; event.request = request;
    AppStorage.setOrCreate('lexiFormLaunch', JSON.stringify(event));
  }

  static decode(raw: string): LexiFormLaunch {
    const event = JSON.parse(raw) as LexiFormLaunch;
    if (!event || typeof event.eventId !== 'string') { throw new Error('卡片启动请求无效'); }
    const request = LexiFormData.decodeRequest(JSON.stringify(event.request));
    if (!request) { throw new Error('卡片操作无效'); }
    event.request = request; return event;
  }
}
