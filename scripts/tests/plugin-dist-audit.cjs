#!/usr/bin/env node
// Static review gate for a plugin package (zip or extracted directory).
// Everything here is offline: no device, no network, no execution of plugin code.
//
//   node scripts/tests/plugin-dist-audit.cjs <path-to-zip-or-dir> [--json <out>]
//   node scripts/tests/plugin-dist-audit.cjs --all [--json <out>]
//
// Findings are split into two severities: "critical" makes the command exit 1,
// "info" is reported but stays green. Rules:
//   dynamic-code   eval(...) / new Function(...) anywhere in shipped JS
//   network-host   a literal URL in fetch / XMLHttpRequest.open / requestUrl that the
//                  manifest never declared in capabilities.network
//   module         require / import of a module outside obsidian, lexinote, @codemirror/*
//   dynamic-import import(...) with a computed specifier
'use strict';
const fs = require('fs');
const path = require('path');
const { readZip } = require('../../tools/plugin-dist/zip-store.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_ROOT = path.join(REPO_ROOT, '.fixtures-out');
const MALICIOUS_ROOT = path.join(REPO_ROOT, 'tools', 'plugin-dist', 'samples', 'malicious-plugin');

const ALLOWED_MODULES = ['obsidian', 'lexinote'];
const ALLOWED_MODULE_PREFIXES = ['@codemirror/'];
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const BT = String.fromCharCode(96);
const QUOTE = '[\'"`]';

const RULES = {
  DYNAMIC_CODE: 'dynamic-code',
  NETWORK_HOST: 'network-host',
  MODULE: 'module',
  DYNAMIC_IMPORT: 'dynamic-import'
};

const REQUIRED_MATRIX = [
  { id: 'view-calendar', dir: path.join(FIXTURES_ROOT, 'view-calendar'), expect: 'clean' },
  { id: 'editor-outliner', dir: path.join(FIXTURES_ROOT, 'editor-outliner'), expect: 'clean' },
  { id: 'theme-minimal', dir: path.join(FIXTURES_ROOT, 'theme-minimal'), expect: 'clean' },
  { id: 'malicious-plugin', dir: MALICIOUS_ROOT, expect: 'critical' }
];

function listFiles(root) {
  const out = [];
  const walk = (absolute, prefix) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(absolute, entry.name);
      if (entry.isDirectory()) { walk(full, name); } else { out.push({ name, data: fs.readFileSync(full) }); }
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function loadPackage(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) { return { kind: 'directory', entries: listFiles(target) }; }
  return { kind: 'zip', entries: readZip(fs.readFileSync(target)) };
}

function findManifest(entries) {
  const hits = entries.filter((entry) => entry.name === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(entry.name));
  if (hits.length === 0) { return { manifest: null, entry: null }; }
  const chosen = hits[0];
  try { return { manifest: JSON.parse(chosen.data.toString('utf8')), entry: chosen.name }; }
  catch (error) { return { manifest: null, entry: chosen.name }; }
}

function declaredHosts(manifest) {
  const caps = manifest && manifest.capabilities;
  const network = caps && Array.isArray(caps.network) ? caps.network : [];
  return network.map((host) => String(host).trim().toLowerCase()).filter((host) => host.length > 0);
}

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : '';
}

function hostDeclared(host, declared) {
  for (const rule of declared) {
    if (rule === host) { return true; }
    if (rule.startsWith('*.') && host.endsWith(rule.slice(1))) { return true; }
  }
  return false;
}

function moduleAllowed(specifier) {
  const clean = specifier.replace(/^node:/, '');
  if (ALLOWED_MODULES.indexOf(clean) >= 0) { return true; }
  for (const prefix of ALLOWED_MODULE_PREFIXES) { if (clean.startsWith(prefix)) { return true; } }
  return false;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) { if (text.charCodeAt(i) === 10) { line++; } }
  return line;
}

function snippet(text, index, length) {
  const start = Math.max(0, index - 20);
  const raw = text.slice(start, Math.min(text.length, index + length + 40)).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + raw.trim() + (index + length + 40 < text.length ? '…' : '');
}

function scanJs(file, text, declared) {
  const findings = [];
  const push = (rule, index, length, detail) => {
    findings.push({ rule, severity: 'critical', file, line: lineOf(text, index), evidence: snippet(text, index, length), detail });
  };

  // Only the global form counts: "obj.eval(...)" is an ordinary method call (bundled
  // Outliner code does exactly that), while a bare "eval(" is code-from-string.
  const globalEval = /(^|[^.\w$])eval\s*\(/g;
  let match = globalEval.exec(text);
  while (match) {
    const start = match.index + match[1].length;
    // "eval(root, op, editor) {" is a method *definition*, not a call (bundled Outliner).
    const isMethodDefinition = /^eval\s*\(\s*[A-Za-z_$][\w$]*(\s*,\s*[A-Za-z_$][\w$]*)*\s*\)\s*\{/.test(text.slice(start, start + 200));
    if (!isMethodDefinition) { push(RULES.DYNAMIC_CODE, start, 5, '全局 eval 执行运行时字符串，静态不可审'); }
    match = globalEval.exec(text);
  }
  const newFunction = /\bnew\s+Function\s*\(/g;
  match = newFunction.exec(text);
  while (match) {
    push(RULES.DYNAMIC_CODE, match.index, match[0].length, 'new Function 由字符串构造函数，静态不可审');
    match = newFunction.exec(text);
  }

  const fetchLiteral = new RegExp('\\bfetch\\s*\\(\\s*' + QUOTE + '([^\'"' + BT + '\\s]+)' + QUOTE, 'g');
  match = fetchLiteral.exec(text);
  while (match) {
    const url = match[1];
    const host = hostOf(url);
    if (!hostDeclared(host, declared)) {
      push(RULES.NETWORK_HOST, match.index, match[0].length, 'fetch 指向未在 capabilities.network 声明的域名: ' + (host || url));
    }
    match = fetchLiteral.exec(text);
  }

  const openLiteral = new RegExp('\\.open\\s*\\(\\s*' + QUOTE + '[^\'"' + BT + ']*' + QUOTE + '\\s*,\\s*' + QUOTE + '([^\'"' + BT + '\\s]+)' + QUOTE, 'g');
  match = openLiteral.exec(text);
  while (match) {
    const url = match[1];
    const host = hostOf(url);
    if (!hostDeclared(host, declared)) {
      push(RULES.NETWORK_HOST, match.index, match[0].length, 'XMLHttpRequest.open 指向未声明的域名: ' + (host || url));
    }
    match = openLiteral.exec(text);
  }

  const requestUrlLiteral = new RegExp('requestUrl\\s*\\(\\s*\\{[^{}]*?url\\s*:\\s*' + QUOTE + '([^\'"' + BT + '\\s]+)' + QUOTE, 'g');
  match = requestUrlLiteral.exec(text);
  while (match) {
    const url = match[1];
    const host = hostOf(url);
    if (!hostDeclared(host, declared)) {
      push(RULES.NETWORK_HOST, match.index, match[0].length, 'requestUrl 指向未声明的域名: ' + (host || url));
    }
    match = requestUrlLiteral.exec(text);
  }

  const requireCall = new RegExp('\\brequire\\s*\\(\\s*' + QUOTE + '([^\'"' + BT + ']+)' + QUOTE + '\\s*\\)', 'g');
  match = requireCall.exec(text);
  while (match) {
    if (!moduleAllowed(match[1])) {
      push(RULES.MODULE, match.index, match[0].length, 'require 了非允许模块: ' + match[1]);
    }
    match = requireCall.exec(text);
  }

  const esImport = new RegExp('\\bfrom\\s+' + QUOTE + '([^\'"' + BT + ']+)' + QUOTE, 'g');
  match = esImport.exec(text);
  while (match) {
    if (!moduleAllowed(match[1])) {
      push(RULES.MODULE, match.index, match[0].length, 'import 了非允许模块: ' + match[1]);
    }
    match = esImport.exec(text);
  }

  const dynamicImport = /\bimport\s*\(\s*([^)]{0,120})/g;
  match = dynamicImport.exec(text);
  while (match) {
    const arg = match[1].trim();
    const literal = new RegExp('^' + QUOTE + '([^\'"' + BT + ']+)' + QUOTE + '\\s*\\)?').exec(arg);
    if (!literal) {
      push(RULES.DYNAMIC_IMPORT, match.index, match[0].length, '动态 import 的模块名是计算出来的: ' + arg.slice(0, 60));
    } else if (!moduleAllowed(literal[1])) {
      push(RULES.DYNAMIC_IMPORT, match.index, match[0].length, '动态 import 了非允许模块: ' + literal[1]);
    }
    match = dynamicImport.exec(text);
  }

  return findings;
}

function auditPackage(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) { throw new Error('目标不存在: ' + resolved); }
  const loaded = loadPackage(resolved);
  const found = findManifest(loaded.entries);
  const declared = declaredHosts(found.manifest);
  const scripts = loaded.entries.filter((file) => JS_EXTENSIONS.indexOf(path.extname(file.name)) >= 0);
  const findings = [];
  for (const script of scripts) {
    const found2 = scanJs(script.name, script.data.toString('utf8'), declared);
    for (const item of found2) { findings.push(item); }
  }
  const critical = findings.filter((finding) => finding.severity === 'critical').length;
  return {
    target: resolved,
    kind: loaded.kind,
    manifestEntry: found.entry,
    manifestId: found.manifest && found.manifest.id ? String(found.manifest.id) : '',
    capabilitiesDeclared: Boolean(found.manifest && found.manifest.capabilities),
    declaredNetwork: declared,
    fileCount: loaded.entries.length,
    scriptCount: scripts.length,
    findings,
    critical,
    verdict: critical > 0 ? 'rejected' : 'clean'
  };
}

function runMatrix(outPath) {
  const results = [];
  let failures = 0;
  for (const item of REQUIRED_MATRIX) {
    if (!fs.existsSync(item.dir)) {
      results.push({ id: item.id, target: item.dir, expect: item.expect, observed: 'missing', verdict: 'missing', critical: 0, findings: [], pass: false });
      failures++;
      continue;
    }
    const report = auditPackage(item.dir);
    const observed = report.critical > 0 ? 'critical' : 'clean';
    const pass = observed === item.expect;
    if (!pass) { failures++; }
    results.push({ id: item.id, target: item.dir, expect: item.expect, observed, verdict: report.verdict, critical: report.critical, findings: report.findings, pass });
  }
  const report = { mode: 'matrix', results, failures, verdict: failures === 0 ? 'ok' : 'mismatch' };
  emit(report, outPath);
  return failures === 0 ? 0 : 1;
}

function summarizeMatrix(report) {
  const lines = ['插件静态审核矩阵（离线）:'];
  for (const item of report.results) {
    const mark = item.verdict === 'missing' ? 'MISSING' : item.pass ? 'PASS' : 'FAIL';
    lines.push('  [' + mark + '] ' + item.id + '  期望=' + item.expect + ' 实测=' + item.observed + ' critical=' + item.critical);
    for (const finding of item.findings) {
      lines.push('      - ' + finding.rule + ' ' + finding.file + ':' + finding.line + '  ' + finding.detail);
    }
  }
  lines.push('  结论: ' + report.verdict + (report.failures ? '  (' + report.failures + ' 项不符)' : ''));
  return lines.join('\n');
}

function emit(report, outPath) {
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2) + '\n');
  }
  if (report.mode === 'matrix') { console.log(summarizeMatrix(report)); }
  else {
    const lines = ['插件静态审核: ' + report.target,
      '  类型=' + report.kind + ' 文件=' + report.fileCount + ' 脚本=' + report.scriptCount +
      ' manifest=' + (report.manifestId || '(未找到)') + ' 声明域名=' + (report.declaredNetwork.join(',') || '(无)')];
    if (report.findings.length === 0) { lines.push('  未命中任何危险模式'); }
    for (const finding of report.findings) {
      lines.push('  [' + finding.severity + '] ' + finding.rule + ' ' + finding.file + ':' + finding.line + '  ' + finding.detail);
      lines.push('        ' + finding.evidence);
    }
    lines.push('  结论: ' + report.verdict);
    console.log(lines.join('\n'));
  }
  if (outPath) { console.log('  JSON 报告: ' + path.resolve(outPath)); }
}

function main(argv) {
  let outPath = '';
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { outPath = argv[i + 1] || ''; i++; }
    else { positional.push(argv[i]); }
  }
  if (positional.length === 0) {
    console.error('用法: node scripts/tests/plugin-dist-audit.cjs <zip|dir> [--json out] | --all [--json out]');
    return 2;
  }
  if (positional[0] === '--all') { return runMatrix(outPath); }
  const report = auditPackage(positional[0]);
  emit(report, outPath);
  return report.critical > 0 ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('[plugin-dist-audit] ' + (error && error.message ? error.message : error)); process.exitCode = 2; }
}

module.exports = { auditPackage, runMatrix, REQUIRED_MATRIX, RULES };
