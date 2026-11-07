// Cross-app Phase 2 linkage regression checks across LumiKit, LexiNote, and LexiGlow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');

const lexiNoteCore = path.resolve(__dirname, '../../entry/src/main/ets/core');
const lexiGlowRoot = path.resolve(__dirname, '../../../LexiGlow/entry/src/main/ets');
const lumiKitRoot = path.resolve(__dirname, '../../../LumiKit/entry/src/main/ets');

const files = new Map();
const dirs = new Set();
const handles = new Map();
const notes = new Map();
let saveCalls = 0;
let sharePayload = [];

class FakeLocalStorage {
  constructor() { this.values = new Map(); }
  setOrCreate(k, v) { this.values.set(k, v); }
  set(k, v) { this.values.set(k, v); }
  get(k) { return this.values.get(k); }
}

const nativeFs = {
  accessSync: p => files.has(p) || dirs.has(p),
  mkdirSync: p => dirs.add(p),
  statSync: p => ({ size: Buffer.byteLength(files.get(p) || '') }),
  lstatSync: p => ({ isFile: () => files.has(p), isSymbolicLink: () => false }),
  readTextSync: p => files.get(p),
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4, READ_ONLY: 0 },
  openSync(p) { const fd = handles.size + 1; handles.set(fd, p); return { fd }; },
  writeSync(fd, text) { files.set(handles.get(fd), text); },
  fsyncSync() {},
  closeSync() {},
  renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
  unlinkSync: p => files.delete(p),
  async open(p) { const fd = handles.size + 1; handles.set(fd, p); return { fd }; },
  async write(fd, text) { files.set(handles.get(fd), text); },
  async close() {}
};

let vaultsList = [{ id: 'v', name: 'Vault', archived: false }];
let activeVaultId = 'v';

const store = {
  async init() {},
  async getVaults() { return vaultsList.map(v => JSON.parse(JSON.stringify(v))); },
  async getProjects() { return [{ id: 'p', vaultId: 'v' }]; },
  async setActiveVaultId(id) { activeVaultId = id; },
  async setActiveProjectId() {},
  async updateScope(_kind, id, name, _fav, archived) {
    const v = vaultsList.find(x => x.id === id);
    if (v) { if (name) v.name = name; if (archived !== undefined) v.archived = archived; }
  },
  async createVault(_context, name, description) {
    const created = { id: 'vault-' + (vaultsList.length + 1), name, description, archived: false };
    vaultsList.push(created);
    activeVaultId = created.id;
    return JSON.parse(JSON.stringify(created));
  },
  async getNotes(v) { return [...notes.values()].filter(n => !v || n.vaultId === v).map(n => JSON.parse(JSON.stringify(n))); },
  async getNoteById(id) { return notes.has(id) ? JSON.parse(JSON.stringify(notes.get(id))) : undefined; },
  async saveNote(_context, n) {
    saveCalls++;
    const saved = JSON.parse(JSON.stringify(n));
    if (!saved.id) saved.id = 'note-' + saveCalls;
    if (typeof saved.trashedAt !== 'number') saved.trashedAt = 0;
    saved.content = loadNoteModule('LexiFrontmatter').LexiFrontmatter.serialize(saved);
    notes.set(saved.id, saved);
    return saved;
  }
};

const noteCache = new Map();
function loadNoteModule(name) {
  if (noteCache.has(name)) return noteCache.get(name);
  const source = fs.readFileSync(path.join(lexiNoteCore, name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const module = { exports: {} };
  noteCache.set(name, module.exports);
  const req = spec => {
    if (spec === './LexiStorageService') return { LexiStorageService: store };
    if (spec.startsWith('./')) return loadNoteModule(spec.slice(2));
    if (spec === '@kit.ArkTS') return { url: { URL: { parseURL: s => new URL(s) } }, util: { generateRandomUUID: () => crypto.randomUUID() } };
    if (spec === '@kit.CoreFileKit') return { fileIo: nativeFs };
    if (spec === '@kit.ShareKit') return { systemShare: { getSharedData: async () => ({ getRecords: () => sharePayload }), ShareAbilityResultCode: { CLOSE: 1, BACK: 0 } } };
    if (spec === '@kit.AbilityKit' || spec === '@kit.ArkData') return {};
    throw new Error(spec);
  };
  vm.runInThisContext('(function(require,module,exports,LocalStorage){' + js + '\n})', { filename: name })(req, module, module.exports, FakeLocalStorage);
  noteCache.set(name, module.exports);
  return module.exports;
}

const glowCache = new Map();
function loadGlowModule(relPath) {
  if (glowCache.has(relPath)) return glowCache.get(relPath);
  const fullPath = path.join(lexiGlowRoot, relPath);
  const dir = path.dirname(fullPath);
  const source = fs.readFileSync(fullPath, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const module = { exports: {} };
  glowCache.set(relPath, module.exports);
  const req = spec => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const targetFull = path.resolve(dir, spec + '.ets');
      const targetRel = path.relative(lexiGlowRoot, targetFull);
      return loadGlowModule(targetRel);
    }
    if (spec === '@kit.ArkTS') return { util: { TextDecoder: { create: () => ({ decodeToString: u8 => Buffer.from(u8).toString('utf8') }) } } };
    if (spec === '@kit.CoreFileKit') return { fileIo: nativeFs, fileUri: { getUriFromPath: p => 'file://' + p } };
    if (spec === '@kit.ShareKit') return { systemShare: {} };
    if (spec === '@kit.ArkData') return { uniformTypeDescriptor: { UniformDataType: { MARKDOWN: 'general.markdown', PLAIN_TEXT: 'general.plain-text' } } };
    if (spec === '@kit.AbilityKit') return {};
    throw new Error(spec);
  };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: relPath })(req, module, module.exports);
  glowCache.set(relPath, module.exports);
  return module.exports;
}

const lumiCache = new Map();
function loadLumiModule(relPath) {
  if (lumiCache.has(relPath)) return lumiCache.get(relPath);
  const fullPath = path.join(lumiKitRoot, relPath);
  const dir = path.dirname(fullPath);
  const source = fs.readFileSync(fullPath, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const module = { exports: {} };
  lumiCache.set(relPath, module.exports);
  const req = spec => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const targetFull = path.resolve(dir, spec + '.ets');
      const targetRel = path.relative(lumiKitRoot, targetFull);
      return loadLumiModule(targetRel);
    }
    if (spec === '@kit.ArkTS') return { util: { TextEncoder: class { encodeInto(t) { return new TextEncoder().encode(t); } }, TextDecoder: class { decodeToString(b) { return new TextDecoder('utf-8').decode(b); } } } };
    if (spec === '@kit.CoreFileKit') return { fileIo: nativeFs, picker: {}, fileUri: { getUriFromPath: p => 'file://' + p } };
    if (spec === '@kit.ShareKit') return { systemShare: {} };
    if (spec === '@kit.ArkData') return {
      uniformTypeDescriptor: {
        UniformDataType: { FILE: 'general.file' },
        getUniformDataTypeByFilenameExtension: ext => ext === '.md' ? 'general.markdown' : ''
      }
    };
    if (spec === '@kit.AbilityKit') return {};
    throw new Error(spec);
  };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: relPath })(req, module, module.exports);
  lumiCache.set(relPath, module.exports);
  return module.exports;
}

const { LexiEcosystemLink } = loadNoteModule('LexiEcosystemLink');
const { LexiShareCapture } = loadNoteModule('LexiShareCapture');
const { LexiFrontmatter } = loadNoteModule('LexiFrontmatter');
const { MarkdownEngine } = loadNoteModule('MarkdownEngine');
const { LexiNoteBridgeService } = loadGlowModule('service/LexiNoteBridgeService.ets');
const { SharedWordService } = loadGlowModule('service/SharedWordService.ets');
const { EcosystemBridge } = loadLumiModule('core/EcosystemBridge.ets');
const { DataEngine } = loadLumiModule('features/files/DataEngine.ets');
const { InventoryItem, LendingRecord } = loadLumiModule('features/inventory/InventoryModels.ets');
const { LocalForm, FormField, FormResponse, FieldAnswer } = loadLumiModule('features/forms/FormModels.ets');

// Wire up saveCapturedNote on mock store
const storageSource = fs.readFileSync(path.join(lexiNoteCore, 'LexiStorageService.ets'), 'utf8');
const captureMethod = storageSource.slice(
  storageSource.indexOf('  static async saveCapturedNote('),
  storageSource.indexOf('  private static async saveNoteSnapshot(')
);
const captureJS = ts.transpileModule(
  'class LexiStorageService {' + captureMethod + '}\nmodule.exports=LexiStorageService;',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }
).outputText;
const captureModule = { exports: {} };
class CaptureResult { constructor() { this.note = {}; this.duplicate = false; this.alreadySaved = false; } }
vm.runInThisContext('(function(module,LexiFrontmatter,LexiCapturedNoteSaveResult){' + captureJS + '})')(
  captureModule,
  LexiFrontmatter,
  CaptureResult
);
Object.assign(captureModule.exports, store, {
  withStorageLock: async (_context, op) => op(),
  saveNoteSnapshot: (context, note) => store.saveNote(context, note)
});
store.saveCapturedNote = captureModule.exports.saveCapturedNote;

const context = { filesDir: '/sandbox/files' };

function reset() {
  files.clear();
  dirs.clear();
  handles.clear();
  notes.clear();
  saveCalls = 0;
  sharePayload = [];
  vaultsList = [{ id: 'v', name: 'Vault', archived: false }];
  activeVaultId = 'v';
  LexiShareCapture.sessions = new Map();
  LexiShareCapture.sessionStorage = new Map();
  LexiShareCapture.saveQueue = Promise.resolve();
}

async function ingestLumiKitMarkdown(title, md) {
  const directDraft = LexiShareCapture.draftFromDirectWant({
    uri: `lexinote://import?source=LumiKit&workspace=%E9%9B%86%E8%90%A4&title=${encodeURIComponent(title)}`,
    parameters: {
      lexinoteMarkdownTitle: title,
      lexinoteMarkdownContent: md,
      lexinoteSourceApp: 'LumiKit',
      lexinoteWorkspaceName: '集萤'
    }
  }, crypto.randomUUID());
  assert.ok(directDraft);
  assert.equal(LexiShareCapture.detectEcosystemApp(directDraft.quote), 'LumiKit');
  const saved = await LexiShareCapture.saveToEcosystemWorkspace(context, directDraft);
  return { note: saved };
}

const tests = [
  ['LumiKit OCR exports Markdown with vocabulary [[wiki-links]] and lexiglow:// lookup links, and ingests into LexiNote and LexiGlow cleanly', async () => {
    const ocrText = 'Resilience and serendipity shape how we navigate ephemeral challenges in modern technology.';
    const md = EcosystemBridge.buildOcrNoteMarkdown('外刊书页摘录', ocrText, 'page_01.png', '2026-11-06');

    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('title: "外刊书页摘录"'));
    assert.ok(!md.includes('# 外刊书页摘录'));
    assert.ok(md.includes('notebook: "资料摘录"'));
    assert.ok(md.includes('source_uri: "lumikit://tool?id=image-ocr"'));
    assert.ok(md.includes('[[resilience]]'));
    assert.ok(md.includes('[[serendipity]]'));
    assert.ok(md.includes('[[ephemeral]]'));
    assert.ok(md.includes('lexiglow://word?spelling=resilience'));
    assert.ok(md.includes('lumikit://tool?id=image-ocr'));

    const saved = await ingestLumiKitMarkdown('外刊书页摘录', md);
    const lumiVault = vaultsList.find(v => v.name === '集萤');
    assert.ok(lumiVault, 'should auto-create 集萤 workspace');
    assert.equal(activeVaultId, lumiVault.id);
    assert.equal(saved.note.vaultId, lumiVault.id);
    assert.equal(saved.note.title, '外刊书页摘录');
    assert.equal(saved.note.notebook, '资料摘录');
    assert.ok(saved.note.tags.includes('集萤OCR'));
    assert.ok(saved.note.properties.some(p => p.key === 'source_app' && p.propValue === 'LumiKit'));

    // Also verify LexiGlow can extract clean English words and companion reading article from this OCR note
    const words = SharedWordService.wordsFromText(md);
    assert.ok(words.includes('resilience'));
    assert.ok(words.includes('serendipity'));
    assert.ok(!words.includes('lumikit'));
    assert.ok(!words.includes('lexiglow'));

    const article = LexiNoteBridgeService.extractArticleFromMarkdown(md, '外刊书页摘录.md');
    assert.equal(article.title, '外刊书页摘录');
    assert.ok(article.body.includes('Resilience and serendipity shape how we navigate ephemeral challenges'));
  }],

  ['LumiKit Analytics exports Markdown report with summary & group tables and ingests into LexiNote target notebook', async () => {
    const csv = '学院,月份,金额\n设计学院,1月,128\n计算机学院,1月,256\n设计学院,2月,198\n计算机学院,2月,320';
    const table = DataEngine.parseCSV(csv);
    const stats = DataEngine.summary(table, 2);
    const groups = DataEngine.groups(table, 0, 2);

    const md = EcosystemBridge.buildAnalyticsReportMarkdown('学院经费统计', table, 0, 2, stats, groups, '2026-11-06');
    assert.ok(md.includes('notebook: "数据报告"'));
    assert.ok(md.includes('source_uri: "lumikit://tool?id=analytics"'));
    assert.ok(md.includes('| 金额 | 4 | 0 | 902 | 225.50 | 128 | 320 |'));
    assert.ok(md.includes('| 计算机学院 | 2 | 50.0% | 576 |'));
    assert.ok(md.includes('lumikit://tool?id=analytics'));

    const saved = await ingestLumiKitMarkdown('数据分析报告 · 学院经费统计', md);
    assert.equal(saved.note.title, '数据分析报告 · 学院经费统计');
    assert.equal(saved.note.notebook, '数据报告');
    assert.ok(saved.note.tags.includes('集萤分析'));
    const blocks = MarkdownEngine.parseBlocks(saved.note.content);
    assert.ok(blocks.some(b => b.kind === 'table'));
  }],

  ['LumiKit Inventory item exports Markdown archive without duplicate self-referencing H1 and with lumikit://inventory backlink', async () => {
    const item = new InventoryItem();
    item.id = 'item_cam_01';
    item.name = '随身微单相机';
    item.category = '数码影像';
    item.brand = 'Sony';
    item.model = 'A7C2';
    item.price = '13999';
    item.purchaseDate = '2026-05-20';
    item.warrantyDate = '2028-05-20';
    item.channel = '官方旗舰店';
    item.notes = '搭配 40mm F2.5 G 镜头使用。';
    const loan = new LendingRecord();
    loan.id = 'loan_1';
    loan.borrower = '林同学';
    loan.lentAt = '2026-10-01';
    loan.dueDate = '2026-11-15';
    item.lending = [loan];
    item.attachments = [{ id: 'att_1', name: '电子发票.pdf', path: '/sandbox/files/workspace/inv.pdf', size: 102400 }];

    const md = EcosystemBridge.buildInventoryMarkdown(item, '保修有效', '2026-11-06');
    assert.ok(md.includes('title: "随身微单相机"'));
    assert.ok(md.includes('notebook: "物品档案"'));
    assert.ok(!md.includes('# [[随身微单相机]]'));
    assert.ok(md.includes('lumikit://inventory?itemId=item_cam_01'));
    assert.equal(LexiEcosystemLink.isExternalDeepLink('lumikit://inventory?itemId=item_cam_01'), true);

    const saved = await ingestLumiKitMarkdown('随身微单相机', md);
    assert.equal(saved.note.title, '随身微单相机');
    assert.equal(saved.note.notebook, '物品档案');
    assert.ok(saved.note.tags.includes('集萤物品'));
    assert.ok(saved.note.tags.includes('数码影像'));
  }],

  ['LumiKit Local Forms exports summary and single response Markdown notes into LexiNote', async () => {
    const form = new LocalForm();
    form.id = 'form_reading_club';
    form.title = '读书会报名表';
    form.description = '每周六下午线下共读活动';
    const f1 = new FormField(); f1.id = 'f_name'; f1.label = '姓名'; f1.type = 'text'; f1.required = true;
    const f2 = new FormField(); f2.id = 'f_book'; f2.label = '推荐书目'; f2.type = 'text'; f2.required = false;
    form.fields = [f1, f2];

    const resp = new FormResponse();
    resp.id = 'resp_01';
    resp.formId = form.id;
    resp.formTitle = form.title;
    resp.submittedAt = '2026-11-06 19:30';
    const a1 = new FieldAnswer(); a1.fieldId = 'f_name'; a1.label = '姓名'; a1.type = 'text'; a1.value = '知萤读者';
    const a2 = new FieldAnswer(); a2.fieldId = 'f_book'; a2.label = '推荐书目'; a2.type = 'text'; a2.value = '《思考，快与慢》';
    resp.answers = [a1, a2];

    const summaryMd = EcosystemBridge.buildFormSummaryMarkdown(form, [resp], '2026-11-06');
    assert.ok(summaryMd.includes('title: "读书会报名表 · 收集汇总报告"'));
    assert.ok(summaryMd.includes('notebook: "表单归档"'));
    assert.ok(summaryMd.includes('| 2026-11-06 19:30 | 知萤读者 | 《思考，快与慢》 |'));
    assert.ok(summaryMd.includes('lumikit://tool?id=forms'));

    const singleMd = EcosystemBridge.buildFormResponseMarkdown(form, resp);
    assert.ok(singleMd.includes('title: "读书会报名表 · 回答记录"'));
    assert.ok(singleMd.includes('| **姓名** | 知萤读者 |'));

    const saved = await ingestLumiKitMarkdown('读书会报名表 · 收集汇总报告', summaryMd);
    assert.equal(saved.note.title, '读书会报名表 · 收集汇总报告');
    assert.equal(saved.note.notebook, '表单归档');
    assert.ok(saved.note.tags.includes('集萤表单'));
  }]
];

(async () => {
  for (const [name, run] of tests) {
    reset();
    await run();
    console.log('PASS ' + name);
  }
  console.log(`${tests.length} ecosystem Phase 2 regression groups passed`);
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
