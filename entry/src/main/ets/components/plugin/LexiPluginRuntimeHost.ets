// Headless plugin runtime host. Embed once in the main window; it boots the manager and keeps
// the runtime page alive. Plugin UI primitives surface through the manager, not through this view.

import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';

@Component
export struct LexiPluginRuntimeHost {
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
          methodList: ['call'],
          controller: this.webController
        })
        .width(1).height(1)
        .hitTestBehavior(HitTestMode.None)
    }
  }
}
