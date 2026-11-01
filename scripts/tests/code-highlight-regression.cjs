const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const filename=path.resolve(__dirname,'../../entry/src/main/ets/core/LexiCodeHighlight.ets');
const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
const mod={exports:{}};vm.runInThisContext('(function(module,exports){'+js+'})',{filename})(mod,mod.exports);
const H=mod.exports.LexiCodeHighlight;
function tokens(text,language){const result=H.tokenize(text,language);assert.equal(result.map(t=>t.text).join(''),text);assert.equal(new Set(result.map(t=>t.id)).size,result.length);return result;}
function luminance(hex){const values=hex.replace('#','').match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return values[0]*.2126+values[1]*.7152+values[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const tests=[
 ['language aliases and unspecified fences have readable labels',()=>{
  for(const [raw,expected] of [['ts','typescript'],['language-js','javascript'],['ets','arkts'],['py','python'],['c++','cpp'],['bash','shell'],['YML','yaml'],['ts title="demo"','typescript']])assert.equal(H.normalizeLanguage(raw),expected);
  for(const raw of ['', 'code', 'auto', 'plaintext'])assert.equal(H.normalizeLanguage(raw),'');
  assert.equal(H.label(''),'未指定语言');assert.equal(H.label('ts'),'TypeScript');
 }],
 ['JavaScript strings, templates, comments and regex retain lexical boundaries',()=>{
  const source='const url = "https://example.com/#a";\nconst text = `**not Markdown** [[link]]`; // return 23\nconst re = /https?:\\/\\/[^ ]+/gi;\nreturn-value;';
  const result=tokens(source,'js');
  assert.ok(result.some(t=>t.kind==='keyword'&&t.text==='const'));
  assert.ok(result.some(t=>t.kind==='string'&&t.text==='"https://example.com/#a"'));
  assert.ok(result.some(t=>t.kind==='string'&&t.text.includes('[[link]]')));
  assert.ok(result.some(t=>t.kind==='comment'&&t.text==='// return 23'));
  assert.ok(result.some(t=>t.kind==='string'&&t.text.startsWith('/https?')));
  assert.ok(result.some(t=>t.kind==='keyword'&&t.text==='return'));
 }],
 ['block comments shield apparent strings and keywords',()=>{
  const result=tokens('/* "const"\nreturn 123 */\nint main() { return 0; }','c');
  assert.equal(result[0].kind,'comment');assert.ok(result.some(t=>t.kind==='function'&&t.text==='main'));
  assert.equal(result.filter(t=>t.kind==='keyword'&&t.text==='return').length,1);
 }],
 ['Python triple quotes and hash comments stay separate',()=>{
  const result=tokens('def run():\n    """# literal\nreturn 12"""\n    value = "# inside" # actual\n    return 2','py');
  assert.ok(result.some(t=>t.kind==='string'&&t.text==='"""# literal\nreturn 12"""'));
  assert.deepEqual(result.filter(t=>t.kind==='comment').map(t=>t.text),['# actual']);
  assert.equal(result.filter(t=>t.kind==='keyword'&&t.text==='return').length,1);
 }],
 ['JSON distinguishes keys, values, numbers and literals without Markdown parsing',()=>{
  const result=tokens('{"title":"**raw**", "url":"//raw", "count":2e3, "ok":true}','json');
  assert.equal(result.filter(t=>t.kind==='property').length,4);
  assert.ok(result.some(t=>t.kind==='number'&&t.text==='2e3'));
  assert.ok(result.some(t=>t.kind==='keyword'&&t.text==='true'));
  assert.equal(result.filter(t=>t.kind==='comment').length,0);
 }],
 ['SQL, shell, YAML, HTML and CSS use their own comment rules',()=>{
  assert.ok(tokens("SELECT '*not*' FROM notes -- from ignored\nWHERE id=7;",'sql').some(t=>t.kind==='keyword'&&t.text==='SELECT'));
  assert.equal(tokens('curl https://example.com # comment','shell').filter(t=>t.kind==='comment')[0].text,'# comment');
  assert.equal(tokens('key: a#b\n# actual','yaml').filter(t=>t.kind==='comment').length,1);
  const markup=tokens('<div class="return">text</div><!-- const -->','html');
  assert.ok(markup.some(t=>t.kind==='tag'&&t.text==='div'));assert.ok(markup.some(t=>t.kind==='property'&&t.text==='class'));
  assert.equal(markup.filter(t=>t.kind==='comment')[0].text,'<!-- const -->');
  assert.equal(tokens('a { content: "// text"; } /* actual */','css').filter(t=>t.kind==='comment').length,1);
 }],
 ['unknown languages preserve Unicode, CRLF and incomplete source as plain text',()=>{
  const raw='**粗体**\r\n[[目标]]\r\n😀 <tag>\n"unfinished';
  const result=tokens(raw,'unknown-language');assert.equal(result.length,1);assert.equal(result[0].kind,'text');
  tokens('const value = "unfinished\nreturn 3;','ts');
 }],
 ['large blocks bound Span count without discarding source',()=>{
  const raw='const x = 1; // repeated\n'.repeat(8000);const result=tokens(raw,'ts');
  assert.ok(result.length<=4001);assert.ok(result[result.length-1].text.length>1000);
 }],
 ['all syntax colors meet 4.5 contrast against both existing code surfaces',()=>{
  for(const dark of [false,true])for(const kind of ['text','keyword','string','number','comment','function','property','tag','punctuation']){
   const color=H.color(kind,dark);assert.ok(contrast(color,dark?'#2D2F3E':'#EEEAF8')>=4.5,`${kind} ${color} contrast`);
  }
 }],
];
for(const [name,run] of tests){run();console.log('PASS '+name);}
console.log(`${tests.length} code-highlight regression groups passed.`);
