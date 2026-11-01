#!/usr/bin/env node
/*
 * harmonyos-emulator MCP server (stdio, zero dependencies).
 * Maps the android-emulator plugin's public operations onto the HarmonyOS hdc backend:
 * preflight / list targets / build / install+launch / screenshot / logs / ui dump /
 * app terminate / emulator helpers.
 */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLCHAIN_ROOT = process.env.HOS_PLUGIN_TOOLCHAIN_ROOT ||
  path.join('E:', 'dev-tools', 'harmonyos', 'command-line-tools');
const BUNDLE = process.env.HOS_PLUGIN_BUNDLE_NAME || 'com.lovexjy.lexinote';
const ABILITY = 'EntryAbility';
const MODULE = 'entry';
const EMU_TARGET = process.env.HOS_PLUGIN_EMULATOR_TARGET || '127.0.0.1:5555';
const PROJECT_DIR = process.env.HOS_PLUGIN_PROJECT_DIR || process.cwd();
const HAP_DIR = path.join(PROJECT_DIR, 'entry', 'build', 'default', 'outputs', 'default');

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch (err) { /* keep probing */ }
  }
  return null;
}

function locateTool(name) {
  const hits = [
    path.join(TOOLCHAIN_ROOT, 'bin', name),
    path.join(TOOLCHAIN_ROOT, 'sdk', 'default', 'openharmony', 'toolchains', name),
    path.join(TOOLCHAIN_ROOT, 'sdk', 'default', 'hms', 'toolchains', name)
  ];
  return firstExisting(hits);
}

function hdcPath() { return locateTool(process.platform === 'win32' ? 'hdc.exe' : 'hdc'); }
function nodePath() {
  return process.execPath;
}
function hvigorCommand() {
  const hvigorw = locateTool(process.platform === 'win32' ? 'hvigorw.bat' : 'hvigorw');
  if (hvigorw) return { cmd: hvigorw, args: [] };
  const hvigorwJs = firstExisting([
    path.join(TOOLCHAIN_ROOT, 'bin', 'hvigorw.js'),
    path.join(TOOLCHAIN_ROOT, 'tool', 'hvigor', 'bin', 'hvigorw.js')
  ]);
  if (hvigorwJs) return { cmd: nodePath(), args: [hvigorwJs] };
  return null;
}

function run(cmd, args, options) {
  return new Promise((resolve) => {
    const opts = Object.assign({ timeoutMs: 120000 }, options || {});
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: opts.cwd },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

function shell(cmd, args, target, options) {
  const hdc = hdcPath();
  if (!hdc) return Promise.resolve({ code: 127, stdout: '', stderr: 'hdc not found under ' + TOOLCHAIN_ROOT });
  const argv = target ? ['-t', target, ...args] : args;
  return run(hdc, argv, options);
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

const TOOLS = [
  {
    name: 'harmony_preflight',
    description: 'Diagnostic check: toolchain paths (hdc/hvigorw/sdkmgr), emulator target reachability, project HAP presence. Pure check, no side effects.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'harmony_list_targets',
    description: 'List connected hdc targets (real devices and local emulator 127.0.0.1:5555).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'harmony_build',
    description: 'Build the HAP with hvigorw (assembleHap). Returns compile output; read it first on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        buildMode: { type: 'string', enum: ['debug', 'release'], default: 'debug' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_install_launch',
    description: 'Install the built HAP to a target (defaults to the local emulator) and launch the entry ability.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string', description: 'hdc target; default ' + EMU_TARGET },
        bundleName: { type: 'string', default: BUNDLE },
        skipLaunch: { type: 'boolean', default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_screenshot',
    description: 'Capture the device screen (snapshot_display) and save a JPEG under the project exports/ directory; returns the file path.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_logs',
    description: 'Read a bounded window of filtered hilog (lexinote/ArkWeb/jscrash/cppcrash) from the target.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        lines: { type: 'number', default: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_ui_dump',
    description: 'Dump the ArkUI control tree (uitest uiDump) and return the JSON text for locator planning.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_terminate_app',
    description: 'Terminate the application on the target.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        bundleName: { type: 'string', default: BUNDLE }
      },
      additionalProperties: false
    }
  },
  {
    name: 'harmony_emulator_connect',
    description: 'Connect hdc to the local emulator target (hdc tconn 127.0.0.1:5555). The emulator process itself is started by Device Emulator tooling.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

async function preflight() {
  const hdc = hdcPath();
  const hvigor = hvigorCommand();
  const sdkmgr = locateTool(process.platform === 'win32' ? 'sdkmgr.exe' : 'sdkmgr');
  const lines = [
    'toolchain_root: ' + TOOLCHAIN_ROOT,
    'hdc: ' + (hdc || 'NOT FOUND'),
    'hvigorw: ' + (hvigor ? hvigor.cmd + (hvigor.args.length ? ' ' + hvigor.args.join(' ') : '') : 'NOT FOUND'),
    'sdkmgr: ' + (sdkmgr || 'NOT FOUND'),
    'project: ' + PROJECT_DIR,
    'hap_dir: ' + HAP_DIR + (fs.existsSync(HAP_DIR) ? '' : ' (not built yet)')
  ];
  if (hdc) {
    const targets = await run(hdc, ['list', 'targets'], { timeoutMs: 15000 });
    lines.push('targets: ' + (targets.stdout.trim() || '[empty]'));
  }
  return textResult(lines.join('\n'));
}

async function build(args) {
  const hvigor = hvigorCommand();
  if (!hvigor) return textResult('hvigorw 不可用:请先安装 command-line-tools 或修正 toolchain_root');
  const mode = (args && args.buildMode) === 'release' ? 'release' : 'debug';
  const sdkRoot = firstExisting([
    path.join(TOOLCHAIN_ROOT, 'sdk'),
    path.join(TOOLCHAIN_ROOT, 'sdk', 'default')
  ]);
  const env = Object.assign({}, process.env);
  if (sdkRoot) { env.DEVECO_SDK_HOME = sdkRoot; env.HOS_SDK_HOME = sdkRoot; }
  const result = await new Promise((resolve) => {
    const child = spawn(hvigor.cmd, hvigor.args.concat([
      '--mode', 'module', '-p', 'product=default', '-p', 'module=' + MODULE + '@default',
      '-p', 'buildMode=' + mode, 'assembleHap', '--no-daemon'
    ]), { cwd: PROJECT_DIR, env, windowsHide: true });
    let output = '';
    const cap = 400000;
    child.stdout.on('data', (d) => { if (output.length < cap) output += String(d); });
    child.stderr.on('data', (d) => { if (output.length < cap) output += String(d); });
    child.on('error', (err) => resolve({ code: 1, output: String(err) }));
    child.on('close', (code) => resolve({ code, output }));
  });
  const hap = firstExisting(fs.existsSync(HAP_DIR)
    ? fs.readdirSync(HAP_DIR).filter((f) => f.endsWith('.hap')).map((f) => path.join(HAP_DIR, f))
    : []);
  return textResult('exit=' + result.code + '\n' + result.output.slice(-6000) + '\nHAP: ' + (hap || 'none'));
}

async function installLaunch(args) {
  const serial = (args && args.serial) || EMU_TARGET;
  const bundle = (args && args.bundleName) || BUNDLE;
  const hap = firstExisting(fs.existsSync(HAP_DIR)
    ? fs.readdirSync(HAP_DIR).filter((f) => f.endsWith('.hap')).map((f) => path.join(HAP_DIR, f))
    : []);
  if (!hap) return textResult('未找到 HAP,请先 harmony_build');
  const install = await shell(['app', 'install', '-r', hap], serial, { timeoutMs: 300000 });
  let output = 'install exit=' + install.code + '\n' + (install.stdout + install.stderr).slice(-3000);
  if (install.code === 0 && !(args && args.skipLaunch)) {
    const start = await shell(['shell', 'aa', 'start', '-a', ABILITY, '-b', bundle], serial, { timeoutMs: 60000 });
    output += '\nlaunch exit=' + start.code + '\n' + (start.stdout + start.stderr).slice(-2000);
  }
  return textResult(output);
}

async function screenshot(args) {
  const serial = (args && args.serial) || EMU_TARGET;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.join(PROJECT_DIR, 'exports');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { /* exists */ }
  await shell(['shell', 'snapshot_display', '-f', '/data/local/tmp/lexi-shot.jpeg'], serial, { timeoutMs: 60000 });
  const localPath = path.join(outDir, 'lexi-shot-' + stamp + '.jpeg');
  const recv = await shell(['file', 'recv', '/data/local/tmp/lexi-shot.jpeg', localPath], serial, { timeoutMs: 60000 });
  return textResult('recv exit=' + recv.code + '\n' + localPath + '\n' + (recv.stderr || '').slice(-500));
}

async function logs(args) {
  const serial = (args && args.serial) || EMU_TARGET;
  const lines = Math.max(50, Math.min(2000, Number(args && args.lines) || 200));
  const result = await shell(['shell', 'hilog', '-x'], serial, { timeoutMs: 60000 });
  const all = (result.stdout || '').split('\n');
  const filtered = all.filter((l) => /lexinote|ArkWeb|JsVm|jscrash|cppcrash/i.test(l)).slice(-lines);
  return textResult('total=' + all.length + ' matched=' + filtered.length + '\n' + filtered.join('\n').slice(-8000));
}

async function uiDump(args) {
  const serial = (args && args.serial) || EMU_TARGET;
  await shell(['shell', 'uitest', 'uiDump', '/data/local/tmp/lexi-ui.json'], serial, { timeoutMs: 60000 });
  const outDir = path.join(PROJECT_DIR, 'exports');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (err) { /* exists */ }
  const localPath = path.join(outDir, 'lexi-ui.json');
  const recv = await shell(['file', 'recv', '/data/local/tmp/lexi-ui.json', localPath], serial, { timeoutMs: 60000 });
  let summary = recv.stderr || '';
  try {
    const tree = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const attributes = tree && tree.attributes ? tree.attributes : {};
    summary = 'window=' + JSON.stringify(attributes.bounds || {}) + ' bytes=' + fs.statSync(localPath).size;
  } catch (err) { /* parse failure is reported via recv output */ }
  return textResult('uiDump saved: ' + localPath + '\n' + summary);
}

async function terminateApp(args) {
  const serial = (args && args.serial) || EMU_TARGET;
  const bundle = (args && args.bundleName) || BUNDLE;
  const result = await shell(['shell', 'aa', 'force-stop', bundle], serial, { timeoutMs: 60000 });
  return textResult('exit=' + result.code + ' ' + (result.stdout + result.stderr).slice(-800));
}

async function emulatorConnect() {
  const hdc = hdcPath();
  if (!hdc) return textResult('hdc not found');
  const result = await run(hdc, ['tconn', EMU_TARGET], { timeoutMs: 30000 });
  const list = await run(hdc, ['list', 'targets'], { timeoutMs: 15000 });
  return textResult('tconn exit=' + result.code + '\n' + (result.stdout + result.stderr) + '\ntargets:\n' + list.stdout);
}

async function listTargets() {
  const hdc = hdcPath();
  if (!hdc) return textResult('hdc not found under ' + TOOLCHAIN_ROOT);
  const result = await run(hdc, ['list', 'targets', '-v'], { timeoutMs: 15000 });
  return textResult(result.stdout || result.stderr || '[empty]');
}

const HANDLERS = {
  harmony_preflight: preflight,
  harmony_list_targets: listTargets,
  harmony_build: build,
  harmony_install_launch: installLaunch,
  harmony_screenshot: screenshot,
  harmony_logs: logs,
  harmony_ui_dump: uiDump,
  harmony_terminate_app: terminateApp,
  harmony_emulator_connect: emulatorConnect
};

// ------------------------------------------------------------- MCP stdio glue

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) { handleMessage(line); }
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handleMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch (err) { return; }
  if (!message || typeof message !== 'object') { return; }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'harmonyos-emulator', version: '0.1.0' }
      }
    });
    return;
  }
  if (message.method === 'notifications/initialized' || (message.method || '').startsWith('notifications/')) {
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    const handler = HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool: ' + name } });
      return;
    }
    handler(args).then(
      (content) => send({ jsonrpc: '2.0', id: message.id, result: content }),
      (err) => send({
        jsonrpc: '2.0', id: message.id,
        result: { content: [{ type: 'text', text: 'tool error: ' + (err && err.message || String(err)) }], isError: true }
      })
    );
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
}
