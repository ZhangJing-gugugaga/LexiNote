/*
 * LexiNote workspace runtime (ArkWeb page entry).
 *
 * Owns: the CodeMirror 6 editor, the WebMessagePort channel to the ArkTS host,
 * the command palette, notice rendering and the plugin view slots.
 *
 * Bridge rules (docs/lexinote_plugin_bridge_spec.md section 2):
 *  - javaScriptProxy carries exactly one method, __lexiHandshake.hello(), used only to
 *    announce that the page booted so the host attaches the port.
 *  - every business call travels as a JSON frame over the port.
 */
import { EditorState, Compartment } from '@codemirror/state';
import * as cmState from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor
} from '@codemirror/view';
import * as cmView from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, deleteLine,
  indentMore, indentLess, moveLineUp, moveLineDown, toggleComment, selectLine
} from '@codemirror/commands';
import * as cmCommands from '@codemirror/commands';
import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import * as cmLanguage from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import * as cmSearch from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import * as cmAutocomplete from '@codemirror/autocomplete';

const PORT_TAG = '__lexi_port__';
const PROXY_TIMEOUT_MS = 8000;
const PORT_TIMEOUT_MS = 12000;

interface HandshakeProxy { hello(reason: string): void }
interface PluginEntry { id: string; name: string; version: string }
interface PluginListResult { plugins: PluginEntry[] }
interface PluginDescriptor {
  id: string; name: string; version: string; code: string; token: string;
  manifest?: Record<string, unknown>;
}
interface AuthData { nonce: string; channelId: string; token: string }
/** Obsidian 兼容层（rawfile/lexinote_plugin_shim.js 的 window.LexiObsidian）。 */
interface LexiObsidianApi {
  apiVersion: string;
  setSessionToken(token: string): void;
  loadPlugin(message: { manifest: Record<string, unknown>; code: string; token: string }): Promise<void>;
  hasPlugin(id: string): boolean;
  commands(): { fullId: string; id: string; name: string; pluginId: string }[];
  runCommand(fullId: string): Promise<unknown>;
  dispatchEvent(frame: unknown): void;
  markLayoutReady(): Promise<unknown>;
  refreshMetadataGraph(): Promise<unknown>;
  refreshVaultFiles(): Promise<unknown>;
  restoreLayout(): Promise<number>;
  /** 主编辑器当前的 Editor 代理(editorInfoField 的值从这里取)。 */
  currentEditor(): unknown;
  stats(): unknown;
}
interface ShimApi {
  attach(post: (text: string) => void): void;
  setup(hooks: Record<string, unknown>): void;
  handleFrame(raw: string): void;
  call(method: string, payload: unknown, token?: string): Promise<unknown>;
  loadPlugin(descriptor: PluginDescriptor): Promise<unknown>;
  mountView(pluginId: string, viewType: string, element: HTMLElement, viewId: string): Promise<unknown>;
  commands(): { id: string; name: string; pluginId: string }[];
  runCommand(fullId: string): Promise<unknown>;
  stats(): unknown;
}

interface EditorBridge {
  cm(): EditorView | null;
  module(name: string): unknown;
  identity(): Record<string, unknown>;
  getValue(): string;
  lineCount(): number;
  getLine(line: number): string;
  getSelection(): { anchor: number; head: number };
  setValue(text: string): number;
  replace(from: number, to: number, text: string): number;
  setSelection(anchor: number, head: number): boolean;
  applyChanges(changes: { from: number; to: number; text: string }[], selections: { anchor: number; head: number }[]): number;
  undo(): boolean;
  redo(): boolean;
  exec(command: unknown): boolean;
  processLines(process: (line: string, lineNumber: number) => string): number;
  wordAt(offset: number): { from: number; to: number } | null;
  scrollIntoView(offset: number): void;
  focus(): void;
  blur(): void;
  registerExtensions(pluginId: string, extensions: unknown[]): number;
  releaseExtensions(pluginId: string): number;
  extensionCount(pluginId?: string): number;
}

const host = window as unknown as {
  __lexiHandshake?: HandshakeProxy;
  LexiPluginShim?: ShimApi;
  LexiObsidian?: LexiObsidianApi;
  lexiHost?: unknown;
  __lexiEditor?: EditorBridge;
  LexiCmModules?: Record<string, unknown>;
  __lexiCmModules?: Record<string, unknown>;
  __lexiEditorInfoField?: unknown;
};
const shim = host.LexiPluginShim as ShimApi;
const obsidianApi = host.LexiObsidian;

let view: EditorView | null = null;
let framePort: MessagePort | null = null;
let sessionToken = '';
let changeTimer = 0;
let bootFailure = '';
let channelReady = false;
const earlyNotes: { topic: string; detail: Record<string, unknown> }[] = [];

/**
 * 插件 require('@codemirror/*') 必须拿到与编辑器同一份实例。
 * 两份副本不会报错:ViewPlugin/StateField 的 instanceof 判定失败后静默不生效。
 * 因此这里把本 bundle 的模块命名空间对象原样交给兼容层,由它按名字解析。
 */
const cmModules: Record<string, unknown> = {
  '@codemirror/state': cmState,
  '@codemirror/view': cmView,
  '@codemirror/language': cmLanguage,
  '@codemirror/commands': cmCommands,
  '@codemirror/search': cmSearch,
  '@codemirror/autocomplete': cmAutocomplete
};
host.__lexiCmModules = cmModules;
host.LexiCmModules = cmModules;

/** 插件扩展挂载点:一个 Compartment 装全部插件扩展,重配置即可增删。 */
const pluginExtensionRoot = new Compartment();
const pluginExtensions = new Map<string, cmState.Extension[]>();

function allPluginExtensions(): cmState.Extension[] {
  const all: cmState.Extension[] = [];
  pluginExtensions.forEach((list) => { for (const ext of list) { all.push(ext); } });
  return all;
}

function installedExtensionCount(pluginId?: string): number {
  if (pluginId !== undefined) {
    const list = pluginExtensions.get(pluginId);
    return list ? list.length : 0;
  }
  let total = 0;
  pluginExtensions.forEach((list) => { total += list.length; });
  return total;
}

function applyPluginExtensions(): number {
  if (!view) { return 0; }
  view.dispatch({ effects: pluginExtensionRoot.reconfigure(allPluginExtensions()) });
  return installedExtensionCount();
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) { throw new Error('missing element #' + id); }
  return found;
}

/** 一条 [lexi] 行:detail 自己 JSON 化并截断,宿主 onConsole 才读得到结构(否则只有 [object Object])。 */
const NOTE_DETAIL_MAX = 160;

function noteLine(topic: string, detail: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(detail === undefined || detail === null ? {} : detail);
  } catch (err) {
    text = '[unserializable]';
  }
  if (typeof text !== 'string') { text = '[unserializable]'; }
  if (text.length > NOTE_DETAIL_MAX) {
    text = text.slice(0, NOTE_DETAIL_MAX) + '…(' + text.length + ')';
  }
  return '[lexi] ' + topic + ' ' + text;
}

/** Host telemetry line: console + hilog on the ArkTS side. */
function note(topic: string, detail: Record<string, unknown>, token?: string): void {
  console.log(noteLine(topic, detail));
  if (!channelReady) { earlyNotes.push({ topic: topic, detail: detail }); return; }
  if (shim) { void shim.call('log.event', { topic: topic, detail: detail }, token).catch(() => {}); }
}

/** Frames sent before the port was attached would be lost; replay them once it is. */
function flushEarlyNotes(): void {
  channelReady = true;
  for (const entry of earlyNotes) {
    void shim.call('log.event', { topic: entry.topic, detail: entry.detail }).catch(() => {});
  }
  earlyNotes.length = 0;
}

/**
 * 兼容层唯一的传输通道:lexinote_plugin_shim.js 只认 window.lexiHost.call(callId, method, payloadJson, token),
 * 这里把它翻译成工作区的 v1 帧,身份 token 由宿主在 channel.auth 发放。
 */
function installCompatHost(): void {
  host.lexiHost = {
    call: (callId: string, method: string, raw: string, token?: string): Promise<string> => {
      let payload: Record<string, unknown> = {};
      try { payload = raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { payload = {}; }
      const identity = token && token.length > 0 ? token : sessionToken;
      return shim.call(method, payload, identity).then(
        (data: unknown) => JSON.stringify({ ok: true, result: data === undefined ? null : data }),
        (err: Error) => JSON.stringify({
          ok: false,
          error: err && err.message ? err.message : String(err),
          code: (err as unknown as { code?: string }).code || ''
        })
      );
    }
  };
}

/** 事件帧是宿主→页面的单向下推,转交 obsidian 兼容层的事件总线。 */
function routeEventFrame(raw: string): void {
  if (!obsidianApi || raw.length === 0 || raw.indexOf('"event"') < 0) { return; }
  try {
    const frame = JSON.parse(raw) as { v?: number; type?: string; topic?: string; payload?: Record<string, unknown> };
    if (!frame || frame.v !== 1 || frame.type !== 'event') { return; }
    const payload = frame.payload || {};
    const name = typeof payload.name === 'string' ? payload.name as string : '';
    obsidianApi.dispatchEvent({ topic: frame.topic, name: name, payload: payload });
  } catch { /* 非 JSON 帧交给 shim 处理 */ }
}

/**
 * Obsidian 的 editorInfoField:插件用 state.field(editorInfoField).editor 取编辑器
 * (obsidian-outliner 的 getEditorFromState 就是这么取的)。必须是装进本 state 的真 StateField——
 * 传 undefined 进去,CM6 的 field() 会在 field.id 上直接抛 TypeError。
 */
const editorInfoValue = {
  id: 'lexinote-main-editor',
  get editor(): unknown {
    return obsidianApi && typeof obsidianApi.currentEditor === 'function' ? obsidianApi.currentEditor() : null;
  }
};
const editorInfoField = cmState.StateField.define<typeof editorInfoValue>({
  create: () => editorInfoValue,
  update: (value) => value
});
host.__lexiEditorInfoField = editorInfoField;

function mountEditor(): EditorView {
  const parent = el('editor');
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: '# LexiNote 插件工作区\n\n在这里输入中文，或从命令面板调用插件命令。\n\n- CM6 由本地 bundle 提供\n- 插件命令走 WebMessagePort\n',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle),
        closeBrackets(),
        autocompletion(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab
        ]),
        EditorView.lineWrapping,
        pluginExtensionRoot.of([]),
        editorInfoField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) { scheduleDocLog(); }
          if (update.docChanged || update.selectionSet) { scheduleEditorEvent(); }
        })
      ]
    })
  });
}

/**
 * 兼容层的 Editor 面在同页只有一套真文档(CM6),所以所有编辑操作都在这里落到活的 EditorView:
 * 宿主 RPC 那条路是原生 slot 面的回落,在容器里只会改到另一份不存在的文档。
 */
function installEditorBridge(): void {
  const commands: Record<string, (target: EditorView) => boolean> = {
    undo: undo, redo: redo, selectAll: selectAll, deleteLine: deleteLine, indentMore: indentMore,
    indentLess: indentLess, moveLineUp: moveLineUp, moveLineDown: moveLineDown,
    toggleComment: toggleComment, selectLine: selectLine
  };

  host.__lexiEditor = {
    cm(): EditorView | null { return view; },
    module(name: string): unknown { return cmModules[name] || null; },
    identity(): Record<string, unknown> {
      const state = view ? view.state : null;
      return {
        module: cmState,
        stateCtor: cmState.EditorState,
        viewCtor: cmView.EditorView,
        moduleIsBundleNamespace: cmModules['@codemirror/state'] === cmState,
        liveStateCtorSame: !!state && state.constructor === cmState.EditorState,
        liveViewCtorSame: !!view && (view as unknown as object).constructor === cmView.EditorView,
        extensionCount: installedExtensionCount(),
        channel: 'page-bundle'
      };
    },
    getValue(): string { return view ? view.state.doc.toString() : ''; },
    lineCount(): number { return view ? view.state.doc.lines : 0; },
    getLine(line: number): string {
      if (!view) { return ''; }
      const doc = view.state.doc;
      return line >= 0 && line < doc.lines ? doc.line(line + 1).text : '';
    },
    getSelection(): { anchor: number; head: number } {
      if (!view) { return { anchor: 0, head: 0 }; }
      const range = view.state.selection.main;
      return { anchor: range.anchor, head: range.head };
    },
    setValue(text: string): number {
      if (!view) { return 0; }
      const length = view.state.doc.length;
      view.dispatch({ changes: { from: 0, to: length, insert: String(text) } });
      return view.state.doc.length;
    },
    replace(from: number, to: number, text: string): number {
      if (!view) { return 0; }
      const length = view.state.doc.length;
      const start = Math.max(0, Math.min(from, length));
      const end = Math.max(start, Math.min(to, length));
      view.dispatch({ changes: { from: start, to: end, insert: String(text) } });
      return view.state.doc.length;
    },
    setSelection(anchor: number, head: number): boolean {
      if (!view) { return false; }
      const length = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.max(0, Math.min(anchor, length)), head: Math.max(0, Math.min(head, length)) } });
      return true;
    },
    applyChanges(changes: { from: number; to: number; text: string }[], selections: { anchor: number; head: number }[]): number {
      if (!view) { return 0; }
      const specs = (changes || []).map((change) => ({
        from: Math.max(0, change.from),
        to: Math.max(change.from, change.to),
        insert: String(change.text === undefined ? '' : change.text)
      }));
      const spec: { changes: { from: number; to: number; insert: string }[]; selection?: { anchor: number; head: number }[] } = { changes: specs };
      if (selections && selections.length > 0) {
        spec.selection = selections.map((range) => ({ anchor: range.anchor, head: range.head }));
      }
      view.dispatch(spec);
      return view.state.doc.length;
    },
    undo(): boolean { return view ? undo(view) : false; },
    redo(): boolean { return view ? redo(view) : false; },
    exec(command: unknown): boolean {
      if (!view) { return false; }
      if (typeof command === 'function') { return (command as (target: EditorView) => boolean)(view) === true; }
      const name = String(command || '');
      const found = commands[name];
      if (!found) { console.warn('[lexinote] Editor.exec 未知编辑器命令: ' + name); return false; }
      return found(view) === true;
    },
    processLines(process: (line: string, lineNumber: number) => string): number {
      if (!view || typeof process !== 'function') { return 0; }
      const doc = view.state.doc;
      const changes: { from: number; to: number; insert: string }[] = [];
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const next = process(line.text, i - 1);
        const text = typeof next === 'string' ? next : line.text;
        if (text !== line.text) { changes.push({ from: line.from, to: line.to, insert: text }); }
      }
      if (changes.length > 0) { view.dispatch({ changes: changes }); }
      return changes.length;
    },
    wordAt(offset: number): { from: number; to: number } | null {
      if (!view) { return null; }
      const text = view.state.doc.toString();
      const isWord = (ch: string): boolean => /[\w\u4e00-\u9fa5]/.test(ch);
      let start = Math.max(0, Math.min(offset, text.length));
      let end = start;
      while (start > 0 && isWord(text.charAt(start - 1))) { start -= 1; }
      while (end < text.length && isWord(text.charAt(end))) { end += 1; }
      return end > start ? { from: start, to: end } : null;
    },
    scrollIntoView(offset: number): void {
      if (!view) { return; }
      const length = view.state.doc.length;
      view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(offset, length)), { y: 'nearest' }) });
    },
    focus(): void { if (view) { view.focus(); } },
    blur(): void { if (view) { (view.contentDOM as HTMLElement).blur(); } },
    registerExtensions(pluginId: string, extensions: unknown[]): number {
      const id = String(pluginId || '');
      if (id.length === 0) { return 0; }
      const list = pluginExtensions.get(id) || [];
      for (const extension of extensions || []) { list.push(extension as cmState.Extension); }
      pluginExtensions.set(id, list);
      applyPluginExtensions();
      note('editor.extensions.install', { pluginId: id, added: (extensions || []).length, total: installedExtensionCount() });
      return installedExtensionCount(id);
    },
    releaseExtensions(pluginId: string): number {
      const id = String(pluginId || '');
      const removed = installedExtensionCount(id);
      if (pluginExtensions.delete(id)) { applyPluginExtensions(); }
      note('editor.extensions.release', { pluginId: id, removed: removed, total: installedExtensionCount() });
      return removed;
    },
    extensionCount(pluginId?: string): number { return installedExtensionCount(pluginId); }
  };
}

let editorEventTimer: number | null = null;

/** Obsidian 的 editor-change / quick-preview 是文档与选区变化的节流通知,容器本地产生即可。 */
function scheduleEditorEvent(): void {
  if (editorEventTimer !== null) { return; }
  editorEventTimer = window.setTimeout(() => {
    editorEventTimer = null;
    if (!obsidianApi || !view) { return; }
    const text = view.state.doc.toString();
    obsidianApi.dispatchEvent({
      topic: 'workspace',
      name: 'editor-change',
      payload: { 'length': text.length, 'blob': text.slice(0, 400) }
    });
    obsidianApi.dispatchEvent({
      topic: 'workspace',
      name: 'quick-preview',
      payload: { 'data': text.slice(0, 400) }
    });
  }, 150);
}

function scheduleDocLog(): void {
  if (changeTimer) { return; }
  changeTimer = window.setTimeout(() => {
    changeTimer = 0;
    if (!view) { return; }
    const text = view.state.doc.toString();
    const tail = text.slice(Math.max(0, text.length - 24));
    note('editor.change', { length: text.length, tail: tail });
  }, 400);
}

function insertAtCursor(text: string): void {
  if (!view) { return; }
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    scrollIntoView: true
  });
  view.focus();
}

const noticeStack = (): HTMLElement => el('notices');

function showNotice(message: string): void {
  const stack = noticeStack();
  const bubble = document.createElement('div');
  bubble.className = 'notice';
  bubble.textContent = message;
  stack.appendChild(bubble);
  note('notice.render', { text: message, visible: stack.children.length });
  window.setTimeout(() => bubble.classList.add('notice-out'), 3200);
  window.setTimeout(() => {
    if (bubble.parentNode) { bubble.parentNode.removeChild(bubble); }
  }, 4200);
}

interface PaletteItem { id: string; name: string; container: boolean }

/** 命令面板:容器内联插件(demo)在前,obsidian 兼容层插件命令在后。 */
function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  if (shim) {
    for (const command of shim.commands()) { items.push({ id: command.id, name: command.name, container: true }); }
  }
  if (obsidianApi) {
    for (const command of obsidianApi.commands()) { items.push({ id: command.fullId, name: command.name, container: false }); }
  }
  return items;
}

let paletteFilter = '';

function openPalette(): void {
  paletteFilter = '';
  const input = el('palette-input') as HTMLInputElement;
  input.value = '';
  el('palette').hidden = false;
  renderPalette();
  input.focus();
  note('palette.open', { commands: paletteItems().length });
}

function closePalette(): void {
  el('palette').hidden = true;
}

function renderPalette(): void {
  const list = el('palette-list');
  list.textContent = '';
  const items = paletteItems();
  for (const item of items) {
    if (paletteFilter && item.name.indexOf(paletteFilter) < 0) { continue; }
    const row = document.createElement('li');
    row.className = 'palette-item';
    row.setAttribute('data-command', item.id);
    row.textContent = item.name;
    row.addEventListener('click', () => { void runPaletteCommand(item.id, item.container); });
    list.appendChild(row);
  }
  if (list.children.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'palette-empty';
    empty.textContent = '没有匹配的命令';
    list.appendChild(empty);
  }
}

async function runPaletteCommand(fullId: string, container: boolean): Promise<void> {
  closePalette();
  note('palette.command.pick', { command: fullId, container: container });
  try {
    if (container) { await shim.runCommand(fullId); } else if (obsidianApi) { await obsidianApi.runCommand(fullId); }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note('palette.command.error', { command: fullId, message: message });
    showNotice('命令失败：' + message);
  }
}

function mountPluginViews(pluginId: string): void {
  const host_ = el('views');
  host_.textContent = '';
  const viewIds = ['v1', 'v2', 'v3'];
  for (const viewId of viewIds) {
    const card = document.createElement('div');
    card.className = 'view-card';
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = '视图 ' + viewId;
    const body = document.createElement('div');
    body.className = 'view-body';
    card.appendChild(title);
    card.appendChild(body);
    host_.appendChild(card);
    void shim.mountView(pluginId, 'demo-status', body, viewId).catch((err: Error) => {
      body.textContent = '渲染失败：' + err.message;
    });
  }
}

/**
 * 真实 obsidian 插件:宿主下发 manifest + main.js 源码,v1 token 作为身份。
 * 装载走兼容层(window.LexiObsidian),与容器内联的 demo 插件是两条并行路径。
 */
async function loadObsidianPlugin(entry: PluginEntry): Promise<void> {
  if (!obsidianApi) {
    note('plugin.obsidian.skip', { id: entry.id, reason: 'compat layer missing' });
    return;
  }
  try {
    const descriptor = await shim.call('plugin.load', { id: entry.id }) as PluginDescriptor;
    if (!descriptor.manifest) { throw new Error('宿主未下发 manifest'); }
    note('plugin.load.done', { id: descriptor.id, codeBytes: descriptor.code.length, kind: 'obsidian' });
    await obsidianApi.loadPlugin({
      manifest: descriptor.manifest,
      code: descriptor.code,
      token: descriptor.token
    });
    note('plugin.obsidian.ready', {
      id: descriptor.id,
      commands: obsidianApi.commands().length,
      stats: obsidianApi.stats()
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note('plugin.obsidian.error', { id: entry.id, message: message });
  }
}

function waitForProxy(): Promise<HandshakeProxy> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      const proxy = host.__lexiHandshake;
      if (proxy && typeof proxy.hello === 'function') { resolve(proxy); return; }
      if (Date.now() - startedAt > PROXY_TIMEOUT_MS) { reject(new Error('__lexiHandshake 代理未注入')); return; }
      window.setTimeout(tick, 40);
    };
    tick();
  });
}

function waitForPort(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('宿主未在 ' + PORT_TIMEOUT_MS + 'ms 内下发 WebMessagePort'));
    }, PORT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      if (event.data !== PORT_TAG) { return; }
      const ports = event.ports;
      if (!ports || ports.length === 0) { return; }
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(ports[0]);
    };
    window.addEventListener('message', onMessage);
  });
}

function setStatus(text: string): void {
  el('status').textContent = text;
}

async function boot(): Promise<void> {
  view = mountEditor();
  installEditorBridge();
  setStatus('等待宿主握手…');
  note('workspace.page.load', { userAgent: navigator.userAgent.slice(0, 72) });

  const portPromise = waitForPort();
  const proxy = await waitForProxy();
  proxy.hello('workspace-page-boot');
  const port = await portPromise;
  port.onmessage = (event: MessageEvent): void => {
    const raw = typeof event.data === 'string' ? event.data : '';
    shim.handleFrame(raw);
    routeEventFrame(raw);
  };
  port.start();
  framePort = port;
  shim.attach((text: string) => port.postMessage(text));
  shim.setup({
    notice: showNotice,
    getValue: (): string => (view ? view.state.doc.toString() : ''),
    insertText: insertAtCursor,
    log: (topic: string, detail: Record<string, unknown>): void => note(topic, detail)
  });
  flushEarlyNotes();
  note('channel.port.attached', {});

  const ack = await shim.call('channel.hello', { page: 'workspace' }) as { nonce: string; channelId: string };
  const auth = await shim.call('channel.auth', { nonce: ack.nonce }) as AuthData;
  sessionToken = typeof auth.token === 'string' ? auth.token : '';
  if (obsidianApi) { obsidianApi.setSessionToken(sessionToken); }
  shim.setSessionToken(sessionToken);
  installCompatHost();
  if (obsidianApi) {
    await obsidianApi.refreshMetadataGraph();
    // 同步文件索引先热身:插件的 onload 里 getMarkdownFiles() 必须是同步真实列表。
    await obsidianApi.refreshVaultFiles();
  }
  note('channel.auth.ok', {
    channelId: ack.channelId,
    sessionTokenTail: sessionToken.slice(Math.max(0, sessionToken.length - 6))
  });
  // 帧协议自检(批量上限 + 20s 超时)在后台跑,不阻塞插件装载。
  window.setTimeout(() => { void protocolSelfCheck(sessionToken); }, 1500);

  const list = await shim.call('plugin.list', {}) as PluginListResult;
  if (!list.plugins || list.plugins.length === 0) { throw new Error('宿主没有返回任何可装载插件'); }
  const target = list.plugins[0];
  note('plugin.list.done', { count: list.plugins.length, first: target.id });
  const descriptor = await shim.call('plugin.load', { id: target.id }) as PluginDescriptor;
  note('plugin.load.done', { id: descriptor.id, codeBytes: descriptor.code.length });
  await shim.loadPlugin(descriptor);
  mountPluginViews(descriptor.id);

  setStatus('CM6 就绪 · 插件 ' + descriptor.name + ' 已装载');
  note('workspace.ready', {
    editorChars: view.state.doc.length,
    commands: paletteItems().length,
    container: shim.stats()
  });

  for (const entry of list.plugins) {
    if (entry.id === target.id) { continue; }
    await loadObsidianPlugin(entry);
  }

  // 全部插件装载完才算布局就绪:此时它们的 onLayoutReady 都已排队,
  // 放行队列并下推一帧 layout-change(真实插件靠这一帧做首屏刷新)。
  if (obsidianApi) {
    // 视图 creator 都注册完了,现在按上次的布局回放(重启后日历回到同一视图)。
    const restored = await obsidianApi.restoreLayout();
    note('workspace.layout.restore', { leaves: restored });
    await obsidianApi.markLayoutReady().catch(() => {});
    note('workspace.layout.ready', { at: 'after-plugins-loaded' });
  }
}

/** 直接发原始帧并等指定形状的应答:批量上限只能由宿主证明(sendBatch 会先被页面本地拦掉)。 */
function probeRawFrame(text: string, match: (frame: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const port = framePort;
    if (!port) {
      reject(new Error('message port 未就绪'));
      return;
    }
    const timer = window.setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error('原始帧探测超时 ' + timeoutMs + 'ms'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (raw.length === 0) { return; }
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      if (!match(frame)) { return; }
      port.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(frame);
    };
    port.addEventListener('message', onMessage);
    port.postMessage(text);
  });
}

function batchFrame(count: number, token: string): string {
  const calls: { id: string; method: string; payload: Record<string, unknown> }[] = [];
  for (let i = 0; i < count; i++) {
    calls.push({ id: 'bc' + i, method: 'log.event', payload: { topic: 'frame.batch.probe', detail: { i: i } } });
  }
  return JSON.stringify({ v: 1, token: token, calls: calls });
}

/** spec section 2 回归自检:批量 ≤64 与 20s 超时都必须有明确结果,不能静默挂死。 */
/** 负向:payload 里自称的 pluginId 必须被宿主的 token 身份覆盖。 */
async function identitySelfCheck(token: string): Promise<void> {
  // 负向证据:同一帧里既带合法 token 又带伪造 pluginId,宿主必须用 token 反查出的身份。
  // 用插件级 token(不是页面 token),日志里 identity=<插件 id> 才能证明伪造值被忽略。
  let pluginToken = token;
  let pluginId = '';
  try {
    const descriptor = await shim.call('plugin.load', { id: 'compat-probe' }) as { id: string; token: string };
    if (descriptor && typeof descriptor.token === 'string') {
      pluginToken = descriptor.token;
      pluginId = descriptor.id;
    }
  } catch (err) { /* 拿不到插件 token 就退回页面 token,仍能证明 claimed 被忽略 */ }
  const frame = JSON.stringify({
    v: 1,
    id: 'idcheck',
    token: pluginToken,
    method: 'vault.files',
    payload: { pluginId: 'forged-identity' }
  });
  try {
    const reply = await probeRawFrame(frame, (candidate) => candidate.id === 'idcheck', 8000);
    note('frame.identity.selfcheck', {
      ok: reply.ok === true,
      claimed: 'forged-identity',
      tokenIdentity: pluginId,
      tokenTail: pluginToken.slice(Math.max(0, pluginToken.length - 6))
    });
  } catch (err) {
    note('frame.identity.selfcheck', { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function protocolSelfCheck(token: string): Promise<void> {
  await identitySelfCheck(token);
  try {
    const refused = await probeRawFrame(batchFrame(65, token), (frame) => {
      const failure = frame.error as Record<string, unknown> | undefined;
      return !!failure && failure.code === 'batch_overflow';
    }, 8000);
    const accepted = await probeRawFrame(
      batchFrame(64, token),
      (frame) => Array.isArray(frame.calls) && (frame.calls as unknown[]).length === 64,
      8000
    );
    note('frame.batch.selfcheck', {
      overflowCode: (refused.error as Record<string, unknown>).code,
      okReplies: (accepted.calls as unknown[]).length
    });
  } catch (err) {
    note('frame.batch.selfcheck', { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  const started = Date.now();
  try {
    await shim.call('debug.delay', { ms: 21000 });
    note('frame.timeout.selfcheck', { rejected: false, ms: Date.now() - started });
  } catch (err) {
    const failure = err as { code?: string; message?: string };
    note('frame.timeout.selfcheck', {
      rejected: true,
      code: failure.code || '',
      ms: Date.now() - started,
      message: failure.message || ''
    });
  }
}

function driveSelfCheck(): void {
  window.setTimeout(() => openPalette(), 900);
  window.setTimeout(() => {
    const first = document.querySelector('#palette-list .palette-item') as HTMLElement | null;
    if (first) { first.click(); }
  }, 2400);
}

function wireUi(): void {
  el('btn-palette').addEventListener('click', () => openPalette());
  el('btn-notice').addEventListener('click', () => showNotice('页面内置 Notice 自检'));
  el('palette-input').addEventListener('input', (event: Event) => {
    paletteFilter = (event.target as HTMLInputElement).value.trim();
    renderPalette();
  });
  el('palette-input').addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { closePalette(); }
  });
  el('palette').addEventListener('click', (event: MouseEvent) => {
    if (event.target === el('palette')) { closePalette(); }
  });
  el('btn-retry').addEventListener('click', () => window.location.reload());
}

function reportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  bootFailure = message;
  setStatus('启动失败：' + message);
  el('boot-error').hidden = false;
  el('boot-error').textContent = '启动失败：' + message;
  note('workspace.boot.error', { message: message });
}

wireUi();
note('workspace.script.loaded', {});
boot().then(() => driveSelfCheck()).catch((err: unknown) => reportFailure(err));
