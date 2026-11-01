const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core=path.resolve(__dirname,'../../entry/src/main/ets/core');
const cache=new Map();
function load(name){
 if(cache.has(name))return cache.get(name);
 const js=ts.transpileModule(fs.readFileSync(path.join(core,name+'.ets'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const mod={exports:{}};cache.set(name,mod.exports);
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:name})(s=>load(s.slice(2)),mod,mod.exports);
 cache.set(name,mod.exports);return mod.exports;
}
const {LexiLiveMarkdown:L,LexiLiveRange}=load('LexiLiveMarkdown');
const {LexiCodeFence,LexiCodeFenceInfo}=load('LexiCodeFence');
const {LexiCodeTools}=load('LexiCodeTools');
function sourceAt(text,point){const r=L.rangeAt(text,point);return text.slice(r.start,r.end);}
const component=fs.readFileSync(path.resolve(core,'../components/LexiLiveMarkdownEditor.ets'),'utf8');
const methods=component.slice(component.indexOf('  private documentChanged()'),component.indexOf('  build()'));
const js=ts.transpileModule('class Subject {'+methods+'}\nmodule.exports=Subject',{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText;
const mod={exports:{}};class FakeFocusFrame{constructor(action){this.action=action;}onIdle(){this.action();}}
vm.runInThisContext('(function(module,LexiLiveMarkdown,LexiLiveFocusFrame,LexiCodeFence,LexiCodeTools){'+js+'})')(mod,L,FakeFocusFrame,LexiCodeFence,LexiCodeTools);const Subject=mod.exports;
function subject(content){
 const s=new Subject();Object.assign(s,{content,documentText:content,sourceText:'',globalStart:content.length,globalEnd:content.length,activeRange:new LexiLiveRange(),editorEnabled:true,activeEditing:false,editingCode:false,showCodeSource:false,codeBody:'',selectedCodeLanguage:'',detectedCodeLanguage:'',codeFence:new LexiCodeFenceInfo(),languageIds:['','text','arkts','typescript','javascript','json'],focusRevision:0,
  getUIContext(){return{postFrameCallback:frame=>frame.onIdle(0),getAttachedFrameNodeById:()=>({isAttached:()=>true,isVisible:()=>true}),getFocusController:()=>({requestFocus(){}})};},inputController:{setTextSelection(){}},
  onSelectionChange(){},onChange(text){s.emitted=text;s.content=text;}});return s;
}
const tests=[
 ['clicked blocks expose exactly their original source without YAML or separator loss',()=>{
  const text='---\ntags: [课程]\n---\n# 标题\n\n**第一段**\n\n第二段\n';
  assert.equal(sourceAt(text,text.indexOf('第一')),'**第一段**');
  const r=L.rangeAt(text,text.indexOf('第一'));const edit=L.replace(text,r.start,r.end,'==修改==');
  assert.equal(edit.content,text.replace('**第一段**','==修改=='));
  assert.equal(L.rangeForLine(text,5).start,r.start);
 }],
 ['tables, fenced code, formula and callout are edited as intact blocks',()=>{
  for(const block of ['| 项目 | 进度 |\n| --- | ---: |\n| A | 1 |','```ts\nconst x=1;\n```','$$\nx^2\n$$','> [!NOTE]\n> 提示']){
   const text='# 前文\n\n'+block+'\n\n## 后文';assert.equal(sourceAt(text,text.indexOf(block)+3),block);
  }
 }],
 ['source offsets preserve Unicode, CRLF and blank insertion locations',()=>{
  const text='# 标题\r\n\r\n段落😀\r\n\r\n';const r=L.rangeAt(text,text.indexOf('😀'));
  assert.equal(text.slice(r.start,r.end),'段落😀');assert.equal(sourceAt(text,text.length),'');
  assert.equal(L.replace(text,text.length,text.length,'新段').content,text+'新段');
 }],
 ['ordinary newline renders prior line while incomplete structural blocks stay editable',()=>{
  assert.equal(L.shouldAdvance('**完成**\n','paragraph'),true);
  assert.equal(L.shouldAdvance('```ts\n','paragraph'),false);
  assert.equal(L.shouldAdvance('```ts\nx\n```\n','code'),true);
  assert.equal(L.shouldAdvance('| A |\n','paragraph'),false);
  assert.equal(L.shouldAdvance('| A |\n\n','table'),true);
  assert.equal(L.shouldAdvance('| A |\r\n\r\n','table'),true);
  assert.equal(L.hasBody('---\ntags: [课程]\n---\n'),false);
 }],
 ['YAML normalization maps active source and selection into the new physical document',()=>{
  const text='# 标题\n\n正文';const s=subject(text);s.selectSource(text.length,text.length);
  s.content='---\ntags: [课程]\n---\n'+text;s.documentChanged();
  assert.equal(s.sourceText,'正文');assert.equal(s.globalStart,s.content.length);
  s.sourceChanged('正文继续');assert.equal(s.emitted,'---\ntags: [课程]\n---\n# 标题\n\n正文继续');
 }],
 ['editing one block preserves surrounding blocks and global selection callbacks',()=>{
  const text='# 前文\n\n**原文**\n\n后文';const s=subject(text);s.selectSource(text.indexOf('原文'),text.indexOf('原文'));
  s.sourceChanged('==新文==');assert.equal(s.emitted,'# 前文\n\n==新文==\n\n后文');
  s.finishEditing();assert.equal(s.activeEditing,false);assert.equal(s.wholeBlocks[1].text,'==新文==');
 }],
 ['tool insertion replaces the active selection rather than appending to the document',()=>{
  const s=subject('前文 原文 后文');s.globalStart=3;s.globalEnd=5;s.insertSnippet('**替换**');
  assert.equal(s.emitted,'前文 **替换** 后文');assert.equal(s.globalStart,'前文 **替换**'.length);
 }],
 ['newline handoff keeps following text and selects only the next paragraph',()=>{
  const s=subject('前半后半\n\n末尾');s.selectSource(2,2);s.sourceChanged('前半\n后半');
  assert.equal(s.emitted,'前半\n后半\n\n末尾');assert.equal(s.sourceText,'后半');
  assert.equal(s.activeRange.start,3);
 }],
 ['focus restoration waits for a mounted visible source and tolerates popup dismissal',()=>{
  const s=subject('正文');let focused=0;
  s.getUIContext=()=>({postFrameCallback:frame=>frame.onIdle(0),getAttachedFrameNodeById:()=>null,getFocusController:()=>({requestFocus(){focused++;}})});
  s.selectSource(1,1);assert.equal(focused,0);
  s.getUIContext=()=>({postFrameCallback:frame=>frame.onIdle(0),getAttachedFrameNodeById:()=>({isAttached:()=>true,isVisible:()=>true}),getFocusController:()=>({requestFocus(){throw Error('150003');}})});
  assert.doesNotThrow(()=>s.selectSource(1,1));assert.equal(s.documentText,'正文');
 }],
 ['code editor keeps fences out of the input and persists a chosen language',()=>{
  const s=subject('前文\n\n```\nconst n = 1;\n```\n\n后文');s.selectSource(s.documentText.indexOf('const'),s.documentText.indexOf('const'));
  assert.equal(s.editingCode,true);assert.equal(s.codeBody,'const n = 1;');
  s.codeChanged('const n = 2;');s.selectCodeLanguage(4);
  assert.equal(s.documentText,'前文\n\n```javascript\nconst n = 2;\n```\n\n后文');
  s.finishEditing();assert.equal(s.activeEditing,false);
 }],
 ['code editor formats valid JSON on exit and leaves raw mode untouched',()=>{
  const s=subject('```json\n{"a":1}\n```');s.selectSource(8,8);s.finishEditing();
  assert.match(s.documentText,/\{\n\s+"a": 1\n\}/);
  const raw=subject('```json\n{"a":1}\n```');raw.selectSource(8,8);raw.showCodeSource=true;raw.finishEditing();
  assert.equal(raw.documentText,'```json\n{"a":1}\n```');
 }]
];
for(const [name,run] of tests){run();console.log('PASS '+name);}
console.log(`${tests.length} live-editor regression groups passed.`);
