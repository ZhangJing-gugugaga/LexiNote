// System ShareController file sharing and HarmonyShare knockShare/dataReceive regression checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');

const files = new Map();
const dirs = new Set();
const handles = new Map();
const notes = new Map();
const appStorage = new Map();
let deviceType = 'phone';
let shareControllerCalls = [];
let knockShareRegistrations = [];
let dataReceiveRegistrations = [];

const FakeAppStorage = {
  setOrCreate(k, v) { appStorage.set(k, v); },
  set(k, v) { appStorage.set(k, v); },
  get(k) { return appStorage.get(k); }
};

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
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
  openSync(p) {
    const fd = handles.size + 1;
    handles.set(fd, p);
    return { fd };
  },
  writeSync(fd, text) { files.set(handles.get(fd), text); },
  fsyncSync() {},
  closeSync() {},
  renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
  unlinkSync: p => files.delete(p)
};

class FakeSharedData {
  constructor(record) {
    this.records = [record];
  }
  addRecord(record) {
    this.records.push(record);
  }
  getRecords() {
    return this.records;
  }
}

class FakeShareController {
  constructor(data) {
    this.data = data;
  }
  async show(context, options) {
    shareControllerCalls.push({ context, data: this.data, options });
  }
}

const fakeHarmonyShare = {
  SharableErrorCode: { NO_CONTENT_ERROR: 1 },
  ReceivableErrorCode: { NO_RECEIVABLE_ERROR: 1 },
  on(event, arg2, arg3) {
    if (event === 'knockShare') {
      const hasWindow = typeof arg3 === 'function';
      knockShareRegistrations.push({
        action: 'on',
        capability: hasWindow ? arg2 : undefined,
        callback: hasWindow ? arg3 : arg2
      });
    } else if (event === 'dataReceive') {
      dataReceiveRegistrations.push({
        action: 'on',
        capability: arg2,
        callback: arg3
      });
    }
  },
  off(event, arg2, arg3) {
    if (event === 'knockShare') {
      const hasWindow = typeof arg3 === 'function' || (arg2 && typeof arg2 === 'object');
      knockShareRegistrations.push({
        action: 'off',
        capability: hasWindow ? arg2 : undefined,
        callback: typeof arg3 === 'function' ? arg3 : (typeof arg2 === 'function' ? arg2 : undefined)
      });
    } else if (event === 'dataReceive') {
      dataReceiveRegistrations.push({
        action: 'off',
        capability: arg2,
        callback: arg3
      });
    }
  }
};

const store = {
  async init() {},
  async flushPendingWrites() {},
  async getNoteById(id) {
    return notes.has(id) ? JSON.parse(JSON.stringify(notes.get(id))) : undefined;
  }
};

const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(core, name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module.exports);
  const req = spec => {
    if (spec === './LexiStorageService') return { LexiStorageService: store };
    if (spec.startsWith('./')) return load(spec.slice(2));
    if (spec === '@kit.ArkTS') return {
      url: { URL: { parseURL: s => new URL(s) } },
      util: { generateRandomUUID: () => crypto.randomUUID() }
    };
    if (spec === '@kit.CoreFileKit') return {
      fileIo: nativeFs,
      fileUri: { getUriFromPath: p => 'file://com.lovexjy.lexinote' + p }
    };
    if (spec === '@kit.BasicServicesKit') return {
      deviceInfo: {
        get deviceType() { return deviceType; },
        apiAvailable: () => true
      }
    };
    if (spec === '@kit.ShareKit') return {
      systemShare: {
        SharedData: FakeSharedData,
        ShareController: FakeShareController,
        SharePreviewMode: { DEFAULT: 0, DETAIL: 1 },
        SelectionMode: { SINGLE: 0, BATCH: 1 }
      },
      harmonyShare: fakeHarmonyShare
    };
    if (spec === '@kit.ArkData') return {
      uniformTypeDescriptor: {
        UniformDataType: {
          MARKDOWN: 'general.markdown',
          PLAIN_TEXT: 'general.plain-text',
          FILE: 'general.file',
          TEXT: 'general.text'
        },
        getUniformDataTypeByFilenameExtension(ext) {
          return ext === '.md' ? 'general.markdown' : '';
        }
      }
    };
    if (spec === '@kit.AbilityKit' || spec === '@kit.ArkUI') return {
      AbilityConstant: { ContinueState: { ACTIVE: 0, INACTIVE: 1 } }
    };
    throw new Error('Unexpected import: ' + spec);
  };
  const canIUse = cap => cap === 'SystemCapability.Collaboration.HarmonyShare';
  vm.runInThisContext('(function(require,module,exports,AppStorage,LocalStorage,canIUse){' + js + '\n})', { filename: name })(
    req, module, module.exports, FakeAppStorage, FakeLocalStorage, canIUse
  );
  cache.set(name, module.exports);
  return module.exports;
}

const { LexiShareService } = load('LexiShareService');
const { LexiContinuationSession } = load('LexiContinuationSession');
const { LexiContinuationDraft } = load('LexiContinuationData');
const { NoteItem } = load('LexiModels');
const { LexiContextTarget, LexiContextBridge } = load('LexiContextModels');

const context = {
  filesDir: '/sandbox/files',
  abilityInfo: { name: 'EntryAbility' },
  setMissionContinueState: async () => {}
};

function reset() {
  files.clear();
  dirs.clear();
  handles.clear();
  notes.clear();
  appStorage.clear();
  deviceType = 'phone';
  shareControllerCalls = [];
  knockShareRegistrations = [];
  dataReceiveRegistrations = [];
  LexiContinuationSession.owner = '';
  LexiContinuationSession.getter = undefined;
  LexiShareService.activeOwner = '';
  LexiShareService.activeGetter = undefined;
  LexiShareService.windowBindings = new Map();
}

const tests = [
  ['sanitizeFileName strips illegal filesystem characters and defaults empty titles', async () => {
    assert.equal(LexiShareService.sanitizeFileName('  我的:笔记/草稿?*<>|  '), '我的_笔记_草稿.md');
    assert.equal(LexiShareService.sanitizeFileName('...'), '未命名笔记.md');
  }],
  ['shareNoteById writes Markdown file into share-out and opens system ShareController with anchor', async () => {
    const n = new NoteItem();
    n.id = 'note-share-1';
    n.title = '分布式架构笔记';
    n.content = '# 分布式架构笔记\n\n支持系统文件分享与碰一碰。\n';
    n.notebook = '研发笔记';
    notes.set(n.id, n);

    await LexiShareService.shareNoteById(context, n.id, 'context-trigger-note-note-share-1');
    assert.equal(shareControllerCalls.length, 1);
    const call = shareControllerCalls[0];
    assert.equal(call.options.anchor, 'context-trigger-note-note-share-1');
    assert.equal(call.options.previewMode, 0);
    assert.equal(call.options.selectionMode, 0);

    const records = call.data.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].utd, 'general.markdown');
    assert.equal(records[0].title, '分布式架构笔记.md');
    assert.ok(records[0].uri.startsWith('file://com.lovexjy.lexinote/sandbox/files/share-out/'));
    assert.equal(files.get('/sandbox/files/share-out/分布式架构笔记.md'), '# 分布式架构笔记\n\n支持系统文件分享与碰一碰。\n');
  }],
  ['context menu for note includes share-file action', async () => {
    const n = new NoteItem();
    n.id = 'note-ctx';
    n.title = '测试菜单';
    const actions = LexiContextBridge.actions(LexiContextTarget.note(n), true);
    assert.ok(actions.some(a => a.id === 'share-file' && a.label === '系统分享文件'));
  }],
  ['knockShare shares active editor note from LexiContinuationSession with file URI and coordinate', async () => {
    const owner = LexiContinuationSession.newOwner();
    LexiContinuationSession.activate(context, owner, () => {
      const draft = new LexiContinuationDraft();
      draft.sourceNoteId = 'note-knock-1';
      draft.title = '碰一碰跨端笔记';
      draft.content = '# 碰一碰跨端笔记\n\n正在编辑的正文内容\n';
      return draft;
    });

    let sharedPayload;
    let clarified;
    LexiShareService.handleKnockShare(context, {
      getInfo: () => ({ coordinate: { screenX: 180, screenY: 60 } }),
      async share(data) { sharedPayload = data; },
      async clarifyNonShare(info) { clarified = info; }
    });

    assert.equal(clarified, undefined);
    assert.ok(sharedPayload);
    const records = sharedPayload.getRecords();
    assert.equal(records[0].title, '碰一碰跨端笔记.md');
    assert.equal(files.get('/sandbox/files/share-out/碰一碰跨端笔记.md'), '# 碰一碰跨端笔记\n\n正在编辑的正文内容\n');
  }],
  ['knockShare calls clarifyNonShare when no note is open in editor', async () => {
    let sharedPayload;
    let clarified;
    LexiShareService.handleKnockShare(context, {
      async share(data) { sharedPayload = data; },
      async clarifyNonShare(info) { clarified = info; }
    });
    assert.equal(sharedPayload, undefined);
    assert.ok(clarified && clarified.message.includes('先打开一篇笔记'));
  }],
  ['window registration uses phone/tablet knockShare on mobile and windowId + dataReceive on 2in1', async () => {
    const fakeWindow = { getWindowProperties: () => ({ id: 42 }) };
    deviceType = 'phone';
    LexiShareService.registerWindow('EntryAbility', context, fakeWindow);
    assert.equal(knockShareRegistrations.length, 1);
    assert.equal(knockShareRegistrations[0].capability, undefined);
    assert.equal(dataReceiveRegistrations.length, 0);
    LexiShareService.unregisterWindow('EntryAbility');
    assert.equal(knockShareRegistrations.length, 2);
    assert.equal(knockShareRegistrations[1].action, 'off');

    knockShareRegistrations = [];
    dataReceiveRegistrations = [];
    deviceType = '2in1';
    LexiShareService.registerWindow('EntryAbility', context, fakeWindow);
    assert.equal(knockShareRegistrations.length, 1);
    assert.deepEqual(knockShareRegistrations[0].capability, { windowId: 42 });
    assert.equal(dataReceiveRegistrations.length, 1);
    assert.equal(dataReceiveRegistrations[0].capability.windowId, 42);

    // Simulate 2in1 receiving a Markdown file via knock dataReceive
    files.set('/sandbox/files/knock-receive/incoming-note.md', '# PC 接收到的碰一碰笔记\n\n内容完整');
    let receivedUri;
    dataReceiveRegistrations[0].callback({
      getInfo: () => ({ coordinate: { screenX: 220, screenY: 90 } }),
      async receive(uri, callbacks) {
        receivedUri = uri;
        callbacks.onDataReceived(new FakeSharedData({
          utd: 'general.markdown',
          uri: '/sandbox/files/knock-receive/incoming-note.md',
          title: 'incoming-note.md'
        }));
      }
    });
    assert.equal(receivedUri, 'file://com.lovexjy.lexinote/sandbox/files/knock-receive');
    const published = JSON.parse(appStorage.get('lexiExternalMarkdownIncoming'));
    assert.equal(published.isMarkdownFile, true);
    assert.equal(published.title, 'incoming-note');
    assert.ok(published.quote.includes('# PC 接收到的碰一碰笔记'));

    LexiShareService.unregisterWindow('EntryAbility');
    assert.equal(knockShareRegistrations[1].action, 'off');
    assert.equal(dataReceiveRegistrations[1].action, 'off');
  }]
];

(async () => {
  for (const [name, run] of tests) {
    reset();
    await run();
    console.log('PASS ' + name);
  }
  console.log(`${tests.length} system and knock share regression groups passed`);
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
