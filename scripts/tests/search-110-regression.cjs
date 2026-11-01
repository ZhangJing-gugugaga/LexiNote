const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const js = ts.transpileModule(fs.readFileSync(path.join(core, name+'.ets'),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}
  }).outputText;
  const mod={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:name})(s=>load(s.slice(2)),mod,mod.exports);
  cache.set(name,mod.exports);return mod.exports;
}
const {LexiSearch:S}=load('LexiSearch');
const {NoteItem,NoteProperty}=load('LexiModels');
const {LEXI_COMMANDS}=load('LexiCommands');
const n=new NoteItem();n.title='Linear Algebra';n.content='矩阵与向量复习';n.noteType='study';
n.tags=['课程/数学','复习'];n.notebook='学习 记录';n.path='/vault/math/algebra.md';n.properties=[new NoteProperty('status','进行中')];
const tests=[
  ['combined structured search requires every clause',()=>{
    assert.equal(S.matches(n,'tag:#课程 type:study notebook:"学习 记录" 矩阵'),true);
    assert.equal(S.matches(n,'tag:#课程 type:quick'),false);
    assert.equal(S.matches(n,'tag:#数学'),false);
  }],
  ['quoted phrases, exclusions and unknown colons preserve normal text semantics',()=>{
    assert.equal(S.matches(n,'"linear algebra" -tag:完成 -type:quick'),true);
    assert.equal(S.matches(n,'矩阵 -tag:复习'),false);
    assert.equal(S.matches(n,'tag:复习 -"linear algebra"'),false);
    assert.equal(S.parse('https://example.com')[0].field,'');
    assert.equal(S.matches(n,'   '),true);
  }],
  ['path and property conditions work with tag and notebook terms',()=>{
    assert.equal(S.matches(n,'path:math [status]:进行 tag:复习'),true);
    assert.equal(S.matches(n,'path:unknown'),false);
    assert.equal(S.matches(n,'[status]:完成'),false);
  }],
  ['quick switcher ranks exact, prefix, substring and ordered subsequences',()=>{
    assert.equal(S.rank('Linear Algebra','linear algebra'),0);
    assert.ok(S.rank('Linear Algebra','lin')<S.rank('My Linear Algebra','lin'));
    assert.ok(S.rank('Linear Algebra','la')>=0);
    assert.equal(S.rank('Linear Algebra','zz'),-1);
  }],
  ['command catalog exposes unique executable commands',()=>{
    assert.ok(LEXI_COMMANDS.length>=20);
    assert.equal(new Set(LEXI_COMMANDS.map(c=>c.id)).size,LEXI_COMMANDS.length);
    for(const id of ['daily','templates','reading','split','backup','export-md'])assert.ok(LEXI_COMMANDS.some(c=>c.id===id));
  }],
];
for(const [name,run] of tests){run();console.log('PASS '+name);}
console.log(`${tests.length} search and workflow regression groups passed.`);
