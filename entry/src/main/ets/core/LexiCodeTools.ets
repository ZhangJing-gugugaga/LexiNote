// Pure code-block helpers. Detection uses distinctive syntax rather than a
// fallback language. Formatting never inserts punctuation or rewrites tokens.
export class LexiCodeTools {
  private static readonly maxCodeLength: number = 262144;

  private static leadingCode(code: string): string {
    let text = code.trim();
    while (text) {
      if (text.startsWith('/*')) {
        const end = text.indexOf('*/', 2);
        if (end < 0) { return ''; }
        text = text.substring(end + 2).trimStart();
      } else if (/^(\/\/|--|#(?!include\b|!))/.test(text)) {
        const end = text.search(/[\r\n]/);
        if (end < 0) { return ''; }
        text = text.substring(end + 1).trimStart();
      } else { break; }
    }
    return text;
  }

  static detect(code: string): string {
    if (!code.trim() || code.length > LexiCodeTools.maxCodeLength) { return ''; }
    const raw = code.trim();
    if (/^#![^\r\n]*\bpython[\d.]*\b/.test(raw)) { return 'python'; }
    if (/^#![^\r\n]*\b(?:ba|z|k|da)?sh\b/.test(raw)) { return 'shell'; }
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try { JSON.parse(raw) as Object; return 'json'; } catch (_) {}
    }
    const text = LexiCodeTools.leadingCode(raw);
    if (!text) { return ''; }
    if (/(?:^|\n)\s*@(?:Entry|Component|ComponentV2)\b/.test(text) && /\bstruct\s+[A-Za-z_]\w*\s*\{/.test(text)) {
      return 'arkts';
    }
    if (/^<!doctype\s+html\b/i.test(text) ||
      /^<(html|head|body|div|span|p|section|article|main|ul|ol|li|table|form|button|script|style|h[1-6])(?:\s[^>]*|)>[\s\S]*<\/\1\s*>/i.test(text)) {
      return 'html';
    }
    if (/^(?:SELECT\s+[\s\S]+\s+FROM\s+[\w"`[]|INSERT\s+INTO\s+|UPDATE\s+[\w"`[]+[\s\S]+\s+SET\s+|DELETE\s+FROM\s+|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|DATABASE)\s+|WITH\s+\w+\s+AS\s*\()/i.test(text)) {
      return 'sql';
    }
    if (/^(?:@(?:media|supports|keyframes|font-face|layer)\b|[.#][\w-]+[^{}]*\{|(?:html|body|div|span|p|button|a|:root)\s*[^{}]*\{)/i.test(text) &&
      /(?:^|[;{\s])(?:--[\w-]+|color|background(?:-[\w-]+)?|display|position|font(?:-[\w-]+)?|margin(?:-[\w-]+)?|padding(?:-[\w-]+)?|width|height|gap|border(?:-[\w-]+)?|transform|opacity|content)\s*:/.test(text)) {
      return 'css';
    }
    if (/^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^\r\n]*\)\s*(?:->\s*[^:\r\n]+)?\s*:/m.test(text) ||
      /^class\s+[A-Za-z_]\w*(?:\([^\r\n]*\))?\s*:/m.test(text) ||
      /^(?:from\s+[\w.]+\s+import\s+\w|import\s+[A-Za-z_]\w*(?:\.[\w]+)*(?:\s+as\s+\w+)?\s*(?:\r?\n|$))/m.test(text)) {
      return 'python';
    }
    if (/^(?:package\s+[\w.]+\s*;|import\s+(?:static\s+)?(?:java|javax|android)\.[\w.*]+\s*;)/m.test(text) ||
      /\bpublic\s+static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s+\w+\s*\[\s*\])/.test(text)) {
      return 'java';
    }
    if (/^\s*#\s*include\s*<\s*(?:iostream|vector|string|map|set|memory|algorithm|thread|utility|array|unordered_map|cstdio|cstdlib)\s*>/m.test(text) ||
      /\bstd::[A-Za-z_]\w*|\busing\s+namespace\s+std\s*;|\btemplate\s*<\s*(?:typename|class)\b/.test(text)) {
      return 'cpp';
    }
    if (/^\s*#\s*include\s*[<"](?:stdio|stdlib|string|stdint|stdbool|stddef|math|unistd)\.h[>"]/m.test(text)) { return 'c'; }
    if (/^(?:set\s+-[A-Za-z]+(?:\s+pipefail)?\s*$|export\s+[A-Za-z_]\w*=|(?:echo|printf|chmod|mkdir|cd)\s+|(?:if|while)\s+\[\[?[^\r\n]*\]\]?\s*;?\s*(?:then|do)\b)/m.test(text)) {
      return 'shell';
    }
    if (/^(?:export\s+)?(?:interface\s+[A-Za-z_]\w*(?:\s+extends\s+[^{}]+)?\s*\{|type\s+[A-Za-z_]\w*(?:<[^>]+>)?\s*=|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]|import\s+type\b)/m.test(text) ||
      /\([^\r\n)]*\b[A-Za-z_$][\w$]*\??\s*:\s*(?:string|number|boolean|void|[A-Z][\w$]*)\b[^\r\n)]*\)/.test(text) ||
      /\)\s*:\s*(?:string|number|boolean|void|Promise\s*<)/.test(text)) {
      return 'typescript';
    }
    if (/^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/m.test(text) ||
      /^(?:export\s+)?(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*|\{[^}\r\n]+\}|\[[^\]\r\n]+\])\s*=(?!=)/m.test(text) ||
      /^import\s+[^;\r\n]+\s+from\s*['"]/m.test(text) ||
      /^\s*console\.(?:log|warn|error|info)\s*\(/m.test(text)) {
      return 'javascript';
    }
    return '';
  }

  private static language(lang: string): string {
    const normalized = lang.trim().toLowerCase();
    if (['js', 'javascript', 'jsx', 'mjs', 'cjs'].includes(normalized)) { return 'javascript'; }
    if (['ts', 'typescript', 'tsx'].includes(normalized)) { return 'typescript'; }
    if (['ets', 'arkts'].includes(normalized)) { return 'arkts'; }
    if (['py', 'python', 'python3'].includes(normalized)) { return 'python'; }
    if (['sh', 'shell', 'bash', 'zsh', 'ksh', 'dash'].includes(normalized)) { return 'shell'; }
    if (['c++', 'cpp', 'cxx', 'cc'].includes(normalized)) { return 'cpp'; }
    if (['c', 'java', 'json', 'html', 'css', 'sql'].includes(normalized)) { return normalized; }
    return '';
  }

  static format(code: string, lang: string): string {
    if (!code || code.length > LexiCodeTools.maxCodeLength) { return code; }
    const language = !lang.trim() || ['auto', 'code'].includes(lang.trim().toLowerCase()) ?
      LexiCodeTools.detect(code) : LexiCodeTools.language(lang);
    if (!language) { return code; }
    if (language === 'json') { return LexiCodeTools.formatJson(code); }
    // Whitespace is data in HTML text nodes, shell heredocs and continuations.
    // Skip these languages rather than pretend a token-blind formatter is safe.
    if (language === 'html' || language === 'shell') { return code; }
    // Preserve templates, triple-quoted/raw strings, SQL dollar strings and
    // escapes (which can hide line continuations or preprocessor behavior).
    if (code.includes('`') || code.includes('\\') || code.includes('"""') || code.includes("'''") ||
      /\b(?:u8|u|U|L)?R"/.test(code) || /\$(?:[A-Za-z_]\w*)?\$/.test(code) ||
      (language === 'sql' && code.includes('['))) { return code; }
    return LexiCodeTools.trimSafeLineEnds(code, language);
  }

  private static formatJson(code: string): string {
    try { JSON.parse(code) as Object; } catch (_) { return code; }
    const tokens: string[] = [];
    for (let index = 0; index < code.length;) {
      if (/\s/.test(code[index])) { index++; continue; }
      const start = index; const char = code[index++];
      if (char === '"') {
        let escaped = false;
        while (index < code.length) {
          const current = code[index++];
          if (!escaped && current === '"') { break; }
          if (!escaped && current === '\\') { escaped = true; } else { escaped = false; }
        }
      } else if (!'{}[],:'.includes(char)) {
        while (index < code.length && !/[\s{}\[\],:]/.test(code[index])) { index++; }
      }
      tokens.push(code.substring(start, index));
    }
    const result: string[] = []; let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === '{' || token === '[') {
        result.push(token); depth++;
        if (depth > 128) { return code; }
        if (tokens[index + 1] !== '}' && tokens[index + 1] !== ']') { result.push(`\n${'  '.repeat(depth)}`); }
      } else if (token === '}' || token === ']') {
        depth--;
        if (tokens[index - 1] !== '{' && tokens[index - 1] !== '[') { result.push(`\n${'  '.repeat(depth)}`); }
        result.push(token);
      } else if (token === ',') { result.push(`,\n${'  '.repeat(depth)}`); }
      else if (token === ':') { result.push(': '); }
      else { result.push(token); }
    }
    return result.join('');
  }

  private static trimSafeLineEnds(code: string, language: string): string {
    const lines = code.split(/(\r\n|\n|\r)/);
    const result: string[] = []; let blockComment = false; let quote = '';
    const slashComments = ['javascript', 'typescript', 'arkts', 'java', 'c', 'cpp'].includes(language);
    for (let index = 0; index < lines.length; index += 2) {
      const line = lines[index]; let hasComment = blockComment;
      for (let column = 0; column < line.length; column++) {
        const char = line[column]; const next = line[column + 1];
        if (blockComment) {
          if (char === '*' && next === '/') { blockComment = false; column++; }
        } else if (quote) { if (char === quote) { quote = ''; } }
        else if (char === '"' || char === "'") { quote = char; }
        else if (language !== 'python' && char === '/' && next === '*') { blockComment = true; hasComment = true; column++; }
        else if ((slashComments && char === '/' && next === '/') ||
          (language === 'sql' && char === '-' && next === '-') ||
          (['python', 'sql'].includes(language) && char === '#')) { hasComment = true; break; }
      }
      // A quote continuing to the next line may be a data-bearing string.
      if (quote) { return code; }
      result.push(hasComment ? line : line.replace(/[ \t]+$/, ''));
      if (index + 1 < lines.length) { result.push(lines[index + 1]); }
    }
    return blockComment ? code : result.join('');
  }
}
