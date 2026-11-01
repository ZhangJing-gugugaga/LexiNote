export class LexiTemplates {
  static dateKey(now: Date = new Date()): string {
    return `${now.getFullYear()}-${LexiTemplates.pad(now.getMonth() + 1)}-${LexiTemplates.pad(now.getDate())}`;
  }

  private static pad(part: number): string { return part < 10 ? `0${part}` : `${part}`; }

  static render(content: string, title: string, now: Date = new Date()): string {
    const weekdays: string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return content.replace(/\{\{\s*(date|time|title|weekday)\s*\}\}/g, (_match: string, token: string): string => {
      if (token === 'date') { return LexiTemplates.dateKey(now); }
      if (token === 'time') { return `${LexiTemplates.pad(now.getHours())}:${LexiTemplates.pad(now.getMinutes())}`; }
      if (token === 'weekday') { return weekdays[now.getDay()]; }
      return title;
    });
  }
}
