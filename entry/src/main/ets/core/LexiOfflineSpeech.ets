import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { speechRecognizer } from '@kit.CoreSpeechKit';
import { util } from '@kit.ArkTS';

export class LexiSpeechSnapshot {
  state: string = 'idle';
  text: string = '';
  partial: string = '';
  message: string = '';
}

/** Only Core Speech's documented offline mode is used. No audio is written to files or sent by the app. */
export class LexiOfflineSpeech {
  private static sessions: Set<LexiOfflineSpeech> = new Set<LexiOfflineSpeech>();
  private engine: speechRecognizer.SpeechRecognitionEngine | undefined = undefined;
  private listener: (snapshot: LexiSpeechSnapshot) => void = (_snapshot: LexiSpeechSnapshot): void => {};
  private generation: number = 0;
  private disposed: boolean = false;
  private sessionId: string = '';
  private state: string = 'idle';
  private clauses: string[] = [];
  private partial: string = '';
  private readyTimer: number = -1;
  private finishTimer: number = -1;
  private durationTimer: number = -1;

  static supported(): boolean {
    try { return canIUse('SystemCapability.AI.SpeechRecognizer'); } catch { return false; }
  }

  private active(): boolean { return ['requesting', 'starting', 'listening', 'stopping'].includes(this.state); }

  private current(generation: number, sessionId: string): boolean {
    return !this.disposed && generation === this.generation && sessionId === this.sessionId && this.active();
  }

  private emit(message: string): void {
    if (this.disposed) { return; }
    const snapshot = new LexiSpeechSnapshot(); snapshot.state = this.state;
    snapshot.partial = this.partial; snapshot.text = this.clauses.join('') + this.partial; snapshot.message = message;
    try { this.listener(snapshot); } catch {}
  }

  private clearTimers(): void {
    if (this.readyTimer >= 0) { clearTimeout(this.readyTimer); this.readyTimer = -1; }
    if (this.finishTimer >= 0) { clearTimeout(this.finishTimer); this.finishTimer = -1; }
    if (this.durationTimer >= 0) { clearTimeout(this.durationTimer); this.durationTimer = -1; }
  }

  private release(cancel: boolean): void {
    LexiOfflineSpeech.sessions.delete(this);
    this.clearTimers();
    const engine = this.engine; this.engine = undefined;
    if (!engine) { return; }
    if (cancel) { try { engine.cancel(this.sessionId); } catch {} }
    try { engine.shutdown(); } catch {}
  }

  private fail(message: string): void {
    this.generation++; this.state = 'error'; this.release(true); this.emit(message);
  }

  private complete(message: string): void {
    this.state = 'complete'; this.release(false); this.emit(message);
  }

  async start(context: common.UIAbilityContext, listener: (snapshot: LexiSpeechSnapshot) => void): Promise<void> {
    if (this.disposed || this.active()) { return; }
    const generation = ++this.generation;
    this.listener = listener; this.clauses = []; this.partial = '';
    this.sessionId = `lexi_${util.generateRandomUUID(true)}`;
    const sessionId = this.sessionId;
    if (!LexiOfflineSpeech.supported()) {
      this.state = 'error'; this.emit('这台设备未提供离线语音识别，可直接在下方输入文字。'); return;
    }
    LexiOfflineSpeech.sessions.add(this);
    this.state = 'requesting'; this.emit('请允许麦克风权限。语音仅在设备上识别。');
    try {
      // This method is invoked only by the user's explicit record action.
      const permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE']);
      if (!this.current(generation, sessionId)) { return; }
      if (!permission.authResults.length || permission.authResults.some((result: number): boolean => result !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED)) {
        this.fail('未获得麦克风权限。可以在系统设置中授权，或继续手动输入。'); return;
      }
      this.state = 'starting'; this.emit('正在准备中文离线识别…');
      this.readyTimer = setTimeout((): void => {
        if (this.current(generation, sessionId)) { this.fail('离线语音服务启动超时，已停止录音准备。可重试或手动输入。'); }
      }, 15000);
      const params: speechRecognizer.CreateEngineParams = {
        language: 'zh-CN', online: 1,
        extraParams: { locate: 'CN', recognizerMode: 'short' }
      };
      // SDK @hms.ai.speechRecognizer: online=1 is OFFLINE; no other mode or fallback is attempted.
      const engine = await speechRecognizer.createEngine(params);
      if (!this.current(generation, sessionId)) { try { engine.shutdown(); } catch {} return; }
      this.engine = engine;
      const recognitionListener: speechRecognizer.RecognitionListener = {
        onStart: (id: string, _message: string): void => {
          if (!this.current(generation, id) || this.state !== 'starting') { return; }
          if (this.readyTimer >= 0) { clearTimeout(this.readyTimer); this.readyTimer = -1; }
          this.state = 'listening'; this.emit('正在离线识别，请说普通话。可随时停止，最长 60 秒。');
        },
        onEvent: (_id: string, _code: number, _message: string): void => {},
        onResult: (id: string, result: speechRecognizer.SpeechRecognitionResult): void => {
          if (!this.current(generation, id)) { return; }
          if (result.isFinal || result.isLast) {
            if (result.result && this.clauses[this.clauses.length - 1] !== result.result) { this.clauses.push(result.result); }
            this.partial = '';
          } else { this.partial = result.result; }
          this.emit(result.isFinal ? '已识别一段文字。' : '正在识别…');
          if (result.isLast) { this.complete('识别已完成。请检查文字后插入笔记。'); }
        },
        onComplete: (id: string, _message: string): void => {
          if (this.current(generation, id)) { this.complete('识别已结束。请检查文字后插入笔记。'); }
        },
        onError: (id: string, code: number, _message: string): void => {
          if (!this.current(generation, id)) { return; }
          this.fail(code === 1002200012 ? '麦克风权限不可用。已停止录音，可以手动输入。' :
            `离线语音服务不可用（${code}）。已停止录音，已有文字保留，可重试或手动输入。`);
        }
      };
      engine.setListener(recognitionListener);
      const startParams: speechRecognizer.StartParams = {
        sessionId, audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 },
        extraParams: { recognitionMode: 0, vadEnd: 3000, maxAudioDuration: 60000 }
      };
      this.durationTimer = setTimeout((): void => { if (this.current(generation, sessionId)) { this.stop(); } }, 65000);
      engine.startListening(startParams);
    } catch {
      if (this.current(generation, sessionId)) {
        this.fail('无法启动设备的中文离线识别服务。未尝试联网识别，可重试或手动输入。');
      }
    }
  }

  stop(): void {
    if (!this.active()) { return; }
    if (!this.engine) { this.cancel(); return; }
    if (this.state === 'stopping') { return; }
    this.state = 'stopping'; this.emit('正在结束录音并整理识别结果…');
    const generation = this.generation; const sessionId = this.sessionId;
    this.finishTimer = setTimeout((): void => {
      if (this.current(generation, sessionId)) { this.complete('录音已结束。最终结果等待超时，已保留现有文字供检查。'); }
    }, 5000);
    try { this.engine.finish(sessionId); }
    catch { this.fail('结束识别时出现问题。录音已停止，已有文字保留。'); }
  }

  cancel(): void {
    if (this.disposed) { return; }
    this.generation++; this.state = 'cancelled'; this.release(true);
    this.clauses = []; this.partial = ''; this.emit('本次录音已取消，之前输入的文字保留。');
  }

  static interruptAll(): void {
    const active = Array.from(LexiOfflineSpeech.sessions);
    for (const session of active) {
      if (!session.active()) { continue; }
      session.generation++; session.state = 'complete'; session.release(true);
      session.emit('应用已进入后台，录音已停止。当前识别文字已保留，可检查后插入。');
    }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true; this.generation++; this.state = 'cancelled'; this.release(true);
    this.listener = (_snapshot: LexiSpeechSnapshot): void => {};
  }
}
