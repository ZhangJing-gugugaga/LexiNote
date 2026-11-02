// Plugin view slot: one visible ArkWeb per open plugin view tab (real DOM + plugin styles).

import { webview } from '@kit.ArkWeb';
import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';

@Component
export struct LexiPluginViewSlot {
  pluginId: string = '';
  viewType: string = '';
  private webController: webview.WebviewController = new webview.WebviewController();
  @State private ready: boolean = false;

  aboutToAppear(): void {
    if (LexiPluginManager.shared) { this.ready = true; }
  }

  build() {
    if (this.ready && this.pluginId && this.viewType) {
      Web({ src: $rawfile('lexinote_plugin_view.html'), controller: this.webController })
        .javaScriptAccess(true)
        .fileAccess(false)
        .databaseAccess(false)
        .javaScriptProxy({
          object: LexiPluginManager.shared!.runtime,
          name: 'lexiHost',
          methodList: ['call'],
          controller: this.webController
        })
        .onPageEnd((): void => {
          const manager = LexiPluginManager.shared;
          if (!manager) { return; }
          const payload = manager.viewBootPayload(this.pluginId, this.viewType);
          if (!payload) { return; }
          this.webController.runJavaScript(
            `window.lexinoteView && window.lexinoteView.boot(${JSON.stringify(payload)})`
          ).catch((): void => { /* a closed tab may drop the controller first */ });
        })
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.workspace_page'))
    }
  }
}
