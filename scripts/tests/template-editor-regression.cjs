const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root = path.resolve(__dirname, '../../entry/src/main/ets');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = { exports: {} }; cache.set(name, mod.exports);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, 'core', name + '.ets'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})')(s => load(s.slice(2)), mod, mod.exports);
  return mod.exports;
}
const { NoteItem, NoteProperty } = load('LexiModels');
const { LexiTemplateLibrary } = load('LexiTemplateLibrary');
const source = fs.readFileSync(path.join(root, 'pages/NoteEditorPage.ets'), 'utf8');
function methods(start, end) { const first = source.indexOf(start); return source.slice(first, source.indexOf(end, first)); }
const selected = methods('  private async loadFromRoute(', '  private pushHistory(') +
  methods('  private async persistNow(', '  private refreshDerived(') +
  methods('  private mapSavedCursor(', '  private refreshCompletion(') +
  methods('  private leaveEditor(', '  @Builder\n  private pageTitleBar(');
const js = ts.transpileModule('class Subject {' + selected + '}\nmodule.exports=Subject;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
let saved, normalWrites, flushes, pops, template, failSave;
const service = {
  init: async () => {}, getActiveVaultId: async () => 'v', getNotes: async () => [],
  getTemplates: async () => template ? [LexiTemplateLibrary.clone(template)] : [],
  saveNote: async () => { normalWrites++; throw Error('template must never be saved as a workspace note'); },
  saveTemplate: async item => { if (failSave) throw Error('disk failure'); saved = LexiTemplateLibrary.clone(item); saved.updatedAt = Date.now(); return saved; }
};
const mod = { exports: {} };
vm.runInThisContext('(function(module,LexiStorageService,LexiTemplateLibrary,NoteItem,NoteProperty){' + js + '\n})')(mod, service, LexiTemplateLibrary, NoteItem, NoteProperty);
function subject() {
  saved = undefined; normalWrites = 0; flushes = 0; pops = 0; failSave = false;
  template = LexiTemplateLibrary.builtins()[0];
  const s = new mod.exports();
  Object.assign(s, { note: new NoteItem(), templateMode: false, editorTier: 'pro', editRevision: 0,
    titleText: '', contentText: '', notebookText: '', selectionStart: 0, selectionEnd: 0, leavingEditor: false,
    context: () => ({}), refreshDerived() {}, anchorRequested() {}, toast() {},
    liveController: { finishEditing() { flushes++; } }, pathStack: { pop() { pops++; } } });
  return s;
}
(async () => {
  const s = subject(); await s.loadFromRoute({ templateId: template.id });
  assert.equal(s.templateMode, true); assert.equal(s.note.id, template.id); assert.equal(normalWrites, 0);
  s.titleText = '自定义日记'; s.contentText = '# {{date}}\n\n- [ ] 今天的任务'; s.notebookText = '日常';
  await s.persistNow(); assert.equal(saved.title, '自定义日记'); assert.equal(saved.content, s.contentText);
  assert.equal(saved.category, '日常'); assert.equal(normalWrites, 0); assert.match(s.saveStatus, /模板已保存/);
  s.leaveEditor(); await new Promise(resolve => setImmediate(resolve)); assert.equal(flushes, 1); assert.equal(pops, 1);
  const failed = subject(); await failed.loadFromRoute({ templateId: template.id }); failSave = true;
  failed.contentText = '保留此草稿'; failed.leaveEditor(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pops, 0); assert.equal(failed.leavingEditor, false); assert.equal(failed.contentText, '保留此草稿'); assert.equal(normalWrites, 0);
  const missing = subject(); template = undefined; await missing.loadFromRoute({ templateId: 'missing' });
  assert.equal(pops, 1); assert.equal(normalWrites, 0);
  console.log('PASS ordinary editor template route, isolated autosave, flush on return, failed save retention and missing template handling');
})().catch(error => { console.error(error); process.exitCode = 1; });
