// Builds the local obsidian-API probe plugin into main.js and mirrors it into app rawfile.
import { createRequire } from 'node:module';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'compat-probe');
const repoRoot = path.resolve(here, '../../..');
const rawDir = path.join(repoRoot, 'entry/src/main/resources/rawfile/plugins/compat-probe');
// esbuild 复用 workspace-bundle 的依赖,避免再装一份
const { build } = createRequire(path.join(repoRoot, 'tools/workspace-bundle/package.json'))('esbuild');

await build({
  entryPoints: [path.join(fixture, 'main.ts')],
  outfile: path.join(fixture, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2019'],
  // @codemirror/* 也必须 external:探针要和容器共用同一份 CM6 实例,不能把第二份打进插件包
  external: ['obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
  legalComments: 'none',
  logLevel: 'warning',
});

await mkdir(rawDir, { recursive: true });
await copyFile(path.join(fixture, 'main.js'), path.join(rawDir, 'main.js'));
await copyFile(path.join(fixture, 'manifest.json'), path.join(rawDir, 'manifest.json'));
const code = await readFile(path.join(fixture, 'main.js'), 'utf8');
console.log('[compat-probe] main.js ' + code.length + ' bytes');
console.log('[compat-probe] manifest + main.js -> entry/src/main/resources/rawfile/plugins/compat-probe/');
