// Cross-app Phase 1 linkage regression checks across LexiNote, LexiGlow, and LumiKit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');

const lexiNoteCore = path.resolve(__dirname, '../../entry/src/main/ets/core');
const lexiGlowRoot = path.resolve(__dirname, '../../../LexiGlow/entry/src/main/ets');

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
  readTextSync: p => files.get(p),
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4, READ_ONLY: 0 },
  openSync(p) { const fd = handles.size + 1; handles.set(fd, p); return { fd }; },
  writeSync(fd, text) { files.set(handles.get(fd), text); },
  fsyncSync() {},
  closeSync() {},
  renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
  unlinkSync: p => files.delete(p)
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

const cache = new Map();
function loadNoteModule(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(lexiNoteCore, name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module.exports);
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
  cache.set(name, module.exports);
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

const { LexiEcosystemLink } = loadNoteModule('LexiEcosystemLink');
const { LexiShareCapture } = loadNoteModule('LexiShareCapture');
const { LexiFrontmatter } = loadNoteModule('LexiFrontmatter');
const { LexiNoteBridgeService } = loadGlowModule('service/LexiNoteBridgeService.ets');
const { SharedWordService } = loadGlowModule('service/SharedWordService.ets');
const { parseLaunchUri } = loadGlowModule('utils/LaunchRouteUtils.ets');

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

async function ingestSharedMarkdownFile(filePath, title, md) {
  files.set(filePath, md);
  sharePayload = [{ utd: 'general.markdown', uri: filePath, title }];
  let local;
  LexiShareCapture.open({}, { loadContent(_p, storage) { local = storage; } });
  await new Promise(r => setImmediate(r));
  const parsed = JSON.parse(local.get('lexiShareDraftJson'));
  return LexiShareCapture.save(context, parsed, 'v', 'p');
}

const tests = [
  ['LexiEcosystemLink parses and builds lexinote://, lexiglow://, and lumikit:// URIs', async () => {
    const parsedOpen = LexiEcosystemLink.parseLexiNoteUri('lexinote://open?noteId=note-123&title=%E8%8B%B1%E8%AF%AD%E7%B2%BE%E8%AF%BB%E7%AC%94%E8%AE%B0');
    assert.ok(parsedOpen);
    assert.equal(parsedOpen.action, 'open');
    assert.equal(parsedOpen.noteId, 'note-123');
    assert.equal(parsedOpen.title, '英语精读笔记');

    const dailyParsed = LexiEcosystemLink.parseLexiNoteUri('lexinote://daily');
    assert.ok(dailyParsed);
    assert.equal(dailyParsed.action, 'daily');

    const quickParsed = LexiEcosystemLink.parseLexiNoteUri('lexinote://quick');
    assert.ok(quickParsed);
    assert.equal(quickParsed.action, 'quick');

    const wordUri = LexiEcosystemLink.lexiGlowWordUri('ephemeral');
    assert.equal(wordUri, 'lexiglow://word?spelling=ephemeral');
    assert.equal(LexiEcosystemLink.isExternalDeepLink(wordUri), true);
    assert.equal(LexiEcosystemLink.isExternalDeepLink('lexiglow://word?spelling=don%27t'), true);

    const invUri = LexiEcosystemLink.lumiKitItemUri('item-42');
    assert.equal(invUri, 'lumikit://inventory?itemId=item-42');
    assert.equal(LexiEcosystemLink.isExternalDeepLink(invUri), true);
  }],

  ['LexiGlow word card exports Markdown with frontmatter, [[wiki-links]], and lexiglow:// backlink, and imports into LexiNote target notebook', async () => {
    const word = {
      id: 101,
      word: 'serendipity',
      phonetic: 'ˌserənˈdɪpəti',
      meaning: 'n. 意外发现珍奇事物的本领；机缘巧合',
      example: 'Meeting her was pure serendipity.',
      translation: '遇见她纯粹是机缘巧合。',
      level: 4
    };
    const progress = { strength: 68, reviewCount: 5 };
    const enrichment = {
      root: 'serendip',
      suffix: '-ity',
      analysis: 'serendip + -ity（抽象名词后缀）',
      collocations: ['pure serendipity', 'by serendipity'],
      familyWords: [{ word: { word: 'serendipitous' }, strength: 50, learned: false }],
      confusingWords: [
        { word: { word: 'ephemeral' }, note: 'adj. 短暂的' },
        { word: { word: 'ubiquitous' }, note: 'adj. 无所不在的' }
      ]
    };
    const md = LexiNoteBridgeService.buildWordNoteMarkdown(word, progress, enrichment, '2026-11-06');
    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('title: "serendipity"'));
    assert.ok(md.includes('notebook: "英语精读"'));
    // Body should NOT duplicate the H1 title or self-reference # [[serendipity]]
    assert.ok(!md.includes('# [[serendipity]]'));
    assert.ok(md.includes('[[serendipitous]]'));
    assert.ok(md.includes('[[ephemeral]]'));
    assert.ok(md.includes('[[ubiquitous]]'));
    assert.ok(md.includes('lexiglow://word?spelling=serendipity'));

    // Direct jump Want parsing & automatic「词萤」workspace creation + save
    const directDraft = LexiShareCapture.draftFromDirectWant({
      uri: 'lexinote://import?source=LexiGlow&workspace=%E8%AF%8D%E8%90%A4&title=serendipity',
      parameters: {
        lexinoteMarkdownTitle: 'serendipity',
        lexinoteMarkdownContent: md,
        lexinoteSourceApp: 'LexiGlow',
        lexinoteWorkspaceName: '词萤'
      }
    }, crypto.randomUUID());
    assert.ok(directDraft);
    assert.equal(LexiShareCapture.isLexiGlowMarkdown(directDraft.quote), true);

    const autoSaved = await LexiShareCapture.saveToLexiGlowWorkspace(context, directDraft);
    const createdVault = vaultsList.find(v => v.name === '词萤');
    assert.ok(createdVault, 'should auto-create 词萤 workspace');
    assert.equal(activeVaultId, createdVault.id);
    assert.equal(autoSaved.vaultId, createdVault.id);
    assert.equal(autoSaved.title, 'serendipity');
    assert.equal(autoSaved.notebook, '英语精读');
    assert.ok(autoSaved.tags.includes('词萤词卡'));
    assert.ok(autoSaved.tags.includes('词汇积累'));
    assert.ok(autoSaved.properties.some(p => p.key === 'source_app' && p.propValue === 'LexiGlow'));
    assert.ok(autoSaved.properties.some(p => p.key === 'word' && p.propValue === 'serendipity'));

    // Re-importing the same word updates the existing note in「词萤」workspace rather than duplicating
    const updatedMd = LexiNoteBridgeService.buildWordNoteMarkdown(word, { strength: 85, reviewCount: 6 }, enrichment, '2026-11-07');
    const secondDraft = LexiShareCapture.draftFromDirectWant({
      parameters: { lexinoteMarkdownTitle: 'serendipity', lexinoteMarkdownContent: updatedMd }
    }, crypto.randomUUID());
    const reSaved = await LexiShareCapture.saveToLexiGlowWorkspace(context, secondDraft);
    assert.equal(reSaved.id, autoSaved.id);
    assert.ok(reSaved.content.includes('强度 85 / 100'));
    assert.equal((await store.getNotes(createdVault.id)).length, 1);
  }],

  ['LexiGlow sentence collection and mistake book export into LexiNote with target notebooks and wiki-links', async () => {
    const sentences = [
      {
        id: 1,
        sentence: 'Resilience is built through adversity.',
        articleId: 42,
        articleTitle: 'Building Resilience',
        note: '注意 resilience 的搭配',
        createdAt: '2026-11-06'
      }
    ];
    const sentenceMd = LexiNoteBridgeService.buildSentenceCollectionMarkdown(sentences, '2026-11-06');
    assert.ok(sentenceMd.includes('notebook: "英语精读"'));
    assert.ok(sentenceMd.includes('[[Resilience]]'));
    assert.ok(sentenceMd.includes('lexiglow://article?id=42'));

    const mistakes = [
      {
        word: {
          id: 202,
          word: 'ubiquitous',
          phonetic: 'juːˈbɪkwɪtəs',
          meaning: 'adj. 无所不在的',
          example: 'Smartphones are ubiquitous today.',
          translation: '如今智能手机无处不在。'
        },
        wrongCount: 3,
        strength: 35
      }
    ];
    const mistakeMd = LexiNoteBridgeService.buildMistakeBookMarkdown(mistakes, '2026-11-06');
    assert.ok(mistakeMd.includes('notebook: "英语复盘"'));
    assert.ok(mistakeMd.includes('[[ubiquitous]]'));
    assert.ok(mistakeMd.includes('lexiglow://study/mistakes'));

    const saved = await ingestSharedMarkdownFile('/shared/mistakes.md', 'mistakes.md', mistakeMd);
    assert.equal(saved.note.notebook, '英语复盘');
    assert.ok(saved.note.tags.includes('词萤错题本'));
  }],

  ['LexiNote Markdown note cleans cleanly into a LexiGlow companion reading article', async () => {
    const rawNote = [
      '---',
      'title: "The Future of Local-First Software"',
      'tags:',
      '  - reading',
      '---',
      '# The Future of Local-First Software',
      '',
      'In a [[local-first|local first]] world, your data lives on your device while remaining [collaborative](https://example.com).',
      '',
      '> Ephemeral cloud services come and go, but plain Markdown endures.',
      ''
    ].join('\n');

    const extracted = LexiNoteBridgeService.extractArticleFromMarkdown(rawNote, 'fallback.md');
    assert.equal(extracted.title, 'The Future of Local-First Software');
    assert.ok(!extracted.body.includes('---'));
    assert.ok(extracted.body.includes('In a local first world, your data lives on your device while remaining collaborative.'));
    assert.ok(extracted.body.includes('Ephemeral cloud services come and go, but plain Markdown endures.'));

    const words = SharedWordService.wordsFromText(rawNote);
    assert.ok(!words.includes('title'));
    assert.ok(!words.includes('tags'));
    assert.ok(!words.includes('https'));
    assert.ok(words.includes('ephemeral'));
  }],

  ['LexiGlow LaunchRouteUtils parses all Phase 1 deep link targets', async () => {
    assert.deepEqual(Object.assign({}, parseLaunchUri('lexiglow://word?spelling=ephemeral')), {
      route: 'lookupWord',
      wordId: 0,
      articleId: 0,
      spelling: 'ephemeral'
    });
    assert.deepEqual(Object.assign({}, parseLaunchUri('lexiglow://word?spelling=don%27t')), {
      route: 'lookupWord',
      wordId: 0,
      articleId: 0,
      spelling: "don't"
    });
    assert.deepEqual(Object.assign({}, parseLaunchUri('lexiglow://article?id=42')), {
      route: 'article',
      wordId: 0,
      articleId: 42,
      spelling: ''
    });
    assert.deepEqual(Object.assign({}, parseLaunchUri('lexiglow://study/mistakes')), {
      route: 'mistakes',
      wordId: 0,
      articleId: 0,
      spelling: ''
    });
    assert.deepEqual(Object.assign({}, parseLaunchUri('lexiglow://study/sentences')), {
      route: 'sentences',
      wordId: 0,
      articleId: 0,
      spelling: ''
    });
  }]
];

(async () => {
  for (const [name, run] of tests) {
    reset();
    await run();
    console.log('PASS ' + name);
  }
  console.log(`${tests.length} ecosystem Phase 1 regression groups passed`);
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
