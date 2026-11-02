#!/usr/bin/env node
'use strict';

/**
 * Offline guard for the workspace container page.
 *
 * The forced-reload hook was removed after it had served its one-off purpose
 * (proving the boot self-reload). Dead debug code drifts back easily, so this
 * gate pins the removal: no DEBUG_ constant, no manual controller refresh.
 *
 * Usage:
 *   node scripts/tests/workspace-page-guard.cjs            # guard the real page
 *   node scripts/tests/workspace-page-guard.cjs --file X   # prove the guard can fail
 *   node scripts/tests/workspace-page-guard.cjs --json
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_PAGE = path.join(REPO, 'entry/src/main/ets/workspace/LexiWorkspacePage.ets');

const FORBIDDEN = [
  { id: 'no-debug-constant', pattern: /DEBUG_/ },
  { id: 'no-controller-refresh', pattern: /controller\.refresh\s*\(/ }
];

function sourceOf(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

function report(file) {
  const source = sourceOf(file);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id: id, state: ok ? 'PASS' : 'FAIL', detail: detail });

  if (source === null) {
    add('page-present', false, 'missing ' + file);
    return { ok: false, checks: checks, file: file };
  }
  const lines = source.split(/\r?\n/);
  add('page-present', true, lines.length + ' lines');

  for (const rule of FORBIDDEN) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        hits.push((i + 1) + ': ' + lines[i].trim());
      }
    }
    add(rule.id, hits.length === 0, hits.length === 0 ? 'absent' : hits.join(' | '));
  }
  const ok = checks.every((c) => c.state === 'PASS');
  return { ok: ok, checks: checks, file: file };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.indexOf('--json') >= 0;
  const fileAt = argv.indexOf('--file');
  const file = fileAt >= 0 && argv[fileAt + 1] ? path.resolve(argv[fileAt + 1]) : DEFAULT_PAGE;

  const result = report(file);
  const failed = result.checks.filter((c) => c.state !== 'PASS').length;
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('file: ' + path.relative(REPO, result.file) + '\n');
    for (const check of result.checks) {
      process.stdout.write('  ' + check.state + ' ' + check.id + '  ' + check.detail + '\n');
    }
    process.stdout.write('assertions: ' + result.checks.length + ', passed: ' +
      (result.checks.length - failed) + ', failed: ' + failed + '\n');
  }
  process.exit(result.ok ? 0 : 1);
}

main();
