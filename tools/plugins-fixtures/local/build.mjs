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

// P4-006b(R39-B):@codemirror/{state,view} 必须随 main.js 打包 —— 宿主两轨(legacy 求值轨与
// 沙箱轨)都按 fail-closed 拒绝外部模块("依赖请随 main.js 打包"),external 的探针在真机 eval
// 即失败。CM6 双副本不会报错、只会让 ViewPlugin/StateField 静默失效,所以 main.ts 里
// preferSharedCm 在 workspace 页宿主注册表(__lexiCmModules=与编辑器同一份实例)存在时优先取
// 宿主那份,打包副本只兜底 runtime 轨。依赖解析全部走仓库内 vendored node_modules,离线可重建。
await build({
  entryPoints: [path.join(fixture, 'main.ts')],
  outfile: path.join(fixture, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2019'],
  external: ['obsidian'],
  nodePaths: [path.join(repoRoot, 'tools/workspace-bundle/node_modules')],
  // 随包的 @codemirror/state dist 带 JSDoc 文本("from `from`." 会被 dist-audit 的 ESM
  // from-正则误报成模块导入);压掉注释/空白,语义零变化。
  minifyWhitespace: true,
  legalComments: 'none',
  logLevel: 'warning',
});

await mkdir(rawDir, { recursive: true });
await copyFile(path.join(fixture, 'main.js'), path.join(rawDir, 'main.js'));
await copyFile(path.join(fixture, 'manifest.json'), path.join(rawDir, 'manifest.json'));
const code = await readFile(path.join(fixture, 'main.js'), 'utf8');
console.log('[compat-probe] main.js ' + code.length + ' bytes');
console.log('[compat-probe] manifest + main.js -> entry/src/main/resources/rawfile/plugins/compat-probe/');
