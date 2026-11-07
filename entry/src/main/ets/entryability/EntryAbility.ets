import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want, wantConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, KeyboardAvoidMode, window } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { LexiContinuationSession } from '../core/LexiContinuationSession';
import { LexiContinuationData } from '../core/LexiContinuationData';
import { LexiNativeLaunch } from '../core/LexiNativeLaunch';
import { LexiOfflineSpeech } from '../core/LexiOfflineSpeech';
import { LexiShareCapture } from '../core/LexiShareCapture';
import { LexiShareService } from '../core/LexiShareService';

const DOMAIN = 0x1050;

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | undefined;
  private avoidListening: boolean = false;
  private sizeListening: boolean = false;
  private titleButtonsListening: boolean = false;
  private titleIntegrated: boolean = false;
  private chromeUnavailable: boolean = false;
  private originalDecorVisible: boolean = true;
  private originalDecorHeight: number = 37;
  private originalButtonStyle: window.DecorButtonStyle | undefined;
  private pendingContinuation: string = '';
  private readonly titleButtonsListener: (rect: window.TitleButtonRect) => void =
    (rect: window.TitleButtonRect): void => { this.updateTitleButtonsInset(rect); };
  private readonly avoidListener: (options: window.AvoidAreaOptions) => void =
    (_options: window.AvoidAreaOptions): void => {
      this.updateInsets();
    };
  private readonly sizeListener: (size: window.Size) => void =
    (_size: window.Size): void => {
      this.updatePcTitleBar();
      this.updateInsets();
    };

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'LexiNote', 'Failed to set colorMode: %{public}s', JSON.stringify(err));
    }
    this.receiveLaunch(want, launchParam);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void { this.receiveLaunch(want, launchParam); }

  onBackground(): void {
    AppStorage.setOrCreate<boolean>('lexiAbilityForeground', false);
    LexiOfflineSpeech.interruptAll();
    LexiShareService.unregisterWindow('EntryAbility');
  }

  onForeground(): void {
    AppStorage.setOrCreate<boolean>('lexiAbilityForeground', true);
    LexiShareService.registerWindow('EntryAbility', this.context, this.mainWindow);
    // Share/Form extensions may have saved while this process was in the background.
    AppStorage.setOrCreate<number>('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
  }

  private receiveLaunch(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      if (launchParam.launchReason === AbilityConstant.LaunchReason.CONTINUATION) {
        const raw = want.parameters?.lexiContinuation;
        if (typeof raw !== 'string') { throw new Error('未收到接续草稿'); }
        LexiContinuationData.decode(raw); this.pendingContinuation = raw;
        this.context.restoreWindowStage(new LocalStorage());
      } else {
        LexiNativeLaunch.receive(want);
        LexiShareCapture.receiveWantMarkdown(want);
      }
    } catch { hilog.warn(DOMAIN, 'LexiNote', 'A native launch request was invalid or unavailable'); }
  }

  onContinue(wantParam: Record<string, Object>): AbilityConstant.OnContinueResult {
    try {
      wantParam['lexiContinuation'] = LexiContinuationSession.export();
      wantParam[wantConstant.Params.SUPPORT_CONTINUE_PAGE_STACK_KEY] = false;
      wantParam[wantConstant.Params.SUPPORT_CONTINUE_SOURCE_EXIT_KEY] = false;
      return AbilityConstant.OnContinueResult.AGREE;
    } catch (error) {
      try { this.mainWindow?.getUIContext().getPromptAction().showToast({ message: (error as Error).message || '当前页面暂不支持接续' }); } catch {}
      return AbilityConstant.OnContinueResult.REJECT;
    }
  }

  onWindowStageRestore(windowStage: window.WindowStage): void {
    this.onWindowStageDestroy(); this.onWindowStageCreate(windowStage);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.mainWindow = windowStage.getMainWindowSync();
    this.context.setMissionContinueState(AbilityConstant.ContinueState.INACTIVE).catch((): void => {});
    try {
      const props = this.mainWindow.getWindowProperties();
      const disp = display.getDefaultDisplaySync();
      const density = disp.densityPixels > 0 ? disp.densityPixels : 3;
      if (props.windowRect.width > 0) {
        AppStorage.setOrCreate('lexiViewportWidth', props.windowRect.width / density);
      }
    } catch {}
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'LexiNote', 'Failed to load content: %{public}s', JSON.stringify(err));
        return;
      }
      this.mainWindow?.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
      this.updatePcTitleBar();
      this.updateInsets();
      try {
        this.mainWindow?.on('avoidAreaChange', this.avoidListener);
        this.avoidListening = true;
      } catch {
        this.avoidListening = false;
      }
      try {
        this.mainWindow?.on('windowSizeChange', this.sizeListener);
        this.sizeListening = true;
      } catch {
        this.sizeListening = false;
      }
      this.updateBars(this.context.config);
      LexiShareService.registerWindow('EntryAbility', this.context, this.mainWindow);
      if (this.pendingContinuation) {
        const raw = this.pendingContinuation; this.pendingContinuation = '';
        try { LexiContinuationSession.publishIncoming(raw); } catch { hilog.warn(DOMAIN, 'LexiNote', 'Continuation draft could not be staged'); }
      }
    });
  }

  onConfigurationUpdate(configuration: Configuration): void {
    this.updateBars(configuration);
    this.updatePcButtonStyle(configuration);
  }

  private updatePcTitleBar(): void {
    if (!this.mainWindow || deviceInfo.deviceType !== '2in1' || this.chromeUnavailable) { return; }
    try {
      if (this.titleIntegrated) {
        this.updateTitleButtonsInset(this.mainWindow.getTitleButtonRect());
        return;
      }
      this.originalDecorVisible = this.mainWindow.getWindowDecorVisible();
      this.originalDecorHeight = this.mainWindow.getWindowDecorHeight();
      this.originalButtonStyle = this.mainWindow.getDecorButtonStyle();
      this.mainWindow.on('windowTitleButtonRectChange', this.titleButtonsListener);
      this.titleButtonsListening = true;
      this.titleIntegrated = true;
      // Keep the native window controls and title hot zone over our own 52 vp header.
      this.mainWindow.setWindowDecorHeight(52);
      this.mainWindow.setWindowDecorVisible(false);
      this.updatePcButtonStyle(this.context.config);
      this.updateTitleButtonsInset(this.mainWindow.getTitleButtonRect());
    } catch {
      this.restorePcTitleBar();
      this.chromeUnavailable = true;
      hilog.warn(DOMAIN, 'LexiNote', 'Integrated PC title bar unavailable; keeping system decoration');
    }
  }

  private updatePcButtonStyle(configuration: Configuration): void {
    if (!this.mainWindow || !this.titleIntegrated) { return; }
    try {
      this.mainWindow.setDecorButtonStyle({
        colorMode: configuration.colorMode,
        buttonBackgroundSize: 32,
        buttonIconSize: 18,
        buttonBackgroundCornerRadius: 6,
        spacingBetweenButtons: 12,
        closeButtonRightMargin: 12
      });
    } catch {
      hilog.warn(DOMAIN, 'LexiNote', 'Using the default window button appearance');
    }
  }

  private updateTitleButtonsInset(rect: window.TitleButtonRect): void {
    // TitleButtonRect is already in vp, unlike windowRect and system avoid areas.
    AppStorage.setOrCreate('lexiWindowButtonsInset', this.titleIntegrated ? Math.max(0, rect.width + rect.right) : 0);
  }

  private restorePcTitleBar(): void {
    if (this.mainWindow && this.titleButtonsListening) {
      try { this.mainWindow.off('windowTitleButtonRectChange', this.titleButtonsListener); } catch {}
    }
    this.titleButtonsListening = false;
    if (this.mainWindow && this.titleIntegrated) {
      this.titleIntegrated = false;
      try { this.mainWindow.setWindowDecorHeight(this.originalDecorHeight); } catch {}
      try {
        if (this.originalButtonStyle) { this.mainWindow.setDecorButtonStyle(this.originalButtonStyle); }
      } catch {}
      try { this.mainWindow.setWindowDecorVisible(this.originalDecorVisible); } catch {}
    }
    AppStorage.setOrCreate('lexiWindowButtonsInset', 0);
  }

  private updateInsets(): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      const uiContext = this.mainWindow.getUIContext();
      const system = this.mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const cutout = this.mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
      const indicator = this.mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      const top = Math.max(system.topRect.height, cutout.topRect.height);
      const bottom = Math.max(system.bottomRect.height, cutout.bottomRect.height, indicator.bottomRect.height);
      const props = this.mainWindow.getWindowProperties();
      if (props.windowRect.width > 0) {
        AppStorage.setOrCreate('lexiViewportWidth', uiContext.px2vp(props.windowRect.width));
      }
      AppStorage.setOrCreate('lexiTopInset', uiContext.px2vp(top));
      AppStorage.setOrCreate('lexiBottomInset', uiContext.px2vp(bottom));
    } catch {
      AppStorage.setOrCreate('lexiBottomInset', 24);
    }
  }

  private updateBars(configuration: Configuration): void {
    if (!this.mainWindow) {
      return;
    }
    const dark = configuration.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    AppStorage.setOrCreate('lexiColorMode', dark ? 1 : 0);
    const background = dark ? '#12131B' : '#F6F4FB';
    const foreground = dark ? '#F5F3FB' : '#231B36';
    try {
      this.mainWindow.setWindowBackgroundColor(background);
    } catch {
      hilog.warn(DOMAIN, 'LexiNote', 'Window background unavailable');
    }
    this.mainWindow.setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      navigationBarColor: '#00000000',
      statusBarContentColor: foreground,
      navigationBarContentColor: foreground
    }).catch(() => {
      hilog.warn(DOMAIN, 'LexiNote', 'System bar appearance unavailable');
    });
  }

  onWindowStageDestroy(): void {
    LexiShareService.unregisterWindow('EntryAbility');
    this.restorePcTitleBar();
    if (this.mainWindow && this.avoidListening) {
      try {
        this.mainWindow.off('avoidAreaChange', this.avoidListener);
      } catch {}
    }
    if (this.mainWindow && this.sizeListening) {
      try { this.mainWindow.off('windowSizeChange', this.sizeListener); } catch {}
    }
    this.avoidListening = false;
    this.sizeListening = false;
    this.mainWindow = undefined;
  }
}
