/* renderer-crash — the failure §10.1 is actually about.
   ────────────────────────────────────────────────────────────────────────
   §12.2 exercises a CONTROLLED teardown and says so; an actual renderer death
   was named as unproven. This kills the pane's web process outright and reads
   what the host makes of it.

   **The pane has its own renderer, measured.** Under WebKitGTK each webview
   gets a `WebKitWebProcess` child of the application: with the road alone
   there is one, and a promote adds a second. So the pane's renderer is
   identified by taking the set before the promote and the set after, and
   killing the difference — no guessing, and the road's own renderer is never
   touched.

   WHAT IS UNDER TEST — §10.1 says the host cannot detect renderer loss:
     · a crash must read `unresponsive`, NEVER `gone`, because the clock is
       the only thing that noticed and a clock may not pronounce death
     · `present` must stay true, because tauri still holds the webview and
       emits no destroyed event
     · the ROAD must survive — a pane crash that takes the shell down is a
       different product
     · `demote` must still recover, and re-promote must mint a NEW instance   */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/target/release/tier1-proof`;
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4485);
const NATIVE = Number(process.env.TAURI_NATIVE_PORT ?? 4486);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let held = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { held++; console.log(`  \x1b[32mheld\x1b[0m    ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAILED\x1b[0m  ${name}${detail ? `\n           ${detail}` : ''}`); }
};
const note = (t) => console.log(`  \x1b[33mnote\x1b[0m    ${t}`);

async function wd(m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b) });
  const j = JSON.parse(await r.text());
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

/* The application's OWN renderer children, by ppid. Matching on the binary
   name alone would sweep in every other WebKitGTK application on the desktop
   — there is one running on this box right now, and killing a stranger's
   renderer is not a test. */
const renderers = (appPid) => (spawnSync('ps', ['-eo', 'pid,ppid,comm'], { encoding: 'utf8' }).stdout || '')
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((c) => c[2] === 'WebKitWebProces' && String(c[1]) === String(appPid))
  .map((c) => Number(c[0]));

const appPidOf = () => {
  const out = spawnSync('pgrep', ['-f', `${ROOT}/target/release/tier1-proof`], { encoding: 'utf8' }).stdout || '';
  return Number(out.trim().split('\n')[0]);
};

if (!existsSync(APP)) { console.error(`no built harness at ${APP}`); process.exit(2); }
const driver = spawn('tauri-driver',
  ['--port', String(PORT), '--native-port', String(NATIVE),
   '--native-driver', process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver'],
  { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
let session = null;
const stop = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch {} };
process.on('exit', stop);

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/status`); break; } catch { await sleep(200); } }
  const c = await wd('POST', '/session',
    { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  session = c.sessionId ?? c.capabilities?.sessionId;
  const sc = (js) => wd('POST', `/session/${session}/execute/sync`, { script: js, args: [] });
  const status = () => sc(`return window.__TAURI__.core.invoke('road_status',
    { generation: window.__ROAD_GENERATION }).then(r => r, e => ({ refused: String(e) }));`);
  await sleep(2500);

  const appPid = appPidOf();
  const before = renderers(appPid);
  const el = await wd('POST', `/session/${session}/element`, { using: 'css selector', value: '#enter' });
  await wd('POST', `/session/${session}/element/${Object.values(el)[0]}/click`, {});
  await sleep(3500);

  const after = renderers(appPid);
  const paneRenderer = after.filter((p) => !before.includes(p));
  const st0 = await status();
  console.log(`\n  app ${appPid} · renderers before ${JSON.stringify(before)} · after ${JSON.stringify(after)}`);
  check('the pane has its OWN renderer process, not the road\'s',
    paneRenderer.length === 1, `delta ${JSON.stringify(paneRenderer)}`);
  check('the pane is live before the kill',
    st0.liveness === 'live' && st0.present === true, JSON.stringify(st0.liveness));
  const label0 = st0.pane_label;

  /* ── THE OBSERVATION CHANNEL HAS TO CHANGE ─────────────────────────
     A renderer crash DELETES THE WEBDRIVER SESSION: the next command comes
     back `invalid session id: session deleted because of page crash or hang`.
     So the crash cannot be watched through the channel that set it up, and
     the first version of this probe died at exactly that line.

     The road records the timeline itself, into its own `localStorage`, and a
     LATER session reads it back — storage outlives the application, which the
     battery already relies on for the pane's state. Nothing is added to the
     product to make this work: the recorder is injected from the test side
     and the road polls a command it already has. */
  /* The recorder also DRIVES THE RECOVERY, for the same reason it records:
     WebDriver is about to die, and the road's page is the only thing left
     that can still reach the host. It demotes the crashed pane and promotes
     a fresh one on its own schedule, and writes both outcomes to the log. */
  await sc(`localStorage.removeItem('tier1.crashlog');
    window.__crashLog = [];
    window.__crashStep = 0;
    const push = (o) => { window.__crashLog.push({ t: Date.now(), ...o });
      localStorage.setItem('tier1.crashlog', JSON.stringify(window.__crashLog)); };
    window.__crashTimer = setInterval(() => {
      const n = ++window.__crashStep;
      if (n === 14) {
        window.__apply('demote').then(r => push({ event: 'demote', ok: r.ok, why: r.why }));
        return;
      }
      if (n === 17) {
        const f = document.getElementById('readframe'); f.classList.add('on');
        const b = f.getBoundingClientRect();
        window.__apply('promote', { package: window.__probe().packages[0], task: null,
                                    rect: { x: b.x, y: b.y, width: b.width, height: b.height } })
          .then(r => push({ event: 'promote', ok: r.ok, why: r.why,
                            label: r.ok ? r.result.pane.surface : null }));
        return;
      }
      window.__TAURI__.core.invoke('road_status', { generation: window.__ROAD_GENERATION })
        .then(r => push({ liveness: r.liveness, present: r.present, label: r.pane_label }),
              e => push({ refused: String(e) }));
    }, 400); return true;`);
  await sleep(1200);

  /* ── THE CRASH ─────────────────────────────────────────────────────── */
  note(`SIGKILL to the pane's renderer ${paneRenderer[0]} (exercises: RENDERER DEATH,`);
  note('        not a controlled teardown and not source unavailability)');
  const t0 = Date.now();
  spawnSync('kill', ['-9', String(paneRenderer[0])]);

  /* Watched from OUTSIDE the process from here on. No WebDriver call is made
     until the app is gone — one would only produce the session-deleted error
     and take the run with it. */
  const outside = [];
  for (let i = 0; i < 28; i++) {
    await sleep(500);
    outside.push({ t: Date.now() - t0, app: appPidOf() === appPid, renderers: renderers(appPid) });
  }
  const last = outside[outside.length - 1];
  console.log(`\n  outside: app alive ${outside.every((x) => x.app)} · renderers `
    + `${outside.map((x) => x.renderers.length).join('')} over ${last.t}ms`);
  /* Judged in the window BEFORE the road demotes and re-promotes — after that
     a second renderer is the REPLACEMENT pane, not the dead one recovering,
     and reading the count at the end reported a respawn that never happened. */
  const preRecovery = outside.filter((x) => x.t < 4000);
  check('the APPLICATION survives its pane\'s renderer dying',
    outside.every((x) => x.app),
    'the app process exited — a pane crash took the whole shell with it');
  check('the ROAD\'s own renderer is untouched',
    outside.every((x) => x.renderers.includes(before[0])),
    `road renderer ${before[0]} is no longer among ${JSON.stringify(last.renderers)}`);
  const revived = preRecovery.some((x) => x.renderers.some((p) => !before.includes(p)));
  check('the killed renderer stays dead — the webview is a live object with nothing behind it',
    !revived && preRecovery.every((x) => !x.renderers.includes(paneRenderer[0])),
    `a renderer outside ${JSON.stringify(before)} reappeared before any recovery`);
  note(revived
    ? 'WebKitGTK RESPAWNED the web process on its own'
    : 'WebKitGTK did not respawn it — nothing recovers the pane except the host');

  /* ── READ THE ROAD'S OWN RECORD, from a fresh session ───────────────── */
  try { await fetch(`${BASE}/session/${session}`, { method: 'DELETE' }); } catch {}
  session = null;
  stop();
  await sleep(1500);

  const driver2 = spawn('tauri-driver',
    ['--port', String(PORT + 10), '--native-port', String(NATIVE + 10),
     '--native-driver', process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver'],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  const BASE2 = `http://127.0.0.1:${PORT + 10}`;
  const wd2 = async (m, pth, b) => {
    const r = await fetch(BASE2 + pth, { method: m, headers: { 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b) });
    const j = JSON.parse(await r.text());
    if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
    return j.value;
  };
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${BASE2}/status`); break; } catch { await sleep(200); } }
    const c2 = await wd2('POST', '/session',
      { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
    const s2 = c2.sessionId ?? c2.capabilities?.sessionId;
    await sleep(2500);
    const log = JSON.parse(await wd2('POST', `/session/${s2}/execute/sync`,
      { script: "return localStorage.getItem('tier1.crashlog') ?? '[]';", args: [] }));
    const afterKill = log.filter((x) => x.t >= t0);
    console.log(`\n  the road recorded ${log.length} samples, ${afterKill.length} after the kill:`);
    console.log('   ' + afterKill.map((x) => `+${x.t - t0}ms ${x.liveness ?? x.refused}`
      + `${x.present === false ? '/absent' : ''}`).join('  '));
    check('the road KEPT ANSWERING while its pane\'s renderer was dead',
      afterKill.length > 0 && afterKill.every((x) => !x.refused),
      afterKill.length ? JSON.stringify(afterKill.filter((x) => x.refused).slice(0, 2))
                       : 'the road recorded nothing after the kill');

    const samples = afterKill.filter((x) => !x.event);
    const demote = afterKill.find((x) => x.event === 'demote');
    const promote = afterKill.find((x) => x.event === 'promote');
    const beforeDemote = samples.filter((x) => demote && x.t < demote.t);
    const afterPromote = samples.filter((x) => promote && x.t > promote.t);
    /* THE WINDOW ENDS AT THE DEMOTE, and getting that wrong once is why it is
       spelled out: the demote's own `gone` is the rule being OBEYED — a
       positive fact — and counting it as a violation made a correct
       implementation look broken. Same class as the geometry check that was
       sampled before layout had settled. */
    const saidGone = beforeDemote.filter((x) => x.liveness === 'gone');
    check('a dead renderer reads `unresponsive`, NEVER `gone`, for as long as it is left alone',
      beforeDemote.some((x) => x.liveness === 'unresponsive') && saidGone.length === 0,
      `gone at ${JSON.stringify(saidGone.map((x) => x.t - t0))}`);
    check('tauri still holds the webview — there is no destroyed event to hear',
      beforeDemote.length > 0 && beforeDemote.every((x) => x.present === true),
      JSON.stringify(beforeDemote.filter((x) => x.present !== true).slice(0, 3)));

    /* ── RECOVERY, driven by the road because nothing else can ────────── */
    check('the host can DEMOTE a pane whose renderer is dead',
      !!demote && demote.ok === true, JSON.stringify(demote));
    const betweenDemoteAndPromote = samples.filter((x) =>
      demote && promote && x.t > demote.t && x.t < promote.t);
    check('and only THEN is it `gone`, by a positive fact',
      betweenDemoteAndPromote.length > 0
        && betweenDemoteAndPromote.every((x) => x.liveness === 'gone' && x.present === false),
      JSON.stringify(betweenDemoteAndPromote.slice(0, 3)));
    check('a new pane promotes after the crash, as a NEW instance',
      !!promote && promote.ok === true && promote.label !== label0
        && /^pane-\d+$/.test(String(promote.label)),
      `was ${label0}, promote said ${JSON.stringify(promote)}`);
    check('the replacement is live and beating',
      afterPromote.length > 0 && afterPromote.some((x) => x.liveness === 'live' && x.present === true),
      JSON.stringify(afterPromote.slice(0, 3)));
    await fetch(`${BASE2}/session/${s2}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    try { process.kill(-driver2.pid, 'SIGKILL'); } catch {}
  }
} catch (e) {
  failed++;
  console.log(`\n  \x1b[31mFAILED\x1b[0m  the probe itself: ${e.message}`);
} finally {
  try { if (session) await fetch(`${BASE}/session/${session}`, { method: 'DELETE' }); } catch {}
  stop();
}
console.log(`\n  \x1b[1m${held} held · ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
