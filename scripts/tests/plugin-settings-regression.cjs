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
const {parseSettingDefinitions}=load('plugin/LexiPluginSettingModel');

const tests=[
 ['parses supported control types with defaults',()=>{
  const defs=parseSettingDefinitions(JSON.stringify([
   {type:'heading',name:'标题'},
   {type:'toggle',name:'开关',key:'a',default:true},
   {type:'text',name:'文本',key:'b',default:'hi',placeholder:'输入'},
   {type:'dropdown',name:'选项',key:'c',default:'x',options:{x:'X 选项',y:'Y 选项'}},
   {type:'slider',name:'数值',key:'d',default:5,min:1,max:10,step:1}
  ]));
  assert.equal(defs.length,5);
  assert.equal(defs[0].type,'heading');
  assert.equal(defs[1].defaultValue,'true');
  assert.equal(defs[2].placeholder,'输入');
  assert.equal(defs[3].optionsJson,JSON.stringify({x:'X 选项',y:'Y 选项'}));
  assert.deepEqual([defs[4].min,defs[4].max,defs[4].step],[1,10,1]);
 }],
 ['drops invalid entries and unknown types fall back to text',()=>{
  const defs=parseSettingDefinitions(JSON.stringify([
   {type:'toggle',key:'no-name'},
   {type:'text',name:'no-key'},
   {type:'weird',name:'未知类型',key:'w'},
   'garbage', null, 7
  ]));
  assert.equal(defs.length,1);
  assert.equal(defs[0].type,'text');
  assert.equal(defs[0].key,'w');
 }],
 ['survives malformed json',()=>{
  assert.equal(parseSettingDefinitions('nope').length,0);
  assert.equal(parseSettingDefinitions('{}').length,0);
 }]
];
(async()=>{
 let failed=0;
 for(const[name,run]of tests){
  try{run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-settings-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
