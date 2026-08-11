// TRAVEL -- the one who navigates.
//
// Travel's question is always *where am I, and how do I get to the other
// thing*: the road under you, the camera, the flight into a window and the
// chord back out, the districts you switch between. Travel does not know what a
// window IS -- only where it stands and how to arrive at it pixel-exact.
//
// Everything below was moved out of m2/shell.js unchanged. The bindings it used
// to read as module-level `let`s are handed over by attachTravel() instead, so
// no line inside a moved function needed rewriting -- this was a cut, not a
// rewrite, and the milestones it carries were re-measured after it.
//
// What Travel needs from RRABBIT is exactly two things, and both go through the
// shared ledger rather than through a call: which sign stands at an address,
// and what rect that sign owns in the flat output.

import * as THREE from 'three'
import { createAxisEventFromWheelEvent } from '@gfld/compositor'
import { state, signs, keyOf, SCENE_ID, MILE } from './world.js'
import * as ws from './workspaces.js'
import { gantryMeshes, exitOf, setHovered } from './gantry.js'

let renderer, gl, scene, camera, session
export function attachTravel(c) {
  ;({ renderer, gl, scene, camera, session } = c)
}

// Camera flight. `from`/`to` are poses; t runs 0..1.
let flight = null
let flatTargetDistrict = null
const raycaster = new THREE.Raycaster()

// ------------------------------------------------------------- the district

// How far down the road you have driven, in world units, 0 at the start and
// negative going away. It is a property of the ROAD, not of a district: step
// sideways into another workspace and you are still the same distance along.
let roadZ = 0

// The road only exists where the windows are. Past the last milepost there is
// nothing to look at, and before the first you are staring at the back of your
// own starting line, so the wheel stops at both.
function roadBounds() {
  // The district you are STANDING in, not every sign in the world: roads are
  // different lengths, and borrowing another workspace's last milepost lets you
  // drive off the end of a short one into nothing.
  let far = 0
  for (const s of signs.values()) if (s.mesh && s.district === state.district) far = Math.max(far, s.milepost)
  return { near: 0, far: far ? -(far - 1) * MILE : 0 }
}

function districtPose(id) {
  const x = ws.laneX(id)
  return {
    pos: new THREE.Vector3(x, 105, 260 + roadZ),
    look: new THREE.Vector3(x, 105, -640 + roadZ),
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
  //
  // The span comes from the LAYOUT rather than from `spacing * (count - 1)`.
  // That arithmetic was also reading `DISTRICT_X`, which this module never
  // imported -- so the overview threw a ReferenceError the moment anyone pressed
  // O. Asking the layout is both correct when the lanes are not evenly spaced
  // and impossible to write without the value being in scope.
  const span = ws.span()
  return {
    pos: new THREE.Vector3(0, 1150, span * 0.5 + 1300),
    look: new THREE.Vector3(0, 0, -520),
  }
}

// `id` is a workspace id. A CLOSED workspace is refused rather than flown to:
// it has no road laid, so arriving would put you in the air over a gap.
function goDistrict(id) {
  const w = ws.get(id)
  if (!w || !w.open) return null
  state.district = id
  state.overview = false
  setRange(FOG_DRIVE, FAR_DRIVE)
  flight = { from: currentPose(), to: districtPose(id), t: 0, target: null }
  state.mode = 'flying'
  return w.name
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

// A ZOOM BELONGS TO THE WINDOW YOU SET IT ON, and is remembered across leaving
// and coming back.
//
// It did not used to be. The rule was "arriving is always pixel-exact", on the
// reasoning that a zoom left over from the last window would be a lie about
// scale -- true of a GLOBAL zoom, which is what flatZoom was. Per window it is
// not a leftover, it is the size you chose for that window, and having to
// re-choose it every time you glance away is the same as not being able to
// choose it at all. Reported.
//
// The cost is real and stays written down: a window you have zoomed is NOT
// pixel-exact when you arrive at it, which is the one property the flatten
// exists to provide. `state.flatZoom` is non-zero exactly when that is the case,
// so the claim is always checkable. A window you have never zoomed still lands
// at 1:1, which is every window until you say otherwise.
//
// Keyed by ADDRESS, not by view key: a surface that is remapped gets a new view
// but keeps its milepost (invariant 6), and mileposts are never reissued, so a
// later window cannot inherit a dead one's zoom.
const zoomMemory = new Map()
const zoomKey = (district, milepost) => `${district}:${milepost}`
const rememberedZoom = (s) => zoomMemory.get(zoomKey(s.district, s.milepost)) ?? 0

function poseFor(s) {
  // A PlaneGeometry faces +Z; after rotation.y = t its normal is (sin t, 0, cos t).
  const t = s.mesh.rotation.y
  const normal = new THREE.Vector3(Math.sin(t), 0, Math.cos(t))
  // Fly to where this window was left, so it arrives at the size you set rather
  // than landing pixel-exact and snapping.
  const d = pixelExactDistance(s) + rememberedZoom(s)
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

// How much closer or further than pixel-exact you have pulled the flattened
// window, in world units. Restored per window on arrival -- see zoomMemory.
let flatZoom = 0

// A wheel gesture and its owner. Browsers do not delimit wheel gestures, so a
// gap in the event stream is the only signal there is; 350ms is long enough to
// span a trackpad's momentum tail and short enough that a deliberate second
// scroll is a new gesture.
const GESTURE_GAP = 350
let wheelOwner = null
let lastWheelAt = 0
function resetWheelGesture() {
  wheelOwner = null
  lastWheelAt = 0
}

// ZOOMING DELIBERATELY LEAVES PIXEL-EXACT, and that is the whole cost of this
// feature: at flatZoom 0 the surface is 1:1 with its texture, which is what the
// flatten is FOR, and any other distance is resampling. It is a choice the
// person made with the wheel, it is undone by leaving and coming back, and no
// other code may set it -- an automatic zoom would silently break the one
// property the flatten exists to provide.
function zoomFlat(d) {
  const s = [...signs.values()].find(
    (x) => x.mesh && x.milepost === state.flatMilepost && x.district === state.flatDistrict,
  )
  if (!s) return
  const base = pixelExactDistance(s)
  // Closer than a third and the surface fills more than the frame; further than
  // 2.5x and you are looking at the road again, which is what release is for.
  flatZoom = Math.min(base * 1.5, Math.max(-base * 0.65, flatZoom + d))
  const t = s.mesh.rotation.y
  const normal = new THREE.Vector3(Math.sin(t), 0, Math.cos(t))
  camera.position.copy(s.mesh.position).addScaledVector(normal, base + flatZoom)
  camera.lookAt(s.mesh.position)
  state.flatZoom = Math.round(flatZoom)
  zoomMemory.set(zoomKey(s.district, s.milepost), flatZoom)
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
  resetWheelGesture()
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
      // Arriving restores THIS window's zoom -- see zoomMemory. `poseFor` flew
      // us to that distance, so this is agreeing with where the camera already
      // is, not moving it. A window never zoomed reads 0 and lands 1:1.
      const arriving = [...signs.values()].find(
        (x) => x.milepost === target && x.district === flatTargetDistrict,
      )
      flatZoom = arriving ? rememberedZoom(arriving) : 0
      state.flatZoom = Math.round(flatZoom)
      // A gesture cannot span a flight. Without this, a wheel still in flight
      // when you arrive would be owned by whatever the LAST window decided.
      resetWheelGesture()
      // Invariant 7: focus follows the FLATTEN, never the drive-by.
      //
      // activateSurface RAISES the view, and that is load-bearing far beyond
      // focus: every window sits at the same rect in the flat output, so
      // pickView can only tell them apart by stacking order. Raising the
      // flattened window is what makes pointer routing hit the right surface.
      if (arriving?.view) {
        session.userShell.actions.activateSurface({
          id: arriving.view.surface.resource.id,
          client: { id: arriving.view.surface.resource.client.id },
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

// Is the pointer over the surface you are flattened on?
//
// scenePointFromEvent returns `sign: { view }` and NOTHING else -- no milepost,
// no district -- so the obvious `p.sign.milepost === state.flatMilepost` is
// undefined === number, false forever, and every scroll silently became a zoom.
// The view key is the only identity that crosses this boundary.
//
// A popup counts as the application: a menu is a window's own surface with its
// own view, and scrolling a menu must reach the menu.
function overFlatSurface(ev) {
  const p = scenePointFromEvent(ev)
  if (!p) return null
  if (p.isPopup) return p
  const flat = [...signs.values()].find(
    (s) => s.mesh && s.milepost === state.flatMilepost && s.district === state.flatDistrict,
  )
  if (!flat?.view) return null
  return keyOf(p.sign.view) === keyOf(flat.view) ? p : null
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
  //
  // `passive` is explicit for the wheel. A wheel listener on `window` is PASSIVE
  // BY DEFAULT in Chrome, so `ev.preventDefault()` inside it is silently ignored
  // -- the shell would refuse the scroll and the page would scroll anyway.
  const swallow = (type, handler, opts) =>
    window.addEventListener(
      type,
      (ev) => {
        if (state.mode === 'flat') {
          ev.stopPropagation()
          handler?.(ev)
        }
      },
      { capture: true, ...opts },
    )

  swallow('pointermove', sendMotion)
  // A click on the window is the application's. A click on anything else --
  // the road, the sky, the space beside the surface -- is you asking to leave,
  // the same answer Esc gives. Clicking "outside" to dismiss is what every
  // other overlay in computing already taught people, and while flat it was the
  // one gesture that did nothing at all.
  swallow('pointerdown', (ev) => {
    if (!overFlatSurface(ev)) {
      release()
      canvas.blur()
      return
    }
    sendButton(ev, false)
  })
  swallow('pointerup', (ev) => sendButton(ev, true))
  // Flat: the wheel belongs to whatever the pointer is over -- decided ONCE PER
  // GESTURE, not once per event.
  //
  // Over the window, it is the application's scroll -- a list scrolls, a
  // document goes up and down, and the shell must not steal that. Anywhere else
  // it is the shell's, and it dollies you toward or away from the surface you
  // are standing in front of. That rule is right and it stays.
  //
  // ASKING PER EVENT MADE THE ZOOM DESTROY ITS OWN PRECONDITION. Zooming in
  // makes the surface bigger around the point the camera looks at, so after a
  // few notches the growing window reaches the cursor that was beside it. From
  // that event on, every wheel went to the application -- IN EITHER DIRECTION,
  // so scrolling back could not undo it either. Measured: three notches from
  // pixel-exact, `lastAxisToApp` flips true, `flatZoom` freezes at -162 and
  // never moves again. Reported as "the scroll only works for a split second
  // after entering the window then it breaks", which is exactly what it was.
  //
  // So the owner is decided at the START of a gesture and held until the gesture
  // ends -- a gap of GESTURE_GAP ms with no wheel events. That protects both
  // sides: the shell cannot steal a fast scroll from a list because the pointer
  // strayed off it, and the application cannot steal a zoom because the window
  // grew under the cursor.
  //
  // Ctrl (and Cmd) always mean the shell, anywhere, including over the window.
  // That is what ctrl+wheel means everywhere else, it is what a trackpad pinch
  // arrives as, and it is a route to the zoom that no feedback loop can take
  // away.
  swallow(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const now = ev.timeStamp
      if (wheelOwner === null || now - lastWheelAt > GESTURE_GAP) {
        wheelOwner = ev.ctrlKey || ev.metaKey ? 'shell' : overFlatSurface(ev) ? 'app' : 'shell'
        state.wheelGestures++
      }
      lastWheelAt = now
      if (wheelOwner === 'app') {
        session.inputQueue.queueAxis(createAxisEventFromWheelEvent(ev, SCENE_ID))
        state.lastAxisToApp = true
        return
      }
      state.lastAxisToApp = false
      zoomFlat(ev.deltaY * 0.45)
    },
    { passive: false },
  )

  // Driving: the wheel moves you ALONG the road, which is the one thing it was
  // obviously for and the one thing it did not do. The camera is static while
  // driving -- only stepFlight ever moved it -- so the road slid past nobody and
  // every window sat at whatever distance it was first laid down at.
  //
  // Not `passive`, because at the ends of the road we refuse the scroll and the
  // page should not also scroll behind us.
  window.addEventListener(
    'wheel',
    (ev) => {
      if (state.mode !== 'driving') return
      ev.preventDefault()
      const { near, far } = roadBounds()
      // Trackpads emit many small deltas and a wheel a few large ones; scaling
      // by the delta keeps both feeling like the same road.
      // deltaY is NEGATIVE when the wheel rolls away from you, which everything
      // else in the world treats as forward/closer -- so it adds, not subtracts.
      roadZ = Math.min(near, Math.max(far, roadZ + ev.deltaY * 0.6))
      const p = districtPose(state.district)
      camera.position.copy(p.pos)
      camera.lookAt(p.look)
    },
    { capture: true, passive: false },
  )

  // What the pointer resolves to at a screen point. The wheel and the click
  // both branch on this, so when they branch wrongly this is the only place the
  // answer can be read.
  window.__scenePoint = (x, y) => {
    const p = scenePointFromEvent({ clientX: x, clientY: y })
    if (!p) return null
    // `p.sign` is `{ view }` and NOTHING else, so `p.sign.milepost` was
    // undefined here -- this probe reported `milepost: undefined` for every
    // point on every window, which is the same reading a MISS gives. Resolve
    // the address through the ledger, the way overFlatSurface has to.
    const k = keyOf(p.sign.view)
    const owner = [...signs.values()].find((s) => s.view && keyOf(s.view) === k)
    return {
      x: Math.round(p.x),
      y: Math.round(p.y),
      key: k,
      milepost: owner?.milepost ?? null,
      district: owner?.district ?? null,
      isPopup: !!p.isPopup,
    }
  }

  // The road is camera state, so nothing in the DOM can be asked where you are.
  window.__road = () => ({ roadZ, ...roadBounds(), cameraZ: camera.position.z })

  // What the GPU is actually holding. A shell that gets slower with every
  // navigation is leaking something, and the only honest way to tell a leak
  // from a slow machine is to watch these counts across a soak: a leak climbs
  // monotonically, a slow machine sits flat and just takes longer per frame.
  window.__perf = () => ({
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? -1,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    signs: signs.size,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  })

  // Clicking while driving. Two things are clickable out here and they are
  // aimed at with the same ray: a WINDOW, which you fly into, and a GANTRY LANE,
  // which you drive down.
  //
  // One raycast over both, sorted by distance, so the answer is simply whatever
  // is nearest -- a gantry that stands in front of a window really does take the
  // click, the way anything else in the world would.
  const aim = (ev) => {
    const rect = canvas.getBoundingClientRect()
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    )
    const meshes = [...gantryMeshes(), ...[...signs.values()].filter((s) => s.mesh).map((s) => s.mesh)]
    return raycaster.intersectObjects(meshes, false)[0] ?? null
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'driving') return
    const hit = aim(ev)
    if (!hit) return
    const exit = exitOf(hit.object)
    if (exit) {
      // A lane to a CLOSED workspace is barred, and clicking it does nothing
      // yet. Opening from the sign is increment 3; refusing is not a stub, it is
      // the truthful answer until then -- goDistrict would otherwise fly you to
      // a road that is not laid.
      state.lastLaneClick = { to: exit.to, opened: !!ws.get(exit.to)?.open }
      goDistrict(exit.to)
      return
    }
    flattenTo(signs.get(hit.object.userData.signKey).milepost)
  })

  // Hover, so a lane reads as clickable before you click it.
  canvas.addEventListener('pointermove', (ev) => {
    if (state.mode !== 'driving') {
      setHovered(null)
      return
    }
    const hit = aim(ev)
    setHovered(hit && exitOf(hit.object) ? hit.object : null)
    canvas.style.cursor = hit ? 'pointer' : ''
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
    // ZERO IS THE OVERVIEW TOO, not just the letter O.
    //
    // The status line said "keys 1..3, O for overview" and was read as a zero --
    // reported as "0 for overview doesn't work". In a monospace face at that
    // size the two are near enough to identical, and the workspace keys next to
    // it ARE digits, so a digit is the obvious guess. Zero is unbound (the roads
    // are numbered from 1) and it sits at the end of that same run of keys, so
    // binding it costs nothing and settles the ambiguity permanently. The label
    // now names the key that cannot be misread.
    const n = Number(ev.key)
    // A digit is a POSITION IN THE LAYOUT, not an id -- pressing 2 means "the
    // second road from the left", which is what you can see. Ids are for the
    // gantry, which names its destinations.
    if (Number.isInteger(n) && n >= 1) {
      const w = ws.at(n - 1)
      if (w) goDistrict(w.id)
    } else if (ev.key === '0' || ev.key === 'o' || ev.key === 'O') goOverview()
  })

  // TWO chords, because the first one is not always ours to receive.
  //
  // Ctrl+Alt+Shift+Esc is also what a browser-based VNC console binds to hand
  // the keyboard back -- PARKVPS does exactly that in vpsd/web/desktop.html.
  // That handler lives in the OUTER page, so it consumes the chord before the
  // keystroke is ever forwarded into the guest, and the shell never sees it.
  // Running T&R inside a PARKVPS desktop console therefore had NO way out of a
  // flattened window at all: invariant 8 held in the code and failed in the
  // only place anyone can currently run this.
  //
  // Reported as "after pressing esc the window disappears" -- which was the
  // other half of the same trap. Plain Esc is forwarded to the application by
  // design (see above), and the simple-shm test client exits on Esc, so the
  // only key that appeared to do anything killed the window instead of leaving
  // it.
  //
  // R for road. Same three modifiers, so it is equally unreachable by accident
  // from inside a focused application, and no console in front of us claims it.
  const isRelease = (ev) =>
    ev.ctrlKey && ev.altKey && ev.shiftKey && (ev.key === 'Escape' || ev.key === 'r' || ev.key === 'R')

  // AND PLAIN ESC, WHILE FLAT.
  //
  // The note above says an application must receive every key including Esc,
  // and that is the right instinct for a shell hosting vi. It was also, in
  // practice, a room with the door painted on: the chord was eaten by the
  // console in front of us, nothing on screen named a way out, and clicking
  // another window does nothing while flat. Every route out of a window was
  // either invisible or intercepted, which is what "it freezes" and "it doesn't
  // fly back to normal position" have both turned out to mean.
  //
  // So Esc leaves. The cost is real and belongs written down rather than
  // discovered: a full-screen vi in a flattened window can no longer use Esc,
  // and when a client that needs it actually ships, the honest fix is
  // double-tap-Esc -- first press to the application, a second within ~400ms to
  // the shell -- which keeps both. Nothing shipping today needs it.
  const isPlainEscape = (ev) =>
    ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey && state.mode === 'flat'

  window.addEventListener(
    'keydown',
    (ev) => {
      if (isRelease(ev) || isPlainEscape(ev)) {
        ev.stopPropagation()
        ev.preventDefault()
        release()
        canvas.blur()
      }
    },
    { capture: true },
  )
}

export {
  districtPose,
  setRange,
  overviewPose,
  goDistrict,
  goOverview,
  pixelExactDistance,
  poseFor,
  flattenTo,
  release,
  currentPose,
  stepFlight,
  scenePointFromEvent,
  // shell.js's `__pointAt`/`__pointAtPopup` call this. They were written when
  // everything lived in one file and the split did not carry the reference
  // across, so both probes threw ReferenceError instead of aiming a pointer.
  sendMotion,
  installInput,
}
