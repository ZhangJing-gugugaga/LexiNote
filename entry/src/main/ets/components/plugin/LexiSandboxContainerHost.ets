// P1-003b 方案 B(ADR-R21-02)·沙箱容器宿主组件(独立 Web,Round 22)。
// 形态与 LexiSandboxHost(PoC 宿主)同构——该形态下页内 window 通道双向已真机验证;
// 与 ArkTS 的桥用 javaScriptProxy(页→宿主)+runJavaScript(宿主→页),均为久经验证机制。
// 职责:只搬运字节——请求帧交 manager.handleSandboxProxyCall(裁决/授权/分发),
// 响应帧经 manager.dispatchSandboxResponse 回推页面 inbox。

import { webview } from '@kit.ArkWeb';
import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';

@Component
export struct LexiSandboxContainerHost {
  private webController: webview.WebviewController = new webview.WebviewController();
  @State private manager: LexiPluginManager | null = null;

  aboutToAppear(): void {
    // LexiPluginRuntimeHost 先行(createShared);此处只读 shared,未就绪则 build 出空由
    // 上层组件树的重渲染兜底(RuntimeHost bootstrap 完成后 shared 非空)。
    this.manager = LexiPluginManager.shared;
  }

  /** 页面加载完成:登记 controller(沙箱轨 boot 走本页)+ ready ping(对账 proxy 可用)。 */
  private onReady(): void {
    if (!this.manager) { return; }
    try {
      this.manager.attachSandboxController(this.webController);
      this.webController.runJavaScript('window.sandboxHostPing && window.sandboxHostPing();');
    } catch (err) { /* 页面未就绪等 transient:由 proxy 探测兜底 */ }
  }

  build() {
    if (this.manager) {
      Web({ src: $rawfile('lexinote_sandbox_host.html'), controller: this.webController })
        .javaScriptAccess(true)
        .fileAccess(false)
        .databaseAccess(false)
        .domStorageAccess(false)
        .javaScriptProxy({
          object: this.manager.sandboxProxy,
          name: 'sandboxHost',
          methodList: ['call'],
          controller: this.webController
        })
        .onPageEnd((): void => { this.onReady(); })
        .width(1).height(1)
        .hitTestBehavior(HitTestMode.None)
    }
  }
}
