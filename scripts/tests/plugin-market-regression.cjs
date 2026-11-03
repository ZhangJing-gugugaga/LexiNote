const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core=path.resolve(__dirname,'../../entry/src/main/ets/core');
function load(spec,base){
 const target=path.resolve(base||core,spec+'.ets');
 const js=ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const mod={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:target})((s)=>load(s,path.dirname(target)),mod,mod.exports);
 return mod.exports;
}
const {parseMarketIndex,parseMarketIndexResult}=load('plugin/LexiPluginMarketModel');

// 逐字段 assert.equal 会静默接受解析结果里"多出来的字段"——循环照样通过。
// 键集先钉死:新增字段必须显式改这份期望,不许自动通过。
const ENTRY_KEYS=['author','capabilities','capabilitiesDeclared','description','id','isDesktopOnly','minApiVersion','name','repo','sha256','updatedAt','version','zipUrl'];

const tests=[
 ['parses the Obsidian-style array form',()=>{
  const entries=parseMarketIndex(JSON.stringify([
   {id:'a',name:'A 插件',author:'作者',description:'desc',repo:'u/a',version:'1.0.0',zipUrl:'https://x/a.zip'},
   {id:'b',name:'B'}
  ]));
  assert.equal(entries.length,2);
  assert.deepEqual(Object.keys(entries[0]).sort(),ENTRY_KEYS,'解析结果的键集变了:必须显式更新 ENTRY_KEYS');
  for(const[field,value]of Object.entries({id:'a',name:'A 插件',author:'作者',description:'desc',repo:'u/a',version:'1.0.0',zipUrl:'https://x/a.zip'})){
   assert.equal(entries[0][field],value,'field '+field);
  }
  assert.equal(entries[1].zipUrl,'');
 }],
 ['parses the wrapped {plugins:[...]} form',()=>{
  const entries=parseMarketIndex(JSON.stringify({plugins:[{id:'w',name:'W'}]}));
  assert.equal(entries.length,1);
  assert.equal(entries[0].id,'w');
 }],
 ['drops entries without id or name and survives garbage',()=>{
  assert.equal(parseMarketIndex('not-json').length,0);
  assert.equal(parseMarketIndex('{}').length,0);
  assert.equal(parseMarketIndex(JSON.stringify([{name:'no-id'},{id:'no-name'},null,42])).length,0);
 }],
 // 兼容展示 ≠ 可信安装:旧版条目照常解析,但 sha256 必为空,上游信任闸门据此拒绝远程安装。
 // warnings 曾经无人读取——这里钉死"旧版可识别"契约,配合 installFromUrl 的 fail-closed 闸门。
 ['legacy entries stay displayable but untrusted (empty hash + warning)',()=>{
  const arr=parseMarketIndexResult(JSON.stringify([{id:'x',name:'X',zipUrl:'https://x/a.zip'}]));
  assert.equal(arr.ok,true);
  assert.deepEqual(arr.warnings,['legacy_array_schema']);
  assert.equal(arr.entries.length,1);
  assert.equal(arr.entries[0].sha256,'','旧版条目必须显式暴露为空哈希');
  const wrapped=parseMarketIndexResult(JSON.stringify({plugins:[{id:'y',name:'Y'}]}));
  assert.deepEqual(wrapped.warnings,['legacy_object_schema']);
 }]
];
(async()=>{
 let failed=0;
 for(const[name,run]of tests){
  try{run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-market-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
