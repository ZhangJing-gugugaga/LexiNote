export class LexiCodeToken {
  id: string = '';
  text: string = '';
  kind: string = 'text';
}

/** A bounded lexical highlighter. Tokens always concatenate to the untouched source. */
export class LexiCodeHighlight {
  static normalizeLanguage(language: string): string {
    const name = language.trim().toLowerCase().split(/\s+/)[0].replace(/^language-/, '');
    if (['', 'code', 'auto', 'text', 'txt', 'plain', 'plaintext', 'none'].includes(name)) { return ''; }
    if (['js', 'jsx', 'javascript', 'node', 'nodejs', 'mjs', 'cjs'].includes(name)) { return 'javascript'; }
    if (['ts', 'tsx', 'typescript'].includes(name)) { return 'typescript'; }
    if (['ets', 'arkts'].includes(name)) { return 'arkts'; }
    if (['py', 'python', 'python3'].includes(name)) { return 'python'; }
    if (['sh', 'bash', 'zsh', 'shell', 'console'].includes(name)) { return 'shell'; }
    if (['c++', 'cpp', 'cc', 'cxx', 'hpp'].includes(name)) { return 'cpp'; }
    if (['c#', 'cs', 'csharp'].includes(name)) { return 'csharp'; }
    if (['yml', 'yaml'].includes(name)) { return 'yaml'; }
    if (['htm', 'html', 'xml', 'svg'].includes(name)) { return name === 'htm' ? 'html' : name; }
    if (name === 'golang') { return 'go'; }
    if (name === 'rs') { return 'rust'; }
    if (name === 'kt') { return 'kotlin'; }
    if (name === 'rb') { return 'ruby'; }
    return name;
  }

  static label(language: string): string {
    const name = LexiCodeHighlight.normalizeLanguage(language);
    if (!name) { return '未指定语言'; }
    if (name === 'javascript') { return 'JavaScript'; }
    if (name === 'typescript') { return 'TypeScript'; }
    if (name === 'arkts') { return 'ArkTS'; }
    if (name === 'python') { return 'Python'; }
    if (name === 'java') { return 'Java'; }
    if (name === 'shell') { return 'Shell'; }
    if (name === 'cpp') { return 'C++'; }
    if (name === 'csharp') { return 'C#'; }
    if (name === 'kotlin') { return 'Kotlin'; }
    if (name === 'swift') { return 'Swift'; }
    if (name === 'rust') { return 'Rust'; }
    if (name === 'ruby') { return 'Ruby'; }
    if (name === 'go') { return 'Go'; }
    return name.toUpperCase();
  }

  static color(kind: string, dark: boolean): string {
    if (kind === 'keyword') { return dark ? '#CEB5FF' : '#6532A3'; }
    if (kind === 'string') { return dark ? '#9AD8B2' : '#176544'; }
    if (kind === 'number') { return dark ? '#F4BC83' : '#8C3B0E'; }
    if (kind === 'comment') { return dark ? '#AAB2C7' : '#596273'; }
    if (kind === 'function' || kind === 'tag') { return dark ? '#96CAFF' : '#1C4F91'; }
    if (kind === 'property') { return dark ? '#F0B2CC' : '#8A3460'; }
    return dark ? '#F5F3FB' : '#231B36';
  }

  private static keywords(language: string): string {
    if (language === 'json') { return ' true false null '; }
    if (language === 'python') { return ' and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case '; }
    if (language === 'sql') { return ' select from where insert into values update set delete create alter drop table view index join left right inner outer full on as and or not null is in exists like between group by order having limit offset distinct union all case when then else end asc desc with over partition true false count sum avg min max '; }
    if (language === 'shell') { return ' if then else elif fi for while do done in case esac function select until time coproc return break continue export local readonly declare typeset unset source alias unalias echo printf cd exit true false '; }
    if (language === 'yaml') { return ' true false null yes no on off '; }
    if (language === 'go') { return ' break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil make new '; }
    if (language === 'rust') { return ' as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while bool char f32 f64 i32 i64 u32 u64 usize '; }
    if (language === 'ruby') { return ' alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield '; }
    if (language === 'css') { return ' important inherit initial unset revert auto none solid block inline flex grid absolute relative fixed sticky hidden visible '; }
    if (['html', 'xml', 'svg'].includes(language)) { return ''; }
    if (language === 'swift') { return ' actor any as async associatedtype await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator override private protocol public repeat required rethrows return self Self some static struct subscript super switch throw throws true try typealias var weak where while '; }
    if (language === 'kotlin') { return ' abstract actual annotation as break by catch class companion const constructor continue data delegate do dynamic else enum expect external false field file final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias typeof val var vararg when where while '; }
    if (['javascript', 'typescript', 'arkts', 'java', 'c', 'cpp', 'csharp'].includes(language)) {
      return ' abstract alignas alignof as async await auto bool boolean break byte case catch char class const constexpr continue debugger declare default delete do double else enum export extends extern false final finally float for friend from function get goto if implements import in infer inline instanceof int interface keyof let long namespace native new null nullptr number of operator override package private protected public readonly record register requires return satisfies set short signed sizeof static string struct super switch synchronized template this throw throws true try type typedef typename typeof undefined union unsigned using var virtual void volatile while with yield ';
    }
    return '';
  }

  private static quotedEnd(source: string, start: number, delimiter: string, multiline: boolean): number {
    let cursor = start + delimiter.length;
    while (cursor < source.length) {
      if (source[cursor] === '\\') { cursor = Math.min(source.length, cursor + 2); continue; }
      if (source.substring(cursor, cursor + delimiter.length) === delimiter) { return cursor + delimiter.length; }
      if (!multiline && (source[cursor] === '\n' || source[cursor] === '\r')) { return cursor; }
      cursor++;
    }
    return source.length;
  }

  private static regexEnd(source: string, start: number): number {
    const before = source.substring(0, start).trimEnd();
    if (before && !/[=([{,:;!?&|]$/.test(before) && !/\b(?:return|throw|case|yield)\s*$/.test(before)) { return -1; }
    let inClass = false;
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source[cursor] === '\n' || source[cursor] === '\r') { return -1; }
      if (source[cursor] === '[') { inClass = true; }
      if (source[cursor] === ']') { inClass = false; }
      if (source[cursor] === '/' && !inClass) {
        cursor++;
        while (cursor < source.length && /[dgimsuvy]/.test(source[cursor])) { cursor++; }
        return cursor;
      }
      cursor++;
    }
    return -1;
  }

  static tokenize(source: string, language: string): LexiCodeToken[] {
    if (!source) { return []; }
    const name = LexiCodeHighlight.normalizeLanguage(language);
    const known = ['javascript', 'typescript', 'arkts', 'python', 'json', 'sql', 'java', 'c', 'cpp', 'csharp', 'shell', 'css', 'html', 'xml', 'svg', 'yaml', 'go', 'rust', 'ruby', 'swift', 'kotlin'].includes(name);
    if (!known) { const plain = new LexiCodeToken(); plain.id = 'code-0'; plain.text = source; return [plain]; }
    const tokens: LexiCodeToken[] = [];
    const cStyle = ['javascript', 'typescript', 'arkts', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin'].includes(name);
    const hashStyle = ['python', 'shell', 'yaml', 'ruby'].includes(name);
    const markup = ['html', 'xml', 'svg'].includes(name);
    const vocabulary = LexiCodeHighlight.keywords(name);
    let inTag = false;
    let cursor = 0;
    while (cursor < source.length) {
      const start = cursor;
      let kind = 'text';
      const character = source[cursor];
      const next = source[cursor + 1] || '';
      const rest = source.substring(cursor);
      if (cursor >= 60000 || tokens.length >= 4000) { cursor = source.length; }
      else if (markup && rest.startsWith('<!--')) {
        const closing = source.indexOf('-->', cursor + 4); cursor = closing < 0 ? source.length : closing + 3; kind = 'comment';
      } else if ((cStyle || name === 'css' || name === 'sql') && rest.startsWith('/*')) {
        const closing = source.indexOf('*/', cursor + 2); cursor = closing < 0 ? source.length : closing + 2; kind = 'comment';
      } else if ((cStyle && rest.startsWith('//')) || (name === 'sql' && rest.startsWith('--')) ||
        (hashStyle && character === '#' && (name !== 'yaml' || cursor === 0 || /\s/.test(source[cursor - 1])))) {
        const newline = source.indexOf('\n', cursor); cursor = newline < 0 ? source.length : newline; kind = 'comment';
      } else if (character === '/' && ['javascript', 'typescript', 'arkts'].includes(name) && LexiCodeHighlight.regexEnd(source, cursor) > cursor) {
        cursor = LexiCodeHighlight.regexEnd(source, cursor); kind = 'string';
      } else if (name === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
        cursor = LexiCodeHighlight.quotedEnd(source, cursor, rest.substring(0, 3), true); kind = 'string';
      } else if (character === '"' || (character === "'" && name !== 'json') ||
        (character === '`' && ['javascript', 'typescript', 'arkts', 'shell', 'go'].includes(name))) {
        cursor = LexiCodeHighlight.quotedEnd(source, cursor, character,
          character === '`' || ['sql', 'shell', 'yaml', 'ruby'].includes(name));
        kind = 'string';
        if (name === 'json' && /^\s*:/.test(source.substring(cursor))) { kind = 'property'; }
      } else if (markup && character === '<' && /[A-Za-z/!?]/.test(next)) {
        inTag = true; cursor++; kind = 'punctuation';
      } else if (markup && character === '>') {
        inTag = false; cursor++; kind = 'punctuation';
      } else if (/\d/.test(character) || (character === '.' && /\d/.test(next))) {
        const number = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:[nNlLfFdD])?/.exec(rest);
        cursor += number ? number[0].length : 1; kind = markup && !inTag ? 'text' : 'number';
      } else if (/[$A-Za-z_]/.test(character)) {
        const word = (markup || name === 'css' || name === 'yaml' ? /^[$A-Za-z_][\w$-]*/ : /^[$A-Za-z_][\w$]*/).exec(rest);
        const wordText = word ? word[0] : character;
        cursor += wordText.length;
        const lower = name === 'sql' || name === 'yaml' ? wordText.toLowerCase() : wordText;
        if (vocabulary.includes(` ${lower} `)) { kind = 'keyword'; }
        else if (markup && inTag) { kind = /^\s*=/.test(source.substring(cursor)) ? 'property' : 'tag'; }
        else if (!markup && name !== 'json' && /^\s*\(/.test(source.substring(cursor))) { kind = 'function'; }
        else if (name === 'yaml' && /^\s*:/.test(source.substring(cursor))) { kind = 'property'; }
      } else if (/\s/.test(character)) {
        cursor++; while (cursor < source.length && /\s/.test(source[cursor])) { cursor++; }
      } else if (/[{}\[\]();:.,=+*/<>!?&|%~^-]/.test(character)) { cursor++; kind = 'punctuation'; }
      else { cursor++; }
      if (cursor <= start) { cursor = start + 1; }
      const text = source.substring(start, cursor);
      const previous = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
      if (previous && previous.kind === kind && kind === 'text') { previous.text += text; }
      else { const token = new LexiCodeToken(); token.id = `code-${start}`; token.kind = kind; token.text = text; tokens.push(token); }
    }
    return tokens;
  }
}
