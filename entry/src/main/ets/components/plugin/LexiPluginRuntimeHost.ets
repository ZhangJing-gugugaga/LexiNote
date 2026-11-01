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
        .fileAccess(true)
        .databaseAccess(false)
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
