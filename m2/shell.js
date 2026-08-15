// M2 -- the flatten. (Forked from m1/shell.js, which stays frozen as evidence.)
//
// M1 put many live windows on the road. M2 is where it stops being a demo: fly
// into a sign, arrive fronto-parallel and PIXEL-EXACT, and type into it.
//
// The design rule from spec §1: 3D is for navigation, work happens
// fronto-parallel. A window you are typing into is never at an angle. So the
// flatten is not a nicety, it is the thing that makes the road usable -- and it
// is why this can work where Project Looking Glass did not.
//
// INPUT. Greenfield binds its own pointer listeners to the scene canvas and maps
// clientX/Y straight to scene coordinates -- correct for a flat desktop, wrong
// for a scene where the window is a quad in perspective. Rather than synthesise
// DOM events, we take the mapping over: raycast the sign, convert the hit UV to
// a point inside the surface's rect in the flat output, and push a ButtonEvent
// (a plain object) onto session.inputQueue -- which is exactly what Greenfield's
// own handlers do, one step further down.
//
// Greenfield's listeners are silenced with a CAPTURE-phase stopPropagation on
// window: capture at window runs before target-phase listeners on the canvas.
//
// The inherited M1 header follows, because all of it still applies.
//
// ---
//
// M0 proved the road can occlude a live Wayland surface, using Greenfield's own
// scene canvas as a CanvasTexture. That shortcut puts EVERY window on ONE
// billboard and costs a full canvas upload per frame. M1 needs one sign per
// window, so it takes the path spec §2.2 describes: share the GL context, let
// Greenfield decode, and composite here.
//
// THE THREE THINGS THAT MAKE THIS WORK, none of them obvious:
//
// 1. `canvas.getContext('webgl')` on a canvas that ALREADY has a context
//    returns that same context. So handing Greenfield three.js's canvas shares
//    the context with no patch to Greenfield at all -- provided three is on a
//    WebGL1 context, which is why we create it ourselves and pass it in.
//    ('webgl' does not return an existing 'webgl2' context; they are distinct
//    types and the request would return null.)
//
// 2. Greenfield's per-surface textures are created by
//    View.ensureRenderStatesForMatchingScenes(), which runs from
//    applyTransformations() -- NOT from Scene.render(). So Scene.render can be
//    suppressed and the textures still fill. Greenfield decodes; we composite.
//
// 3. A view only gets a renderState if its region INTERSECTS the scene region.
//    A window outside the output has no texture at all -- not a black one, none.
//    The Wayland output is the window ledger; the road is a view of it.

import * as THREE from 'three'
import { createAppLauncher, createCompositorSession, initWasm } from '@gfld/compositor'
import { createRack } from './tubes.js'
import { createDash, GEARS } from './dash.js'
import { makeYoke } from './yoke3d.js'
import { createTv } from './broadcast.js'
import {
  state,
  signs,
  titles,
  ctx,
  hooks,
  sideQueue,
  keyOf,
  ACC,
  COOL,
  BG,
  SCENE_ID,
  LEDGER_PITCH,
  LEDGER_COLS,
  windowZ,
  dashNear,
} from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'
import {
  attachTravel,
  districtPose,
  setRange,
  goDistrict,
  goWindow,
  flyToPaper,
  goTrack,
  replayTrack,
  stopReplay,
  pauseReplay,
  resumeReplay,
  stepReplay,
  stepBack,
  isReplaying,
  replayState,
  goExit,
  goDash,
  flattenTo,
  release,
  enterFull,
  exitFull,
  backTarget,
  sendMotion,
  resizeFlatBy,
  handlePoint,
  stepFlight,
  installInput,
  dropAt,
  inputGate,
} from './travel.js'
import {
  attachRrabbit,
  adoptPending,
  syncPopups,
  repaints,
  syncPlacement,
  syncHandles,
  checkPopupsMapped,
  flipWindowSide,
  nudgeWindowAlong,
  moveWindowTo,
  reorderWindowTo,
  tidyRoad,
  tidyPreview,
  requestCloseWindow,
  renameWindow,
  nameOf,
  syncTitles,
  layoutReport,
} from './rrabbit.js'
import { attachGantry, attachBack, syncGantries, gantryReport } from './gantry.js'
import { attachRamps, syncRamps, rampReport, rampMeshes } from './ramps.js'
import { attachPaper, syncPaper, paperReport, paperMeshes, placePaper, seedPapers, clearPapers, registerPaperOps, paperUnread } from './paper.js'
import { attachRead, renderRead } from './paper/read.js'
import { apply as applyOp, log as opLog, plan as opPlan, opCounts, replay as replayOps, precheck as precheckOps, register as registerOp } from './ops.js'
import { attachMap, openMap, closeMap, mapReport } from './map.js'
import {
  attachReel, openReel, closeReel, reelReport,
  attachTransport, transportStart, transportStop, transportReport,
} from './reel.js'

// THE DECODER'S OWN GEOMETRY -- the runbook's probe for a picture that does not
// line up, and the one that found section 23. A padded decode and a shifted
// visibleRect look identical on the glass and are entirely different faults, so
// this reports what the decoder says rather than what the surface says.
//
// AT MODULE SCOPE ON PURPOSE: it has to be in place before Greenfield builds a
// decoder, and `?remote=` launches during boot, so there is no later moment to
// arm it from. Cheap -- it records five numbers per frame and forwards.
export const decodeGeom = { frames: 0, last: null }
if (typeof window.VideoDecoder === 'function') {
  const RealVD = window.VideoDecoder
  const Patched = function (init) {
    return new RealVD({
      output: (f) => {
        decodeGeom.frames++
        const r = f.visibleRect
        decodeGeom.last = {
          coded: [f.codedWidth, f.codedHeight],
          visible: r ? [r.x, r.y, r.width, r.height] : null,
          format: f.format,
        }
        init.output(f)
      },
      error: init.error,
    })
  }
  Patched.isConfigSupported = RealVD.isConfigSupported.bind(RealVD)
  window.VideoDecoder = Patched
}

// state lives in world.js now; the page and the diagnostics still expect it
// to come from here.
export { state }

// The tube bridge (bridge.py). SAME-ORIGIN by default -- see world.js for why
// an absolute origin here was a bug.
const TUBE_BRIDGE = new URLSearchParams(location.search).get('bridge') ?? ''

let renderer, gl, scene, camera, session, rack, dash, tv, vaoExt

// (program, side, dash) => bool -- open one of the things in the ST&RT menu.
// Assigned in main() once the compositor session exists, which is the only
// moment a launcher can be made; null until then, and the drag handler in
// buildWorld checks rather than assumes, because buildWorld runs first.
let launchProgram = null

// The layer full screen looks at. 1 rather than 0 because 0 is where everything
// already is, and the point is to have a channel nothing else is on.
const FULL_LAYER = 1

// THE BROADCAST LEDGER. Insertion-ordered keys, because the chips on the TV are
// laid out in list order and a Set preserves that for free -- a window you added
// first stays leftmost instead of the row reshuffling every time one is removed.
//
// `onAir` is a SEPARATE field and not "the first entry". Being on the list and
// being on the screen are two different states: `--&` puts a window on both, and
// pressing its chip takes it off the screen while leaving it on the list, which
// is the whole point of the list existing.
const castList = new Set()
let onAirKey = null
// The pane on air, if it is a pane. Mutually exclusive with `onAirKey` -- one
// screen, one picture.
let onAirPaper = null

// What a chip says. The window's own name plus its ADDRESS, because a client
// names its own window and two of them often pick the same string -- `home:2` is
// the shell's name for it and the one thing the map, the keyboard and every
// report in here agree on. On a chip 104px wide the address is what makes two
// `xterm`s tell apart, so it goes first and the title fills what is left.
function labelOfKey(k) {
  const s = signs.get(k)
  if (!s) return k
  return `${s.district}:${s.milepost} ${nameOf(s)}`
}
// ------------------------------------------------------------- the programs
//
// WHAT THE ST&RT MENU CAN OPEN, and there are exactly two kinds because the
// compositor has exactly two launchers.
//
// `web` is an in-browser client out of `clients/` -- it runs in a same-origin
// iframe and needs nothing but this page. `native` is a real process on the
// machine, started by compositor-proxy (`npm run proxy`) and streamed in, and it
// needs that process to be running. The two are not interchangeable and the menu
// says which is which, because "xterm did not open" has a different answer from
// "the test pattern did not open".
//
// THE WEB LIST IS THE BUILD'S. vite.config.ts names these two as build inputs, so
// a third client added there has to be added here as well -- there is no
// directory to read at runtime, and inventing one would mean a menu offering a
// path that 404s.
const WEB_PROGRAMS = [
  { id: 'simple-shm', name: 'Simple SHM', kind: 'web', client: 'simple-shm',
    note: 'the shared-memory test pattern' },
  { id: 'menu-shm', name: 'Menu SHM', kind: 'web', client: 'menu-shm',
    note: 'test pattern with popup menus' },
]

// A MIRROR OF `proxy/applications.json`, USED ONLY WHEN THE REAL FILE CANNOT BE
// READ. The file is served by vite in dev and is not in the build output, so on
// the target this is what there is. It is a mirror and drifts, which is exactly
// why `programsFrom` is printed on the menu and reported by `__dash()`: a list
// off the file and a list off this constant look identical otherwise.
const NATIVE_MIRROR = [
  { path: '/text-editor', name: 'Text Editor' },
  { path: '/xterm', name: 'XTerm' },
  { path: '/firefox', name: 'Firefox' },
  { path: '/glxgears', name: 'glxgears' },
  { path: '/busy-xterm', name: 'XTerm (busy)' },
]

const PROXY_BASE = new URLSearchParams(location.search).get('proxy') ?? 'http://127.0.0.1:8912'

// THE PROXY TELLS US TO CONNECT SOMEWHERE IT CANNOT KNOW, AND WE CAN.
//
// compositor-proxy is started with ONE `--base-url`, and it builds the URL for
// each application's protocol channel from it (`NativeAppContext.js`, the
// `data.url` of the channel signalling message). There is no request in scope
// there, so unlike the HTTP replies it cannot answer with the host the client
// actually used -- it can only repeat the flag.
//
// For a T&R guest reaching the host's proxy at `10.0.2.2:8912` that flag says
// `127.0.0.1:8912`, which inside the guest is the GUEST. Measured: the signalling
// socket connected (`appStates: open`), the protocol channel never did, and the
// only trace was an unhandled `Failed to connect to application.` with
// `views: []`. Nothing else in the shell can tell that apart from "the frames
// never decoded" -- which is where two turns went.
//
// So correct it here, where the answer is known: we reached the proxy at
// PROXY_BASE, so that is its address FOR US, whatever it believes. Scoped to the
// proxy's own two endpoints, and a no-op when the hosts already agree -- vite's
// HMR socket shares this global and must not be touched.
//
// This is the WebSocket half. The HTTP half (`baseURL`, used for clipboard and
// file transfer) is fixed on the server, where a request IS in scope --
// `publicBaseURL` in patches/proxy-cli-multi-origin.md. Two transports, two
// places; neither one covers the other.
{
  const proxyHost = new URL(PROXY_BASE).host
  const Real = window.WebSocket
  window.WebSocket = function (url, protocols) {
    try {
      const u = new URL(String(url), location.href)
      if ((u.protocol === 'ws:' || u.protocol === 'wss:')
          && (u.pathname === '/channel' || u.pathname === '/signal')
          && u.host !== proxyHost) {
        u.host = proxyHost
        url = u.href
      }
    } catch {
      // Not a URL we can reason about -- hand it over untouched.
    }
    return protocols === undefined ? new Real(url) : new Real(url, protocols)
  }
  window.WebSocket.prototype = Real.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Real[k]
}

// The native half of the menu, and where it came from. Filled by `loadPrograms`
// below; until then the menu shows the web clients alone rather than a guess.
let nativePrograms = []
let programsFrom = 'web clients'
// null = NOT ASKED YET, and it is a third state on purpose. "The proxy is down"
// is a claim, and a menu that made it before anything had been sent would be
// making it up -- so an unprobed native row says `proxy not checked yet` and
// still launches, which is the honest order: try, then report.
let proxyUp = null

async function loadPrograms() {
  try {
    // Relative to /m2/, so this is `/proxy/applications.json` -- the actual file
    // the proxy is started with, served by vite in dev. A 404 in a build is
    // expected and is not an error; it is the mirror's whole reason to exist.
    const res = await fetch('../proxy/applications.json', { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const apps = await res.json()
    nativePrograms = Object.entries(apps).map(([path, a]) => ({
      path, name: a?.name || path.replace(/^\//, ''),
    }))
    programsFrom = 'applications.json'
  } catch {
    nativePrograms = NATIVE_MIRROR
    programsFrom = 'built-in list'
  }
}

// THERE IS NO PROBE. This function used to exist and it was worse than nothing:
// it reported every healthy proxy as dead, so every native program in the ST&RT
// menu -- including the T&R guest apps -- was drawn refused, with a message
// telling you to start something that was already running. Three ways were
// tried, and this page cannot ask the question:
//
//   OPTIONS + cors   The proxy answers `Access-Control-Allow-Methods: GET` and
//                    nothing else. OPTIONS is not a simple method, so an OPTIONS
//                    *fetch* is itself preflighted with an OPTIONS -- which the
//                    allow-list does not contain, so the preflight is refused.
//                    (`curl -X OPTIONS` returns 204 with correct CORS headers,
//                    which is what made this look like a proxy fault.)
//   GET + cors       `/` answers 403 with NO `Access-Control-Allow-Origin`
//                    header at all, so the CORS check rejects a reply the server
//                    plainly sent.
//   GET + no-cors    Blocked by COEP. vite.config.ts serves this page
//                    `Cross-Origin-Embedder-Policy: require-corp` because
//                    Greenfield needs SharedArrayBuffer, and under that every
//                    cross-origin subresource must opt in with CORP. The proxy
//                    sends none.
//   WebSocket        The proxy ends any upgrade without a `compositorSessionId`,
//                    which is indistinguishable from connection-refused.
//
// So the menu STOPS GUESSING. `proxyUp` stays null until something real happens:
// native rows are offered, and the first launch that actually fails records why
// and refuses the rest. That is the same order the rest of this shell keeps --
// try, then report what happened -- instead of a claim made before anything was
// sent.
let proxyWhy = 'compositor-proxy is not answering — npm run proxy'

// The list as the dashboard needs to draw it, derived every call from the two
// halves above -- one source, so a row cannot describe a program the launcher
// would not start.
// WHAT A WINDOW COSTS, said where the window is opened.
//
// MEASURED, not guessed: eight simple-shm windows open at once put one Chrome
// renderer at 776% CPU on a 24-core machine -- almost exactly one core each,
// held for as long as the window is open. These clients paint every frame in
// software forever; that is what they are for, and it was affordable while the
// only way to open one was to drive to the gate and press a panel.
//
// The ST&RT menu made it one click, and a menu that will happily open twenty of
// them while saying nothing is the shell hiding a cost it can measure. So the
// count goes on the menu, and past half the machine's cores the footer says what
// is happening. It does NOT refuse -- how many windows you want is your call,
// and a shell that capped it would be answering a question nobody asked. This is
// invariant 1's habit applied to a resource rather than to a gauge: name what is
// over the line, and why.
const windowBudget = () => Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2))

function programList() {
  const web = WEB_PROGRAMS.map((p) => ({ ...p, ok: true }))
  const native = nativePrograms.map((p) => ({
    id: 'native' + p.path,
    name: p.name,
    kind: 'native',
    path: p.path,
    note: proxyUp === true ? 'through the proxy' : 'needs compositor-proxy',
    ok: proxyUp !== false,
    why: proxyWhy,
  }))
  const open = signs.size
  const budget = windowBudget()
  return {
    list: [...web, ...native],
    from: programsFrom,
    open,
    // `null` when there is nothing to say. A footer that carries a warning slot
    // even when nothing is wrong is furniture, and the one thing this shell will
    // not do is print a line that is always there and therefore never read.
    // The COUNT is already in the header, in the same warn colour, so this line
    // is only the reason. Repeating the number here overran the plate.
    cost: open >= budget ? 'each web client holds a core for as long as it is open' : null,
  }
}

const DRIVE_POSE = { pos: new THREE.Vector3(0, 105, 260), look: new THREE.Vector3(0, 105, -640) }

// workspace id -> { road }. A Map rather than an array because the roads
// are no longer a fixed list laid down once at startup: workspaces are added,
// closed and re-opened while the shell runs, and `syncRoads` reconciles the
// scene with the graph every time that happens.
const roads = new Map()
let lastRoadCount = -1
const forgetStatus = () => {
  lastRoadCount = -1
}

// THE CONTEXT CAN BE TAKEN AWAY WHILE YOU ARE USING IT, AND THAT IS NOT SURVIVABLE
// HERE. This is the one line that has to be believed.
//
// `whyNoContext` already covers the context you never got. This is the other one:
// the GPU process dies mid-session, the browser fires `webglcontextlost`, and every
// GL object made before that moment belongs to a context that no longer exists.
//
// three HANDLES THIS AND THAT IS WHAT MAKES IT WORSE. WebGLRenderer calls
// preventDefault on the loss, which asks the browser for a fresh context, and then
// rebuilds its own objects on it -- so three comes back. Greenfield does not. Its
// compositor holds its own programs and textures on that same canvas (Program.js,
// Texture.js, SceneShader.js) and has no restore path, so the frame after "Context
// Restored" is a frame where half the scene is talking to a context it was not born
// in. Reported, and the log is unmistakable:
//
//     WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost
//     THREE.WebGLRenderer: Context Lost.  /  Context Restored.
//     WebGL: INVALID_OPERATION: bindTexture: object does not belong to this context   (x150)
//     WebGL: INVALID_OPERATION: texSubImage2D: no texture bound to target             (x100)
//     Program.js BUG? use gl program failed.                                          (x40)
//     WebGL: too many errors, no more errors will be reported for this context
//
// That storm is not the damage report, it IS the damage: several hundred failing GL
// calls per frame, forever, on a tab that now looks frozen and is busier than it has
// ever been. The old behaviour was to keep running into it.
//
// SO THE SHELL STOPS. The loop is halted at the top of the next frame, the polls are
// cancelled, and the status line says what happened and what to do about it. A
// reload rebuilds everything -- clients included, since none of them survive a
// reload anyway -- so "reload" is the honest instruction rather than a shrug.
//
// NOT A `preventDefault` OF OUR OWN, either way: three has already asked for the
// restore by the time this runs, and whether the browser grants it changes nothing
// here. What matters is that we stop drawing.
let contextLost = false
let sayLine = () => {}
const timers = []

// WHAT WENT WRONG, FOR A BROWSER THAT CANNOT BE ASKED. The shell's one target is
// a kiosk Firefox with no devtools and no address bar, so a console error there
// is a thing that happened to nobody. Kept small and BOUNDED: the tube poll used
// to emit hundreds of identical failures (see the note above pollTubes), and an
// unbounded buffer would make the report the same drowning-in-instrumentation
// problem in a different place. First 20 -- first, not last, because the error
// that explains a failure is almost always the first one.
const errorLog = []
const noteError = (kind, text) => {
  if (errorLog.length >= 20) return
  errorLog.push(`${kind}: ${String(text).slice(0, 200)}`)
}
{
  const realError = console.error.bind(console)
  console.error = (...a) => {
    noteError('console', a.map((x) => (x && x.stack ? x.stack : x)).join(' '))
    realError(...a)
  }
  window.addEventListener('error', (e) => noteError('window', e.message || e.error))
  window.addEventListener('unhandledrejection', (e) => noteError('rejection', e.reason))
}
// One per launch that has not yet produced a window. `setTimeout`, so they are
// kept apart from `timers` (cleared with `clearInterval`) for the same reason
// the pacer's deferral is -- and cleared on a lost context, because a shell that
// has stopped drawing has no business announcing that a window did not appear.
// Cancel FUNCTIONS, not timer ids -- a watchdog re-arms itself once a second
// while it waits, so any id captured here would be stale a second later.
const launchWatchdogs = []
function clearWatchdogs() {
  for (const cancel of launchWatchdogs) cancel()
  launchWatchdogs.length = 0
}
function loseContext(reason) {
  if (contextLost) return
  contextLost = true
  state.contextLost = reason
  for (const t of timers) clearInterval(t)
  timers.length = 0
  clearWatchdogs()
  // The tube poll schedules itself now, so it is not in that list. Left running
  // it is the thing this function's own note calls the loudest part of a broken
  // tab: a fetch every few seconds, forever, drawing a rack nobody can see.
  if (tubeTimer) clearTimeout(tubeTimer)
  tubeTimer = 0
  // The pacer's deferral is a setTimeout rather than an interval, so it is not in
  // that list -- and it holds a reference to the ORIGINAL renderer.render, which
  // would run one more full cycle after the stub below had replaced the wrapper.
  if (pacing.timer) clearTimeout(pacing.timer)
  pacing.timer = 0
  pacing.fire = null
  // AND THE COMPOSITOR'S LOOP, WHICH IS NOT OURS TO SCHEDULE.
  //
  // Stopping the frame loop stopped OUR drawing and the storm carried on anyway --
  // reported, with the stack that names the owner:
  //
  //     use @ SceneShader.js -> render @ Scene.js -> render @ Renderer.js
  //       -> onCommit @ XdgToplevel.js -> commit @ Surface.js -> messagePort.onmessage
  //
  // Greenfield renders on COMMIT. Every frame a client draws arrives over the
  // Wayland message port and turns straight into a draw call, so its loop is driven
  // by five programs that know nothing about a lost context and will go on
  // committing forever. Nothing on our side can pace that; the only thing that can
  // is making the render a no-op.
  //
  // Both levels, because either one alone leaves a path open: `renderer.render` is
  // what the commit calls, and a scene's own `render` is what the renderer walks to.
  // The shell already stubs the latter for its own scene at startup (see initScene)
  // for a different reason -- to stop Greenfield compositing over the road -- which
  // is proof the seam is a supported one to cut.
  try {
    if (session?.renderer) {
      session.renderer.render = () => {}
      for (const s of Object.values(session.renderer.scenes ?? {})) s.render = () => {}
    }
  } catch {
    // A compositor that cannot be quietened is still better stopped than not: the
    // frame loop is already halted and the message below still goes up.
  }
  sayLine(`the GPU dropped this page (${reason}) -- reload to come back. Your roads and windows are saved.`)
  console.error(`[rrabbit] ${reason}: halting the frame loop. Reload the page.`)
  offerReload(reason)
}

// TELLING SOMEBODY TO RELOAD IS NOT THE SAME AS LETTING THEM.
//
// This has now been reported three times, and every time the shell had already
// worked out exactly what happened and then done nothing about it: the status
// line says "reload to come back", `#status` is `pointer-events: none`, and the
// only other notice is a console message you have to have had open. The page sits
// there looking frozen. Whatever is dropping the context, THAT part is ours.
//
// A button, not an automatic reload. A GPU that has just reset may be about to do
// it again, and a page that reloads itself on context loss can spin -- so the
// recovery is one click and the choice stays with the person watching. It is
// wired to `location.reload()` because a reload genuinely is the whole fix: the
// clients do not survive one anyway, and the roads, workspaces and window names
// are persisted (which is what the line above is claiming when it says they are
// saved).
function offerReload(reason) {
  const status = document.getElementById('status')
  if (!status || document.getElementById('reload-btn')) return
  // Same reason as `say`: an offer to reload inside a hidden panel is not an
  // offer. This is the one path where the shell is already broken, so it is the
  // worst one to have swallowed.
  status.hidden = false
  // The strip is deliberately unclickable so it can never eat a press meant for
  // the road (see index.html). That rule is right and it is suspended for exactly
  // this: there is no road left to press.
  status.style.pointerEvents = 'auto'
  const btn = document.createElement('button')
  btn.id = 'reload-btn'
  btn.textContent = 'reload the shell'
  btn.style.cssText = 'display:block;margin-top:8px;cursor:pointer;font:inherit;'
    + 'background:#f2c14e;color:#03040a;border:0;padding:6px 12px;font-weight:700;'
  btn.addEventListener('click', () => location.reload())
  status.appendChild(btn)
  // Recorded so a report can say whether the offer was ever made -- "the button
  // did not appear" and "the loss was never detected" look identical otherwise.
  state.reloadOffered = { reason, at: Date.now() }
}

// ---------------------------------------------------------------- the world

// Only ever called once the request has ALREADY failed, so it is free to be
// destructive: claiming a 2d context on a canvas that could not give us a WebGL
// one costs nothing, and a throwaway canvas is thrown away.
//
// The three answers, in the order that tells them apart:
//
//   1. The canvas is already a WebGL2 canvas. `getContext('webgl')` does not
//      return an existing 'webgl2' context -- they are distinct types -- which
//      is the same mismatch the header warns about for Greenfield, arriving from
//      the other direction.
//   2. A FRESH canvas can still get a context, so WebGL works on this machine
//      and it is this page that cannot have one. In practice that means the
//      browser's live-context limit, which a shell reloaded all afternoon while
//      its Greenfield sessions outlive the page will reach. Closing the tab and
//      opening it again is the fix, and now it says so.
//   3. Neither can. There is no WebGL here at all -- a disabled or blocklisted
//      GPU, or the software path refusing. This is the one that is not our
//      problem to retry, and it is the answer the T&R image has always been at
//      risk of giving (spec: WebGL over Xorg scfb with no DRM is a hypothesis).
function whyNoContext(canvas) {
  const already2 = (() => {
    try {
      return !!canvas.getContext('webgl2')
    } catch {
      return false
    }
  })()
  if (already2) {
    return 'WebGL1 refused because this canvas already holds a WebGL2 context. The shell must own a WebGL1 context (see the header) -- something else called getContext on #gl first.'
  }
  const freshWorks = (() => {
    try {
      return !!document.createElement('canvas').getContext('webgl')
    } catch {
      return false
    }
  })()
  if (freshWorks) {
    return 'WebGL works here but this page could not get a context -- almost always the browser\'s live-context limit, reached by reloading the shell while old sessions still hold theirs. Close the tab and open it again.'
  }
  // THIS BRANCH USED TO BLAME THE MACHINE, AND IT WAS WRONG TO.
  //
  // "fresh canvases are refused too" was taken to mean WebGL is unavailable
  // here, which sends you to hardware acceleration and to Xorg scfb -- a long
  // way from the actual cause. But the context pool is shared across every tab
  // in the process, and when it is EXHAUSTED rather than merely full for this
  // page, a fresh canvas is refused as well. That is a recoverable state that
  // looks identical to a broken driver.
  //
  // Diagnosed the hard way on 2026-08-12: the cockpit's yoke took a second
  // context per load and was not in the pagehide reaper the road's context has
  // been in for months, so every reload leaked one until the pool was gone --
  // and this message said the browser could not do WebGL, on a browser that had
  // been doing it all afternoon.
  return 'No WebGL context could be had -- fresh canvases are refused too. That is EITHER the browser/machine (check hardware acceleration, and on the T&R image whether the software path survives Xorg scfb) OR the shared context pool being exhausted across tabs. Try that first, it is the cheaper one: close other WebGL tabs (RAVIO holds two of its own), then reload. `?yoke=0` boots this shell on one context instead of two.'
}

function buildWorld(canvas) {
  // Create the context OURSELVES, as WebGL1, so that Greenfield's later
  // getContext('webgl') returns this very object. If three were left to make a
  // WebGL2 context, Greenfield's request would return null and initScene would
  // throw "This browser doesn't support WebGL!" -- which reads as a browser
  // problem and is in fact a context-type mismatch.
  gl = canvas.getContext('webgl', {
    alpha: false,
    depth: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  // A NULL CONTEXT IS THREE DIFFERENT FAULTS AND THEY NEED DIFFERENT ANSWERS.
  //
  // Reported as `TypeError: Cannot read properties of null (reading
  // 'getExtension')` -- the first line that happened to touch `gl` after the
  // request quietly returned null, which names neither the request nor the
  // reason. Every one of these is recoverable and none of them is a bug in this
  // file, so the shell has to say which one it is.
  if (!gl) throw new Error(whyNoContext(canvas))
  // Bound BEFORE three's own listener, so this runs first and the loop is already
  // stopping by the time three starts asking for a replacement context.
  canvas.addEventListener('webglcontextlost', () => loseContext('WebGL context lost'))
  // And if the browser DOES hand one back, stay stopped: three would be whole and
  // the compositor would not, which is the state that produced the error storm.
  canvas.addEventListener('webglcontextrestored', () => {
    console.error('[rrabbit] context restored, but the compositor cannot be. Reload.')
    // The browser handing the context back is the clearest possible moment to
    // offer the way out, and until now it was the moment the shell said the least.
    // Idempotent -- `loseContext` has almost certainly already put the button up.
    offerReload('context restored without a compositor')
  })
  renderer = new THREE.WebGLRenderer({ canvas, context: gl })
  renderer.setPixelRatio(1)

  // THE FOURTH THING THAT MAKES THIS WORK, and the one that took a torn frame
  // to find. See leaveNeutralVertexState() at the end of the frame.
  vaoExt = gl.getExtension('OES_vertex_array_object')

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.Fog(BG, 1400, 4200)

  camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 6000)
  camera.position.set(0, 105, 260)

  scene.add(new THREE.AmbientLight(0xffffff, 1.2))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(-200, 400, 300)
  scene.add(key)

  syncRoads()

  // The camera is still in the scene graph, and that is no longer about the
  // tubes: the resize handle and the popup quads are parented to it too.
  scene.add(camera)

  // THE RACK IS A MODEL NOW, AND THE COCKPIT DRAWS IT.
  //
  // It used to be seven THREE cylinders in a Group parented to the camera --
  // an instrument hanging in mid-air, taking fog and perspective from a scene
  // it was not part of, with its readouts on 256px CanvasTextures. RAVIO does
  // not do that: RAVIO has a dashboard at the bottom of the frame and the tubes
  // are seated in it. So does this now. `createRack()` keeps `apply` and
  // `overRedline` unchanged -- renderWhy() below never knew about the geometry
  // and still does not.
  rack = createRack()
  tv = createTv(camera)
  dash = createDash({
    canvas: document.getElementById('dashcv'),
    yokeCanvas: document.getElementById('yokecv'),
    makeYoke,
    rack,
    state,
    camera,
    // WHICH GEARS HAVE NOTHING BEHIND THEM YET. P, R and C are drawn in the gate
    // and REFUSE to engage, because a stick that moves into PARK while the road
    // is still running underneath reports a state the viewer cannot read off
    // anything in front of them. The list shrinks as the scenes get built; it is
    // not a placeholder for "coming soon", it is the shell declining to claim
    // something it cannot do.
    // R COMES OFF THE LIST: the reel exists now. P and C do not, and the gate
    // still refuses them for the reason `setGear` gives -- a stick reporting a
    // scene that is not behind it is unreadable from the cockpit.
    unbuilt: ['P', 'C'],
    // What the TV shows. Passed in as a callback rather than imported inside
    // dash.js, for the same reason the map's actions are: shell.js is the only
    // module allowed to know about Travel, RRABBIT and the compositor at once.
    card: (gear) => {
      const g = GEARS.find((x) => x.id === gear) || GEARS[GEARS.length - 1]
      const here = [...signs.values()].filter((s) => s.district === state.district).length
      // THE THIRD PLACE THAT KNEW R WAS UNBUILT, and the one that got missed.
      // `unbuilt` opened the gate and the mirror caption was rewritten, but this
      // branch is `gear !== 'D'` -- so the reel opened over a TV still reporting
      // "not built · no scene behind this gear yet" about the scene in front of
      // it. Caught from a screenshot of the guest, which is the only place all
      // three surfaces are visible at once.
      if (gear === 'R') {
        const n = tracks.list().length
        const t = tracks.active()
        const r = t ? tracks.recordingOf(t.id) : null
        return {
          head: 'R · REEL', sub: 'THE TRACKS',
          big: `${n} track${n === 1 ? '' : 's'}`,
          // The same two numbers the reel's own columns carry, for the same
          // reason -- the trail is walkable and the recording is what happened,
          // and seeing them differ is the point.
          line: t
            ? `on ${tracks.labelOf(t)}  ·  ${t.history.length} on the trail  ·  ${r?.steps.length ?? 0} recorded`
            : 'no track selected',
          foot: 'a number drives one  ·  Esc for D',
          footWarn: false,
        }
      }
      if (gear !== 'D') {
        return { head: g.id + ' · ' + g.name, sub: g.sub.toUpperCase(),
                 big: 'not built', line: 'no scene behind this gear yet',
                 foot: 'the shifter is beside the wheel · Esc for D', footWarn: true }
      }
      return {
        head: 'T&R · Travel & RRABBIT',
        sub: state.mode === 'flat' ? 'STANDING IN A WINDOW'
           : state.mode === 'flying' ? 'IN FLIGHT' : 'ON THE ROAD',
        big: ws.get(state.district)?.name || state.district,
        line: `${here} window${here === 1 ? '' : 's'} here  ·  ${signs.size} open  ·  `
            + (state.tubeError ? 'bridge unreachable' : (state.tubeReader || 'bridge waiting')),
        // The letters are advertised beside G because a direct key nobody is
        // told about is a direct key nobody presses.
        foot: 'G · next gear   R · the reel   0 · the map',
        footWarn: !!state.tubeError,
      }
    },
    // The housings are drawn; the GLASS is empty and says which nothing it is.
    // A dark housing with no caption is indistinguishable from a rendering fault.
    //
    // THE RIGHT CAPTION MOVED WHEN THE REEL LANDED. It used to say both C and R
    // were unbuilt, and leaving it would have been the same fault the caption
    // exists to prevent -- a viewer reading "R · REEL is not built" off a
    // cockpit whose gate will happily shift into R.
    mirrors: () => ({
      mirrorLive: { left: false, right: false },
      mirrorTag: { left: 'BEHIND', right: 'AHEAD' },
      mirrorEmpty: {
        left: ['NO REAR VIEW', 'the road behind is not rendered yet'],
        right: ['NO REEL IN THE GLASS', 'shift to R for the reel · C · CAMERA is not built'],
      },
    }),
    // AND HERE IS WHERE IT GOT WIRED. The note this replaces said changing gear
    // becomes Travel's business "the moment there is a scene to change to" --
    // the reel is that scene, so R now opens it and every other detent closes
    // it. One gear variable, still, and the scene follows it rather than
    // tracking it.
    onGear: (id) => {
      state.gear = id
      // And the same exclusion from the other side: shifting into R over an
      // open map has to put the map away, or the reel covers a scene that still
      // believes it is showing and still holds `selected`.
      if (id === 'R') {
        closeMap()
        openReel()
      } else closeReel()
    },
    // The list, as the TV needs to draw it. Derived from the ledger every call
    // rather than kept in a second array -- one source, so a chip cannot label
    // itself after a window that has closed.
    cast: () => ({
      // A PANE COUNTS AS ON AIR. The dashboard reserves the TV's rect from this
      // flag, so a report that only knew about windows meant `cast` on a pane
      // returned ok, pinned the pane's tier, set the picture -- and the screen was
      // never given a rect to appear in. The op reported success at every step and
      // nothing showed, which is the shape of failure that takes longest to find.
      onAir: (!!onAirKey && signs.has(onAirKey)) || !!onAirPaper,
      onAirKey: onAirKey && signs.has(onAirKey) ? onAirKey : (onAirPaper?.key ?? null),
      title: onAirPaper ? (onAirPaper.card?.title ?? 'document') : (onAirKey ? labelOfKey(onAirKey) : null),
      list: [...castList].filter((k) => signs.has(k)).map((k) => ({
        key: k,
        label: labelOfKey(k),
        live: k === onAirKey,
      })),
    }),
    // What the ST&RT menu offers. Same shape and same reason as `cast`: read at
    // paint time and at hit time from one function, so the row you press is the
    // program that opens.
    programs: programList,
    // RAVIO's pill says which lane is on and what milepost you are at. The same
    // question asked of the grid this fork actually has: which workspace, and
    // which DASH you are standing at.
    // THE PILL IS OFF. It said which road you were on and which dash you were
    // near -- and the TV two feet below it already says the road, in larger
    // type, beside the window count. So it was a second answer to a question
    // already answered, sitting in the middle of the windscreen.
    //
    // `pillPlate` returns on null, so this costs nothing and is one line to put
    // back if the milepost turns out to be worth its glass.
    pill: () => null,
  })

  // Hand the stage to both personalities. `session` is still null here -- it is
  // created later in main() -- so this runs again once it exists. attach() is
  // deliberately re-callable rather than one-shot: the alternative is reading
  // through ctx on every access, which would have meant editing every line
  // moved into travel.js and rrabbit.js, and the point of the split was to move
  // that code without touching it.
  Object.assign(ctx, { renderer, gl, scene, camera, session })
  attachTravel(ctx)
  attachRrabbit(ctx)
  attachGantry(ctx)
  attachRamps(ctx)
  attachPaper(ctx)
  attachRead(ctx)
  registerPaperOps()
  // THE DRAFT'S OWN VERBS THROUGH THE SAME DOOR. `drive` and `park` are two of the
  // sixteen in OP_VOCABULARY_DRAFT.md §3 and they are wired here rather than left
  // to the pane ops alone, because §9's test is about whether ONE seam serves
  // unrelated consumers. Two nav ops and two pane ops sharing `apply` is the
  // evidence; one op proving it about itself would not be.
  //
  // These do not replace travel.js's own callers. Nothing in the shell was
  // rerouted -- the seam calls the same `goDistrict` a gate does, so the op path
  // is additive and cannot destabilise driving.
  registerOp('drive', {
    pre: (op) => (ws.has(op.road) ? true : 'OP_NO_ROAD'),
    perform: (op) => { goDistrict(op.road, { atHead: true }) },
  })
  registerOp('park', {
    pre: (op) => {
      if (!ws.has(op.road)) return 'OP_NO_ROAD'
      return Number.isFinite(op.z) ? true : 'OP_BAD_Z'
    },
    perform: (op) => { goDistrict(op.road, { at: op.z }) },
  })
  // Escape inside a read pane leaves it, and does so THROUGH THE SEAM -- read.js
  // raises the intent and paper.js turns it into an op, so there is no path into
  // or out of a pane that the log does not see.
  hooks.paperUnread = paperUnread
  hooks.flyToPaper = flyToPaper
  attachBack(backTarget)
  syncGantries()
  syncRamps()
  syncPaper()
  // `?papers=seed` puts the bundled sample documents on the road you start on.
  // A URL PARAM AND NOT A STARTUP DEFAULT, the same shape `?layout=reset` and
  // `?tracks=` already use: a shell that invents road furniture on every boot is a
  // shell you cannot take a clean reading from, and the guest has no console to
  // undo it from. Reported to `state.paperSeed` so the report can say whether the
  // seed ran at all -- "no panes" and "the seed never fired" look identical
  // otherwise, which is exactly the confusion that costs a deploy cycle.
  const paperArg = new URLSearchParams(location.search).get('papers')
  if (paperArg === 'seed') {
    seedPapers().then((r) => { state.paperSeed = r }, (e) => { state.paperSeed = { error: String(e?.message ?? e) } })
  } else if (paperArg === 'chrome') {
    setTimeout(() => {
      import('./paper/bench.js').then((m) => m.runChromeDemo())
        .catch((e) => { state.paperBench = { error: String(e?.message ?? e) } })
    }, 2500)
  } else if (paperArg === 'read') {
    setTimeout(() => {
      import('./paper/bench.js')
        .then((m) => m.runReadDemo())
        .catch((e) => { state.paperBench = { error: String(e?.message ?? e) } })
    }, 2500)
  } else if (paperArg === 'store') {
    // Rung 5's instrument: ten thousand documents in a real IndexedDB store, of
    // which one road's worth is streamed in.
    setTimeout(() => {
      import('./paper/bench.js')
        .then((m) => m.runStoreBench())
        .catch((e) => { state.paperBench = { error: String(e?.message ?? e) } })
    }, 2500)
  } else if (paperArg === 'bench') {
    // Rung 4's instrument. Deferred a beat so the first frames -- shader compiles,
    // the road's own first draw -- are not folded into the N=0 baseline, which is
    // the number every other row is measured against.
    setTimeout(() => {
      import('./paper/bench.js')
        .then((m) => m.runBench())
        .catch((e) => { state.paperBench = { error: String(e?.message ?? e) } })
    }, 2500)
  }
  // The map navigates through Travel rather than doing it itself, the same
  // division the gates keep.
  // IF YOU MOVE THE WINDOW YOU ARE STANDING IN, YOU GO WITH IT.
  //
  // The map is open over a flattened window now, so "cross to the other side" is
  // something you can ask for from inside the very window it moves -- and the
  // camera is parked pixel-exact against a surface that then slides 660 units
  // sideways. Measured that way once: the window crossed the road and the view
  // stayed pointed at the empty air it had left.
  //
  // TWO FRAMES LATER, not immediately. A move changes three fields on a record
  // and syncPlacement puts the mesh right on the NEXT frame (that is the whole
  // mechanism -- see rrabbit.js), while flattenTo reads the mesh's position to
  // work out where to stand. Re-seating in the same tick would fly the camera to
  // where the window still was.
  const follow = (move) => (district, milepost, arg) => {
    const wasIn = state.mode === 'flat' && state.flatDistrict === district && state.flatMilepost === milepost
    // AND WHEN YOU ARE DRIVING THE ROAD IT IS ON. Standing in it is the obvious
    // case and it was the only one handled; out on the road a window you moved
    // slid 660 units up the tarmac while the camera stayed where it was, which
    // is the same complaint from one step further back. Only the road you are
    // actually on -- rearranging a road you are not looking at should not drive
    // you to it.
    const wasNear = !wasIn && state.mode !== 'flat' && state.district === district
    const out = move(district, milepost, arg)
    if (!out) return out
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (wasIn) flattenTo(out.milepost, out.district)
        else if (wasNear) goWindow(out.district, out.milepost)
      }),
    )
    return out
  }

  // Travel flies, RRABBIT moves the windows, and the map does neither -- it only
  // says what was asked for. Both halves of that are wired here for the same
  // reason: shell.js is the one module that is allowed to know about all three.
  attachMap({
    // RELEASE FIRST. Both of these fly the camera somewhere, and the map can now
    // be open while you are standing IN a window -- so "drive to it" from in
    // there has to let go of the one you are in, or you end up driving with the
    // shell still believing it is flattened against a window behind you.
    window: (d, m) => {
      release()
      return goWindow(d, m)
    },
    // INTO the window, not onto the road outside it -- the dash page's "open its
    // page" button, which is the only control in the map that names the window's own
    // surface rather than its place on the road. Release first for the same reason
    // `window` does: the map can be open while you are standing in a DIFFERENT
    // window, and flattening from inside one has to let go of that one first, or the
    // shell flies away still believing it is pressed against a surface behind it.
    enter: (d, m) => {
      release()
      return flattenTo(m, d)
    },
    district: (id) => {
      release()
      return goDistrict(id)
    },
    // Walking the graph by clicking the lit neighbours. Travel's own goExit lets
    // go of the window first, because the map can be open from inside one.
    exit: goExit,
    // And standing in front of one dash, which is the same division: the map says
    // which marker, Travel does the driving.
    dash: goDash,
    move: {
      side: follow(flipWindowSide),
      along: follow(nudgeWindowAlong),
      to: follow(moveWindowTo),
      onto: follow(reorderWindowTo),
      tidy: tidyRoad,
      preview: tidyPreview,
    },
    close: requestCloseWindow,
    rename: renameWindow,
    // Clicking a chip is pressing its number, so it goes through the same
    // function the keyboard does rather than a second path that could disagree.
    track: goTrack,
  })
  // The reel needs exactly one verb and it is the same one: which track, never
  // how to get there. Driving stays in travel.js.
  //
  // `leave` is the second half of the gear wiring and it has to exist: the reel
  // closes itself on Esc and on a number being pressed, and without a way to say
  // so the stick would sit in R with no reel in front of it -- the unreadable
  // cockpit state the gate's own refusal exists to prevent, arrived at from the
  // other direction.
  attachReel({
    track: goTrack,
    leave: () => dash?.setGear('D', 'reel'),
    // Replaying is Travel's business for the same reason driving is: the reel
    // picks WHICH track and never how to walk it.
    //
    // The transport comes up with the replay and goes down with it, here rather
    // than inside `replayTrack`, so travel.js stays unaware there is a bar.
    replay: (id, opts) => {
      const out = replayTrack(id, opts ?? {})
      if (out.started) transportStart()
      return out
    },
  })

  // The bar's four verbs. `stop` also takes the bar down, because a transport
  // outliving the thing it transports is the same unreadable state as a gear
  // with no scene behind it.
  attachTransport({
    pause: pauseReplay,
    resume: resumeReplay,
    step: stepReplay,
    back: stepBack,
    stop: () => { stopReplay('transport'); transportStop() },
    state: replayState,
  })
  hooks.closeWindow = requestCloseWindow
  // Every way a replay can end -- completion, refusal, Esc, the exit button --
  // goes through `stopReplay`, which fires this. One place, not five.
  hooks.replayEnded = transportStop

  // FLY TO A WINDOW THAT HAS JUST APPEARED.
  //
  // Reported against dialogs: an application puts one up, the ship stays where
  // it was, and there is no way to tell anything happened. A window arriving IS
  // the event worth looking at, so the camera goes to it.
  //
  // Two refusals, both so this does not fight the person using it:
  //   - not while the MAP is open. The map is a deliberate act; yanking the
  //     world around underneath it would move the thing being read.
  //   - not if we are already standing IN that window, which happens on the
  //     rebuild path and would re-fly the camera to where it already is.
  hooks.arrived = (district, milepost) => {
    if (state.mapOpen) return
    if (state.mode === 'flat' && state.flatDistrict === district && state.flatMilepost === milepost) return
    goWindow(district, milepost)
    state.flewTo = { district, milepost, n: (state.flewTo?.n ?? 0) + 1 }
  }

  // ---- ending the session -------------------------------------------------
  //
  // A PAGE CANNOT LOG YOU OUT. The shell is a document in a kiosk browser; it
  // has no session to end and `window.close()` will not close the last window it
  // is running in. The thing that owns the session is `rrabbit-session`, which
  // is blocked waiting for that browser to exit -- so ending the session means
  // ending the browser, and the only process on the machine that both knows
  // which browser that is and is allowed to signal it is the bridge.
  //
  // WHICH IS WHY THIS CAN REFUSE, AND SHOULD. Served from vite on 8911, or from
  // a bridge started by hand on a workstation, there is no session and no kiosk
  // -- and a shell that reached for the nearest Firefox and killed it would take
  // the browser you are developing in with it. The bridge answers 409 with a
  // sentence saying so, and that sentence goes on the plate.
  async function endSession() {
    let why
    try {
      const r = await fetch(`${TUBE_BRIDGE}/api/logout`, { method: 'POST' })
      // READ THE BODY EITHER WAY. The refusal's whole value is its reason, and
      // `r.ok` alone would reduce it to "no".
      const body = await r.json().catch(() => ({}))
      state.lastLogout = { ok: !!body.ok, status: r.status, why: body.why || null,
                           pid: body.pid ?? null, at: Date.now() }
      if (!r.ok || !body.ok) why = body.why || `bridge answered ${r.status}`
      // Signalled. Nothing more to draw -- either this page is about to go, or
      // the browser ignored the signal, and the line below is what says which.
      else why = `signalled pid ${body.pid} — still here means it did not go`
    } catch (e) {
      state.lastLogout = { ok: false, status: null, why: String(e), pid: null, at: Date.now() }
      why = `the bridge did not answer: ${e}`
    }
    dash.setPowerWhy(why)
  }

  // THE COCKPIT'S ONE CONTROL, wired into the road's own pointer path rather
  // than into a listener of its own. Travel asks before it raycasts; a hit on
  // the gate knocks the stick into that detent and swallows the click, and
  // anything else falls straight through to the road.
  hooks.dashHit = (x, y) => {
    const on = dash && dash.hit(x, y)
    if (!on) return null
    if (on.kind === 'gear') dash.setGear(on.id, 'click')
    if (on.kind === 'dashPull') dash.setRaised(on.action === 'raise')
    if (on.kind === 'exitFull') exitFull()
    if (on.kind === 'start') {
      // THE SAME DIVISION THE TUNER KEEPS. `hit()` says a press was a miss;
      // shutting the menu happens here, once per press, because `hit()` also runs
      // on every pointer move and a menu closed there closes the instant you
      // start moving toward the row you meant.
      if (on.action === 'menu') dash.toggleStart()
      if (on.action === 'close' || on.action === 'dismiss') dash.closeStart()
    }
    if (on.kind === 'power') {
      // Same division as the tuner's and the ST&RT menu's: `hit()` says what the
      // press was, and the opening and shutting happens here, once per press.
      if (on.action === 'menu') dash.togglePower()
      if (on.action === 'close' || on.action === 'dismiss') dash.closePower()
      if (on.action === 'logout') endSession()
    }
    // A PRESS ON A ROW, as opposed to a DRAG off one. Both begin with the same
    // pointerdown and the drag is decided later by whether the pointer moved, so
    // the press is handled where the gesture ENDS -- see `endDrag` -- and this
    // branch exists only to swallow the click here so nothing behind the menu
    // takes it as well.
    if (on.kind === 'program') return on
    if (on.kind === 'channel') {
      if (on.action === 'menu') dash.toggleMenu()
      // THE ONLY PLACE THE MENU IS CLOSED BY A MISS, and it is here rather than
      // in `hit()` because this runs once per PRESS. `hit()` also runs on every
      // pointer move, so closing it there closed it the instant the pointer
      // started travelling toward a row.
      if (on.action === 'dismiss') dash.closeMenu()
      if (on.action === 'pick') {
        // A PICK IS A TUNE, NOT A TOGGLE. Pressing the row of the channel
        // already on turns the TV OFF, which is the only way this dropdown can
        // express "nothing" -- there is no other control for it, and a tuner you
        // cannot switch off is one where a window is stuck on the screen.
        onAirKey = onAirKey === on.key ? null : on.key
        dash.closeMenu()
      }
    }
    if (on.kind === 'tvctl' && on.action === 'delete') {
      // DELETE TAKES IT OFF THE LIST, not off the screen -- taking it off the
      // screen is what picking its own row already does, and two controls for
      // one act is how you end up pressing the wrong one. Off the list is off
      // the air as well, because a window broadcasting that nothing on the
      // dashboard admits to has no way back.
      if (on.key) castList.delete(on.key)
      if (onAirKey === on.key) onAirKey = null
      dash.closeMenu()
    }
    if (on.kind === 'screen' && on.key) {
      // CLICKING THE TV FLIES YOU INTO THE WINDOW ON IT. The same gesture as
      // clicking its sign out on the road, and it resolves through the same
      // function -- the TV is a view of a window, so it answers like one.
      const s = signs.get(on.key)
      if (s) {
        dash.closeMenu()
        flattenTo(s.milepost, s.district)
      }
    }
    return on
  }

  // `--&` on a flattened window. Adds it to the list AND puts it on air, because
  // pressing a control on a window and having it appear nowhere is a press you
  // cannot tell from a miss.
  // A PANE ON AIR. Tracked beside `onAirKey` rather than folded into it: the
  // window path keys on a `signs` key and checks liveness against `signs`, and a
  // pane is not in that map. One extra binding beats making every line that says
  // `signs.get(onAirKey)` ask which kind of thing it is holding.
  hooks.castPaper = (pane) => {
    if (!pane?.tex) return null
    onAirPaper = onAirPaper === pane ? null : pane
    if (onAirPaper) onAirKey = null
    return { on: !!onAirPaper, key: pane.key }
  }

  hooks.castWindow = (district, milepost) => {
    const k = [...signs.keys()].find((key) => {
      const s = signs.get(key)
      return s && s.district === district && s.milepost === milepost
    })
    if (!k) return null
    castList.add(k)
    onAirKey = k
    // AND IT LETS GO OF THE WINDOW, which is the half that was missing.
    //
    // The cockpit slides out of the way while you are standing in a window (the
    // flatten is pixel-exact and an instrument panel over it would be a lie about
    // 1:1), so pressing `&--` from inside put the window on a TV that was not on
    // screen -- a control that visibly did nothing, from the one place you can
    // reach it. Broadcasting is a thing you do TO a window in order to watch it
    // from outside, so the press ends where the result is visible: back on the
    // road, dashboard up, this window on the glass.
    //
    // `release()` and not `goWindow()`: you are already parked in front of it, so
    // stepping back out is the whole move.
    release()
    return { key: k, listed: castList.size, on: true, released: true }
  }
  // ---- dragging a program out of the ST&RT menu ----------------------------
  //
  // ONE GESTURE, TWO OUTCOMES, decided by whether the pointer moved. Press a row
  // and release without travelling and the program opens wherever the road has
  // room; press it and drag and it opens WHERE YOU DROPPED IT. That is the same
  // bargain a desktop makes with a shortcut, and it means the menu does not need
  // a second control for "and put it over there".
  //
  // THE THRESHOLD IS WHAT MAKES BOTH REACHABLE. Without it every click is a
  // one-pixel drag onto the menu itself, which is a cancel -- so a plain click
  // would do nothing at all, and it would look exactly like a dead row.
  const DRAG_SLOP = 5
  let dragging = null

  // WHERE THIS WOULD LAND IF IT WERE RELEASED NOW, and why not, in the same
  // answer. The ghost prints `hint` verbatim, so every refusal here is a refusal
  // the user can read off the screen rather than infer from nothing happening.
  function dragHint(x, y) {
    const prog = dragging.program
    if (!prog.ok) return { ok: false, hint: prog.why || 'not available' }
    // Over the panel or over the menu it came from: not a place, and the way a
    // drag is cancelled -- you put it back where you got it.
    if (dash && dash.overCockpit(x, y)) return { ok: false, hint: 'release it over the road' }
    const t = dropAt(x, y)
    if (!t || t.blocked) {
      return { ok: false, hint: t?.label || 'no road under the pointer to put it on' }
    }
    return { ok: true, hint: t.label, target: t }
  }

  function stepDrag(ev) {
    if (!dragging) return
    if (!dragging.moved
        && Math.hypot(ev.clientX - dragging.from[0], ev.clientY - dragging.from[1]) < DRAG_SLOP) {
      return
    }
    dragging.moved = true
    const d = dragHint(ev.clientX, ev.clientY)
    dragging.target = d.ok ? d.target : null
    dash.setDrag({ name: dragging.program.name, x: ev.clientX, y: ev.clientY,
                   ok: d.ok, hint: d.hint })
  }

  function endDrag(ev) {
    if (!dragging) return
    const { program, moved, target } = dragging
    dragging = null
    dash.setDrag(null)
    if (!program.ok) {
      // REFUSED, AND RECORDED. A row that cannot launch is drawn refused and says
      // why on the row; releasing it changes nothing, and this is the line that
      // says so rather than leaving "I clicked it and nothing happened".
      state.lastLaunch = { program: program.id, ok: false, why: program.why }
      return
    }
    // A CLICK IS A DROP WITH NO PLACE IN IT. `spawnWindow(null, null)` is what
    // the shell has always meant by "wherever there is room", so a press and a
    // drop onto bare road take the same path and cannot disagree.
    const place = moved ? target : { where: 'click', side: null, dash: null }
    if (!place) {
      state.lastLaunch = { program: program.id, ok: false, why: 'released nowhere' }
      return
    }
    dash.closeStart()
    const ok = launchProgram ? launchProgram(program, place.side, place.dash) : false
    state.lastLaunch = { program: program.id, where: place.where,
                         side: place.side ?? null, dash: place.dash ?? null, ok }
  }

  // CAPTURE ON `window`, AND IT HAS TO BE. Travel owns the pointer -- its driving
  // handler is on the canvas and its flat handler is a capture listener on
  // `window` that calls `stopPropagation` -- so this has to run before both, and
  // registration order in this phase is what puts it there: buildWorld runs
  // before installInput. `stopPropagation` here is only ever used for a press on
  // a program row; every other press on the cockpit still goes down the one path
  // through `hooks.dashHit`, which is the whole reason that hook exists.
  window.addEventListener('pointerdown', (ev) => {
    if (!dash) return
    const on = dash.hit(ev.clientX, ev.clientY)
    if (!on || on.kind !== 'program') return
    ev.preventDefault()
    ev.stopPropagation()
    dragging = { program: on.program, from: [ev.clientX, ev.clientY], moved: false, target: null }
  }, { capture: true })

  // NOT SWALLOWED, and that is the point. Travel's own hover listener is what
  // lights a gate panel or frames a marker, and it is the road's highlight --
  // stopping the move here left the ghost naming a target the road showed no
  // sign of, which is two answers to "where will this land" and only one of them
  // visible. The move is read, not taken.
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return
    stepDrag(ev)
  }, { capture: true })

  for (const kind of ['pointerup', 'pointercancel']) {
    window.addEventListener(kind, (ev) => {
      if (!dragging) return
      ev.stopPropagation()
      // A CANCELLED POINTER IS NOT A DROP. The browser takes the pointer away on
      // a lost window or a system gesture, and finishing the launch on that would
      // open a window somewhere the user never released.
      if (kind === 'pointercancel') { dragging = null; dash.setDrag(null); return }
      endDrag(ev)
    }, { capture: true })
  }

  // Hover, so a detent reads as reachable before you knock the stick into it --
  // and so the pull tab knows the pointer has come down to the bottom edge.
  //
  // CAPTURE, and that is not a style choice. While you are standing in a window
  // Travel silences Greenfield with a capture-phase `stopPropagation` on
  // `window`, so a listener in the BUBBLE phase never runs in flat mode at all --
  // which is the one mode the pull tab exists in. It stayed invisible however
  // far down the screen the pointer went. `stopPropagation` does not stop other
  // listeners on the SAME node, so a capture listener here still hears it.
  //
  // Passive: this only ever does arithmetic, and it must not compete with the
  // raycast hover already on the canvas.
  window.addEventListener('pointermove', (ev) => {
    if (dash) dash.hover(ev.clientX, ev.clientY)
  }, { capture: true, passive: true })
  window.addEventListener('blur', () => dash && dash.hover(null, null))

  // G WALKS THE GATE, Esc drops back into D -- RAVIO's two keys, and the only
  // ones the cockpit takes. Capture phase and only when the road has the
  // keyboard: a flattened window is being typed into, and a shell that ate `g`
  // out of somebody's editor would be the worst kind of furniture.
  window.addEventListener('keydown', (ev) => {
    if (state.mode === 'flat') return
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return
    if (!dash) return
    if (ev.key === 'g' || ev.key === 'G') {
      const i = GEARS.findIndex((g) => g.id === dash.gear())
      // Walks past a gear it cannot engage rather than stopping dead on it --
      // `setGear` refuses, and a G that did nothing would read as a broken key
      // rather than as a gate with three positions that are not built.
      for (let n = 1; n <= GEARS.length; n++) {
        if (dash.setGear(GEARS[(i + n) % GEARS.length].id, 'key')) break
      }
    } else if (ev.key === 'Escape') {
      // The replay branch that used to be here has moved to travel.js's
      // capture-phase listener. This one is bubble phase and three branches over
      // there can stop propagation before it, which is why Esc appeared dead.
      dash.setGear('D', 'key')
    // THE GEAR'S OWN LETTER GOES STRAIGHT THERE. `G` walks the gate one detent
    // at a time, which is right when you are browsing it and wrong when you know
    // where you are going -- reaching the reel from D meant three presses past
    // two gears that refuse.
    //
    // EVERY GEAR, NOT A KEY FOR THE REEL. A letter bound to one scene would be
    // the second-way-in that `t` already was; a letter bound to the GATE is the
    // same control the stick is, reached from the keyboard. P and C still refuse
    // through `setGear`, so an unbuilt gear says so rather than going quiet.
    //
    // `r` is safe beside the ctrl+alt+shift+R release chord: this handler
    // returns above on any modifier, so the chord never reaches it.
    } else if (/^[prcd]$/i.test(ev.key)) {
      dash.setGear(ev.key.toUpperCase(), 'key')
    }
  })

  resize()
  window.addEventListener('resize', resize)
}

// One road per OPEN workspace, laid side by side at the lane the layout gives
// it. A workspace you can SEE from a neighbouring workspace is the difference
// between switching and teleporting.
//
// Reconciliation rather than construction: this used to be a `forEach` over a
// constant array, run once, and there was no case where the answer could change.
// Now it can -- a workspace is added, closed, re-opened -- so the function has to
// be safe to call at any time and idempotent when nothing moved.
function syncRoads() {
  const want = new Set()
  for (const w of ws.list()) {
    if (!w.open) continue
    want.add(w.id)
    const x = ws.laneX(w.id)
    let r = roads.get(w.id)
    if (!r) {
      // 14000 long, not 6000. The road used to end at z=-5600, which was past
      // anything a 260-unit milepost could reach; same-side spacing is 460 now
      // and the exit gate stands a clear run beyond the last window, so a road
      // with a dozen windows on one side would have run out of tarmac under it.
      // Fog stops at 4200 either way, so this costs one quad and shows nothing
      // extra.
      // 14500 AND RE-CENTRED, because the wheel now goes BACKWARDS past the head
      // of the road (HEAD_ROOM). The old quad ran z -13600..+400 and the camera
      // can now sit at z 580, which put you 180 units behind the tarmac's own
      // near edge, looking at the road starting in mid-air. The far end is kept
      // exactly where it was and only the near end grows -- fog stops at 4200
      // either way, so this still costs one quad and shows nothing extra.
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(320, 14500),
        new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9 }),
      )
      road.rotation.x = -Math.PI / 2
      scene.add(road)

      // THE GATEWAY ARCH IS GONE. It existed so "a district is identifiable
      // from the overview without reading anything", was hidden from the road
      // because at eye level it was a bare crossbar in your way, and the
      // overview it labelled has been replaced by a map that says the names
      // out loud. Furniture whose only audience has left is not furniture.
      r = { road }
      roads.set(w.id, r)
    }
    r.road.position.set(x, -30, -6350)
  }
  // THE STATUS LINE STOPPED DESCRIBING THE KEYBOARD, because the keyboard
  // changed under it. It said "type a number for a lane (1..n)" and the numbers
  // are TRACKS now -- ten trails, not n roads -- so the sentence was describing
  // a feature that no longer exists while sitting above the one that replaced
  // it. The count still has to be live for the same reason it always did.
  // AND THE HINT PANEL IS GONE TOO, for a better reason than "it was in the
  // way": it had gone STALE and was teaching the wrong thing. "1..9 switch
  // tracks (1 then 0 for ten)" describes the fixed ten-track model that sparse
  // 1-999 replaced -- the same drift its own comment above warned about, one
  // model later. A permanent panel that has to be re-edited every time the shell
  // changes is a panel that will be wrong again.
  //
  // What it taught now lives where it is needed instead: the TV's footer carries
  // `G · next gear   R · the reel   0 · the map`, and the reel states its own
  // grammar in its subtitle.
  if (want.size !== lastRoadCount) {
    lastRoadCount = want.size
    const el = document.getElementById('status')
    // HIDDEN, NOT EMPTIED. Clearing the text left the panel's border and
    // background painted around nothing -- a small empty box in the corner,
    // which is what got reported. The element stays in the tree because boot
    // failures still write to it; `hidden` comes off the moment anything does.
    if (el) {
      el.textContent = ''
      el.hidden = true
    }
  }

  for (const [id, r] of [...roads]) {
    if (want.has(id)) continue
    scene.remove(r.road)
    r.road.geometry.dispose()
    r.road.material.dispose()
    roads.delete(id)
  }
}

// ---------------------------------------------------------------- the tubes

// A BRIDGE THAT IS DOWN IS ASKED LESS OFTEN, and it took three crash logs to
// notice this was not already true.
//
// The poll was a flat `setInterval(pollTubes, 2000)` -- forever, at the same rate,
// whether the bridge answered or not. With bridge.py not running that is a failed
// fetch every two seconds for as long as the tab is open, and each one is a
// console error Chrome RETAINS, with a stack. Every crash report from this shell
// so far has been several hundred identical `api/tubes 500` lines with the actual
// event buried at the bottom; twelve minutes of idle is about 360 of them. That
// is a diagnostic being drowned by its own instrumentation.
//
// The file already knows this is wrong -- `loseContext` calls pollTubes "the
// loudest thing in a broken tab" and clears it -- but only for a lost context. A
// bridge that is simply not running is the far more ordinary case and got no such
// mercy.
//
// So: double the gap on every consecutive failure up to TUBE_MAX, and drop
// straight back to TUBE_BASE the moment it answers. The rack still shows its last
// known values and `#why` still says the bridge is unreachable -- the display is
// unchanged, only the asking is. A bridge that comes back is picked up within
// TUBE_MAX rather than instantly, which is the honest price and is stated on the
// line itself.
const TUBE_BASE = 2000
const TUBE_MAX = 30000
let tubeGap = TUBE_BASE
let tubeTimer = 0

async function pollTubes() {
  try {
    const r = await fetch(`${TUBE_BRIDGE}/api/tubes`, { cache: 'no-store' })
    // CHECKED, WHICH IT WAS NOT. A 500 fell through to `r.json()` and surfaced as
    // `Unexpected end of JSON input` -- which reads as a bridge sending malformed
    // data rather than as a bridge that is not running, and those have completely
    // different fixes. The status code is the answer to which one it is.
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const payload = await r.json()
    rack.apply(payload)
    state.tubeReader = payload.reader
    state.tubePolls++
    state.tubeError = null
    tubeGap = TUBE_BASE
  } catch (e) {
    // A bridge that is down must not read as a machine that is idle: leave the
    // last values alone and say so. Blanking the rack would be a claim.
    state.tubeError = String(e)
    state.tubeFails = (state.tubeFails ?? 0) + 1
    tubeGap = Math.min(TUBE_MAX, tubeGap * 2)
  }
  state.tubeGap = tubeGap
  renderWhy()
}

// Self-scheduling rather than an interval, because the gap changes. One handle,
// cleared by `loseContext` -- a poll that outlives the context it draws for is
// exactly what the note above is about.
function scheduleTubes() {
  tubeTimer = setTimeout(async () => {
    tubeTimer = 0
    await pollTubes()
    if (!contextLost) scheduleTubes()
  }, tubeGap)
}

// Invariant 1: a tube over its redline has to say what is doing it.
function renderWhy() {
  const el = document.getElementById('why')
  if (!el) return
  const over = rack.overRedline()
  if (state.tubeError) {
    // The RETRY GAP is on the line, because a poll that has backed off to thirty
    // seconds and a poll that has stopped look identical from a stale rack, and
    // one of them is a bug. It also says how long a bridge you have just started
    // will take to be noticed.
    const every = Math.round((state.tubeGap ?? TUBE_BASE) / 1000)
    el.textContent = `tube bridge unreachable — showing last known values `
      + `(${state.tubeError}; retrying every ${every}s)`
    el.dataset.state = 'stale'
    return
  }
  if (over.length === 0) {
    el.textContent = ''
    el.dataset.state = 'ok'
    return
  }
  el.dataset.state = 'over'
  el.textContent = over
    .map((o) => `${o.name.toUpperCase()} ${Math.round(o.value * 100)}% over ${Math.round(o.bar * 100)}% — ${o.why}`)
    .join('   ·   ')
}

function resize() {
  const w = window.innerWidth || 1280
  const h = window.innerHeight || 720
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}



// --------------------------------------------------------------- the frame

// WHY THE FRAME ENDS BY UNBINDING A VERTEX ARRAY.
//
// This was recorded for two months as "frames tear -- h264 damage-region
// artifacts, unmeasured". It is not a damage-region problem and it is not in
// the encoder. It is the shared context.
//
// three leaves one of its own VAOs bound when render() returns. Greenfield's
// YUV->RGB pass then runs from a WebCodecs callback, in its own task, and
// converts the decoded frame with a full-screen triangle strip:
// `bindBuffer` + two `vertexAttribPointer` calls + `drawArrays`, and NO vertex
// array of its own -- it was written for a context nobody else touches.
// Without a VAO of its own, those pointer calls are recorded into whichever
// VAO happens to be bound, which is three's, and the draw then reads the rest
// of its attribute state from three's leftovers.
//
// Hence a triangle strip where one triangle lands and the other does not:
// a clean DIAGONAL split, with the surviving half stretched across the quad --
// exactly the "blurred giant glyphs" in docs/m8-native-flat.png. It also
// silently corrupts the VAO three will use next.
//
// Measured before the fix: `OES_vertex_array_object` present, and
// VERTEX_ARRAY_BINDING_OES non-null immediately after render() returned.
//
// Leaving the DEFAULT vertex array bound between frames costs one call and
// means any Greenfield draw that lands between our frames operates on state
// that belongs to nobody. three re-binds its own on the next resetState().
function leaveNeutralVertexState() {
  if (vaoExt) vaoExt.bindVertexArrayOES(null)
  else if (gl.bindVertexArray) gl.bindVertexArray(null)
}

// --------------------------------------------------------- the idle backoff

// WHY THE FRAME LOOP HAS A BRAKE, AND WHY IT IS KEYED ON INPUT AND NOTHING ELSE.
//
// Measured: three abandoned headless tabs of this page, left behind by earlier
// agent-browser runs, held ELEVEN OF TWENTY-FOUR CORES for hours -- ~3.4 cores
// each, all of it in the GPU process, compositing at 15-30fps against
// swiftshader. They had no server left to talk to (:8911 was long dead) and
// nobody attached. One had rendered 369,325 frames and logged 358,290 GL errors
// on the way, one per frame for five hours that no one was ever going to read.
// The loop's whole contract was "re-arm forever", so that is what it did.
//
// THREE CONDITIONS THAT LOOK RIGHT AND ARE ALL WRONG, because each was measured
// before it was believed:
//
// 1. `document.hidden`. All three tabs reported visibilityState 'visible' for
//    their entire lives -- a `--headless=new` page is never backgrounded. It is
//    still checked below, because it is free and correct for a real background
//    tab, but on the case that actually burned the CPU it does nothing.
//
// 2. "No windows." `signs.size === 0` never happens here: /m2/ opens its launch
//    plan on load, so an abandoned tab sits at five.
//
// 3. "No new content." There is a real content-arrival hook -- Greenfield's
//    `Renderer.render()` is commit-driven and ends by calling `gfScene.render`,
//    which this file overrides and already counts as `state.suppressed`. It was
//    climbing at ~30/s on a tab nobody had touched in ten minutes, and that is
//    not a bug: `clients/simple-shm` is the ordinary Wayland demo, so it paints
//    from a `frame()` callback and commits again forever, five times over. The
//    scene is GENUINELY never static. A dirty-flag brake can never engage here,
//    and there is nothing to fix in the client -- animating is its whole job.
//
// So content cannot distinguish a shell in use from one abandoned overnight,
// because both have identical content. Only INPUT can. That is the brake:
// nothing touched this page in a while, so stop paying full price to composite
// for nobody. It is the one signal that is about the human rather than the
// scene, and it is why this is keyed on input alone.
//
// Two stages rather than one, because "untouched" spans two different things.
// Reading output without moving the mouse is normal and must stay watchable, so
// the first stage only halves-ish the rate. Ten minutes untouched is a tab
// somebody walked away from, and that one gets the slow beat.
//
// And it is a HEARTBEAT, NOT A STOP. Adoption is a poll, not an event
// (`adoptPending` reads `topLevelViews` every frame), so there is no arrival
// callback to wake on: a window that appears while we are braked is noticed on
// the next beat and full rate resumes by itself. Anything this fails to
// enumerate recovers at WALKED_HZ rather than never, which is the difference
// between a brake and a bug. Any pointer move, wheel or key restores full rate
// on the spot -- including a pointermove that merely crosses the page.
const RESTING_AFTER = 60000 // ms untouched: still being read, cap the rate
const RESTING_HZ = 10
const WALKED_AFTER = 600000 // ms untouched: nobody is here
const WALKED_HZ = 1

let lastInput = 0
let beat = 0

// Capture phase on `window`, because Greenfield binds its own input to the
// CANVAS (browser/input.js) and Travel binds its own on top of that. Waking has
// to happen whoever ends up handling -- or swallowing -- the event.
for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup']) {
  window.addEventListener(ev, () => wake(), { capture: true, passive: true })
}
window.addEventListener('visibilitychange', () => !document.hidden && wake())

function wake() {
  lastInput = performance.now()
  // The clients are paced off the same brake now, so waking has to release them
  // too -- see paceCompositor. Unconditional, and BEFORE the `beat` guard: the
  // shell can already be at full rate (mode is not `driving`) while a deferral
  // from a moment ago is still sitting on a timer.
  flushPace()
  if (!beat) return
  // Do not wait out the rest of a beat to answer a keystroke.
  clearTimeout(beat)
  beat = 0
  requestAnimationFrame(frame)
}

// The rate this frame is allowed to re-arm at, or 0 for "as fast as the display
// will take it". Motion the user did not ask for keeps full rate: a flight is a
// shot in progress and a resize is a gesture, and neither may go choppy just
// because the pointer happens to be still while it plays.
function pace(now) {
  if (state.mode !== 'driving') return 0
  const quiet = now - lastInput
  if (quiet > WALKED_AFTER) return WALKED_HZ
  if (quiet > RESTING_AFTER) return RESTING_HZ
  return 0
}

// Re-arming is the loop's only exit, so it is the one place the brake can live.
function rearm(now) {
  const hz = pace(now)
  if (!hz) {
    beat = 0
    requestAnimationFrame(frame)
    return
  }
  state.idleBeats++
  beat = setTimeout(() => {
    beat = 0
    frame(performance.now())
  }, 1000 / hz)
}

// -------------------------------------------------- pacing the CLIENTS too
//
// THE BRAKE ABOVE THROTTLED THE ONE CHEAP PARTICIPANT AND NONE OF THE EXPENSIVE
// ONES, and it took a soak to see it.
//
// Measured: seven simple-shm windows, seven minutes untouched. The shell braked
// itself all the way down to WALKED_HZ -- 3597 idle beats, the loop doing almost
// nothing -- and one Chrome renderer sat at 614% CPU for the entire run. The
// clients never slowed down at all, and the reason is one line in the compositor:
//
//     export function createRenderFrame() {                  Renderer.js:8
//       return new Promise((resolve) => { requestAnimationFrame(resolve) })
//     }
//
// A Wayland client paints when the compositor hands it a `wl_surface.frame`
// callback. Greenfield hands them out on a bare rAF, so every client is invited
// to paint sixty times a second forever no matter what the page is displaying --
// seven clients painting at 60fps into a shell drawing at 1fps. The brake was
// saving the cheapest thing on the page and paying full price for the rest.
//
// So the callbacks are paced by the SAME `pace()` the shell re-arms on. Not a
// second policy: one function, so the rate the clients are invited to paint at
// and the rate the page is drawn at cannot drift -- and it inherits `pace()`'s
// existing rule that anything other than `driving` runs at full rate for free,
// which is what keeps a flattened window pixel-exact and live while you are
// standing in it.
//
// DEFERRED, NEVER DROPPED, and that distinction is the whole correctness of it.
// `Renderer.render()` is what collects a surface's pending frame callbacks and
// fires them; a client that is waiting on one does not commit again until it
// arrives. Dropping a call would therefore not slow a client down, it would STOP
// it -- permanently, because the next call only ever comes from the commit that
// is now never going to happen. So a call that arrives early is rescheduled, not
// discarded, and one deferral in flight is enough to carry all of them.
//
// `?pace=0` declines it. The cost this trades away is real: a client animating on
// its own -- a clock, a video -- goes choppy after RESTING_AFTER of no input,
// because it is being invited to paint ten times a second instead of sixty. That
// is the same bargain the shell already makes with its own loop, applied to the
// participants that were exempt from it.
const PACE_CLIENTS = new URLSearchParams(location.search).get('pace') !== '0'
const pacing = { deferred: 0, passed: 0, lastAt: 0, timer: 0 }

// Input must not wait out a beat here either -- `wake()` calls this. A pending
// deferral is up to a second of latency sitting between a keystroke and the
// client that should answer it.
function flushPace() {
  if (!pacing.timer) return
  clearTimeout(pacing.timer)
  pacing.timer = 0
  pacing.fire?.()
}

function paceCompositor() {
  if (!PACE_CLIENTS || !session?.renderer) return
  const real = session.renderer.render.bind(session.renderer)
  let queued
  const run = (after) => {
    pacing.passed++
    pacing.lastAt = performance.now()
    return real(after)
  }
  pacing.fire = () => {
    const arg = queued
    queued = undefined
    run(arg ?? undefined)
  }
  session.renderer.render = (after) => {
    const now = performance.now()
    const hz = pace(now)
    // Full rate: the wrapper is a straight pass-through and costs one call.
    if (!hz) return run(after)
    const due = pacing.lastAt + 1000 / hz
    if (now >= due) return run(after)
    if (queued === undefined) queued = after ?? null
    if (pacing.timer) return
    pacing.deferred++
    pacing.timer = setTimeout(() => {
      pacing.timer = 0
      pacing.fire()
    }, Math.ceil(due - now))
  }
}

// SHARING THE CONTEXT MEANS SHARING THE STATE, AND THE STATE IS THREE'S.
//
// Greenfield gets a surface's pixels into `renderState.texture` three ways, and
// all three are raw GL in OUR context (Scene.js: `image/bitmap` and `image/png`
// are a texImage2D, `video/h264` is a full YUV->RGB shader pass rendered into
// the texture). Upstream that context belongs to Greenfield alone, so the
// passes set only what they use and inherit the defaults for everything else.
// Here they inherit whatever three.js last left switched on -- measured, mid
// frame: CULL_FACE on (BACK/CCW), DEPTH_TEST on, BLEND on, UNPACK_FLIP_Y on,
// and a clear colour of the road's navy instead of transparent black.
//
// THAT IS THE WHOLE "NATIVE WINDOWS ARE BLANK" FAULT, and it is why only native
// ones were: an shm client's upload does not rasterise, so nothing culls it.
// The h264 quad is six vertices drawn as a TRIANGLE_STRIP, whose two real
// triangles come out with OPPOSITE winding -- so back-face culling drops
// exactly one of them and the window shows a corner-to-corner diagonal, half
// picture and half clear colour. Photographed before and after.
//
// UNPACK_FLIP_Y is the subtler one. It flips every plane upload, which means
// which way a window is up depended on which three.js texture happened to be
// uploaded last. Forcing it off is what lets `adoptSurfaceTexture` derive the
// flip instead of measuring an accident (see the note there).
//
// The fence is per-pass rather than around `renderer.render`, because the passes
// run in a microtask that `render()` queues -- anything set outside it is only
// still true by luck. `resetState()` on the way out: three caches every one of
// these and would otherwise keep drawing the road on Greenfield's settings.
// EVERY DECODED FRAME PASSES THROUGH HERE, so this is where "did a picture ever
// arrive" can be answered instead of guessed. `state.decodes` looks like it
// answers it and does not -- it is declared in world.js and incremented nowhere,
// and it was quoted as evidence for "no frames arrive" more than once. This
// counts the passes that actually ran, per format, with the size of the last
// one, and it is the only counter here that has ever been true.
const passes = { 'video/h264': 0, 'image/bitmap': 0, 'image/png': 0, last: null, threw: 0 }
window.__passes = () => passes

// THE SAME COUNT, PER WINDOW -- because "is this one frozen" is the question
// that keeps getting asked and `passes` cannot answer it. Its totals are the
// whole page: five animating web clients drown one stalled native window, so a
// climbing number has been read as "frames are arriving" while the window being
// argued about was getting none. Keyed on the renderState the pass wrote into,
// which is the only handle a pass has -- it is given `(contents, renderState)`
// and nothing else. WeakMap so a destroyed surface takes its counter with it.
const fedByRenderState = new WeakMap()

function tallyFed(renderState) {
  if (!renderState) return
  const f = fedByRenderState.get(renderState)
  if (f) f.n++
  else fedByRenderState.set(renderState, { n: 1, was: 0, at: 0 })
}

// INPUT TO PICTURE, IN MILLISECONDS -- the one number "it does not update
// immediately" is actually about.
//
// Measured on the host it is ~36 ms (58/22/52/37/1/36 over six keystrokes into a
// flattened gnome-text-editor), which is two frames and invisible. Reported from
// the image it is plainly visible. Same code, so the difference is in what the
// guest's browser and the encoder cost, and NEITHER of those can be argued about
// from here -- they have to be read off the machine that is slow.
//
// The clock starts on a keystroke or a press and stops on the next decoded frame
// FOR THE SURFACE YOU ARE STANDING IN. That last part is the whole reason this
// is not a one-liner: five simple-shm clients paint continuously, so a timer
// stopped by "any pass" would report a millisecond or two forever and prove the
// opposite of the truth. Armed only while flat, for the same reason.
const lat = { pending: 0, samples: [], n: 0, missed: 0 }

function markInput() {
  if (state.mode !== 'flat') return
  // FIRST press of a burst, not the last: holding a key repeats, and restarting
  // the clock on each repeat would measure the gap between repeats instead.
  if (!lat.pending) lat.pending = performance.now()
}

function markPicture(renderState) {
  if (!lat.pending || state.mode !== 'flat') return
  // Only the surface being typed into. Walked rather than cached because a
  // view object is replaced when a surface is remapped, and a cached one would
  // silently stop matching -- which reads as "no frames" rather than as a stale
  // handle. The walk is behind the `pending` guard, so it costs nothing except
  // in the few frames after an actual keystroke.
  let mine = null
  for (const s of signs.values()) {
    if (s.district === state.flatDistrict && s.milepost === state.flatMilepost) { mine = s; break }
  }
  if (!mine || mine.view?.renderStates?.[SCENE_ID] !== renderState) return
  const dt = performance.now() - lat.pending
  lat.pending = 0
  lat.n++
  lat.samples.push(Math.round(dt))
  if (lat.samples.length > 40) lat.samples.shift()
}

for (const ev of ['keydown', 'pointerdown']) {
  window.addEventListener(ev, markInput, { capture: true, passive: true })
}

// HOW LONG FROM A KEYSTROKE TO THE PICTURE THAT ANSWERS IT.
//
// `p50`/`p90` rather than a mean, because the complaint is about the slow ones
// and a mean hides them behind the fast ones. `pending` non-zero at read time
// means a press is still unanswered -- if it stays non-zero the picture is not
// late, it is not coming, which is a different fault (see `__fed`).
window.__lat = () => {
  const s = [...lat.samples].sort((a, b) => a - b)
  const at = (q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null)
  return {
    mode: state.mode,
    n: lat.n,
    samples: [...lat.samples],
    p50: at(0.5),
    p90: at(0.9),
    max: s.length ? s[s.length - 1] : null,
    pendingMs: lat.pending ? Math.round(performance.now() - lat.pending) : 0,
  }
}

function fenceScenePasses(gfScene) {
  for (const mime of ['video/h264', 'image/bitmap', 'image/png']) {
    const real = gfScene[mime].bind(gfScene)
    gfScene[mime] = (contents, renderState) => {
      passes[mime] = (passes[mime] ?? 0) + 1
      tallyFed(renderState)
      markPicture(renderState)
      // Shape-agnostic: greenfield has moved this field around, and a probe that
      // throws while measuring is worse than no probe.
      try {
        const c = contents ?? {}
        const sz = c.size ?? c.codedSize ?? c.buffer?.codedSize ?? null
        passes.last = {
          mime,
          n: passes[mime],
          size: sz ? { w: sz.width, h: sz.height } : null,
          rsSize: renderState?.size ? { w: renderState.size.width, h: renderState.size.height } : null,
          coded: decodeGeom.last?.coded ?? null,
        }
        // THE DECODED FRAME'S SIZE, STAMPED ON THE SURFACE IT BELONGS TO.
        //
        // This is the missing number. `rs.texture.size` reports the SURFACE size
        // while the texture behind it holds the DECODED frame, which the encoder
        // has padded up to its alignment -- measured, a 613x205 surface decodes
        // to 640x256 with `visibleRect` covering the whole 640x256, so nothing
        // downstream can tell the picture from the padding. `sx = width / tw`
        // then computes 1.0, the quad samples the entire padded frame, and the
        // margin lands on the sign: 27 black columns for 27 columns of padding.
        //
        // Greenfield calls this pass from the decoder's own output callback, so
        // the frame that just arrived IS this surface's. The size check keeps
        // that from being a bare assumption: a coded size must CONTAIN the
        // surface and exceed it by less than one alignment block, or it belongs
        // to some other window and is ignored.
        if (mime === 'video/h264' && renderState?.size && decodeGeom.last?.coded) {
          const [cw, ch] = decodeGeom.last.coded
          const { width: sw, height: sh } = renderState.size
          // The slack was "< 64 either way" first, and that was wrong: a 577x183
          // surface decodes to 640x256, which is 63 columns and **73 rows** of
          // padding. The alignment is not one block and guessing its rule is how
          // that mistake happened. The honest constraint is only that a frame
          // must CONTAIN the surface and not be wildly larger than it -- which
          // still rejects the other window's frame outright, because that one
          // does not contain this surface at all.
          if (cw >= sw && ch >= sh && cw < sw * 2 && ch < sh * 2) {
            renderState.__codedSize = { w: cw, h: ch }
          }
        }
      } catch (e) {
        passes.threw++
      }
      gl.disable(gl.CULL_FACE)
      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.BLEND)
      gl.disable(gl.SCISSOR_TEST)
      gl.disable(gl.STENCIL_TEST)
      gl.colorMask(true, true, true, true)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      // Greenfield sets this once at YUVA2RGBA.create and never again; the pass
      // clears with it, so the padding around a picture is transparent rather
      // than a stripe of whatever three cleared with last.
      gl.clearColor(0, 0, 0, 0)
      try {
        return real(contents, renderState)
      } finally {
        renderer.resetState()
      }
    }
  }
}

let lastT = 0
function frame(now = 0) {
  // The one exit from the loop that does not re-arm. Everything below this line
  // assumes the GL objects it is about to touch still exist.
  if (contextLost) return
  try {
    // RAVIO: MEASUREMENTS MUST OUTLAST A FRAME, and an eased term driven by a
    // fixed step lies whenever the frame rate moves. Clamp so a backgrounded
    // tab returning does not teleport the camera.
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    lastT = now
    // A hidden tab has nothing to show and rAF is suspended there anyway; this
    // only matters for the beat, which is a timer and keeps firing. Skipping
    // before the reconcilers, not after, because a composite nobody can see is
    // the whole cost being avoided.
    if (document.hidden) return rearm(now)
    adoptPending()
    syncPopups()
    // The resize grab only exists on the window you are in, and what that is
    // changes from four different places -- reconcile rather than remember.
    syncHandles()
    // After adoptPending, so a window that arrived this frame is already counted
    // on the lane that advertises its road, and the exit gate has already moved
    // down to stand past it.
    //
    // Roads are reconciled here too, and not only at startup: a workspace can be
    // created from the exit gate mid-flight, and the road has to exist by the
    // time you land on it.
    syncRoads()
    syncGantries()
    // After the gantries, because the exit gate stands past the last thing on the
    // road and a ramp is now one of those things -- so the gate has to have moved
    // before the dashes are counted out to reach it.
    syncRamps()
    // Panes retier off the camera's z, so this has to run after the roads have
    // settled and before the frame is drawn -- a pane that retiers after the draw
    // shows the previous tier for one frame, which reads as a flicker on entry.
    syncPaper()
    // After the roads, because this puts the windows back over them.
    syncPlacement()
    syncTitles()
    stepFlight(dt)
    // THE ARCH IS AN OVERVIEW LABEL, SO IT ONLY EXISTS IN THE OVERVIEW.
    //
    // It was built "so a district is identifiable from the overview without
    // reading anything" -- a good reason, applied at all times. From the road
    // it is a bare crossbar hanging at y=300 across the head of your own
    // street, with no uprights and nothing to say it is a gateway, and it is
    // the first thing you see every time you look forward. Reported, twice.
    // Serving its stated purpose means being visible exactly where that purpose
    // applies.
    // Greenfield decoded into OUR context and left its own bindings behind.
    // three caches GL state and would otherwise trust a cache that is no longer
    // true. This call exists for exactly this kind of interop.
    // FULL SCREEN SHOWS THE WINDOW AND NOTHING ELSE, and it is done with LAYERS
    // rather than by hiding things.
    //
    // Setting `.visible = false` across the scene would be fighting the
    // reconcilers: syncPlacement, syncRoads, syncGantries and syncRamps all
    // write `visible` every frame from their own rules, so anything cleared here
    // is set again before the draw. Layers are orthogonal -- nothing else in this
    // shell touches them -- so the camera can simply be told to look at one layer
    // and every road, gantry, ramp, post and neighbouring window falls out of the
    // frame without a single one of them being asked to.
    //
    // Re-applied every frame rather than at the moment full screen is entered,
    // because the sign is REBUILT whenever the surface changes size, and the
    // first thing full screen does is change the surface's size.
    if (state.full && state.mode === 'flat') {
      const fs = [...signs.values()].find(
        (x) => x.district === state.flatDistrict && x.milepost === state.flatMilepost,
      )
      if (fs?.mesh) fs.mesh.traverse((o) => o.layers.enable(FULL_LAYER))
      camera.layers.set(FULL_LAYER)
    } else if (camera.layers.mask !== 1) {
      camera.layers.set(0)
    }

    // WHAT IS ON AIR, reconciled BEFORE the render, because the screen is an
    // object in this scene and positioning it after the draw would put it a
    // frame behind the bezel it has to sit inside.
    //
    // Reconciled rather than remembered: a window can leave by closing, by its
    // client exiting, or by its surface being remapped, and only one of those
    // routes goes through a handler this file owns. So the ledger is filtered
    // against the signs that actually exist, every frame, exactly the way
    // syncPlacement and syncTitles do it.
    if (tv && dash) {
      for (const k of [...castList]) if (!signs.has(k)) castList.delete(k)
      if (onAirKey && !signs.has(onAirKey)) onAirKey = null
      // A PANE THAT WENT AWAY CANNOT STAY ON AIR, and neither can one that dropped
      // out of the paint tier -- its texture is released on downgrade, and three
      // would happily keep drawing a disposed one.
      if (onAirPaper && !onAirPaper.tex) onAirPaper = null
      const rect = dash.tvRect()
      // No rect means the cockpit is out of the way (flat, or the map is up), and
      // a TV with nowhere to be does not draw. It keeps its place on the list.
      tv.set(rect ? (onAirKey ? signs.get(onAirKey) : onAirPaper) : null)
      if (rect) {
        // ALIVE-KEYS ONLY WHEN A WINDOW IS ON AIR. broadcast.js's liveness check is
        // `keyOf(showing)` against the sign ledger, and `keyOf` reads
        // `view.surface.resource...` -- a pane has no surface, so handing it that
        // check is a throw inside the frame loop rather than a picture that
        // disappears. Passing null skips it, which is correct because a PANE's
        // liveness is the shell's to know: `onAirPaper` is cleared above the moment
        // its texture is released.
        tv.sync(rect, window.innerWidth || 1280, window.innerHeight || 720,
          onAirPaper ? null : new Set(signs.keys()))
      }
    }

    renderer.resetState()
    renderer.render(scene, camera)
    // The CSS3D layer draws AFTER the WebGL frame and shares its camera. It is a
    // no-op unless a pane is being read, so the cost when nobody is reading is one
    // null check -- and the layer's own `pointer-events` stays off, which is what
    // keeps it from eating clicks meant for the road.
    renderRead()
    state.frames++
    leaveNeutralVertexState()

    // WHAT IS ON AIR, reconciled before the frame is drawn rather than
    // remembered at the moment something changed. A window can leave by closing,
    // by its client exiting, or by the surface being remapped, and only one of
    // those routes goes through a handler we own -- so the ledger is filtered
    // against the signs that actually exist, every frame, the same way
    // syncPlacement and syncTitles do it.
    // AFTER the scene and after leaveNeutralVertexState(), and both halves of
    // that matter. It is a separate 2D canvas composited by the browser, so it
    // cannot touch the shared GL context -- but drawing it before the render
    // would show the cockpit reading a frame the scene under it has not drawn
    // yet, and the whole panel is a measurement OF this frame.
    if (dash) dash.draw(now)

    // Drain the shared context's error flag once per frame and REMEMBER it.
    // Greenfield's Program.use() calls getError() straight after useProgram and
    // blames the useProgram for whatever it finds -- but getError returns the
    // first error since anyone last asked, so its "BUG? use gl program failed"
    // is equally consistent with an error three left behind. Sampling here, at
    // a known point, is what tells the two apart.
    const glErr = gl.getError()
    if (glErr !== gl.NO_ERROR) {
      state.glErrors++
      state.lastGlError = glErr
      state.lastGlErrorFrame = state.frames
    }
  } catch (e) {
    if (!state.frameError) state.frameError = String(e && e.stack ? e.stack : e)
  }
  rearm(now)
}

// ------------------------------------------------------------- the readback

function pixelAt(cx, cy) {
  const px = new Uint8Array(4)
  gl.readPixels(
    Math.round(cx),
    Math.round(renderer.domElement.height - cy),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    px,
  )
  return [px[0], px[1], px[2]]
}

const isBlack = ([r, g, b]) => r < 12 && g < 12 && b < 12

// Sweep each sign's own face, so "is this window on the road?" is answered per
// window and never by one guessed point (spec §10.1).
function sweepSign(s, n = 8) {
  if (!s.mesh) return null
  const g = s.mesh.geometry.parameters
  let content = 0
  let total = 0
  const lit = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const local = new THREE.Vector3(
        -g.width / 2 + (g.width * (i + 0.5)) / n,
        -g.height / 2 + (g.height * (j + 0.5)) / n,
        0,
      )
      const world = s.mesh.localToWorld(local)
      const v = world.project(camera)
      const sx = ((v.x + 1) / 2) * renderer.domElement.width
      const sy = ((1 - v.y) / 2) * renderer.domElement.height
      if (sx < 0 || sy < 0 || sx >= renderer.domElement.width || sy >= renderer.domElement.height) continue
      const rgb = pixelAt(sx, sy)
      total++
      if (!isBlack(rgb)) {
        content++
        lit.push(...rgb)
      }
    }
  }
  let digest = 0
  for (const v of lit) digest = (digest * 31 + v) >>> 0
  return { total, content, digest }
}

// ORIENTATION. A Wayland surface is top-left origin; a GL texture is
// bottom-left. Greenfield does no UNPACK_FLIP_Y on upload, so the correction
// has to happen at sample time -- and getting it backwards is invisible against
// a radially symmetric test pattern and glaring against a real application.
//
// So do not eyeball it. Attach the foreign texture to a framebuffer and read
// its OWN texels: row 0 is the first row Greenfield uploaded, i.e. the TOP of
// the surface. Then read the screen above and below the sign's centre. Whichever
// screen sample matches texel row 0 tells us which way up the sign is.
function orientationOf(s) {
  if (!s.mesh) return null
  const { width, height } = s.size
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    // the raw WebGLTexture, not three's wrapper
    renderer.properties.get(s.tex).__webglTexture,
    0,
  )
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  const readTexel = (x, y) => {
    const p = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p)
    return [p[0], p[1], p[2]]
  }
  // Row 0 and row h-1 are both white margin in this client, so THEY CANNOT
  // DISCRIMINATE. Sample at 20% and 80% of the height instead, and refuse to
  // answer if even those agree -- an inconclusive test that returns a boolean
  // is worse than one that returns nothing.
  const yNear = Math.floor(height * 0.2)
  const yFar = Math.floor(height * 0.8)
  const texNear = complete ? readTexel(Math.floor(width / 2), yNear) : null
  const texFar = complete ? readTexel(Math.floor(width / 2), yFar) : null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fb)
  // three cached bindings we just trampled.
  renderer.resetState()
  renderer.render(scene, camera)

  const g = s.mesh.geometry.parameters
  const screenAt = (fy) => {
    const world = s.mesh.localToWorld(new THREE.Vector3(0, g.height * fy, 0))
    const v = world.project(camera)
    return pixelAt(((v.x + 1) / 2) * renderer.domElement.width, ((1 - v.y) / 2) * renderer.domElement.height)
  }
  // Texel row `yNear` is 20% down from the FIRST uploaded row. If the sign is
  // upright that lands 20% down from the sign's top, i.e. local fy = +0.3.
  const screenUprightSlot = screenAt(0.3)
  const screenFlippedSlot = screenAt(-0.3)

  const dist = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : Infinity)
  const separation = dist(texNear, texFar)
  if (!complete || separation < 24) {
    return { complete, texNear, texFar, separation, inconclusive: true }
  }
  const errUpright = dist(screenUprightSlot, texNear) + dist(screenFlippedSlot, texFar)
  const errFlipped = dist(screenFlippedSlot, texNear) + dist(screenUprightSlot, texFar)
  return {
    complete,
    texNear,
    texFar,
    separation,
    errUpright,
    errFlipped,
    // "upright" == the surface's top is drawn at the TOP of the sign.
    upright: errUpright < errFlipped,
    inconclusive: errUpright === errFlipped,
  }
}

// CALIBRATION. The test client's pattern is mirror-symmetric about its own
// midline, so no sample of it can ever decide the flip -- `__orient` correctly
// refuses. So test the half of the path that is OURS, with a source that is
// asymmetric by construction: a texture whose FIRST uploaded rows are red and
// whose last are blue, adopted through the exact same code as a real surface.
//
// If red lands at the top of the quad, then texel row 0 renders at the top, and
// since Greenfield uploads a surface top-row-first (there is no UNPACK_FLIP_Y
// anywhere in its render path), a window is upright.
window.__calibrate = () => {
  const W = 4
  const H = 4
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const first = y < H / 2 // first rows of the DATA, i.e. low texel rows
      data[i] = first ? 255 : 0
      data[i + 1] = 0
      data[i + 2] = first ? 0 : 255
      data[i + 3] = 255
    }
  }
  const glTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, glTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const rt = new THREE.WebGLRenderTarget(W, H)
  rt.depthTexture = new THREE.DepthTexture(W, H)
  renderer.setRenderTargetTextures(rt, glTex)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.magFilter = tex.minFilter = THREE.NearestFilter
  // THE LINE UNDER TEST -- identical to makeSign().
  tex.repeat.set(1, -1)
  tex.offset.set(0, 1)

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )
  quad.position.set(0, 105, camera.position.z - 300)
  scene.add(quad)
  renderer.resetState()
  renderer.render(scene, camera)

  const at = (fy) => {
    const v = quad.localToWorld(new THREE.Vector3(0, 160 * fy, 0)).project(camera)
    return pixelAt(((v.x + 1) / 2) * renderer.domElement.width, ((1 - v.y) / 2) * renderer.domElement.height)
  }
  const top = at(0.35)
  const bottom = at(-0.35)
  scene.remove(quad)
  rt.dispose()
  gl.deleteTexture(glTex)

  const isRed = (c) => c[0] > 120 && c[2] < 120
  const isBlue = (c) => c[2] > 120 && c[0] < 120
  return {
    top,
    bottom,
    // Red is the FIRST uploaded row. Upright means it renders at the top.
    upright: isRed(top) && isBlue(bottom),
    flipped: isBlue(top) && isRed(bottom),
  }
}

window.__orient = () => {
  const out = []
  for (const s of signs.values()) if (s.mesh) out.push({ milepost: s.milepost, ...orientationOf(s) })
  return out
}

window.__m1 = () => {
  // `repaints` lives in rrabbit.js and is folded in here because this is the
  // report the image can actually reach (the report endpoint prints it and the
  // target has no console). `tried` climbing with `done` behind it is a sign
  // recovering a texture that was swapped out from under it -- runbook section 10.
  const out = { ...state, repaints: { ...repaints }, mileposts: [], sweeps: [] }
  for (const [k, s] of signs) {
    out.mileposts.push({
      key: k,
      district: s.district,
      districtName: ws.get(s.district)?.name ?? null,
      milepost: s.milepost,
      slot: s.slot,
      // The side is worth reporting because it is no longer implied by the
      // milepost: a window opened from the enter gate stands where it was asked
      // to, and parity only decides when nobody said.
      side: s.side ?? null,
      dash: s.dash ?? null,
      x: s.mesh ? Math.round(s.mesh.position.x) : null,
      z: s.mesh ? Math.round(s.mesh.position.z) : null,
      built: !!s.mesh,
      size: s.size ?? null,
    })
    if (s.mesh) out.sweeps.push({ milepost: s.milepost, district: s.district, ...sweepSign(s) })
  }
  out.camera = [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)]
  out.districtNames = ws.list().map((w) => w.name)
  out.districtX = ws.list().map((w) => ws.laneX(w.id))
  return out
}

// THE INCREMENT-1 PROOF. The workspaces are a graph now, and the claim is that
// nothing on screen moved: every lane sits where the old `districtX(index)`
// arithmetic put it, every road in the scene belongs to an open workspace, and
// every window's `district` names a workspace that exists.
//
// `laneMatchesOldArithmetic` is the one that matters -- it recomputes the
// formula this change deleted and compares, rather than trusting that a layout
// which LOOKS right is the same layout.
window.__ws = () => {
  const all = ws.list()
  const OLD_DISTRICT_X = 2600
  const rows = all.map((w, i) => ({
    id: w.id,
    name: w.name,
    open: w.open,
    exits: [...w.exits],
    laneX: ws.laneX(w.id),
    oldX: (i - (all.length - 1) / 2) * OLD_DISTRICT_X,
    windows: [...signs.values()].filter((s) => s.district === w.id).length,
    hasRoad: roads.has(w.id),
  }))
  return {
    root: ws.root(),
    standingIn: state.district,
    span: ws.span(),
    laneMatchesOldArithmetic: rows.every((r) => r.laneX === r.oldX),
    roadsMatchOpenWorkspaces: rows.every((r) => r.hasRoad === r.open) && roads.size === rows.filter((r) => r.open).length,
    everyWindowInAKnownWorkspace: [...signs.values()].every((s) => ws.has(s.district)),
    rows,
  }
}
window.__wsReset = () => ws.reset()

// Closing a road up, on demand. The map already offers it; this is the same call
// with its answer visible, which is the only way to tell "it did nothing" apart
// from "it was never asked".
window.__tidy = (d) => tidyRoad(d ?? state.district)

// THE MULTI-TENANCY PROOF, and the two claims it has to carry are opposites:
//
//   - the ACTIVE network's roads are laid and its lanes still sit exactly where
//     the single-network arithmetic put them (`__ws` above proves that half, and
//     it proves it of whichever network is active);
//   - every OTHER network's roads are NOT laid, and every window standing on one
//     is hidden AND out of the raycast -- which is the half nothing on screen
//     would tell you about, because a window that is quietly stacked at x=0
//     underneath the middle road looks exactly like a window that is not there.
//
// `hiddenMatchesForeign` is the one that matters. It compares what is hidden
// against what the graph says belongs elsewhere, rather than counting either one
// on its own.
window.__tenants = () => {
  const foreign = [...signs.values()].filter((s) => s.mesh && !ws.inActive(s.district))
  const home = [...signs.values()].filter((s) => s.mesh && ws.inActive(s.district))
  return {
    ...ws.report(),
    standingIn: state.district,
    standingInIsActive: ws.inActive(state.district),
    roadsLaid: [...roads.keys()],
    roadsAreAllActive: [...roads.keys()].every((id) => ws.inActive(id)),
    windows: {
      onThisNetwork: home.length,
      onOthers: foreign.length,
      // The two directions of the same claim, so neither can pass by accident.
      hiddenMatchesForeign:
        foreign.every((s) => s.mesh.visible === false) && home.every((s) => s.mesh.visible === true),
      foreignAddresses: foreign.map((s) => `${s.district}:${s.milepost}`),
    },
  }
}

// WHAT IS PAINTED ON THE ROAD. Read off the instance matrices and the instance
// colours rather than recomputed from dashZ -- a report that recomputed them
// would agree with itself whatever the scene contained.
window.__ramps = () => rampReport()

// WHAT DOCUMENTS ARE ON THE ROAD, and at which tier. The tier breakdown is the
// point: "there are 40 panes" and "40 panes are being laid out" are different
// facts and only the second one is a cost. See docs/PAPER_ROADS.md.
window.__papers = () => paperReport()

// RUNG 7. The road you are standing on, as a WRL network, sealed to a `sem-` id.
// The SOURCE comes back with the id on purpose: an identity whose input you cannot
// read is a number you have to trust rather than one you can check.
window.__seal = async (district) => {
  const { sealRoad } = await import('./paper/wiring.js')
  const { papers } = await import('./world.js')
  return sealRoad([...papers.values()], district ?? state.district)
}

// THE SEAM, from the console. `__op` is the same door a click uses -- which is the
// point of OP_VOCABULARY_DRAFT.md §9's test and the reason there is no separate
// "programmatic API" here. The vocabulary IS the API.
window.__op = (op) => applyOp(op, { by: 'program' })
window.__opLog = () => ({ log: opLog(), plan: opPlan(), counts: opCounts() })
window.__opReplay = (steps) => replayOps(steps ?? opPlan(), { by: 'replay' })
window.__opPrecheck = (steps) => precheckOps(steps ?? opPlan())
window.__seedPapers = (d) => seedPapers(d)
window.__clearPapers = () => clearPapers()
window.__placePaper = (doc, opts) => placePaper(doc, opts)

// WHAT SURVIVES A RELOAD ABOUT A WINDOW. Three separate answers on purpose: what
// is stored, what is being asked for right now, and what the surfaces actually
// are -- a shape that is remembered and refused must not read as one that was
// put back.
window.__layout = () => layoutReport()

// A HOVER AIMED FOR REAL, because what is being claimed is what the POINTER does.
//
// The ramp's tarmac lighting up when pointed at -- and staying lit afterwards --
// was reported three times, and each earlier attempt was checked by reading the
// hover state the highlight is drawn from. That state agrees with itself. This
// aims a genuine pointermove at the deck (or at the sign) through the same canvas
// listener a mouse goes through, waits for the frame that would repaint, and
// reports the two MATERIALS either side of it -- including after the pointer has
// left, which is the half that was broken.
window.__hoverRamp = async (which = 'deck') => {
  const canvas = renderer.domElement
  const rect = canvas.getBoundingClientRect()
  // The board is the one with a texture on it; the deck is bare tarmac.
  const mesh = rampMeshes()
    .filter((m) => m.userData?.gantryAction?.kind === 'ramp')
    .find((m) => !!m.material.map === (which === 'board'))
  if (!mesh) return { error: 'no ramp on this road', which }
  // The board colour is written by syncRamps, once a frame -- so a colour read in
  // the same tick as the event is the colour from BEFORE it, and would report a
  // working highlight as broken.
  const settle = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  const colours = () =>
    rampReport().roads.flatMap((road) =>
      road.ramps.map((x) => ({ at: x.at, deck: x.deck.color, board: x.boardLit })),
    )
  // A POINT ON THE SURFACE THAT THE RAY ACTUALLY REACHES, not the bounding-sphere
  // centre. The deck is a curved ribbon, so its sphere centre sits BESIDE the
  // tarmac; and even on the ribbon, the far end can be off-screen or behind a
  // window. Either way the ray comes back holding nothing, and "nothing lit" reads
  // exactly like a fixed highlight while being the opposite of a measurement.
  //
  // So the deck's own vertices are walked until `__aim` -- the pointer's own aiming
  // function, not a copy of it -- says the thing under that pixel is this ramp's
  // tarmac. The board is a plane in clear air and its centre is its centre.
  const at = (world) => {
    const v = world.clone().project(camera)
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height]
  }
  const pos = mesh.geometry.attributes.position
  let clientX, clientY
  if (mesh.material.map) {
    ;[clientX, clientY] = at(mesh.getWorldPosition(new THREE.Vector3()))
  } else {
    for (let i = 0; i < pos.count; i++) {
      const [x, y] = at(mesh.localToWorld(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))))
      const found = window.__aim(x, y)
      if (found?.action?.kind === 'ramp' && !found.textured) {
        clientX = x
        clientY = y
        break
      }
    }
    if (clientX === undefined) return { error: 'no pixel of this ramp deck is reachable', which }
  }
  const before = colours()
  canvas.dispatchEvent(
    new PointerEvent('pointermove', { clientX, clientY, bubbles: true, pointerType: 'mouse' }),
  )
  await settle()
  const during = colours()
  // Out through the same door a real pointer leaves by.
  canvas.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))
  await settle()
  return {
    aimedAt: which,
    screen: [Math.round(clientX), Math.round(clientY)],
    roadColour: '11131f',
    // What the ray found there, so "nothing lit up" can be told apart from
    // "the ray never reached the ramp".
    underThePointer: window.__aim(clientX, clientY),
    before,
    during,
    after: colours(),
  }
}

// The diagnosis, reachable without having to cause the failure. A message that
// only appears when the shell is already dead is a message nobody can check.
window.__whyNoContext = (canvas) => whyNoContext(canvas ?? document.createElement('canvas'))

// THE INCREMENT-2 PROOF. What every gantry is actually advertising, read off the
// panels' own state rather than off the graph -- a lane that agrees with the
// graph by construction would prove nothing about what is on the sign.
window.__gantry = () => gantryReport()

// Drive: move the camera down the road so occlusion by nearer posts is real.
window.__drive = (z) => {
  camera.position.z = z
  camera.lookAt(0, 105, z - 900)
  return camera.position.z
}

window.__tubes = () => ({
  reader: state.tubeReader,
  polls: state.tubePolls,
  error: state.tubeError,
  over: rack ? rack.overRedline() : null,
  // WHAT THE BRIDGE SAID, and separately WHAT WAS PAINTED. This used to be one
  // object because the mesh WAS the drawing -- `fill.scale.y` and
  // `fill.material.color` were the picture, read straight off it. The rack is a
  // model and a 2D panel now, so the two are split rather than merged: `said`
  // is the payload, `drawn` is dash.js writing down what it actually put on the
  // canvas. A report that recomputed the second from the first would agree with
  // itself no matter what the cockpit did.
  said: rack ? Object.fromEntries(Object.entries(rack.tubes).map(([k, t]) => [k, t.data && {
    value: t.data.value, n: t.data.n, bar: t.data.bar, why: t.data.why,
  }])) : null,
  drawn: dash ? dash.report().tubes : null,
  why: document.getElementById('why')?.textContent ?? null,
})

// The cockpit's own numbers: how big it is, how far it is pushed out of the
// frame, and the two dials -- which are measured in dash.js off the camera and
// the clock, not handed to it.
// IS THE COMPOSITOR ACTUALLY BEING PACED, and at what. Every field is measured
// here rather than assumed: `wrapped` false with `on` true means the install
// never ran, which looks exactly like a pacer that is running and finding nothing
// to defer -- and those are opposite facts. `hz` 0 is "full rate, nothing to do",
// which is the correct state whenever the page is being used.
window.__pace = () => ({
  on: PACE_CLIENTS,
  wrapped: !!pacing.fire,
  hz: pace(performance.now()),
  quietMs: Math.round(performance.now() - lastInput),
  deferred: pacing.deferred,
  passed: pacing.passed,
  pending: !!pacing.timer,
})

// IS THIS WINDOW BEING FED, AND IF NOT, WHOSE FAULT IS IT.
//
// Two sessions have now started from "the client is waiting for permission to
// draw" and that has never once been true. Measured, on this machine, with no
// input at all for 82 seconds: five web clients held ~28 fps each and a native
// glxgears held ~45 fps. Frame callbacks fire. They fire for the two classes of
// client by COMPLETELY DIFFERENT ROUTES, which is the fact that keeps getting
// missed:
//
//   web    -- Greenfield's `Renderer.render()` collects the surface's pending
//             `wl_surface.frame` callbacks and fires them after its rAF. That is
//             the path `paceCompositor` throttles, so braking the shell really
//             does stop a web client painting.
//   native -- compositor-proxy answers the application's frame callbacks ITSELF,
//             off its own `setInterval` (FrameFeedback.js). The browser's only
//             say is a once-a-second encoder-feedback message, and the proxy
//             parks callbacks only if that message goes 1500 ms stale. Nothing
//             the shell draws, defers or suppresses grants a native app its next
//             frame.
//
// So a native window that looks frozen is not starved: either the client has
// nothing to paint, or the BRAKE has capped how often its decoded frame reaches
// the glass -- 10 Hz after a minute untouched, 1 Hz after ten, and full rate the
// moment anything is touched or the mode leaves `driving`. `hz` here is that cap
// and it is the first field to read.
//
// `fps` is measured BETWEEN CALLS and is therefore null on the first one. That
// is deliberate: a rate invented from a single sample is the kind of number that
// gets quoted back as evidence.
window.__fed = () => {
  const now = performance.now()
  return {
    mode: state.mode,
    hz: pace(now), // 0 = uncapped
    quietMs: Math.round(now - lastInput),
    windows: (session?.renderer?.topLevelViews ?? []).map((view) => {
      const rs = view.renderStates[SCENE_ID]
      const f = rs ? fedByRenderState.get(rs) : undefined
      const dt = f?.at ? now - f.at : 0
      const d = f ? f.n - f.was : 0
      if (f) {
        f.was = f.n
        f.at = now
      }
      return {
        at: keyOf(view),
        title: titles.get(keyOf(view)) ?? null,
        // The one honest test for "does this window's picture come over the
        // wire": a surface only has an encoderFeedback if the remote launcher
        // built one for it. Role name cannot say -- a native app is an
        // XdgToplevel exactly like a web one.
        native: !!view.surface.encoderFeedback,
        size: rs?.size ? { w: rs.size.width, h: rs.size.height } : null,
        frames: f?.n ?? 0,
        fps: dt > 0 ? Math.round((d / dt) * 1000 * 10) / 10 : null,
      }
    }),
  }
}

// DID A POINTER EVENT REACH AN APPLICATION WITHOUT GOING THROUGH THE SHELL?
//
// `dropped` counts events Greenfield's own canvas listeners tried to queue --
// out on the road that was every move, every click and the pointer capture that
// came with it, aimed at whichever client lay under a flat-desktop coordinate
// that means nothing in a perspective scene. Non-zero while driving is the
// passthrough; `passed` is the shell's own properly-mapped sends.
//
// Both counts together, because "the click did nothing" and "the click went
// somewhere else" look identical from outside and only one of them is this.
window.__inputGate = () => ({ ...inputGate, byKind: { ...inputGate.byKind }, mode: state.mode })

window.__dash = () => (dash ? dash.report() : null)

// WHAT THE COCKPIT CLAIMS AT A GIVEN PIXEL, answered by the SAME hook the
// pointer handler calls -- the discipline `__aim` already keeps. A probe with
// its own copy of the arithmetic could answer about a gate the real handler
// never consults, and "the shifter does not respond" would then mean "the hit
// test is wrong" and "the handler never asks" indistinguishably.
//
// It really does knock the stick, because `hooks.dashHit` is the thing that
// does that -- a read-only probe would be testing a different function.
window.__dashAt = (x, y) => (hooks.dashHit ? hooks.dashHit(x, y) : null)

// The broadcast, from both ends: what the ledger believes and what the quad
// actually drew. Kept apart on purpose -- `list` is the shell's intent and
// `tv` is the picture, and a report that computed the second from the first
// would agree with itself no matter what the screen was doing.
window.__cast = () => ({
  // `live` as well as `alive`, because they are different questions and the
  // report was missing the one a reader actually asks. `alive` is "does this
  // window still exist"; `live` is "is this the chip lit on the TV". Without the
  // second, a test of the toggle reads the first, sees no change, and concludes
  // the toggle is broken -- which is exactly what happened.
  list: [...castList].map((k) => ({
    key: k, label: labelOfKey(k), alive: signs.has(k), live: k === onAirKey,
  })),
  onAir: onAirKey,
  rect: dash ? dash.tvRect() : null,
  tv: tv ? tv.report() : null,
})

// Raw view tree, for looking at what the compositor actually did with a popup
// before deciding how to draw it.
// IDENTITY, NOT EQUALITY. Two signs showing one picture and one showing none is
// what "the wrong window" looks like, and the only way to tell it from a drawing
// bug is to ask whether the two views point at the SAME WebGLTexture. Numbered
// through a WeakMap so the answer is comparable inside one report and nothing is
// retained.
const texIds = new WeakMap()
let nextTexId = 1
const texIdOf = (t) => {
  if (!t) return null
  if (!texIds.has(t)) texIds.set(t, nextTexId++)
  return texIds.get(t)
}

// WHAT IS ACTUALLY IN THE SURFACE, in surface pixels, read off the adopted
// render target rather than inferred from a screenshot.
//
// The black band along the top of native windows has been argued about from
// screenshots three times and every argument needed a scale factor nobody had
// measured. This reads a column and a row of the real thing and says how many
// pixels at each edge are black -- so "the client painted that" and "we sampled
// the wrong rectangle" stop being indistinguishable.
//
// GL readback is BOTTOM-UP: index 0 of the column is the surface's BOTTOM row.
//
// IT CANNOT READ THE SIGN'S OWN TARGET. `adoptSurfaceTexture` attaches
// Greenfield's texture with `setRenderTargetTextures`, and reading that back
// returns all zeros with alpha 0 -- measured, on windows that were visibly
// rendering a bright test pattern at the time. So the texture is drawn through
// a target this file owns, with the SAME material settings the sign uses, and
// that copy is what gets read. What comes back is then what the glass shows.
let probeRT = null, probeScene = null, probeCam = null, probeMat = null
function probeSetup(w, h) {
  if (!probeScene) {
    probeScene = new THREE.Scene()
    probeCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1)
    // NoBlending, AND IT IS THE DIFFERENCE BETWEEN THIS PROBE WORKING AND NOT.
    //
    // `topAlpha`/`midAlpha` below exist for exactly one job: telling a region
    // that is TRANSPARENT from one that is BLACK, because they look identical on
    // the glass and are different faults. As first written they could not do it.
    // three sets a material's `opaque` program parameter from
    // `material.transparent === false && material.blending === NormalBlending`,
    // and `opaque_fragment` then runs `#ifdef OPAQUE diffuseColor.a = 1.0`, so a
    // default MeshBasicMaterial pins the readback alpha at 255 for every sign in
    // every state -- including a texture that has never been written once.
    // Two fields that always answered 255 were quoted as evidence.
    //
    // NoBlending clears `opaque` so the texture's own alpha survives into the
    // target, and still writes the fragment straight in rather than compositing
    // it. The RGB path is unchanged, so `black*` keeps meaning what it meant.
    probeMat = new THREE.MeshBasicMaterial({ toneMapped: false, blending: THREE.NoBlending })
    probeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), probeMat))
  }
  if (!probeRT || probeRT.width !== w || probeRT.height !== h) {
    probeRT?.dispose()
    probeRT = new THREE.WebGLRenderTarget(w, h)
  }
  return probeRT
}

window.__edges = (thresh = 8) =>
  [...signs.values()]
    .filter((s) => s.tex && s.size)
    .map((s) => {
      const w = s.size.width, h = s.size.height
      const col = new Uint8Array(h * 4)
      const row = new Uint8Array(w * 4)
      try {
        const rt = probeSetup(w, h)
        probeMat.map = s.tex
        probeMat.needsUpdate = true
        const prev = renderer.getRenderTarget()
        renderer.setRenderTarget(rt)
        renderer.render(probeScene, probeCam)
        renderer.setRenderTarget(prev)
        renderer.resetState()
        renderer.readRenderTargetPixels(rt, Math.floor(w / 2), 0, 1, h, col)
        renderer.readRenderTargetPixels(rt, 0, Math.floor(h / 2), w, 1, row)
      } catch (e) {
        return { at: `${s.district}:${s.milepost}`, error: String(e) }
      }
      const dark = (buf, i) => buf[i * 4] <= thresh && buf[i * 4 + 1] <= thresh && buf[i * 4 + 2] <= thresh
      let bottom = 0; while (bottom < h && dark(col, bottom)) bottom++
      let top = 0; while (top < h && dark(col, h - 1 - top)) top++
      let left = 0; while (left < w && dark(row, left)) left++
      let right = 0; while (right < w && dark(row, w - 1 - right)) right++
      return {
        at: `${s.district}:${s.milepost}`,
        size: [w, h],
        // Black pixels at each edge of the SURFACE, in surface pixels.
        blackTop: top, blackBottom: bottom, blackLeft: left, blackRight: right,
        // The alpha at the very top-left, because a transparent region and a
        // black one look identical on the glass and are different faults.
        topAlpha: col[(h - 1) * 4 + 3],
        midAlpha: col[Math.floor(h / 2) * 4 + 3],
      }
    })

window.__views = () =>
  session.renderer.topLevelViews.map((v) => {
    // THE TWO SIZES `adoptSurfaceTexture` DIVIDES, reported rather than inferred.
    // A window whose picture does not fill its sign is one of these disagreeing,
    // and from outside they are indistinguishable: the surface being smaller
    // than the sign, the texture being bigger than the surface, and the picture
    // being written to the wrong corner all look like "it does not line up".
    // `size` is what the quad is built from; `texSize` is the destination
    // texture the encoder's padding decides; `uv` is the sub-rect actually
    // sampled. If uv is far from 1, the margin is real and this says how much.
    const rs = v.renderStates?.[SCENE_ID]
    const size = rs?.size ? { w: rs.size.width, h: rs.size.height } : null
    const texSize = rs?.texture?.size ? { w: rs.texture.size.width, h: rs.texture.size.height } : null
    return {
      key: keyOf(v),
      role: v.surface.role?.constructor?.name ?? null,
      hasParent: !!v.surface.parent,
      parentKey: v.surface.parent?.role?.view ? keyOf(v.surface.parent.role.view) : null,
      rect: [v.regionRect.x0, v.regionRect.y0, v.regionRect.x1, v.regionRect.y1],
      mapped: v.mapped,
      hasBuffer: !!v.surface.state.bufferContents,
      knownAsSign: signs.has(keyOf(v)),
      size,
      texSize,
      // THE DECODER'S CODED SIZE, BESIDE THE ALLOCATION IT IS NOT.
      //
      // `texSize` is the destination texture Greenfield allocated
      // (`setContentBuffer(null, opaque.codedSize)`); `decoderCoded` is what the
      // VideoDecoder called the frame. The UVs are computed from `texSize` and
      // ONLY from it. These are reported side by side because they DISAGREE and
      // the disagreement was the bug: measured on one gnome-text-editor frame,
      // texSize 1024x640 against decoderCoded 1024x**642**, and the old
      // arithmetic divided by the second.
      //
      // `codedFromThisSurface` is the sharper half. `decodeGeom` is ONE
      // module-global -- the last decode from ANY surface -- and the stamp's only
      // guard is that the coded size contains this surface and is under twice it.
      // A small dialog beside a big window passes that test easily and gets the
      // big window's number, which under the old `padX = tw - width` slid the
      // sampled rect clean off the picture. **That is a window that is simply
      // black**, and it is what "Restore Session, black glass" has been every
      // time it has been photographed. False here means the stamp is not this
      // surface's; it no longer changes what is drawn, only what this says.
      decoderCoded: rs?.__codedSize ? { w: rs.__codedSize.w, h: rs.__codedSize.h } : null,
      codedFromThisSurface: !!(rs?.__codedSize && texSize &&
        rs.__codedSize.w === texSize.w && rs.__codedSize.h === texSize.h),
      // THE WINDOW RECT THE CLIENT DECLARED, which is not the buffer it painted.
      // A client drawing its own decorations paints a shadow into the buffer and
      // then calls `xdg_surface.set_window_geometry` to say which part of it is
      // actually the window. Size the sign off the buffer and the frame stands
      // off the visible edge by however much shadow there is.
      geom: (() => {
        const g = v.surface?.geometry
        return g?.size ? { x: g.x0, y: g.y0, w: g.size.width, h: g.size.height } : null
      })(),
      // THE QUAD ITSELF, and the surface size it was BUILT from -- which is the
      // pair that says whether a sign is stale. `makeSign` fixes the width at
      // SIGN_W and takes the aspect from the surface at the moment it builds, so
      // sign and surface agree by construction and can only disagree by the
      // rebuild not having happened. Reporting only the quad would hide that;
      // reporting only the surface would hide it the other way.
      sign: (() => {
        const sg = signs.get(keyOf(v))
        const p = sg?.mesh?.geometry?.parameters
        if (!p) return null
        return {
          w: +p.width.toFixed(2),
          h: +p.height.toFixed(2),
          builtFrom: sg.size ? { w: sg.size.width, h: sg.size.height } : null,
          // Same number from both sides. If these differ the quad is showing a
          // shape the surface has stopped being.
          aspect: +(p.width / p.height).toFixed(4),
          surfaceAspect: size ? +(size.w / size.h).toFixed(4) : null,
          // What windowRectOf actually returned for this sign. `geom` says what
          // the client declared; this says whether the shell accepted it. The two
          // disagreeing silently is what cost a whole round of guessing.
          crop: sg.crop ?? null,
        }
      })(),
      uv: size && texSize ? { sx: +(size.w / texSize.w).toFixed(4), sy: +(size.h / texSize.h).toFixed(4) } : null,
      // Two views reporting the same texId ARE the same picture, whatever their
      // titles say.
      texId: texIdOf(rs?.texture?.texture),
      // WHY A WINDOW WILL NOT RESIZE, asked the same way startResize asks it --
      // by shape, because minification renames the class and every check keyed
      // on a constructor name is already dead in the shipped bundle.
      canResize: typeof v.surface.role?.configureSize === 'function',
      roleName: v.surface.role?.constructor?.name ?? null,
      // What the client actually painted, which need not be either of the above.
      buffer: (() => {
        const b = v.surface.state.bufferContents
        return b?.size ? { w: b.size.width, h: b.size.height } : null
      })(),
    }
  })

// Aim at a POPUP's centre and report where Greenfield resolved it. The proof
// that a menu is clickable, not decorative.
window.__pointAtPopup = () => {
  for (const sign of signs.values()) {
    if (!sign.mesh || !sign.popups?.size) continue
    const [q] = [...sign.popups.values()]
    const world = q.mesh.getWorldPosition(new THREE.Vector3())
    const v = world.project(camera)
    const ev = {
      clientX: ((v.x + 1) / 2) * renderer.domElement.width,
      clientY: ((1 - v.y) / 2) * renderer.domElement.height,
      timeStamp: performance.now(),
      buttons: 0,
      button: 0,
    }
    sendMotion(ev)
    const pv = q.mesh.userData.popupView
    const picked = session.renderer.pickView({ x: state.lastScenePoint[0], y: state.lastScenePoint[1] })
    return {
      popupRect: [pv.regionRect.x0, pv.regionRect.y0, pv.regionRect.x1, pv.regionRect.y1],
      parentRect: [sign.view.regionRect.x0, sign.view.regionRect.y0, sign.view.regionRect.x1, sign.view.regionRect.y1],
      scenePoint: state.lastScenePoint,
      hitPopupQuad: state.lastWasPopup,
      resolvedToPopup: picked ? keyOf(picked) === keyOf(pv) : false,
      resolvedTo: picked ? keyOf(picked) : null,
    }
  }
  return null
}

// Say what happened, and KEEP saying it, for the benefit of a browser that
// cannot be asked. `?report=15` posts state every 15 seconds.
//
// IT USED TO FIRE ONCE, and that made it useless for the questions it was built
// to answer. A one-shot report describes the shell as it was `secs` after boot,
// so anything about a WINDOW had to be asked by guessing -- before the page
// loaded, in a shell script -- how long it would take to open one. Every
// diagnosis needing two programs up at the same time was a race against a timer
// set in the past. Repeating costs one POST per interval to a server on the same
// machine, and `grep REPORT | tail -1` becomes "what is true now".
{
  const secs = Number(new URLSearchParams(location.search).get('report'))
  if (Number.isFinite(secs) && secs > 0) {
    // Re-armed AFTER each POST settles rather than on a fixed interval: a bridge
    // that stops answering must not leave an unbounded queue of reports behind
    // it. One in flight, always.
    const post = async () => {
      const t = window.__m1()
      const tubes = window.__tubes()
      // CAN THIS BROWSER DECODE AT ALL. Asked rather than assumed: the target is
      // Firefox on FreeBSD, and "the h264 path is dark" has one cause here that
      // no amount of looking at the compositor would ever find.
      let h264 = 'not asked'
      try {
        h264 = typeof VideoDecoder === 'undefined'
          ? 'no VideoDecoder'
          : JSON.stringify(await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f' }))
      } catch (e) {
        h264 = `threw: ${e}`
      }
      return fetch(`${TUBE_BRIDGE}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ua: navigator.userAgent.slice(0, 60),
          crossOriginIsolated: window.crossOriginIsolated,
          sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
          webglVendor: (() => {
            try {
              const d = gl.getExtension('WEBGL_debug_renderer_info')
              return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
            } catch (e) {
              return 'unavailable'
            }
          })(),
          compositor: t.compositor,
          surfaces: t.surfaces,
          signs: t.signs,
          frames: t.frames,
          districts: t.districtNames,
          tubeReader: tubes.reader,
          tubePolls: tubes.polls,
          error: t.error,
          frameError: t.frameError,
          // THE THREE FIELDS THAT TELL THE FAILURES APART. "A native program does
          // not appear" has distinct causes that look identical from outside, and
          // each of these separates a pair of them:
          //
          //   proxyBase       -- did `?proxy=` reach the shell at all, or is it
          //                      still talking to a port that is not there
          //   appStates       -- did the LAUNCH fail, or did it succeed and the
          //                      picture not arrive
          //   views           -- THE decisive one. A view with `hasBuffer` and
          //                      `knownAsSign:false` means the surface arrived and
          //                      the road did not build a sign for it; no view at
          //                      all means nothing ever arrived. Those two have
          //                      nothing in common and were being guessed between.
          proxyBase: PROXY_BASE,
          programsFrom,
          appStates: t.appStates ?? null,
          lastLaunch: t.lastLaunch ?? null,
          // Whether the power key ever reached the bridge, and what it said. The
          // dash's own `powerWhy` is the same sentence; this is the status code
          // and the pid behind it, which the plate has no room for.
          lastLogout: t.lastLogout ?? null,
          spawned: t.spawned ?? null,
          // DID A PICTURE EVER ARRIVE, counted rather than assumed. See
          // `fenceScenePasses`. A black window with `video/h264: 0` is a
          // transport or decode fault; the same window with a non-zero count is
          // a fault in what was drawn, and those two have nothing in common.
          passes: window.__passes(),
          views: window.__views(),
          // Black pixels at each edge of each surface, measured. In here rather
          // than only on `window` because the machine this question is about is
          // a kiosk with no console.
          edges: window.__edges(),
          decode: decodeGeom,
          h264,
          errors: errorLog,
        }),
      }).catch(() => {})
    }
    const tick = () => post().catch(() => {}).finally(() => setTimeout(tick, secs * 1000))
    setTimeout(tick, secs * 1000)
  }
}

// Takes an id, or an index into the layout for everything written against the
// old numeric districts (`__district(1)` still means the second road).
window.__district = (d) => goDistrict(typeof d === 'number' ? ws.at(d)?.id : d)

// TEN TRAILS, AND WHICH ONE YOU ARE ON. `__tracks(n)` switches, `__tracks()`
// reports -- and the report says where each one is parked and what is behind it,
// because the whole claim being made is that those differ per track while the
// road they are on may not.
window.__tracks = (n) => {
  if (n !== undefined) goTrack(Number(n))
  const r = tracks.report()
  return {
    ...r,
    standingOn: state.district,
    backTarget: backTarget(),
    tracks: r.tracks.map((t) => ({ ...t, name: t.name || null, on: t.at ? (ws.get(t.at)?.name ?? t.at) : null })),
  }
}
// The door counters that found the `[hidden]` bug are gone. What they proved is
// worth keeping as a note rather than as code: every handler in the chain was
// working, and the only broken thing was a CSS rule that made the result
// invisible. When a control "does not respond", measure whether its EFFECT is
// reaching the screen before measuring whether its input is reaching the code.
window.__tracksReset = () => tracks.reset()
// The reel, and the recording a row is claiming. `__rec` prints the STEPS --
// `__tracks` deliberately prints only their count, because a few thousand of
// them in a console buries everything else in the report.
window.__reel = (openIt) => {
  if (openIt === false) closeReel()
  else if (openIt === true) openReel()
  return reelReport()
}
window.__rec = (id) => tracks.recordingOf(id ?? tracks.activeIndex())
// REPLAY, from a console. `__plan` asks what a track assumes WITHOUT driving it,
// which is the probe worth having: "would this run, and if not which step" is a
// question you want answered before the camera starts moving.
window.__plan = (id) => tracks.precheck(id ?? tracks.activeIndex())
window.__replay = (id, gap) => replayTrack(id ?? tracks.activeIndex(), gap ? { gap } : {})
window.__replayStop = () => { stopReplay('console'); transportStop() }
window.__replayState = () => ({
  running: isReplaying(), now: replayState(), last: state.lastReplay ?? null, transport: transportReport(),
})
// The transport from a console, so "the bar does not respond" and "the bar is
// not wired" stop looking the same.
window.__walk = (id) => {
  const out = replayTrack(id ?? tracks.activeIndex(), { paused: true })
  if (out.started) transportStart()
  return out
}
window.__step = () => (stepReplay(), replayState())
window.__back = () => (stepBack(), replayState())
window.__pause = () => (pauseReplay(), replayState())
window.__play = () => (resumeReplay(), replayState())
window.__map = (openIt) => {
  if (openIt === false) closeMap()
  else if (openIt === true) openMap()
  return mapReport()
}

// MOVING A WINDOW, PROVED FROM THE SCENE.
//
// The three moves change three fields on a record and nothing else -- the mesh
// is put right by syncPlacement on the next frame. So a report taken from the
// record would only be telling you that an assignment happened. This waits a
// frame and reads the MESH, which is the only thing that can say the window
// actually went anywhere.
//
//   __moveWindow('home', 2, 'flip')      cross the road
//   __moveWindow('home', 2, -1)          one place nearer the entrance
//   __moveWindow('home', 2, 'build')     onto another road entirely
window.__moveWindow = (district, milepost, what) => {
  const before = [...signs.values()].find((s) => s.district === district && s.milepost === milepost && s.mesh)
  const from = before ? { district, milepost, side: before.side, dash: before.dash, x: Math.round(before.mesh.position.x), z: Math.round(before.mesh.position.z) } : null
  const asked =
    what === 'flip'
      ? flipWindowSide(district, milepost)
      : typeof what === 'number'
        ? nudgeWindowAlong(district, milepost, what)
        : moveWindowTo(district, milepost, what)
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const s = asked && [...signs.values()].find((x) => x.district === asked.district && x.milepost === asked.milepost && x.mesh)
        resolve({
          from,
          asked,
          mesh: s ? { x: Math.round(s.mesh.position.x), z: Math.round(s.mesh.position.z), turn: +s.mesh.rotation.y.toFixed(3) } : null,
          // The claim, checked rather than asserted: the mesh is where the
          // record now says it should be, and the frame and post came with it.
          placed: !!s && Math.round(s.mesh.position.z) === Math.round(windowZ(s.dash)),
          togetherWithFurniture:
            !!s && !!s.post && Math.round(s.post.position.x) === Math.round(s.mesh.position.x) && Math.round(s.post.position.z) === Math.round(s.mesh.position.z),
        })
      }),
    ),
  )
}

// THE M4 PROOF. Every window must occupy its OWN rect in the ledger, and
// pickView must resolve each one's centre to that window -- WITHOUT relying on
// the flatten having raised it (§12.3). If this passes, the ledger is
// addressable by position and routing no longer depends on stacking order.
window.__ledger = () => {
  const rows = []
  for (const s of signs.values()) {
    if (!s.view) continue
    const r = s.view.regionRect
    const cx = (r.x0 + r.x1) / 2
    const cy = (r.y0 + r.y1) / 2
    const picked = session.renderer.pickView({ x: cx, y: cy })
    rows.push({
      district: s.district,
      milepost: s.milepost,
      slot: s.slot,
      rect: [r.x0, r.y0, r.x1, r.y1],
      centre: [cx, cy],
      resolvesToSelf: picked ? keyOf(picked) === keyOf(s.view) : false,
    })
  }
  const keys = new Set(rows.map((r) => r.rect.join(',')))
  state.ledgerDistinct = keys.size === rows.length
  return { distinctRects: keys.size === rows.length, rows }
}

// IS THE WHOLE SIGN ON SCREEN? Projects the mesh's own four corners, so it
// measures what is drawn rather than agreeing with the arithmetic that placed
// the camera. `__flatMetrics` does the same thing for the flatten, and for the
// same reason: the first road-view distance was a constant that put the sign's
// top edge one pixel above the viewport, and nothing in the shell could say so.
window.__onScreen = (district = state.district, milepost = state.lastMapPick?.milepost) => {
  const s = [...signs.values()].find((x) => x.district === district && x.milepost === milepost && x.mesh)
  if (!s) return { found: false, district, milepost }
  const g = s.mesh.geometry.parameters
  const W = renderer.domElement.width
  const H = renderer.domElement.height
  const corner = (sx, sy) => {
    const v = s.mesh.localToWorld(new THREE.Vector3((g.width / 2) * sx, (g.height / 2) * sy, 0)).project(camera)
    return [+(((v.x + 1) / 2) * W).toFixed(1), +(((1 - v.y) / 2) * H).toFixed(1)]
  }
  const pts = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    found: true,
    district,
    milepost,
    viewport: [W, H],
    corners: pts,
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => +n.toFixed(1)),
    fullyOnScreen: Math.min(...xs) >= 0 && Math.min(...ys) >= 0 && Math.max(...xs) <= W && Math.max(...ys) <= H,
    // How much of each axis it uses. Fully on screen but 3% tall would be a
    // different complaint with the same answer.
    coverage: [+((Math.max(...xs) - Math.min(...xs)) / W).toFixed(3), +((Math.max(...ys) - Math.min(...ys)) / H).toFixed(3)],
  }
}

// THE RESIZE PROOF. Drives the real grab at its real screen position, so it
// exercises the same path a hand does rather than a private shortcut, and
// reports what the surface actually became -- the client has to ack the
// configure and reallocate, so the number that matters is the one measured
// after, not the one asked for.
window.__resize = (dx = 120, dy = 90) => {
  const before = [...signs.values()]
    .filter((s) => s.district === state.flatDistrict && s.milepost === state.flatMilepost)
    .map((s) => [s.size.width, s.size.height])[0]
  const grab = handlePoint()
  const r = resizeFlatBy(dx, dy)
  return { grabAtScreen: grab && [Math.round(grab.x), Math.round(grab.y)], before, ...r }
}
// Where the grab is, WITHOUT touching anything. `__resize(0,0)` was being used
// for this and it is not a read: it starts and ends a real drag, which sends a
// no-op configure and leaves the pacing believing the client has just caught up.
// A probe with side effects measures the probe.
// DOES THE GRAB COVER ANY OF THE APPLICATION? Projects the surface quad and the
// two grab meshes and intersects their screen boxes, so "it does not obstruct
// the window" is a measurement rather than a claim. The hit pad is included
// because an invisible target over the client area still eats the click.
window.__grabClear = () => {
  const s = [...signs.values()].find(
    (x) => x.mesh && x.district === state.flatDistrict && x.milepost === state.flatMilepost,
  )
  if (!s) return { found: false }
  const W = renderer.domElement.width
  const H = renderer.domElement.height
  const boxOf = (obj, w, h) => {
    const pts = [
      [-0.5, 0.5],
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, -0.5],
    ].map(([u, v]) => {
      const p = obj.localToWorld(new THREE.Vector3(w * u, h * v, 0)).project(camera)
      return [((p.x + 1) / 2) * W, ((1 - p.y) / 2) * H]
    })
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => +n.toFixed(1))
  }
  const overlap = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    return w > 0.5 && h > 0.5 ? [+w.toFixed(1), +h.toFixed(1)] : null
  }
  const g = s.mesh.geometry.parameters
  const surface = boxOf(s.mesh, g.width, g.height)
  const grip = s.handle ? boxOf(s.handle, s.handle.geometry.parameters.width, s.handle.geometry.parameters.height) : null
  const pad = s.grabPad ? boxOf(s.grabPad, s.grabPad.geometry.parameters.width, s.grabPad.geometry.parameters.height) : null
  return {
    found: true,
    surface,
    grip,
    pad,
    gripOverlapsSurface: grip ? overlap(surface, grip) : null,
    padOverlapsSurface: pad ? overlap(surface, pad) : null,
    clear: !(grip && overlap(surface, grip)) && !(pad && overlap(surface, pad)),
  }
}

window.__grabPoint = () => {
  const p = handlePoint()
  return p ? [Math.round(p.x), Math.round(p.y)] : null
}

// WHERE ANY CHROME CONTROL IS ON SCREEN, by the name the input handler knows it by:
// `grabPad`, `closePad`, `platePad`, `prevPad`, `nextPad`, `keepPad`, `shutPad`.
//
// `__grabPoint` answers this for exactly one of the seven, and a control that has to
// be pressed and then ANSWERED cannot be driven without the other two -- so rather
// than grow a third one-off, this is the general form. `armed` comes back with the
// point because a pad that is not armed is not pressable, and "the click did
// nothing" and "the control was not live" are the two explanations that look
// identical from outside.
window.__chromePoint = (which) => {
  const s = [...signs.values()].find(
    (x) => x.district === state.flatDistrict && x.milepost === state.flatMilepost,
  )
  const pad = s?.[which]
  if (!pad) return null
  const v = pad.getWorldPosition(new THREE.Vector3()).project(camera)
  const rect = renderer.domElement.getBoundingClientRect()
  return {
    at: [
      Math.round(rect.left + ((v.x + 1) / 2) * rect.width),
      Math.round(rect.top + ((1 - v.y) / 2) * rect.height),
    ],
    armed: !!pad.userData.armed,
    drawn: !!s[which.replace('Pad', 'Btn')]?.visible,
  }
}
window.__resized = () =>
  [...signs.values()]
    .filter((s) => s.district === state.flatDistrict && s.milepost === state.flatMilepost)
    .map((s) => ({ milepost: s.milepost, size: s.size, mesh: s.mesh ? [s.mesh.geometry.parameters.width, +s.mesh.geometry.parameters.height.toFixed(1)] : null }))[0]

window.__flatten = (m) => flattenTo(m)
window.__release = () => release()

// THE M2 PROOF. A flattened sign must measure EXACTLY the surface's pixel size
// on screen -- that is what "pixel-exact" claims, and it is checkable rather
// than admired. Measured off the mesh's own corners, not off the formula that
// positioned the camera, or it would be testing the arithmetic against itself.
window.__flatMetrics = () => {
  const s = [...signs.values()].find(
    (x) => x.milepost === state.flatMilepost && x.district === state.flatDistrict && x.mesh,
  )
  if (!s) return { flat: false, mode: state.mode }
  const g = s.mesh.geometry.parameters
  const corner = (sx, sy) => {
    const v = s.mesh.localToWorld(new THREE.Vector3((g.width / 2) * sx, (g.height / 2) * sy, 0)).project(camera)
    return [((v.x + 1) / 2) * renderer.domElement.width, ((1 - v.y) / 2) * renderer.domElement.height]
  }
  const tl = corner(-1, 1)
  const tr = corner(1, 1)
  const bl = corner(-1, -1)
  const br = corner(1, -1)
  const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1])
  const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1])
  return {
    flat: state.mode === 'flat',
    milepost: state.flatMilepost,
    surfacePx: [s.size.width, s.size.height],
    screenPx: [+w.toFixed(2), +h.toFixed(2)],
    // Fronto-parallel: the top and bottom edges must be the SAME length. A sign
    // still at an angle has a near edge longer than its far edge, and that is
    // invisible in a screenshot at small angles.
    topWidth: +w.toFixed(2),
    bottomWidth: +Math.hypot(br[0] - bl[0], br[1] - bl[1]).toFixed(2),
    scale: +(w / s.size.width).toFixed(4),
  }
}

// Drive a pointer at a given UV of the flat sign and report where Greenfield
// resolved it. Synthetic events do not always reach a real listener (PARKVPS
// found that with noVNC), so this calls the same path the listener calls.
window.__pointAt = (u, v) => {
  const s = [...signs.values()].find(
    (x) => x.milepost === state.flatMilepost && x.district === state.flatDistrict && x.mesh,
  )
  if (!s) return null
  const g = s.mesh.geometry.parameters
  const world = s.mesh.localToWorld(new THREE.Vector3(g.width * (u - 0.5), g.height * (0.5 - v), 0))
  const p = world.project(camera)
  const ev = {
    clientX: ((p.x + 1) / 2) * renderer.domElement.width,
    clientY: ((1 - p.y) / 2) * renderer.domElement.height,
    timeStamp: performance.now(),
    buttons: 0,
    button: 0,
  }
  sendMotion(ev)
  return {
    aimedUV: [u, v],
    expectedSurfacePx: [Math.round(u * s.size.width), Math.round(v * s.size.height)],
    scenePoint: state.lastScenePoint,
    viewRect: [s.view.regionRect.x0, s.view.regionRect.y0, s.view.regionRect.x1, s.view.regionRect.y1],
    pickMatchedAimedSurface: state.lastPickMatched,
  }
}

// ---------------------------------------------------------- the compositor

async function main() {
  const status = document.getElementById('status')
  // ANYTHING WORTH SAYING UN-HIDES THE PANEL. The road-count branch hides it once
  // the hint is gone (see above), so a boot message written into a hidden element
  // would be a failure reported nowhere -- exactly what this mechanism exists to
  // prevent.
  const say = (t) => {
    if (!status) return
    status.textContent = t
    status.hidden = !t
  }
  // The same line, reachable from module scope. `loseContext` fires from a canvas
  // event that has no way into this closure, and a failure nobody can see reported
  // is the failure this whole mechanism exists to stop being.
  sayLine = say
  // A read-only handle on the same object the HUD reads. Every measurement in
  // the spec so far had to be taken by editing the shell to print it; this
  // makes the numbers reachable from outside without a rebuild.
  window.rrabbit = state
  window.rrabbitGl = () => gl
  // Surface vs decoded-texture geometry, per sign. The h264 path pads to
  // macroblocks, so these two are NOT the same rectangle, and every question
  // about a sheared or offset frame is a question about the difference.
  window.rrabbitSurfaces = () =>
    [...signs.entries()].map(([k, s]) => {
      const rs = s.view?.renderStates?.[SCENE_ID]
      return {
        key: k,
        mime: s.view?.surface?.state?.bufferContents?.mimeType ?? null,
        surface: rs?.size ? { w: rs.size.width, h: rs.size.height } : null,
        texture: rs?.texture?.size ? { w: rs.texture.size.width, h: rs.texture.size.height } : null,
      }
    })

  try {
    buildWorld(document.getElementById('gl'))
    frame()

    await initWasm()

    // A NEW SESSION ID PER PAGE LOAD. This was the constant 'rrabbit-m1', and
    // the proxy keys its own session off it -- so reloading the shell rejoined
    // a proxy session whose client was bound to a browser connection that no
    // longer existed. The symptom is a session that reports `app: open` and
    // `surfaces: 0` with the application still running, and the documented
    // workaround was to restart the proxy between runs.
    //
    // Reloading is what you do all day while building this, so the default is
    // a clean session; `?session=<id>` pins one for the case where rejoining
    // deliberately is the point.
    const sessionId =
      new URLSearchParams(location.search).get('session') ??
      `rrabbit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    session = await createCompositorSession(sessionId)
    state.sessionId = sessionId
    window.__session = session

    // The half of the stage that did not exist at buildWorld time. Travel needs
    // it to raise a surface on flatten; RRABBIT needs it to see the views at
    // all, so until this line adoptPending() reads an empty list and finds
    // nothing -- which is correct, and is why it is safe to be running already.
    ctx.session = session
    attachTravel(ctx)
    attachRrabbit(ctx)

    // Ask for the clients to be closed on the way out, so the old session is
    // reaped promptly rather than lingering until something times it out.
    // `pagehide` and not `beforeunload`: the latter is not fired reliably on
    // mobile or on a discarded tab, and this must not become a dialog.
    window.addEventListener('pagehide', () => {
      try {
        session.terminate()
      } catch {
        /* leaving anyway -- a failure here must not block the unload */
      }
      // AND GIVE THE GL CONTEXT BACK.
      //
      // Terminating the session was only half of leaving. A browser allows a
      // small number of live WebGL contexts -- Chrome drops the oldest, Firefox
      // refuses -- and this page holds one for as long as the browser has not
      // got round to collecting it. Iterating on the shell means reloading it
      // dozens of times an hour, each load asking for another, and the failure
      // when the limit is hit is a null context on a page that worked a minute
      // ago. Handing it back explicitly is what makes a reload cost nothing.
      try {
        renderer.dispose()
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      } catch {
        /* same -- nothing here is worth blocking an unload for */
      }
      // AND THE COCKPIT'S, which is a SECOND context on this page.
      //
      // The dash reaps its own yoke on pagehide as well, because this listener
      // only exists once the compositor session is up and the yoke is taken
      // before that. Both is deliberate and costs nothing: `dispose()` is
      // idempotent, and the case that matters is the boot that never reaches
      // here at all.
      try {
        dash?.dispose()
      } catch {
        /* same */
      }
    })

    session.userShell.events.notify = (v, m) => {
      state.error = `${v}: ${m}`
      say(`notify ${v}: ${m}`)
    }
    session.userShell.events.surfaceCreated = () => {
      state.surfaces++
      say(`${state.surfaces} surface(s)`)
    }
    session.userShell.events.surfaceDestroyed = () => {
      state.surfaces--
    }
    // THE ONLY PLACE A WINDOW'S NAME EXISTS. Greenfield emits the title and
    // keeps none of it (see `titles` in world.js), so if this listener is not
    // here the name board can only ever say "untitled window" -- which is what
    // it said for every client until it was.
    session.userShell.events.surfaceTitleUpdated = (cs, title) => {
      titles.set(`${cs.client.id}:${cs.id}`, String(title ?? ''))
    }

    // Greenfield's output IS our canvas, so it gets our context.
    session.userShell.actions.initScene(SCENE_ID, document.getElementById('gl'))

    // Suppress Greenfield's compositing. Its Scene would paint every window
    // flat across our canvas, over the road. We want only the decode, which
    // happens elsewhere (see the header note 2).
    const gfScene = session.renderer.scenes[SCENE_ID]
    if (!gfScene) throw new Error('scene not registered under ' + SCENE_ID)
    gfScene.render = () => {
      state.suppressed++
      session.userShell.events.sceneRefreshed?.(SCENE_ID)
    }

    fenceScenePasses(gfScene)

    // THE SAME SEAM, ONE LAYER UP. The line above cuts Greenfield's compositing
    // out of the scene; this one paces how often the whole cycle -- including the
    // frame callbacks that invite every client to paint again -- is allowed to
    // run at all. Installed here because this is the first moment the renderer
    // exists, and before `globals.register()` so no client can commit into an
    // unpaced renderer.
    paceCompositor()

    session.globals.register()
    installInput()
    // KEPT, so a lost context can cancel them. Both of these outlive the frame loop
    // otherwise -- one polls a bridge over the network and one walks the popups --
    // and neither has anything to do once the scene has stopped being drawable.
    // `pollTubes` in particular is the loudest thing in a broken tab: it fetches
    // every two seconds forever and logs its own failure each time.
    // A detector, not a fix -- see checkPopupsMapped. Slow on purpose.
    timers.push(setInterval(checkPopupsMapped, 1000))
    pollTubes().then(() => {
      if (!contextLost) scheduleTubes()
    })
    state.compositor = 'up'

    // `?remote=/text-editor,/xterm` launches NATIVE applications through
    // compositor-proxy (npm run proxy) instead of in-browser clients. Native is
    // the case that decides whether §7's per-window encode cost is affordable,
    // and nothing before this exercised gstreamer at all.
    const params = new URLSearchParams(location.search)
    const remote = params.get('remote')

    // The ST&RT menu's list, read once. Not awaited: the menu draws the web
    // clients the moment it is opened and the native rows appear when the answer
    // arrives, which is the right order -- a start button that would not open
    // until a fetch came back would be a start button blocked on a file that is
    // legitimately absent in a build.
    loadPrograms()

    // ONE LAUNCH PATH FOR EVERY WAY A WINDOW IS ASKED FOR -- the gate panels, the
    // boot plan, a click in the ST&RT menu and a program dropped on the road all
    // come through here. Four callers and one function, because the placement
    // rule (below) has to be the same for all of them or the same request made
    // two ways puts the window in two different places.
    //
    // It does NOT choose a workspace or a milepost. Both are claimed at adoption
    // (`state.district`, `ws.takeMilepost`) because the surface does not exist
    // yet when the click happens -- so a window opened from a gate arrives by
    // exactly the same path as one the launch plan opened, and there is no
    // second placement rule that could disagree with the first.
    //
    // The launchers are made ON DEMAND and kept. Both kinds can be wanted in one
    // session now (the menu offers web clients and native programs together),
    // which is the thing `?remote=` used to decide once at boot for the whole page.
    const launchers = {}
    const launcherFor = (kind) =>
      (launchers[kind] ??= createAppLauncher(session, kind === 'web' ? 'web' : 'remote'))
    const urlOf = (prog) => (prog.kind === 'web'
      ? new URL(`${location.origin}/clients/${prog.client}/app.html`)
      : new URL(`${PROXY_BASE}${prog.path}`))

    // `at` is which marker on the centre line the window was asked for, and null
    // means "wherever there is room". It goes on the queue with the side for the
    // same reason the side always did: the surface does not exist yet.
    launchProgram = (prog, side = null, at = null) => {
      try {
        sideQueue.push({ side: side ?? null, dash: Number.isInteger(at) ? at : null })
        // A WINDOW IS THE ONLY EVIDENCE THAT A PROGRAM RAN. `open` and `closed`
        // are the SIGNALLING socket's states, not the application's -- measured:
        // a program that exits immediately cycles open/closed/open/closed as the
        // launcher reconnects, and one that is running sits at `open`. Neither
        // says whether anything appeared. So watch for the thing being asked for.
        //
        // This is a TIMEOUT, which is a guess about how long is long enough, and
        // it is worded as what was observed -- "no window ... within 12s" -- and
        // not as "failed". A slow program that arrives late still gets its
        // window; all that is lost is a line on the status strip.
        const before = state.surfaces ?? 0
        // AND IT KEEPS WATCHING AFTER IT HAS COMPLAINED, because the first
        // version's complaint was measurably false. On this guest -- software
        // EGL, software x264, four vCPUs already busy drawing the road --
        // Firefox took well over a minute to put up its first surface, and the
        // strip said "the program may have exited" while `ps` showed it alive
        // and it went on to render perfectly. A message that contradicts what
        // is on screen is worse than no message, and this one never withdrew.
        //
        // So the deadline announces SLOWNESS, in those words, and the watcher
        // stays up until the window arrives or GIVE_UP passes. If it arrives,
        // the complaint is retracted on the same line that made it.
        const WAIT = 12000, GIVE_UP = 90000
        const t0 = (performance?.now?.() ?? Date.now())
        const waitedMs = () => (performance?.now?.() ?? Date.now()) - t0
        let announced = false, timer = 0, stopped = false
        const stop = () => { stopped = true; clearTimeout(timer) }
        const check = () => {
          if (stopped) return
          const waited = waitedMs()
          if ((state.surfaces ?? 0) > before) {
            if (announced) {
              // Retract. `lastLaunch` is what a report is read off, so the
              // record has to say the launch was fine AND that it was slow --
              // dropping the number would lose the only measurement here.
              state.error = null
              if (state.lastLaunch?.program === prog.id) {
                state.lastLaunch = { ...state.lastLaunch, ok: true, why: null,
                                     windowAfterMs: Math.round(waited) }
              }
              say(`${prog.name}: window arrived after ${Math.round(waited / 1000)}s`)
            }
            return
          }
          if (!announced && waited >= WAIT) {
            announced = true
            // NOT a proxy verdict. The proxy answered -- it took the launch and
            // ran something. Blaming it here is what would refuse every other
            // native row because one application on this host is unhappy.
            //
            // Nor a verdict on the PROGRAM. All that is known at this point is
            // that no window has appeared yet, so that is all it says.
            const why = `no window yet after ${WAIT / 1000}s — still waiting`
            state.error = `${prog.id}: ${why}`
            if (state.lastLaunch?.program === prog.id) {
              state.lastLaunch = { ...state.lastLaunch, ok: false, why }
            }
            say(`${prog.name}: ${why}`)
          }
          if (waited < GIVE_UP) timer = setTimeout(check, 1000)
          else if (announced) {
            const why = `no window after ${GIVE_UP / 1000}s — giving up watching`
            state.error = `${prog.id}: ${why}`
            say(`${prog.name}: ${why}`)
          }
        }
        timer = setTimeout(check, WAIT)
        // A canceller rather than a timer id: this one re-arms, so the id the
        // list would have captured stops being the live one after a second.
        launchWatchdogs.push(stop)
        const app = launcherFor(prog.kind).launch(urlOf(prog), () => {})
        if (app) {
          // WHAT THE DELETED PROBE USED TO GUESS, LEARNED FROM AN ACTUAL ATTEMPT.
          // A native launch can only fail this way if the proxy did not answer,
          // so this is the first moment the menu is entitled to say so.
          //
          // `onStateChange('error')` IS THE FAILURE SIGNAL. `onError` is not, and
          // wiring this to it (as it was) meant the reporting half of "try, then
          // report" never ran: you clicked a program, the menu shut, nothing
          // opened, and nothing anywhere said why. Measured with the proxy down
          // -- `appStates` went to `error`, `onError` never fired, every row
          // stayed `ok:true` and `lastLaunch.ok` said `true`.
          //
          // Upstream only calls `onError` from the signalling socket's own
          // `error` event, and the browser's WebSocket error event carries no
          // `.error` -- so even when it does fire it has nothing to say.
          // `RemoteAppLauncher.error()` closes everything and reports through
          // `onStateChange`.
          const failed = (why) => {
            // A named failure beats a timeout, and both firing would print two
            // different reasons for one click.
            stop()
            state.error = `${prog.id}: ${why}`
            // The launch was ACCEPTED and then failed. Leaving `ok:true` on the
            // record is how "I clicked it and nothing happened" stayed
            // unexplained in every report of this.
            if (state.lastLaunch?.program === prog.id) {
              state.lastLaunch = { ...state.lastLaunch, ok: false, why }
            }
            say(`${prog.name}: ${why}`)
            if (prog.kind !== 'web') {
              proxyUp = false
              // NAME THE ADDRESS THAT DID NOT ANSWER. The launcher has no
              // message to give (see above), and "not answering" without saying
              // what was called is unactionable -- especially in the distro,
              // where this URL is a host the guest has no proxy on at all.
              proxyWhy = `no compositor-proxy at ${PROXY_BASE}`
            }
          }
          app.onError = (e) => failed(e ? String(e) : `no compositor-proxy at ${PROXY_BASE}`)
          app.onStateChange = (s) => {
            state.appStates = { ...(state.appStates ?? {}), [prog.id]: s }
            if (s === 'error') failed(`no compositor-proxy at ${PROXY_BASE}`)
          }
        }
        state.spawned = (state.spawned ?? 0) + 1
        return true
      } catch (e) {
        // A failed launch must not leave a side queued -- the next window to
        // arrive for any other reason would take it.
        sideQueue.pop()
        state.error = String(e)
        return false
      }
    }

    // A path off the query string, in the shape the menu and the launcher both
    // read. Named from the path because nothing on the wire says otherwise --
    // `applications.json` has the pretty name and it is the proxy's, not ours.
    const progOf = (path) => ({ id: 'native' + path, name: path.replace(/^\//, ''),
                                kind: 'native', path, ok: true })

    // Launch on demand from the console. `?remote=` fires during boot, which
    // makes it useless for anything that has to be armed BEFORE the first frame
    // -- a probe on the decoder, say. Same one launch path as everything else.
    window.__launch = (path) => launchProgram(progOf(path))

    if (remote) {
      const paths = remote.split(',')
      for (const path of paths) launchProgram(progOf(path))
      // "Open another one of these" -- the first remote path is the only thing a
      // gate could mean here, since nothing on the sign names an application.
      hooks.spawnWindow = (side, at = null) => launchProgram(progOf(paths[0]), side, at)
      say(`compositor up -- launching remote ${remote}`)
    } else {
      // Windows open in the district you are STANDING IN -- assignment reads
      // `state.district` at adoption time, exactly as it would if you were
      // driving around opening things. `?windows=2,2,1` is per-district counts.
      const clientName = params.get('client') ?? 'simple-shm'
      // `?client=` may name a client that is not in the menu's list; it still
      // launches, because the query string is a direct instruction and the list
      // is only what the menu is prepared to offer.
      const boot = WEB_PROGRAMS.find((p) => p.client === clientName)
        ?? { id: clientName, name: clientName, kind: 'web', client: clientName, ok: true }
      const plan = (params.get('windows') ?? '2,2,1').split(',').map((n) => parseInt(n, 10) || 0)
      const lanes = ws.openList()
      hooks.spawnWindow = (side, at = null) => launchProgram(boot, side, at)
      ;(async () => {
        for (let d = 0; d < Math.min(plan.length, lanes.length); d++) {
          state.district = lanes[d].id
          for (let i = 0; i < plan[d]; i++) {
            launchProgram(boot)
            // Let the surface arrive and be adopted before moving on, or every
            // window would be assigned to whichever district we ended on.
            await new Promise((r) => setTimeout(r, 2500))
          }
        }
        state.district = ws.root()
        goDistrict(ws.root())
        // Let the live status line reclaim the bar. `surfaceCreated` writes
        // "N surface(s)" over it while the plan runs, so without this the key
        // hint is only ever seen by someone who then adds a workspace.
        forgetStatus()
      })()
      say('compositor up -- opening windows across districts')
    }
  } catch (e) {
    state.error = String(e && e.stack ? e.stack : e)
    say(`FAILED: ${e}`)
    console.error(e)
  }
}

window.addEventListener('load', main)
