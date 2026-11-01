import { ShareExtensionAbility, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { LexiShareCapture } from '../core/LexiShareCapture';

/** Native system share details page. Incoming data is previewed and never saved automatically. */
export default class LexiShareAbility extends ShareExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    LexiShareCapture.open(want, session);
  }

  onSessionDestroy(session: UIExtensionContentSession): void {
    LexiShareCapture.release(session);
  }
}
