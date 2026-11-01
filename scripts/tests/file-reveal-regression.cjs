const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/core/LexiFileActions.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
let notePath = '/storage/Users/currentUser/Documents/我的笔记/分类 & A/学习.md';
let projectUri = '';
let vaultUri = 'file://docs/storage/Users/currentUser/Documents/%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0';
const storage = {
  getNoteById: async () => ({ path: notePath }),
  getProjects: async () => [{ id: 'p', folderUri: projectUri }],
  getVaults: async () => [{ id: 'v', folderUri: vaultUri }]
};
const modules = {
  '@kit.CoreFileKit': { fileUri: { getUriFromPath: p => `uri:${p}` } },
  './LexiStorageService': { LexiStorageService: storage },
  './LexiFolderStore': { LexiFolderStore: { path: u => decodeURIComponent(u.replace('file://docs', '')) } }
};
const mod = { exports: {} };
vm.runInThisContext('(function(require,module,exports){' + js + '\n})')((id) => modules[id] || {}, mod, mod.exports);
const actions = mod.exports.LexiFileActions;
const target = { kind: 'note', id: 'n', vaultId: 'v', projectId: 'p' };
const calls = [];
const context = { filesDir: '/private/app', openLink: async (...args) => calls.push(['link', ...args]), startAbility: async (...args) => calls.push(['ability', ...args]) };
(async () => {
  await actions.reveal(context, target);
  assert.equal(calls[0][0], 'link');
  assert.equal(calls[0][1], 'filemanager://openDirectory');
  assert.equal(calls[0][2].parameters.fileUri, vaultUri + '/%E5%88%86%E7%B1%BB%20%26%20A');
  await actions.openExternal(context, target);
  assert.equal(calls[1][0], 'ability');
  assert.equal(calls[1][1].type, 'text/markdown');
  projectUri = 'file://docs/storage/Users/currentUser/Documents/Project';
  notePath = '/storage/Users/currentUser/Documents/Project/deep/note.md';
  await actions.reveal(context, target);
  assert.equal(calls[2][2].parameters.fileUri, projectUri + '/deep');
  notePath = '/private/app/vaults/v/notes/n.md';
  await assert.rejects(() => actions.reveal(context, target), /无法定位/);
  projectUri = ''; vaultUri = '';
  await assert.rejects(() => actions.reveal(context, target), /应用内部/);
  assert.equal(calls.length, 3, 'unsupported locations must not open a default file handler');
  console.log('PASS file manager reveal, folder URI encoding, project precedence and internal fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
