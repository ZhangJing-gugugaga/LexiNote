import { Want } from '@kit.AbilityKit';
import { LexiDeepLinkRequest, LexiEcosystemLink } from './LexiEcosystemLink';
import { LexiFormData, LexiFormRequest } from './LexiFormData';

export class LexiFormLaunch {
  eventId: string = '';
  request: LexiFormRequest = new LexiFormRequest();
}

export class LexiDeepLinkLaunch {
  eventId: string = '';
  request: LexiDeepLinkRequest = new LexiDeepLinkRequest();
}

export class LexiNativeLaunch {
  private static sequence: number = 0;

  static receive(want: Want): void {
    const uri = typeof want.uri === 'string' ? want.uri.trim() : '';
    if (uri.toLowerCase().startsWith('lexinote://import')) {
      return;
    }
    if (uri.startsWith('lexinote://')) {
      const deepLink = LexiEcosystemLink.parseLexiNoteUri(uri);
      if (deepLink) {
        const event = new LexiDeepLinkLaunch();
        event.eventId = `${Date.now()}-${++LexiNativeLaunch.sequence}`;
        event.request = deepLink;
        AppStorage.setOrCreate('lexiDeepLinkLaunch', JSON.stringify(event));
      }
      return;
    }
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

  static decodeDeepLink(raw: string): LexiDeepLinkLaunch {
    const event = JSON.parse(raw) as LexiDeepLinkLaunch;
    if (!event || typeof event.eventId !== 'string' || !event.request || typeof event.request.action !== 'string') {
      throw new Error('链接启动请求无效');
    }
    return event;
  }
}
