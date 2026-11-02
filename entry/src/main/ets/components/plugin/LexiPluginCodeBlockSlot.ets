// Plugin code block slot: one compact ArkWeb per rendered plugin code block.

import { webview } from '@kit.ArkWeb';
import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';

@Component
export struct LexiPluginCodeBlockSlot {
  pluginId: string = '';
  language: string = '';
  source: string = '';
  private webController: webview.WebviewController = new webview.WebviewController();
  @State private ready: boolean = false;

  aboutToAppear(): void {
    if (LexiPluginManager.shared) { this.ready = true; }
  }

  build() {
    if (this.ready && this.pluginId && this.language) {
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
          const payload = manager.codeBlockPayload(this.pluginId, this.language, this.source);
          if (!payload) { return; }
          this.webController.runJavaScript(
            `window.lexinoteView && window.lexinoteView.bootCodeBlock(${JSON.stringify(payload)})`
          ).catch((): void => { /* the preview may be replaced before boot */ });
        })
        .width('100%')
        .height(180)
        .backgroundColor($r('app.color.soft_surface'))
        .borderRadius(12)
        .clip(true)
    }
  }
}
