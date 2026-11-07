export class LexiDeepLinkRequest {
  action: string = '';
  noteId: string = '';
  title: string = '';
  notebook: string = '';
}

/**
 * Unified URI protocol and deep-link helpers across the Firefly (知萤 / 词萤 / 集萤) ecosystem.
 * Pure string parsing with zero platform Kit dependencies so it can be verified in Node.js tests.
 */
export class LexiEcosystemLink {
  private static hasUnsafeChars(raw: string): boolean {
    return !raw || raw.length > 4096 || /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(raw);
  }

  private static decodeParam(raw: string): string {
    try {
      return decodeURIComponent(raw.replace(/\+/g, '%20')).replace(/[\r\n\u0000-\u001f]/g, '').trim();
    } catch {
      return '';
    }
  }

  private static parseQuery(queryString: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!queryString) {
      return map;
    }
    const pairs = queryString.split('&');
    for (const pair of pairs) {
      if (!pair) {
        continue;
      }
      const eq = pair.indexOf('=');
      const key = eq >= 0 ? LexiEcosystemLink.decodeParam(pair.slice(0, eq)) : LexiEcosystemLink.decodeParam(pair);
      const val = eq >= 0 ? LexiEcosystemLink.decodeParam(pair.slice(eq + 1)) : '';
      if (key) {
        map.set(key, val);
      }
    }
    return map;
  }

  static parseLexiNoteUri(rawUri: string): LexiDeepLinkRequest | undefined {
    if (typeof rawUri !== 'string' || LexiEcosystemLink.hasUnsafeChars(rawUri)) {
      return undefined;
    }
    const match = /^lexinote:\/\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?(?:\?([^#]*))?$/i.exec(rawUri);
    if (!match) {
      return undefined;
    }
    const host = match[1].toLowerCase();
    const pathSeg = (match[2] || '').toLowerCase();
    const query = LexiEcosystemLink.parseQuery(match[3] || '');
    const routeKey = pathSeg ? `${host}/${pathSeg}` : host;

    if (routeKey === 'daily' || routeKey === 'note/daily') {
      const req = new LexiDeepLinkRequest();
      req.action = 'daily';
      return req;
    }
    if (routeKey === 'quick' || routeKey === 'note/quick') {
      const req = new LexiDeepLinkRequest();
      req.action = 'quick';
      return req;
    }
    if (routeKey === 'open' || routeKey === 'note/open' || routeKey === 'note') {
      const noteId = (query.get('noteId') || query.get('id') || '').slice(0, 128);
      const title = (query.get('title') || '').slice(0, 160);
      const notebook = (query.get('notebook') || '').slice(0, 80);
      if (noteId && !/^[A-Za-z0-9_-]{1,128}$/.test(noteId)) {
        return undefined;
      }
      if (!noteId && !title) {
        return undefined;
      }
      const req = new LexiDeepLinkRequest();
      req.action = 'open';
      req.noteId = noteId;
      req.title = title;
      req.notebook = notebook;
      return req;
    }
    return undefined;
  }

  static isLexiNoteDeepLink(target: string): boolean {
    return LexiEcosystemLink.parseLexiNoteUri(target) !== undefined;
  }

  static isExternalDeepLink(target: string): boolean {
    if (typeof target !== 'string' || LexiEcosystemLink.hasUnsafeChars(target)) {
      return false;
    }
    if (/^(?:https?:\/\/|mailto:)/i.test(target)) {
      return true;
    }
    if (/^lexiglow:\/\/(?:study\/(?:plan|mistakes|sentences)|word\?id=[1-9]\d{0,9}|article\?id=-?[1-9]\d{0,9})$/i.test(target)) {
      return true;
    }
    const wordSpellingMatch = /^lexiglow:\/\/word\?spelling=([A-Za-z0-9%'’-]{1,128})$/i.exec(target);
    if (wordSpellingMatch) {
      try {
        const decoded = decodeURIComponent(wordSpellingMatch[1]).trim().toLowerCase().replace(/’/g, "'");
        return /^[a-z][a-z'-]{0,63}$/.test(decoded);
      } catch {
        return false;
      }
    }
    if (/^lumikit:\/\/(?:inventory\?itemId=[A-Za-z0-9_-]{1,128}|tool\?id=[a-z0-9-]{1,64})$/i.test(target)) {
      return true;
    }
    return false;
  }

  static lexiGlowWordUri(spelling: string): string {
    const clean = (spelling || '').trim().toLowerCase().replace(/’/g, "'");
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(clean) || clean.length > 64) {
      return '';
    }
    return `lexiglow://word?spelling=${clean}`;
  }

  static lexiGlowArticleUri(articleId: number): string {
    if (!Number.isInteger(articleId) || articleId === 0) {
      return '';
    }
    return `lexiglow://article?id=${articleId}`;
  }

  static lexiGlowPlanUri(): string {
    return 'lexiglow://study/plan';
  }

  static lumiKitItemUri(itemId: string): string {
    const clean = (itemId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clean)) {
      return '';
    }
    return `lumikit://inventory?itemId=${clean}`;
  }

  static lumiKitToolUri(toolId: string): string {
    const clean = (toolId || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(clean)) {
      return '';
    }
    return `lumikit://tool?id=${clean}`;
  }
}
