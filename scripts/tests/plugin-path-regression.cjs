const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core=path.resolve(__dirname,'../../entry/src/main/ets/core');
const cache=new Map();
function load(spec,fromDir){
 const base=spec.startsWith('.')?path.resolve(fromDir||core,spec):path.resolve(core,spec);
 const target=base.endsWith('.ets')?base:base+'.ets';
 if(cache.has(target))return cache.get(target);
 const js=ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const mod={exports:{}};cache.set(target,mod.exports);
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:target})(
  s=>load(s,path.dirname(target)),mod,mod.exports);
 cache.set(target,mod.exports);return mod.exports;
}
const model=load('plugin/LexiVaultModel');
const {NoteItem}=load('LexiModels');
const {buildVaultIndex,normalizePath,resolvePath,LexiTFolder,LexiTFile}=model;

function note(id,vaultId,title,notebook,projectId,content){
 const item=new NoteItem();
 item.id=id;item.vaultId=vaultId;item.title=title;item.notebook=notebook;
 item.projectId=projectId||'';item.content=content||`# ${title}\n`;item.updatedAt=1000+item.id.length;
 item.createdAt=900;return item;
}

// 调用方只传入当前活动库的笔记(与 LexiVaultFacade.refresh 一致)
const projectNames=new Map([['p1','毕业论文']]);

const index=buildVaultIndex([
 note('a1','v1','日记','日常记录 / 日记'),
 note('a2','v1','读书笔记','学习笔记','p1'),
 note('a3','v1','读书笔记','学习笔记','p1'),        // 同笔记本同名 → id 后缀
 note('a5','v1','被删除的笔记','日常记录 / 日记')
].map(n=>{if(n.id==='a5'){n.trashedAt=42;}return n;}),projectNames);

const tests=[
 ['normalizePath collapses slashes and trims edges',()=>{
  assert.equal(normalizePath('  a\\\\b//c/  '),'a/b/c');
  assert.equal(normalizePath('/root/'),'root');
  assert.equal(normalizePath(''),'');
 }],
 ['virtual paths are vault-relative like Obsidian (project/notebook/title)',()=>{
  // Notebooks keep their display name; illegal path chars (including '/') are sanitized.
  const file=resolvePath(index,'/日常记录 _ 日记/日记.md');
  assert.ok(file instanceof LexiTFile);
  assert.equal(file.noteId,'a1');
  assert.equal(file.basename,'日记');
  assert.equal(file.stat.mtime,1002);
  const nested=resolvePath(index,'/毕业论文/学习笔记/读书笔记.md');
  assert.ok(nested instanceof LexiTFile);
  assert.equal(nested.noteId,'a2');
  const folder=resolvePath(index,'毕业论文');
  assert.ok(folder instanceof LexiTFolder);
  assert.equal(folder.children.length,1);
 }],
 ['duplicate titles inside one notebook get a stable id suffix',()=>{
  const first=resolvePath(index,'/毕业论文/学习笔记/读书笔记.md');
  const second=resolvePath(index,'/毕业论文/学习笔记/读书笔记 a3.md');
  assert.equal(first.noteId,'a2');
  assert.equal(second.noteId,'a3');
 }],
 ['trashed notes are invisible in the path space',()=>{
  assert.equal(resolvePath(index,'/日常记录 _ 日记/被删除的笔记.md'),null);
 }],
 ['project names map to ids for path resolution',()=>{
  assert.equal(index.projectIdByName.get('毕业论文'),'p1');
 }],
 ['folders resolve even without notes beneath, unknown roots stay null',()=>{
  assert.ok(resolvePath(index,'毕业论文') instanceof LexiTFolder);
  assert.equal(resolvePath(index,'不存在/路径.md'),null);
 }]
];
(async()=>{
 let failed=0;
 for(const[name,run]of tests){
  try{await run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-path-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
