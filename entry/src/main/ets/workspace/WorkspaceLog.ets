import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0A17;
const TAG: string = 'LexiWorkspace';

/**
 * Instrumentation for the workspace host track.
 * Every line lands in hilog so device validation reads the same story as the code.
 */
export class WorkspaceLog {
  static info(topic: string, detail: string): void {
    hilog.info(DOMAIN, TAG, '[%{public}s] %{public}s', topic, detail);
  }

  static warn(topic: string, detail: string): void {
    hilog.warn(DOMAIN, TAG, '[%{public}s] %{public}s', topic, detail);
  }

  static error(topic: string, detail: string): void {
    hilog.error(DOMAIN, TAG, '[%{public}s] %{public}s', topic, detail);
  }
}
