// Exercise the ACTUAL m2 operation seam against native Tauri commands.
// This adapter uses existing read/unread names. It proves completion, refusal
// and replay semantics, not camera placement or the finished road UI.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4501);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let session, held = 0, failed = 0;
function check(name, ok, detail) {
  ok ? held++ : failed++;
  console.log(`  ${ok ? 'held' : 'FAILED'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
}
async function wd(method, path, body) {
  const response = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const { value } = await response.json();
  if (value?.error) throw new Error(`${value.error}: ${value.message}`);
  return value;
}
const script = source => wd('POST', `/session/${session}/execute/sync`, { script: source, args: [] });
const driver = spawn('tauri-driver', ['--port', String(PORT), '--native-port',
  String(process.env.TAURI_NATIVE_PORT ?? 4502), '--native-driver',
  process.env.WEBKIT_WEBDRIVER ?? '/usr/bin/WebKitWebDriver'],
  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch {} };
process.on('exit', stop);
try {
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/status`); break; } catch { await sleep(100); }
  }
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: {
    'tauri:options': { application: `${ROOT}/target/release/tier1-proof` },
  } } });
  session = created.sessionId ?? created.capabilities?.sessionId;
  for (let i = 0; i < 60; i++) {
    if (await script("return document.body.dataset.ready === '1'")) break;
    await sleep(100);
  }
  // This module has no imports. Remove only declaration export markers for
  // WebDriver's script wrapper; execute its actual implementation unchanged.
  const source = readFileSync(`${ROOT}/../m2/ops.js`, 'utf8');
  if (/^import\s/m.test(source) || /^export\s+(?!const\b|function\b)/m.test(source))
    throw new Error('ops.js module shape changed; update the native loader');
  await script(`(() => { ${source.replace(/^export /gm, '')}
    const host = (command, op) => window.__TAURI__.core.invoke(command, {
      generation: op.generation ?? window.__ROAD_GENERATION,
      rect: (() => { const f = document.getElementById('readframe'); f.classList.add('on');
        const b = f.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; })(),
      package: 'notes', task: {kind:'document', payload:'actual road seam'},
    }).catch(error => ({ok:false, why:String(error)}));
    // Existing read semantics supersede the previous pane. Plans omit unread,
    // so replay must preserve that meaning across the native boundary too.
    register('read', {perform: async op => {
      const status = await host('road_status', op);
      if (status.ok === false) return status;
      if (status.present) {
        const left = await host('road_demote', op);
        if (left.ok === false) return left;
      }
      return host('road_promote', op);
    }});
    register('unread', {perform: op => host('road_demote', op)});
    window.__roadSeam = {apply, replay, log, plan, opCounts};
  })();`);
  const read = { op: 'read', district: 'proof', side: 1, dash: 0 };
  const run = (op, by = 'pointer') => script(`return window.__roadSeam.apply(${JSON.stringify(op)}, {by:${JSON.stringify(by)}});`);
  const status = () => script(`return window.__TAURI__.core.invoke('road_status', {generation:window.__ROAD_GENERATION});`);
  const opened = await run(read);
  check('actual road read waits for the native live pane', opened.ok && opened.result?.tier === 'live', opened);
  check('successful native completion enters the actual road log', (await script('return window.__roadSeam.log().length')) === 1);
  const closed = await run({ op: 'unread' });
  check('actual unread revokes and removes the pane', closed.ok && !(await status()).present, closed);

  const generation = await script('return window.__ROAD_GENERATION');
  const stale = { ...read, generation: generation + 999 };
  const rejected = await run(stale, 'cockpit');
  check('host refuses stale identity even under a cockpit annotation', !rejected.ok && /PRINCIPAL_STALE_GENERATION/.test(rejected.why), rejected);
  check('host refusal creates no pane', !(await status()).present);
  check('host refusal does not enter the successful road log', (await script('return window.__roadSeam.log().length')) === 2);

  check('a program can read through the same native seam', (await run(read, 'program')).ok);
  const recordedPlan = await script('return window.__roadSeam.plan();');
  check('the recorded plan contains both reads and omits unread',
    recordedPlan.length === 2 && recordedPlan.every(op => op.op === 'read'), recordedPlan);
  const replayed = await script(`return window.__roadSeam.replay(${JSON.stringify(recordedPlan)});`);
  check('the recorded native plan replays with superseding reads', replayed.ok && replayed.ran === 2, replayed);
  const live = await status();
  check('replay ends with exactly one authorized pane', live.present && live.host_state.bindings.filter(b => !b.revoked && b.surface.startsWith('pane-')).length === 1, live);
  check('replay never records itself', (await script('return window.__roadSeam.log().length')) === 3);
  const stopped = await script(`return window.__roadSeam.replay(${JSON.stringify([stale, {op:'unread'}])});`);
  check('native refusal stops replay before its destructive next step', !stopped.ok && stopped.ran === 1, stopped);
  check('the existing pane survives the refused replay', (await status()).pane_label === live.pane_label);
  await run({ op: 'unread' }, 'program');
  check('a program uses the same native seam to leave', !(await status()).present);
} catch (error) {
  check('native road seam battery completed', false, String(error));
} finally {
  try { if (session) await wd('DELETE', `/session/${session}`); } catch {}
  stop();
}
console.log(`\n${held} held · ${failed} failed`);
process.exit(failed ? 1 : 0);
