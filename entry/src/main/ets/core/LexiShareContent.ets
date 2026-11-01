import { url } from '@kit.ArkTS';

export class LexiShareRecord {
  utd: string = '';
  content: string = '';
  title: string = '';
  description: string = '';
  plainContent: string = '';
}

export class LexiShareDraft {
  captureId: string = '';
  receivedFingerprint: string = '';
  receivedAt: number = 0;
  title: string = '';
  sourceUrl: string = '';
  quote: string = '';
  notice: string = '';
}

/** Text-only clipping. No HTML renderer, attachment reads, or network requests are used. */
export class LexiShareContent {
  static readonly MAX_BYTES: number = 200 * 1024;
  static readonly MAX_QUOTE_BYTES: number = 100 * 1024;
  static readonly MAX_RECORDS: number = 32;

  static bytes(text: string): number {
    let size = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code <= 0x7f) { size++; }
      else if (code <= 0x7ff) { size += 2; }
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { size += 4; index++; }
      else { size += 3; }
    }
    return size;
  }

  static cleanText(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  }

  static safeUrl(raw: string): string {
    const clean = raw.trim();
    if (!clean) { return ''; }
    if (clean.length > 4096 || /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(clean) || !/^https?:\/\//i.test(clean)) {
      throw new Error('来源链接仅支持不含空白的 HTTP 或 HTTPS 地址');
    }
    let parsed: url.URL;
    try { parsed = url.URL.parseURL(clean); } catch { throw new Error('来源链接格式无效，请检查或清空链接'); }
    if (!parsed.hostname || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
      throw new Error('来源链接不能包含账号密码，且必须为 HTTP 或 HTTPS 地址');
    }
    return parsed.href;
  }

  private static scalar(code: number): string {
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }

  static decodeEntities(text: string): string {
    return text.replace(/&#x([0-9a-f]+);/gi, (_full: string, digits: string): string => LexiShareContent.scalar(parseInt(digits, 16)))
      .replace(/&#([0-9]+);/g, (_full: string, digits: string): string => LexiShareContent.scalar(parseInt(digits, 10)))
      .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }

  static htmlToText(html: string): string {
    if (LexiShareContent.bytes(html) > LexiShareContent.MAX_BYTES) { throw new Error('分享内容超过 200 KB，请缩小选中范围'); }
    const stripped = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|head)\b[^>]*>[\s\S]*$/gi, '')
      .replace(/<\s*(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|section|article)\s*>/gi, '\n')
      .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, '');
    return LexiShareContent.cleanText(LexiShareContent.decodeEntities(stripped).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'));
  }

  static fingerprint(text: string): string {
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < text.length; index++) {
      first = Math.imul(first ^ text.charCodeAt(index), 16777619);
      second = Math.imul(second ^ text.charCodeAt(index), 3266489917);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
  }

  static fromRecords(records: LexiShareRecord[], captureId: string, now: number): LexiShareDraft {
    if (!records.length || records.length > LexiShareContent.MAX_RECORDS) { throw new Error('一次最多接收 32 条文本或链接，请缩小分享范围'); }
    const draft = new LexiShareDraft(); draft.captureId = captureId; draft.receivedAt = now;
    const texts: string[] = [];
    let total = 0;
    for (const record of records) {
      if (typeof record.content !== 'string' || typeof record.title !== 'string' || typeof record.description !== 'string' || typeof record.plainContent !== 'string') {
        throw new Error('分享内容格式不正确');
      }
      total += LexiShareContent.bytes(record.content + record.title + record.description + record.plainContent);
      if (total > LexiShareContent.MAX_BYTES) { throw new Error('分享内容超过 200 KB，请缩小选中范围'); }
      const type = record.utd;
      if (!['general.text', 'general.plain-text', 'general.html', 'general.hyperlink'].includes(type)) {
        draft.notice = '已跳过不支持的附件，仅保留文本与网页链接。'; continue;
      }
      if (!draft.title && record.title.trim()) { draft.title = LexiShareContent.cleanText(record.title).replace(/\n/g, ' ').slice(0, 160); }
      if (type === 'general.hyperlink') {
        try {
          const source = LexiShareContent.safeUrl(record.content);
          if (!draft.sourceUrl) { draft.sourceUrl = source; }
          else if (source !== draft.sourceUrl && !texts.includes(source)) { texts.push(source); }
        } catch { draft.notice = '不安全或无效的来源链接已忽略，可在保存前重新填写。'; }
        const description = LexiShareContent.cleanText(record.description);
        if (description && description !== draft.title && !texts.includes(description)) { texts.push(description); }
      } else {
        const text = type === 'general.html' ? (record.plainContent ? LexiShareContent.cleanText(record.plainContent) : LexiShareContent.htmlToText(record.content)) : LexiShareContent.cleanText(record.content);
        if (text && !texts.includes(text)) {
          if (/^https?:\/\/[^\s]+$/i.test(text) && !draft.sourceUrl) {
            try { draft.sourceUrl = LexiShareContent.safeUrl(text); } catch { texts.push(text); }
          } else { texts.push(text); }
        }
      }
    }
    draft.quote = texts.join('\n\n');
    if (!draft.title) { draft.title = draft.quote.split('\n')[0].slice(0, 60) || '网页剪藏'; }
    draft.receivedFingerprint = LexiShareContent.fingerprint(`${draft.title}\n${draft.sourceUrl}\n${draft.quote}`);
    LexiShareContent.validate(draft);
    return draft;
  }

  static validate(draft: LexiShareDraft): void {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(draft.captureId) || !/^[a-f0-9]{16}-\d+$/.test(draft.receivedFingerprint)) { throw new Error('剪藏会话无效，请重新分享'); }
    if (draft.title.trim().length > 160 || /[\r\n\u0000-\u001f]/.test(draft.title)) { throw new Error('标题最多 160 字，且不能包含换行'); }
    if (LexiShareContent.bytes(draft.quote) > LexiShareContent.MAX_QUOTE_BYTES) { throw new Error('引用文本超过 100 KB，请缩小选中范围'); }
    const source = LexiShareContent.safeUrl(draft.sourceUrl);
    if (!LexiShareContent.cleanText(draft.quote) && !source) { throw new Error('没有可剪藏的文本或安全网页链接'); }
    if (!Number.isFinite(draft.receivedAt) || draft.receivedAt <= 0) { throw new Error('剪藏时间无效'); }
  }

  private static markdownText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/[\[\]*_`~]/g, (mark: string): string => `\\${mark}`).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  static markdown(draft: LexiShareDraft): string {
    LexiShareContent.validate(draft);
    const title = LexiShareContent.cleanText(draft.title) || '未命名剪藏';
    const quote = LexiShareContent.cleanText(draft.quote);
    const source = LexiShareContent.safeUrl(draft.sourceUrl).replace(/[()<>]/g, (mark: string): string => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
    const parts: string[] = [`# ${LexiShareContent.markdownText(title)}`];
    if (source) { parts.push(`来源：[打开原文](${source})`); }
    if (quote) { parts.push(quote.split('\n').map((line: string): string => `> ${LexiShareContent.markdownText(line)}`).join('\n')); }
    parts.push('#剪藏');
    return parts.join('\n\n') + '\n';
  }
}
