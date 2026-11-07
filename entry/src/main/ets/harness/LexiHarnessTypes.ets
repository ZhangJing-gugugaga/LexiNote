export class LexiHarnessContentBlock {
  blockType: string = 'text'; // 'text' | 'reasoning' | 'tool-call'
  text: string = '';
  signature: string = '';
  toolCallId: string = '';
  toolName: string = '';
  toolArguments: string = '{}';

  static textBlock(text: string): LexiHarnessContentBlock {
    const block = new LexiHarnessContentBlock();
    block.blockType = 'text';
    block.text = text;
    return block;
  }

  static reasoningBlock(text: string, signature: string = ''): LexiHarnessContentBlock {
    const block = new LexiHarnessContentBlock();
    block.blockType = 'reasoning';
    block.text = text;
    block.signature = signature;
    return block;
  }

  static toolCallBlock(id: string, name: string, argsJson: string): LexiHarnessContentBlock {
    const block = new LexiHarnessContentBlock();
    block.blockType = 'tool-call';
    block.toolCallId = id;
    block.toolName = name;
    block.toolArguments = argsJson || '{}';
    return block;
  }
}

export class LexiHarnessNoteRef {
  id: string = '';
  title: string = '';
  kind: string = 'note'; // 'note' | 'folder' | 'mindmap' | 'canvas'

  constructor(id: string = '', title: string = '', kind: string = 'note') {
    this.id = id;
    this.title = title;
    this.kind = kind;
  }
}

export class LexiHarnessMessageSource {
  kind: string = 'user'; // 'user' | 'runtime-context' | 'skill-catalog' | 'skill-invocation' | 'agent-instructions'
  skillName: string = '';
  summary: string = '';
  refs: LexiHarnessNoteRef[] = [];
}

export class LexiHarnessMessage {
  role: string = 'user'; // 'system' | 'user' | 'assistant' | 'tool'
  content: LexiHarnessContentBlock[] = [];
  toolCallId: string = '';
  toolName: string = '';
  isError: boolean = false;
  source: LexiHarnessMessageSource = new LexiHarnessMessageSource();
}

export class LexiHarnessSurfaceOp {
  kind: string = 'append'; // 'append' | 'replace' | 'none'
  startSeq: number = 0;
  endSeq: number = 0;

  static append(): LexiHarnessSurfaceOp {
    const op = new LexiHarnessSurfaceOp();
    op.kind = 'append';
    return op;
  }

  static none(): LexiHarnessSurfaceOp {
    const op = new LexiHarnessSurfaceOp();
    op.kind = 'none';
    return op;
  }

  static replace(startSeq: number, endSeq: number): LexiHarnessSurfaceOp {
    const op = new LexiHarnessSurfaceOp();
    op.kind = 'replace';
    op.startSeq = startSeq;
    op.endSeq = endSeq;
    return op;
  }
}

export class LexiHarnessSessionEvent {
  seq: number = 0;
  timestamp: number = 0;
  eventType: string = 'user/message'; // 'system/message' | 'user/message' | 'assistant/message' | 'tool/call' | 'tool/result' | 'turn/start' | 'turn/end' | 'step/start' | 'step/end'
  surfaceOp: LexiHarnessSurfaceOp = LexiHarnessSurfaceOp.append();
  message: LexiHarnessMessage = new LexiHarnessMessage();
  toolTitle: string = '';
  toolSubtitle: string = '';
  toolOutputPreview: string = '';
  turn: number = 0;
  step: number = 0;
  reason: string = '';
  inputTokens: number = 0;
  outputTokens: number = 0;
}

export class LexiHarnessTodoItem {
  id: string = '';
  content: string = '';
  status: string = 'pending'; // 'pending' | 'in_progress' | 'completed'

  constructor(id: string = '', content: string = '', status: string = 'pending') {
    this.id = id;
    this.content = content;
    this.status = status;
  }
}

export class LexiHarnessSessionRecord {
  id: string = '';
  title: string = '新会话';
  createdAt: number = 0;
  updatedAt: number = 0;
  events: LexiHarnessSessionEvent[] = [];
  todos: LexiHarnessTodoItem[] = [];
  lastCatalogDigest: string = '';
  lastRuntimeDigest: string = '';
}

export class LexiHarnessModelProfile {
  id: string = '';
  label: string = '';
  provider: string = 'deepseek-openai'; // 'deepseek-openai' | 'deepseek-anthropic' | 'openai-compatible' | 'anthropic-compatible'
  baseUrl: string = 'https://api.deepseek.com';
  apiKey: string = '';
  model: string = 'deepseek-chat';
  reasoningEffort: string = 'medium'; // 'off' | 'low' | 'medium' | 'high'

  constructor(
    id: string = '',
    label: string = '',
    provider: string = 'deepseek-openai',
    baseUrl: string = 'https://api.deepseek.com',
    apiKey: string = '',
    model: string = 'deepseek-chat',
    reasoningEffort: string = 'medium'
  ) {
    this.id = id;
    this.label = label;
    this.provider = provider;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }
}

export class LexiHarnessConfig {
  provider: string = 'deepseek-openai'; // 'deepseek-openai' | 'deepseek-anthropic' | 'openai-compatible' | 'anthropic-compatible'
  apiKey: string = '';
  baseUrl: string = 'https://api.deepseek.com';
  model: string = 'deepseek-chat';
  reasoningEffort: string = 'medium'; // 'off' | 'low' | 'medium' | 'high'
  maxTokens: number = 8192;
  temperature: number = 0.3;
  enableLocalFallback: boolean = true;
  activeModelId: string = '';
  models: LexiHarnessModelProfile[] = [];
}

export class LexiHarnessStreamChunk {
  chunkType: string = 'text-delta'; // 'block-start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish'
  blockIndex: number = 0;
  blockType: string = 'text'; // 'text' | 'reasoning' | 'tool-call'
  textDelta: string = '';
  signature: string = '';
  toolId: string = '';
  toolName: string = '';
  argumentsDelta: string = '';
  finishReason: string = 'stop'; // 'stop' | 'tool-calls' | 'max-tokens' | 'error'
  inputTokens: number = 0;
  outputTokens: number = 0;
}

export class LexiHarnessSkillDefinition {
  name: string = '';
  description: string = '';
  whenToUse: string = '';
  content: string = '';
  baseDir: string = '';
  modelInvocable: boolean = true;
  userInvocable: boolean = true;
  sourceRank: number = 600;
  sourceLabel: string = '内置';
}

export class LexiHarnessToolParamProp {
  propName: string = '';
  propType: string = 'string'; // 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string = '';
  required: boolean = false;
  enumValues: string[] = [];

  constructor(propName: string, propType: string, description: string, required: boolean = false, enumValues: string[] = []) {
    this.propName = propName;
    this.propType = propType;
    this.description = description;
    this.required = required;
    this.enumValues = enumValues;
  }
}

export class LexiHarnessToolExecutionOutput {
  contentText: string = '';
  title: string = '';
  subtitle: string = '';
  preview: string = '';
  isError: boolean = false;
  openedNoteId: string = '';
}

export class LexiHarnessUiToolRow {
  callId: string = '';
  toolName: string = '';
  title: string = '';
  subtitle: string = '';
  argsJson: string = '';
  outputPreview: string = '';
  fullOutput: string = '';
  status: string = 'running'; // 'running' | 'completed' | 'error'
}

export class LexiHarnessUiItem {
  id: string = '';
  seq: number = 0;
  itemKind: string = 'user'; // 'user' | 'assistant' | 'tool' | 'skill'
  text: string = '';
  reasoning: string = '';
  skillName: string = '';
  refs: LexiHarnessNoteRef[] = [];
  toolRow: LexiHarnessUiToolRow = new LexiHarnessUiToolRow();
  timestamp: number = 0;
  streaming: boolean = false;
}
