const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root = path.resolve(__dirname, '../../entry/src/main/ets');
function section(source, start, end) { const a = source.indexOf(start); return source.slice(a, source.indexOf(end, a)); }
function subject(methods, service = {}) {
  const js = ts.transpileModule('class Subject {' + methods + '}\nmodule.exports=Subject;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = { exports: {} };
  const markdown = { buildNoteLinks: () => [], findUnlinkedMentions: () => [] };
  vm.runInThisContext('(function(module,LexiStorageService,MarkdownEngine,Edge){' + js + '\n})')(mod, service, markdown, { Top: 0 });
  return new mod.exports();
}
const homeSource = fs.readFileSync(path.join(root, 'components/LexiHomeTab.ets'), 'utf8');
const home = subject(section(homeSource, '  private recompute()', '  private greeting()'));
const a = { id: 'a', trashedAt: 0, updatedAt: 1, pinned: false };
const b = { id: 'b', trashedAt: 0, updatedAt: 2, pinned: false };
home.notes = [a, b]; home.links = [{ sourceId: 'a', targetId: 'b' }, { sourceId: 'a', targetId: '' }, { sourceId: 'outside', targetId: 'b' }];
home.recompute(); assert.equal(home.activeList.length, 2); assert.equal(home.resolvedLinks, 1);
assert.equal(home.backlinkCount('b'), 1); assert.equal(home.outgoingCount('a'), 1);
home.notes = [a, { ...b, trashedAt: 10 }]; home.recompute();
assert.equal(home.activeList.length, 1); assert.equal(home.resolvedLinks, 0);
home.notes = [a, b, { id: 'c', trashedAt: 0, updatedAt: 3, pinned: true }]; home.recompute();
assert.equal(home.activeList.length, 3); assert.equal(home.pinnedList[0].id, 'c'); assert.equal(home.recentList[0].id, 'b');
home.notes = []; home.recompute(); assert.equal(home.activeList.length, 0); assert.equal(home.resolvedLinks, 0);
console.log('PASS homepage counts follow create/trash/restore/delete and exclude unresolved or out-of-scope links');

const indexSource = fs.readFileSync(path.join(root, 'pages/Index.ets'), 'utf8');
const scopes = section(indexSource, '  private activeNotes()', '  private trashedNotes()') +
  section(indexSource, '  private projectNotes()', '  private activeProjectName()');
let resolveOld, readCount = 0;
const service = { flushPendingWrites: async () => {}, getVaults: async () => [{ id: 'v' }], getActiveVaultId: async () => 'v',
  getProjects: async () => [{ id: 'p' }], getActiveProjectId: async () => 'p',
  getNotes: async () => ++readCount === 1 ? await new Promise(resolve => { resolveOld = resolve; }) : [{ ...b, projectId: 'p' }],
  getMindMaps: async () => [], getCanvases: async () => [], getSetting: async () => 'b' };
const parent = subject(scopes + section(indexSource, '  private async refresh()', '  private async rebuildGraph()') +
  section(indexSource, '  private activateTab(', '  private tabTitle('), service);
Object.assign(parent, { refreshSequence: 0, projects: [{ id: 'p' }], activeProjectId: 'p',
  notes: [{ ...a, projectId: 'p' }, { ...b, projectId: 'other' }], maps: [{ id: 'map-p', projectId: 'p', trashedAt: 0 }, { id: 'map-other', projectId: 'other', trashedAt: 0 }],
  canvases: [{ id: 'board-p', projectId: 'p' }, { id: 'board-other', projectId: 'other' }], rebuildGraph() {}, syncDesktopCards() {} });
assert.equal(parent.activeNotes().length, 1); assert.equal(parent.projectMaps().length, 1); assert.equal(parent.projectCanvases().length, 1);
(async () => {
  const old = parent.refresh(); while (!resolveOld) await new Promise(resolve => setImmediate(resolve));
  await parent.refresh(); assert.equal(parent.notes[0].id, 'b');
  resolveOld([{ ...a, projectId: 'p' }]); await old;
  assert.equal(parent.notes[0].id, 'b', 'an older refresh must not overwrite a later published snapshot');
  let refreshed = 0; parent.refresh = async () => { refreshed++; };
  parent.ready = true; parent.tabScrollers = [{ scrollEdge() {} }, { scrollEdge() {} }];
  parent.activateTab(0); assert.equal(refreshed, 1); parent.activateTab(1); assert.equal(refreshed, 1);
  console.log('PASS project-scoped metrics, latest refresh wins, and returning home requests a fresh snapshot');
})().catch(error => { console.error(error); process.exitCode = 1; });
