import {
  LexiHarnessContentBlock,
  LexiHarnessMessage,
  LexiHarnessMessageSource,
  LexiHarnessNoteRef,
  LexiHarnessSessionEvent,
  LexiHarnessSessionRecord,
  LexiHarnessStreamChunk,
  LexiHarnessSurfaceOp,
  LexiHarnessTodoItem,
  LexiHarnessUiItem,
  LexiHarnessUiToolRow
} from './LexiHarnessTypes';

class LexiAssemblerSlot {
  blockIndex: number = 0;
  blockType: string = 'text';
  text: string = '';
  signature: string = '';
  toolCallId: string = '';
  toolName: string = '';
  toolArguments: string = '';
  closed: boolean = false;
}

export class LexiBlockAssembler {
  private slots: Map<number, LexiAssemblerSlot> = new Map<number, LexiAssemblerSlot>();
  private finishReason: string = 'stop';
  inputTokens: number = 0;
  outputTokens: number = 0;

  feed(chunk: LexiHarnessStreamChunk): void {
    if (chunk.chunkType === 'usage') {
      if (chunk.inputTokens > 0) { this.inputTokens = chunk.inputTokens; }
      if (chunk.outputTokens > 0) { this.outputTokens = chunk.outputTokens; }
      return;
    }
    if (chunk.chunkType === 'finish') {
      this.finishReason = chunk.finishReason || 'stop';
      if (chunk.inputTokens > 0) { this.inputTokens = chunk.inputTokens; }
      if (chunk.outputTokens > 0) { this.outputTokens = chunk.outputTokens; }
      return;
    }
    const idx = chunk.blockIndex;
    let slot = this.slots.get(idx);
    if (!slot) {
      slot = new LexiAssemblerSlot();
      slot.blockIndex = idx;
      slot.blockType = chunk.blockType || (chunk.chunkType === 'reasoning-delta' ? 'reasoning' :
        chunk.chunkType === 'tool-call-delta' ? 'tool-call' : 'text');
      this.slots.set(idx, slot);
    }
    if (chunk.chunkType === 'block-start') {
      slot.blockType = chunk.blockType || slot.blockType;
      if (chunk.toolId) { slot.toolCallId = chunk.toolId; }
      if (chunk.toolName) { slot.toolName = chunk.toolName; }
    } else if (chunk.chunkType === 'text-delta') {
      slot.blockType = 'text';
      slot.text += chunk.textDelta;
    } else if (chunk.chunkType === 'reasoning-delta') {
      slot.blockType = 'reasoning';
      slot.text += chunk.textDelta;
      if (chunk.signature) { slot.signature = chunk.signature; }
    } else if (chunk.chunkType === 'tool-call-delta') {
      slot.blockType = 'tool-call';
      if (chunk.toolId) { slot.toolCallId = chunk.toolId; }
      if (chunk.toolName) { slot.toolName = chunk.toolName; }
      slot.toolArguments += chunk.argumentsDelta;
    } else if (chunk.chunkType === 'block-end') {
      slot.closed = true;
      if (chunk.signature) { slot.signature = chunk.signature; }
    }
  }

  liveReasoning(): string {
    const indices: number[] = Array.from(this.slots.keys()).sort((a: number, b: number): number => a - b);
    let out = '';
    for (let i = 0; i < indices.length; i++) {
      const slot = this.slots.get(indices[i]);
      if (slot && slot.blockType === 'reasoning') {
        out += slot.text;
      }
    }
    return out;
  }

  liveText(): string {
    const indices: number[] = Array.from(this.slots.keys()).sort((a: number, b: number): number => a - b);
    let out = '';
    for (let i = 0; i < indices.length; i++) {
      const slot = this.slots.get(indices[i]);
      if (slot && slot.blockType === 'text') {
        out += slot.text;
      }
    }
    return out;
  }

  blocks(interrupted: boolean = false): LexiHarnessContentBlock[] {
    const indices: number[] = Array.from(this.slots.keys()).sort((a: number, b: number): number => a - b);
    const result: LexiHarnessContentBlock[] = [];
    const dropTruncatedTools = interrupted || this.finishReason === 'max-tokens';
    for (let i = 0; i < indices.length; i++) {
      const slot = this.slots.get(indices[i]);
      if (!slot) { continue; }
      if (slot.blockType === 'reasoning') {
        if (slot.text.trim().length > 0) {
          result.push(LexiHarnessContentBlock.reasoningBlock(slot.text, slot.signature));
        }
      } else if (slot.blockType === 'text') {
        if (slot.text.length > 0) {
          result.push(LexiHarnessContentBlock.textBlock(slot.text));
        }
      } else if (slot.blockType === 'tool-call') {
        if (dropTruncatedTools && !slot.closed) {
          continue;
        }
        if (slot.toolName.trim().length > 0) {
          const callId = slot.toolCallId || `call_${Date.now()}_${i}`;
          const args = slot.toolArguments.trim() || '{}';
          result.push(LexiHarnessContentBlock.toolCallBlock(callId, slot.toolName.trim(), args));
        }
      }
    }
    return result;
  }
}

export class LexiHarnessSession {
  record: LexiHarnessSessionRecord = new LexiHarnessSessionRecord();

  constructor(record?: LexiHarnessSessionRecord) {
    if (record) {
      this.record = record;
    } else {
      this.record.id = `session-${Date.now()}`;
      this.record.title = '新对话';
      this.record.createdAt = Date.now();
      this.record.updatedAt = Date.now();
    }
  }

  private nextSeq(): number {
    if (this.record.events.length === 0) { return 1; }
    return this.record.events[this.record.events.length - 1].seq + 1;
  }

  private static isSurfaceEvent(eventType: string): boolean {
    return eventType === 'system/message' ||
      eventType === 'user/message' ||
      eventType === 'assistant/message' ||
      eventType === 'tool/result';
  }

  appendSystemMessage(text: string): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = 'system/message';
    const existingSystem = this.record.events.find((item: LexiHarnessSessionEvent): boolean => item.eventType === 'system/message');
    ev.surfaceOp = existingSystem ? LexiHarnessSurfaceOp.replace(existingSystem.seq, existingSystem.seq) : LexiHarnessSurfaceOp.append();
    ev.message = new LexiHarnessMessage();
    ev.message.role = 'system';
    ev.message.content = [LexiHarnessContentBlock.textBlock(text)];
    this.record.events.push(ev);
    this.record.updatedAt = ev.timestamp;
    return ev;
  }

  appendUserMessage(text: string, sourceKind: string = 'user', refs: LexiHarnessNoteRef[] = [], skillName: string = ''): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = 'user/message';
    ev.surfaceOp = LexiHarnessSurfaceOp.append();
    ev.message = new LexiHarnessMessage();
    ev.message.role = 'user';
    ev.message.content = [LexiHarnessContentBlock.textBlock(text)];
    const src = new LexiHarnessMessageSource();
    src.kind = sourceKind;
    src.refs = refs;
    src.skillName = skillName;
    ev.message.source = src;
    this.record.events.push(ev);
    this.record.updatedAt = ev.timestamp;
    if (sourceKind === 'user' && (this.record.title === '新对话' || this.record.title === '新会话' || !this.record.title.trim())) {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean.length > 0) {
        this.record.title = clean.slice(0, 22);
      }
    }
    return ev;
  }

  appendAssistantMessage(blocks: LexiHarnessContentBlock[], inputTokens: number = 0, outputTokens: number = 0): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = 'assistant/message';
    ev.surfaceOp = LexiHarnessSurfaceOp.append();
    ev.message = new LexiHarnessMessage();
    ev.message.role = 'assistant';
    ev.message.content = blocks;
    ev.inputTokens = inputTokens;
    ev.outputTokens = outputTokens;
    this.record.events.push(ev);
    this.record.updatedAt = ev.timestamp;
    return ev;
  }

  appendToolCall(callId: string, toolName: string, argsJson: string, title: string, subtitle: string): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = 'tool/call';
    ev.surfaceOp = LexiHarnessSurfaceOp.none();
    ev.message = new LexiHarnessMessage();
    ev.message.role = 'assistant';
    ev.message.toolCallId = callId;
    ev.message.toolName = toolName;
    ev.message.content = [LexiHarnessContentBlock.toolCallBlock(callId, toolName, argsJson)];
    ev.toolTitle = title;
    ev.toolSubtitle = subtitle;
    this.record.events.push(ev);
    this.record.updatedAt = ev.timestamp;
    return ev;
  }

  appendToolResult(callId: string, toolName: string, contentText: string, isError: boolean, title: string, subtitle: string, preview: string): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = 'tool/result';
    ev.surfaceOp = LexiHarnessSurfaceOp.append();
    ev.message = new LexiHarnessMessage();
    ev.message.role = 'tool';
    ev.message.toolCallId = callId;
    ev.message.toolName = toolName;
    ev.message.isError = isError;
    ev.message.content = [LexiHarnessContentBlock.textBlock(contentText)];
    ev.toolTitle = title;
    ev.toolSubtitle = subtitle;
    ev.toolOutputPreview = preview;
    this.record.events.push(ev);
    this.record.updatedAt = ev.timestamp;
    return ev;
  }

  appendLifecycle(eventType: string, turn: number, step: number = 0, reason: string = ''): LexiHarnessSessionEvent {
    const ev = new LexiHarnessSessionEvent();
    ev.seq = this.nextSeq();
    ev.timestamp = Date.now();
    ev.eventType = eventType;
    ev.surfaceOp = LexiHarnessSurfaceOp.none();
    ev.turn = turn;
    ev.step = step;
    ev.reason = reason;
    this.record.events.push(ev);
    return ev;
  }

  surfaceNodes(): LexiHarnessSessionEvent[] {
    let nodes: LexiHarnessSessionEvent[] = [];
    for (let i = 0; i < this.record.events.length; i++) {
      const ev = this.record.events[i];
      if (!LexiHarnessSession.isSurfaceEvent(ev.eventType)) {
        continue;
      }
      if (ev.surfaceOp.kind === 'replace' && ev.surfaceOp.startSeq > 0) {
        const start = ev.surfaceOp.startSeq;
        const end = ev.surfaceOp.endSeq >= start ? ev.surfaceOp.endSeq : start;
        const nextNodes: LexiHarnessSessionEvent[] = [];
        let replaced = false;
        for (let j = 0; j < nodes.length; j++) {
          const n = nodes[j];
          if (n.seq >= start && n.seq <= end) {
            if (!replaced) {
              nextNodes.push(ev);
              replaced = true;
            }
          } else {
            nextNodes.push(n);
          }
        }
        if (!replaced) {
          nextNodes.push(ev);
        }
        nodes = nextNodes;
      } else if (ev.surfaceOp.kind !== 'none') {
        nodes.push(ev);
      }
    }
    return nodes;
  }

  deriveMessages(): LexiHarnessMessage[] {
    const surface = this.surfaceNodes();
    const messages: LexiHarnessMessage[] = [];
    for (let i = 0; i < surface.length; i++) {
      messages.push(surface[i].message);
    }
    return messages;
  }

  deriveUiItems(liveStreamingText: string = '', liveStreamingReasoning: string = '', isStreaming: boolean = false): LexiHarnessUiItem[] {
    const items: LexiHarnessUiItem[] = [];
    const toolMap: Map<string, LexiHarnessUiItem> = new Map<string, LexiHarnessUiItem>();
    for (let i = 0; i < this.record.events.length; i++) {
      const ev = this.record.events[i];
      if (ev.eventType === 'user/message') {
        const srcKind = ev.message.source ? ev.message.source.kind : 'user';
        if (srcKind === 'user') {
          const item = new LexiHarnessUiItem();
          item.id = `ui-user-${ev.seq}`;
          item.seq = ev.seq;
          item.itemKind = 'user';
          item.text = ev.message.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n');
          item.refs = ev.message.source.refs ? ev.message.source.refs.slice() : [];
          item.timestamp = ev.timestamp;
          items.push(item);
        } else if (srcKind === 'skill-invocation' && ev.message.source.skillName) {
          const item = new LexiHarnessUiItem();
          item.id = `ui-skill-${ev.seq}`;
          item.seq = ev.seq;
          item.itemKind = 'skill';
          item.skillName = ev.message.source.skillName;
          item.text = `已加载技能指令 · ${ev.message.source.skillName}`;
          item.timestamp = ev.timestamp;
          items.push(item);
        }
      } else if (ev.eventType === 'assistant/message') {
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        for (let b = 0; b < ev.message.content.length; b++) {
          const block = ev.message.content[b];
          if (block.blockType === 'text' && block.text.trim().length > 0) {
            textParts.push(block.text);
          } else if (block.blockType === 'reasoning' && block.text.trim().length > 0) {
            reasoningParts.push(block.text);
          }
        }
        if (textParts.length > 0 || reasoningParts.length > 0) {
          const item = new LexiHarnessUiItem();
          item.id = `ui-assistant-${ev.seq}`;
          item.seq = ev.seq;
          item.itemKind = 'assistant';
          item.text = textParts.join('\n\n');
          item.reasoning = reasoningParts.join('\n\n');
          item.timestamp = ev.timestamp;
          items.push(item);
        }
      } else if (ev.eventType === 'tool/call') {
        const callBlock = ev.message.content.length > 0 ? ev.message.content[0] : undefined;
        const callId = ev.message.toolCallId || (callBlock ? callBlock.toolCallId : `call_${ev.seq}`);
        const item = new LexiHarnessUiItem();
        item.id = `ui-tool-${ev.seq}-${callId}`;
        item.seq = ev.seq;
        item.itemKind = 'tool';
        item.timestamp = ev.timestamp;
        const row = new LexiHarnessUiToolRow();
        row.callId = callId;
        row.toolName = ev.message.toolName || (callBlock ? callBlock.toolName : 'tool');
        row.title = ev.toolTitle || row.toolName;
        row.subtitle = ev.toolSubtitle || '';
        row.argsJson = callBlock ? callBlock.toolArguments : '{}';
        row.status = 'running';
        item.toolRow = row;
        toolMap.set(callId, item);
        items.push(item);
      } else if (ev.eventType === 'tool/result') {
        const callId = ev.message.toolCallId;
        const fullText = ev.message.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n');
        const existing = toolMap.get(callId);
        if (existing) {
          existing.toolRow.status = ev.message.isError ? 'error' : 'completed';
          if (ev.toolTitle) { existing.toolRow.title = ev.toolTitle; }
          if (ev.toolSubtitle) { existing.toolRow.subtitle = ev.toolSubtitle; }
          existing.toolRow.outputPreview = ev.toolOutputPreview || fullText.slice(0, 160);
          existing.toolRow.fullOutput = fullText;
        } else {
          const item = new LexiHarnessUiItem();
          item.id = `ui-tool-res-${ev.seq}`;
          item.seq = ev.seq;
          item.itemKind = 'tool';
          item.timestamp = ev.timestamp;
          const row = new LexiHarnessUiToolRow();
          row.callId = callId;
          row.toolName = ev.message.toolName;
          row.title = ev.toolTitle || ev.message.toolName;
          row.subtitle = ev.toolSubtitle || '';
          row.status = ev.message.isError ? 'error' : 'completed';
          row.outputPreview = ev.toolOutputPreview || fullText.slice(0, 160);
          row.fullOutput = fullText;
          item.toolRow = row;
          items.push(item);
        }
      }
    }
    if (isStreaming && (liveStreamingText.length > 0 || liveStreamingReasoning.length > 0)) {
      const streamItem = new LexiHarnessUiItem();
      streamItem.id = 'ui-assistant-live-stream';
      streamItem.seq = 999999;
      streamItem.itemKind = 'assistant';
      streamItem.text = liveStreamingText;
      streamItem.reasoning = liveStreamingReasoning;
      streamItem.streaming = true;
      streamItem.timestamp = Date.now();
      items.push(streamItem);
    }
    return items;
  }

  setTodos(todos: LexiHarnessTodoItem[]): void {
    this.record.todos = todos;
    this.record.updatedAt = Date.now();
  }
}
