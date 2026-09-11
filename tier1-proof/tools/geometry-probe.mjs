/* geometry-probe — what `add_child` actually does to the parent.
   ────────────────────────────────────────────────────────────────────────
   The battery asserts nothing about geometry, and ROAD_SHELL.md §12 lists the
   on-screen read pose as NOT MEASURED. This is the measurement, kept separate
   so that a platform defect can never quietly redden the authority suite.

   MEASURED ON LINUX, 2026-09-10 (WebKitGTK, dpr 2):

     road BEFORE promote        1000 x 653
     pane  AFTER promote        1000 x 653   <- ignored the requested 520 x 260
     main  AFTER promote        1000 x   1   <- the ROAD was squashed to one pixel

   §10.6 says Tauri's Linux child webviews "are packed in a vertical GtkBox;
   their set_position/set_size methods do not position them inside the
   cockpit." That undersells it: the child takes the WHOLE window and the
   parent collapses. The road does not merely sit behind the pane — it stops
   having a surface. This is why super/cockpit's GTK-overlay workaround in
   `src/preview.rs` exists, and that workaround is deliberately NOT ported
   here, so the raw platform behaviour stays visible.

   THE macOS PREDICTION, which this same probe falsifies or confirms in one
   command: on NSView subviews the parent should stay 1000 x 653 and the child
   should be 520 x 260. Run it on a Mac. Until then §11 is a hypothesis.       */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/target/release/tier1-proof`;
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4461);
const NATIVE = Number(process.env.TAURI_NATIVE_PORT ?? 4462);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b) });
  const j = JSON.parse(await r.text());
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

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
  const handles = () => wd('GET', `/session/${session}/window/handles`);
  const focus = (h) => wd('POST', `/session/${session}/window`, { handle: h });
  const geom = () => sc('return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };');

  await sleep(2500);
  await focus((await handles())[0]);
  /* The read frame is display:none until the road enters the pose, so it must
     be made visible before it has a rect — reading it first prints 0 x 0 and
     makes the comparison below meaningless. */
  const rect = await sc("const f = document.getElementById('readframe');\n"
    + "f.classList.add('on');\n"
    + 'const r = f.getBoundingClientRect();\n'
    + 'return { x: r.x, y: r.y, w: r.width, h: r.height };');
  console.log(`\n  requested read rect   x=${rect.x} y=${rect.y} ${rect.w} x ${rect.h}`);
  console.log(`  road BEFORE promote   ${JSON.stringify(await geom())}`);

  /* Promote is started WITHOUT awaiting, and the host is polled while it
     runs — a pane that fails to reach its pose is torn down, so anything
     read after the fact reads an empty road. */
  await sc(`window.__promoting = window.__apply('promote',
    { rect: (() => { const f = document.getElementById('readframe');
                     f.classList.add('on');
                     const r = f.getBoundingClientRect();
                     return { x: r.x, y: r.y, width: r.width, height: r.height }; })() })
    .then(r => (window.__promoted = r));`);
  const readStatus = () => sc(
    `return window.__TAURI__.core.invoke('road_status',
       { generation: window.__ROAD_GENERATION }).then(r => r, e => ({ refused: String(e) }));`);
  const seenPoses = [];
  for (let i = 0; i < 60; i++) {
    const st = await readStatus();
    if (st && st.read_pose) seenPoses.push(st.read_pose);
    if (await sc('return window.__promoted !== undefined;')) break;
    await sleep(150);
  }
  const last = seenPoses[seenPoses.length - 1];
  if (last) {
    console.log(`  host: allocation      ${JSON.stringify(last.alloc)}`);
    console.log(`  host: allocated_w/h   ${JSON.stringify(last.allocated)}`);
    console.log(`  host: size_request    ${JSON.stringify(last.size_request)}`);
    console.log(`  host: realized/mapped ${last.realized}/${last.mapped}  visible ${last.visible}`);
    console.log(`  host: parent          ${JSON.stringify(last.parent)}`);
  } else {
    console.log('  host: no read_pose sample was taken');
  }
  const pr = await sc('return window.__promoted;');
  console.log(`  promote ok            ${pr && pr.ok}`);
  if (pr && pr.why) console.log(`  promote why           ${pr.why}`);
  await sleep(500);

  let verdict = 'UNKNOWN';
  for (const h of await handles()) {
    await focus(h);
    const label = await sc('const m = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata;\n'
      + 'return m && m.currentWebview && m.currentWebview.label;');
    const g = await geom();
    console.log(`  ${String(label).padEnd(5)} AFTER promote   ${JSON.stringify(g)}`);
    if (label === 'main') verdict = g.h < 40 ? 'PARENT SQUASHED (the GtkBox defect)' : 'parent intact';
  }
  console.log(`\n  verdict: ${verdict}\n`);
} catch (e) {
  console.log(`  probe failed: ${e.message}`);
} finally {
  try { if (session) await fetch(`${BASE}/session/${session}`, { method: 'DELETE' }); } catch {}
  stop();
}
