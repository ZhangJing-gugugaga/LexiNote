// Run the real card route, editor draft/save and voice insertion methods with native storage mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root = path.resolve(__dirname, '../../entry/src/main/ets');
const editorSource = fs.readFileSync(path.join(root, 'pages/NoteEditorPage.ets'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'pages/Index.ets'), 'utf8');
const coreCache = new Map();
function loadCore(name) {
  if (coreCache.has(name)) return coreCache.get(name);
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, 'core', name + '.ets'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})')(
    spec => spec.startsWith('./') ? loadCore(spec.slice(2)) : {}, module, module.exports
  );
  coreCache.set(name, module.exports);
  return module.exports;
}
const { NoteItem, NoteProperty, NoteEditorRouteParam } = loadCore('LexiModels');
const { LexiFrontmatter } = loadCore('LexiFrontmatter');
function section(source, start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, start);
  const stop = source.indexOf(end, at);
  assert.ok(stop > at, end);
  return source.slice(at, stop);
}
const cardRoute = section(indexSource,
  "            if (request.lexiFormAction === 'quick' || request.lexiFormAction === 'voice') {",
  "else if (request.lexiFormAction === 'daily')");
const editorMethods =
  section(editorSource, '  private async loadFromRoute(', '  private templateNote(') +
  section(editorSource, '  private scheduleSave(', '  private refreshDerived(') +
  section(editorSource, '  private finishLoadingRoute(', '  @Builder\n  private assistantSheet(') +
  section(editorSource, '  private mapSavedCursor(', '  private refreshCompletion(') +
  section(editorSource, '  private leaveEditor(', '  @Builder\n  private pageTitleBar(');
const frame = section(editorSource,
  'class LexiNoteEditorFrame extends FrameCallback', 'interface LexiNotePopupState');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tests = [];
function test(name, run) { tests.push([name, run]); }

function harness() {
  const notes = new Map();
  const calls = [];
  const timers = new Map();
  const frames = [];
  let timerId = 0;
  let beforeCreate;
  let failCreate = false;
  let reads = 0;
  const service = {
    async init() {},
    async getActiveVaultId() { return 'vault'; },
    async getActiveProjectId() { return 'project'; },
    async getNotes(vault) { return [...notes.values()].filter(note => note.vaultId === vault).map(clone); },
    async getNoteById(id) { reads++; return clone(notes.get(id)); },
    async saveNote(_context, snapshot) {
      calls.push(['create-attempt', clone(snapshot)]);
      if (beforeCreate) await beforeCreate();
      if (failCreate) throw Error('disk failure');
      const saved = clone(snapshot);
      if (!saved.id) saved.id = crypto.randomUUID();
      saved.createdAt = saved.createdAt || 100;
      saved.updatedAt = 100;
      saved.path = '/vault/notes/' + saved.id + '.md';
      saved.content = LexiFrontmatter.serialize(saved);
      notes.set(saved.id, clone(saved));
      calls.push(['create', clone(saved)]);
      return saved;
    },
    async saveNoteIfCurrent(_context, snapshot, title, content) {
      const previous = notes.get(snapshot.id);
      if (!previous || previous.title !== title || previous.content !== content) throw Error('DOCUMENT_CHANGED_ELSEWHERE');
      const saved = clone(snapshot);
      saved.updatedAt = previous.updatedAt + 1;
      saved.content = LexiFrontmatter.serialize(saved);
      notes.set(saved.id, clone(saved));
      calls.push(['update', clone(saved)]);
      return saved;
    }
  };
  const sandbox = {
    NoteItem, NoteProperty, NoteEditorRouteParam, LexiFrontmatter,
    util: { generateRandomUUID: () => crypto.randomUUID() },
    FrameCallback: class {},
    LexiStorageService: service,
    MarkdownEngine: { parseBlocks: () => [], extractOutline: () => [] },
    LexiContinuationSession: {
      activate() { calls.push(['continuation']); },
      deactivate() { calls.push(['deactivate']); }
    },
    LexiContinuationData: { capture: () => ({}) },
    setTimeout(callback, delay) { const id = ++timerId; if (delay === 0) frames.push({ onIdle: callback }); else timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.createContext(sandbox);
  const js = ts.transpileModule(frame + '\nclass Editor {' + editorMethods +
    '}; class CardRoute { open(request) { const vaultId = "vault"; ' + cardRoute +
    '} };globalThis.Editor=Editor;globalThis.CardRoute=CardRoute;', {
    compilerOptions: { target: ts.ScriptTarget.ES2021 }
  }).outputText;
  vm.runInContext(js, sandbox);
  const ui = {
    postFrameCallback: callback => frames.push(callback),
    showAlertDialog: dialog => calls.push(['dialog', dialog])
  };
  const page = new sandbox.Editor();
  Object.assign(page, {
    note: new NoteItem(), deferredCreation: false, templateMode: false, externalFileMode: false,
    titleText: '', contentText: '', notebookText: '笔记', editorTier: 'simple', viewMode: 'live',
    baseTitle: '', baseContent: '', editRevision: 0, savedEditRevision: 0, pendingSave: undefined,
    pageAttached: true, pageVisible: true, pageLoaded: false, abilityForeground: true,
    conflictResolving: false, conflictVisible: false, externalReadRevision: 0, leavingEditor: false,
    continuationOwner: 'owner', pendingRouteRestore: false, focusRevision: 0,
    selectionStart: 0, selectionEnd: 0, saveTimer: -1, showOutlinePanel: false,
    showToolsPanel: false, showAssistantPanel: false, pendingAssistantOpen: false,
    pendingAssistantSnippet: '', pendingToolSnippet: '', completionItems: [], allVaultNotes: [],
    context: () => ({ abilityInfo: { name: 'EntryAbility' } }), getUIContext: () => ui,
    liveController: { finishEditing() { calls.push(['finish-editing']); } },
    pathStack: { pop() { calls.push(['pop']); } },
    refreshDerived() {}, anchorRequested() {},
    pushHistory() { calls.push(['history']); },
    restoreEditorSelection(start, end, content, focus) { calls.push(['restore', start, end, content, focus]); },
    toast(message) { calls.push(['toast', message]); }
  });
  const route = new sandbox.CardRoute();
  Object.assign(route, {
    activeProjectId: 'project', defaultTier: 'simple',
    pathStack: { pushPathByName(name, param) { calls.push(['route', name, param]); } }
  });
  function flushFrames() { while (frames.length) frames.shift().onIdle(1); }
  async function settle() { for (let index = 0; index < 16; index++) await Promise.resolve(); }
  async function load(kind = 'quick') {
    route.open({ lexiFormAction: kind });
    const param = calls.find(call => call[0] === 'route')[2];
    await page.loadFromRoute(param);
    flushFrames();
    return param;
  }
  async function flushTimers() {
    const pending = [...timers.values()];
    timers.clear();
    for (const timer of pending) timer();
    await settle();
    if (page.pendingSave) await page.pendingSave;
  }
  function input(content, title = '') {
    page.contentText = content;
    page.titleText = title;
    page.scheduleSave();
  }
  return {
    page, calls, notes, load, input, flushFrames, settle, flushTimers, service,
    get reads() { return reads; },
    set beforeCreate(callback) { beforeCreate = callback; },
    set failCreate(fail) { failCreate = fail; }
  };
}

test('quick and voice card routes opt into deferred creation without changing the ordinary route default', async () => {
  assert.equal(new NoteEditorRouteParam().deferCreationUntilInput, false);
  for (const kind of ['quick', 'voice']) {
    const h = harness();
    const param = await h.load(kind);
    assert.equal(param.deferCreationUntilInput, true, kind);
    assert.equal(param.launchAssistant, kind === 'voice');
    assert.equal(h.calls.filter(call => call[0] === 'create-attempt').length, 0);
    assert.equal(h.notes.size, 0);
    assert.ok(h.page.note.id, 'the editor has an identity before any file is written');
    assert.equal(h.page.note.path, '');
    assert.equal(h.page.deferredCreation, true);
    assert.equal(h.calls.filter(call => call[0] === 'continuation').length, 0);
  }
});

test('returning from an untouched or whitespace-only card draft never creates a file', async () => {
  for (const kind of ['quick', 'voice']) for (const content of ['', ' \n\t\r\n']) {
    const h = harness();
    await h.load(kind);
    if (content) h.input(content, ' \t');
    await h.flushTimers();
    h.page.leaveEditor();
    await h.settle();
    assert.equal(h.notes.size, 0, kind);
    assert.equal(h.calls.filter(call => call[0] === 'create-attempt').length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'pop').length, 1);
  }
});

test('opening or cancelling voice capture without confirming insertion keeps an empty card draft ephemeral', async () => {
  const h = harness();
  await h.load('voice');
  assert.equal(h.page.showAssistantPanel, true);
  h.page.showAssistantPanel = false;
  h.page.assistantDisappeared();
  await h.page.persistNow();
  h.page.requestAssistant();
  h.flushFrames();
  h.page.showAssistantPanel = false;
  h.page.assistantDisappeared();
  h.page.leaveEditor();
  await h.settle();
  assert.equal(h.notes.size, 0);
  assert.equal(h.calls.filter(call => call[0] === 'create-attempt').length, 0);
  assert.equal(h.page.contentText, '');
});

test('confirmed voice text is inserted at the draft cursor and creates exactly one note after sheet dismissal', async () => {
  const h = harness();
  await h.load('voice');
  const id = h.page.note.id;
  h.page.queueAssistantInsertion('\n\n语音识别的文字\n');
  assert.equal(h.page.contentText, '');
  assert.equal(h.notes.size, 0);
  h.page.assistantDisappeared();
  assert.match(h.page.contentText, /语音识别的文字/);
  await h.flushTimers();
  assert.equal(h.notes.size, 1);
  assert.equal(h.page.note.id, id);
  assert.equal(h.page.deferredCreation, false);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'update').length, 0);
  await h.page.persistNow();
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
});

test('nonempty body or an explicitly entered title creates the draft on its first automatic save', async () => {
  for (const [body, title] of [['正文', ''], ['', '用户填写的标题']]) {
    const h = harness();
    await h.load();
    h.input(body, title);
    await h.flushTimers();
    assert.equal(h.notes.size, 1);
    const saved = [...h.notes.values()][0];
    assert.equal(saved.content, body);
    assert.equal(saved.title, title);
    assert.equal(saved.projectId, 'project');
    assert.equal(saved.vaultId, 'vault');
    assert.equal(h.page.hasUnsavedChanges(), false);
  }
});

test('clearing input before the first automatic save leaves no empty note', async () => {
  const h = harness();
  await h.load();
  h.input('曾经输入的文字');
  h.input('  \n');
  await h.flushTimers();
  await h.page.persistNow();
  assert.equal(h.notes.size, 0);
  assert.equal(h.calls.filter(call => call[0] === 'create-attempt').length, 0);
});

test('metadata and editor settings alone do not create an empty card note', async () => {
  const h = harness();
  await h.load();
  h.page.editorTier = 'pro';
  h.page.notebookText = '修改分类';
  h.page.note.tags = ['标签'];
  h.page.note.properties = [new NoteProperty('状态', '草稿')];
  h.page.scheduleSave();
  await h.flushTimers();
  await h.page.persistNow();
  assert.equal(h.notes.size, 0);
  assert.equal(h.calls.filter(call => call[0] === 'create-attempt').length, 0);
});

test('overlapping first saves use one creation then conditionally save the later input to the same note', async () => {
  const h = harness();
  await h.load();
  let release;
  h.beforeCreate = () => new Promise(resolve => { release = resolve; });
  h.input('第一份输入');
  const first = h.page.persistNow();
  await h.settle();
  assert.equal(typeof release, 'function');
  h.input('保存过程中的新输入');
  const second = h.page.persistNow();
  release();
  await Promise.all([first, second]);
  assert.equal(h.notes.size, 1);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'update').length, 1);
  assert.equal([...h.notes.values()][0].content, '保存过程中的新输入');
  assert.equal(h.page.hasUnsavedChanges(), false);
});

test('failed first creation retains the draft identity, text and retry path', async () => {
  const h = harness();
  await h.load();
  const id = h.page.note.id;
  h.input('不能丢失的输入');
  h.failCreate = true;
  await assert.rejects(h.page.persistNow(), /disk failure/);
  assert.equal(h.page.deferredCreation, true);
  assert.equal(h.page.note.id, id);
  assert.equal(h.page.contentText, '不能丢失的输入');
  assert.equal(h.page.pendingSave, undefined);
  assert.equal(h.notes.size, 0);
  h.failCreate = false;
  await h.page.persistNow();
  assert.equal(h.notes.size, 1);
  assert.equal(h.page.note.id, id);
  assert.equal(h.page.deferredCreation, false);
});

test('after creation normal conditional saves still preserve external changes and the local draft', async () => {
  const h = harness();
  await h.load();
  h.input('已经保存的输入');
  await h.page.persistNow();
  const saved = h.notes.get(h.page.note.id);
  saved.content = '其他窗口修改';
  h.input('本机最新输入');
  await assert.rejects(h.page.persistNow(), /DOCUMENT_CHANGED_ELSEWHERE/);
  assert.equal(h.notes.get(h.page.note.id).content, '其他窗口修改');
  assert.equal(h.page.contentText, '本机最新输入');
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'dialog').length, 1);
});

test('foreground refresh never treats an unsaved card draft as a deleted file', async () => {
  for (const kind of ['quick', 'voice']) {
    const h = harness();
    await h.load(kind);
    const status = h.page.saveStatus;
    await h.page.refreshExternalNote();
    assert.equal(h.reads, 0);
    assert.equal(h.page.saveStatus, status);
    assert.doesNotMatch(h.page.saveStatus, /移除/);
    assert.equal(h.notes.size, 0);
  }
});

(async () => {
  for (const [name, run] of tests) {
    await run();
    console.log('PASS ' + name);
  }
  console.log(`${tests.length} card draft regression groups passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
