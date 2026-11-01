// Cursor, link safety, and chapter navigation regression tests against the ArkTS core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(core, name + '.ets'), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021}}).outputText;
  const module = {exports: {}};
  cache.set(name, module.exports);
  const req = spec => {if (spec.startsWith('./')) return load(spec.slice(2)); throw new Error('Unexpected import ' + spec);};
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', {filename:name})(req, module, module.exports);
  cache.set(name,module.exports);
  return module.exports;
}
const {LexiCompletion:C} = load('LexiCompletion');
const {NoteItem} = load('LexiModels');
function note(id, title, content, tags = []) {const n = new NoteItem(); n.id=id; n.title=title; n.content=content; n.tags=tags; return n;}
const notes = [note('source','Source','# Source'), note('target','目标笔记','# 目标笔记\n\n## 复习重点\n正文\n### 下一步\n记录', ['复习','课程/数学'])];
const tests = [
  ['mid-sentence wiki completion preserves suffix and closes existing brackets once', () => {
    const input='前文 [[目标]] 后文'; const cursor=input.indexOf(']]');
    const context=C.context(input,cursor);const suggestions=C.candidates(context,notes,'source');
    assert.equal(suggestions.length,1);const edit=C.apply(input,context,suggestions[0]);
    assert.equal(edit.text,'前文 [[目标笔记]] 后文');assert.equal(edit.cursor,'前文 [[目标笔记]]'.length);
  }],
  ['nested chapter completion and current-note chapter completion', () => {
    const input='[[目标笔记#复';const context=C.context(input,input.length);
    assert.equal(context.kind,'heading');const suggestions=C.candidates(context,notes,'source');
    assert.equal(suggestions[0].insertion,'[[目标笔记#复习重点]]');
    const self=C.context('[[#Sou','[[#Sou'.length);assert.equal(C.candidates(self,notes,'source')[0].insertion,'[[#Source]]');
  }],
  ['tag completion filters, deduplicates, ignores trashed notes, and preserves following text', () => {
    const deleted=note('deleted','Deleted','', ['复习']);deleted.trashedAt=1;
    const input='进度 #复 / 待办';const cursor=input.indexOf(' /');const context=C.context(input,cursor);
    const results=C.candidates(context,notes.concat([deleted]),'source');
    assert.equal(results.length,1);assert.equal(C.apply(input,context,results[0]).text,'进度 #复习  / 待办');
  }],
  ['completion is suppressed inside fenced/inline code and for selections', () => {
    for(const input of ['```md\n[[目标','~~~\n#复','`[[目标','段落 `#复'])assert.equal(C.context(input,input.length).kind,'');
    assert.equal(C.context('[[目标',1,4).kind,'');
    assert.equal(C.context('```md\ncode\n```\n[[目标','```md\ncode\n```\n[[目标'.length).kind,'note');
  }],
  ['chapter target parsing retains note identity, title aliases, URL decoding and normalized heading', () => {
    const target=C.splitTarget('[[目标笔记#%E5%A4%8D%E4%B9%A0%E9%87%8D%E7%82%B9|别名]]');
    assert.equal(target.noteName,'目标笔记');assert.equal(target.anchor,'复习重点');
    assert.equal(C.splitTarget('#Local heading').noteName,'');
    const heading={title:'A Friendly Heading',lineIndex:3};
    assert.equal(C.findHeading([heading],'a-friendly-heading'),heading);
    assert.equal(C.findHeading([heading],'missing'),undefined);
  }],
  ['one-click mentions skip metadata, code, existing links, URLs and partial words', () => {
    const input='---\nrelated: Target\n---\n```\nTarget\n```\n`Target` [[Target]] [Target](https://x/Target) https://x/Target Targeted then Target remains';
    const result=C.linkFirstMention(input,'Target');
    assert.equal(result,input.replace('then Target remains','then [[Target]] remains'));
    assert.equal(C.linkFirstMention('[[目标笔记]] 和 目标笔记','目标笔记'),'[[目标笔记]] 和 [[目标笔记]]');
    assert.equal(C.linkFirstMention('Targeted only','Target'),'Targeted only');
  }],
];
for(const [name,run] of tests){run();console.log('PASS '+name);}
console.log(`${tests.length} completion and relation regression groups passed`);
