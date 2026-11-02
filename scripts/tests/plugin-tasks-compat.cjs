#!/usr/bin/env node
'use strict';
// Gate: obsidian-tasks 8.6.0 must run unmodified against the SHIPPED rawfile products.
// Checks 1-7 follow the task brief. Checks 2-4 report PENDING (not PASS) when the
// base genuinely lacks an API; the gate still exits 0 for a *consistent* contract
// and exits 1 the moment any check it can run is red. --require-full exits 1 while
// the track's headline goal is unreachable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO, 'tools', 'plugins-fixtures', 'local', 'obsidian-tasks');
const OUT = path.join(REPO, '.fixtures-out', 'tasks-compat');
const RAWFILE = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile');

const EXPECTED = {
  main: { sha256: '500F8106D05DDB483BBFEC135CAC7948022BF6BA7386D1851B28F4D087866E8F', bytes: 1051096 },
  manifest: { sha256: '2EFC88DF9E973247360D486B420791C266C8824516919303B948D0192E159127', bytes: 518 }
};
// Our two shims as of the start of this track; a change here means the verdict below
// belongs to a different base than the one this run measured.
const SHIM_BASELINE = {
  'lexinote_plugin_shim.js': '278CBC352D76C0B3C6CFCCB921EAB8FD502300C31CC7B41FA11980C9F864F471',
  'lexinote_plugin_view_shim.js': 'C2CDC44BC33C5EA5851B0ACEB51BD3A9EF89BE116DE9529833E5808525E337EA'
};

const args = process.argv.slice(2);
const redlight = (args.find((a) => a.indexOf('--redlight=') === 0) || '').split('=')[1] || '';
const requireFull = args.includes('--require-full');
// --ladder climbs the failure staircase instead of judging the track; see
// tools/tasks-compat/ladder.cjs. --ladder-redlight=N drops level N's HARNESS-ONLY
// stub to prove that level is load-bearing (the gate must then go red on it).
const ladderMode = args.includes('--ladder');
const ladderRedlight = (args.find((a) => a.indexOf('--ladder-redlight=') === 0) || '').split('=')[1] || '';

const rows = [];
let failed = 0;
function record(name, state, detail) {
  rows.push({ name, state, detail });
  if (state === 'FAIL') failed += 1;
  const tag = state === 'PASS' ? 'PASS' : state === 'PENDING' ? 'PENDING' : 'FAIL';
  console.log('[' + tag + '] ' + name + (detail ? ' — ' + detail : ''));
}

function fileDigest(file) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // ---------------------------------------------------------------- 1 sha256 lock
  const main = fileDigest(path.join(FIXTURE, 'main.js'));
  const manifest = fileDigest(path.join(FIXTURE, 'manifest.json'));
  const mainWant = redlight === 'sha256' ? Object.assign({}, EXPECTED.main, { sha256: 'DEADBEEF'.repeat(8) }) : EXPECTED.main;
  const shaOk = main.sha256 === mainWant.sha256 && main.bytes === mainWant.bytes &&
    manifest.sha256 === EXPECTED.manifest.sha256 && manifest.bytes === EXPECTED.manifest.bytes;
  record('01 fixture byte-identical to the downloaded plugin', shaOk ? 'PASS' : 'FAIL',
    'main.js ' + main.sha256 + ' ' + main.bytes + ' B; manifest.json ' + manifest.sha256 + ' ' + manifest.bytes + ' B' +
    (shaOk ? '' : ' — expected ' + mainWant.sha256 + ' ' + mainWant.bytes + ' B'));
  if (!shaOk) return finish(null);

  const shims = {
    'lexinote_plugin_shim.js': fileDigest(path.join(RAWFILE, 'lexinote_plugin_shim.js')),
    'lexinote_plugin_view_shim.js': fileDigest(path.join(RAWFILE, 'lexinote_plugin_view_shim.js'))
  };
  for (const [name, digest] of Object.entries(shims)) {
    if (digest.sha256 !== SHIM_BASELINE[name]) {
      console.log('[WARN] base shim changed since this track started: ' + name + ' ' + digest.sha256 + ' (baseline ' + SHIM_BASELINE[name] + ')');
    }
  }

  if (ladderMode) {
    const ladder = require(path.join(REPO, 'tools', 'tasks-compat', 'ladder.cjs'));
    // domhelpers = take the whole prototype mount back out (the pre-fix world);
    // getattr    = take out exactly one helper, the symbol the original probe died on.
    const stripDomHelpers = ladderRedlight === 'domhelpers' ? true : (ladderRedlight === 'getattr' ? ['getAttr'] : false);
    const verdict = await ladder.run({ redlight: ladderRedlight, stripDomHelpers });
    const written = ladder.write(verdict, OUT);
    console.log('\n--- failure ladder (' + verdict.rows.length + ' level(s), harness-only) ---');
    for (const line of ladder.table(verdict.rows)) console.log('  ' + line);
    if (written.mdPath) console.log('  ladder files: ' + written.mdPath);
    console.log('  ladder files: ' + written.jsonPath);

    if (verdict.domHelpersRedlight) {
      // Deliberately red: the shipped reader's prototype DOM helpers are deleted out of
      // the jsdom window, which is the pre-fix world where only hand-patched nodes had
      // them. L5 must go FAIL; a PASS here means the new criterion is not load-bearing.
      console.log('');
      console.log('[red-light] Element.prototype helpers removed before the plugin ran: ' + JSON.stringify(verdict.domHelpersRedlight.stripped));
      console.log('[red-light] ' + verdict.domHelpersRedlight.detail);
      record('06 red-light: DOM helpers unmounted, L5 must be red', verdict.domHelpersRedlight.ok ? 'PASS' : 'FAIL', verdict.domHelpersRedlight.detail);
    }
    if (verdict.redlight) {
      // Deliberately red: this run removes one HARNESS-ONLY level to prove the gate
      // really depends on it. Exit 1 is the point of the run, and the label names the level.
      console.log('');
      console.log('[red-light] removed level ' + verdict.redlight.level + ' (' + verdict.redlight.symbol + ')');
      console.log('[red-light] ' + verdict.redlight.detail);
      record('06 red-light: level ' + verdict.redlight.level + ' removed, gate must be red', 'FAIL', verdict.redlight.detail);
      record('L1..L6', 'PENDING', 'not evaluated in red-light mode: this run only proves level ' + verdict.redlight.level + ' is load-bearing');
      return finish({ verdict });
    }

    record('L1 ladder ran, one full re-climb per level', verdict.rows.length > 0 ? 'PASS' : 'FAIL',
      verdict.rows.length + ' levels / ' + verdict.runs.length + ' harness boots');
    const mismatched = verdict.rows.filter((r) => !r.matchesAuthored).map((r) => r.level);
    record('L2 every level reproduces the error recorded for it', mismatched.length === 0 ? 'PASS' : 'FAIL',
      mismatched.length === 0 ? 'observed == authored on all ' + verdict.rows.length + ' levels' : 'mismatch at level(s) ' + JSON.stringify(mismatched));
    if (verdict.outcome.onloadAnchor) {
      record('L3 plugin.onload.done reached', 'PASS', 'after ' + verdict.rows.length + ' HARNESS-ONLY level(s): ' + JSON.stringify(verdict.outcome.hostMethods.slice(-3)));
    } else {
      record('L3 plugin.onload.done reached', 'PENDING', 'stopped at level ' + verdict.rows.length + ': ' + verdict.rows[verdict.rows.length - 1].nextError);
    }
    if (verdict.outcome.architectureGap) {
      record('L4 architecture-level gap recorded, not faked', 'PASS', verdict.outcome.architectureGap.symbol + ' — ' + verdict.outcome.architectureGap.error);
    }
    // A checkbox in the DOM is NOT evidence: the markdown renderer draws those itself.
    // And "no synchronous throw" is not evidence either, because the post-processor
    // registers behind a wrapper that returns undefined, so its async failure never
    // reaches applyPostProcessors' catch. L5 is therefore judged by ladder.cjs on the
    // render window itself: the DOM the plugin produced plus the unhandledRejections
    // that escaped while it ran. Only a plugin-owned post-processor (L5) plus a click
    // that writes the note back (L6) prove the tasks renderer actually took over.
    const l5 = verdict.outcome.postProcessor || null;
    if (l5 && l5.state === 'PASS') record('L5 plugin post-processor ran to completion', 'PASS', l5.detail);
    else if (l5 && l5.state === 'FAIL') record('L5 plugin post-processor ran to completion', 'FAIL', l5.detail);
    else record('L5 plugin post-processor ran to completion', 'PENDING', l5 ? l5.detail : 'the ladder produced no post-processor evidence (no render window)');
    if (verdict.click && verdict.click.sourceAfter !== verdict.click.sourceBefore) {
      record('L6 checkbox click writes the source line back', 'PASS', JSON.stringify(verdict.click.sourceBefore) + ' -> ' + JSON.stringify(verdict.click.sourceAfter));
    } else {
      record('L6 checkbox click writes the source line back', 'PENDING', 'a rendered checkbox exists but clicking it changed nothing (sourceBefore == sourceAfter), so it is renderer-native, not the plugin');
    }

    if (!verdict.domHelpersRedlight) {
      record('06 red-light not requested this run', 'PASS', 'run --ladder --ladder-redlight=1|2|3|getattr|domhelpers to prove a level (or the helper mount) is load-bearing');
    }
    return finish({ verdict });
  }

  // Generation attempt #1 of at most 3.
  const harness = require(path.join(REPO, 'tools', 'tasks-compat', 'harness.cjs'));
  const result = await harness.run();

  // ---------------------------------------------------------------- 2 it really ran
  const ranFixtureCode = !!result.firstError || result.onloadAnchor;
  record('02 obsidian-tasks main.js was really executed by our loader', ranFixtureCode ? 'PASS' : 'FAIL',
    ranFixtureCode
      ? (result.onloadAnchor ? 'onload reached' : 'factory executed, its own frame: ' + result.firstError.stackTop)
      : 'no fixture frame and no onload anchor');

  const err = result.firstError;
  const missingApi = err && err.api && err.api.symbol ? /\.([A-Za-z_$][\w$]*)$/.exec(err.api.symbol) : null;

  // ---------------------------------------------------------------- 3 post-processor + DOM
  if (result.onloadAnchor && result.postProcessors.registered >= 1) {
    record('03 registerMarkdownPostProcessor reached our registry', 'PASS', result.postProcessors.registered + ' handler(s)');
  } else if (redlight === 'registry') {
    record('03 registerMarkdownPostProcessor reached our registry', 'FAIL', 'registry empty: the registration path is dead');
  } else if (!result.onloadAnchor) {
    record('03 registerMarkdownPostProcessor reached our registry', 'PENDING',
      'unreachable: onload never ran because ' + (missingApi ? missingApi[1] : '?') + ' is missing from obsidianNamespace (' +
      'lexinote_plugin_shim.js:2433). Fix that export first, then this check runs for real.');
  } else {
    record('03 registerMarkdownPostProcessor reached our registry', 'FAIL', 'onload ran but registered ' + result.postProcessors.registered + ' handler(s)');
  }

  const rendered = result.render && result.render.ran && result.render.nodeCount > 0;
  if (rendered) record('03b task lines rendered as real DOM checkboxes', 'PASS', result.render.nodeCount + ' × ' + result.render.selector);
  else record('03b task lines rendered as real DOM checkboxes', 'PENDING', 'unreachable: no post-processor ever ran (see 03)');

  // ---------------------------------------------------------------- 4 writeback
  if (result.click && result.click.ran && result.click.sourceAfter !== result.click.sourceBefore) {
    record('04 checkbox click writes the source line back', 'PASS', JSON.stringify(result.click.sourceBefore) + ' -> ' + JSON.stringify(result.click.sourceAfter));
  } else if (redlight === 'writeback') {
    record('04 checkbox click writes the source line back', 'FAIL', 'source unchanged after click');
  } else {
    record('04 checkbox click writes the source line back', 'PENDING', 'unreachable: no checkbox exists to click (see 03)');
  }

  // ---------------------------------------------------------------- 5 gap table
  const gaps = [];
  if (err) {
    const name = missingApi ? missingApi[1] : (err.api ? err.api.symbol : 'unknown');
    gaps.push({
      api: 'obsidian.' + name,
      calledFrom: 'tools/plugins-fixtures/local/obsidian-tasks/main.js:' + err.fixtureLine,
      ourState: 'missing',
      error: err.message + ' @ ' + err.stackTop,
      evidence: 'runtime',
      fix: 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2433 (obsidianNamespace has no ' + name + ')'
    });
  }
  for (const m of result.namespace.missing) {
    if (err && err.api && err.api.symbol && err.api.symbol.endsWith('.' + m.api)) continue;
    gaps.push({
      api: 'obsidian.' + m.api,
      calledFrom: m.calledFrom,
      ourState: 'missing',
      error: 'not reached yet (projected from the bundle; it is the next class/function to evaluate)',
      evidence: 'static',
      fix: 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js:2433'
    });
  }
  gaps.push({
    api: 'Plugin.registerMarkdownPostProcessor', calledFrom: 'obsidian-tasks main.js (post-processor registration)',
    ourState: 'stub', error: 'shim discards the processor and only warns',
    evidence: 'static', fix: 'lexinote_plugin_shim.js:1667 (workspace page overrides it at lexinote_workspace.js:441; the plugin-view page does not: lexinote_plugin_view_shim.js:295 is an empty function)'
  });
  gaps.push({
    api: 'obsidian.setIcon', calledFrom: 'obsidian-tasks main.js (icon buttons)',
    ourState: 'stub', error: 'no-op: function () {} — icons silently never appear',
    evidence: 'static', fix: 'lexinote_plugin_shim.js:2500'
  });

  const byState = gaps.reduce((acc, g) => { acc[g.ourState] = (acc[g.ourState] || 0) + 1; return acc; }, {});
  record('05 gap table written (JSON + human)', gaps.length > 0 ? 'PASS' : 'FAIL',
    gaps.length + ' gaps ' + JSON.stringify(byState));

  const jsonPath = path.join(OUT, 'gap-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), fixture: { main, manifest }, shims, gaps, load: { hostMethods: result.load.hostMethods, logs: result.load.logs.slice(0, 20) } }, null, 2));
  const mdPath = path.join(OUT, 'gap-report.md');
  const md = ['# obsidian-tasks 8.6.0 compat gaps', '', '| # | api | calledFrom | ourState | error |', '|---|---|---|---|---|']
    .concat(gaps.map((g, i) => '| ' + (i + 1) + ' | ' + g.api + ' | ' + g.calledFrom + ' | ' + g.ourState + ' | ' + String(g.error).replace(/\|/g, '\\|') + ' |'))
    .join('\n');
  fs.writeFileSync(mdPath, md + '\n');

  console.log('\n--- gap table (first 15) ---');
  for (const g of gaps.slice(0, 15)) console.log('  ' + g.api + '  <-  ' + g.calledFrom + '  [' + g.ourState + ']  ' + g.error);
  console.log('  totals by ourState: ' + JSON.stringify(byState));

  // ---------------------------------------------------------------- 6 red light bookkeeping
  if (redlight) record('06 red-light injection "' + redlight + '" produced a named failure', failed > 0 ? 'PASS' : 'FAIL', 'exit code path exercised');
  else record('06 red-light not requested this run', 'PASS', 'run with --redlight=sha256|registry|writeback to prove the checks bite');

  // ---------------------------------------------------------------- 7 headline verdict
  const pending = rows.filter((r) => r.state === 'PENDING').length;
  if (pending > 0) {
    console.log('\n[VERDICT] 本轨未达成零改动跑通: onload 未被执行 —— obsidian-tasks 模块求值阶段即抛 ' +
      (err ? err.message : '?') + ' (' + (missingApi ? missingApi[1] : '?') + ' @ main.js:' + (err ? err.fixtureLine : '?') + ')');
  }
  return finish({ result, gaps, pending });
})().catch((e) => {
  console.error('[FATAL]', e && e.stack || e);
  process.exit(2);
});

function finish(payload) {
  const pendingCount = rows.filter((r) => r.state === 'PENDING').length;
  console.log('\nsummary: ' + rows.filter((r) => r.state === 'PASS').length + ' pass, ' + failed + ' fail, ' + pendingCount + ' pending');
  if (failed > 0) { console.log('RESULT: FAIL'); process.exit(1); }
  if (requireFull && pendingCount > 0) { console.log('RESULT: GOAL_NOT_MET (' + pendingCount + ' acceptance criteria unreachable on the current base)'); process.exit(1); }
  console.log('RESULT: ' + (pendingCount > 0 ? 'PENDING' : 'PASS'));
  void payload;
  process.exit(0);
}
