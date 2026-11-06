// Headless plugin runtime host. Embed once in the main window; it boots the manager and keeps
// the runtime page alive. Plugin UI primitives surface through the manager, not through this view.

import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';

// runtime 页的 console 引擎不自动转发（LexiSandboxHost/LexiWorkspacePage 同款 onConsole 补齐），
// shim 的通道选择/告警日志（[lexinote] 前缀）由此进 hilog，供设备验收取证。
const HI_DOMAIN: number = 0x1051;
const HI_TAG: string = 'LexiPluginRuntimePage';

@Component
export struct LexiPluginRuntimeHost {
  private static readonly CONTEXT_PORT_TAG: string = 'lexi-context-port';
  private webController: webview.WebviewController = new webview.WebviewController();
  @State private manager: LexiPluginManager | null = null;

  aboutToAppear(): void {
    this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.manager) { return; }
    const context = getContext(this) as common.Context;
    const manager = await LexiPluginManager.createShared(context);
    manager.setToastHandler((message: string): void => {
      this.getUIContext().getPromptAction().showToast({ message: message });
    });
    await manager.attachRuntime(this.webController);
    this.manager = manager;
  }

  /**
   * P1-003a(ADR-R18-01):端口对建立——ports[0] 转移给 runtime 页(页面侧存
   * window.lexiContextPort),ports[1] 留宿主 → manager.handleContextPortFrame。
   * 帧→contextId 反查→既有 broker 的裁决在 manager 侧;本组件只搬运字节。
   */
  private openContextPort(): void {
    if (!this.manager) { return; }
    try {
      const ports: Array<webview.WebMessagePort> = this.webController.createWebMessagePorts();
      if (ports.length < 2) { console.log('[lexinote] openContextPort ports=' + ports.length); return; }
      const pageEnd: webview.WebMessagePort = ports[0];
      const hostEnd: webview.WebMessagePort = ports[1];
      hostEnd.onMessageEvent((result: webview.WebMessage): void => {
        if (typeof result === 'string' && this.manager) {
          this.manager.handleContextPortFrame(result);
        }
      });
      this.manager.attachContextPort(hostEnd);
      this.webController.postMessage(LexiPluginRuntimeHost.CONTEXT_PORT_TAG, [pageEnd], '*');
    } catch (err) { console.log('[lexinote] openContextPort threw: ' + String(err)); }
  }

  build() {
    if (this.manager) {
      Web({ src: $rawfile('lexinote_plugin_runtime.html'), controller: this.webController })
        .javaScriptAccess(true)
        // RFC §3.9:不可信插件运行页面禁本地文件访问、禁 DOM Storage(插件数据走 data.load/save)。
        .fileAccess(false)
        .databaseAccess(false)
        .domStorageAccess(false)
        .javaScriptProxy({
          object: this.manager.runtime,
          name: 'lexiHost',
          // P1-006b①:admitDispatch 是 __receive 门卫的同步核销口(一次性通道凭据,
          // 单次有效+method/payload 绑定)——派发回调执行前必须先过它。
          methodList: ['call', 'admitDispatch'],
          controller: this.webController
        })
        .onPageEnd((): void => { this.openContextPort(); })
        .onConsole((event: OnConsoleEvent): boolean => {
          try {
            const line: string = event.message.getMessage();
            if (line.indexOf('[lexinote]') >= 0) {
              hilog.info(HI_DOMAIN, HI_TAG, '%{public}s', line);
            }
          } catch (err) {
            hilog.error(HI_DOMAIN, HI_TAG, 'onConsole handler threw');
          }
          return true;
        })
        .width(1).height(1)
        .hitTestBehavior(HitTestMode.None)
    }
  }
}
