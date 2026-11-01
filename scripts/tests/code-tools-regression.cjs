// Execute the real pure ArkTS helper after the same transpilation used by the
// other core regression suites. No device or filesystem mutation is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const filename = path.resolve(__dirname, '../../entry/src/main/ets/core/LexiCodeTools.ets');
const source = fs.readFileSync(filename, 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const moduleScope = { exports: {} };
vm.runInThisContext('(function(module,exports){' + js + '\n})', { filename })(moduleScope, moduleScope.exports);
const { LexiCodeTools: Tools } = moduleScope.exports;
const tests = [];
const test = (name, run) => tests.push([name, run]);

const examples = [
  ['json', '{"title":"知萤","items":[1,true,null]}'],
  ['json', '[1,2,3]'],
  ['arkts', '@Entry\n@Component\nstruct Demo { build() { Column() { Text("hi") } } }'],
  ['typescript', 'const count: number = 1;'],
  ['typescript', 'interface Person { name: string; }'],
  ['typescript', 'function greet(name: string): string { return name; }'],
  ['javascript', 'const count = 1;\nconsole.log(count);'],
  ['javascript', 'function greet(name) { return name; }'],
  ['javascript', 'import React from "react";'],
  ['python', 'def greet(name):\n    return name'],
  ['python', '# Python example\nimport os\nprint(os.name)'],
  ['python', '#!/usr/bin/env python3\nprint("hello")'],
  ['html', '<!DOCTYPE html>\n<html><body>hi</body></html>'],
  ['html', '<div class="card">Hello</div>'],
  ['css', '.card { display: flex; gap: 8px; }'],
  ['css', 'body { color: red; }'],
  ['sql', '-- example\nSELECT name FROM notes WHERE id = 1;'],
  ['sql', 'INSERT INTO notes (title) VALUES (\'hello\');'],
  ['sql', 'UPDATE notes SET title = \'hi\' WHERE id = 1;'],
  ['java', 'public class Main { public static void main(String[] args) {} }'],
  ['java', 'package com.example;\npublic class Main {}'],
  ['c', '#include <stdio.h>\nint main(void) { printf("hi"); return 0; }'],
  ['cpp', '#include <iostream>\nint main() { std::cout << "hi"; }'],
  ['shell', '#!/bin/bash\necho "hello"'],
  ['shell', 'set -euo pipefail\necho "hello"']
];
for (const [language, code] of examples) {
  test('detects ' + language + ': ' + code.split('\n')[0], () => assert.equal(Tools.detect(code), language));
}

test('uncertain or unsupported text has no invented language', () => {
  for (const code of ['', 'hello world', '123', 'true', '"a string"', 'key: value', '{broken json}', '// comment only']) {
    assert.equal(Tools.detect(code), '', code);
  }
});
test('JSON formatting indents while retaining every original value token', () => {
  const code = '{"a":[1,{"b":true}],"c":null}';
  assert.equal(Tools.format(code, 'json'), '{\n  "a": [\n    1,\n    {\n      "b": true\n    }\n  ],\n  "c": null\n}');
  assert.deepEqual(JSON.parse(Tools.format(code, 'json')), JSON.parse(code));
});
test('JSON keeps large numeric literals, negative zero, duplicate keys and escapes', () => {
  const formatted = Tools.format('{"big":9007199254740993,"zero":-0,"x":1,"x":2,"escaped":"\\u0041","n":1e+40}', 'json');
  for (const token of ['9007199254740993', '-0', '"x": 1', '"x": 2', '"\\u0041"', '1e+40']) assert.ok(formatted.includes(token), token);
});
test('JSON punctuation and escaped quotes inside strings remain data', () => {
  const code = '{"s":"{ [ , : ] } \\"quoted\\"","path":"a\\\\b","line":"a\\nb"}';
  assert.deepEqual(JSON.parse(Tools.format(code, 'json')), JSON.parse(code));
});
test('empty JSON collections and explicit primitive JSON are supported', () => {
  assert.equal(Tools.format(' {  } ', 'json'), '{}');
  assert.equal(Tools.format('[ ]', 'json'), '[]');
  assert.equal(Tools.format('  -0  ', 'json'), '-0');
});
test('invalid JSON and unsupported languages remain byte-for-byte unchanged', () => {
  for (const code of ['{"a":}', '{"a":1,}', '{"a":NaN}', '{"a":1}\nextra']) assert.equal(Tools.format(code, 'json'), code);
  const raw = 'key: value   \r\n  next: yes  \r\n';
  assert.equal(Tools.format(raw, 'yaml'), raw);
  assert.equal(Tools.format(raw, 'plaintext'), raw);
});
test('ordinary code only loses safe trailing whitespace and keeps indentation and newlines', () => {
  const code = 'const x: number = 1;   \r\n\tconsole.log(x);\t\r\n';
  assert.equal(Tools.format(code, 'ts'), 'const x: number = 1;\r\n\tconsole.log(x);\r\n');
});
test('Python indentation and comment bytes remain unchanged', () => {
  const code = 'def greet(name):   \n\tif name:  \n\t\treturn "hello "  # comment   \n\treturn ""   \n';
  assert.equal(Tools.format(code, 'py'), 'def greet(name):\n\tif name:\n\t\treturn "hello "  # comment   \n\treturn ""\n');
});
test('Python triple-quoted strings remain completely unchanged', () => {
  for (const code of ['value = """\n  data   \n"""\nprint(value)   ', "value = '''\n  data   \n'''\nprint(value)   "]) assert.equal(Tools.format(code, 'python'), code);
});
test('JS template literals and escaped continuations remain completely unchanged', () => {
  for (const code of ['const s = `line   \n  data   `;   ', "const s = 'line\\\n  data';   "]) assert.equal(Tools.format(code, 'javascript'), code);
});
test('multiline quoted data and Java text blocks remain completely unchanged', () => {
  const sql = "SELECT 'line   \n  content   ' AS text;   ";
  const java = 'String s = """\n  data   \n""";   ';
  assert.equal(Tools.format(sql, 'sql'), sql);
  assert.equal(Tools.format(java, 'java'), java);
});
test('line and block comment contents retain their trailing whitespace', () => {
  const code = 'const x = 1;   \n/* comment   \n * data   \n */   \n// last comment   \nconst y = 2;   ';
  assert.equal(Tools.format(code, 'js'), 'const x = 1;\n/* comment   \n * data   \n */   \n// last comment   \nconst y = 2;');
});
test('HTML text and shell heredoc whitespace remain byte-for-byte unchanged', () => {
  const html = '<pre>line   \n  text   </pre>   \n';
  const shell = 'cat <<\'EOF\'\n  data   \nEOF\necho done   \n';
  assert.equal(Tools.format(html, 'html'), html);
  assert.equal(Tools.format(shell, 'bash'), shell);
});
test('SQL dollar strings and C++ raw strings are preserved', () => {
  const sql = 'SELECT $text$line   \n  data   $text$;   ';
  const cpp = 'const char* s = R"(line   \n  data   )";   ';
  assert.equal(Tools.format(sql, 'sql'), sql);
  assert.equal(Tools.format(cpp, 'cpp'), cpp);
});
test('C++ raw string data keeps embedded quotes and custom delimiters', () => {
  const cpp = 'const char* s = R"tag(data " quote   \n  content   )tag";   ';
  assert.equal(Tools.format(cpp, 'cpp'), cpp);
});
test('SQL bracket identifiers retain whitespace inside multiline identifiers', () => {
  const sql = 'SELECT [line   \n  identifier] FROM notes;   ';
  assert.equal(Tools.format(sql, 'sql'), sql);
});
test('unknown language preserves content and auto formatting uses confident detection', () => {
  const raw = 'This is a sentence.   \n';
  assert.equal(Tools.format(raw, ''), raw);
  assert.equal(Tools.format('{"a":1}', ''), '{\n  "a": 1\n}');
});
test('formatting is idempotent', () => {
  for (const [language, code] of examples) {
    const first = Tools.format(code, language);
    assert.equal(Tools.format(first, language), first, language);
  }
});
test('very deep JSON and oversized input do not create huge formatting output', () => {
  const deep = '['.repeat(129) + '1' + ']'.repeat(129);
  assert.equal(Tools.format(deep, 'json'), deep);
  const huge = 'const x = 1;\n'.repeat(24000);
  assert.equal(Tools.format(huge, 'javascript'), huge);
  assert.equal(Tools.detect(huge), '');
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
if (failed) process.exitCode = 1;
else console.log(tests.length + ' code-tool regression checks passed. Pure logic; no syntax-aware reindentation is claimed.');
