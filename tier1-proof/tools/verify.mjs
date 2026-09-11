/* verify — every instrument this harness has, in one command, with a receipt.
   ────────────────────────────────────────────────────────────────────────
   There are six of them now and no single entry point, which is how a suite
   starts being run in pieces and reported from memory. Each stage below
   states what it proves; each SKIP states why, because a skipped stage that
   looks like a pass is worse than a red one.

     node tools/verify.mjs            everything the host can run
     node tools/verify.mjs --sweep    …and the sabotage sweep (~20 min)

   Exit is non-zero if any stage failed. A SKIP is not a failure — it is a
   gap, and the receipt says so in both the table and the closing list.      */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = process.argv.includes('--sweep');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 2_400_000,
    env: { ...process.env, CARGO_TARGET_DIR: `${ROOT}/target` }, ...opts });

/* PRESENCE, not `--version`. The first version asked each binary for a
   version string and skipped every stage that mattered: `tauri-driver` does
   not answer `--version`, and ImageMagick's `import` wants `-version`. A
   capability probe that is wrong in the SKIP direction is the worst kind —
   the run goes green having tested nothing. */
const has = (c) => run('sh', ['-c', `command -v ${c}`]).status === 0;
const display = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const capability = {
  'tauri-driver': has('tauri-driver'),
  WebKitWebDriver: run('test', ['-x', process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver']).status === 0,
  display,
  magick: has('magick'),
  import: has('import'),
  xprop: has('xprop'),
};

const stages = [];
const stage = (name, proves, fn) => {
  const t0 = Date.now();
  const r = fn();
  stages.push({ name, proves, ms: Date.now() - t0, ...r });
  const tag = r.status === 'held' ? '\x1b[32mheld\x1b[0m'
    : r.status === 'skip' ? '\x1b[33mSKIP\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
  console.log(`  ${tag}  ${name.padEnd(26)} ${r.result ?? r.why ?? ''}`);
};
const counts = (out) => {
  const m = /(\d+) held · (\d+) failed/.exec(out || '');
  return m ? { held: +m[1], failed: +m[2] } : null;
};
const fromCounts = (r) => {
  const c = counts((r.stdout || '') + (r.stderr || ''));
  if (!c) return { status: 'failed', why: `no count line (exit ${r.status})` };
  return { status: c.failed === 0 && r.status === 0 ? 'held' : 'failed',
           result: `${c.held} held · ${c.failed} failed`, held: c.held, failed: c.failed };
};

console.log(`\n  tier1-proof · verify · ${stamp}\n`);

stage('build', 'the harness compiles', () => {
  const r = run('cargo', ['build', '--release']);
  return r.status === 0 ? { status: 'held', result: 'release' }
                        : { status: 'failed', why: (r.stderr || '').slice(-300) };
});

stage('registry unit tests', 'the whoami/revocation invariants, deterministically', () => {
  const r = run('cargo', ['test', '--release']);
  const m = /test result: ok\. (\d+) passed/.exec(r.stdout || '');
  return r.status === 0 && m ? { status: 'held', result: `${m[1]} passed` }
                             : { status: 'failed', why: (r.stdout || '').slice(-300) };
});

stage('static ACL gate', 'the three lists agree; no capability names a window', () =>
  fromCounts(run('node', ['tools/check-acl.mjs'])));

stage('live battery', 'the round trip, containment, and the authority boundary', () => {
  if (!capability['tauri-driver'] || !capability.WebKitWebDriver || !display)
    return { status: 'skip', why: 'needs tauri-driver, WebKitWebDriver and a display' };
  return fromCounts(run('node', ['tools/proof-battery.mjs']));
});

stage('handoff battery', 'two apps, one live pane: routing, acceptance, eviction', () => {
  if (!capability['tauri-driver'] || !capability.WebKitWebDriver || !display)
    return { status: 'skip', why: 'needs tauri-driver, WebKitWebDriver and a display' };
  return fromCounts(run('node', ['tools/handoff-battery.mjs']));
});

stage('geometry contract', 'road 1000x653, pane at the requested rect', () => {
  if (!capability['tauri-driver'] || !display)
    return { status: 'skip', why: 'needs tauri-driver and a display' };
  const r = run('node', ['tools/geometry-probe.mjs']);
  const v = /verdict: (.+)/.exec(r.stdout || '');
  return v && /parent intact/.test(v[1]) ? { status: 'held', result: v[1].trim() }
    : { status: 'failed', why: (v ? v[1] : (r.stdout || '')).slice(-200) };
});

stage('renderer death', 'unresponsive never gone; the road survives; recovery', () => {
  if (!capability['tauri-driver'] || !display)
    return { status: 'skip', why: 'needs tauri-driver and a display' };
  return fromCounts(run('node', ['tools/renderer-crash.mjs']));
});

stage('on-screen position', 'WHERE the pane is, in pixels', () => {
  if (!capability.import || !capability.magick || !capability.xprop || !display)
    return { status: 'skip', why: 'needs ImageMagick (import + magick), xprop and an X display' };
  const r = run('node', ['tools/pose-screenshot.mjs', `${ROOT}/receipts/read-pose-${stamp}.png`]);
  const v = /"verdict": "([^"]+)"/.exec(r.stdout || '');
  const g = /"raw_trim_geometry": "([^"]+)"/.exec(r.stdout || '');
  return v && /IS AT THE REQUESTED RECT/.test(v[1])
    ? { status: 'held', result: g ? g[1] : v[1] }
    : { status: 'failed', why: (v ? v[1] : (r.stdout || '')).slice(-200) };
});

stage('sabotage sweep', 'every law has a falsifier that can be written', () => {
  if (!SWEEP) return { status: 'skip', why: 'not requested — pass --sweep (~20 min)' };
  if (!display) return { status: 'skip', why: 'needs a display' };
  const r = run('bash', ['tools/sabotage.sh']);
  const out = (r.stdout || '') + (r.stderr || '');
  const fal = (out.match(/IS A FALSIFIER/g) || []).length;
  const not = (out.match(/NOT A FALSIFIER/g) || []).length;
  const off = (out.match(/RED, BUT NOT ON THE NAMED LAW/g) || []).length;
  return not === 0 && off === 0 && fal > 0
    ? { status: 'held', result: `${fal}/${fal} falsifiers` }
    : { status: 'failed', why: `${fal} falsifiers, ${off} off-law, ${not} not falsifiers` };
});

/* ── the receipt ──────────────────────────────────────────────────────── */
const commit = (run('git', ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
const dirty = (run('git', ['status', '--porcelain', '--', '.']).stdout || '').trim();
const failed = stages.filter((s) => s.status === 'failed');
const skipped = stages.filter((s) => s.status === 'skip');

/* A RECEIPT DESCRIBES A REVISION, NOT A WORKING DIRECTORY.
   The first one was committed, and a receipt that is part of the commit it
   describes cannot describe it — it was written before the commit existed and
   permanently records `working tree dirty`. Receipts are build artifacts now:
   `receipts/` is git-ignored and CI uploads them. What ties a run to code is
   the COMMIT RECORDED INSIDE, and a run against a dirty tree says so at the
   top, because it is evidence about no revision at all. */
const lines = [
  `# tier1-proof — verification receipt`,
  ``,
  dirty
    ? `> **NOT A RECORD OF ANY REVISION.** The working tree was dirty, so this run\n`
      + `> describes \`${commit}\` plus uncommitted changes. Re-run against a clean tree\n`
      + `> before citing it.\n`
    : `Tested revision: \`${(run('git', ['rev-parse', 'HEAD']).stdout || '').trim()}\``,
  ``,
  `**${stamp}** · commit \`${commit}\`${dirty ? ' · **working tree dirty**' : ' · clean tree'}`,
  `· ${failed.length ? `**${failed.length} STAGE(S) FAILED**`
      : skipped.length ? `**${skipped.length} STAGE(S) SKIPPED — NOT A FULL VERIFICATION**`
      : 'ALL STAGES HELD'}`,
  ``,
  `| stage | proves | result | ms |`,
  `|---|---|---|---|`,
  ...stages.map((s) => `| ${s.name} | ${s.proves} | ${s.status === 'skip'
    ? `**SKIP** — ${s.why}` : (s.result ?? s.why)} | ${s.ms} |`),
  ``,
  `## Host`,
  ``,
  '```',
  `${(run('uname', ['-sr']).stdout || '').trim()}`,
  `session ${process.env.XDG_SESSION_TYPE ?? '?'} · DISPLAY ${process.env.DISPLAY ?? '-'}`
    + ` · WAYLAND_DISPLAY ${process.env.WAYLAND_DISPLAY ?? '-'}`,
  Object.entries(capability).map(([k, v]) => `${k}: ${v}`).join(' · '),
  '```',
  ``,
  `## Not measured here, and why`,
  ``,
  `- **Source unavailability.** The UI is baked into the binary (\`frontendDist\`), so there is`,
  `  no origin to take away. Reaching this condition needs a pane loaded from an external`,
  `  origin, which is **§13 #7 — an open [TRAVIS] decision**. Building it would answer that`,
  `  ruling by accident, which is the reason this harness is standalone in the first place.`,
  `- **Anything at all on macOS.** No Mac. \`tools/geometry-probe.mjs\` is the release gate in`,
  `  one command; CI compiles and unit-tests on macos-14 and validates no geometry, no`,
  `  containment and no input.`,
  ...skipped.map((s) => `- **${s.name}** — skipped: ${s.why}`),
  ``,
];
mkdirSync(`${ROOT}/receipts`, { recursive: true });
const path = `${ROOT}/receipts/VERIFY-${stamp}.md`;
writeFileSync(path, lines.join('\n'));
console.log(`\n  receipt: ${path}${dirty ? '  \x1b[33m(dirty tree — not a record of any revision)\x1b[0m' : ''}`);
/* A SKIP IS A GAP, and a headline that reads "all stages held" beside five of
   them is the reassuring lie this file's own header warns about. When anything
   was skipped the summary says so FIRST, and does not use the word that would
   let a reader stop reading there. */
const heldN = stages.filter((x) => x.status === 'held').length;
/* "1 FAILED · all 8 stages held" — the summary contradicted itself, because a
   failure and a skip were treated as independent and only the skip branch
   could displace the word "all". A failure displaces it too. */
console.log('\n  ' + (failed.length
    ? `\x1b[31m${failed.length} FAILED\x1b[0m · ${heldN} held`
      + (skipped.length ? ` · ${skipped.length} skipped` : '')
    : skipped.length
      ? `\x1b[33m${heldN} held · ${skipped.length} SKIPPED — this is not a full verification\x1b[0m`
      : `\x1b[1mall ${heldN} stages held\x1b[0m`) + '\n');
process.exit(failed.length ? 1 : 0);
