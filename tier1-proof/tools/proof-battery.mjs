/* proof-battery — the live half of ROAD_SHELL.md §12.
   ────────────────────────────────────────────────────────────────────────
   ONE TRANSITION:

     published sign -> read pose -> LIVE pane -> leave read pose -> published sign
                                        |
                                state preserved
                            stale messages rejected

   Nine assertions (§12.1) and the sabotages (§12.2), each naming WHICH
   FAILURE IT EXERCISES — because two of them were originally one and they do
   not test the same thing.

   Needs `tauri-driver`, `WebKitWebDriver` (webkit2gtk-4.1), a display, and a
   built harness. Speaks W3C WebDriver directly: the protocol is a handful of
   endpoints and a JSON envelope, and a client library would be the only
   dependency in a tree that has none.

   TRAP, INHERITED: the UI is BAKED INTO THE BINARY (`frontendDist: "ui"`), so
   editing ui/*.html and re-running this proves nothing about the edit.
   `cargo build --release` after every UI change. ROAD_SHELL.md §10.7.        */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/target/release/tier1-proof`;
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4455);
const NATIVE = Number(process.env.TAURI_NATIVE_PORT ?? 4456);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let held = 0, failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { held++; console.log(`  \x1b[32mheld\x1b[0m    ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAILED\x1b[0m  ${name}${detail ? `\n           ${detail}` : ''}`); }
}
function note(text) { console.log(`  \x1b[33mnote\x1b[0m    ${text}`); }

async function wd(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`); }
  if (json.value && json.value.error) {
    throw new Error(`${method} ${path} -> ${json.value.error}: ${json.value.message}`);
  }
  return json.value;
}

let session = null;
const script = (js, args = []) => wd('POST', `/session/${session}/execute/sync`, { script: js, args });

async function poll(f, limitMs, everyMs) {
  const deadline = Date.now() + limitMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await f(); if (last) return { got: last, last }; }
    catch (e) { last = String(e); }
    await sleep(everyMs);
  }
  return { got: null, last };
}
async function waitFor(label, f, limitMs = 60_000, everyMs = 200) {
  const { got, last } = await poll(f, limitMs, everyMs);
  if (got) return got;
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/* Returns null instead of throwing. A condition that never becomes true must
   fail the CHECK that names it, not take down the run with a timeout — a
   harness that dies on a red assertion reports nothing about the other
   twenty-four. */
async function waitSoft(f, limitMs = 20_000, everyMs = 250) {
  return (await poll(f, limitMs, everyMs)).got;
}

const handles = () => wd('GET', `/session/${session}/window/handles`);
const focus = (handle) => wd('POST', `/session/${session}/window`, { handle });
const labels = () => script(`const m = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata;
  return m ? [m.currentWindow && m.currentWindow.label, m.currentWebview && m.currentWebview.label] : null;`);

/* The topology is DERIVED, never typed. A count asserted by hand goes red the
   day a surface is added, for a reason unrelated to what it was testing. */
async function surfaces() {
  const hs = await handles();
  const seen = [];
  for (const h of hs) {
    await focus(h);
    const l = await labels().catch(() => null);
    if (l) seen.push({ handle: h, window: l[0], webview: l[1] });
  }
  const by = Object.fromEntries(seen.map((v) => [v.webview, v.handle]));
  /* THE PANE LABEL IS `pane-<generation>` AND IS NEVER REUSED, so it is found
     by shape rather than by name. A fixed `by.pane` would have gone red the
     moment the label became instance-scoped, for a reason unrelated to what
     it was testing. ROAD_SHELL.md §6.2. */
  const paneEntry = seen.find((v) => /^pane-\d+$/.test(String(v.webview)));
  return {
    road: by.main ?? null,
    pane: paneEntry ? paneEntry.handle : null,
    paneLabel: paneEntry ? paneEntry.webview : null,
    count: hs.length,
    seen,
  };
}

const findEl = async (css) =>
  wd('POST', `/session/${session}/element`, { using: 'css selector', value: css });
const click = async (css) => {
  const el = await findEl(css);
  const id = Object.values(el)[0];
  await wd('POST', `/session/${session}/element/${id}/click`, {});
};
/* CLEARS FIRST, and that is not a detail.
   WebDriver's `/value` APPENDS. The pane's note lives in localStorage, which
   survives the app, so a second run of this battery started with the field
   already full and typed into the end of it — and the two assertions that read
   the note went red in every one of the four sabotages, including the two that
   touch neither typing nor state. A battery that is not idempotent across runs
   reports the previous run. Found by the sabotage sweep, which is what a
   sabotage sweep is for. */
const typeInto = async (css, text) => {
  const el = await findEl(css);
  const id = Object.values(el)[0];
  await wd('POST', `/session/${session}/element/${id}/clear`, {});
  await wd('POST', `/session/${session}/element/${id}/value`, { text });
};

const roadProbe = () => script('return window.__probe();');
const geom = () => script('return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };');
const near = (a, b, slack = 8) => Math.abs(a - b) <= slack;
const paneProbe = () => script('return window.__paneProbe();');
const status = async () => script(
  `return window.__TAURI__.core.invoke('road_status', { generation: window.__ROAD_GENERATION })
     .then(r => r, e => ({ refused: String(e) }));`);

async function run() {
  let S = await surfaces();

  /* ── 1 ─ the published sign, with no pane in existence ──────────────── */
  console.log('\n  \x1b[1m1 · the sign renders from the published representation\x1b[0m');
  await focus(S.road);
  await waitFor('the road to finish loading', async () =>
    (await script("return document.body.dataset.ready === '1';")) === true);
  let p = await roadProbe();
  let st = await status();
  const roadBefore = await geom();
  check('the sign is drawn from the COORDINATOR\'s manifest — no pane has ever existed',
    p.signSource === 'coordinator' && p.manifestOwner === 'host' && p.signPrimitives === 6,
    JSON.stringify(p));
  check('the sign is visible and no pane webview exists',
    p.signVisible === true && S.pane === null && st.present === false,
    `signVisible=${p.signVisible} pane=${S.pane} present=${st.present}`);
  check('the road holds a host-minted generation it never asked for',
    typeof p.roadGeneration === 'number' && p.roadGeneration >= 1, `gen=${p.roadGeneration}`);

  /* ── 9a ─ the ALLOWED half, before the refusal half ─────────────────── */
  console.log('\n  \x1b[1m9a · the road performs an allowed op\x1b[0m');
  const placed = await script(
    `return window.__apply('place', { dash: 12, side: 1 }).then(r => r);`);
  check('road_place succeeds and returns the host-derived principal',
    placed.ok === true && placed.result?.by_principal?.surface === 'main'
      && placed.result.by_principal.grants.includes('place'),
    JSON.stringify(placed).slice(0, 240));

  /* ── 9b ─ the privileged refusal, including the forged `by` ─────────── */
  console.log('\n  \x1b[1m9b · the host refuses a privileged op — and `by` is not consulted\x1b[0m');
  const plain = await script(`return window.__apply('intent', { payload: 'x' }).then(r => r);`);
  check('a privileged op from the road is refused by the HOST',
    plain.ok === false && /PRINCIPAL_GRANT_NOT_HELD/.test(plain.why), plain.why);
  const forged = await script(
    `return window.__apply('intent', { payload: 'x' }, { by: 'cockpit' }).then(r => r);`);
  check('SABOTAGE — forging by:\'cockpit\' changes nothing (exercises: `by` reaching a decision)',
    forged.ok === false && /PRINCIPAL_GRANT_NOT_HELD/.test(forged.why)
      && /not consulted/.test(forged.why), forged.why);
  check('the ACL let it through — so what refused it was the seam, not the resolver',
    !/not allowed|forbidden|Unauthorized/i.test(forged.why), forged.why);

  /* ── 2 ─ promote ────────────────────────────────────────────────────── */
  console.log('\n  \x1b[1m2 · read promotes exactly one pane to live\x1b[0m');

  /* ── CONTAINMENT, SAMPLED THROUGH THE WHOLE TRANSITION ────────────────
     `promote` is started WITHOUT awaiting it, and the road is polled while
     it runs. Eventual geometry is not containment: before this, the pane was
     created box-packed at full window size and stayed that way ~2.8 s — an
     untrusted surface covering the road and taking input over all of it,
     while every post-settle assertion passed. §10.6.3.
     The rule sampled here: at no moment is the pane BOTH visible and outside
     its rectangle. `visible` folds in opacity, and `sensitive` is input.   */
  const samples = [];
  await script(`window.__promoting = window.__apply('promote',
    { rect: (() => { const f = document.getElementById('readframe');
                     f.classList.add('on');
                     const r = f.getBoundingClientRect();
                     return { x: r.x, y: r.y, width: r.width, height: r.height }; })() })
    .then(r => (window.__promoted = r));`);
  const wantRect = await script("const f = document.getElementById('readframe').getBoundingClientRect();\n"
    + 'return { w: Math.round(f.width), h: Math.round(f.height) };');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const st0 = await status();
    if (st0 && st0.read_pose) {
      samples.push({
        visible: st0.read_pose.visible,
        sensitive: st0.read_pose.sensitive,
        w: st0.read_pose.alloc && st0.read_pose.alloc.w,
        h: st0.read_pose.alloc && st0.read_pose.alloc.h,
      });
    }
    if (await script('return window.__promoted !== undefined;')) break;
  }
  const promoted = await script('return window.__promoted;');
  const escaped = samples.filter((x) =>
    (x.visible || x.sensitive) && !(near(x.w, wantRect.w) && near(x.h, wantRect.h)));
  check(`the pane is never visible or interactive outside its rectangle (${samples.length} samples)`,
    promoted && promoted.ok === true && escaped.length === 0,
    escaped.length ? `escaped in ${escaped.length}: ${JSON.stringify(escaped.slice(0, 3))}`
                   : `promote said ${JSON.stringify(promoted).slice(0, 200)}`);
  if (promoted && promoted.ok) {
    note(`the host held the pane contained for ${promoted.result.pose_ms} ms, then revealed it`);
  }

  S = await waitFor('the pane webview to exist', async () => {
    const s = await surfaces(); return s.pane ? s : null;
  });
  const firstPaneLabel = S.paneLabel;
  await focus(S.road);
  st = await status();
  check('the pane label is instance-scoped, not a reusable name',
    /^pane-\d+$/.test(String(firstPaneLabel)), String(firstPaneLabel));
  check('the child webview exists and the road reports the live tier',
    S.pane !== null && st.tier === 'live' && st.present === true, JSON.stringify(st).slice(0, 200));
  check('the pane is a child of the ROAD window, not a second window',
    S.seen.filter((v) => v.window === 'main').length === S.count && S.count === 2,
    JSON.stringify(S.seen));
  const second = await script(
    `return window.__apply('promote', { rect: { x: 300, y: 20, width: 520, height: 260 } }).then(r => r);`);
  check('a second promote is refused — the live budget is N = 1 (§4.1)',
    second.ok === false && /TIER_ALREADY_LIVE/.test(second.why), second.why);

  /* ── 2b ─ THE READ POSE, ON SCREEN. An acceptance gate, not a note. ───
     The transition is half the central promise and geometry is the half a
     screenshot would have shown. Before the GTK overlay this read
     road 1000x1 / pane 1000x653 — the road stopped having a surface while
     every authority assertion stayed green. ROAD_SHELL.md §10.6.           */
  console.log('\n  \x1b[1m2b · the read pose is on screen — the road survives its own pane\x1b[0m');
  const want = await script("const f = document.getElementById('readframe').getBoundingClientRect();\n"
    + 'return { w: Math.round(f.width), h: Math.round(f.height) };');

  /* THE READ POSE IS REACHED ASYNCHRONOUSLY, and the deadline is part of the
     assertion rather than a sleep hidden in a helper. Measured: the pane is
     created at full window size and GTK re-allocates it to the requested rect
     afterwards, so a check made the instant `promote` returns reads 1000x653
     and a 1500 ms sleep reads 522x262. Both are true; only one is the claim.
     A road that draws its own chrome will see that first frame, so the window
     is named here rather than slept through. */
  const started = Date.now();
  let paneGeom = null;
  await focus(S.pane);
  const settled = await waitSoft(async () => {
    paneGeom = await geom();
    return near(paneGeom.w, want.w) && near(paneGeom.h, want.h);
  }, 5_000, 100);
  const settleMs = Date.now() - started;
  await focus(S.road);
  const roadGeom = await geom();
  check(`the PANE reaches the requested read rect within 5 s (took ${settleMs} ms)`,
    settled === true,
    `wanted ${want.w}x${want.h}, last read ${paneGeom && paneGeom.w}x${paneGeom && paneGeom.h}`);
  /* MEASURED AFTER THE PANE SETTLES, and that ordering is the assertion.
     Read immediately after `promote` this check PASSED under sabotage S5 —
     the road is still full-size for the moment before GTK re-allocates, so a
     gate placed there goes green over the exact collapse it exists to catch.
     It survived only because the pane check failed beside it. A geometry
     assertion made before layout has settled is not a geometry assertion. */
  check('the ROAD still has a full-size surface AFTER the pane has settled',
    near(roadGeom.h, roadBefore.h) && near(roadGeom.w, roadBefore.w),
    `road was ${roadBefore.w}x${roadBefore.h}, is now ${roadGeom.w}x${roadGeom.h}`);
  note(`the read pose is asynchronous — full-window at first paint, ${settleMs} ms to settle`);

  /* ── 3 ─ pointer and keyboard reach the pane ────────────────────────── */
  console.log('\n  \x1b[1m3 · pointer and keyboard reach the pane while live\x1b[0m');
  await focus(S.pane);
  await waitFor('the pane to load', async () =>
    (await script("return document.body.dataset.ready === '1';")) === true);
  const before = (await paneProbe()).counter;
  for (let i = 0; i < 7; i++) await click('#inc');
  await typeInto('#note', 'survives the round trip');
  let pp = await paneProbe();
  check('a real WebDriver click reaches the pane and changes its DOM',
    pp.counter === before + 7, `before=${before} after=${pp.counter}`);
  check('real typed keys reach the pane',
    pp.note === 'survives the round trip', JSON.stringify(pp.note));
  const paneGen = pp.generation;

  /* ── 6 ─ the pane rejects a non-current generation ──────────────────── */
  console.log('\n  \x1b[1m6 · every message carries a generation; non-current is rejected\x1b[0m');
  const bogus = await script(`return window.__invokeRaw('pane_beat', { generation: 999999 });`);
  check('a request carrying a generation the binding is not at is refused',
    bogus.ok === false && /PRINCIPAL_STALE_GENERATION/.test(bogus.why), bogus.why);
  const noGrant = await script(`return window.__invokeRaw('road_status', { generation: ${paneGen} });`);
  check('the pane cannot read the road\'s status — it holds no such grant',
    noGrant.ok === false, noGrant.why);

  /* ── 8 ─ liveness: unresponsive is not gone ─────────────────────────── */
  console.log('\n  \x1b[1m8 · a missed beat is `unresponsive`, never `gone`\x1b[0m');
  await focus(S.road);
  st = await status();
  check('a beating pane reads live', st.liveness === 'live', JSON.stringify(st.liveness));
  await focus(S.pane);
  await click('#stall');
  note('SABOTAGE — beats stopped (exercises: a slow or throttled pane, NOT death)');
  await sleep(2200);
  await focus(S.road);
  st = await status();
  check('SABOTAGE HELD — a stalled pane reads `unresponsive` and stays present',
    st.liveness === 'unresponsive' && st.present === true && st.tier === 'live',
    JSON.stringify({ liveness: st.liveness, present: st.present, tier: st.tier }));

  /* ── 4 ─ demote ─────────────────────────────────────────────────────── */
  console.log('\n  \x1b[1m4 · leaving the read pose destroys the pane and restores the sign\x1b[0m');
  note('SABOTAGE — controlled pane teardown (exercises: renderer removal by a positive fact,');
  note('           NOT a renderer crash and NOT source unavailability — see §12.2)');
  await click('#leave');
  S = await waitFor('the pane webview to be gone', async () => {
    const s = await surfaces(); return s.pane === null ? s : null;
  });
  await focus(S.road);
  st = await status();
  p = await roadProbe();
  check('the pane webview is destroyed and liveness reads `gone` by a positive fact',
    S.pane === null && st.present === false && st.liveness === 'gone',
    JSON.stringify({ pane: S.pane, present: st.present, liveness: st.liveness }));
  check('the sign is back, drawn from the manifest — not a retained last frame',
    p.signVisible === true && p.signSource === 'coordinator' && p.signPrimitives === 6,
    JSON.stringify(p));

  /* ── 5 + 7 ─ re-promote: state survives, old generation is dead ─────── */
  console.log('\n  \x1b[1m5 · state survives the round trip, and the shell holds no copy\x1b[0m');
  await click('#enter');
  S = await waitFor('the pane to come back', async () => {
    const s = await surfaces(); return s.pane ? s : null;
  });
  await focus(S.pane);
  await waitFor('the pane to load again', async () =>
    (await script("return document.body.dataset.ready === '1';")) === true);
  pp = await paneProbe();
  check('the app restored its own state across destroy + recreate',
    pp.counter === before + 7 && pp.note === 'survives the round trip',
    JSON.stringify({ counter: pp.counter, note: pp.note }));
  check('the generation advanced — this is a NEW binding',
    pp.generation > paneGen, `was ${paneGen}, now ${pp.generation}`);
  /* THE SUCCESSOR IS A DIFFERENT INSTANCE, NOT THE SAME NAME REBOUND.
     `whoami` takes no echoed generation — it is what a caller uses to LEARN
     one — so under a reusable label an instance that outlived its `close()`
     could call it, resolve the name to whichever binding now holds it, and
     come back carrying the successor's generation. It would stop being old.
     With the generation in the label there is no such name to resolve.
     The deterministic version of this, including the revoked-instance
     refusal, is `src/principal.rs`'s unit tests: a renderer that survives its
     own close cannot be summoned on demand (§10.1), so the live battery
     asserts the structure and the registry asserts the behaviour. */
  check('the replacement pane is a NEW instance label, not the old name rebound',
    S.paneLabel !== firstPaneLabel && /^pane-\d+$/.test(String(S.paneLabel)),
    `was ${firstPaneLabel}, now ${S.paneLabel}`);

  await focus(S.road);
  st = await status();
  const hostState = JSON.stringify(st.host_state);
  check('the HOST holds no copy of the app\'s state',
    !hostState.includes('survives the round trip') && !/"counter"/.test(hostState),
    hostState.slice(0, 300));

  console.log('\n  \x1b[1m7 · an old-generation request never reaches the replacement\x1b[0m');
  await focus(S.pane);
  const stale = await script(`return window.__invokeRaw('pane_beat', { generation: ${paneGen} });`);
  check('SABOTAGE HELD — replaying the captured old generation is refused (exercises: a revoked binding)',
    stale.ok === false && /PRINCIPAL_STALE_GENERATION/.test(stale.why), stale.why);
  await focus(S.road);
  const recorded = await script(`return document.getElementById('replay-old-gen').click(), true;`);
  await sleep(150);
  const shown = await script("return document.getElementById('status').textContent;");
  check('a RECORDED identity carries no authority — replay needs current authorization (§6.2 #5)',
    /PRINCIPAL_STALE_GENERATION/.test(shown), shown.slice(0, 200));

  /* A picture of the end state, for a person. Not an assertion — §10.9 is
     the standing reminder that a screenshot cannot tell success from a layer
     that merely reported it. */
  if (process.env.PROOF_SHOT) {
    const b64 = await wd('GET', `/session/${session}/screenshot`);
    (await import('node:fs')).writeFileSync(process.env.PROOF_SHOT, Buffer.from(b64, 'base64'));
    note(`screenshot written to ${process.env.PROOF_SHOT}`);
  }

  /* ── what this run did NOT exercise ─────────────────────────────────── */
  console.log('\n  \x1b[1mnot exercised, and named rather than implied\x1b[0m');
  note('source availability (kill the dev server): this harness has NO dev server — the UI is');
  note('   baked into the binary (§10.7), so the condition cannot arise here. Unproven.');
  note('an actual renderer CRASH: only controlled teardown was exercised above. Unproven.');
  note('anything at all on macOS. `tools/geometry-probe.mjs` is the same contract in one');
  note('   command and is what turns §11 from a hypothesis into a measurement there.');
}

async function main() {
  if (!existsSync(APP)) {
    console.error(`no built harness at ${APP} — run: cargo build --release`);
    process.exit(2);
  }
  const driver = spawn('tauri-driver',
    ['--port', String(PORT), '--native-port', String(NATIVE),
     '--native-driver', process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver'],
    /* Its own process group, so `kill(-pgid)` reaches the app the driver
       spawned and nothing else. An orphaned webview holding this process's
       stdout is a hang with no output, and it has happened here before. */
    { stdio: ['ignore', 'inherit', 'inherit'], detached: true });

  const stop = () => {
    try { if (session) fetch(`${BASE}/session/${session}`, { method: 'DELETE' }).catch(() => {}); } catch {}
    try { process.kill(-driver.pid, 'SIGKILL'); } catch {}
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  try {
    await waitFor('tauri-driver to listen', async () => {
      try { await fetch(`${BASE}/status`); return true; } catch { return false; }
    }, 20_000, 200);
    const created = await wd('POST', '/session',
      { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
    session = created.sessionId ?? created.capabilities?.sessionId;
    if (!session) throw new Error(`no sessionId in ${JSON.stringify(created)}`);
    await run();
  } catch (e) {
    failed++;
    console.log(`\n  \x1b[31mFAILED\x1b[0m  the battery itself: ${e.message}`);
  } finally {
    stop();
  }
  console.log(`\n  \x1b[1m${held} held · ${failed} failed\x1b[0m\n`);
  process.exit(failed ? 1 : 0);
}
main();
