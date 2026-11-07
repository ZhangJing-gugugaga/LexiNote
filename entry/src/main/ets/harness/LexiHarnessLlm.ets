import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import {
  LexiHarnessConfig,
  LexiHarnessContentBlock,
  LexiHarnessMessage,
  LexiHarnessStreamChunk,
  LexiHarnessToolParamProp
} from './LexiHarnessTypes';
import { LexiBlockAssembler } from './LexiHarnessSession';
import { LexiHarnessToolSchema } from './LexiHarnessTools';

export class LexiHarnessLlmResult {
  blocks: LexiHarnessContentBlock[] = [];
  inputTokens: number = 0;
  outputTokens: number = 0;
  interrupted: boolean = false;
  errorMessage: string = '';
}

export class LexiHarnessLlm {
  private static activeRequest: http.HttpRequest | undefined = undefined;
  private static aborted: boolean = false;

  static abortActiveStream(): void {
    LexiHarnessLlm.aborted = true;
    if (LexiHarnessLlm.activeRequest) {
      try {
        LexiHarnessLlm.activeRequest.destroy();
      } catch {}
      LexiHarnessLlm.activeRequest = undefined;
    }
  }

  private static isAnthropicWire(config: LexiHarnessConfig): boolean {
    if (config.provider === 'deepseek-anthropic' || config.provider === 'anthropic-compatible') {
      return true;
    }
    const url = config.baseUrl.toLowerCase();
    return url.includes('/anthropic') || url.endsWith('/v1/messages');
  }

  private static resolveEndpointUrl(config: LexiHarnessConfig): string {
    const base = (config.baseUrl.trim() || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (LexiHarnessLlm.isAnthropicWire(config)) {
      if (base.endsWith('/v1/messages')) { return base; }
      if (base.endsWith('/v1')) { return `${base}/messages`; }
      return `${base}/v1/messages`;
    }
    if (base.endsWith('/chat/completions')) { return base; }
    if (base.endsWith('/v1')) { return `${base}/chat/completions`; }
    return `${base}/v1/chat/completions`;
  }

  private static buildToolJsonSchema(props: LexiHarnessToolParamProp[]): Record<string, Object> {
    const properties: Record<string, Object> = {};
    const requiredList: string[] = [];
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      const fieldObj: Record<string, Object> = {
        'type': p.propType,
        'description': p.description
      };
      if (p.enumValues && p.enumValues.length > 0) {
        fieldObj['enum'] = p.enumValues;
      }
      properties[p.propName] = fieldObj;
      if (p.required) {
        requiredList.push(p.propName);
      }
    }
    return {
      'type': 'object',
      'properties': properties,
      'required': requiredList
    };
  }

  private static buildOpenAiPayload(
    config: LexiHarnessConfig,
    messages: LexiHarnessMessage[],
    tools: LexiHarnessToolSchema[]
  ): string {
    const wireMessages: Record<string, Object>[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') {
        const text = msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n\n');
        if (text.trim()) {
          wireMessages.push({ 'role': 'system', 'content': text });
        }
      } else if (msg.role === 'user') {
        const text = msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n\n');
        if (text.trim()) {
          wireMessages.push({ 'role': 'user', 'content': text });
        }
      } else if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        const toolCalls: Record<string, Object>[] = [];
        for (let b = 0; b < msg.content.length; b++) {
          const block = msg.content[b];
          if (block.blockType === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.blockType === 'reasoning' && block.text) {
            reasoningParts.push(block.text);
          } else if (block.blockType === 'tool-call' && block.toolName) {
            const fnObj: Record<string, Object> = {
              'name': block.toolName,
              'arguments': block.toolArguments || '{}'
            };
            toolCalls.push({
              'id': block.toolCallId || `call_${i}_${b}`,
              'type': 'function',
              'function': fnObj
            });
          }
        }
        const assistantObj: Record<string, Object> = {
          'role': 'assistant',
          'content': textParts.length > 0 ? textParts.join('\n') : ''
        };
        if (reasoningParts.length > 0) {
          assistantObj['reasoning_content'] = reasoningParts.join('\n');
        }
        if (toolCalls.length > 0) {
          assistantObj['tool_calls'] = toolCalls;
        }
        wireMessages.push(assistantObj);
      } else if (msg.role === 'tool') {
        const text = msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n');
        wireMessages.push({
          'role': 'tool',
          'tool_call_id': msg.toolCallId,
          'content': text || 'Done'
        });
      }
    }

    const wireTools: Record<string, Object>[] = tools.map((t: LexiHarnessToolSchema): Record<string, Object> => {
      const fnDef: Record<string, Object> = {
        'name': t.name,
        'description': t.description,
        'parameters': LexiHarnessLlm.buildToolJsonSchema(t.props)
      };
      const toolDef: Record<string, Object> = {
        'type': 'function',
        'function': fnDef
      };
      return toolDef;
    });

    const payload: Record<string, Object> = {
      'model': config.model.trim() || 'deepseek-chat',
      'messages': wireMessages,
      'stream': true,
      'max_tokens': Math.max(512, Math.min(32768, config.maxTokens || 8192))
    };
    if (!config.model.includes('reasoner')) {
      payload['temperature'] = config.temperature;
    }
    if (wireTools.length > 0) {
      payload['tools'] = wireTools;
    }
    return JSON.stringify(payload);
  }

  private static buildAnthropicPayload(
    config: LexiHarnessConfig,
    messages: LexiHarnessMessage[],
    tools: LexiHarnessToolSchema[]
  ): string {
    const systemParts: string[] = [];
    const wireMessages: Record<string, Object>[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') {
        const text = msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n\n').trim();
        if (text) { systemParts.push(text); }
        continue;
      }
      if (msg.role === 'assistant') {
        const blocks: Record<string, Object>[] = [];
        for (let b = 0; b < msg.content.length; b++) {
          const block = msg.content[b];
          if (block.blockType === 'reasoning' && block.text) {
            const tb: Record<string, Object> = { 'type': 'thinking', 'thinking': block.text };
            if (block.signature) { tb['signature'] = block.signature; }
            blocks.push(tb);
          } else if (block.blockType === 'text' && block.text) {
            blocks.push({ 'type': 'text', 'text': block.text });
          } else if (block.blockType === 'tool-call' && block.toolName) {
            let inputObj: Record<string, Object> = {};
            try { inputObj = JSON.parse(block.toolArguments || '{}') as Record<string, Object>; } catch {}
            blocks.push({
              'type': 'tool_use',
              'id': block.toolCallId || `toolu_${i}_${b}`,
              'name': block.toolName,
              'input': inputObj
            });
          }
        }
        if (blocks.length > 0) {
          wireMessages.push({ 'role': 'assistant', 'content': blocks });
        }
      } else if (msg.role === 'tool' || msg.role === 'user') {
        const blockObj: Record<string, Object> = msg.role === 'tool'
          ? {
              'type': 'tool_result',
              'tool_use_id': msg.toolCallId,
              'content': msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n') || 'OK',
              'is_error': msg.isError
            }
          : {
              'type': 'text',
              'text': msg.content.map((b: LexiHarnessContentBlock): string => b.text).join('\n\n')
            };
        // Merge consecutive user/tool_result messages with tool_result blocks first (per deepseek-harness serialize.ts)
        const prev = wireMessages.length > 0 ? wireMessages[wireMessages.length - 1] : undefined;
        if (prev && prev['role'] === 'user' && Array.isArray(prev['content'])) {
          const prevList = prev['content'] as Record<string, Object>[];
          if (msg.role === 'tool') {
            const firstNonTool = prevList.findIndex((item: Record<string, Object>): boolean => item['type'] !== 'tool_result');
            if (firstNonTool >= 0) {
              prevList.splice(firstNonTool, 0, blockObj);
            } else {
              prevList.push(blockObj);
            }
          } else {
            prevList.push(blockObj);
          }
        } else {
          wireMessages.push({ 'role': 'user', 'content': [blockObj] });
        }
      }
    }

    const wireTools: Record<string, Object>[] = tools.map((t: LexiHarnessToolSchema): Record<string, Object> => ({
      'name': t.name,
      'description': t.description,
      'input_schema': LexiHarnessLlm.buildToolJsonSchema(t.props)
    }));

    const payload: Record<string, Object> = {
      'model': config.model.trim() || 'deepseek-flash',
      'max_tokens': Math.max(1024, Math.min(64000, config.maxTokens || 8192)),
      'stream': true,
      'messages': wireMessages
    };
    if (systemParts.length > 0) {
      payload['system'] = systemParts.join('\n\n');
    }
    if (wireTools.length > 0) {
      payload['tools'] = wireTools;
    }
    if (config.reasoningEffort !== 'off') {
      const thinkingCfg: Record<string, Object> = { 'type': 'enabled' };
      payload['thinking'] = thinkingCfg;
    }
    return JSON.stringify(payload);
  }

  private static handleOpenAiSseData(dataLine: string, assembler: LexiBlockAssembler): void {
    if (!dataLine || dataLine === '[DONE]') {
      const done = new LexiHarnessStreamChunk();
      done.chunkType = 'finish';
      done.finishReason = 'stop';
      assembler.feed(done);
      return;
    }
    try {
      const parsed = JSON.parse(dataLine) as Record<string, Object>;
      const usageObj = parsed['usage'] as Record<string, Object> | undefined;
      if (usageObj) {
        const uChunk = new LexiHarnessStreamChunk();
        uChunk.chunkType = 'usage';
        uChunk.inputTokens = Number(usageObj['prompt_tokens'] ?? 0);
        uChunk.outputTokens = Number(usageObj['completion_tokens'] ?? 0);
        assembler.feed(uChunk);
      }
      const choices = parsed['choices'] as Record<string, Object>[] | undefined;
      if (!Array.isArray(choices) || choices.length === 0) {
        return;
      }
      const choice = choices[0];
      const delta = (choice['delta'] ?? choice['message']) as Record<string, Object> | undefined;
      if (delta) {
        const reasoningDelta = delta['reasoning_content'] as string | undefined;
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          const rChunk = new LexiHarnessStreamChunk();
          rChunk.chunkType = 'reasoning-delta';
          rChunk.blockIndex = 0;
          rChunk.blockType = 'reasoning';
          rChunk.textDelta = reasoningDelta;
          assembler.feed(rChunk);
        }
        const contentDelta = delta['content'] as string | undefined;
        if (typeof contentDelta === 'string' && contentDelta.length > 0) {
          const tChunk = new LexiHarnessStreamChunk();
          tChunk.chunkType = 'text-delta';
          tChunk.blockIndex = 1;
          tChunk.blockType = 'text';
          tChunk.textDelta = contentDelta;
          assembler.feed(tChunk);
        }
        const toolCalls = delta['tool_calls'] as Record<string, Object>[] | undefined;
        if (Array.isArray(toolCalls)) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const tcIdx = Number(tc['index'] ?? i);
            const blockIdx = 10 + tcIdx;
            const fnObj = tc['function'] as Record<string, Object> | undefined;
            const tcChunk = new LexiHarnessStreamChunk();
            tcChunk.chunkType = 'tool-call-delta';
            tcChunk.blockIndex = blockIdx;
            tcChunk.blockType = 'tool-call';
            tcChunk.toolId = typeof tc['id'] === 'string' ? (tc['id'] as string) : '';
            tcChunk.toolName = fnObj && typeof fnObj['name'] === 'string' ? (fnObj['name'] as string) : '';
            tcChunk.argumentsDelta = fnObj && typeof fnObj['arguments'] === 'string' ? (fnObj['arguments'] as string) : '';
            assembler.feed(tcChunk);
          }
        }
      }
      const finishReason = choice['finish_reason'] as string | undefined;
      if (typeof finishReason === 'string' && finishReason.length > 0) {
        for (let b = 0; b < 25; b++) {
          const endChunk = new LexiHarnessStreamChunk();
          endChunk.chunkType = 'block-end';
          endChunk.blockIndex = b;
          assembler.feed(endChunk);
        }
        const fChunk = new LexiHarnessStreamChunk();
        fChunk.chunkType = 'finish';
        fChunk.finishReason = finishReason === 'length' ? 'max-tokens' : finishReason;
        assembler.feed(fChunk);
      }
    } catch {
      // Ignore partial JSON frame
    }
  }

  private static handleAnthropicSseData(dataLine: string, assembler: LexiBlockAssembler): void {
    if (!dataLine || dataLine === '[DONE]') { return; }
    try {
      const parsed = JSON.parse(dataLine) as Record<string, Object>;
      const evType = parsed['type'] as string | undefined;
      if (evType === 'content_block_start') {
        const index = Number(parsed['index'] ?? 0);
        const cb = parsed['content_block'] as Record<string, Object> | undefined;
        if (cb) {
          const cbType = cb['type'] as string | undefined;
          const chunk = new LexiHarnessStreamChunk();
          chunk.chunkType = 'block-start';
          chunk.blockIndex = index;
          if (cbType === 'thinking') {
            chunk.blockType = 'reasoning';
            chunk.textDelta = typeof cb['thinking'] === 'string' ? (cb['thinking'] as string) : '';
          } else if (cbType === 'tool_use') {
            chunk.blockType = 'tool-call';
            chunk.toolId = typeof cb['id'] === 'string' ? (cb['id'] as string) : '';
            chunk.toolName = typeof cb['name'] === 'string' ? (cb['name'] as string) : '';
          } else {
            chunk.blockType = 'text';
            chunk.textDelta = typeof cb['text'] === 'string' ? (cb['text'] as string) : '';
          }
          assembler.feed(chunk);
          if (chunk.textDelta) {
            const deltaChunk = new LexiHarnessStreamChunk();
            deltaChunk.chunkType = chunk.blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta';
            deltaChunk.blockIndex = index;
            deltaChunk.blockType = chunk.blockType;
            deltaChunk.textDelta = chunk.textDelta;
            assembler.feed(deltaChunk);
          }
        }
      } else if (evType === 'content_block_delta') {
        const index = Number(parsed['index'] ?? 0);
        const delta = parsed['delta'] as Record<string, Object> | undefined;
        if (delta) {
          const dType = delta['type'] as string | undefined;
          if (dType === 'text_delta') {
            const c = new LexiHarnessStreamChunk();
            c.chunkType = 'text-delta';
            c.blockIndex = index;
            c.blockType = 'text';
            c.textDelta = typeof delta['text'] === 'string' ? (delta['text'] as string) : '';
            assembler.feed(c);
          } else if (dType === 'thinking_delta') {
            const c = new LexiHarnessStreamChunk();
            c.chunkType = 'reasoning-delta';
            c.blockIndex = index;
            c.blockType = 'reasoning';
            c.textDelta = typeof delta['thinking'] === 'string' ? (delta['thinking'] as string) : '';
            assembler.feed(c);
          } else if (dType === 'signature_delta') {
            const c = new LexiHarnessStreamChunk();
            c.chunkType = 'reasoning-delta';
            c.blockIndex = index;
            c.blockType = 'reasoning';
            c.signature = typeof delta['signature'] === 'string' ? (delta['signature'] as string) : '';
            assembler.feed(c);
          } else if (dType === 'input_json_delta') {
            const c = new LexiHarnessStreamChunk();
            c.chunkType = 'tool-call-delta';
            c.blockIndex = index;
            c.blockType = 'tool-call';
            c.argumentsDelta = typeof delta['partial_json'] === 'string' ? (delta['partial_json'] as string) : '';
            assembler.feed(c);
          }
        }
      } else if (evType === 'content_block_stop') {
        const index = Number(parsed['index'] ?? 0);
        const c = new LexiHarnessStreamChunk();
        c.chunkType = 'block-end';
        c.blockIndex = index;
        assembler.feed(c);
      } else if (evType === 'message_delta') {
        const delta = parsed['delta'] as Record<string, Object> | undefined;
        const stopReason = delta && typeof delta['stop_reason'] === 'string' ? (delta['stop_reason'] as string) : 'stop';
        const c = new LexiHarnessStreamChunk();
        c.chunkType = 'finish';
        c.finishReason = stopReason === 'max_tokens' ? 'max-tokens' : stopReason;
        assembler.feed(c);
      }
    } catch {}
  }

  static async streamChat(
    config: LexiHarnessConfig,
    messages: LexiHarnessMessage[],
    tools: LexiHarnessToolSchema[],
    onProgress: (liveText: string, liveReasoning: string) => void
  ): Promise<LexiHarnessLlmResult> {
    const result = new LexiHarnessLlmResult();
    LexiHarnessLlm.aborted = false;
    const assembler = new LexiBlockAssembler();
    const isAnthropic = LexiHarnessLlm.isAnthropicWire(config);
    const url = LexiHarnessLlm.resolveEndpointUrl(config);
    const body = isAnthropic
      ? LexiHarnessLlm.buildAnthropicPayload(config, messages, tools)
      : LexiHarnessLlm.buildOpenAiPayload(config, messages, tools);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (isAnthropic) {
      headers['x-api-key'] = config.apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    const req = http.createHttp();
    LexiHarnessLlm.activeRequest = req;
    const decoder = new util.TextDecoder('utf-8');
    let sseBuffer = '';
    let rawResponseText = '';

    req.on('dataReceive', (data: ArrayBuffer) => {
      if (LexiHarnessLlm.aborted) { return; }
      const chunkText = decoder.decodeToString(new Uint8Array(data), { stream: true });
      rawResponseText += chunkText;
      sseBuffer += chunkText.replace(/\r\n/g, '\n');
      let newlineIdx = sseBuffer.indexOf('\n');
      while (newlineIdx >= 0) {
        const line = sseBuffer.substring(0, newlineIdx).trim();
        sseBuffer = sseBuffer.substring(newlineIdx + 1);
        if (line.startsWith('data:')) {
          const dataPayload = line.substring(5).trim();
          if (isAnthropic) {
            LexiHarnessLlm.handleAnthropicSseData(dataPayload, assembler);
          } else {
            LexiHarnessLlm.handleOpenAiSseData(dataPayload, assembler);
          }
          onProgress(assembler.liveText(), assembler.liveReasoning());
        }
        newlineIdx = sseBuffer.indexOf('\n');
      }
    });

    try {
      const statusCode = await req.requestInStream(url, {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: body,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 20000,
        readTimeout: 120000
      });

      if (sseBuffer.trim().startsWith('data:')) {
        const tailData = sseBuffer.trim().substring(5).trim();
        if (isAnthropic) {
          LexiHarnessLlm.handleAnthropicSseData(tailData, assembler);
        } else {
          LexiHarnessLlm.handleOpenAiSseData(tailData, assembler);
        }
      }

      if (statusCode >= 400) {
        let errDetail = rawResponseText.trim().slice(0, 300);
        try {
          const parsedErr = JSON.parse(rawResponseText) as Record<string, Object>;
          const errObj = parsedErr['error'] as Record<string, Object> | undefined;
          if (errObj && typeof errObj['message'] === 'string') {
            errDetail = errObj['message'] as string;
          }
        } catch {}
        result.errorMessage = `模型接口返回 HTTP ${statusCode}: ${errDetail || '请检查 API Key、Base URL 与模型名称设置'}`;
        return result;
      }

      // If endpoint returned non-SSE single JSON body, parse it as fallback
      let blocks = assembler.blocks(LexiHarnessLlm.aborted);
      if (blocks.length === 0 && rawResponseText.trim().startsWith('{')) {
        LexiHarnessLlm.handleOpenAiSseData(rawResponseText.trim(), assembler);
        blocks = assembler.blocks(LexiHarnessLlm.aborted);
      }

      result.blocks = blocks;
      result.inputTokens = assembler.inputTokens;
      result.outputTokens = assembler.outputTokens;
      result.interrupted = LexiHarnessLlm.aborted;
      return result;
    } catch (error) {
      if (LexiHarnessLlm.aborted) {
        result.blocks = assembler.blocks(true);
        result.interrupted = true;
        return result;
      }
      result.errorMessage = `网络请求异常: ${(error as Error).message || '无法连接到大模型网关'}`;
      return result;
    } finally {
      try { req.off('dataReceive'); } catch {}
      try { req.destroy(); } catch {}
      if (LexiHarnessLlm.activeRequest === req) {
        LexiHarnessLlm.activeRequest = undefined;
      }
    }
  }

  static async fetchBalance(config: LexiHarnessConfig): Promise<string> {
    const apiKey = config.apiKey.trim();
    if (!apiKey) {
      return '未配置密钥';
    }
    let rootUrl = (config.baseUrl.trim() || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (rootUrl.endsWith('/anthropic')) {
      rootUrl = rootUrl.substring(0, rootUrl.length - 10);
    }
    if (rootUrl.endsWith('/v1')) {
      rootUrl = rootUrl.substring(0, rootUrl.length - 3);
    }
    const balanceUrl = `${rootUrl}/user/balance`;
    const req = http.createHttp();
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
    try {
      const resp = await req.request(balanceUrl, {
        method: http.RequestMethod.GET,
        header: headers,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 10000
      });
      if (resp.responseCode >= 200 && resp.responseCode < 300 && typeof resp.result === 'string') {
        const parsed = JSON.parse(resp.result) as Record<string, Object>;
        const infos = parsed['balance_infos'] as Record<string, Object>[] | undefined;
        if (Array.isArray(infos) && infos.length > 0) {
          const info = infos[0];
          const currency = String(info['currency'] ?? 'CNY');
          const total = String(info['total_balance'] ?? '0.00');
          const symbol = currency === 'USD' ? '$' : '¥';
          return `${symbol}${total}`;
        }
        if (parsed['total_available'] !== undefined) {
          return `$${String(parsed['total_available'])}`;
        }
      }
      return '接口不支持余额查询';
    } catch {
      return '余额查询失败';
    } finally {
      try { req.destroy(); } catch {}
    }
  }
}
