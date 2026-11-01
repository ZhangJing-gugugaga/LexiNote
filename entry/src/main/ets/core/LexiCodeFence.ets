export class LexiCodeFenceInfo {
  raw: string = '';
  newline: string = '\n';
  marker: string = '```';
  header: string = '```';
  language: string = '';
  extra: string = '';
  body: string = '';
  bodyOffset: number = 4;
  closing: string = '```';
  closed: boolean = false;
}

/** Retains fence metadata and line endings while the editor works on code only. */
export class LexiCodeFence {
  static parse(raw: string): LexiCodeFenceInfo {
    const result = new LexiCodeFenceInfo(); result.raw = raw;
    result.newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(result.newline);
    result.header = lines[0] || '```';
    const header = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(result.header);
    if (header) {
      result.marker = header[2];
      const info = header[3].trim();
      const split = info.search(/\s/);
      result.language = split < 0 ? info : info.substring(0, split);
      result.extra = split < 0 ? '' : info.substring(split);
    }
    result.bodyOffset = result.header.length + (lines.length > 1 ? result.newline.length : 0);
    const closing = lines.length > 1 ? lines[lines.length - 1] : '';
    const closePattern = new RegExp(`^\\s*${result.marker.charAt(0)}{${result.marker.length},}\\s*$`);
    result.closed = lines.length > 1 && closePattern.test(closing);
    result.closing = result.closed ? closing : '';
    result.body = lines.slice(1, result.closed ? lines.length - 1 : lines.length).join(result.newline);
    return result;
  }

  static update(raw: string, body: string, language: string): string {
    const old = LexiCodeFence.parse(raw);
    if (old.body === body && old.language === language) { return raw; }
    const prefix = old.header.substring(0, old.header.indexOf(old.marker));
    let length = old.marker.length;
    const markerChar = old.marker.charAt(0);
    for (const line of body.split(/\r?\n/)) {
      const match = new RegExp(`^\\s*(${markerChar}{3,})\\s*$`).exec(line);
      if (match && match[1].length >= length) { length = match[1].length + 1; }
    }
    const marker = markerChar.repeat(length);
    const header = `${prefix}${marker}${language}${old.extra}`;
    if (!old.closed) { return `${header}${old.newline}${body}`; }
    const closing = length === old.marker.length ? old.closing : old.closing.replace(new RegExp(`${markerChar}{3,}`), marker);
    return `${header}${old.newline}${body}${old.newline}${closing}`;
  }
}
