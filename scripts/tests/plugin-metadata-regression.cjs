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
const {LexiMetadataModel}=load('plugin/LexiMetadataModel');

const content=[
 '---',
 'title: 插件笔记',
 'tags: [学习, plugin]',
 'status: draft',
 '---',
 '# 总览',
 '',
 '参考 [[读书笔记|这本书]] 与 [官方文档](https://example.com/docs)。',
 '',
 '```ts',
 '// #tag_in_code 不应计入标签',
 '```',
 '',
 '- 记录 #学习/方法 一条'
].join('\n');

const tests=[
 ['headings carry line-level positions after frontmatter',()=>{
  const cache=LexiMetadataModel.build(content);
  assert.equal(cache.headings.length,1);
  const heading=cache.headings[0];
  assert.equal(heading.heading,'总览');
  assert.equal(heading.level,1);
  assert.equal(heading.position.start.line,5);
  assert.equal(heading.position.start.col,0);
  assert.equal(content.slice(heading.position.start.offset,heading.position.end.offset),'# 总览');
 }],
 ['wiki and markdown links both appear with exact positions',()=>{
  const cache=LexiMetadataModel.build(content);
  assert.equal(cache.links.length,2);
  const wiki=cache.links[0];
  assert.equal(wiki.link,'读书笔记');
  assert.equal(wiki.displayText,'这本书');
  assert.equal(wiki.original,'[[读书笔记|这本书]]');
  assert.equal(content.slice(wiki.position.start.offset,wiki.position.end.offset),'[[读书笔记|这本书]]');
  const markdown=cache.links[1];
  assert.equal(markdown.link,'https://example.com/docs');
  assert.equal(markdown.displayText,'官方文档');
  assert.equal(markdown.position.start.line,7);
 }],
 ['inline tags skip fenced code and keep positions',()=>{
  const cache=LexiMetadataModel.build(content);
  const tags=cache.tags.map(t=>t.tag);
  assert.deepEqual(tags,['学习/方法']);
  const tag=cache.tags[0];
  assert.equal(content.slice(tag.position.start.offset,tag.position.end.offset),'#学习/方法');
  assert.equal(tag.position.start.line,13);
 }],
 ['frontmatter projects tags and properties with its position',()=>{
  const cache=LexiMetadataModel.build(content);
  assert.equal(cache.frontmatter['tags'].length,2);
  assert.equal(cache.frontmatter['status'],'draft');
  assert.ok(cache.frontmatterPosition.end.offset>0);
  const headerText=content.slice(0,cache.frontmatterPosition.end.offset);
  assert.ok(headerText.startsWith('---'));
  assert.ok(headerText.includes('status: draft'));
 }],
 ['sections map block kinds onto the Obsidian type set',()=>{
  const cache=LexiMetadataModel.build(content);
  const types=cache.sections.map(s=>s.type);
  assert.equal(types[0],'heading'); // body blocks start after the YAML header
  assert.ok(types.includes('code'));
  assert.ok(types.includes('list'));
  assert.ok(!types.includes('yaml'));
 }],
 ['plain markdown without extras yields null collections',()=>{
  const cache=LexiMetadataModel.build('只有一段话');
  assert.equal(cache.headings,null);
  assert.equal(cache.links,null);
  assert.equal(cache.tags,null);
  assert.equal(cache.frontmatter,null);
  assert.equal(cache.sections.length,1);
  assert.equal(cache.sections[0].type,'paragraph');
 }]
];
(async()=>{
 let failed=0;
 for(const[name,run]of tests){
  try{await run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-metadata-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
