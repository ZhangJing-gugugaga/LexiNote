/**
 * lexinote plugin API — stable contract for plugins written against LexiNote.
 *
 * Scope: only APIs implemented by the host runtime are declared here. Anything absent
 * (Modal/Menu/Suggest/Setting builders, code block processors, Bases, CM6 extensions)
 * is intentionally not declared yet — a type error is better than a runtime surprise.
 *
 * Import style (aliases are interchangeable):
 *   import { Plugin, Notice } from 'lexinote';
 *   const { Plugin, Notice } = require('obsidian');
 */

/* ------------------------------------------------------------------ DOM helpers (view slots) */

export interface DomElementInfo {
    cls?: string | string[];
    text?: string | DocumentFragment;
    attr?: Record<string, string | number | boolean | null>;
    title?: string;
    placeholder?: string;
    href?: string;
    value?: string;
}

declare global {
    interface Node {
        createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomElementInfo, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
        createDiv(o?: DomElementInfo, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
        createSpan(o?: DomElementInfo, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
        appendText(text: string): void;
        detach(): void;
        empty(): void;
    }
    interface Element {
        getText(): string;
        setText(value: string): void;
        addClass(...cls: string[]): void;
        removeClass(...cls: string[]): void;
        toggleClass(cls: string | string[], value: boolean): void;
        hasClass(cls: string): boolean;
        setAttr(name: string, value: string | number | boolean | null): void;
        setAttrs(attrs: Record<string, string | number | boolean | null>): void;
        getAttr(name: string): string | null;
    }
    interface HTMLElement {
        onClickEvent(listener: (evt: MouseEvent) => unknown): this;
        show(): void;
        hide(): void;
        toggle(show: boolean): void;
        setCssStyles(styles: Record<string, string>): void;
        setCssProps(props: Record<string, string>): void;
        on(type: string, selector: string, listener: (evt: Event, target: HTMLElement) => unknown, options?: object): void;
    }
    function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomElementInfo, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
    function createDiv(o?: DomElementInfo, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
    function createSpan(o?: DomElementInfo, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
}

/* ------------------------------------------------------------------ manifest */

export interface PluginManifest {
    id: string;
    name: string;
    author: string;
    version: string;
    minAppVersion: string;
    description: string;
    authorUrl?: string;
    isDesktopOnly?: boolean;
}

/* ------------------------------------------------------------------ lifecycle */

export interface EventRef {
    off(): void;
}

export abstract class Component {
    load(): Promise<void> | void;
    onload(): Promise<void> | void;
    unload(): void;
    onunload(): void;
    addChild<T extends Component>(child: T): T;
    register(cleanup: () => void): void;
    registerEvent(eventRef: EventRef): void;
    registerDomEvent(el: HTMLElement | Document | Window, type: string, callback: (evt: Event) => void, options?: object): void;
    registerInterval(id: number): number;
}

export interface Hotkey {
    modifiers: string[];
    key: string;
}

export interface Command {
    id: string;
    name: string;
    icon?: string;
    hotkeys?: Hotkey[];
    callback?: () => void | Promise<void>;
    checkCallback?: (checking: boolean) => boolean;
    editorCallback?: (editor: Editor, ctx: MarkdownFileInfo) => void | Promise<void>;
}

export abstract class Plugin extends Component {
    app: App;
    manifest: PluginManifest;
    constructor(app: App, manifest: PluginManifest);
    addCommand(command: Command): Command;
    removeCommand(commandId: string): void;
    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement | null;
    addStatusBarItem(): { setText(text: string): void };
    addSettingTab(settingTab: PluginSettingTab): void;
    registerView(type: string, creator: ViewCreator): void;
    registerMarkdownPostProcessor(postProcessor: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => unknown): unknown;
    registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => unknown, sortOrder?: number): unknown;
    registerEditorSuggest(editorSuggest: unknown): void;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    onUserEnable(): void;
    onExternalSettingsChange?(): unknown;
}

/* ------------------------------------------------------------------ files */

export interface DataWriteOptions {
    ctime?: number;
    mtime?: number;
}

export interface FileStats {
    ctime: number;
    mtime: number;
    size: number;
}

export abstract class TAbstractFile {
    path: string;
    name: string;
    parent: TFolder | null;
}

export class TFile extends TAbstractFile {
    basename: string;
    extension: string;
    stat: FileStats;
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[];
    isRoot(): boolean;
}

export class Vault {
    on(name: 'create', callback: (file: TAbstractFile) => unknown, ctx?: unknown): EventRef;
    on(name: 'modify', callback: (file: TAbstractFile) => unknown, ctx?: unknown): EventRef;
    on(name: 'delete', callback: (file: TAbstractFile) => unknown, ctx?: unknown): EventRef;
    on(name: 'rename', callback: (file: TAbstractFile, oldPath: string) => unknown, ctx?: unknown): EventRef;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    getFileByPath(path: string): TFile | null;
    getFolderByPath(path: string): TFolder | null;
    getMarkdownFiles(): Promise<TFile[]>;
    getFiles(): Promise<TFile[]>;
    getRoot(): TFolder;
    read(file: TFile): Promise<string>;
    cachedRead(file: TFile): Promise<string>;
    modify(file: TFile, data: string): Promise<void>;
    create(path: string, data: string): Promise<TFile>;
    append(file: TFile, data: string): Promise<void>;
    process(file: TFile, fn: (data: string) => string): Promise<string>;
    delete(file: TAbstractFile, force?: boolean): Promise<void>;
    trash(file: TAbstractFile, system: boolean): Promise<void>;
    rename(file: TAbstractFile, newPath: string): Promise<void>;
    getResourcePath(file: TFile): string;
}

/* ------------------------------------------------------------------ metadata */

export interface Loc {
    line: number;
    col: number;
    offset: number;
}

export interface Pos {
    start: Loc;
    end: Loc;
}

export interface HeadingCache {
    heading: string;
    level: number;
    position: Pos;
}

export interface LinkCache {
    link: string;
    original: string;
    displayText: string;
    position: Pos;
}

export interface TagCache {
    tag: string;
    position: Pos;
}

export interface SectionCache {
    id: string;
    type: string;
    position: Pos;
}

export interface CachedMetadata {
    headings?: HeadingCache[] | null;
    links?: LinkCache[] | null;
    tags?: TagCache[] | null;
    sections?: SectionCache[] | null;
    frontmatter?: Record<string, unknown> | null;
    frontmatterPosition?: Pos | null;
}

export class MetadataCache {
    on(name: 'changed', callback: (file: TFile, data: string, cache: CachedMetadata) => unknown, ctx?: unknown): EventRef;
    on(name: 'deleted', callback: (file: TFile, prevCache: CachedMetadata | null) => unknown, ctx?: unknown): EventRef;
    on(name: 'resolved', callback: () => unknown, ctx?: unknown): EventRef;
    getFileCache(file: TFile): Promise<CachedMetadata | null>;
    getCache(path: string): Promise<CachedMetadata | null>;
    getFirstLinkpathDest(linkpath: string, sourcePath: string): Promise<TFile | null>;
    fileToLinktext(file: TFile, sourcePath: string, omitMdExtension?: boolean): string;
    resolvedLinks(): Promise<Record<string, Record<string, number>>>;
}

/* ------------------------------------------------------------------ editor */

export interface EditorPosition {
    line: number;
    ch: number;
}

export interface EditorRange {
    from: EditorPosition;
    to: EditorPosition;
}

export interface EditorSelection {
    anchor: EditorPosition;
    head: EditorPosition;
}

/**
 * Editor API v1: single-selection, offset based. Read methods are synchronous
 * (snapshot), write methods return promises that resolve after the host applied them.
 * Unsupported: undo/redo/exec/transaction/processLines/scroll.
 */
export abstract class Editor {
    getValue(): string;
    setValue(content: string): Promise<unknown>;
    getSelection(): string;
    somethingSelected(): boolean;
    replaceSelection(replacement: string): Promise<unknown>;
    replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition): Promise<unknown>;
    getRange(from: EditorPosition, to: EditorPosition): string;
    getLine(line: number): string;
    lineCount(): number;
    lastLine(): number;
    getCursor(side?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition;
    setCursor(pos: EditorPosition | number, ch?: number): Promise<unknown>;
    setSelection(anchor: EditorPosition, head?: EditorPosition): Promise<unknown>;
    setSelections(ranges: EditorSelection[], main?: number): Promise<unknown>;
    listSelections(): EditorSelection[];
    posToOffset(pos: EditorPosition): number;
    offsetToPos(offset: number): EditorPosition;
    focus(): void;
    blur(): void;
    hasFocus(): boolean;
    getScrollInfo(): { top: number; left: number };
    scrollTo(x?: number | null, y?: number | null): void;
    scrollIntoView(range: EditorRange, center?: boolean): void;
    wordAt(pos: EditorPosition): EditorRange | null;
    transaction(transaction: EditorTransaction, origin?: string): Promise<unknown>;
}

export interface EditorChange extends EditorRangeOrCaret {
    text: string;
}

export interface EditorRangeOrCaret {
    from: EditorPosition;
    to?: EditorPosition;
}

export interface EditorTransaction {
    replaceSelection?: string;
    changes?: EditorChange[];
    selections?: EditorRangeOrCaret[];
    selection?: EditorRangeOrCaret;
}

export interface MarkdownFileInfo {
    app: App;
    file: TFile | null;
    editor?: Editor;
}

/* ------------------------------------------------------------------ workspace & views */

export interface ViewState {
    type: string;
    state?: Record<string, unknown>;
    active?: boolean;
    pinned?: boolean;
}

export abstract class View extends Component {
    app: App;
    leaf: WorkspaceLeaf;
    containerEl: HTMLElement;
    getViewType(): string;
    getDisplayText(): string;
    getIcon(): string;
    onOpen(): Promise<void> | void;
    onClose(): Promise<void> | void;
    getState(): Record<string, unknown>;
    setState(state: unknown, result?: unknown): Promise<void>;
}

export abstract class ItemView extends View {
    contentEl: HTMLElement;
    constructor(leaf: WorkspaceLeaf);
}

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export class WorkspaceLeaf {
    view: View | null;
    getViewState(): ViewState;
    setViewState(state: ViewState): Promise<unknown>;
    openFile(file: TFile, openState?: unknown): Promise<void>;
    detach(): Promise<unknown>;
    getDisplayText(): string;
    getIcon(): string;
}

export class Workspace {
    activeEditor: MarkdownFileInfo | null;
    on(name: 'active-leaf-change', callback: (leaf: WorkspaceLeaf | null) => unknown, ctx?: unknown): EventRef;
    on(name: 'file-open', callback: (file: TFile | null) => unknown, ctx?: unknown): EventRef;
    on(name: 'layout-change', callback: () => unknown, ctx?: unknown): EventRef;
    on(name: 'editor-change', callback: (editor: Editor, info: MarkdownFileInfo) => unknown, ctx?: unknown): EventRef;
    on(name: 'css-change', callback: () => unknown, ctx?: unknown): EventRef;
    getActiveFile(): Promise<TFile | null>;
    getRightLeaf(split: boolean): WorkspaceLeaf;
    getLeaf(newLeaf?: 'tab' | 'split' | boolean): WorkspaceLeaf;
    getLeavesOfType(viewType: string): Promise<WorkspaceLeaf[]>;
    detachLeavesOfType(viewType: string): Promise<unknown>;
    revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
}

/* ------------------------------------------------------------------ app & ui primitives */

export class App {
    vault: Vault;
    metadataCache: MetadataCache;
    workspace: Workspace;
    isDarkMode(): Promise<boolean>;
}

export class Notice {
    constructor(message: string, duration?: number);
    setMessage(message: string): this;
    hide(): void;
}

export interface SettingDefinitionItem {
    type: 'heading' | 'toggle' | 'text' | 'textarea' | 'dropdown' | 'slider';
    name: string;
    key?: string;
    desc?: string;
    default?: string | number | boolean;
    options?: Record<string, string>;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
}

/**
 * Declarative settings tab. `getSettingDefinitions()` is serialized to the host and
 * rendered with native controls; values persist in data.json and are pushed back to
 * `setControlValue(key, value)` / `onSettingsChanged(values)`.
 */
export abstract class PluginSettingTab {
    app: App;
    plugin: Plugin;
    constructor(app: App, plugin: Plugin);
    getSettingDefinitions(): SettingDefinitionItem[];
    getControlValue(key: string): unknown;
    setControlValue(key: string, value: unknown): void;
    onSettingsChanged(values: Record<string, unknown>): void;
    display(): void;
    hide(): void;
}

export interface MarkdownPostProcessorContext {
    docId: string;
    sourcePath: string;
    frontmatter: unknown;
    addChild(child: Component): void;
    getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

/* ------------------------------------------------------------------ utilities */

/** Compact moment-compatible surface provided by the runtime. */
export interface MomentLike {
    format(pattern?: string): string;
    add(amount: number, unit: string): MomentLike;
    subtract(amount: number, unit: string): MomentLike;
    startOf(unit: string): MomentLike;
    diff(other: MomentLike | Date | number | string, unit?: string): number;
    valueOf(): number;
    unix(): number;
    toDate(): Date;
    toISOString(): string;
    isBefore(other: MomentLike | Date | number | string): boolean;
    isAfter(other: MomentLike | Date | number | string): boolean;
    clone(): MomentLike;
}
export function moment(input?: string | number | Date | MomentLike): MomentLike;
export function normalizePath(path: string): string;
export function requestUrl(request: string | { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    json: unknown;
    arrayBuffer: Promise<ArrayBuffer>;
}>;
export function debounce<T extends unknown[], V>(cb: (...args: T) => V, timeout?: number): ((...args: T) => void) & { cancel(): void };
export function sleep(ms: number): Promise<void>;
export function prepareFuzzySearch(query: string): (text: string) => { score: number; matches: [number, number][] } | null;
export const apiVersion: string;
export const Platform: {
    isMobile: boolean;
    isPhone: boolean;
    isTablet: boolean;
    isDesktop: boolean;
    isMobileApp: boolean;
    isDesktopApp: boolean;
    isMacOS: boolean;
    isWin: boolean;
    isLinux: boolean;
    resourcePathPrefix: string;
};
