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
import { state, signs, hooks, keyOf, SCENE_ID, exitZOf, GANTRY_VIEW } from './world.js'
import * as ws from './workspaces.js'
import { gantryMeshes, actionOf, setHovered, scrollGateOf } from './gantry.js'
import { toggleMap, closeMap, isOpen as mapIsOpen } from './map.js'

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
// negative going away.
//
// EACH WORKSPACE REMEMBERS ITS OWN. It used to be one number shared by every
// road -- "step sideways into another workspace and you are still the same
// distance along" -- which is a coherent idea and is not what a workspace is
// for. You leave a road parked in front of the thing you were doing, and coming
// back to find yourself somewhere else because another road moved is the same
// complaint as the flat zoom being forgotten: a position you chose, discarded
// by something you did elsewhere. Reported.
//
// The distinction that survives is between the two ways of arriving, and it is
// the one goDistrict already draws: a workspace KEY is a step sideways and
// restores where you were, while taking an EXIT is a junction and puts you at
// the head of the new road.
let roadZ = 0
const roadMemory = new Map()

// WHERE YOU HAVE BEEN, so there is a way back that does not require remembering.
//
// Only workspace CHANGES go on it -- pressing 2 while already on lane 2 is not a
// journey -- and it is capped, because this is a trail to retrace and not a log.
// `goBack` pops rather than pushing, or back would be a place you could go
// forward to and the button would just oscillate between two roads.
const HISTORY_MAX = 32
const history = []
let goingBack = false

export function backTarget() {
  for (let i = history.length - 1; i >= 0; i--) {
    const id = history[i]
    if (id !== state.district && ws.get(id)?.open) return id
  }
  return null
}

function goBack() {
  const id = backTarget()
  if (!id) return null
  // Drop everything from that entry onward, so repeated backs walk the trail
  // rather than bouncing off its end.
  const at = history.lastIndexOf(id)
  history.length = at
  goingBack = true
  const r = goDistrict(id)
  goingBack = false
  state.lastGantryClick = { kind: 'back', to: id }
  return r
}

// The workspace number being typed. 600ms is the pause after which a lone "1"
// stops being a possible prefix of "12" and becomes a jump to lane 1 -- long
// enough that a deliberate two-digit number is never split, short enough that a
// single-digit jump on a big network does not feel like it hung.
const DIGIT_GAP = 600
let digits = ''
let digitTimer = 0

function commitDigits() {
  clearTimeout(digitTimer)
  digitTimer = 0
  const n = Number(digits)
  digits = ''
  // A digit is a POSITION IN THE LAYOUT, not an id -- typing 2 means "the second
  // road", which is what the map numbers. Ids are for the gates, which name
  // their destinations.
  const w = n >= 1 ? ws.at(n - 1) : null
  state.lastLaneKey = { typed: n, went: w?.id ?? null }
  if (w) goDistrict(w.id)
}

// The road runs from the head to the EXIT GATE, and the wheel stops at both.
//
// It used to stop at the last window, which was right when the last window was
// the last thing on the road. It no longer is: there is a gate past them, and a
// road you cannot drive to the end of is a road with an unreachable exit. The
// far stop leaves the exit gate GANTRY_VIEW ahead of you -- the same framing the
// enter gate gets when you are parked at the head -- so you finish the road
// looking at the sign rather than standing under it.
function roadBoundsOf(id) {
  // exitZOf reads ONE workspace's own signs, not every sign in the world: roads
  // are different lengths, and borrowing another workspace's last window lets
  // you drive off the end of a short one into nothing.
  // camera z is 260 + roadZ, and we want (camera z - exitZ) === GANTRY_VIEW.
  return { near: 0, far: exitZOf(id) + GANTRY_VIEW - 260 }
}

const roadBounds = () => roadBoundsOf(state.district)

function districtPose(id) {
  const x = ws.laneX(id)
  return {
    pos: new THREE.Vector3(x, 105, 260 + roadZ),
    look: new THREE.Vector3(x, 105, -640 + roadZ),
  }
}

// THE 3D OVERVIEW IS GONE, and map.js is what replaced it.
//
// It flew the camera to 1150 units up and back so every road was in shot, and
// what you got was a picture of the roads: grey strips with flecks on them. It
// could not answer which workspace connects to which, what is on each one, or
// take me to that. Those are the questions you have from up there, so the
// overview is a MAP now -- nodes, arrows, names, counts, clickable -- and this
// module keeps only the driving ranges.
//
// The measurement it cost is worth keeping even though its code is not: a "too
// far to see" bug has TWO independent causes that look identical. Widening
// scene.fog.far alone still rendered black, because the CAMERA'S FAR PLANE
// clips before fog is ever consulted. If anything here ever needs to see a long
// way again, both budgets move together or the shot is of nothing.
const FOG_DRIVE = 4200
const FAR_DRIVE = 6000

function setRange(fog, far) {
  scene.fog.far = fog
  camera.far = far
  camera.updateProjectionMatrix()
}

// `id` is a workspace id. A CLOSED workspace is refused rather than flown to:
// it has no road laid, so arriving would put you in the air over a gap.
//
// WHERE ALONG THE NEW ROAD YOU LAND depends on how you got there, and both
// answers are right for their own gesture:
//
//   `atHead` -- you TOOK AN EXIT. The exit gate is a junction, and coming off a
//   junction puts you at the start of the next road, which is also the only
//   place a brand-new workspace makes sense to arrive at: its entrance, where
//   windows are opened.
//
//   otherwise -- you pressed a workspace key, which is a step sideways, and you
//   are put back exactly where you left THAT road (see roadMemory).
//
//   `at` -- a caller that knows exactly where on the road it wants you, which
//   is the map picking a window. It BEATS the memory, and saying so explicitly
//   is the fix for a real bug: goWindow used to publish its target by writing it
//   into roadMemory, and the "park the road you are leaving" line below then
//   overwrote it with the current position whenever the destination was the road
//   you were already on. So picking a window on your OWN lane read the value
//   back unchanged and nothing moved -- reported as the map not shifting when
//   toggling between two windows on the same lane. A destination is an argument,
//   not a message left in shared state.
//
// Either way roadZ is CLAMPED to the destination's own bounds. Roads are
// different lengths now that the exit gate stands past the last window, so
// carrying a position from a long road onto a short one put the camera beyond
// its exit gate, looking back up an empty road at nothing. Measured: arriving on
// a fresh workspace at roadZ -2580 whose far bound was -1800. The clamp still
// matters with per-road memory, because a road SHRINKS when its last window
// closes.
function goDistrict(id, { atHead = false, at = null } = {}) {
  const w = ws.get(id)
  if (!w || !w.open) return null
  // Park the road you are leaving before you leave it.
  if (state.district) roadMemory.set(state.district, roadZ)
  if (state.district && state.district !== id && !goingBack) {
    history.push(state.district)
    if (history.length > HISTORY_MAX) history.shift()
    state.historyDepth = history.length
  }
  const b = roadBoundsOf(id)
  const want = at !== null ? at : atHead ? b.near : (roadMemory.get(id) ?? b.near)
  roadZ = Math.min(b.near, Math.max(b.far, want))
  roadMemory.set(id, roadZ)
  state.district = id
  setRange(FOG_DRIVE, FAR_DRIVE)
  flight = { from: currentPose(), to: districtPose(id), t: 0, target: null }
  state.mode = 'flying'
  return w.name
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
// How far the wheel may take you either way, as a fraction of pixel-exact
// distance. Named because the DEFAULT is now one of them and the two must not
// drift apart: a default outside the clamp would be shoved back by the first
// scroll, which reads as the zoom jumping when you touch it.
const ZOOM_IN_LIMIT = 0.65
const ZOOM_OUT_LIMIT = 1.5

const zoomMemory = new Map()
const zoomKey = (district, milepost) => `${district}:${milepost}`
// A window you have never zoomed arrives ALL THE WAY IN -- the wheel's own near
// limit, not a separate number -- because that is what was asked for, and
// because a window you have just flown into is one you are about to work in.
//
// THIS RETIRES THE LAST OF "ARRIVING IS ALWAYS PIXEL-EXACT". The cost was
// already stated when zoom became per-window; it is now paid by default rather
// than only by windows you had zoomed, so it is worth saying flatly: at
// ZOOM_IN_LIMIT the surface is drawn at about 2.9x and IS RESAMPLED, and a tall
// one can exceed the viewport and be cropped. Scroll out once and that is
// remembered for that window forever, which is the whole point of the memory.
// `state.flatZoom === 0` is still exactly the pixel-exact case.
// ...BUT NEVER SO FAR IN THAT THE WINDOW STOPS FITTING ON THE SCREEN.
//
// The hard near limit crops: measured, a 250x250 surface arrives 714px tall in a
// 577-tall canvas. That was a stated cost when it was only about pixels, and it
// stopped being only about pixels when the window got a RESIZE GRAB at its
// bottom-right corner -- measured again, the grab landed at screen y 651 in that
// same 577-tall viewport, so the default arrival put the new control off the
// screen. A control you cannot reach in the default state is not a control.
//
// So: as far in as the wheel goes, or as far in as still fits, whichever is
// less. FIT is the same 0.86 of the frame the road view and the gantry use, and
// the slack is what the grab sits in. `?zoom=max` restores the hard limit for
// anyone who wants the crop.
const FIT = 0.86
const ZOOM_MODE = new URLSearchParams(location.search).get('zoom')

// The distance at which the sign fills FIT of the frame, whichever axis binds.
// The closest you can stand and still see all of the window.
function fitDistance(s) {
  const g = s.mesh.geometry.parameters
  const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * FIT
  return Math.max(g.height / (2 * vTan), g.width / (2 * vTan * camera.aspect))
}

function defaultZoom(s) {
  const base = pixelExactDistance(s)
  const hard = -ZOOM_IN_LIMIT * base
  if (ZOOM_MODE === 'max') return hard
  // Both are offsets from pixel-exact and both are negative going in, so the
  // nearer of the two is the more negative -- take the less negative one.
  return Math.max(hard, fitDistance(s) - base)
}
const rememberedZoom = (s) => zoomMemory.get(zoomKey(s.district, s.milepost)) ?? defaultZoom(s)

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
const flatSign = () =>
  [...signs.values()].find(
    (x) => x.mesh && x.milepost === state.flatMilepost && x.district === state.flatDistrict,
  ) ?? null

// One place that puts the camera at a chosen offset from pixel-exact. Both the
// wheel and the resize move the camera, and they must clamp, record and remember
// identically or the two disagree about where you are standing.
function applyFlatZoom(s, want) {
  const base = pixelExactDistance(s)
  // Closer than a third and the surface fills more than the frame; further than
  // 2.5x and you are looking at the road again, which is what release is for.
  flatZoom = Math.min(base * ZOOM_OUT_LIMIT, Math.max(-base * ZOOM_IN_LIMIT, want))
  const t = s.mesh.rotation.y
  const normal = new THREE.Vector3(Math.sin(t), 0, Math.cos(t))
  camera.position.copy(s.mesh.position).addScaledVector(normal, base + flatZoom)
  camera.lookAt(s.mesh.position)
  state.flatZoom = Math.round(flatZoom)
  zoomMemory.set(zoomKey(s.district, s.milepost), flatZoom)
}

function zoomFlat(d) {
  const s = flatSign()
  if (s) applyFlatZoom(s, flatZoom + d)
}

// WHILE RESIZING, HOLD THE PIXEL SCALE -- which is what makes a resize look like
// one.
//
// A sign's world width is a constant 300 whatever its surface is (makeSign), so
// growing the surface at a fixed camera distance makes the window DENSER and not
// bigger: measured, dragging 250x250 out to 326x310 left it 496px wide on screen
// both before and after, which is not what dragging a window corner means
// anywhere else in computing.
//
// Holding the scale instead moves the camera in as the surface grows, so the
// corner stays under the pointer and the window gets bigger. The arithmetic is
// one line: scale is base/d by construction, so d = base/scale.
//
// Runs every frame rather than once per configure because the surface does not
// change when we ask -- the client has to ack and reallocate, and the sign is
// rebuilt some frames later.
function holdFlatScale() {
  const job = resizing ?? settling
  if (!job || state.mode !== 'flat') {
    settling = null
    return
  }
  const s = flatSign()
  if (!s?.mesh) return
  const base = pixelExactDistance(s)
  // Hold the scale, BUT NEVER CLOSER THAN FIT. Holding it strictly is right
  // until the window grows past the frame, at which point the grab you are
  // dragging leaves the screen with it -- measured, growing 250x250 to 326x310
  // put the corner at y 600 in a 577-tall viewport, so the gesture could be
  // made and then not undone. Past that point the window keeps gaining
  // resolution and stops gaining size, which is the half of the trade that can
  // be reversed.
  const d = Math.max(base / job.scale0, fitDistance(s))
  applyFlatZoom(s, d - base)
  if (!settling) return

  const arrived = s.size.width === settling.w && s.size.height === settling.h
  if (arrived || performance.now() > settling.until) {
    // One last apply at the size that actually arrived, then let go -- the zoom
    // it lands on is now this window's, remembered like any other.
    if (!arrived) state.resizeGaveUp = { asked: [settling.w, settling.h], got: [s.size.width, s.size.height] }
    settling = null
    return
  }

  // ASK AGAIN UNTIL IT IS TRUE.
  //
  // configureSize is fire-and-forget: there is no failure to catch and no reply
  // that means "applied". A client that is mid-reallocation, or holding both its
  // buffers, simply does nothing with a configure -- measured, a drag that asked
  // for 355x338 left the surface at 271x268 and nothing anywhere said so. The
  // size you let go at is the one that matters, so it is re-asked at a rate a
  // client can absorb until the surface is observed to be it, or until the
  // deadline says the client is refusing rather than lagging.
  if (performance.now() - settling.sentAt > 220) {
    settling.sentAt = performance.now()
    settling.role.configureSize({ width: settling.w, height: settling.h })
    state.configures = (state.configures ?? 0) + 1
    state.resizeRetries = (state.resizeRetries ?? 0) + 1
  }
}

// ------------------------------------------------------------- the resize
//
// A window you are standing in can be RESIZED, by dragging the grab at its
// bottom-right corner. This is a real xdg_toplevel configure -- the client is
// told a new size, reallocates its buffer and paints at it -- not a scale on the
// quad, which would just be the zoom under another name and would resample
// rather than give the application more room.
//
// WHY A CORNER GRAB AND NOT A DRAG ON THE EDGE OF THE SURFACE. While flat, every
// pointer event over the window belongs to the application (that is the whole
// point of the flatten) and every event beside it means "leave". There is no
// spare gesture in between, so the resize needs a target of its own that is
// neither: a small quad hung off the sign, hit-tested before both rules.
//
// The drag is in SCREEN pixels and the configure is in SURFACE pixels, and while
// flat the two differ by a known scale -- the sign is fronto-parallel, so one
// number converts them. Measuring it from the camera distance rather than from
// the last flatten means it stays right while you are zoomed.
let resizing = null

// A RESIZE IS NOT OVER WHEN THE DRAG IS.
//
// configureSize only ASKS. The client has to ack the configure, reallocate its
// buffer and paint, and the sign is rebuilt some frames after that -- so at
// pointerup the surface is usually still its old size. Holding the scale only
// while the pointer is down therefore held it over the period when nothing had
// changed yet, and let go exactly when the change arrived: measured, a drag from
// 250x250 to 326x310 left the window 496px wide on screen before AND after.
//
// So the hold outlives the drag, until the surface reaches the size that was
// asked for or the client makes it clear it is not going to.
let settling = null

function surfacePerScreenPx(s) {
  const dist = camera.position.distanceTo(s.mesh.position)
  const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / renderer.domElement.height
  return worldPerPx * (s.size.width / s.mesh.geometry.parameters.width)
}

// Where the grab is on screen. Also what the probe aims at, so the test drives
// the same pixels a hand would.
function handlePoint() {
  const s = flatSign()
  if (!s?.handle?.userData?.armed || !s.grabPad) return null
  const v = s.grabPad.getWorldPosition(new THREE.Vector3()).project(camera)
  return {
    x: ((v.x + 1) / 2) * renderer.domElement.clientWidth,
    y: ((1 - v.y) / 2) * renderer.domElement.clientHeight,
  }
}

// The grip brightens and the cursor changes when the pointer is over the pad --
// the same signal the gantry lanes give, and the only thing that says a control
// is there before you press it.
function setGrabHot(s, hot) {
  if (!s?.handle) return
  const show = !!hot && !!s.handle.userData.armed
  s.handle.visible = show
  renderer.domElement.style.cursor = show ? 'nesw-resize' : ''
  state.grabHot = show
}

function handleUnder(ev) {
  const s = flatSign()
  if (!s?.handle?.userData?.armed || !s.grabPad) return null
  const rect = renderer.domElement.getBoundingClientRect()
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  )
  return raycaster.intersectObject(s.grabPad, false).length ? s : null
}

function startResize(s, ev) {
  // BY SHAPE, NOT BY CLASS NAME. Minification renames constructors and every
  // check keyed on one was dead in the shipped bundle (see rrabbit.js); a method
  // name survives, and `configureSize` is the only thing actually needed here.
  const role = s.view?.surface?.role
  if (typeof role?.configureSize !== 'function') return false
  resizing = {
    sx: ev.clientX,
    sy: ev.clientY,
    w: s.size.width,
    h: s.size.height,
    k: surfacePerScreenPx(s),
    // Screen pixels per surface pixel at the moment the drag began -- the thing
    // holdFlatScale keeps constant.
    scale0: 1 / surfacePerScreenPx(s),
    role,
    min: role.queryMinSize?.() ?? null,
    max: role.queryMaxSize?.() ?? null,
  }
  role.configureResizing?.(true)
  state.resizes = (state.resizes ?? 0) + 1
  return true
}

// A pointermove can fire many times between two frames, and every configureSize
// is a round trip the client has to ack and a buffer it may reallocate. Compute
// per event, SEND per frame.
// ONE CONFIGURE IN FLIGHT AT A TIME.
//
// configureSize does not resize anything -- it asks, and the client acks and
// reallocates in its own time. Greenfield's scheduleConfigure DROPS a new
// request outright when one is already queued and differs, so a stream of them
// does not queue up, it goes missing: measured, a drag paced across 40 frames
// asked for 334x320, left ONE unacked configure outstanding, `pending.size` at
// {0,0}, and the surface still 250x250. Reported as the drag working for a
// little bit and then freezing, which is exactly the shape of it -- the first
// configure lands, the rest are dropped on the floor.
//
// So the next one is sent only once the last has LANDED, which is observable
// without any Greenfield internals: the sign's size is the size the surface
// actually reached. A 400ms stale timer covers a client that ignores a configure
// it does not like, and `force` covers the last one, which must go out even if
// the previous is still in the air or the final pixels of every drag are lost.
// Called once, from endResize. Kept as its own function because "the size the
// drag ended on" and "the act of asking for it" are different things and the
// retry in holdFlatScale needs the second one too.
function flushResize() {
  const r = resizing
  if (!r?.want) return
  const { w, h } = r.want
  r.want = null
  if (w === r.w && h === r.h) return
  r.lastW = w
  r.lastH = h
  r.sentAt = performance.now()
  r.role.configureSize({ width: w, height: h })
  state.resizeTo = [w, h]
  state.configures = (state.configures ?? 0) + 1
}

// THE DRAG IS A PREVIEW; THE COMMIT IS ONE REQUEST ON RELEASE.
//
// Measured, and this is the whole reason for the shape of it: a single spaced
// configure lands every time (250 -> 292 -> 320 -> 299, three in a row), while a
// stream during a drag applies one or two and then the client stops honouring
// them at all -- it keeps acking, keeps painting, and ignores the size. Re-asking
// afterwards does not recover it: nine retries over two and a half seconds left
// the surface at 252 when 355 was asked for.
//
// So do not stream. Scale the quad while you drag, which costs the client
// nothing and shows the size you are choosing, and send exactly one configure
// when you let go -- the case that is known to work.
//
// The grip counter-scales so it stays the same size under the pointer; the hit
// pad does not, because a target that grows with the window is only easier.
function previewResize(r, w, h) {
  const s = flatSign()
  if (!s?.mesh) return
  const sx = w / r.w
  const sy = h / r.h
  s.mesh.scale.set(sx, sy, 1)
  if (s.frame) s.frame.scale.set(sx, sy, 1)
  if (s.handle) s.handle.scale.set(1 / sx, 1 / sy, 1)
  state.resizePreview = [w, h]
}

function clearPreview() {
  const s = flatSign()
  if (!s?.mesh) return
  s.mesh.scale.set(1, 1, 1)
  if (s.frame) s.frame.scale.set(1, 1, 1)
  if (s.handle) s.handle.scale.set(1, 1, 1)
  state.resizePreview = null
}

function stepResize(ev) {
  const r = resizing
  // A client may declare its own limits and they are the client's to declare.
  // The floor of 64 is ours, and it is the difference between a small window and
  // a window nobody can find again.
  const minW = Math.max(64, r.min?.width || 0)
  const minH = Math.max(64, r.min?.height || 0)
  const maxW = r.max?.width || 4096
  const maxH = r.max?.height || 4096
  // The grab is the TOP-right corner, so screen-y UP is taller -- which is also
  // the direction that corner really travels, since the sign's bottom edge is
  // pinned to the road and it grows upward.
  const w = Math.round(Math.min(maxW, Math.max(minW, r.w + (ev.clientX - r.sx) * r.k)))
  const h = Math.round(Math.min(maxH, Math.max(minH, r.h - (ev.clientY - r.sy) * r.k)))
  // Only configure on a CHANGE. A pointermove at 120Hz that re-sends the same
  // size is a configure the client has to ack, and a buffer it may reallocate.
  r.want = { w, h }
  previewResize(r, w, h)
}

function endResize() {
  if (!resizing) return false
  // The preview goes before the request, so the quad is back at 1:1 when the
  // real buffer arrives at the new size.
  clearPreview()
  flushResize()
  if (resizing.captured !== undefined) {
    try {
      renderer.domElement.releasePointerCapture(resizing.captured)
    } catch {
      /* already gone */
    }
  }
  resizing.role.configureResizing?.(false)
  if (resizing.lastW) {
    // 1500ms is a deadline, not a duration: a client that honours the configure
    // is done in a frame or two, and one that refuses -- or clamps to its own
    // limits -- would otherwise hold the camera hostage forever.
    settling = {
      scale0: resizing.scale0,
      w: resizing.lastW,
      h: resizing.lastH,
      role: resizing.role,
      sentAt: performance.now(),
      until: performance.now() + 2500,
    }
  }
  resizing = null
  return true
}

// Drive a resize without a mouse, for the same reason __pointAt exists.
function resizeFlatBy(dxScreen, dyScreen) {
  const s = flatSign()
  if (!s) return null
  const p = handlePoint()
  if (!p) return null
  if (!startResize(s, { clientX: p.x, clientY: p.y })) return null
  stepResize({ clientX: p.x + dxScreen, clientY: p.y + dyScreen })
  const asked = state.resizeTo
  endResize()
  return { from: [s.size.width, s.size.height], asked }
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
  settling = null
  state.released++
  return true
}

// Come out of the map ON THE ROAD BESIDE a particular window.
//
// Not flattened into it: the ask was to "transfer back to the road view looking
// at that window", and the road view is where you can see it standing in its
// place with its neighbours either side. One more click flattens, which is the
// same gesture it has always been.
//
// HOW FAR SHORT OF THE WINDOW TO STOP, computed from the sign rather than
// chosen.
//
// It was a flat 420 and that was a guess, which is the kind of number this file
// is supposed to not contain. At 420 the sign's TOP EDGE lands one pixel above
// the viewport -- a window standing 300 tall with its centre at y=190 subtends
// more than the frustum's half-height at that range -- so you arrived at the
// window you asked for and could not see all of it. Reported.
//
// And a constant could not have been right anyway: a sign is sized to its own
// surface (makeSign), so a tall client is a tall sign and needs more room than a
// square one. So solve it, the same way pixelExactDistance does for the flatten.
//
// Camera is at road level looking straight down the road, so in camera space the
// sign is a box `d` ahead, `cx` to one side, spanning yBot..yTop. Rotated by
// `t`, its half-width splits into an x extent and a z extent -- the NEAR corner
// is closer than d and the FAR corner further, and each binds a different edge
// of the frame:
//
//   vertical   the nearest part subtends the most, so it decides the top edge
//   horizontal the far corner has the largest x, the near corner the smallest z
//
// M keeps the whole thing inside 86% of the frame rather than exactly touching
// the edges, because a sign flush against the border reads as cropped even when
// it is not.
function roadViewDistance(s) {
  const g = s.mesh.geometry.parameters
  const t = Math.abs(s.mesh.rotation.y)
  const xExtent = (g.width / 2) * Math.cos(t)
  const zExtent = (g.width / 2) * Math.sin(t)
  const cx = Math.abs(s.mesh.position.x - ws.laneX(s.district))
  const camY = 105
  const yTop = s.mesh.position.y + g.height / 2
  const yBot = s.mesh.position.y - g.height / 2

  const M = 0.86
  const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * M
  const hTan = vTan * camera.aspect

  const dV = Math.max(Math.abs(yTop - camY), Math.abs(camY - yBot)) / vTan + zExtent
  const dFar = (cx + xExtent) / hTan - zExtent
  const dNear = (cx - xExtent) / hTan + zExtent
  return Math.max(dV, dFar, dNear, 240)
}

// Come out of the map ON THE ROAD BESIDE a particular window.
//
// Not flattened into it: the ask was to "transfer back to the road view looking
// at that window", and the road view is where you can see it standing in its
// place with its neighbours either side. One more click flattens, which is the
// same gesture it has always been.
function goWindow(district, milepost) {
  const w = ws.get(district)
  if (!w || !w.open) return null
  const s = [...signs.values()].find((x) => x.district === district && x.milepost === milepost && x.mesh)
  if (!s) return null
  const view = roadViewDistance(s)
  // camera z is 260 + roadZ, and we want (camera z - window z) === view.
  // Handed to goDistrict as an ARGUMENT -- see `at` there for what writing it
  // into roadMemory instead cost.
  const at = s.mesh.position.z + view - 260
  state.lastMapPick = { district, milepost, view: Math.round(view), at: Math.round(at) }
  return goDistrict(district, { at })
}

// What a panel on a gate does when you click it. The gate hangs the action; this
// is the only place that carries it out, so there is one list of everything a
// road lets you do from outside a window.
function doGantryAction(a) {
  if (a.kind === 'exit') {
    // A lane to a CLOSED workspace is barred, and clicking it does nothing yet.
    // Opening one from the sign is still to come; refusing is not a stub, it is
    // the truthful answer until then -- goDistrict would otherwise fly you to a
    // road that is not laid.
    state.lastGantryClick = { kind: 'exit', to: a.to, open: !!ws.get(a.to)?.open }
    return goDistrict(a.to, { atHead: true })
  }
  if (a.kind === 'open') {
    // The enter gate opens onto THE ROAD IT STANDS ON, which is the road you are
    // driving -- so there is no workspace to pass. rrabbit.js reads
    // `state.district` when the surface finally arrives, exactly as it does for
    // a window opened any other way, and sideQueue carries the side.
    const ok = hooks.spawnWindow ? hooks.spawnWindow(a.side) : false
    state.lastGantryClick = { kind: 'open', side: a.side, ok }
    return ok
  }
  if (a.kind === 'back') return goBack()
  if (a.kind === 'reloop') {
    // Back to the head of THIS road. Not a workspace change, so it is not a
    // journey and does not go on the history -- you have not been anywhere.
    const b = roadBoundsOf(state.district)
    roadZ = b.near
    roadMemory.set(state.district, roadZ)
    state.lastGantryClick = { kind: 'reloop', to: state.district }
    flight = { from: currentPose(), to: districtPose(state.district), t: 0, target: null }
    state.mode = 'flying'
    return true
  }
  if (a.kind === 'newLane') {
    // A new workspace is created CONNECTED, in both directions. A lane you can
    // drive down and not back up is a road network a graph is allowed to have,
    // but it is not what "make me another workspace" means -- you would arrive
    // somewhere with no way home.
    const from = state.district
    const n = ws.list().length + 1
    const made = ws.add({ name: `road ${n}` })
    ws.connect(from, made.id)
    ws.connect(made.id, from)
    state.lastGantryClick = { kind: 'newLane', id: made.id, from }
    // Roads are laid by shell.js, which reconciles them every frame -- so the
    // new one exists by the time the flight lands.
    return goDistrict(made.id, { atHead: true })
  }
  return null
}

function currentPose() {
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(400).add(camera.position)
  return { pos: camera.position.clone(), look }
}

function stepFlight(dt) {
  if (!flight) return holdFlatScale()
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
      // `.mesh` and `.size` are what pixelExactDistance reads, and a sign whose
      // surface has not been built yet has neither.
      flatZoom = arriving?.mesh ? rememberedZoom(arriving) : 0
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
  // The resize grab is a child of the sign, so a RECURSIVE pick finds it -- and
  // it is not part of the surface. Left in, a click on the corner would resolve
  // to no view at all, which reads to overFlatSurface as "outside the window"
  // and would have made grabbing the handle the gesture that leaves.
  const hit = hits.find((h) => h.uv && !h.object.userData.resizeHandle)
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

  swallow('pointermove', (ev) => {
    if (resizing) return stepResize(ev)
    setGrabHot(flatSign(), !!handleUnder(ev))
    sendMotion(ev)
  })
  // A click on the window is the application's. A click on anything else --
  // the road, the sky, the space beside the surface -- is you asking to leave,
  // the same answer Esc gives. Clicking "outside" to dismiss is what every
  // other overlay in computing already taught people, and while flat it was the
  // one gesture that did nothing at all.
  swallow('pointerdown', (ev) => {
    // The grab is checked FIRST, before both of the rules below -- it is neither
    // the application's click nor a click outside asking to leave.
    // WHAT A CLICK IN THE FLAT VIEW DECIDED. Three outcomes, and "it does not
    // work" can be any of them -- the grab missing, the click reaching the
    // application, or the click being read as "outside" and leaving the window
    // entirely. Guessing between them from a description is what this replaces.
    const grab = handleUnder(ev)
    if (grab && startResize(grab, ev)) {
      // TAKE THE GESTURE PROPERLY, or the browser takes it back. An unprevented
      // pointerdown on a canvas can begin a native drag or a selection, and the
      // browser then stops delivering moves and fires pointercancel -- which is
      // wired to endResize, so the drag ended on the first pixel and the whole
      // feature read as doing nothing. Capture also guarantees the moves keep
      // arriving once the pointer leaves the window it started on, which a
      // resize that makes things bigger does immediately.
      ev.preventDefault()
      try {
        canvas.setPointerCapture(ev.pointerId)
        resizing.captured = ev.pointerId
      } catch {
        /* synthetic events have no real pointer to capture; the drag still works */
      }
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: 'grab' }
      return
    }
    if (!overFlatSurface(ev)) {
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: 'leave' }
      release()
      canvas.blur()
      return
    }
    state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: 'app' }
    sendButton(ev, false)
  })
  swallow('pointerup', (ev) => {
    if (endResize()) return
    sendButton(ev, true)
  })
  // A drag that ends off the window, or that the browser takes away, must not
  // leave the client stuck in its resizing state.
  window.addEventListener('pointercancel', endResize, { capture: true })
  window.addEventListener('blur', endResize)
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
      // The map is over the road, and scrolling a map you are reading must
      // scroll the MAP -- which is a normal overflowing element, so the answer
      // is simply not to take the event.
      if (state.mode !== 'driving' || mapIsOpen()) return
      ev.preventDefault()
      // A GATE WITH MORE LANES THAN IT CAN SHOW TAKES THE WHEEL, and only then.
      // Same rule the flatten uses -- the wheel belongs to whatever the pointer
      // is over -- and scrollGateOf refuses when a gate has nothing off-screen,
      // so pointing at an ordinary gate still drives the road past it.
      const over = aim(ev)
      if (over && scrollGateOf(over.object, ev.deltaY)) {
        state.lastGateScroll = ev.deltaY > 0 ? 'down' : 'up'
        return
      }
      const { near, far } = roadBounds()
      // Trackpads emit many small deltas and a wheel a few large ones; scaling
      // by the delta keeps both feeling like the same road.
      // deltaY is NEGATIVE when the wheel rolls away from you, which everything
      // else in the world treats as forward/closer -- so it adds, not subtracts.
      roadZ = Math.min(near, Math.max(far, roadZ + ev.deltaY * 0.6))
      roadMemory.set(state.district, roadZ)
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
  window.__road = () => ({
    roadZ,
    ...roadBounds(),
    cameraZ: camera.position.z,
    parked: Object.fromEntries([...roadMemory].map(([k, v]) => [k, Math.round(v)])),
  })

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
    if (state.mode !== 'driving' || mapIsOpen()) return
    const hit = aim(ev)
    if (!hit) return
    const action = actionOf(hit.object)
    if (action) return doGantryAction(action)
    flattenTo(signs.get(hit.object.userData.signKey).milepost)
  })

  // Hover, so a lane reads as clickable before you click it.
  canvas.addEventListener('pointermove', (ev) => {
    if (state.mode !== 'driving') {
      setHovered(null)
      return
    }
    const hit = aim(ev)
    setHovered(hit && actionOf(hit.object) ? hit.object : null)
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
    if (ev.key === 'Escape' && mapIsOpen()) return void closeMap()
    // A FIELD YOU ARE TYPING IN OWNS ITS KEYSTROKES. The map has a name box and
    // a lane box now, and without this a workspace called "build 2" would fly
    // you to lane 2 while you named it, and a zero would shut the map you were
    // editing in. Escape is deliberately above this line, because leaving is the
    // one thing that should still work from inside a field.
    if (ev.target?.closest?.('#map input, #map select')) return
    if (ev.key === 'o' || ev.key === 'O') return void toggleMap()
    if (!/^[0-9]$/.test(ev.key)) return

    // TYPING 1 THEN 2 MEANS LANE 12, NOT LANE 1 AND THEN LANE 2.
    //
    // One digit per lane worked while there were three of them and stopped the
    // moment the exit gate could make more: lane 12 was simply unreachable from
    // the keyboard, and the two keystrokes that ought to reach it drove you
    // somewhere else on the way. So digits accumulate.
    //
    // ZERO IS STILL THE MAP, but only as the FIRST digit -- the roads are
    // numbered from 1, so a leading zero can never be part of a lane number,
    // while the 0 in "10" always is. That is the whole rule, and it is why the
    // test is on the buffer being empty rather than on a mode.
    if (ev.key === '0' && digits === '') return void toggleMap()

    digits += ev.key
    clearTimeout(digitTimer)

    // COMMIT AS SOON AS THE NUMBER CANNOT GROW. With five workspaces, "3" can
    // only ever mean 3 -- 30-something does not exist -- so it goes immediately
    // and single-digit jumps feel exactly as they always did. Only a prefix that
    // could still become a bigger valid lane waits, and then only for as long as
    // someone might plausibly still be typing it.
    const count = ws.list().length
    if (Number(digits) * 10 > count) commitDigits()
    else digitTimer = setTimeout(commitDigits, DIGIT_GAP)
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
  goDistrict,
  pixelExactDistance,
  poseFor,
  flattenTo,
  release,
  currentPose,
  goWindow,
  goBack,
  stepFlight,
  scenePointFromEvent,
  // shell.js's `__pointAt`/`__pointAtPopup` call this. They were written when
  // everything lived in one file and the split did not carry the reference
  // across, so both probes threw ReferenceError instead of aiming a pointer.
  sendMotion,
  resizeFlatBy,
  handlePoint,
  installInput,
}
