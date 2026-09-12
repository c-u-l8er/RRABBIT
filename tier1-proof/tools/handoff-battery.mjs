/* handoff-battery — two apps, one live pane. ROAD_SHELL.md §5 / §5.1 / §4.1.
   ────────────────────────────────────────────────────────────────────────
   The single-pane proof answered whether a pane can stand on a road at all.
   This answers whether the rules COMPOSE ACROSS AN APP BOUNDARY, which is
   where they are first able to contradict each other:

     · both signs render with ZERO live panes
     · routing is by DECLARED acceptance, and an unroutable kind is refused
       by name rather than dropped
     · an app's own report is not a transfer — only the coordinator's
       ACCEPTANCE is, and the road has nothing to route until it exists
     · eviction under N = 1 is how the second app stands, not an optimisation
     · authority does not leak across the boundary: a package that declares no
       `produces` is refused when it tries to hand work on
     · each app's own state survives its own eviction using package-specific
       keys; the shared origin is NOT a confidentiality boundary

   `N = 1` is NOT a limit on this test. It limits SIMULTANEOUS live panes;
   two apps, routing, eviction, state and sequential promotion are all
   provable under it, and only simultaneous residency needs ruling §13 #6.  */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/target/release/tier1-proof`;
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4491);
const NATIVE = Number(process.env.TAURI_NATIVE_PORT ?? 4492);
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
let session = null;
const script = (js) => wd('POST', `/session/${session}/execute/sync`, { script: js, args: [] });
const handles = () => wd('GET', `/session/${session}/window/handles`);
const focus = (h) => wd('POST', `/session/${session}/window`, { handle: h });
const label = () => script('const m = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata;\n'
  + 'return m && m.currentWebview && m.currentWebview.label;');
async function surfaces() {
  const hs = await handles(); const seen = [];
  for (const h of hs) { await focus(h); const l = await label().catch(() => null);
    if (l) seen.push({ handle: h, webview: l }); }
  const pane = seen.find((v) => /^pane-\d+$/.test(String(v.webview)));
  return { road: (seen.find((v) => v.webview === 'main') || {}).handle ?? null,
           pane: pane ? pane.handle : null, paneLabel: pane ? pane.webview : null,
           count: hs.length };
}
const clickOn = async (css) => {
  const el = await wd('POST', `/session/${session}/element`, { using: 'css selector', value: css });
  await wd('POST', `/session/${session}/element/${Object.values(el)[0]}/click`, {});
};

if (!existsSync(APP)) { console.error(`no built harness at ${APP}`); process.exit(2); }
const driver = spawn('tauri-driver',
  ['--port', String(PORT), '--native-port', String(NATIVE),
   '--native-driver', process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver'],
  { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
const stop = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch {} };
process.on('exit', stop);

/* Every observation of how many panes exist, across the whole run. N = 1 is
   not checked at two convenient moments — it is checked at all of them. */
const census = [];
const observe = async (where) => {
  const s = await surfaces();
  census.push({ where, count: s.count, pane: s.paneLabel });
  return s;
};

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/status`); break; } catch { await sleep(200); } }
  const c = await wd('POST', '/session',
    { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  session = c.sessionId ?? c.capabilities?.sessionId;
  let S = await surfaces();
  await focus(S.road);
  const status = () => script(`return window.__TAURI__.core.invoke('road_status',
    { generation: window.__ROAD_GENERATION }).then(r => r, e => ({ refused: String(e) }));`);
  for (let i = 0; i < 60; i++) {
    if ((await script("return document.body.dataset.ready === '1';")) === true) break;
    await sleep(250);
  }

  /* ── 1 ─ the catalogue, with nothing running ────────────────────────── */
  console.log('\n  \x1b[1m1 · both signs render with ZERO live panes\x1b[0m');
  const probe = await script('return window.__probe();');
  const st0 = await status();
  await observe('before any promote');
  check('the coordinator serves a catalogue of two packages',
    JSON.stringify(probe.packages) === JSON.stringify(['notes', 'digest']),
    JSON.stringify(probe.packages));
  check('every package has a sign, drawn from the manifest, with no pane in existence',
    probe.signPrimitives === 12 && probe.signSource === 'coordinator' && st0.present === false,
    `${probe.signPrimitives} primitives · present=${st0.present}`);

  /* ── 2 ─ routing by what a package DECLARES ─────────────────────────── */
  console.log('\n  \x1b[1m2 · routing reads the declaration\x1b[0m');
  const r1 = await script(`return window.__apply('route', { kind: 'document' });`);
  const r2 = await script(`return window.__apply('route', { kind: 'summary' });`);
  const r3 = await script(`return window.__apply('route', { kind: 'nonsense' });`);
  check('a document routes to the package that declares it accepts documents',
    r1.ok && r1.result.package === 'notes', JSON.stringify(r1));
  check('a summary routes to the other one', r2.ok && r2.result.package === 'digest',
    JSON.stringify(r2));
  check('a kind nothing accepts is refused BY NAME, not dropped',
    !r3.ok && /NO_ROUTE/.test(r3.why), r3.why);

  /* ── 3 ─ the first app ──────────────────────────────────────────────── */
  console.log('\n  \x1b[1m3 · the first app takes the task from the host\x1b[0m');
  const h1 = await script(`return window.__handoff('document', 'a document that entered the road');`);
  check('the road routed and promoted in one move', h1.ok === true, JSON.stringify(h1).slice(0, 200));
  S = await observe('first app live');
  const firstLabel = S.paneLabel;
  await focus(S.pane);
  for (let i = 0; i < 60; i++) {
    if ((await script("return document.body.dataset.ready === '1';")) === true) break;
    await sleep(250);
  }
  let pp = await script('return window.__paneProbe();');
  const notesState = { counter: pp.counter, note: pp.note };
  check('the pane is the routed package and was HANDED its task',
    pp.package === 'notes' && pp.task && pp.task.kind === 'document'
      && /entered the road/.test(String(pp.task.payload)), JSON.stringify(pp.task));

  /* ── 4 ─ an app's report is not a transfer ──────────────────────────── */
  console.log('\n  \x1b[1m4 · only the coordinator\'s ACCEPTANCE is a transfer\x1b[0m');
  await focus(S.road);
  const beforeOffer = await status();
  check('nothing is in the ledger before the app has offered anything',
    Array.isArray(beforeOffer.ledger) && beforeOffer.ledger.length === 0,
    JSON.stringify(beforeOffer.ledger));
  const early = await script('return window.__handoffNext();');
  check('the road has NOTHING TO ROUTE until something is accepted',
    early.ok === false && /ACCEPTED/.test(early.why), JSON.stringify(early));

  await focus(S.pane);
  await clickOn('#produce');
  await sleep(600);
  pp = await script('return window.__paneProbe();');
  check('the app offers, and what comes back is an ACCEPTANCE RECORD',
    pp.lastOffer && pp.lastOffer.ok === true && pp.lastOffer.r.accepted
      && pp.lastOffer.r.accepted.from === 'notes' && pp.lastOffer.r.accepted.seq === 1,
    JSON.stringify(pp.lastOffer).slice(0, 200));
  await focus(S.road);
  const afterOffer = await status();
  check('the coordinator\'s ledger records it, and the ledger is the record',
    afterOffer.ledger.length === 1 && afterOffer.ledger[0].kind === 'summary',
    JSON.stringify(afterOffer.ledger));

  /* ── 5 ─ eviction, and the second app ───────────────────────────────── */
  console.log('\n  \x1b[1m5 · eviction is how the second app stands\x1b[0m');
  const h2 = await script('return window.__handoffNext();');
  check('evict, route the accepted kind, promote the next package',
    h2.ok === true && h2.steps.map((x) => x.name).join(',') === 'evict,route,promote-2',
    JSON.stringify(h2.steps?.map((x) => `${x.name}:${x.ok}`) ?? h2));
  if (!h2.ok) throw new Error(`handoff refused: ${JSON.stringify(h2)}`);
  S = await observe('second app live');
  check('the second pane is a DIFFERENT INSTANCE, not the first rebound',
    S.paneLabel !== firstLabel && /^pane-\d+$/.test(String(S.paneLabel)),
    `first ${firstLabel}, second ${S.paneLabel}`);
  await focus(S.pane);
  for (let i = 0; i < 60; i++) {
    if ((await script("return document.body.dataset.ready === '1';")) === true) break;
    await sleep(250);
  }
  const pp2 = await script('return window.__paneProbe();');
  check('the second app is the routed package and received the ACCEPTED payload',
    pp2.package === 'digest' && pp2.task && pp2.task.kind === 'summary'
      && pp2.task.payload && pp2.task.payload.from === 'notes',
    JSON.stringify(pp2.task));

  /* ── 6 ─ authority does not cross the boundary ──────────────────────── */
  console.log('\n  \x1b[1m6 · a terminal package cannot hand work on\x1b[0m');
  await clickOn('#produce');
  await sleep(600);
  const pp3 = await script('return window.__paneProbe();');
  check('an app that declares no `produces` is REFUSED when it offers',
    pp3.lastOffer && pp3.lastOffer.ok === false, JSON.stringify(pp3.lastOffer).slice(0, 200));
  check('and it is the HOST that refuses, on the grant, not the page declining',
    pp3.lastOffer && /not allowed|PRINCIPAL_GRANT_NOT_HELD|OFFER_NOT_DECLARED/.test(pp3.lastOffer.why),
    pp3.lastOffer && pp3.lastOffer.why);
  await focus(S.road);
  const afterDigest = await status();
  check('nothing was added to the ledger by the refusal',
    afterDigest.ledger.length === 1, JSON.stringify(afterDigest.ledger));

  /* ── 7 ─ state across the boundary and across eviction ──────────────── */
  console.log('\n  \x1b[1m7 · each app\'s own state, across its own eviction\x1b[0m');
  await focus(S.pane);
  for (let i = 0; i < 5; i++) await clickOn('#inc');
  const digestCount = (await script('return window.__paneProbe();')).counter;
  await focus(S.road);
  await clickOn('#leave');
  await sleep(1200);
  await observe('after the second eviction');
  const back = await script(
    `return window.__apply('promote', { rect: (() => { const f = document.getElementById('readframe');
       f.classList.add('on'); const b = f.getBoundingClientRect();
       return { x: b.x, y: b.y, width: b.width, height: b.height }; })(),
       package: 'notes', task: null });`);
  check('the first app can be promoted again', back.ok === true, JSON.stringify(back).slice(0, 160));
  S = await observe('first app live again');
  await focus(S.pane);
  for (let i = 0; i < 60; i++) {
    if ((await script("return document.body.dataset.ready === '1';")) === true) break;
    await sleep(250);
  }
  const pp4 = await script('return window.__paneProbe();');
  check('it kept its OWN state across being evicted for another app',
    pp4.package === 'notes' && pp4.counter === notesState.counter && pp4.note === notesState.note,
    `expected ${JSON.stringify(notesState)}; got ${JSON.stringify({ counter: pp4.counter, note: pp4.note })}`);
  check('its storage key names are scoped to its package (not storage isolation)',
    JSON.stringify(pp4.storageKeys) === JSON.stringify(['tier1-proof.notes.counter', 'tier1-proof.notes.note']),
    JSON.stringify(pp4.storageKeys));

  await focus(S.road);
  await script("return window.__apply('demote');");
  const digestBack = await script(`return window.__apply('promote', {
    rect: (() => { const b = document.getElementById('readframe').getBoundingClientRect();
      return {x:b.x, y:b.y, width:b.width, height:b.height}; })(), package: 'digest', task: null });`);
  check('the second app can also be promoted again', digestBack.ok === true, JSON.stringify(digestBack));
  S = await observe('second app restored');
  await focus(S.pane);
  for (let i = 0; i < 60; i++) {
    if (await script("return document.body.dataset.ready === '1';")) break;
    await sleep(250);
  }
  const digestRestored = await script('return window.__paneProbe();');
  check('the second app restores the exact counter saved before eviction',
    digestRestored.package === 'digest' && digestRestored.counter === digestCount,
    `expected ${digestCount}, got ${digestRestored.counter}`);

  /* ── 8 ─ N = 1, at every observation ────────────────────────────────── */
  console.log('\n  \x1b[1m8 · one live pane, at every point in the run\x1b[0m');
  const over = census.filter((x) => x.count > 2);
  check(`never more than one pane live (${census.length} observations)`,
    over.length === 0, JSON.stringify(over));
  note(census.map((x) => `${x.where}: ${x.count - 1} pane${x.count === 2 ? '' : 's'}`).join('  ·  '));
} catch (e) {
  failed++;
  console.log(`\n  \x1b[31mFAILED\x1b[0m  the battery itself: ${e.message}`);
} finally {
  try { if (session) await fetch(`${BASE}/session/${session}`, { method: 'DELETE' }); } catch {}
  stop();
}
console.log(`\n  \x1b[1m${held} held · ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
