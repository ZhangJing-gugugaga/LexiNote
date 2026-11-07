import { common } from '@kit.AbilityKit';
import { NoteItem, VaultItem } from '../core/LexiModels';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiLocalAssistant, LexiLocalSuggestion } from '../core/LexiLocalAssistant';
import {
  LexiHarnessConfig,
  LexiHarnessContentBlock,
  LexiHarnessModelProfile,
  LexiHarnessNoteRef,
  LexiHarnessSessionRecord,
  LexiHarnessSkillDefinition,
  LexiHarnessTodoItem,
  LexiHarnessUiItem
} from './LexiHarnessTypes';
import { LexiHarnessSession } from './LexiHarnessSession';
import { LexiHarnessSkills } from './LexiHarnessSkills';
import { LexiHarnessTools, LexiHarnessUiActionRequest } from './LexiHarnessTools';
import { LexiHarnessLlm } from './LexiHarnessLlm';

export class LexiHarnessService {
  private static initialized: boolean = false;
  private static appContext: common.UIAbilityContext | undefined = undefined;
  private static config: LexiHarnessConfig = new LexiHarnessConfig();
  private static skills: LexiHarnessSkillDefinition[] = [];
  private static sessions: LexiHarnessSessionRecord[] = [];
  private static activeSession: LexiHarnessSession = new LexiHarnessSession();
  private static activeEditorNoteId: string = '';
  private static runningTurn: boolean = false;
  private static abortRequested: boolean = false;
  private static liveText: string = '';
  private static liveReasoning: string = '';
  private static turnCounter: number = 0;
  private static balanceText: string = '';
  private static balanceLoading: boolean = false;
  private static uiActionHandler: ((req: LexiHarnessUiActionRequest) => void) | undefined = undefined;

  private static bumpRevision(): void {
    const rev = AppStorage.get<number>('lexiHarnessRevision') ?? 0;
    AppStorage.setOrCreate('lexiHarnessRevision', rev + 1);
  }

  static setUiActionHandler(handler: (req: LexiHarnessUiActionRequest) => void): void {
    LexiHarnessService.uiActionHandler = handler;
  }

  static setActiveEditorNoteId(noteId: string): void {
    if (LexiHarnessService.activeEditorNoteId !== noteId) {
      LexiHarnessService.activeEditorNoteId = noteId;
      AppStorage.setOrCreate('lexiHarnessActiveNoteId', noteId);
      LexiHarnessService.bumpRevision();
    }
  }

  static getActiveEditorNoteId(): string {
    return LexiHarnessService.activeEditorNoteId;
  }

  static isRunning(): boolean {
    return LexiHarnessService.runningTurn;
  }

  static getConfig(): LexiHarnessConfig {
    return LexiHarnessService.config;
  }

  static getModels(): LexiHarnessModelProfile[] {
    return LexiHarnessService.config.models;
  }

  static getActiveModelProfile(): LexiHarnessModelProfile {
    const models = LexiHarnessService.config.models;
    const found = models.find((m: LexiHarnessModelProfile): boolean => m.id === LexiHarnessService.config.activeModelId);
    if (found) {
      return found;
    }
    if (models.length > 0) {
      return models[0];
    }
    return new LexiHarnessModelProfile(
      'model-default',
      LexiHarnessService.config.model || 'deepseek-chat',
      LexiHarnessService.config.provider,
      LexiHarnessService.config.baseUrl,
      LexiHarnessService.config.apiKey,
      LexiHarnessService.config.model || 'deepseek-chat',
      LexiHarnessService.config.reasoningEffort
    );
  }

  static getBalanceText(): string {
    return LexiHarnessService.balanceText;
  }

  static isBalanceLoading(): boolean {
    return LexiHarnessService.balanceLoading;
  }

  static async refreshBalance(): Promise<string> {
    if (!LexiHarnessService.config.apiKey.trim()) {
      LexiHarnessService.balanceText = '未配置密钥';
      LexiHarnessService.bumpRevision();
      return LexiHarnessService.balanceText;
    }
    LexiHarnessService.balanceLoading = true;
    LexiHarnessService.bumpRevision();
    try {
      LexiHarnessService.balanceText = await LexiHarnessLlm.fetchBalance(LexiHarnessService.config);
      return LexiHarnessService.balanceText;
    } finally {
      LexiHarnessService.balanceLoading = false;
      LexiHarnessService.bumpRevision();
    }
  }

  private static ensureModelProfiles(): void {
    const cfg = LexiHarnessService.config;
    const baseKey = cfg.apiKey || '';
    const baseUrl = cfg.baseUrl || 'https://api.deepseek.com';
    const provider = cfg.provider || 'deepseek-openai';
    if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
      const defaults: LexiHarnessModelProfile[] = [
        new LexiHarnessModelProfile('model-deepseek-chat', 'DeepSeek Chat (V3)', provider, baseUrl, baseKey, 'deepseek-chat', 'medium'),
        new LexiHarnessModelProfile('model-deepseek-reasoner', 'DeepSeek Reasoner (R1)', provider, baseUrl, baseKey, 'deepseek-reasoner', 'high'),
        new LexiHarnessModelProfile('model-deepseek-flash', 'DeepSeek Flash', provider.includes('anthropic') ? provider : 'deepseek-anthropic', 'https://api.deepseek.com/anthropic', baseKey, 'deepseek-flash', 'medium')
      ];
      if (cfg.model && !defaults.some((m: LexiHarnessModelProfile): boolean => m.model === cfg.model)) {
        defaults.unshift(
          new LexiHarnessModelProfile(`model-${cfg.model}`, cfg.model, provider, baseUrl, baseKey, cfg.model, cfg.reasoningEffort || 'medium')
        );
      }
      cfg.models = defaults;
    } else {
      // Backfill shared API key to default DeepSeek profiles if they have empty keys and cfg.apiKey is set
      if (baseKey.trim().length > 0) {
        for (let i = 0; i < cfg.models.length; i++) {
          if (!cfg.models[i].apiKey && cfg.models[i].baseUrl.includes('deepseek.com')) {
            cfg.models[i].apiKey = baseKey;
          }
        }
      }
    }
    const matched = cfg.models.find((m: LexiHarnessModelProfile): boolean => m.id === cfg.activeModelId) ||
      cfg.models.find((m: LexiHarnessModelProfile): boolean => m.model === cfg.model) ||
      cfg.models[0];
    if (matched) {
      cfg.activeModelId = matched.id;
      cfg.provider = matched.provider;
      cfg.baseUrl = matched.baseUrl;
      cfg.apiKey = matched.apiKey || cfg.apiKey;
      cfg.model = matched.model;
      cfg.reasoningEffort = matched.reasoningEffort;
    }
  }

  static async selectModelProfile(profileId: string): Promise<void> {
    const cfg = LexiHarnessService.config;
    const target = cfg.models.find((m: LexiHarnessModelProfile): boolean => m.id === profileId);
    if (!target) {
      return;
    }
    cfg.activeModelId = target.id;
    cfg.provider = target.provider;
    cfg.baseUrl = target.baseUrl;
    if (target.apiKey.trim().length > 0) {
      cfg.apiKey = target.apiKey;
    }
    cfg.model = target.model;
    cfg.reasoningEffort = target.reasoningEffort;
    await LexiStorageService.setSetting('harness_config_v1', JSON.stringify(cfg));
    LexiHarnessService.bumpRevision();
    LexiHarnessService.refreshBalance();
  }

  static async setActiveReasoningEffort(effort: string): Promise<void> {
    const cfg = LexiHarnessService.config;
    await LexiHarnessService.setModelProfileReasoningEffort(cfg.activeModelId, effort);
  }

  static async setModelProfileReasoningEffort(profileId: string, effort: string): Promise<void> {
    const cfg = LexiHarnessService.config;
    const nextModels: LexiHarnessModelProfile[] = [];
    for (let i = 0; i < cfg.models.length; i++) {
      const m = cfg.models[i];
      if (m.id === profileId) {
        nextModels.push(new LexiHarnessModelProfile(m.id, m.label, m.provider, m.baseUrl, m.apiKey, m.model, effort));
      } else {
        nextModels.push(m);
      }
    }
    cfg.models = nextModels;
    if (profileId === cfg.activeModelId) {
      cfg.reasoningEffort = effort;
    }
    await LexiStorageService.setSetting('harness_config_v1', JSON.stringify(cfg));
    LexiHarnessService.bumpRevision();
  }

  static async upsertModelProfile(profile: LexiHarnessModelProfile, setActive: boolean = true): Promise<void> {
    const cfg = LexiHarnessService.config;
    const cleanId = profile.id.trim() || `model-${Date.now()}`;
    profile.id = cleanId;
    profile.model = profile.model.trim() || 'deepseek-chat';
    profile.label = profile.label.trim() || profile.model;
    profile.baseUrl = profile.baseUrl.trim() || (profile.provider.includes('anthropic') ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com');
    const idx = cfg.models.findIndex((m: LexiHarnessModelProfile): boolean => m.id === cleanId);
    if (idx >= 0) {
      cfg.models[idx] = profile;
    } else {
      cfg.models.push(profile);
    }
    // Share API key across other DeepSeek profiles that don't have a key yet
    if (profile.apiKey.trim().length > 0 && profile.baseUrl.includes('deepseek.com')) {
      for (let i = 0; i < cfg.models.length; i++) {
        if (!cfg.models[i].apiKey && cfg.models[i].baseUrl.includes('deepseek.com')) {
          cfg.models[i].apiKey = profile.apiKey.trim();
        }
      }
    }
    if (setActive || !cfg.activeModelId) {
      cfg.activeModelId = profile.id;
      cfg.provider = profile.provider;
      cfg.baseUrl = profile.baseUrl;
      cfg.apiKey = profile.apiKey;
      cfg.model = profile.model;
      cfg.reasoningEffort = profile.reasoningEffort;
    }
    await LexiStorageService.setSetting('harness_config_v1', JSON.stringify(cfg));
    LexiHarnessService.bumpRevision();
    LexiHarnessService.refreshBalance();
  }

  static async deleteModelProfile(profileId: string): Promise<void> {
    const cfg = LexiHarnessService.config;
    if (cfg.models.length <= 1) {
      return;
    }
    cfg.models = cfg.models.filter((m: LexiHarnessModelProfile): boolean => m.id !== profileId);
    if (cfg.activeModelId === profileId && cfg.models.length > 0) {
      await LexiHarnessService.selectModelProfile(cfg.models[0].id);
      return;
    }
    await LexiStorageService.setSetting('harness_config_v1', JSON.stringify(cfg));
    LexiHarnessService.bumpRevision();
  }

  static getSkills(): LexiHarnessSkillDefinition[] {
    return LexiHarnessService.skills;
  }

  static getSessions(): LexiHarnessSessionRecord[] {
    return LexiHarnessService.sessions;
  }

  static getActiveSession(): LexiHarnessSession {
    return LexiHarnessService.activeSession;
  }

  static getTodos(): LexiHarnessTodoItem[] {
    return LexiHarnessService.activeSession.record.todos;
  }

  static deriveUiItems(): LexiHarnessUiItem[] {
    return LexiHarnessService.activeSession.deriveUiItems(
      LexiHarnessService.liveText,
      LexiHarnessService.liveReasoning,
      LexiHarnessService.runningTurn
    );
  }

  static async init(context: common.UIAbilityContext): Promise<void> {
    LexiHarnessService.appContext = context;
    if (LexiHarnessService.initialized) {
      return;
    }
    await LexiStorageService.init(context);

    // Load config
    const rawConfig = await LexiStorageService.getSetting('harness_config_v1', '');
    if (rawConfig) {
      try {
        const parsed = JSON.parse(rawConfig) as LexiHarnessConfig;
        if (parsed && typeof parsed === 'object') {
          LexiHarnessService.config.provider = parsed.provider || 'deepseek-openai';
          LexiHarnessService.config.apiKey = parsed.apiKey || '';
          LexiHarnessService.config.baseUrl = parsed.baseUrl || 'https://api.deepseek.com';
          LexiHarnessService.config.model = parsed.model || 'deepseek-chat';
          LexiHarnessService.config.reasoningEffort = parsed.reasoningEffort || 'medium';
          LexiHarnessService.config.maxTokens = parsed.maxTokens || 8192;
          LexiHarnessService.config.temperature = typeof parsed.temperature === 'number' ? parsed.temperature : 0.3;
          LexiHarnessService.config.enableLocalFallback = parsed.enableLocalFallback !== false;
          LexiHarnessService.config.activeModelId = parsed.activeModelId || '';
          LexiHarnessService.config.models = Array.isArray(parsed.models) ? parsed.models : [];
        }
      } catch {}
    }
    LexiHarnessService.ensureModelProfiles();
    if (LexiHarnessService.config.apiKey.trim().length > 0) {
      LexiHarnessService.refreshBalance();
    } else {
      LexiHarnessService.balanceText = '未配置密钥';
    }

    // Load skills
    LexiHarnessService.skills = await LexiHarnessSkills.loadAllSkills(context);

    // Load sessions
    const rawSessions = await LexiStorageService.getRawValue('harness_sessions_v1', '[]');
    try {
      const parsedSessions = JSON.parse(rawSessions) as LexiHarnessSessionRecord[];
      if (Array.isArray(parsedSessions) && parsedSessions.length > 0) {
        LexiHarnessService.sessions = parsedSessions;
        LexiHarnessService.activeSession = new LexiHarnessSession(parsedSessions[0]);
      } else {
        const initial = new LexiHarnessSession();
        LexiHarnessService.sessions = [initial.record];
        LexiHarnessService.activeSession = initial;
      }
    } catch {
      const initial = new LexiHarnessSession();
      LexiHarnessService.sessions = [initial.record];
      LexiHarnessService.activeSession = initial;
    }

    LexiHarnessService.initialized = true;
    LexiHarnessService.bumpRevision();
  }

  static async saveConfig(nextConfig: LexiHarnessConfig): Promise<void> {
    LexiHarnessService.config = nextConfig;
    await LexiStorageService.setSetting('harness_config_v1', JSON.stringify(nextConfig));
    LexiHarnessService.bumpRevision();
  }

  static async reloadSkills(): Promise<void> {
    if (!LexiHarnessService.appContext) { return; }
    LexiHarnessService.skills = await LexiHarnessSkills.loadAllSkills(LexiHarnessService.appContext);
    LexiHarnessService.bumpRevision();
  }

  private static async persistSessions(): Promise<void> {
    const activeRec = LexiHarnessService.activeSession.record;
    const existingIdx = LexiHarnessService.sessions.findIndex((s: LexiHarnessSessionRecord): boolean => s.id === activeRec.id);
    if (existingIdx >= 0) {
      LexiHarnessService.sessions[existingIdx] = activeRec;
    } else {
      LexiHarnessService.sessions.unshift(activeRec);
    }
    LexiHarnessService.sessions = LexiHarnessService.sessions.slice(0, 25);
    try {
      await LexiStorageService.setRawValue('harness_sessions_v1', JSON.stringify(LexiHarnessService.sessions));
    } catch {}
  }

  static async createNewSession(): Promise<void> {
    if (LexiHarnessService.runningTurn) {
      LexiHarnessService.abortCurrentTurn();
    }
    const fresh = new LexiHarnessSession();
    LexiHarnessService.sessions.unshift(fresh.record);
    LexiHarnessService.activeSession = fresh;
    await LexiHarnessService.persistSessions();
    LexiHarnessService.bumpRevision();
  }

  static async switchSession(sessionId: string): Promise<void> {
    if (LexiHarnessService.runningTurn) {
      LexiHarnessService.abortCurrentTurn();
    }
    const target = LexiHarnessService.sessions.find((s: LexiHarnessSessionRecord): boolean => s.id === sessionId);
    if (target) {
      LexiHarnessService.activeSession = new LexiHarnessSession(target);
      LexiHarnessService.bumpRevision();
    }
  }

  static async deleteSession(sessionId: string): Promise<void> {
    if (LexiHarnessService.runningTurn) {
      LexiHarnessService.abortCurrentTurn();
    }
    LexiHarnessService.sessions = LexiHarnessService.sessions.filter((s: LexiHarnessSessionRecord): boolean => s.id !== sessionId);
    if (LexiHarnessService.sessions.length === 0) {
      const fresh = new LexiHarnessSession();
      LexiHarnessService.sessions = [fresh.record];
      LexiHarnessService.activeSession = fresh;
    } else if (LexiHarnessService.activeSession.record.id === sessionId) {
      LexiHarnessService.activeSession = new LexiHarnessSession(LexiHarnessService.sessions[0]);
    }
    await LexiHarnessService.persistSessions();
    LexiHarnessService.bumpRevision();
  }

  static abortCurrentTurn(): void {
    LexiHarnessService.abortRequested = true;
    LexiHarnessLlm.abortActiveStream();
    LexiHarnessService.runningTurn = false;
    LexiHarnessService.liveText = '';
    LexiHarnessService.liveReasoning = '';
    LexiHarnessService.bumpRevision();
  }

  private static buildSystemPrompt(): string {
    return [
      `你是知萤 (LexiNote) 的原生大模型智能体，基于 DeepSeek Harness 架构（Event-Sourced Session + Two-Tier Skill Registry + ReAct Tool Loop）构建。`,
      `你运行在 HarmonyOS NEXT 知萤应用中，拥有完整操作用户本地 Markdown 知识库、双向链接图谱、思维导图(MindMap)、自由白板(Canvas)、今日日记与模板库的工具权限。`,
      ``,
      `## 核心行为准则`,
      `1. **优先加载 Skill**：当用户的请求涉及知萤操作（如创建/编辑/整理笔记、建立双链、转换思维导图、创建自由白板、管理标签与属性）且当前会话尚未加载 \`lexinote-operator\` 时，首先调用 \`skill\` 工具加载 \`lexinote-operator\`（或对应的 \`lexinote-study-note\` / \`lexinote-knowledge-graph\`）。`,
      `2. **真实工具操作**：不要只口头给出建议而不执行操作。当用户要求新建笔记、修改当前笔记、生成思维导图、建立双链或创建白板时，直接调用对应工具完成落盘保存。`,
      `3. **尊重已有内容**：修改已有笔记前先读取内容；对当前打开的笔记优先使用 \`edit_active_note\` 以便用户在编辑器中实时看到更新。`,
      `4. **善用知萤原生语法**：在笔记正文中积极使用 \`[[目标笔记标题]]\` 双向链接、\`#多级/标签\`、\`==重点高亮==\`、\`> [!NOTE] 提示框\`、\`$$LaTeX公式$$\` 和 \`- [ ] 待办事项\`。`,
      `5. **任务跟踪**：遇到包含 3 个以上步骤的复杂任务，先调用 \`todo_write\` 列出执行计划，并在完成过程中更新状态。`
    ].join('\n');
  }

  private static async buildRuntimeContextSnapshot(attachedRefs: LexiHarnessNoteRef[]): Promise<string> {
    const vaultId = await LexiStorageService.getActiveVaultId();
    const projectId = await LexiStorageService.getActiveProjectId(vaultId);
    const vaults = await LexiStorageService.getVaults();
    const activeVault = vaults.find((v: VaultItem): boolean => v.id === vaultId);
    const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    const openId = LexiHarnessService.activeEditorNoteId || await LexiStorageService.getSetting('lastEditedNoteId', '');
    const openNote = openId ? allNotes.find((n: NoteItem): boolean => n.id === openId) : undefined;

    const sections: string[] = [
      `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`,
      `- Active Workspace: ${activeVault ? activeVault.name : '个人知识库'} (vaultId: ${vaultId}, projectId: ${projectId || 'all'})`,
      `- Active Notes Count: ${allNotes.length}`
    ];

    if (openNote) {
      const headings = MarkdownEngine.extractOutline(openNote.content).map((h): string => h.title).join(' / ');
      sections.push(
        `- Currently Open Note in Editor: 《${MarkdownEngine.displayTitle(openNote)}》 (noteId: ${openNote.id}, notebook: ${openNote.notebook}, tags: ${openNote.tags.join(',') || 'none'}, headings: ${headings || 'none'}, length: ${openNote.content.length} chars)`
      );
    }

    if (attachedRefs.length > 0) {
      sections.push(`\n### User Attached # References:`);
      for (let i = 0; i < attachedRefs.length; i++) {
        const ref = attachedRefs[i];
        if (ref.kind === 'note') {
          const note = allNotes.find((n: NoteItem): boolean => n.id === ref.id || MarkdownEngine.displayTitle(n) === ref.title);
          if (note) {
            sections.push(`#### Referenced Note: 《${MarkdownEngine.displayTitle(note)}》 (ID: ${note.id}, Notebook: ${note.notebook})\n\`\`\`markdown\n${note.content.slice(0, 3000)}\n\`\`\``);
          }
        } else if (ref.kind === 'folder') {
          const folderNotes = allNotes.filter((n: NoteItem): boolean => n.notebook === ref.title);
          sections.push(`#### Referenced Notebook Folder: 「${ref.title}」 (${folderNotes.length} notes: ${folderNotes.slice(0, 12).map((n: NoteItem): string => `《${MarkdownEngine.displayTitle(n)}》`).join(', ')})`);
        }
      }
    }

    return sections.join('\n');
  }

  private static dispatchUiAction(req: LexiHarnessUiActionRequest): void {
    if (LexiHarnessService.uiActionHandler) {
      LexiHarnessService.uiActionHandler(req);
    }
  }

  static triggerUiAction(req: LexiHarnessUiActionRequest): void {
    LexiHarnessService.dispatchUiAction(req);
  }

  /**
   * Built-in local ReAct execution when user has not configured an API Key yet,
   * so all 知萤 tools & skills can still be demonstrated and used out-of-the-box.
   */
  private static async runLocalSmartAgent(
    context: common.UIAbilityContext,
    userPrompt: string,
    attachedRefs: LexiHarnessNoteRef[]
  ): Promise<void> {
    const session = LexiHarnessService.activeSession;
    const lower = userPrompt.toLowerCase();
    const callTool = async (name: string, argsObj: Record<string, Object>): Promise<string> => {
      const callId = `local_call_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const argsJson = JSON.stringify(argsObj);
      const summary = LexiHarnessTools.presentCallSummary(name, argsJson);
      session.appendAssistantMessage([LexiHarnessContentBlock.toolCallBlock(callId, name, argsJson)]);
      session.appendToolCall(callId, name, argsJson, summary[0], summary[1]);
      LexiHarnessService.bumpRevision();
      const out = await LexiHarnessTools.executeTool(
        context,
        name,
        argsJson,
        LexiHarnessService.skills,
        LexiHarnessService.activeEditorNoteId,
        (todos: LexiHarnessTodoItem[]): void => {
          session.setTodos(todos);
          LexiHarnessService.bumpRevision();
        },
        (req: LexiHarnessUiActionRequest): void => {
          LexiHarnessService.dispatchUiAction(req);
        }
      );
      session.appendToolResult(callId, name, out.contentText, out.isError, out.title, out.subtitle, out.preview);
      LexiHarnessService.bumpRevision();
      return out.contentText;
    };

    // Always load lexinote-operator skill first if not loaded via slash gesture
    if (!userPrompt.includes('/lexinote-')) {
      await callTool('skill', { 'name': 'lexinote-operator' });
    }

    const vaultId = await LexiStorageService.getActiveVaultId();
    const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    const refNoteId = attachedRefs.length > 0 && attachedRefs[0].kind === 'note' ? attachedRefs[0].id : LexiHarnessService.activeEditorNoteId;
    const targetNote = refNoteId
      ? allNotes.find((n: NoteItem): boolean => n.id === refNoteId)
      : (allNotes.length > 0 ? allNotes[0] : undefined);

    if (lower.includes('导图') || lower.includes('mindmap')) {
      if (targetNote) {
        await callTool('manage_mindmap', {
          'action': 'convert_from_note',
          'fromNote': targetNote.id,
          'title': `${MarkdownEngine.displayTitle(targetNote)} · 思维导图`,
          'openAfterSave': true
        });
        session.appendAssistantMessage([
          LexiHarnessContentBlock.textBlock(
            `已为你调用 \`manage_mindmap\` 将笔记 **《${MarkdownEngine.displayTitle(targetNote)}》** 的章节大纲转换为思维导图并打开。\n\n> [!TIP] 提示\n> 当前处于 **本地智能执行模式**（未配置外部大模型 API Key）。你可以点击右上角 **⚙️ 模型设置** 填入 DeepSeek / OpenAI / Anthropic API Key 开启完整大模型深度推理。`
          )
        ]);
        return;
      }
    }

    if (lower.includes('白板') || lower.includes('canvas')) {
      const topNotes = allNotes.slice(0, 4);
      const cards: Record<string, Object>[] = topNotes.map((n: NoteItem, idx: number): Record<string, Object> => ({
        'id': `card-${idx + 1}`,
        'title': MarkdownEngine.displayTitle(n),
        'content': MarkdownEngine.extractSnippet(n),
        'noteRefId': n.id,
        'noteRefTitle': MarkdownEngine.displayTitle(n),
        'x': 80 + (idx % 2) * 300,
        'y': 80 + Math.floor(idx / 2) * 200,
        'colorTag': ['purple', 'indigo', 'teal', 'amber'][idx % 4]
      }));
      const edges: Record<string, Object>[] = [];
      for (let i = 0; i + 1 < cards.length; i++) {
        edges.push({
          'id': `edge-${i + 1}`,
          'fromId': `card-${i + 1}`,
          'toId': `card-${i + 2}`,
          'label': '知识关联'
        });
      }
      await callTool('manage_canvas', {
        'action': 'create',
        'title': '知萤知识梳理白板',
        'cardsJson': JSON.stringify(cards),
        'edgesJson': JSON.stringify(edges),
        'openAfterSave': true
      });
      session.appendAssistantMessage([
        LexiHarnessContentBlock.textBlock(
          `已为你创建并打开自由白板 **《知萤知识梳理白板》**，自动挂载了 ${cards.length} 张关联笔记卡片与连接线。`
        )
      ]);
      return;
    }

    if (lower.includes('双链') || lower.includes('关联') || lower.includes('提及') || lower.includes('图谱')) {
      const report = await callTool('manage_links_and_graph', { 'action': 'inspect' });
      const linkedReport = await callTool('manage_links_and_graph', { 'action': 'establish_all_mentions' });
      session.appendAssistantMessage([
        LexiHarnessContentBlock.textBlock(
          `已完成知识图谱扫描与双向链接织网：\n\n${report}\n\n**执行结果**：${linkedReport}`
        )
      ]);
      return;
    }

    if (lower.includes('今日') || lower.includes('日记') || lower.includes('daily')) {
      await callTool('manage_templates_and_daily', { 'action': 'open_daily' });
      session.appendAssistantMessage([
        LexiHarnessContentBlock.textBlock(`已为你打开或创建今日笔记，你可以继续让我往今日笔记中追加待办或总结。`)
      ]);
      return;
    }

    if (lower.includes('总结') || lower.includes('整理') || lower.includes('待办') || lower.includes('润色')) {
      if (targetNote) {
        await callTool('read_note', { 'noteId': targetNote.id });
        const arrangement = LexiLocalAssistant.arrange(
          targetNote.content,
          allNotes.filter((n: NoteItem): boolean => n.id !== targetNote.id)
        );
        const allIds: string[] = [
          ...arrangement.actions.map((s: LexiLocalSuggestion): string => s.id),
          ...arrangement.links.map((s: LexiLocalSuggestion): string => s.id),
          ...arrangement.tags.map((s: LexiLocalSuggestion): string => s.id)
        ];
        const markdownBlock = LexiLocalAssistant.selectedMarkdown(arrangement, allIds, arrangement.summary, true);
        const tagNames = arrangement.tags.map((s: LexiLocalSuggestion): string => s.label.replace(/^#/, '')).join(',');
        await callTool('update_note', {
          'noteId': targetNote.id,
          'mode': 'append',
          'content': markdownBlock,
          'tags': tagNames
        });
        session.appendAssistantMessage([
          LexiHarnessContentBlock.textBlock(
            `已读取 **《${MarkdownEngine.displayTitle(targetNote)}》** 并完成要点提炼、待办提取与双链/标签推荐，结果已自动追加到笔记末尾：\n\n${markdownBlock}`
          )
        ]);
        return;
      }
    }

    if (lower.includes('新建') || lower.includes('创建') || lower.includes('写一篇')) {
      const cleanedTitle = userPrompt
        .replace(/\/[a-z0-9-]+/g, '')
        .replace(/^(请|帮我)?(在知萤中)?(新建|创建|写一篇|生成)(关于)?/g, '')
        .replace(/(的笔记|笔记|文档).*$/g, '')
        .trim() || 'AI 知识笔记';
      const body = [
        `# ${cleanedTitle}`,
        ``,
        `> [!NOTE] 核心导读`,
        `> 本笔记由知萤 Harness 自动创建，支持 \`[[双向链接]]\`、\`#多级标签\` 与一键转换思维导图。`,
        ``,
        `## 一、核心概念`,
        `- ==关键要点==：围绕 **${cleanedTitle}** 的结构化梳理。`,
        ``,
        `## 二、行动清单`,
        `- [ ] 补充 ${cleanedTitle} 的详细案例与参考资料`,
        `- [ ] 与知识库已有笔记建立 \`[[双向链接]]\``
      ].join('\n');
      await callTool('create_note', {
        'title': cleanedTitle,
        'content': body,
        'notebook': '学习笔记',
        'noteType': 'study',
        'editorLevel': 'pro',
        'tags': 'AI生成,学习笔记',
        'openAfterCreate': true
      });
      session.appendAssistantMessage([
        LexiHarnessContentBlock.textBlock(`已为你创建并打开结构化笔记 **《${cleanedTitle}》**。`)
      ]);
      return;
    }

    // Default: inspect workspace status and search matching notes
    const statusText = await callTool('get_workspace_status', {});
    session.appendAssistantMessage([
      LexiHarnessContentBlock.textBlock(
        `${statusText}\n\n---\n> [!TIP] 配置大模型开启完整 DeepSeek Harness 推理\n> 你当前处于 **本地工具直连模式**。点击面板右上角 **⚙️ 模型设置**，填入 **DeepSeek**（\`https://api.deepseek.com\` 或 \`https://api.deepseek.com/anthropic\`）或任意 OpenAI / Anthropic 兼容 API Key，即可驱动多步 ReAct 智能体自主规划并操作知萤！`
      )
    ]);
  }

  static async sendUserMessage(
    context: common.UIAbilityContext,
    rawInputText: string,
    attachedRefs: LexiHarnessNoteRef[] = []
  ): Promise<void> {
    const trimmed = rawInputText.trim();
    if (!trimmed || LexiHarnessService.runningTurn) {
      return;
    }
    await LexiHarnessService.init(context);

    LexiHarnessService.runningTurn = true;
    LexiHarnessService.abortRequested = false;
    LexiHarnessService.liveText = '';
    LexiHarnessService.liveReasoning = '';
    const turnNumber = ++LexiHarnessService.turnCounter;
    const session = LexiHarnessService.activeSession;

    try {
      session.appendLifecycle('turn/start', turnNumber, 0);

      // Ensure system prompt is on the surface
      session.appendSystemMessage(LexiHarnessService.buildSystemPrompt());

      // Pre-step 1: Inject <available_skills> catalog if digest changed
      const catalogDigest = LexiHarnessSkills.catalogDigest(LexiHarnessService.skills);
      if (catalogDigest && session.record.lastCatalogDigest !== catalogDigest) {
        const catalogXml = LexiHarnessSkills.formatCatalogBlock(LexiHarnessService.skills);
        if (catalogXml) {
          session.appendUserMessage(catalogXml, 'skill-catalog');
          session.record.lastCatalogDigest = catalogDigest;
        }
      }

      // Pre-step 2: Inject Runtime Context snapshot if changed or refs attached
      const runtimeSnapshot = await LexiHarnessService.buildRuntimeContextSnapshot(attachedRefs);
      if (runtimeSnapshot !== session.record.lastRuntimeDigest || attachedRefs.length > 0) {
        session.appendUserMessage(runtimeSnapshot, 'runtime-context');
        session.record.lastRuntimeDigest = runtimeSnapshot;
      }

      // Append the human user message
      session.appendUserMessage(trimmed, 'user', attachedRefs);

      // Pre-step 3: Detect `/skill-name` gesture in user message and auto-inject <skill_content>
      const slashSkills = LexiHarnessSkills.extractSlashSkills(trimmed, LexiHarnessService.skills);
      for (let i = 0; i < slashSkills.length; i++) {
        const sk = slashSkills[i];
        session.appendUserMessage(
          LexiHarnessSkills.formatSkillContentBlock(sk),
          'skill-invocation',
          [],
          sk.name
        );
      }

      LexiHarnessService.bumpRevision();
      await LexiHarnessService.persistSessions();

      // Check if API key is configured
      if (!LexiHarnessService.config.apiKey.trim()) {
        if (LexiHarnessService.config.enableLocalFallback) {
          await LexiHarnessService.runLocalSmartAgent(context, trimmed, attachedRefs);
        } else {
          session.appendAssistantMessage([
            LexiHarnessContentBlock.textBlock('尚未配置大模型 API Key。请点击右上角「⚙️ 模型设置」配置 DeepSeek 或兼容大模型密钥。')
          ]);
        }
        session.appendLifecycle('turn/end', turnNumber, 1, 'completed');
        await LexiHarnessService.persistSessions();
        return;
      }

      // Multi-step ReAct Agent Loop (up to 10 steps per turn)
      const toolSchemas = LexiHarnessTools.getToolSchemas();
      const maxSteps = 10;
      for (let step = 1; step <= maxSteps; step++) {
        if (LexiHarnessService.abortRequested) {
          session.appendLifecycle('turn/end', turnNumber, step, 'aborted');
          break;
        }
        session.appendLifecycle('step/start', turnNumber, step);
        LexiHarnessService.liveText = '';
        LexiHarnessService.liveReasoning = '';
        LexiHarnessService.bumpRevision();

        const surfaceMessages = session.deriveMessages();
        const llmRes = await LexiHarnessLlm.streamChat(
          LexiHarnessService.config,
          surfaceMessages,
          toolSchemas,
          (liveText: string, liveReasoning: string): void => {
            LexiHarnessService.liveText = liveText;
            LexiHarnessService.liveReasoning = liveReasoning;
            LexiHarnessService.bumpRevision();
          }
        );

        LexiHarnessService.liveText = '';
        LexiHarnessService.liveReasoning = '';

        if (llmRes.errorMessage) {
          session.appendAssistantMessage([
            LexiHarnessContentBlock.textBlock(`⚠️ ${llmRes.errorMessage}`)
          ]);
          session.appendLifecycle('step/end', turnNumber, step, 'error');
          session.appendLifecycle('turn/end', turnNumber, step, 'error');
          break;
        }

        if (llmRes.blocks.length > 0) {
          session.appendAssistantMessage(llmRes.blocks, llmRes.inputTokens, llmRes.outputTokens);
        }
        LexiHarnessService.bumpRevision();

        if (llmRes.interrupted || LexiHarnessService.abortRequested) {
          session.appendLifecycle('step/end', turnNumber, step, 'aborted');
          session.appendLifecycle('turn/end', turnNumber, step, 'aborted');
          break;
        }

        const toolCallBlocks = llmRes.blocks.filter((b: LexiHarnessContentBlock): boolean => b.blockType === 'tool-call');
        if (toolCallBlocks.length === 0) {
          session.appendLifecycle('step/end', turnNumber, step, 'completed');
          session.appendLifecycle('turn/end', turnNumber, step, 'completed');
          break;
        }

        // Execute tool batch in deterministic order
        for (let t = 0; t < toolCallBlocks.length; t++) {
          if (LexiHarnessService.abortRequested) { break; }
          const call = toolCallBlocks[t];
          const callSummary = LexiHarnessTools.presentCallSummary(call.toolName, call.toolArguments);
          session.appendToolCall(call.toolCallId, call.toolName, call.toolArguments, callSummary[0], callSummary[1]);
          LexiHarnessService.bumpRevision();

          const toolOut = await LexiHarnessTools.executeTool(
            context,
            call.toolName,
            call.toolArguments,
            LexiHarnessService.skills,
            LexiHarnessService.activeEditorNoteId,
            (todos: LexiHarnessTodoItem[]): void => {
              session.setTodos(todos);
              LexiHarnessService.bumpRevision();
            },
            (req: LexiHarnessUiActionRequest): void => {
              LexiHarnessService.dispatchUiAction(req);
            }
          );

          session.appendToolResult(
            call.toolCallId,
            call.toolName,
            toolOut.contentText,
            toolOut.isError,
            toolOut.title,
            toolOut.subtitle,
            toolOut.preview
          );
          LexiHarnessService.bumpRevision();
        }

        session.appendLifecycle('step/end', turnNumber, step, 'tool-calls');
        await LexiHarnessService.persistSessions();
      }
    } finally {
      LexiHarnessService.runningTurn = false;
      LexiHarnessService.liveText = '';
      LexiHarnessService.liveReasoning = '';
      await LexiHarnessService.persistSessions();
      LexiHarnessService.bumpRevision();
      if (LexiHarnessService.config.apiKey.trim().length > 0) {
        LexiHarnessService.refreshBalance();
      }
    }
  }
}
