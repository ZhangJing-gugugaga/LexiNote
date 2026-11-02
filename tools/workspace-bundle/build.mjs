// Builds the single-file workspace runtime and copies it into the app rawfile directory.
import { build } from 'esbuild';
import { mkdir, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const bundlesDir = path.join(root, 'bundles');
const outfile = path.join(bundlesDir, 'workspace.js');
const rawfileDir = path.resolve(root, '../../entry/src/main/resources/rawfile');
const rawTarget = path.join(rawfileDir, 'lexinote_workspace.js');

// The page-side scripts run in page global scope after the bundle, so they are appended
// as text at build time instead of being imported into src/main.ts.
// Order below is the order in the product. src/reading-wiring.js must stay LAST:
// scripts/tests/reading-source-path.cjs pins the product from the '阅读渲染接线' comment
// to EOF as byte-identical to that file.
const APPENDED_SOURCES = ['src/workspace-note-open.js', 'src/reading-wiring.js'];
const appended = [];
for (const rel of APPENDED_SOURCES) {
  let text;
  try {
    text = await readFile(path.join(root, rel), 'utf8');
  } catch (error) {
    console.error('[workspace-bundle] missing ' + rel + ': ' + error.message);
    process.exit(1);
  }
  if (text.trim() === '') {
    console.error('[workspace-bundle] ' + rel + ' is empty; refusing to build without it');
    process.exit(1);
  }
  appended.push({ rel, text });
}

await mkdir(bundlesDir, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning'
});

const bundleText = await readFile(outfile, 'utf8');
const bundleWithNewline = bundleText.endsWith('\n') ? bundleText : bundleText + '\n';
await mkdir(rawfileDir, { recursive: true });
let product = bundleWithNewline;
for (const entry of appended) {
  product += '\n' + entry.text;
}
await writeFile(rawTarget, product, 'utf8');

const info = await stat(outfile);
const kb = (info.size / 1024).toFixed(1);
const siblings = (await readdir(rawfileDir)).filter((name) => name.startsWith('lexinote_workspace_'));
console.log('[workspace-bundle] bundles/workspace.js  ' + kb + ' KB');
console.log('[workspace-bundle] appended ' + appended.map((entry) => entry.rel).join(' + '));
console.log('[workspace-bundle] wrote -> ' + path.relative(root, rawTarget));
console.log('[workspace-bundle] rawfile siblings: ' + siblings.join(', '));
