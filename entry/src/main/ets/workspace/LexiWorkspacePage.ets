import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { WorkspaceBridge } from './WorkspaceBridge';
import { WorkspaceThemeCatalog } from './WorkspaceThemeCatalog';
import { WorkspaceLog } from './WorkspaceLog';

const PAGE_SRC: Resource = $rawfile('lexinote_workspace.html');
const PORT_TAG: string = '__lexi_port__';
/** 等 onPageBegin 的预算:超时视为这一次加载被吞掉,重试一次。 */
const BOOT_BEGIN_WAIT_MS: number = 3000;
/** 显式加载的总次数上限(首加载 1 次 + 重试 1 次)。 */
const BOOT_MAX_ATTEMPTS: number = 2;
/** The only javaScriptProxy surface this track exposes (spec section 2). */
class WorkspaceHandshakeProxy {
  private readonly onHello: (reason: string) => void;

  constructor(onHello: (reason: string) => void) {
    this.onHello = onHello;
  }

  hello(reason: string): void {
    this.onHello(reason);
  }
}

/**
 * Visible ArkWeb workspace host: CodeMirror 6 editor on the page side, plugin bridge over
 * WebMessagePort, javaScriptProxy kept down to a one-shot handshake poke.
 */
@Entry
@Component
struct LexiWorkspacePage {
  @State status: string = '启动中…';
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: WorkspaceBridge | null = null;
  private pagePort: webview.WebMessagePort | null = null;
  private bootBegun: boolean = false;
  private bootDone: boolean = false;
  private bootAttempts: number = 0;
  private bootTimer: number = -1;
  private handshake: WorkspaceHandshakeProxy =
    new WorkspaceHandshakeProxy((reason: string): void => this.openChannel(reason));

  aboutToAppear(): void {
    // 旧宿主(41 个 handler)先就绪,桥再开始接帧:插件通道的语义只有一份实现。
    this.bridge = new WorkspaceBridge(this.bootstrapManager(),
      new WorkspaceThemeCatalog(getContext(this) as common.UIAbilityContext));
    // 事件帧(宿主→页面)与应答共用端口,出口注入在这里。
    this.bridge.setEventSink((text: string): void => {
      this.postToPage(text);
    });
    const noteId: string = this.noteIdFromParams();
    if (noteId.length > 0) {
      // 只交 id:path 与身份都由宿主侧解析,页面不给路径也不自证身份。
      this.bridge.setInitialNote(noteId);
      WorkspaceLog.info('page.note.request', 'noteId=' + noteId);
    } else {
      WorkspaceLog.info('page.note.request', 'none');
    }
    WorkspaceLog.info('page.appear', 'workspace host page constructed');
  }

  /** 路由参数只带笔记 id;从设置页实验入口进来时没有参数,按「空容器」处理。 */
  private noteIdFromParams(): string {
    try {
      const params: Object | undefined = router.getParams();
      if (params === undefined || params === null) {
        return '';
      }
      const record: Record<string, Object> = params as Record<string, Object>;
      const raw: Object | undefined = record['noteId'];
      return typeof raw === 'string' ? raw as string : '';
    } catch (err) {
      return '';
    }
  }

  private async bootstrapManager(): Promise<LexiPluginManager | null> {
    try {
      const manager: LexiPluginManager =
        await LexiPluginManager.createShared(getContext(this) as common.UIAbilityContext);
      WorkspaceLog.info('plugin.manager', 'shared ready');
      return manager;
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('plugin.manager', 'init failed: ' + message);
      return null;
    }
  }

  aboutToDisappear(): void {
    this.cancelBootWatchdog();
    if (this.pagePort !== null) {
      this.pagePort.close();
      this.pagePort = null;
    }
    WorkspaceLog.info('page.disappear', 'port closed');
  }

  /** 页面可见:首次加载只归 controller 挂载回调;这里不发起 loadUrl(此时 controller 还没关联,必抛)。 */
  onPageShow(): void {
    WorkspaceLog.info('page.show', 'workspace page visible');
    if (this.bootBegun || this.bootDone) {
      WorkspaceLog.info('web.boot.skip', 'reason=page.show already loading or loaded');
      return;
    }
    if (this.bootAttempts > 0) {
      WorkspaceLog.info('web.boot.skip', 'reason=page.show load already issued attempt=' + this.bootAttempts);
      return;
    }
    WorkspaceLog.info('web.boot.defer', 'reason=page.show wait=controller.attached');
    this.armBootWatchdog();
  }

  /**
   * 首次加载与重试的唯一入口。attempts 上限守住次数;loadUrl 抛错(例如还没和 Web 组件关联)
   * 也照样占一次尝试并挂看门狗,免得一个页面无限重试。
   */
  private requestWebLoad(reason: string): void {
    if (this.bootBegun || this.bootDone) {
      WorkspaceLog.info('web.boot.skip', 'reason=' + reason + ' already loading or loaded');
      return;
    }
    if (this.bootAttempts >= BOOT_MAX_ATTEMPTS) {
      WorkspaceLog.warn('web.boot.giveup', 'attempts=' + this.bootAttempts);
      return;
    }
    this.bootAttempts += 1;
    WorkspaceLog.info('web.boot.load', 'reason=' + reason + ' attempt=' + this.bootAttempts);
    try {
      this.controller.loadUrl(PAGE_SRC);
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('web.boot.error', message);
    }
    this.armBootWatchdog();
  }

  /** 预算内没等到 onPageBegin 就重试一次:重试前先摘端口,重载后的 hello 才不会被 skip 掉。 */
  private armBootWatchdog(): void {
    this.cancelBootWatchdog();
    this.bootTimer = setTimeout((): void => {
      this.bootTimer = -1;
      if (this.bootBegun || this.bootDone) {
        return;
      }
      WorkspaceLog.warn('web.boot.retry', 'attempt=' + this.bootAttempts
        + ' waited=' + BOOT_BEGIN_WAIT_MS + 'ms no page.begin');
      if (this.bootAttempts >= BOOT_MAX_ATTEMPTS) {
        WorkspaceLog.warn('web.boot.giveup', 'attempts=' + this.bootAttempts
          + ' waited=' + BOOT_BEGIN_WAIT_MS + 'ms no page.begin');
        return;
      }
      this.resetPortForReload('boot retry');
      this.requestWebLoad('retry');
    }, BOOT_BEGIN_WAIT_MS);
  }

  private cancelBootWatchdog(): void {
    if (this.bootTimer === -1) {
      return;
    }
    clearTimeout(this.bootTimer);
    this.bootTimer = -1;
  }

  /** 同一页面存续期内端口只挂一次:重载前把旧端口摘掉,否则新的 hello 撞上 port already attached。 */
  private resetPortForReload(reason: string): void {
    if (this.pagePort === null) {
      WorkspaceLog.info('channel.port.reset', 'reason=' + reason + ' no port attached, nothing to reset');
      return;
    }
    try {
      this.pagePort.close();
    } catch (err) {
      WorkspaceLog.warn('channel.port.reset', 'reason=' + reason + ' close failed');
    }
    this.pagePort = null;
    WorkspaceLog.info('channel.port.reset', 'reason=' + reason + ' closed before new document');
  }

  onPageHide(): void {
    WorkspaceLog.info('page.hide', 'workspace page hidden');
  }

  onBackPress(): boolean {
    WorkspaceLog.info('page.back', 'leaving workspace page');
    return false;
  }

  /** The page poked __lexiHandshake.hello(); attach the port it will listen on. */
  private openChannel(reason: string): void {
    WorkspaceLog.info('channel.open.request', 'reason=' + reason);
    if (this.pagePort !== null) {
      WorkspaceLog.warn('channel.open.skip', 'port already attached');
      return;
    }
    try {
      const ports: Array<webview.WebMessagePort> = this.controller.createWebMessagePorts();
      if (ports.length < 2) {
        WorkspaceLog.error('channel.open.fail', 'createWebMessagePorts returned ' + ports.length + ' port');
        return;
      }
      // The pair is entangled: the page keeps ports[0], this side talks on ports[1].
      const pageEnd: webview.WebMessagePort = ports[0];
      const hostEnd: webview.WebMessagePort = ports[1];
      hostEnd.onMessageEvent((result: webview.WebMessage): void => {
        if (typeof result !== 'string') {
          WorkspaceLog.warn('channel.frame.in', 'non-string frame dropped');
          return;
        }
        this.onFrame(result);
      });
      this.pagePort = hostEnd;
      this.controller.postMessage(PORT_TAG, [pageEnd], '*');
      this.status = '通道已建立';
      WorkspaceLog.info('channel.port.attached', 'postMessage tag=' + PORT_TAG);
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      this.status = '通道建立失败';
      WorkspaceLog.error('channel.open.error', message);
    }
  }

  private onFrame(text: string): void {
    let method: string = '?';
    try {
      const head: Record<string, Object> = JSON.parse(text) as Record<string, Object>;
      const raw: Object | undefined = head['method'];
      method = raw === undefined ? (head['calls'] === undefined ? 'batch?' : 'batch') : String(raw);
    } catch (err) {
      method = 'unparsable';
    }
    WorkspaceLog.info('channel.frame.in', 'bytes=' + text.length + ' method=' + method);
    const bridge: WorkspaceBridge | null = this.bridge;
    if (bridge === null) {
      WorkspaceLog.warn('channel.frame.drop', 'bridge not constructed');
      return;
    }
    bridge.handleText(text).then((reply: string): void => {
      if (reply.length === 0) {
        return;
      }
      this.postToPage(reply);
    }).catch((err: Object): void => {
      WorkspaceLog.error('channel.frame.error', String(err));
    });
  }

  private postToPage(text: string): void {
    if (this.pagePort === null) {
      WorkspaceLog.warn('channel.post.skip', 'port missing');
      return;
    }
    try {
      this.pagePort.postMessageEvent(text);
      WorkspaceLog.info('channel.frame.out', 'bytes=' + text.length);
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('channel.post.error', message);
    }
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('‹ 返回')
          .fontSize(14)
          .fontColor('#4C6EF5')
          .padding({ left: 12, right: 8, top: 6, bottom: 6 })
          .onClick((): void => {
            this.getUIContext().getRouter().back();
          })
        Text('插件工作区（实验）')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#1F2328')
          .layoutWeight(1)
        Text(this.status)
          .fontSize(11)
          .fontColor('#6B7280')
          .padding({ right: 12 })
      }
      .width('100%')
      .height(44)
      .backgroundColor('#FFFFFF')
      .border({ width: { bottom: 1 }, color: '#E3E1DC' })

      Web({ src: PAGE_SRC, controller: this.controller })
        .javaScriptAccess(true)
        .fileAccess(false)
        .databaseAccess(false)
        .onlineImageAccess(false)
        .domStorageAccess(true)
        .mixedMode(MixedMode.None)
        .javaScriptProxy({
          object: this.handshake,
          name: '__lexiHandshake',
          methodList: ['hello'],
          controller: this.controller
        })
        .onControllerAttached((): void => {
          WorkspaceLog.info('web.controller.attached', 'attempt=' + this.bootAttempts);
          this.requestWebLoad('controller.attached');
        })
        .onPageBegin((): void => {
          // 端口还挂着 = 这是一份新文档(ArkWeb 换了渲染进程自我重载):旧端口随旧文档一起没了,
          // 不先摘掉的话新文档的 hello 会撞上 port already attached,通道静默变哑。
          const newDocument: boolean = this.pagePort !== null;
          if (newDocument) {
            this.resetPortForReload('page.begin new-document');
          }
          this.bootBegun = true;
          this.bootDone = false;
          this.cancelBootWatchdog();
          WorkspaceLog.info('web.page.begin', 'lexinote_workspace.html attempt=' + this.bootAttempts
            + (newDocument ? ' new-document' : ''));
        })
        .onPageEnd((): void => {
          this.bootDone = true;
          this.cancelBootWatchdog();
          WorkspaceLog.info('web.page.end', 'lexinote_workspace.html loaded');
        })
        .onConsole((event: OnConsoleEvent): boolean => {
          const line: string = event.message.getMessage();
          if (line.indexOf('[lexi]') >= 0) {
            WorkspaceLog.info('web.console', line.length > 220 ? line.substring(0, 220) : line);
          }
          return false;
        })
        .onErrorReceive((event: OnErrorReceiveEvent): void => {
          WorkspaceLog.error('web.page.error', event.error.getErrorInfo());
        })
        .width('100%')
        .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F7F6F3')
  }
}
