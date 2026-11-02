// RFC §14 T0.2 · SandboxHost。
// 无头 PoC 宿主：装载 lexinote_sandbox_poc.html，由页面为每个插件上下文创建
// sandbox="allow-scripts" 的独立 iframe（opaque origin）+ 专属 MessageChannel，
// 并在其中运行沙箱逃逸探针。逐向量结论经 console（[lexinote][sandbox] 前缀）进 hilog，
// 供设备验收与审计取证。本组件不承载任何业务插件执行，可随宿主常驻（1x1）。

import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const HI_DOMAIN: number = 0x1051;
const HI_TAG: string = 'LexiSandbox';

@Component
export struct LexiSandboxHost {
  private webController: webview.WebviewController = new webview.WebviewController();

  build() {
    Web({ src: $rawfile('lexinote_sandbox_poc.html'), controller: this.webController })
      .javaScriptAccess(true)
      // RFC §3.9:沙箱宿主页同样禁本地文件访问与 DOM Storage。
      .fileAccess(false)
      .databaseAccess(false)
      .domStorageAccess(false)
      .onlineImageAccess(false)
      .mixedMode(MixedMode.None)
      .onConsole((event: OnConsoleEvent): boolean => {
        const line: string = event.message.getMessage();
        if (line.indexOf('[lexinote][sandbox]') >= 0) {
          hilog.info(HI_DOMAIN, HI_TAG, '%{public}s', line);
        }
        return true;
      })
      .width(1).height(1)
      .hitTestBehavior(HitTestMode.None)
  }
}
