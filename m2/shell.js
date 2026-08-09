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

const ACC = 0xf2c14e
const COOL = 0x2de2e6
const BG = 0x03040a

// Spacing between mileposts. RAVIO measured its way to S=300 for a change feed
// of 15-25 rows/hour against a road passing 1800 signs/hour. Windows invert
// that problem -- there are 5-30 of them, not thousands -- so this is NOT
// RAVIO's S and must not be assumed to transfer (spec §7).
const MILE = 260
const SCENE_ID = 'road'

// ---- M4: districts -------------------------------------------------------
//
// A district is a workspace. Spec §3 originally said "one Wayland output each";
// §11.2 and §12.3 measured why that is the wrong shape:
//
//   - every scene renders every view, so extra outputs do not partition windows
//   - a view only gets a texture where it INTERSECTS a scene's region
//   - and a scene's region is its canvas, which is the visible one
//
// So districts are a partition of the ROAD, not of the output. There is one
// flat output -- the ledger -- and every window lives in it at its own slot.
// The road is a view of the ledger; a district is a stretch of road.
//
// THE LEDGER SLOT IS NOT COSMETIC. §12.3 found every window stacked at the same
// rect, which left `pickView` able to tell windows apart only by stacking order
// -- so routing was correct only because the flatten raises its target first.
// Distinct slots make the ledger addressable by position, which is what a
// window manager is supposed to be.
const DISTRICTS = ['home', 'build', 'watch']
const DISTRICT_X = 2600 // how far apart the roads are laid
const LEDGER_PITCH = 264 // slot spacing in the flat output
const LEDGER_COLS = 4
// The tube bridge (bridge.py). Its own port so a shell without one still runs.
const TUBE_BRIDGE = new URLSearchParams(location.search).get('bridge') ?? 'http://127.0.0.1:8913'

export const state = {
  compositor: 'idle',
  surfaces: 0,
  signs: 0,
  adopted: 0,
  frames: 0,
  decodes: 0,
  suppressed: 0,
  // M2
  mode: 'driving', // driving | flying | flat
  flatMilepost: null,
  flatDistrict: null,
  pointerSent: 0,
  buttonSent: 0,
  lastScenePoint: null,
  lastPickMatched: null,
  released: 0,
  district: 0,
  overview: false,
  placed: 0,
  ledgerDistinct: null,
  popupsMapped: 0,
  popupQuads: 0,
  lastWasPopup: null,
  popupError: null,
  tubeReader: null,
  tubePolls: 0,
  tubeError: null,
  error: null,
  frameError: null,
}

let renderer, gl, scene, camera, session, rack
// Mileposts are PER DISTRICT -- each workspace numbers its own road.
const nextMilepost = DISTRICTS.map(() => 1)
let nextSlot = 0
// surface key -> { milepost, mesh, tex, rt, size, view }
const signs = new Map()

// Camera flight. `from`/`to` are poses; t runs 0..1.
let flight = null
let flatTargetDistrict = 0
const DRIVE_POSE = { pos: new THREE.Vector3(0, 105, 260), look: new THREE.Vector3(0, 105, -640) }
const raycaster = new THREE.Raycaster()
const districtArches = []

const districtX = (d) => (d - (DISTRICTS.length - 1) / 2) * DISTRICT_X

// A slot in the flat output. The ledger is a grid, one cell per window, so no
// two windows share a rect and `pickView` can resolve a point to a window on
// position alone.
const ledgerSlot = (i) => ({
  x: (i % LEDGER_COLS) * LEDGER_PITCH,
  y: Math.floor(i / LEDGER_COLS) * LEDGER_PITCH,
})

const keyOf = (view) => `${view.surface.resource.client.id}:${view.surface.resource.id}`

// ---------------------------------------------------------------- the world

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
  renderer = new THREE.WebGLRenderer({ canvas, context: gl })
  renderer.setPixelRatio(1)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.Fog(BG, 1400, 4200)

  camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 6000)
  camera.position.set(0, 105, 260)

  scene.add(new THREE.AmbientLight(0xffffff, 1.2))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(-200, 400, 300)
  scene.add(key)

  // One road per district, laid side by side. A workspace you can SEE from a
  // neighbouring workspace is the difference between switching and teleporting.
  DISTRICTS.forEach((name, d) => {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(320, 6000),
      new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9 }),
    )
    road.rotation.x = -Math.PI / 2
    road.position.set(districtX(d), -30, -2600)
    scene.add(road)

    // A gateway arch at the head of each road, so a district is identifiable
    // from the overview without reading anything.
    const arch = new THREE.Mesh(
      new THREE.BoxGeometry(360, 14, 14),
      new THREE.MeshStandardMaterial({ color: d === 0 ? COOL : ACC, roughness: 0.5 }),
    )
    arch.position.set(districtX(d), 300, 60)
    arch.userData.district = d
    scene.add(arch)
    districtArches.push(arch)
  })

  // The rack is parented to the camera, and a camera's children are only
  // rendered if the camera is itself in the scene graph. Without this line the
  // tubes exist, update correctly, and are invisible.
  scene.add(camera)
  rack = createRack(camera)

  resize()
  window.addEventListener('resize', resize)
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

// ------------------------------------------------------------------- signs

// Adopt a Greenfield surface texture as a three.js map. Shared by signs and by
// popups so the two can never drift on colour space or the flip.
// three r160 has no ExternalTexture class; setRenderTargetTextures is the
// supported way in at this revision. It dereferences
// `renderTarget.depthTexture` UNCONDITIONALLY, and a plain render target has
// none, so the call dies with "Invalid value used as weak map key" three lines
// before the branch that handles `depthTexture === undefined` -- hence a depth
// texture that is never used.
//
// The flip is at SAMPLE time (repeat/offset) because `flipY` is an UPLOAD-time
// flag and adoption does no upload.
function adoptSurfaceTexture(rs) {
  const { width, height } = rs.size
  const rt = new THREE.WebGLRenderTarget(width, height)
  rt.depthTexture = new THREE.DepthTexture(width, height)
  renderer.setRenderTargetTextures(rt, rs.texture.texture)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(1, -1)
  tex.offset.set(0, 1)
  return { rt, tex }
}

function makeSign(view, milepost, district) {
  const rs = view.renderStates[SCENE_ID]
  if (!rs || !rs.texture || !rs.texture.texture) return null
  const { width, height } = rs.size
  if (!width || !height) return null

  const { rt, tex } = adoptSurfaceTexture(rs)

  // One sign is sized to ITS OWN surface. M0's board was a fixed rectangle and
  // a 250x250 client filled a corner of it -- correct behaviour, wrong framing.
  const sw = 300
  const sh = (sw * height) / width
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )

  // Alternate sides of the road, like RAVIO's billboards -- on THIS district's
  // road.
  const side = milepost % 2 === 0 ? 1 : -1
  mesh.position.set(districtX(district) + side * 260, 40 + sh / 2, -milepost * MILE)
  mesh.rotation.y = -side * 0.42
  scene.add(mesh)

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(sw + 14, sh + 14),
    new THREE.MeshBasicMaterial({ color: COOL }),
  )
  frame.position.copy(mesh.position)
  frame.rotation.copy(mesh.rotation)
  frame.translateZ(-2)
  scene.add(frame)

  // A post, so the sign stands on the road rather than floating -- and so
  // there is geometry that can occlude the sign behind it.
  //
  // It must stop AT the sign's bottom edge, not run through it. An overlapping
  // post covered the lower face and made a readback sample amber, which read as
  // the window being the wrong way up. Furniture that crosses the picture is
  // also an instrument that lies about the picture.
  const postTop = mesh.position.y - sh / 2
  const postH = postTop + 30
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(14, postH, 14),
    new THREE.MeshStandardMaterial({ color: ACC, roughness: 0.6 }),
  )
  post.position.set(mesh.position.x, postTop - postH / 2, mesh.position.z)
  scene.add(post)

  state.adopted++
  return { mesh, frame, post, tex, rt, size: { width, height } }
}

// A surface's size is not known when it is created -- the first buffer decides
// it, and renderStates are only built once the view intersects the scene. So
// signs are adopted lazily, every frame, until they take.
function adoptPending() {
  const views = session?.renderer?.topLevelViews ?? []
  for (const view of views) {
    const k = keyOf(view)
    const existing = signs.get(k)
    if (existing && existing.mesh) {
      // Invariant 6: content changes, PLACEMENT DOES NOT. The milepost is the
      // window's address and is never recomputed.
      const rs = view.renderStates[SCENE_ID]
      if (rs && (rs.size.width !== existing.size.width || rs.size.height !== existing.size.height)) {
        // A resized surface is a new texture allocation. Rebuild the sign in
        // place, at the SAME milepost.
        dropSign(k)
        signs.set(k, { milepost: existing.milepost, district: existing.district, slot: existing.slot })
      }
      continue
    }
    // Invariant 6, widened by M4: a window's address is now (district,
    // milepost) and neither half is ever recomputed. The ledger slot is
    // assigned once for the same reason -- a window that moved in the ledger
    // would change where its input lands.
    const district = existing?.district ?? state.district
    const milepost = existing?.milepost ?? nextMilepost[district]++
    const slot = existing?.slot ?? nextSlot++
    placeInLedger(view, slot)
    const built = makeSign(view, milepost, district)
    // The view is kept so input can be mapped back into the flat output. It is
    // re-read every frame rather than cached at build time: a view object is
    // replaced when a surface is remapped.
    signs.set(k, built ? { milepost, district, slot, view, ...built } : { milepost, district, slot, view })
    if (built) built.mesh.userData.signKey = k
  }
  for (const [k, s] of signs) {
    const v = views.find((x) => keyOf(x) === k)
    if (v) s.view = v
  }
  state.signs = [...signs.values()].filter((s) => s.mesh).length

  // Surfaces that went away.
  //
  // A window can close WHILE YOU ARE IN IT -- the client exits, the surface is
  // destroyed, and without this the shell sits flat against a milepost that no
  // longer has anything on it, with input routed to a surface that is gone.
  // Proven by pressing Escape in the test client, which exits on ESC.
  const live = new Set(views.map(keyOf))
  for (const k of [...signs.keys()]) {
    if (live.has(k)) continue
    const dying = signs.get(k)
    if (dying && dying.milepost === state.flatMilepost) release()
    dropSign(k, true)
  }
}

function dropSign(k, forget = false) {
  const s = signs.get(k)
  if (!s) return
  for (const o of [s.mesh, s.frame, s.post]) if (o) scene.remove(o)
  if (s.rt) s.rt.dispose()
  if (forget) signs.delete(k)
}

// ----------------------------------------------------------------- popups
//
// AN xdg_popup CANNOT MAP IN GREENFIELD 1.0.0-rc1. `surface.mapped = true`
// happens in exactly one place -- `FloatingDesktopSurface.commit()` -- and that
// is called by XdgToplevel, ShellSurface and XWaylandShellSurface. XdgPopup's
// own `onCommit` acks the configure, schedules a render, and never calls it.
//
// So the popup surface is created with the right role, receives its buffer, and
// then sits at `mapped: false` forever. Measured exactly that: role XdgPopup,
// hasBuffer true, mapped false, and no view anywhere.
//
// This is not a 3D problem. It is the reason no menu, dropdown, combobox or
// tooltip can appear in this compositor AT ALL, for any client. Spec §7 worried
// about placing a popup on a curved billboard; that worry was one layer too
// high.
//
// Until upstream fixes it, the shell finishes the job: a popup that has a buffer
// and is not mapped gets the `desktopSurface.commit()` it never received.
function mapStrandedPopups() {
  const clients = session?.display?.clients
  if (!clients) return
  for (const client of Object.values(clients)) {
    const objs = client.connection?.wlObjects
    if (!objs) continue
    for (const o of Object.values(objs)) {
      const impl = o?.implementation
      if (!impl || impl.constructor?.name !== 'Surface') continue
      const role = impl.role
      if (!role || role.constructor?.name !== 'XdgPopup') continue
      if (impl.mapped || !impl.state?.bufferContents) continue
      try {
        role.desktopSurface?.commit()
        state.popupsMapped++
      } catch (e) {
        if (!state.popupError) state.popupError = String(e)
      }
    }
  }
}

// A popup is drawn ON ITS PARENT'S SIGN, at the position the COMPOSITOR
// computed from the client's XdgPositioner. The shell does not invent a
// position -- spec §7 feared there was no rectangle to anchor to on a receding
// billboard, but the ledger has one: both surfaces have a rect there, and the
// difference between them is the offset in parent-surface pixels.
//
//   local x = (dx + popupW/2 - parentW/2) * scale
//   local y = -(dy + popupH/2 - parentH/2) * scale     (y is up in the plane)
//
// A menu that overhangs its window overhangs its sign too, which is correct.
function popupsByParentKey() {
  const out = new Map()
  const clients = session?.display?.clients
  if (!clients) return out
  for (const client of Object.values(clients)) {
    for (const o of Object.values(client.connection?.wlObjects ?? {})) {
      const impl = o?.implementation
      if (!impl || impl.constructor?.name !== 'Surface') continue
      if (impl.role?.constructor?.name !== 'XdgPopup') continue
      if (!impl.mapped) continue
      const view = impl.role.view
      const rs = view?.renderStates?.[SCENE_ID]
      if (!rs?.texture?.texture || !rs.size.width) continue
      // Walk up: a submenu's parent is another popup, and it still belongs to
      // the toplevel's sign.
      let p = impl.parent
      let guard = 0
      while (p && guard++ < 8) {
        const pv = p.role?.view
        if (pv && signs.has(keyOf(pv))) {
          const k = keyOf(pv)
          if (!out.has(k)) out.set(k, [])
          out.get(k).push({ view, rs })
          break
        }
        p = p.parent
      }
    }
  }
  return out
}

function syncPopups() {
  const byParent = popupsByParentKey()
  for (const [k, sign] of signs) {
    if (!sign.mesh) continue
    sign.popups = sign.popups ?? new Map()
    const live = byParent.get(k) ?? []
    const liveKeys = new Set(live.map((p) => keyOf(p.view)))

    for (const { view, rs } of live) {
      const pk = keyOf(view)
      let q = sign.popups.get(pk)
      const size = { w: rs.size.width, h: rs.size.height }
      if (q && (q.size.w !== size.w || q.size.h !== size.h)) {
        sign.mesh.remove(q.mesh)
        q.rt.dispose()
        sign.popups.delete(pk)
        q = undefined
      }
      if (!q) {
        const { rt, tex } = adoptSurfaceTexture(rs)
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
        )
        // A child of the sign, so it inherits the sign's pose for free and
        // stays glued to the window through the flatten.
        mesh.userData.popupView = view
        sign.mesh.add(mesh)
        q = { mesh, rt, size }
        sign.popups.set(pk, q)
        state.popupQuads++
      }
      const g = sign.mesh.geometry.parameters
      const scale = g.width / sign.size.width
      const pr = view.regionRect
      const sr = sign.view.regionRect
      const dx = pr.x0 - sr.x0
      const dy = pr.y0 - sr.y0
      q.mesh.scale.set(size.w * scale, size.h * scale, 1)
      q.mesh.position.set(
        (dx + size.w / 2 - sign.size.width / 2) * scale,
        -(dy + size.h / 2 - sign.size.height / 2) * scale,
        1.5, // just proud of the sign face, so it never z-fights the window
      )
    }

    for (const [pk, q] of [...sign.popups]) {
      if (liveKeys.has(pk)) continue
      sign.mesh.remove(q.mesh)
      q.rt.dispose()
      sign.popups.delete(pk)
    }
  }
}

// ---------------------------------------------------------------- the ledger

// Put a window at its own rect in the flat output. `positionOffset` is the same
// lever Greenfield's own FloatingDesktopSurface uses to drag a window, so this
// is placement rather than a trick.
function placeInLedger(view, slot) {
  const p = ledgerSlot(slot)
  const cur = view.positionOffset
  if (cur && cur.x === p.x && cur.y === p.y) return
  view.positionOffset = p
  state.placed++
}

// ------------------------------------------------------------- the district

function districtPose(d) {
  return {
    pos: new THREE.Vector3(districtX(d), 105, 260),
    look: new THREE.Vector3(districtX(d), 105, -640),
  }
}

// The overview -- spec §5's R gear, re-missioned: all workspaces at once rather
// than one.
//
// FOG IS A DISTANCE BUDGET, AND THE OVERVIEW BLOWS IT. Driving fog (far 4200)
// suits a road you are on; from above, the outer districts are 5000+ units away
// and the first overview rendered them as black. The pose and the fog have to
// move together or the shot is of nothing.
// AND FOG IS ONLY ONE OF TWO DISTANCE BUDGETS. Widening the fog alone still
// rendered an empty overview, because the CAMERA'S FAR PLANE is 6000 and the
// outer roads sit 6000-12000 away -- clipped before fog was ever consulted.
// A "too far to see" bug has two independent causes and they look identical.
const FOG_DRIVE = 4200
const FOG_OVERVIEW = 16000
const FAR_DRIVE = 6000
const FAR_OVERVIEW = 20000

function setRange(fog, far) {
  scene.fog.far = fog
  camera.far = far
  camera.updateProjectionMatrix()
}

function overviewPose() {
  // Frame WHERE THE WINDOWS ARE, not the whole road. Mileposts start at 1, so
  // the occupied stretch is the first few hundred units of each road; framing
  // all 6000 put every sign in a thin band at the horizon.
  const span = DISTRICT_X * (DISTRICTS.length - 1)
  return {
    pos: new THREE.Vector3(0, 1150, span * 0.5 + 1300),
    look: new THREE.Vector3(0, 0, -520),
  }
}

function goDistrict(d) {
  if (d < 0 || d >= DISTRICTS.length) return null
  state.district = d
  state.overview = false
  setRange(FOG_DRIVE, FAR_DRIVE)
  flight = { from: currentPose(), to: districtPose(d), t: 0, target: null }
  state.mode = 'flying'
  return DISTRICTS[d]
}

function goOverview() {
  state.overview = true
  setRange(FOG_OVERVIEW, FAR_OVERVIEW)
  flight = { from: currentPose(), to: overviewPose(), t: 0, target: null }
  state.mode = 'flying'
  return true
}

// ------------------------------------------------------------- the flatten
//
// PIXEL-EXACT means the surface's own pixels map 1:1 to screen pixels: no
// resampling, no blur, text as crisp as it is on a flat desktop. That is the
// whole reason to care about the distance rather than just "close enough".
//
// A world length L at distance d covers L/(2*d*tan(fov/2)) of the viewport
// height. Setting that equal to (surface px / viewport px) and solving:
//
//     d = signWorldHeight * viewportPx / (surfacePx * 2 * tan(fov/2))
//
// Note this does NOT move the sign. Invariant 6: a window's placement is its
// address. We fly the camera to the window, never the window to the camera.
function pixelExactDistance(s) {
  const worldH = s.mesh.geometry.parameters.height
  const H = renderer.domElement.height
  const fov = THREE.MathUtils.degToRad(camera.fov)
  return (worldH * H) / (s.size.height * 2 * Math.tan(fov / 2))
}

function poseFor(s) {
  // A PlaneGeometry faces +Z; after rotation.y = t its normal is (sin t, 0, cos t).
  const t = s.mesh.rotation.y
  const normal = new THREE.Vector3(Math.sin(t), 0, Math.cos(t))
  const d = pixelExactDistance(s)
  return {
    pos: s.mesh.position.clone().addScaledVector(normal, d),
    look: s.mesh.position.clone(),
  }
}

// Mileposts restart in every district, so a milepost ALONE no longer names a
// window -- (district, milepost) does. Defaulting the district to the one you
// are standing in is what makes `__flatten(2)` still mean what it used to.
function flattenTo(milepost, district = state.district) {
  const s = [...signs.values()].find((x) => x.milepost === milepost && x.district === district && x.mesh)
  if (!s) return null
  flatTargetDistrict = district
  flight = { from: currentPose(), to: poseFor(s), t: 0, target: milepost }
  state.mode = 'flying'
  return milepost
}

// Invariant 8: there is always a way out that does not depend on the 3D scene.
function release() {
  if (state.mode === 'driving') return false
  // Back to the district you were in, not to district 0 -- releasing must
  // not silently move you between workspaces.
  flight = { from: currentPose(), to: districtPose(state.district), t: 0, target: null }
  state.mode = 'flying'
  state.flatMilepost = null
  state.flatDistrict = null
  state.released++
  return true
}

function currentPose() {
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(400).add(camera.position)
  return { pos: camera.position.clone(), look }
}

function stepFlight(dt) {
  if (!flight) return
  // Ease at the same rate family RAVIO uses for camera terms (3.5-4.5); this is
  // a shot, not a thing you push.
  flight.t = Math.min(1, flight.t + dt * 2.6)
  const e = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2
  camera.position.lerpVectors(flight.from.pos, flight.to.pos, e)
  const look = new THREE.Vector3().lerpVectors(flight.from.look, flight.to.look, e)
  camera.lookAt(look)
  if (flight.t >= 1) {
    const target = flight.target
    flight = null
    if (target === null) {
      state.mode = 'driving'
    } else {
      state.mode = 'flat'
      state.flatMilepost = target
      state.flatDistrict = flatTargetDistrict
      // Invariant 7: focus follows the FLATTEN, never the drive-by.
      //
      // activateSurface RAISES the view, and that is load-bearing far beyond
      // focus: every window sits at the same rect in the flat output, so
      // pickView can only tell them apart by stacking order. Raising the
      // flattened window is what makes pointer routing hit the right surface.
      const s = [...signs.values()].find((x) => x.milepost === target && x.district === flatTargetDistrict)
      if (s?.view) {
        session.userShell.actions.activateSurface({
          id: s.view.surface.resource.id,
          client: { id: s.view.surface.resource.client.id },
        })
      }
      // Greenfield's keydown listener lives on the canvas and its `focus`
      // handler is what calls notifyKeyboardFocusIn. Without this the surface is
      // activated, looks focused, and receives no keys at all.
      renderer.domElement.focus()
    }
  }
}

// --------------------------------------------------------------- the input
//
// Raycast the sign, then convert the hit UV into the surface's own rect inside
// the FLAT output, because that is the space Greenfield's pickView works in.
function scenePointFromEvent(ev) {
  if (state.mode !== 'flat') return null
  const rect = renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(ndc, camera)
  // RECURSIVE: popup quads are children of their sign, and a menu is the thing
  // you most need to be able to click. A non-recursive pick made every popup
  // decorative.
  const meshes = [...signs.values()].filter((s) => s.mesh).map((s) => s.mesh)
  const hits = raycaster.intersectObjects(meshes, true)
  const hit = hits.find((h) => h.uv)
  if (!hit) return null

  // A popup carries its OWN view, and therefore its own rect in the ledger. Its
  // surface coordinates start at ITS top-left, not the parent's -- routing a
  // menu click through the parent's rect would land somewhere in the window
  // behind it.
  const popupView = hit.object.userData.popupView
  const target = popupView ?? signs.get(hit.object.userData.signKey)?.view
  if (!target) return null

  // The plane's v runs 0 at the BOTTOM; the surface's y runs 0 at the TOP, and
  // the sign is upright (verified by __calibrate). So vTop = 1 - uv.y.
  const u = hit.uv.x
  const vTop = 1 - hit.uv.y
  const r = target.regionRect
  return {
    x: r.x0 + u * (r.x1 - r.x0),
    y: r.y0 + vTop * (r.y1 - r.y0),
    sign: { view: target },
    isPopup: !!popupView,
  }
}

function sendMotion(ev) {
  const p = scenePointFromEvent(ev)
  if (!p) return
  state.lastScenePoint = [Math.round(p.x), Math.round(p.y)]
  state.lastWasPopup = !!p.isPopup
  // Did Greenfield resolve this point to the surface we aimed at? If not, the
  // remap is wrong and every click is landing somewhere else -- which would
  // otherwise only show up as an application behaving strangely.
  const picked = session.renderer.pickView({ x: p.x, y: p.y })
  state.lastPickMatched = picked ? keyOf(picked) === keyOf(p.sign.view) : false
  session.inputQueue.queueMotion({
    x: p.x,
    y: p.y,
    timestamp: ev.timeStamp,
    buttonCode: 0,
    released: false,
    buttons: ev.buttons ?? 0,
    sceneId: SCENE_ID,
  })
  state.pointerSent++
}

function sendButton(ev, released) {
  const p = scenePointFromEvent(ev)
  if (!p) return
  session.inputQueue.queueButton({
    x: p.x,
    y: p.y,
    timestamp: ev.timeStamp,
    buttonCode: ev.button ?? 0,
    released,
    buttons: ev.buttons ?? 0,
    sceneId: SCENE_ID,
  })
  state.buttonSent++
}

function installInput() {
  const canvas = renderer.domElement

  // CAPTURE phase on window, so this runs before Greenfield's own target-phase
  // listeners on the canvas. stopPropagation then keeps them from seeing a
  // pointer position that means nothing in a perspective scene.
  const swallow = (type, handler) =>
    window.addEventListener(
      type,
      (ev) => {
        if (state.mode === 'flat') {
          ev.stopPropagation()
          handler?.(ev)
        }
      },
      { capture: true },
    )

  swallow('pointermove', sendMotion)
  swallow('pointerdown', (ev) => sendButton(ev, false))
  swallow('pointerup', (ev) => sendButton(ev, true))
  swallow('wheel', null)

  // Clicking a sign while driving flies to it. This is the only pointer path
  // that is live outside `flat`.
  canvas.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'driving') return
    const rect = canvas.getBoundingClientRect()
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    )
    const meshes = [...signs.values()].filter((s) => s.mesh).map((s) => s.mesh)
    const hit = raycaster.intersectObjects(meshes, false)[0]
    if (hit) flattenTo(signs.get(hit.object.userData.signKey).milepost)
  })

  // THE ESCAPE HATCH (invariant 8). Capture phase, or the focused client's
  // keydown listener eats it first -- a focused surface swallows every key
  // including Esc, which is exactly how PARKVPS lost its way back to the road.
  //
  // NOT Esc+CapsLock: CapsLock is a lock, not a modifier, so it would steal Esc
  // from vi whenever the light is on, and the page cannot see the light.
  // District keys. Deliberately NOT live while flat: a digit typed into a
  // focused application must reach the application, not move you to another
  // workspace.
  window.addEventListener('keydown', (ev) => {
    if (state.mode === 'flat' || ev.ctrlKey || ev.altKey || ev.metaKey) return
    const n = Number(ev.key)
    if (Number.isInteger(n) && n >= 1 && n <= DISTRICTS.length) goDistrict(n - 1)
    else if (ev.key === 'o' || ev.key === 'O') goOverview()
  })

  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.ctrlKey && ev.altKey && ev.shiftKey && ev.key === 'Escape') {
        ev.stopPropagation()
        ev.preventDefault()
        release()
        canvas.blur()
      }
    },
    { capture: true },
  )
}

// --------------------------------------------------------------- the frame

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
    stepFlight(dt)
    // Greenfield decoded into OUR context and left its own bindings behind.
    // three caches GL state and would otherwise trust a cache that is no longer
    // true. This call exists for exactly this kind of interop.
    renderer.resetState()
    renderer.render(scene, camera)
    state.frames++
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
      districtName: DISTRICTS[s.district],
      milepost: s.milepost,
      slot: s.slot,
      built: !!s.mesh,
      size: s.size ?? null,
    })
    if (s.mesh) out.sweeps.push({ milepost: s.milepost, district: s.district, ...sweepSign(s) })
  }
  out.camera = [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)]
  out.districtNames = DISTRICTS
  out.districtX = DISTRICTS.map((_, d) => districtX(d))
  return out
}

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

window.__district = (d) => goDistrict(d)
window.__overview = () => goOverview()

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

  try {
    buildWorld(document.getElementById('gl'))
    frame()

    await initWasm()
    session = await createCompositorSession('rrabbit-m1')
    window.__session = session

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
    // 10Hz: scanning every client object per frame is not free, and a popup
    // appearing 100ms late is invisible to a person.
    setInterval(mapStrandedPopups, 100)
    pollTubes()
    setInterval(pollTubes, 2000)
    state.compositor = 'up'

    // `?remote=/text-editor,/xterm` launches NATIVE applications through
    // compositor-proxy (npm run proxy) instead of in-browser clients. Native is
    // the case that decides whether §7's per-window encode cost is affordable,
    // and nothing before this exercised gstreamer at all.
    const params = new URLSearchParams(location.search)
    const remote = params.get('remote')
    if (remote) {
      const base = params.get('proxy') ?? 'http://127.0.0.1:8912'
      const launcher = createAppLauncher(session, 'remote')
      for (const path of remote.split(',')) {
        const app = launcher.launch(new URL(`${base}${path}`), () => {})
        app.onStateChange = (s) => {
          state.appStates = { ...(state.appStates ?? {}), [path]: s }
        }
        app.onError = (e) => {
          state.error = `${path}: ${e}`
        }
      }
      say(`compositor up -- launching remote ${remote}`)
    } else {
      // Windows open in the district you are STANDING IN -- assignment reads
      // `state.district` at adoption time, exactly as it would if you were
      // driving around opening things. `?windows=2,2,1` is per-district counts.
      const launcher = createAppLauncher(session, 'web')
      const clientName = params.get('client') ?? 'simple-shm'
      const plan = (params.get('windows') ?? '2,2,1').split(',').map((n) => parseInt(n, 10) || 0)
      ;(async () => {
        for (let d = 0; d < Math.min(plan.length, DISTRICTS.length); d++) {
          state.district = d
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
        state.district = 0
        goDistrict(0)
        say(`${DISTRICTS.length} districts -- keys 1..${DISTRICTS.length}, O for overview`)
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
