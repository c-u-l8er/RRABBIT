/* pose-screenshot — a PICTURE of the read pose, and a measurement of it.
   ────────────────────────────────────────────────────────────────────────
   §12 lists the pane's ON-SCREEN POSITION as not independently verified: the
   battery asserts the pane's SIZE (which is what bounds containment), and the
   host's own allocation reports x/y as 0,0 because a WebKitWebView has its own
   GdkWindow and its allocation is reported relative to it. So the one thing
   neither instrument can answer is *where on the road the pane actually sits*.

   This answers it from outside the process, with pixels.

   **XWAYLAND, DELIBERATELY.** This box is GNOME on Wayland and there is no
   `grim` (wlroots only); GNOME's own capture is a portal that wants a human.
   `GDK_BACKEND=x11` puts the app on XWayland where `import` can reach the
   window. The GtkOverlay layout being measured is backend-independent — it is
   the same `get-child-position` either way — but the capture path is not the
   shipping one, and saying so is part of the result.

   Usage:  node tools/pose-screenshot.mjs [out.png]                         */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = `${ROOT}/target/release/tier1-proof`;
const OUT = process.argv[2] ?? `${ROOT}/read-pose.png`;
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4471);
const NATIVE = Number(process.env.TAURI_NATIVE_PORT ?? 4472);
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
  { stdio: ['ignore', 'inherit', 'inherit'], detached: true,
    env: { ...process.env, GDK_BACKEND: 'x11' } });

let session = null;
const stop = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch {} };
process.on('exit', stop);

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/status`); break; } catch { await sleep(200); } }
  const c = await wd('POST', '/session',
    { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  session = c.sessionId ?? c.capabilities?.sessionId;
  const sc = (js) => wd('POST', `/session/${session}/execute/sync`, { script: js, args: [] });
  await sleep(2500);
  const mainHandle = await wd('GET', `/session/${session}/window`);
  const click = async (selector) => {
    const el = await wd('POST', `/session/${session}/element`, { using:'css selector', value:selector });
    await wd('POST', `/session/${session}/element/${Object.values(el)[0]}/click`, {});
  };
  const waitFor = async (script, failure) => {
    for (let i=0; i<40; i++) {
      if (await sc(script)) return;
      await sleep(100);
    }
    throw new Error(failure);
  };
  const immersive = process.env.PROOF_FULLSCREEN === '1';
  if (immersive) {
    await click('#fullscreen');
    await sleep(1800);
    if (!await sc("return window.__apply('fullscreen').then(r => r.ok && r.result.fullscreen);"))
      throw new Error('the fullscreen sign did not enter native fullscreen');
    if (!await sc("return !document.getElementById('service-panel').open && document.getElementById('road').clientHeight === innerHeight;"))
      throw new Error('the default view is not a road-only viewport');
    await click('#entrance');
    await waitFor("const c=window.__roadScene.snapshot(); return c.phase==='driving' && c.position[2]<c.entranceZ;",
      'the entrance control did not travel through the gantry');
  }

  const want = await sc("const f = document.getElementById('readframe');\n"
    + "f.classList.add('on');\n"
    + 'const r = f.getBoundingClientRect();\n'
    + 'return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };');
  const dpr = await sc('return devicePixelRatio;');
  const road = await sc('return { w: innerWidth, h: innerHeight };');

  /* THE WINDOW ID, RESOLVED BY NAME — not `-window root` and not `-window
     <title>`. Measured on this box: under GNOME/XWayland `import -window root`
     fails outright ("missing an image filename"), and the title form falls
     through to the same failure. `_NET_CLIENT_LIST` plus a `WM_NAME` match
     gives an id that works and is unambiguous. */
  const windowId = () => {
    const list = spawnSync('xprop', ['-root', '_NET_CLIENT_LIST'], { encoding: 'utf8' }).stdout || '';
    for (const id of [...list.matchAll(/0x[0-9a-f]+/g)].map((m) => m[0])) {
      const n = spawnSync('xprop', ['-id', id, 'WM_NAME'], { encoding: 'utf8' }).stdout || '';
      if (/Tier 1 proof/.test(n)) return id;
    }
    throw new Error('the harness window is not in _NET_CLIENT_LIST — is GDK_BACKEND=x11 set?');
  };
  const WIN = windowId();
  const capture = (path) => {
    const r = spawnSync('import', ['-window', WIN, path], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`import failed: ${r.stderr}`);
  };
  await sc("document.getElementById('readframe').classList.remove('on'); return true;");
  const aligned = await sc(`const a=document.getElementById('sign-notes').getBoundingClientRect();
    const r=document.getElementById('road').getBoundingClientRect();
    return a.right<r.x+r.width/2 && a.width>0 && a.height>0
      && getComputedStyle(document.getElementById('sign-digest')).visibility==='hidden';`);
  if (!aligned) throw new Error('current lane window is misplaced or another lane captures clicks');
  await sleep(150);
  capture(OUT.replace(/\.png$/, '-road.png'));

  /* THE REAL PATH — a click on the road's own control, so the sign is hidden
     by the same handler a person would trigger. Driving `apply` directly left
     the sign painted underneath and made the picture a lie about what a user
     sees. */
  const el = await wd('POST', `/session/${session}/element`,
    { using: 'css selector', value: '#sign-notes' });
  await wd('POST', `/session/${session}/element/${Object.values(el)[0]}/click`, {});
  const approach = await sc(`return window.__apply('status').then(r => ({
    phase:window.__roadScene.snapshot().phase, present:r.result?.present }));`);
  if (approach.phase !== 'approaching' || approach.present)
    throw new Error('the camera approach was not observed before native pane creation');
  await sleep(3000);

  const st = await sc(`return window.__TAURI__.core.invoke('road_status',
    { generation: window.__ROAD_GENERATION }).then(r => r, () => null);`);
  if (!st || !st.present) throw new Error('no pane is live after the click');
  const projection = await sc('return window.__roadScene.snapshot();');
  if (projection.phase !== 'reading' || !projection.readRect ||
      Math.abs(projection.readRect.x-want.x)>2 || Math.abs(projection.readRect.y-want.y)>2 ||
      Math.abs(projection.readRect.width-want.w)>2 || Math.abs(projection.readRect.height-want.h)>2)
    throw new Error('the 3D sign did not arrive at the native read rectangle');

  /* A PICTURE OF WHAT A PERSON SEES, taken first and left alone. */
  capture(OUT);

  /* THE MEASUREMENT — and a difference of two captures is NOT it. That was
     tried: clicking `#enter` also hides the sign and rewrites the status
     block, so the changed region came back 1915x1386, essentially the whole
     window. The pane has to identify ITSELF.

     So the pane paints one colour that appears nowhere else on the road, over
     its entire viewport, and the bounding box of that colour in a capture of
     the WINDOW is the pane's on-screen rectangle exactly — independent of
     what either page chose to draw, and of every other thing that changed. */
  const handles = await wd('GET', `/session/${session}/window/handles`);
  let paneHandle = null;
  for (const h of handles) {
    await wd('POST', `/session/${session}/window`, { handle: h });
    const label = await sc('const m = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata;\n'
      + 'return m && m.currentWebview && m.currentWebview.label;');
    if (/^pane-\d+$/.test(String(label))) { paneHandle = h; break; }
  }
  if (!paneHandle) throw new Error('the pane webview is not among the window handles');
  if (immersive && !await sc(`return window.__TAURI__.core.invoke('road_fullscreen',
      { generation:0, enabled:false }).then(() => false, () => true);`))
    throw new Error('an app pane changed the shell fullscreen state');
  await sc(`const d = document.createElement('div');
    d.id = '__pose_probe';
    d.style.cssText = 'position:fixed;inset:0;background:#FF00FF;z-index:2147483647';
    document.body.appendChild(d); return true;`);
  await sleep(900);
  const probe = OUT.replace(/\.png$/, '-probe.png');
  capture(probe);

  const isolate = OUT.replace(/\.png$/, '-isolated.png');
  // Remove everything except the marker BEFORE making it white. Otherwise
  // actual white road-sign lettering survives the mask and inflates the box.
  const iso = spawnSync('magick', [probe, '-fuzz', '12%', '-fill', 'black', '+opaque', '#FF00FF',
    '-fill', 'white', '-opaque', '#FF00FF', isolate], { encoding: 'utf8' });
  if (iso.status !== 0) throw new Error(`isolate failed: ${iso.stderr}`);
  const t = spawnSync('magick', [isolate, '-trim', '-format', '%wx%h%X%Y', 'info:'],
    { encoding: 'utf8' });
  const geom = (t.stdout || '').trim();
  const m = /^(\d+)x(\d+)([+-]\d+)([+-]\d+)$/.exec(geom);
  const got = m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  const expect = {
    x: Math.round(want.x * dpr), y: Math.round(want.y * dpr),
    w: Math.round(want.w * dpr), h: Math.round(want.h * dpr),
  };
  const near = (a, b, slack = 6) => Math.abs(a - b) <= slack;
  const verdict = !!got && near(got.x, expect.x) && near(got.y, expect.y)
    && near(got.w, expect.w) && near(got.h, expect.h);

  console.log(JSON.stringify({
    screenshot: OUT,
    probe_capture: probe,
    pane_label: st.pane_label,
    requested_rect_css: want,
    road_viewport_css: road,
    device_pixel_ratio: dpr,
    expected_pane_device_px: expect,
    measured_pane_device_px: got,
    raw_trim_geometry: geom,
    delta_px: got ? { x: got.x - expect.x, y: got.y - expect.y,
                      w: got.w - expect.w, h: got.h - expect.h } : null,
    verdict: verdict ? 'THE PANE IS AT THE REQUESTED RECT'
                     : 'MISMATCH — the pane is not where it was asked to be',
  }, null, 2));
  if (!verdict) process.exitCode = 1;
  if (immersive) {
    await wd('POST', `/session/${session}/window`, {handle:mainHandle});
    await click('#leave'); await sleep(400);
    await waitFor("return window.__roadScene.snapshot().phase === 'driving';", 'the camera did not return to the lane');
    await click('#services');
    await waitFor("return document.getElementById('service-panel').open;",
      'the services sign did not open diagnostics');
    await click('#close-services');
    await click('#exit'); await sleep(1800);
    const left = await sc("return Promise.all([window.__apply('fullscreen'),window.__apply('status')]).then(([f,s]) => f.ok && !f.result.fullscreen && s.ok && !s.result.present);");
    if (!left) throw new Error('the exit sign did not leave fullscreen and close the pane');
    console.log('Fullscreen sign, road-only view, entrance, pane denial, services, and exit: held');
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  try { if (session) await fetch(`${BASE}/session/${session}`, { method: 'DELETE' }); } catch {}
  stop();
}
