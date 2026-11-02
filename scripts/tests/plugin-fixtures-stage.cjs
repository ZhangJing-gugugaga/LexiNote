#!/usr/bin/env node
// 把 .fixtures-out/ 里的第三方插件产物暂存进 rawfile/plugins/<id>/,让 assembleHap 能把它们带进 HAP。
//
// 为什么需要这一步:hdc 写不进应用沙箱(${filesDir}/plugins),第三方插件要进设备只能走内置资源。
// 仓库约定是第三方源码只落在 .fixtures-out/(gitignore),所以 rawfile/plugins/<id> 里的目录是**生成物**,
// 由本脚本产出,不要手改、不要提交。
//
// 用法:node scripts/tests/plugin-fixtures-stage.cjs [--clean]
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '.fixtures-out');
const RAW_PLUGINS = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins');
const STAGED = ['view-calendar:calendar', 'editor-outliner:editor-outliner'];

const clean = process.argv.includes('--clean');

function stageOne(sourceId, targetId) {
  const from = path.join(OUT_DIR, sourceId);
  const to = path.join(RAW_PLUGINS, targetId);
  if (!fs.existsSync(path.join(from, 'main.js'))) {
    console.error('[stage] 缺少产物 ' + from + '/main.js(先跑 plugin-fixtures-fetch.cjs)');
    return false;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const name of ['manifest.json', 'main.js', 'styles.css']) {
    const src = path.join(from, name);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(to, name)); }
  }
  const bytes = fs.statSync(path.join(to, 'main.js')).size;
  console.log('[stage] ' + sourceId + ' -> rawfile/plugins/' + targetId + ' (main.js ' + bytes + ' bytes)');
  return true;
}

let ok = true;
for (const pair of STAGED) {
  const [sourceId, targetId] = pair.split(':');
  const to = path.join(RAW_PLUGINS, targetId);
  if (clean) {
    fs.rmSync(to, { recursive: true, force: true });
    console.log('[stage] 已清理 rawfile/plugins/' + targetId);
    continue;
  }
  ok = stageOne(sourceId, targetId) && ok;
}
process.exitCode = ok ? 0 : 1;
