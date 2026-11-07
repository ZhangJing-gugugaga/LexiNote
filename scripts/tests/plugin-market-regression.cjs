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
const {parseMarketIndex,parseMarketIndexResult,isTrustedInstallHash,marketSourceKindOf,isProductionBlockedSource,PRODUCTION_HTTP_BLOCKED_MESSAGE}=load('plugin/LexiPluginMarketModel');

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
 }],
 // P5-005 源形态:生产构建 https 强制(明文 http 只在调试构建放行,演示源 10.0.2.2:8099 依赖)。
 ['P5-005 source kinds: dev-http marked, https trusted, production blocks http only',()=>{
  assert.equal(marketSourceKindOf('https://market.example.com/a.zip'),'https');
  assert.equal(marketSourceKindOf('http://10.0.2.2:8099/market.json'),'dev-http');
  assert.equal(marketSourceKindOf(' HTTP://host/a.zip '),'dev-http','scheme 判定大小写不敏感且先去空白');
  assert.equal(marketSourceKindOf('ftp://x/a.zip'),'other');
  assert.equal(marketSourceKindOf(''),'other');
  // 判定矩阵:只有(生产构建 × dev-http)是红灯;调试构建 http 放行是 flows 演示流的硬前提。
  assert.equal(isProductionBlockedSource('http://10.0.2.2:8099/market.json',false),true,'生产构建拒绝明文 http');
  assert.equal(isProductionBlockedSource('http://10.0.2.2:8099/market.json',true),false,'调试构建保留演示源');
  assert.equal(isProductionBlockedSource('https://market.example.com/a.zip',false),false,'https 生产可用');
  assert.equal(isProductionBlockedSource('https://market.example.com/a.zip',true),false);
  assert.equal(isProductionBlockedSource('ftp://x/a.zip',false),false,'非 http(s) 由安装口 scheme 白名单拒绝,源闸不扩权');
  assert.equal(typeof PRODUCTION_HTTP_BLOCKED_MESSAGE === 'string' && PRODUCTION_HTTP_BLOCKED_MESSAGE.length > 0, true,
    '拒绝话术必须存在(宿主与 UI 共用同一句,保证语义一致上屏)');
  // v1 索引里的 http 条目照常解析(展示面),但源形态可判——安装口据此拒绝/放行。
  const v1=parseMarketIndexResult(JSON.stringify({schemaVersion:1,plugins:[
    {id:'dev',name:'D',version:'1.0.0',author:'t',zipUrl:'http://10.0.2.2:8099/dev.zip',sha256:'a'.repeat(64)},
    {id:'prod',name:'P',version:'1.0.0',author:'t',zipUrl:'https://market.example.com/prod.zip',sha256:'b'.repeat(64)}
  ]}));
  assert.equal(v1.ok,true);
  assert.equal(marketSourceKindOf(v1.entries[0].zipUrl),'dev-http','解析后的条目仍可判源形态(UI 据此打开发源标记)');
  assert.equal(marketSourceKindOf(v1.entries[1].zipUrl),'https');
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
