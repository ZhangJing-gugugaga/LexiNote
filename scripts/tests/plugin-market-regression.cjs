const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core=path.resolve(__dirname,'../../entry/src/main/ets/core');
function load(spec){
 const target=path.resolve(core,spec+'.ets');
 const js=ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const mod={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:target})((s)=>load(s),mod,mod.exports);
 return mod.exports;
}
const {parseMarketIndex}=load('plugin/LexiPluginMarketModel');

const tests=[
 ['parses the Obsidian-style array form',()=>{
  const entries=parseMarketIndex(JSON.stringify([
   {id:'a',name:'A 插件',author:'作者',description:'desc',repo:'u/a',version:'1.0.0',zipUrl:'https://x/a.zip'},
   {id:'b',name:'B'}
  ]));
  assert.equal(entries.length,2);
  assert.deepEqual({...entries[0]},{id:'a',name:'A 插件',author:'作者',description:'desc',repo:'u/a',version:'1.0.0',zipUrl:'https://x/a.zip'});
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
