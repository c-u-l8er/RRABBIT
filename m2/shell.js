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
import {
  state,
  signs,
  ctx,
  hooks,
  sideQueue,
  keyOf,
  ACC,
  COOL,
  BG,
  MILE,
  SCENE_ID,
  LEDGER_PITCH,
  LEDGER_COLS,
} from './world.js'
import * as ws from './workspaces.js'
import {
  attachTravel,
  districtPose,
  setRange,
  goDistrict,
  goWindow,
  flattenTo,
  release,
  sendMotion,
  resizeFlatBy,
  handlePoint,
  stepFlight,
  installInput,
} from './travel.js'
import { attachRrabbit, adoptPending, syncPopups, syncHandles, checkPopupsMapped } from './rrabbit.js'
import { attachGantry, syncGantries, gantryReport } from './gantry.js'
import { attachMap, openMap, closeMap, mapReport } from './map.js'

// state lives in world.js now; the page and the diagnostics still expect it
// to come from here.
export { state }

// The tube bridge (bridge.py). SAME-ORIGIN by default -- see world.js for why
// an absolute origin here was a bug.
const TUBE_BRIDGE = new URLSearchParams(location.search).get('bridge') ?? ''

let renderer, gl, scene, camera, session, rack, vaoExt
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
  return 'No WebGL context is available in this browser at all (fresh canvases are refused too), so this is the machine or the browser, not the shell. Check hardware acceleration, and on the T&R image whether the software path survives Xorg scfb.'
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

  // The rack is parented to the camera, and a camera's children are only
  // rendered if the camera is itself in the scene graph. Without this line the
  // tubes exist, update correctly, and are invisible.
  scene.add(camera)
  rack = createRack(camera)

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
  syncGantries()
  // The map navigates through Travel rather than doing it itself, the same
  // division the gates keep.
  attachMap({ window: goWindow, district: (id) => goDistrict(id) })

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
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(320, 14000),
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
    r.road.position.set(x, -30, -6600)
  }
  // The status line names the workspace keys, and creating a lane from an exit
  // gate changes how many there are -- so a line written once at startup starts
  // lying the first time you use the feature it is describing.
  if (want.size !== lastRoadCount) {
    lastRoadCount = want.size
    const el = document.getElementById('status')
    if (el) {
      el.textContent =
        `${want.size} workspaces -- type a number for a lane (1..${want.size}), 0 for the map. ` +
        'Scroll: open windows at the entrance, then the lanes out at the far end.'
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

async function pollTubes() {
  try {
    const r = await fetch(`${TUBE_BRIDGE}/api/tubes`, { cache: 'no-store' })
    const payload = await r.json()
    rack.apply(payload)
    state.tubeReader = payload.reader
    state.tubePolls++
    state.tubeError = null
  } catch (e) {
    // A bridge that is down must not read as a machine that is idle: leave the
    // last values alone and say so. Blanking the rack would be a claim.
    state.tubeError = String(e)
  }
  renderWhy()
}

// Invariant 1: a tube over its redline has to say what is doing it.
function renderWhy() {
  const el = document.getElementById('why')
  if (!el) return
  const over = rack.overRedline()
  if (state.tubeError) {
    el.textContent = `tube bridge unreachable — showing last known values (${state.tubeError})`
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

let lastT = 0
function frame(now = 0) {
  try {
    // RAVIO: MEASUREMENTS MUST OUTLAST A FRAME, and an eased term driven by a
    // fixed step lies whenever the frame rate moves. Clamp so a backgrounded
    // tab returning does not teleport the camera.
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    lastT = now
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
    renderer.resetState()
    renderer.render(scene, camera)
    state.frames++
    leaveNeutralVertexState()

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
  requestAnimationFrame(frame)
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
  const out = { ...state, mileposts: [], sweeps: [] }
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
      lane: s.lane ?? null,
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
  read: rack ? Object.fromEntries(Object.entries(rack.tubes).map(([k, t]) => [k, t.data && {
    value: t.data.value, n: t.data.n, bar: t.data.bar,
    fillY: +t.fill.scale.y.toFixed(5), barShown: t.bar.visible,
    color: '#' + t.fill.material.color.getHexString(),
  }])) : null,
  why: document.getElementById('why')?.textContent ?? null,
})

// Raw view tree, for looking at what the compositor actually did with a popup
// before deciding how to draw it.
window.__views = () =>
  session.renderer.topLevelViews.map((v) => ({
    key: keyOf(v),
    role: v.surface.role?.constructor?.name ?? null,
    hasParent: !!v.surface.parent,
    parentKey: v.surface.parent?.role?.view ? keyOf(v.surface.parent.role.view) : null,
    rect: [v.regionRect.x0, v.regionRect.y0, v.regionRect.x1, v.regionRect.y1],
    mapped: v.mapped,
    hasBuffer: !!v.surface.state.bufferContents,
    knownAsSign: signs.has(keyOf(v)),
  }))

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

// Say what happened, once, for the benefit of a browser that cannot be asked.
// `?report=15` posts state after 15 seconds.
{
  const secs = Number(new URLSearchParams(location.search).get('report'))
  if (Number.isFinite(secs) && secs > 0) {
    setTimeout(() => {
      const t = window.__m1()
      const tubes = window.__tubes()
      fetch(`${TUBE_BRIDGE}/api/report`, {
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
        }),
      }).catch(() => {})
    }, secs * 1000)
  }
}

// Takes an id, or an index into the layout for everything written against the
// old numeric districts (`__district(1)` still means the second road).
window.__district = (d) => goDistrict(typeof d === 'number' ? ws.at(d)?.id : d)
window.__map = (openIt) => {
  if (openIt === false) closeMap()
  else if (openIt === true) openMap()
  return mapReport()
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
  const say = (t) => {
    if (status) status.textContent = t
  }
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

    session.globals.register()
    installInput()
    // A detector, not a fix -- see checkPopupsMapped. Slow on purpose.
    setInterval(checkPopupsMapped, 1000)
    pollTubes()
    setInterval(pollTubes, 2000)
    state.compositor = 'up'

    // `?remote=/text-editor,/xterm` launches NATIVE applications through
    // compositor-proxy (npm run proxy) instead of in-browser clients. Native is
    // the case that decides whether §7's per-window encode cost is affordable,
    // and nothing before this exercised gstreamer at all.
    const params = new URLSearchParams(location.search)
    const remote = params.get('remote')

    // WHAT THE ENTER GATE DOES. One function, defined for whichever kind of
    // client this session is running, and published through `hooks` because
    // travel.js cannot import this module back.
    //
    // It does NOT choose a workspace or a milepost. Both are claimed at adoption
    // (`state.district`, `ws.takeMilepost`) because the surface does not exist
    // yet when the click happens -- so a window opened from a gate arrives by
    // exactly the same path as one the launch plan opened, and there is no
    // second placement rule that could disagree with the first.
    const publishSpawn = (open) => {
      hooks.spawnWindow = (side) => {
        try {
          sideQueue.push(side)
          const app = open()
          if (app) {
            app.onError = (e) => {
              state.error = String(e)
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
    }

    if (remote) {
      const base = params.get('proxy') ?? 'http://127.0.0.1:8912'
      const launcher = createAppLauncher(session, 'remote')
      const paths = remote.split(',')
      for (const path of paths) {
        const app = launcher.launch(new URL(`${base}${path}`), () => {})
        app.onStateChange = (s) => {
          state.appStates = { ...(state.appStates ?? {}), [path]: s }
        }
        app.onError = (e) => {
          state.error = `${path}: ${e}`
        }
      }
      // "Open another one of these" -- the first remote path is the only thing a
      // gate could mean here, since nothing on the sign names an application.
      publishSpawn(() => launcher.launch(new URL(`${base}${paths[0]}`), () => {}))
      say(`compositor up -- launching remote ${remote}`)
    } else {
      // Windows open in the district you are STANDING IN -- assignment reads
      // `state.district` at adoption time, exactly as it would if you were
      // driving around opening things. `?windows=2,2,1` is per-district counts.
      const launcher = createAppLauncher(session, 'web')
      const clientName = params.get('client') ?? 'simple-shm'
      const plan = (params.get('windows') ?? '2,2,1').split(',').map((n) => parseInt(n, 10) || 0)
      const lanes = ws.openList()
      publishSpawn(() => launcher.launch(new URL(`${location.origin}/clients/${clientName}/app.html`), () => {}))
      ;(async () => {
        for (let d = 0; d < Math.min(plan.length, lanes.length); d++) {
          state.district = lanes[d].id
          for (let i = 0; i < plan[d]; i++) {
            const app = launcher.launch(new URL(`${location.origin}/clients/${clientName}/app.html`), () => {})
            app.onError = (e) => {
              state.error = String(e)
            }
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
