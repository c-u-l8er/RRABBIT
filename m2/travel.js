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
import { state, signs,
  papers, hooks, keyOf, SCENE_ID, exitZOf, GANTRY_VIEW, HEAD_ROOM, roadOrder, dashZ, slotFree } from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'
import { paperMeshes } from './paper.js'
import { apply as applyOp } from './ops.js'
import * as layout from './layout.js'
import { gantryMeshes, actionOf, setHovered, scrollGateOf } from './gantry.js'
import { rampMeshes, dashActionOf, setRampHover } from './ramps.js'
import { toggleMap, closeMap, openMap, openMapAt, openMapAtDash, isOpen as mapIsOpen } from './map.js'
import { closeReel, isOpen as reelIsOpen } from './reel.js'

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

// WHERE YOU LEFT EACH ROAD IS A FACT ABOUT THE TRACK, not about the road.
//
// This was a Map here, keyed by workspace, shared by everything -- and that was
// right for exactly as long as there was one of you. Two tracks parked on
// `home` are two pieces of work that happen to be on the same road, and one of
// them scrolling the other's view is the same complaint per-workspace memory was
// introduced to fix, one level up. It lives on the track now (tracks.js), and
// these two lines are all that is left of it here.
const parkRoad = (id, z) => tracks.parkRoad(id, z)
const parkedAt = (id) => tracks.roadOf(id)

// WHERE YOU HAVE BEEN LIVES IN tracks.js NOW, and there are ten of them.
//
// There was one history, a module-level array right here, and it was the shell's
// single idea of where you had been -- so `back` meant back from whatever you
// last happened to do, whichever piece of work it belonged to. A track is a
// trail of its own, ten run at once, and `back` follows the one you are on.
// travel.js keeps the flying and asks tracks.js where it has been.
let goingBack = false

export const backTarget = () => tracks.backTarget()

function goBack() {
  const id = tracks.back()
  if (!id) return null
  goingBack = true
  const r = goDistrict(id)
  goingBack = false
  state.lastGantryClick = { kind: 'back', to: id }
  return r
}

// The track number being typed. 600ms is the pause after which a lone "1" stops
// being a possible prefix of "10" and becomes track 1 -- long enough that a
// deliberate two-digit number is never split, short enough that a single-digit
// switch does not feel like it hung.
const DIGIT_GAP = 600
let digits = ''
let digitTimer = 0

// A DIGIT IS A TRACK, NOT A LANE.
//
// It used to be a position in the layout: `2` meant "the second road". That made
// the number a name for a PLACE, and there were as many of them as there were
// roads. A track is a name for a piece of WORK -- ten of them, each parked
// somewhere with its own trail -- so two of them can be on the same road and
// pressing back on each goes somewhere different. That is the whole change.
//
// SWITCHING IS NOT A JOURNEY. `goingBack` is reused for exactly the reason it
// exists: arriving because you selected a track is a restore, and recording it
// would put the track's own current road onto its own trail every time you came
// back to it.
function commitDigits() {
  clearTimeout(digitTimer)
  digitTimer = 0
  const n = Number(digits)
  digits = ''
  if (n < 1 || n > tracks.MAX) {
    state.lastTrackKey = { typed: n, track: null, went: null }
    return null
  }
  // A NUMBER PRESSED OVER THE REEL DRIVES AND THE SCREEN GETS OUT OF THE WAY.
  // The reel is a list of places to go; leaving it up over the road you just
  // asked for would make the number look like it had not worked.
  if (reelIsOpen()) closeReel()
  leaveTrack()
  const to = tracks.select(n)
  state.lastTrackKey = { typed: n, track: n, went: to ?? null }
  if (!to) return
  return driveToTrack(to, tracks.flatOf(n))
}

// A TRACK SWITCH LETS GO OF THE WINDOW YOU ARE STANDING IN.
//
// You cannot be flattened against a surface and be driving somewhere else, and
// a track is somewhere else even when it is parked on the same road -- that is
// what makes it a different piece of work. Unlike the map, which draws over the
// window and gives it back when you shut it, this is leaving.
//
// The blur matters as much as the release: Greenfield's key listeners are on the
// canvas, so a client that still has DOM focus keeps receiving keystrokes while
// you drive away from it. The plain-Esc path already pairs `release()` with
// `canvas.blur()` for exactly this reason.
//
// One flight, not two. `release()` aims at the road you are on and then this
// aims at the road you are going to; both read `currentPose()` and no frame runs
// between them, so the second simply replaces the first.
// AND IT PUTS YOU BACK IN THE WINDOW THE TRACK WAS IN.
//
// Letting go is still right on the way OUT -- you cannot be pressed against one
// surface and driving to another. What was wrong was that letting go was the whole
// story: the track you left kept its road and its scroll position and forgot the
// one thing you were actually looking at, so switching away and straight back was
// not a round trip. Reported.
//
// STILL ONE FLIGHT. `release`, `goDistrict` and `flattenTo` all read `currentPose()`
// and no frame runs between them, so each simply replaces the last one's target --
// what plays is a single flight from where you are to the window.
//
// A WINDOW THAT IS NO LONGER THERE IS NOT AN ERROR. Clients die, get closed, and
// never survive a reload; `flattenTo` answers null when there is no sign for the
// address, and the road view it was already flying to is the honest place to be
// left. The stale address is dropped at that point rather than kept to fail again.
function driveToTrack(to, want) {
  if (state.mode === 'flat') {
    release()
    renderer.domElement.blur()
  }
  goingBack = true
  const r = goDistrict(to)
  goingBack = false
  if (want && want.district === to) {
    const landed = flattenTo(want.milepost, want.district)
    if (!landed) tracks.parkFlat(null)
  }
  return r
}

// PARK THE ROAD YOU ARE LEAVING ON THE TRACK YOU ARE LEAVING.
//
// It has to happen BEFORE `select`, and it did not: select flips the active
// track and goDistrict's own "park the road you are leaving" line then wrote the
// outgoing road's position onto the INCOMING track. Measured: switching from
// track 1 (on `home`) to track 4 gave track 4 an entry for `home` it had never
// driven, and track 1 lost the position that was the whole point.
let switchingTrack = false
const leaveTrack = () => {
  if (state.district) tracks.parkRoad(state.district, roadZ)
  // The window, on the same side of `select` and for the same reason: after it,
  // `active()` is the track you are going TO.
  tracks.parkFlat(
    state.mode === 'flat' ? { district: state.flatDistrict, milepost: state.flatMilepost } : null,
  )
  // And tell goDistrict not to park it AGAIN on the way in. Its own "park the
  // road you are leaving" line is right for every other kind of journey and
  // wrong for this one, because by the time it runs the active track is the new
  // one -- so the outgoing road's position landed on the incoming track. That is
  // the same off-by-one ordering fault as above, one call deeper, and it gave a
  // never-used track a scroll position it had never set.
  switchingTrack = true
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLAYING A TRACK. tracks.js decides what a step ASSUMES; this decides how to
// go there, which is the same division the reel already runs on.
//
// It drives one step at a time on a timer rather than in a loop, because the
// flight is animated and a loop would ask the camera for six places at once and
// arrive at the last. The gap is also what makes a replay watchable -- a route
// that completes instantly is indistinguishable from a route that did nothing.
let replaying = null

export const isReplaying = () => !!replaying

// WHAT THE TRANSPORT NEEDS TO DRAW, and nothing it does not. `steps` is dropped
// because a bar that re-read the whole recording every frame would be paying for
// the one thing it never shows; `now` and `next` are the two the operator is
// actually looking at -- what just happened and what is about to.
export function replayState() {
  if (!replaying) return null
  const s = replaying.steps
  return {
    id: replaying.id,
    i: replaying.i,
    total: replaying.total,
    paused: replaying.paused,
    now: replaying.i > 0 ? { ...s[replaying.i - 1] } : null,
    next: s[replaying.i] ? { ...s[replaying.i] } : null,
    ran: replaying.ran.length,
    // Both clocks, because they answer different questions. `at` is where this
    // step sat in the ORIGINAL drive; `elapsed` is how long this replay has been
    // going. A step recorded 4s in can be replayed 40s in, and conflating them
    // would make a paused replay look like a slow one.
    elapsed: Date.now() - replaying.startedAt,
    refusals: replaying.refusals.map((r) => ({ ...r })),
  }
}

// PAUSE IS NOT STOP. A paused replay keeps its place, its evidence and its
// refusal list; a stopped one is over. Two words because they are two states,
// and a transport that only had "stop" would make stepping impossible.
export function pauseReplay() {
  if (!replaying || replaying.paused) return false
  clearTimeout(replaying.timer)
  replaying.timer = 0
  replaying.paused = true
  return true
}

export function resumeReplay() {
  if (!replaying || !replaying.paused) return false
  replaying.paused = false
  replaying.timer = setTimeout(() => replaying && replaying.tick(), 0)
  return true
}

// ONE STEP, AND IT LEAVES YOU PAUSED. Stepping out of a running replay would be
// two controls fighting over the same clock, so this pauses first -- pressing
// step always means "advance exactly one and hold", whatever it was doing.
export function stepReplay() {
  if (!replaying) return false
  pauseReplay()
  replaying.tick({ once: true })
  return true
}

// STEPPING BACKWARD, AND WHY IT IS EVEN POSSIBLE.
//
// You cannot undo a drive -- there is no inverse of "enter this window". What
// makes this work is the granularity rule the ops already follow: every step
// records an ARRIVAL, not a delta. So the state after step k is fully described
// by step k, and going back to k-1 is not an undo at all -- it is re-performing
// step k-1 and landing where it left you.
//
// That property is the whole argument for "record the arrival, not the input"
// stated as a capability rather than a principle: arrival-based ops are
// SEEKABLE and input-based ones are not. Forty wheel deltas cannot be rewound;
// `park(road, z)` can be re-run.
//
// AT THE FIRST STEP IT HOLDS RATHER THAN GUESSING. There is no recorded state
// from before step 1 -- the drive started wherever the operator happened to be
// -- so `i` goes to 0 and nothing drives. Inventing a starting position would be
// the silent repair the forward path already refuses to do.
export function stepBack() {
  if (!replaying || replaying.i <= 0) return false
  pauseReplay()
  replaying.i--
  const s = replaying.steps[replaying.i - 1]
  if (!s) return true // back at the start: hold, drive nothing, claim nothing
  const bad = replaying.perform(s, replaying.i - 1)
  if (bad) {
    // A refusal going BACKWARD does not end the replay. Forward, a refusal means
    // the route cannot continue; backward it only means this position cannot be
    // restored, and the operator is still free to step forward or stop.
    replaying.refusals.push({ ...bad, back: true })
    return false
  }
  return true
}

// Stop, on purpose or because something refused. Kept separate from the refusal
// itself so "the operator stopped it" and "the world had moved" never share a
// reason string.
// A REPLAY IS A ROUND TRIP.
//
// You pressed replay to WATCH a route, not to be moved by it -- so leaving one
// puts you back on the road and in the window you were in when it started.
// Reported as the driver not being returned to the lane/window they were last
// viewing, and it is the right rule for the same reason `back` is: an inspection
// that relocates you has spent your place to show you something.
//
// `driveToTrack` is the existing primitive for exactly this -- it releases a
// window first, sets `goingBack` so the journey home is not recorded onto the
// trail, and re-enters the window if one was wanted. Reused rather than
// re-derived; a second way to arrive somewhere would be a second set of bugs.
function goHome(h) {
  if (!h) return
  const road = ws.get(h.district)?.open ? h.district : null
  if (!road) return // the road you started from is gone; stay put and say nothing false
  const want = h.flat && h.flat.district === road ? h.flat : null
  driveToTrack(road, want)
}

export function stopReplay(why = 'stopped') {
  if (!replaying) return null
  clearTimeout(replaying.timer)
  const ev = { ...replaying, steps: undefined, done: true, why }
  const home = replaying.home
  replaying = null
  state.lastReplay = ev
  // AFTER `replaying` is null, so the drive home cannot be mistaken for a step
  // of the replay it is ending -- `arrive` would otherwise record it and the
  // transport would still be reading a live state while the camera moved.
  goHome(home)
  // EVERY EXIT TAKES THE BAR DOWN, from here, rather than each caller
  // remembering to. The transport was left showing a finished replay because
  // exactly one path -- completion inside `tick` -- did not call
  // `transportStop`, and a control surface that outlives its subject is how
  // "there is no way to exit" happens.
  hooks.replayEnded?.()
  return ev
}

export function replayTrack(id, { gap = 900, onStep = null, paused = false } = {}) {
  if (replaying) return { started: false, code: tracks.REFUSE.BUSY, why: 'a replay is already running' }

  // PHASE ONE -- before anything moves. A recording whose third step names a
  // deleted road must not take the first one.
  const plan = tracks.precheck(id)
  if (!plan.ok) {
    state.lastReplay = { id, started: false, refusals: plan.refusals, plan }
    return { started: false, code: plan.refusals[0]?.code, why: plan.refusals[0]?.why, plan }
  }

  const steps = tracks.replaySteps(id)
  replaying = {
    id, i: 0, total: steps.length, steps, timer: 0, gap,
    // STARTING PAUSED IS A FIRST-CLASS WAY IN, not a special case. "Show me this
    // route one step at a time" and "run it" are the same track and the same
    // machinery; only the clock differs.
    paused: !!paused,
    // EVIDENCE, gathered as it goes rather than reconstructed after. `ran` is
    // what actually executed, which is the only honest answer to "how far did
    // it get" once a refusal can stop it half way.
    ran: [], refusals: [], startedAt: Date.now(), plan,
    // WHERE YOU WERE WHEN YOU PRESSED IT. Taken before the first step moves
    // anything, and the same shape `leaveTrack` already uses to remember a
    // track's window -- so the two agree about what "where you were" means.
    home: {
      district: state.district,
      flat: state.mode === 'flat'
        ? { district: state.flatDistrict, milepost: state.flatMilepost }
        : null,
    },
  }

  // GOING TO WHERE ONE STEP LEFT YOU. Factored out because stepping BACKWARD
  // needs exactly this and nothing else -- see `stepBack`.
  //
  // It returns the refusal rather than stopping, so the caller decides whether a
  // refusal ends the replay (forwards) or merely declines to move (backwards).
  const perform = (s, at) => {
    // PHASE TWO -- re-check immediately before executing. The world can move
    // between the precheck and here, and this is the narrowest the window gets.
    // It does not close it: a road can still go away between this line and the
    // drive below. That residue is real and is not claimed away anywhere.
    const bad = tracks.checkStep(s)
    if (bad) return { ...bad, i: at, step: { ...s } }

    if (s.k === 'go' || s.k === 'land') goDistrict(s.to)
    else if (s.k === 'in') {
      // THE WINDOW HALF, asked at the only moment it can be answered. `goWindow`
      // returning nothing means there is no surface at that milepost any more --
      // a refusal, not a miss, and the replay stops on it like any other.
      if (!goWindow(s.district, s.milepost)) {
        return { code: tracks.REFUSE.WINDOW_GONE, why: `no window at ${s.district}:${s.milepost}`, i: at, step: { ...s } }
      }
    }
    return null
  }
  replaying.perform = perform

  // THE END IS A PLACE TO STAND, NOT AN EXIT.
  //
  // It used to `stopReplay('complete')` on the last step, which threw you out of
  // the transport at the exact moment the route finished -- so you could not
  // step BACK through what you had just watched, and the bar vanished before you
  // could read where it ended. Holding paused at the end keeps `back` live and
  // leaves the leaving to you.
  const holdAtEnd = () => {
    replaying.paused = true
    clearTimeout(replaying.timer)
    replaying.timer = 0
  }

  const tick = ({ once = false } = {}) => {
    if (!replaying) return
    const s = replaying.steps[replaying.i]
    if (!s) return void holdAtEnd()

    const bad = perform(s, replaying.i)
    if (bad) {
      replaying.refusals.push(bad)
      return void stopReplay(bad.code)
    }

    replaying.ran.push({ i: replaying.i, k: s.k, at: Date.now() - replaying.startedAt, was: s.t })
    onStep?.(replaying.i, s, replaying.total)
    replaying.i++
    // FINISHED IS DECIDED HERE, NOT ONE GAP LATER -- the end of the list is
    // knowable the moment you reach it, so waiting a gap to discover it left the
    // bar reading `5 / 5` with a live replay behind it. It now HOLDS rather than
    // stops (see holdAtEnd), so the same line that used to be the exit is the
    // one that parks you at the end with `back` still available.
    if (replaying.i >= replaying.steps.length) return void holdAtEnd()
    // `once` is the step button: advance exactly one and hold. Anything else
    // keeps the clock, unless a pause landed while this step was executing.
    if (!once && !replaying.paused) replaying.timer = setTimeout(tick, replaying.gap)
  }

  // Held on the state so pause/resume/step can drive the same function the timer
  // does. Two entry points into one stepper, rather than a second stepper that
  // has to be kept in agreement with the first.
  replaying.tick = tick

  // The first step goes on the same timer as the rest, so a one-step recording
  // and a ten-step one behave the same way rather than the first being special.
  if (!replaying.paused) replaying.timer = setTimeout(tick, 0)
  return { started: true, total: steps.length, plan, paused: replaying.paused }
}

// Switching tracks from the map, which is the same act as pressing the number.
export function goTrack(n) {
  leaveTrack()
  const to = tracks.select(n)
  if (!to) return null
  state.lastTrackKey = { typed: n, track: n, went: to, from: 'map' }
  return driveToTrack(to, tracks.flatOf(n))
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
  //
  // `near` is HEAD_ROOM and not 0: the wheel stopped dead at the head of the
  // road, which framed the enter gate against a full frame at a moment when the
  // cockpit takes the bottom third of it. See ENTER_VIEW in world.js for the
  // measurement. Never past `far` -- a road short enough for the two to cross
  // would otherwise let you scroll backwards off its own exit.
  const far = exitZOf(id) + GANTRY_VIEW - 260
  return { near: Math.max(far, HEAD_ROOM), far }
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
//   are put back exactly where you left THAT road, on THIS track (tracks.js).
//
//   `at` -- a caller that knows exactly where on the road it wants you, which
//   is the map picking a window. It BEATS the memory, and saying so explicitly
//   is the fix for a real bug: goWindow used to publish its target by writing it
//   into the road memory, and the "park the road you are leaving" line below then
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
//
// AND IT IS THE ONE PLACE THE NETWORK CHANGES. Every way of arriving somewhere
// comes through here -- a gate lane, a ramp, a track, the map, going back -- so
// putting the switch here means none of them needs to know that networks exist.
// A destination in another network selects that network on the way in, and
// everything downstream (the roads laid, the lanes, the layout) reconciles to it
// on the next frame because it always did.
//
// It has to LET GO OF THE WINDOW first. You cannot be flattened against a surface
// standing on a road that is about to stop being laid; the road you were on
// belongs to the network you are leaving.
function goDistrict(id, { atHead = false, at = null } = {}) {
  const w = ws.get(id)
  if (!w || !w.open) return null
  const crossing = !ws.inActive(id)
  if (crossing && state.mode === 'flat') {
    release()
    renderer.domElement.blur()
  }
  // Park the road you are leaving before you leave it -- unless the track
  // switched under us, in which case leaveTrack already did it, onto the track
  // that was actually leaving. Before the switch, because it is a fact about the
  // road you are on and that road is about to stop being one of ours.
  if (state.district && !switchingTrack) parkRoad(state.district, roadZ)
  if (crossing) {
    state.lastNetworkChange = { from: ws.activeTenantId(), to: ws.tenantOf(id), at: id }
    ws.selectTenant(ws.tenantOf(id))
  }
  switchingTrack = false
  // ONTO THE ACTIVE TRACK'S TRAIL, and only if this is a journey. `goingBack` is
  // true both when retracing and when SELECTING a track -- neither is somewhere
  // you went, and recording the second would mean a track pushed its own current
  // road onto its own trail every time you switched back to it.
  tracks.arrive(id, { record: !goingBack })
  state.historyDepth = tracks.active()?.history.length ?? 0
  state.track = tracks.activeIndex()
  const b = roadBoundsOf(id)
  const want = at !== null ? at : atHead ? b.near : (parkedAt(id) ?? b.near)
  roadZ = Math.min(b.near, Math.max(b.far, want))
  state.district = id
  // So that coming back to this network puts you on the road you left rather than
  // on its root. Written on arrival rather than on departure: departure does not
  // know it is one, because leaving a road and leaving a network are the same
  // call and only the destination tells them apart.
  ws.noteLast(id)
  state.network = ws.activeTenantName()
  setRange(FOG_DRIVE, FAR_DRIVE)
  state.flewBy = { why: 'goDistrict', to: id, at: state.frames }
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
  // THE WINDOW IS TALLER THAN ITS PICTURE. The name board and the close control
  // stand above the top edge (rrabbit.js: chromeTop), and the camera looks at
  // the picture's centre -- so the top of the chrome is the furthest thing from
  // the look point and it is what decides whether all of the window is on
  // screen. Leaving it out is what put both of them off the top of the frame.
  const half = g.height / 2 + (s.chromeTop ?? 0)
  return Math.max(half / vTan, g.width / (2 * vTan * camera.aspect))
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

// A window that MOVES TO ANOTHER ROAD takes a fresh milepost there, so its
// address changes -- and this memory is keyed by address. Without this the zoom
// you set on that window is left behind under a key nothing will ever ask for
// again, and the window arrives at the default the next time you fly into it,
// which reads as the shell forgetting.
//
// "Mileposts are never reissued" is what makes moving the entry safe rather than
// merely tidy: the key it vacates cannot be claimed by a later window, so there
// is no way for this to hand one window's zoom to another.
export function rekeyZoom(fromDistrict, fromMilepost, toDistrict, toMilepost) {
  const from = zoomKey(fromDistrict, fromMilepost)
  if (!zoomMemory.has(from)) return false
  zoomMemory.set(zoomKey(toDistrict, toMilepost), zoomMemory.get(from))
  zoomMemory.delete(from)
  return true
}

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
// Wired by installInput. Declared out here because the wheel handler and the key
// handlers are built in the same call but read each other's state, and a shared
// `let` would let either one write what the other owns.
let escIsHeld = () => false
let noteEscUsed = () => {}
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
  // FULL SCREEN KEEPS THIS RUNNING WITH NO JOB. The settle finishes as soon as
  // the surface reaches the size, and the camera then has to STAY at pixel-exact
  // for as long as full screen is on -- the window is rebuilt at every size
  // change and each rebuild lands at the fit distance again.
  if (state.mode === 'flat' && state.full && !job) {
    const s0 = flatSign()
    if (s0?.mesh) applyFlatZoom(s0, 0)
    return
  }
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
  // FULL SCREEN IS ALWAYS PIXEL-EXACT, and that is what makes it full screen.
  //
  // The client has been asked for the viewport's size, so 1:1 and "fills the
  // frame" are the same distance -- there is nothing to fit and nothing to hold.
  // Holding `scale0` instead kept the camera at the distance the window had
  // BEFORE it grew, which is why a 1440x900 surface was still drawn 775px wide
  // with road either side of it.
  const d = state.full ? base : Math.max(base / job.scale0, fitDistance(s))
  applyFlatZoom(s, d - base)
  if (!settling) return

  const arrived = s.size.width === settling.w && s.size.height === settling.h
  if (arrived || performance.now() > settling.until) {
    // One last apply at the size that actually arrived, then let go -- the zoom
    // it lands on is now this window's, remembered like any other.
    if (!arrived) state.resizeGaveUp = { asked: [settling.w, settling.h], got: [s.size.width, s.size.height] }
    // AND THE SHAPE IS REMEMBERED HERE, at the one moment the answer is known.
    //
    // Not in endResize: that is where the drag stops, and what the drag ASKED for
    // is not what the window is -- a client may clamp to its own minimum, or refuse
    // outright, and a remembered size that the surface never reached would put the
    // window back wrong on every future load. `s.size` at this line is the size the
    // surface actually settled at, refusal included, which is the only shape worth
    // keeping. See layout.js for what the address can and cannot promise.
    // NOT FOR A FULL-SCREEN CONFIGURE. `remember` is how a window gets put back
    // the shape you last left it, and it is right for a resize you performed on
    // purpose. Full screen is a MODE, not a shape: remembering it taught the
    // shell that this address is viewport-sized, so every future window opened
    // there came up full-screen-sized with no full screen on -- and it survived
    // a reload, which is what made it look like the resize was not working.
    if (settling.remember !== false) {
      layout.remember(s.district, s.milepost, s.size.width, s.size.height)
    }
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
  state.grabHot = show
}

// `X--` appears the same way `-->` does, and the two are checked together so
// that exactly one cursor is set per pointer move. Two independent "hot"
// functions each writing `style.cursor` means whichever ran second wins, and
// leaving one control's corner would clear the cursor the other had just set.
function setCloseHot(s, hot) {
  if (!s?.closeBtn) return
  const show = !!hot && !!s.closeBtn.userData.armed
  s.closeBtn.visible = show
  state.closeHot = show
}

// `&--` JOINS THE HOVER-ONLY FAMILY, which is a change of mind worth recording.
//
// It was drawn whenever you were in the window, on the argument `X--` makes: a
// control you can only see once you are pointing at it is one you have to be
// told about. That argument holds for the way OUT of a window, which every
// window needs and which has to be findable by someone who has never seen this
// shell. It does not hold here -- broadcasting is a thing you go looking for,
// the way a resize is, and a permanent cyan mark on the corner of every window
// you stand in is furniture the other three corners had already argued against.
//
// Asked for, and it puts the pair on the left edge back in step with `-->`.
function setCastHot(s, hot) {
  if (!s?.castBtn) return
  const show = !!hot && !!s.castBtn.userData.armed
  s.castBtn.visible = show
  state.castHot = show
}

function setStepHot(s, which, hot) {
  const btn = s?.[which === -1 ? 'prevBtn' : 'nextBtn']
  if (!btn) return false
  const show = !!hot && !!btn.userData.armed
  btn.visible = show
  return show
}

function setChromeCursor() {
  renderer.domElement.style.cursor = state.grabHot
    ? 'nesw-resize'
    : state.closeHot || state.castHot || state.titleHot || state.stepHot
      ? 'pointer'
      : ''
}

// STEP TO THE WINDOW BEFORE OR AFTER THIS ONE, in road order.
//
// Road order interleaves the two sides (world.js), so the next window along is
// frequently on the OTHER side of the road -- and flattenTo flies you there,
// across the tarmac, which is the "jump the camera across the lane when it needs
// to" this was asked for. There is nothing special to do for that case; it falls
// out of stepping through the order the road is actually in.
function stepWindow(s, delta) {
  const road = roadOrder(s.district)
  const i = road.indexOf(s)
  const to = road[i + delta]
  if (i < 0 || !to) return null
  state.lastStep = { from: s.milepost, to: to.milepost, delta }
  return flattenTo(to.milepost, to.district)
}

// Is the pointer over one of the flat window's own controls? `which` names the
// pad, so there is one raycast routine for all three rather than one per control
// -- the next one added is a name, not another copy of this.
//
// It tests ARMED and not `visible` for the reason syncHandles states: the grab
// is drawn only when reached for, so a control that could only be hit while it
// was already being pointed at is a control nobody can ever find.
function chromeUnder(ev, which) {
  const s = flatSign()
  const pad = s?.[which]
  if (!pad?.userData?.armed) return null
  const rect = renderer.domElement.getBoundingClientRect()
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  )
  return raycaster.intersectObject(pad, false).length ? s : null
}

const handleUnder = (ev) => chromeUnder(ev, 'grabPad')

// THE CLOSE ASKS FIRST, and the answers are their own targets.
//
// `X--` used to close on the press. It is a small quad at a corner you also reach
// for to grab and to read the board, it is the only control on a window that cannot
// be undone -- the client exits and takes whatever was in it -- and it sat one
// misjudged pixel away from two controls that can. Asked for, and the shape is the
// one the rest of computing uses: press once to ask, and the second press is yes.
//
// `X--` CANNOT BE THE YES, and that is the whole guard.
//
// A second press on it used to close, on the argument that pressing one control
// twice is what a two-stage button means everywhere else. Asked to remove it, and
// the ask is right: that shape stops a stray click and nothing more. A double-click
// is a SINGLE gesture -- one decision, two presses -- and it went through the guard
// as if it were two. So the only yes is `close--X`, on the other side of the board:
// the pointer has to be moved somewhere to give it, and the movement is the second
// decision. Pressing `X--` again takes the question back, because the control that
// asked is the natural place to unask, and because an impatient double-click then
// lands on cancel rather than on anything irreversible.
//
// ANYTHING ELSE IS A NO. Not a list of controls that cancel: every other press
// does, including one into the application itself, because a question left standing
// over a window you have gone back to working in is a question whose yes is one
// stray click away. That is why this runs before every other branch -- each of them
// either returns or begins a gesture, so a cancel written after them is one a
// resize, a step or a click into the client would skip.
//
// Returns whether the press was spent here.
function closeClick(ev) {
  const shut = chromeUnder(ev, 'closePad')
  const answer = shut ? null : chromeUnder(ev, 'keepPad') ? 'keep' : chromeUnder(ev, 'shutPad') ? 'close' : null
  if (!shut && !answer) {
    if (state.closeAsking) state.closeAsking = null
    return false
  }
  ev.preventDefault()
  const s = shut ?? flatSign()
  const at = s ? `${s.district}:${s.milepost}` : null
  const seen = [Math.round(ev.clientX), Math.round(ev.clientY)]
  // Nothing below this line can close a window unless the press landed on
  // `close--X` AND that window is the one already being asked about.
  if (answer === 'close' && at && state.closeAsking === at) {
    state.closeAsking = null
    const asked = hooks.closeWindow?.(s.district, s.milepost) ?? null
    state.lastFlatClick = { at: seen, went: 'close', asked: !!asked }
    return true
  }
  if (shut && at && state.closeAsking !== at) {
    state.closeAsking = at
    state.lastFlatClick = { at: seen, went: 'close?', asked: false }
    return true
  }
  state.closeAsking = null
  state.lastFlatClick = { at: seen, went: 'keep' }
  return true
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

// ---------------------------------------------------------- FULL SCREEN
//
// The window, and nothing else the shell owns. Every control is unarmed and
// undrawn (syncHandles), the DOM strips are hidden, the cockpit stays away, and
// the CLIENT IS ASKED TO FILL THE VIEWPORT -- because the flatten is pixel-exact,
// so viewport pixels and surface pixels are the same pixels and "fill the screen"
// is a real configure rather than a scale on the quad. A scale would resample the
// application instead of giving it more room, which is the same argument the
// resize grab makes in its own note.
//
// Asked through `settling`, the mechanism the resize already uses: configureSize
// is fire-and-forget, so it is re-asked at a rate a client can absorb until the
// surface is observed to BE the size, or the deadline says the client is refusing
// rather than lagging. Some clients refuse -- simple-shm is fixed at 250x250 and
// will never fill anything. That is a fact about the client, so the shell reports
// it (`__full()`) rather than pretending.
export function enterFull() {
  if (state.mode !== 'flat' || state.full) return null
  const s = flatSign()
  const role = s?.view?.surface?.role
  state.full = true
  // Remembered so leaving puts the window back the size you found it. Recorded
  // even when the client cannot be asked, so the exit path has nothing to branch
  // on -- an absent memory and a memory of the same size are different things.
  state.fullFrom = s?.size ? { w: s.size.width, h: s.size.height } : null
  // `?fullresize=0` enters full screen WITHOUT asking the client to grow. Kept
  // as a switch rather than deleted because "the shell drops you out of the
  // window when you go full screen" has two candidate causes -- the configure
  // and everything else -- and they are indistinguishable from the outside.
  const askAllowed = new URLSearchParams(location.search).get('fullresize') !== '0'
  if (askAllowed && typeof role?.configureSize === 'function') {
    const w = Math.max(64, Math.round(window.innerWidth || 1280))
    const h = Math.max(64, Math.round(window.innerHeight || 720))
    settling = { scale0: 1, w, h, role, sentAt: 0, until: performance.now() + 2500, remember: false }
  }
  return { asked: !!settling, from: state.fullFrom }
}

export function exitFull() {
  if (!state.full) return null
  state.full = false
  const s = flatSign()
  const role = s?.view?.surface?.role
  const back = state.fullFrom
  state.fullFrom = null
  if (back && typeof role?.configureSize === 'function') {
    settling = { scale0: 1, w: back.w, h: back.h, role, sentAt: 0, until: performance.now() + 2500, remember: false }
  }
  return { restored: back }
}

// LEAVING THE WINDOW LEAVES FULL SCREEN, and it has to be here rather than in
// `release()`'s callers: there are four ways out of a window (the chord, a click
// outside, a step to the neighbour, the window closing under you) and a flag left
// standing after any of them would hide the chrome of the NEXT window you enter.
export function clearFull() {
  if (state.full) exitFull()
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
  // WHO LET GO, recorded. There are six call sites and a per-frame reconciler
  // that can reach this, and from outside they are one symptom: the camera is
  // suddenly back on the road. Guessing between them from a description is what
  // this replaces -- the same argument `__aim` and `lastFlatClick` already make.
  state.releasedBy = { at: state.frames, stack: new Error().stack?.split('\n').slice(1, 5).join(' | ') }
  // FULL SCREEN DOES NOT SURVIVE LEAVING. Every route out of a window ends here,
  // which is why the clear is here and not at each of the four call sites -- a
  // flag left standing would hide the chrome of the NEXT window you stand in,
  // and the only control that could undo it is one that only appears while full.
  clearFull()
  if (state.mode === 'driving') return false
  // Back to the district you were in, not to district 0 -- releasing must
  // not silently move you between workspaces.
  state.flewBy = { why: 'release', at: state.frames }
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
  // into the road memory instead cost.
  const at = s.mesh.position.z + view - 260
  state.lastMapPick = { district, milepost, view: Math.round(view), at: Math.round(at) }
  return goDistrict(district, { at })
}

// DRIVE TO A DASH. What "go to that dash" on the ramp page has to actually do.
//
// It said "go to that dash" and only re-pointed the panel at a different slot,
// which is a label writing a cheque the button did not cash. Reported. Naming a
// dash and standing in front of one are two different acts, so they are two
// controls now, and this is the one that drives.
//
// DASH_VIEW is not GANTRY_VIEW. A gate is a flat sign and you want to be far
// enough back to read it; a dash is a mark on the ground with up to 560 units of
// ramp sweeping off it, so the shot has to hold the marker AND where it leads. 700
// puts the dash comfortably into the lower half of the frame with the ramp's board
// still in shot.
//
// The road may not reach: goDistrict clamps to the road's own bounds, so a dash
// past the exit gate leaves you at the end of the road looking down at it. That is
// the honest answer rather than a refusal, and building a ramp there moves the gate
// out to meet it (world.js lastRampZ) -- so the way to reach a dash you cannot
// reach is to give it a reason to exist.
const DASH_VIEW = 700

export function goDash(district, at) {
  const w = ws.get(district)
  if (!w || !w.open || !Number.isInteger(at)) return null
  if (state.mode === 'flat') {
    release()
    renderer.domElement.blur()
  }
  const at_ = dashZ(at) + DASH_VIEW - 260
  const r = goDistrict(district, { at: at_ })
  const b = roadBoundsOf(district)
  state.lastDashDrive = {
    district,
    dash: at,
    dashZ: Math.round(dashZ(at)),
    roadZ: Math.round(Math.min(b.near, Math.max(b.far, at_))),
    clampedShort: at_ < b.far,
  }
  return r
}

// WALKING THE NETWORK FROM THE MAP.
//
// The map lights up the workspaces reachable from the one you have selected, and
// clicking a lit one comes here. It is deliberately the SAME journey a gate lane
// is -- `atHead`, recorded on the track's trail -- because it is the same journey:
// you took an exit. The only difference is that you took it by pointing at the
// destination on a map instead of at a panel on a sign, and a shell in which those
// two produce different results is a shell with two ideas of what an exit is.
//
// It does not close the map. Arriving re-selects the node you arrived on, whose
// own exits then light, so hops chain: click, click, click, and the trail behind
// you is real history you can press back through. Closing on the first click would
// make the second one a second gesture.
export function goExit(to) {
  if (state.mode === 'flat') {
    release()
    renderer.domElement.blur()
  }
  const r = goDistrict(to, { atHead: true })
  state.lastMapWalk = { to, arrived: r, from: 'map' }
  return r
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
    const ok = hooks.spawnWindow ? hooks.spawnWindow(a.side, a.dash ?? null) : false
    state.lastGantryClick = { kind: 'open', side: a.side, dash: a.dash ?? null, ok }
    return ok
  }
  if (a.kind === 'map') {
    // The name board on either gate. Pressing it is pressing 0, and it opens on
    // the road you are standing on -- which is the road the board names.
    openMap()
    state.lastGantryClick = { kind: 'map', to: state.district }
    return true
  }
  if (a.kind === 'ramp') {
    // TAKING A RAMP IS TAKING AN EXIT, and it lands you at the head of the road
    // it leads to for exactly the reason a gate lane does: a junction is not a
    // place you were before, so there is no position on the far road to restore.
    // goDistrict switches the network if the destination is in another one.
    const to = ws.get(a.to)
    state.lastGantryClick = {
      kind: 'ramp',
      district: a.district,
      at: a.at,
      to: a.to,
      open: !!to?.open,
      crossesNetwork: ws.tenantOf(a.to) !== ws.tenantOf(a.district),
    }
    // A ramp to a CLOSED workspace is barred rather than followed, the same
    // refusal a barred gate lane gives: its road is not laid, so arriving would
    // put you in the air. The board says `closed` so this is not a silent no.
    return goDistrict(a.to, { atHead: true })
  }
  if (a.kind === 'dash') {
    // A BARE MARKER OPENS THE PLANNER. Building a ramp means naming a network and
    // a workspace in it, and that is a list -- out here you drive, in there you
    // plan, which is the division the name board already keeps. The dash is
    // carried through so the page that opens is about THAT slot.
    state.lastGantryClick = { kind: 'dash', district: a.district, at: a.at }
    openMapAtDash(a.district, a.at)
    return true
  }
  if (a.kind === 'back') return goBack()
  if (a.kind === 'reloop') {
    // Back to the head of THIS road. Not a workspace change, so it is not a
    // journey and does not go on the history -- you have not been anywhere.
    const b = roadBoundsOf(state.district)
    roadZ = b.near
    parkRoad(state.district, roadZ)
    state.lastGantryClick = { kind: 'reloop', to: state.district }
    state.flewBy = { why: 'reloop', at: state.frames }
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
  // WHERE ON THE ROAD WE ARE, published once a frame. The camera is Travel's and
  // nothing else may move it, but the gate board has to be able to say which window
  // you are at -- so the number goes out through `state`, the way every other fact
  // both personalities need already does. Here rather than at each of the six places
  // that write `roadZ`, because a value published in six places is a value that will
  // eventually be published in five.
  state.roadZ = roadZ
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
  // Only the windows of the network that is laid -- see liveSigns in installInput
  // for why `visible` has to be tested here rather than trusted.
  // RECURSIVE: popup quads are children of their sign, and a menu is the thing
  // you most need to be able to click. A non-recursive pick made every popup
  // decorative.
  const meshes = [...signs.values()].filter((s) => s.mesh && s.mesh.visible).map((s) => s.mesh)
  const hits = raycaster.intersectObjects(meshes, true)
  // The resize grab is a child of the sign, so a RECURSIVE pick finds it -- and
  // it is not part of the surface. Left in, a click on the corner would resolve
  // to no view at all, which reads to overFlatSurface as "outside the window"
  // and would have made grabbing the handle the gesture that leaves.
  const hit = hits.find((h) => h.uv && !h.object.userData.chrome)
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

// THE SHELL IS THE ONLY THING ALLOWED TO PUT AN EVENT IN THE QUEUE.
//
// Greenfield binds its own pointermove/pointerdown/pointerup/wheel/keydown/keyup
// to the scene canvas (browser/input.js) and maps clientX/clientY STRAIGHT to
// scene coordinates -- correct for a flat desktop, meaningless for a quad in
// perspective. The header of shell.js says those listeners are silenced with a
// capture-phase stopPropagation on window; `swallow` below does that, but only
// `if (state.mode === 'flat')`. So OUT ON THE ROAD THEY ALL STILL RAN:
//
//   * every pointer move sent motion to whichever client happened to lie under
//     that flat-desktop coordinate;
//   * every click sent it a button press -- and took a `setPointerCapture`;
//   * EVERY KEYSTROKE went to the focused client, preventDefault and all.
//
// Reported as "in driver mode a click on the app screen is not supposed to
// passthrough to the app, it is only supposed to enter the detail window view",
// which is exactly right and is the rule this restores.
//
// The gate is at the QUEUE rather than at the listener, because widening
// `swallow` to every mode cannot work: a capture-phase stopPropagation on
// `window` also stops the SHELL's own driving-mode listeners, which are bound to
// the canvas (the flatten click, the road hover, the ramps). One owner, checked
// where the two paths finally meet.
//
// Greenfield's `focus`/`blur`/`pointerleave` handlers are untouched on purpose:
// they carry keyboard focus in and out and queue nothing.
//
// AND `queueKey` IS DELIBERATELY NOT GATED. The keyboard is the one input the
// shell does NOT remap: Greenfield's keydown/keyup are bound to the canvas and
// its focus/blur handlers are what tell the client it has the keyboard, so DOM
// focus IS the routing (`hooks.shellKeyboard`, and the note above it). Gating
// the key queue would not fix a route, it would silently stop every keystroke
// reaching every application -- there is no shell-side sender to let through.
// Only the POINTER is remapped, so only the pointer is gated.
let shellIsSending = 0
export const inputGate = { dropped: 0, passed: 0, byKind: {}, lastDropAt: null }

function fromShell(fn) {
  shellIsSending++
  try {
    return fn()
  } finally {
    shellIsSending--
  }
}

function gateInputQueue() {
  const q = session?.inputQueue
  if (!q || q.__gated) return
  q.__gated = true
  for (const name of ['queueMotion', 'queueButton', 'queueAxis']) {
    const real = q[name]?.bind(q)
    if (!real) continue
    q[name] = (...args) => {
      if (!shellIsSending) {
        inputGate.dropped++
        inputGate.byKind[name] = (inputGate.byKind[name] ?? 0) + 1
        inputGate.lastDropAt = state.mode
        return
      }
      inputGate.passed++
      return real(...args)
    }
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
  fromShell(() =>
    session.inputQueue.queueMotion({
      x: p.x,
      y: p.y,
      timestamp: ev.timeStamp,
      buttonCode: 0,
      released: false,
      buttons: ev.buttons ?? 0,
      sceneId: SCENE_ID,
    }),
  )
  state.pointerSent++
}

function sendButton(ev, released) {
  const p = scenePointFromEvent(ev)
  if (!p) return
  fromShell(() =>
    session.inputQueue.queueButton({
      x: p.x,
      y: p.y,
      timestamp: ev.timeStamp,
      buttonCode: ev.button ?? 0,
      released,
      buttons: ev.buttons ?? 0,
      sceneId: SCENE_ID,
    }),
  )
  state.buttonSent++
}

// WHERE A PROGRAM DRAGGED OFF THE ST&RT MENU WOULD LAND, answered by the SAME
// raycast the pointer already uses.
//
// Set by installInput because that is where `aim` and `actionAt` live, and they
// stay there: a probe with its own copy of the mesh list could aim somewhere the
// real handler does not, which is the ambiguity `__aim` was written to remove and
// it applies twice over here -- a drop that highlights one marker and opens the
// window at another is worse than a drop that refuses.
let dropProbe = null

// null means THERE IS NOWHERE TO PUT IT from where the pointer is: the map is
// open, or you are standing in a window, or the ray missed the world entirely.
// The shell shows that as a refusal rather than opening the window somewhere the
// pointer was not.
export function dropAt(clientX, clientY) {
  return dropProbe ? dropProbe(clientX, clientY) : null
}

function installInput() {
  const canvas = renderer.domElement

  // Installed FIRST, before any listener below can fire: a click that arrives
  // between the canvas being live and the gate being on is a click that reaches
  // an application from the road, which is the thing this exists to stop.
  gateInputQueue()

  // WHO HAS THE KEYBOARD, published for map.js to call.
  //
  // Greenfield binds keydown/keyup to this canvas (browser/input.js), and its
  // `focus`/`blur` handlers are what tell the client it gained or lost the
  // keyboard -- so DOM focus IS the answer to the question, and moving it is the
  // whole implementation. The map calls this when it opens over a flattened
  // window and again when it shuts.
  hooks.shellKeyboard = (mine) => {
    if (mine) canvas.blur()
    else canvas.focus()
  }

  // CAPTURE phase on window, so this runs before Greenfield's own target-phase
  // listeners on the canvas. stopPropagation then keeps them from seeing a
  // pointer position that means nothing in a perspective scene.
  //
  // `passive` is explicit for the wheel. A wheel listener on `window` is PASSIVE
  // BY DEFAULT in Chrome, so `ev.preventDefault()` inside it is silently ignored
  // -- the shell would refuse the scroll and the page would scroll anyway.
  //
  // AND IT STANDS ASIDE WHILE THE MAP IS OPEN. The map can be open while you are
  // STANDING IN a window now -- that is what pressing 0 in there does -- and it
  // is a DOM overlay above this canvas. Swallowing every pointer event in the
  // capture phase would stop all of them reaching it, so the map would draw
  // perfectly and not respond to a single click. The earlier build dodged that
  // by leaving the window first; being asked to stay is what makes the rule
  // explicit: flat mode owns the pointer only while nothing of ours is over it.
  const swallow = (type, handler, opts) =>
    window.addEventListener(
      type,
      (ev) => {
        // A CONTROL OF OURS OVER THE WINDOW KEEPS ITS OWN PRESSES.
        //
        // This swallowed every pointer event in flat mode and exempted exactly
        // one thing: the map. That was complete when the map was the only
        // surface the shell put over a window -- and it stopped being complete
        // the moment the reel and the transport existed.
        //
        // The transport is the one that bit: a replay whose step ENTERS a window
        // puts the shell in flat mode, and from that instant every button on the
        // bar was dead while still looking pressable. That is the "exit does not
        // work" report, and it is worse than a dead button because the bar is
        // the only way out of the mode it is reporting on.
        if (ev.target?.closest?.('#transport, #reel, #map')) return
        if (state.mode === 'flat' && !mapIsOpen()) {
          ev.stopPropagation()
          handler?.(ev)
        }
      },
      { capture: true, ...opts },
    )

  swallow('pointermove', (ev) => {
    if (resizing) return stepResize(ev)
    const on = flatSign()
    setGrabHot(on, !!handleUnder(ev))
    setCloseHot(on, !!chromeUnder(ev, 'closePad'))
    setCastHot(on, !!chromeUnder(ev, 'castPad'))
    state.titleHot = !!chromeUnder(ev, 'platePad')
    const prevHot = setStepHot(on, -1, !!chromeUnder(ev, 'prevPad'))
    const nextHot = setStepHot(on, 1, !!chromeUnder(ev, 'nextPad'))
    state.stepHot = prevHot || nextHot
    setChromeCursor()
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
    // THE CLOSE QUESTION IS SETTLED BEFORE ANYTHING ELSE IS CONSIDERED, because
    // every other branch below either returns or begins a gesture -- so a "no"
    // written after them is a no that a resize, a step or a click into the
    // application would skip, leaving the prompt standing over a window you had
    // gone back to using.
    if (closeClick(ev)) return

    // THE COCKPIT GETS ASKED HERE TOO, and it has to be asked in the FLAT
    // handler as well as the driving one -- they are two different listeners and
    // wiring only the first left the pull tab dead in the one mode it exists in.
    //
    // Before the window's own controls and before the click-outside-to-leave
    // rule: while the dashboard is pulled up over a flattened window it is in
    // front of the surface, so a press that lands on an instrument belongs to
    // the instrument. Without this, pulling the dash up put a panel over the
    // window whose every control fell through to "you clicked outside, leaving".
    if (hooks.dashHit) {
      const onDash = hooks.dashHit(ev.clientX, ev.clientY)
      if (onDash) {
        ev.preventDefault()
        // RECORDED, like every other branch of this handler. "The cockpit took
        // it" and "nothing took it and the window was left" are the two answers
        // that look identical from outside, and one of them is a bug.
        state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)],
                                went: 'dash', dash: onDash }
        return
      }
    }

    // THE SHIP ON THE POST puts this window on the whole screen. Checked with the
    // other window controls and before the client, because it is one of them.
    const full = chromeUnder(ev, 'fullPad')
    if (full) {
      ev.preventDefault()
      const went = enterFull()
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)],
                              went: 'full', full: went }
      return
    }

    // `--&` PUTS THIS WINDOW ON THE DASHBOARD'S TV, and it is checked after the
    // close question and before everything else. After, because a standing
    // "close this?" has to be answerable or cancellable by any press and a
    // broadcast slipping in front of that would leave the prompt up. Before the
    // grab and the client, because it is the shell's own control on the shell's
    // own corner -- the same place in the order `X--` occupies.
    const cast = chromeUnder(ev, 'castPad')
    if (cast) {
      ev.preventDefault()
      const went = hooks.castWindow?.(cast.district, cast.milepost) ?? null
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)],
                              went: 'cast', cast: went }
      return
    }

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
    // The other controls on the frame, checked in the same place and for the same
    // reason: they are the shell's, not the application's, and none of them is a
    // click outside asking to leave.
    for (const [pad, delta] of [
      ['prevPad', -1],
      ['nextPad', 1],
    ]) {
      const on = chromeUnder(ev, pad)
      if (!on) continue
      ev.preventDefault()
      const went = stepWindow(on, delta)
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: delta < 0 ? 'prev' : 'next', to: went }
      return
    }
    const board = chromeUnder(ev, 'platePad')
    if (board) {
      ev.preventDefault()
      // WITHOUT LEAVING. The board is a menu bar on the window, and clicking one
      // does not shut the thing it is attached to. `swallow` standing aside
      // while the map is open is what makes the overlay clickable from in here.
      openMapAt(board.district, board.milepost)
      state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: 'title' }
      return
    }
    if (!overFlatSurface(ev)) {
      // NOT WHILE FULL SCREEN IS ON. Clicking beside the window is how you leave
      // it, and while full there is no "beside" that means anything -- the app has
      // the whole frame, so a press that lands off the surface is a press that
      // missed, not a decision to go. The ONLY way out is the ship, which is the
      // whole point of there being no bar: an exit you cannot hit by accident.
      if (state.full) {
        state.lastFlatClick = { at: [Math.round(ev.clientX), Math.round(ev.clientY)], went: 'held' }
        return
      }
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
        // Esc held joins ctrl and cmd as "the shell, wherever the pointer is".
        const forced = ev.ctrlKey || ev.metaKey || escIsHeld()
        wheelOwner = forced ? 'shell' : overFlatSurface(ev) ? 'app' : 'shell'
        state.wheelGestures++
      }
      lastWheelAt = now
      // Marked whether or not this gesture ended up as a zoom: what it records is
      // that the key was USED, and a wheel while Esc is down is a use even if the
      // gesture was already latched to the application.
      if (escIsHeld()) noteEscUsed()
      // NO ZOOM WHILE FULL SCREEN IS ON. The window is exactly the viewport and
      // exactly 1:1; a wheel that changed the scale would break both of those at
      // once and leave a "full screen" that is neither full nor exact. The app
      // still gets the wheel -- it is the one that should have it here.
      if (state.full) {
        wheelOwner = 'app'
      }
      if (wheelOwner === 'app') {
        fromShell(() => session.inputQueue.queueAxis(createAxisEventFromWheelEvent(ev, SCENE_ID)))
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
      parkRoad(state.district, roadZ)
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
    // BY ID, NOT BY POSITION. `tracks[activeIndex() - 1]` was the same thing
    // while there were ten tracks in ten slots; with a sparse set the third
    // entry is not track 3 and this reported another track's roads.
    parked: tracks.report().tracks.find((t) => t.id === tracks.activeIndex())?.roads ?? {},
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
  // A WINDOW ON ANOTHER NETWORK'S ROAD IS HIDDEN AND STILL RAYCASTABLE. three
  // tests neither `visible` nor the material's when you hand it a mesh directly,
  // which is the same trap the gantry's scrolled-off panels hit -- and here it
  // would mean clicking through the road you are on into a window belonging to a
  // network that is not laid. `.visible` is set by syncPlacement, so this filter
  // and that assignment are the two halves of one rule.
  const liveSigns = () => [...signs.values()].filter((s) => s.mesh && s.mesh.visible).map((s) => s.mesh)

  const aim = (ev) => {
    const rect = canvas.getBoundingClientRect()
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    )
    // The road markings join the same single raycast, so a dash under a gantry
    // upright loses to the upright and a ramp board in front of a window takes the
    // click -- whatever is nearest wins, which is what everything else in a world
    // does.
    const meshes = [...gantryMeshes(), ...rampMeshes(), ...liveSigns(), ...paperMeshes()]
    return raycaster.intersectObjects(meshes, false)[0] ?? null
  }

  // A hit is one of four things now, in the order they are asked: a dash or a ramp
  // (which are instances and a mesh respectively, so the dash pads need the
  // instanceId and nothing else does), a gate panel, or a window.
  const actionAt = (hit) => (hit ? (dashActionOf(hit) ?? actionOf(hit.object)) : null)

  // THE DROP TARGET, in the three forms the road actually offers -- and no more.
  //
  // A gate lane is a side, a centre-line marker is a place on that road, and
  // anywhere else on the road is "wherever there is room", which is what
  // `spawnWindow(null, null)` has always meant and is the answer that makes the
  // gesture land instead of bouncing. Dropping ON a window is deliberately NOT a
  // target: a Wayland client brings its own surface, so "into that window" is not
  // a thing this shell can honour, and a drop that silently opened a second
  // window beside the one you aimed at would be a lie about what happened.
  dropProbe = (clientX, clientY) => {
    if (state.mode !== 'driving' || mapIsOpen()) return null
    const hit = aim({ clientX, clientY })
    const action = actionAt(hit)
    if (action?.kind === 'open') {
      return { where: 'gate', side: action.side, dash: action.dash ?? null,
               label: action.side < 0 ? 'at the gate, on the left' : 'at the gate, on the right' }
    }
    if (action?.kind === 'dash') {
      // THE MARKER IS ASKED WHETHER IT COULD ACTUALLY TAKE ONE, and per side.
      //
      // Not every dash can: the first several are the run of clear road past the
      // enter gate (SLOT_FIRST), and one already carrying a window or standing in
      // a ramp's sweep is spoken for. Without this the ghost said "at marker 7",
      // the queue asked for 7, `slotFree` said no at adoption and rrabbit.js put
      // the window at 16 -- a promise made by the thing you were looking at and
      // broken by the thing that carried it out. Measured, on the first drop onto
      // the centre line that was tried.
      const at = action.at
      const d = action.district
      const left = slotFree(d, -1, at, 'window')
      const right = slotFree(d, 1, at, 'window')
      if (!left && !right) {
        return { where: 'dash', dash: at, district: d, blocked: true,
                 label: `marker ${at} cannot take a window` }
      }
      // One side free is a side we can NAME and pass; both free leaves it to the
      // same parity rule every other window is placed by, and either way what the
      // ghost says is what the queue is handed.
      const side = left && right ? null : (left ? -1 : 1)
      return { where: 'dash', side, dash: at, district: d,
               label: side === null ? `on this road, at marker ${at}`
                    : `at marker ${at}, on the ${side < 0 ? 'left' : 'right'}` }
    }
    if (hit?.object?.userData?.signKey) {
      // A WINDOW IS NOT A CONTAINER. Named rather than treated as bare road, so
      // the ghost can say why this particular pixel is not a place.
      return { where: 'window', side: null, dash: null, blocked: true,
               label: 'a window is not a place to put one' }
    }
    return { where: 'road', side: null, dash: null,
             label: 'on this road, wherever there is room' }
  }

  // WHAT IS UNDER A GIVEN PIXEL, answered by the same `aim` the pointer uses. A
  // probe that raycast its own copy of the mesh list could aim somewhere the real
  // handler does not, and "nothing lit" would then mean "the ray missed" and
  // "the highlight is fixed" indistinguishably -- which is the exact ambiguity
  // this was written to remove.
  window.__aim = (clientX, clientY) => {
    const hit = aim({ clientX, clientY })
    if (!hit) return null
    return {
      action: actionAt(hit),
      isSign: !!hit.object.userData.signKey,
      // A ramp's tarmac and its board give the same action, and telling them apart
      // is the whole question when the claim is "the sign lights, the road does
      // not". The board is the one carrying a texture.
      textured: !!hit.object.material?.map,
      distance: Math.round(hit.distance),
    }
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'driving' || mapIsOpen()) return
    // THE COCKPIT GETS ASKED FIRST, and it is asked rather than listening.
    //
    // The dash canvas is `pointer-events: none` and stays that way -- a second
    // element over the whole viewport competing for these events is the shape of
    // the bug that once ate every click in the graph box. So the dashboard does
    // not receive the pointer; it ANSWERS a question this handler puts to it,
    // which keeps one input path with one owner. Before the raycast, because an
    // instrument painted OVER the road must take the click that lands on it --
    // otherwise the shifter is furniture with a window behind it.
    if (hooks.dashHit) {
      const on = hooks.dashHit(ev.clientX, ev.clientY)
      if (on) return
    }
    const hit = aim(ev)
    if (!hit) return
    const action = actionAt(hit)
    if (action) return doGantryAction(action)

    // A PANE IS ENTERED THROUGH THE SEAM, exactly as a program enters one. This
    // is the click OP_VOCABULARY_DRAFT.md §9 is about: the pointer emits the same
    // `read` op `window.__op` does, and the log cannot tell them apart except by
    // the `by` field it records and never consults.
    const paperKey = hit.object.userData.paperKey
    if (paperKey) {
      const p = papers.get(paperKey)
      if (!p) return
      const at = { district: p.district, side: p.side, dash: p.dash }
      const u = hit.object.userData
      // WHICH CONTROL, or the document itself. Every branch emits an op; none of
      // them touches a pane directly, so a click and a program and a replay are
      // still one code path.
      if (u.paperClose) applyOp({ op: 'close', ...at }, { by: 'pointer' })
      else if (u.paperCast) applyOp({ op: 'cast', ...at }, { by: 'pointer' })
      else if (u.paperResize) applyOp({ op: 'resize', ...at, w: (p.w ?? 300) + 150 }, { by: 'pointer' })
      else applyOp({ op: 'read', ...at }, { by: 'pointer' })
      return
    }

    // GUARDED, because the raycast now returns things that are not windows. It
    // read `signs.get(key).milepost` unconditionally, so any hit without a
    // `signKey` threw inside the handler -- and a listener that throws stops
    // handling clicks, which does not read as an exception, it reads as a
    // dashboard whose buttons stopped working.
    const sign = signs.get(hit.object.userData.signKey)
    if (sign) flattenTo(sign.milepost)
  })

  // A HOVER HAS TO BE ABLE TO END, and on a canvas that fills the window the ways
  // it ends are not all pointermoves on the canvas.
  //
  // Nothing here is a hover once the pointer is off the drawing: leave the window
  // entirely, or cross onto the status line, which is a DOM element sitting over the
  // canvas and eats the moves under it. Both left whatever was last lit still lit --
  // reported as a highlight that would not go back. `pointerout` covers moving to
  // another element as well as leaving the window; `pointercancel` covers a pointer
  // that is taken away from us mid-gesture.
  const dropHover = () => {
    setHovered(null)
    setRampHover(null)
    canvas.style.cursor = ''
  }
  for (const kind of ['pointerout', 'pointerleave', 'pointercancel']) {
    canvas.addEventListener(kind, dropHover)
  }
  window.addEventListener('blur', dropHover)

  // Hover, so a lane reads as clickable before you click it.
  canvas.addEventListener('pointermove', (ev) => {
    if (state.mode !== 'driving') {
      setHovered(null)
      setRampHover(null)
      return
    }
    const hit = aim(ev)
    const action = actionAt(hit)
    // Two hover owners because they light two different kinds of thing: the gantry
    // recolours a panel it owns, the centre line recolours an instance nobody
    // owns. Both are told on every move, including that it is not them.
    //
    // A RAMP IS NOT THE GANTRY'S TO LIGHT, and that was the bug: the deck and the
    // board carry a `gantryAction` -- that is how pressing the tarmac drives you
    // down it -- and handing the hit to setHovered on that basis painted the TARMAC,
    // which the ramp's own hover owner deliberately leaves alone (ramps.js, "the
    // sign lights, the road does not"). Filtering on the action's kind rather than
    // on the mesh keeps one rule: whoever owns the hover for a kind owns all of it.
    const gantryHit = hit ? actionOf(hit.object) : null
    setHovered(gantryHit && gantryHit.kind !== 'ramp' ? hit.object : null)
    setRampHover(hit)
    canvas.style.cursor = hit && (action || hit.object.userData.signKey) ? 'pointer' : ''
  })

  // THE ESCAPE HATCH (invariant 8). Capture phase, or the focused client's
  // keydown listener eats it first -- a focused surface swallows every key
  // including Esc, which is exactly how PARKVPS lost its way back to the road.
  //
  // NOT Esc+CapsLock: CapsLock is a lock, not a modifier, so it would steal Esc
  // from vi whenever the light is on, and the page cannot see the light.
  // THE NUMBER KEYS ARE THE SHELL'S, INCLUDING FROM INSIDE A WINDOW.
  //
  // They were the application's while flat, on the rule that a key typed into a
  // focused program must reach the program. That was right when a digit meant
  // "fly me to the second road" -- nobody wants typing `2` in an editor to move
  // them -- and it stopped being right when a digit became a TRACK. A track is
  // the thing you switch between while working, so a track key that only works
  // when you are not working is not a track key.
  //
  // `0` was taken first and 1..9 were left behind, which made the keyboard
  // inconsistent in the worst possible way: one number did something and the
  // other nine looked broken. Reported twice.
  //
  // THE COST, STATED PLAINLY: no digit reaches a focused application any more.
  // That is a real loss and a bigger one than `0` alone -- you cannot type a
  // number into a terminal in a flattened window. It is the price of ten tracks
  // being reachable without a chord, it was asked for twice, and the honest fix
  // when a client that needs digits actually ships is the one written down for
  // Esc below: a modifier, or a double-tap, so both can have them.
  //
  // CAPTURE PHASE, and stopImmediatePropagation on the keys we take. A focused
  // surface's own listener is on the canvas and would otherwise eat them; the
  // two sibling listeners on `window` in this same phase would otherwise still
  // run, which is exactly how one Esc both shut the map and left the window.
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return
      const flat = state.mode === 'flat'

      // ESCAPE SHUTS THE MAP FIRST. Plain Esc belongs to the application
      // (invariant 8 forwards it, which is why the way out is a chord) -- but
      // not while a menu of ours is open over it, because there Esc is aimed at
      // the menu, like it is everywhere else in computing.
      // A REPLAY IS THE TOPMOST THING ESC CAN MEAN, so it is answered before the
      // map and before the gear.
      //
      // IT LIVES HERE AND NOT IN shell.js, WHICH IS THE FIX. It was in shell's
      // gear listener, which is on `window` in the BUBBLE phase -- reachable
      // only if nothing in this capture-phase listener stops propagation first,
      // and there are three branches here that do. Reported as "pressing esc
      // doesn't work", and the honest reading is that I put a key on the one
      // path in this file that another handler is allowed to eat.
      if (ev.key === 'Escape' && isReplaying()) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        stopReplay('escape')
        return
      }

      if (ev.key === 'Escape' && mapIsOpen()) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        closeMap()
        return
      }

      // The reel gets Esc on the same terms and for the same reason -- it is a
      // menu of ours over whatever is behind it, and Esc belongs to the topmost
      // menu everywhere else in computing too.
      if (ev.key === 'Escape' && reelIsOpen()) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        closeReel()
        return
      }

      // A FIELD YOU ARE TYPING IN OWNS ITS KEYSTROKES. The map has name boxes and
      // a lane box, and without this naming a workspace "build 2" switches you to
      // track 2 while you type it and a zero shuts the map you are editing in.
      // Above the flat branch as well as below it, because the map can be open
      // over a flattened window now.
      if (ev.target?.closest?.('#map input, #map select')) return
      // The reel's name boxes are text fields over the same shell, so a digit
      // typed into a track's name must name it rather than switching track --
      // the same exemption `#map input` gets one line up, for the same reason.
      if (ev.target?.closest?.('#reel input')) return

      if (!flat && (ev.key === 'o' || ev.key === 'O')) return void toggleMap()

      // NO KEY FOR THE REEL. It is gear R, reached by the gate or by `G · next
      // gear` like every other scene, and a letter beside that would be a second
      // way in with its own rules. This branch briefly bound `t`; the cockpit
      // already had the detent and it was only ever waiting for the scene.
      if (!/^[0-9]$/.test(ev.key)) return
      // THE DIGITS BELONG TO THE APPLICATION ONLY IN FULL SCREEN. The line this
      // replaces was `if (flat) return`, which gave them up the moment you stood
      // in a window at all.
      //
      // Both halves of that were asked for, in this order, and the second one is
      // the correction to the first. Giving the digits up entirely was right
      // about the reason -- a window you are typing into must get the keystroke
      // -- and wrong about the boundary: STANDING IN a window is the ordinary
      // working view, with the road, the gate boards and the dashboard all still
      // in frame, and a track key that stops working the moment you are actually
      // working is not a track key. Full screen is the state where you have
      // explicitly asked for nothing but the window; every strip the shell owns
      // is already hidden there (`:root.full` in index.html), so the keyboard
      // going with them is the same promise kept once rather than two rules.
      //
      // THE COST, STATED PLAINLY: you still cannot type a number into a flattened
      // terminal. The way out is the one full screen already is -- and the honest
      // long-term fix is still the one written down for Esc below, a modifier or
      // a double-tap, so both sides can have the whole row.
      if (state.full) return

      // AND NOW THE KEY HAS TO BE TAKEN PROPERLY, which it never had to be
      // before. While the digits were only ever read from the road there was no
      // focused surface to take them FROM, so this branch could get away with
      // just acting. In a flattened window there is one, its keydown is bound to
      // the canvas (browser/input.js) and this listener is capture-phase on
      // `window` -- so without these two lines a `2` would switch track AND be
      // typed into the application.
      ev.preventDefault()
      ev.stopImmediatePropagation()

      // ZERO IS THE MAP, but only as the FIRST digit -- tracks are numbered from
      // 1, so a leading zero can never be part of a track number while the zero
      // in "10" always is. That is the whole rule, and it is why the test is on
      // the buffer being empty rather than on a mode.
      //
      // From inside a window it opens the map ON that window AND LEAVES YOU IN
      // IT: a menu does not close the document in order to open itself.
      if (ev.key === '0' && digits === '') {
        // ONE SCENE AT A TIME, and this cost a round trip to find. The reel
        // paints at z-40 and the map at z-6, so a map opened while the reel was
        // up went BEHIND it -- `0` did exactly what it was asked and looked like
        // a dead key, which is the worst shape a bug can take. Reported as
        // "switching back and forth between 0 and R doesn't work".
        //
        // Closing it here rather than inside `openMap` keeps map.js and reel.js
        // from importing each other: the caller knows about both, the scenes
        // know about neither.
        //
        // `closeReel` runs its `leave`, so the stick comes out of R too -- the
        // gate must not report a scene the map is now standing in front of.
        if (reelIsOpen()) closeReel()
        if (!flat) return void toggleMap()
        if (mapIsOpen()) return void closeMap()
        openMapAt(state.flatDistrict, state.flatMilepost)
        return
      }

      // TYPING 1 THEN 0 MEANS TRACK 10, NOT TRACK 1 AND THEN THE MAP.
      //
      // Digits accumulate, and they always have -- the rule was written for lane
      // numbers when a road network could grow past nine, and it is what makes a
      // tenth track reachable without inventing a key for it.
      digits += ev.key
      clearTimeout(digitTimer)

      // COMMIT AS SOON AS THE NUMBER CANNOT GROW. `2` can only ever mean track 2
      // -- there is no track 20 -- so it goes immediately and nine of the ten
      // switch on one keystroke. Only `1` waits, because it could still become
      // 10, and then only for as long as someone might plausibly still be typing.
      //
      // THE BOUND IS THE TRACK COUNT NOW, AND IT WAS THE WORKSPACE COUNT. Left as
      // `ws.list().length` it read 3, so `1 * 10 > 3` committed track 1 on the
      // spot and the following `0` was a fresh leading zero -- which is the map.
      // Measured exactly that: `1` `0` selected track 1 and opened the map, and
      // track 10 could not be reached at all.
      //
      // NOW IT IS THE POPULATION AND NOT THE CEILING (tracks.js). Reading MAX
      // here would be that same bug with the sign flipped: `7 * 10 > 999` is
      // false, so every single-digit press would sit out the gap waiting for a
      // second digit that in most shells cannot come. `canGrow` answers the
      // question the old arithmetic was approximating -- is there a LONGER track
      // that starts with this -- so nine tracks or fewer never start the timer.
      if (!tracks.canGrow(digits)) commitDigits()
      else digitTimer = setTimeout(commitDigits, DIGIT_GAP)
      return void 0
    },
    { capture: true },
  )

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

  // PLAIN ESC USED TO LEAVE, AND NO LONGER DOES. Kept as a note because the
  // reasoning that put it there was sound and the reasoning that took it away is
  // the other half of the same argument.
  //
  // It was added because every route out of a flattened window was either
  // invisible or intercepted: the chord is eaten by a PARKVPS console in front of
  // us, nothing on screen named a way out, and clicking another window does
  // nothing while flat. That was a room with the door painted on, and Esc was the
  // door. The cost was written down at the time -- "a full-screen vi in a
  // flattened window can no longer use Esc" -- as a thing to fix when a client
  // that needed it shipped.
  //
  // What changed is that the window now NAMES its own ways out: the corner
  // controls, the ship on the post, the flying ship in full screen, and a click
  // beside the surface. The door is drawn on the wall now, so the shell can stop
  // holding the one key every terminal program is waiting for. Asked for, and it
  // is the same trade read from the other end.

  // Whether Esc is physically down, and whether anything used it while it was.
  // Declared HERE and not inside the listener: both key handlers and the wheel
  // read them, and an earlier edit deleted these two lines along with a comment
  // block above them -- which in an ES module (always strict) turned every read
  // into a ReferenceError thrown inside a capture listener. The symptom was that
  // Esc silently did nothing at all while the chord in the same handler kept
  // working, because the chord returns before it touches either.
  let escHeld = false
  let escUsed = false
  // Whether THIS press is one the flat view took for itself. Separate from
  // `escHeld`, because the map's Esc branch above returns before any of this and
  // must not leave a keyup behind that walks you out of the window as well.
  let escOwned = false

  window.addEventListener(
    'keydown',
    (ev) => {
      // THE CHORD IS THE ONLY KEY THIS SHELL STILL TAKES FROM A WINDOW.
      //
      // Ctrl+Alt+Shift+Esc/R, and it stays for the reason it was invented: it is
      // the hatch you reach for when something has gone wrong, no console in
      // front of us claims it, and it is unreachable by accident. Take this away
      // and a client that has grabbed the pointer leaves no way out at all.
      if (isRelease(ev)) {
        ev.stopPropagation()
        ev.preventDefault()
        release()
        canvas.blur()
        return
      }
      // ESC LEAVES THE WINDOW, AND ONLY OUT OF THE BASIC FLAT VIEW.
      //
      // Third position on this key, and the boundary is now the same one the
      // digits settled on -- which is the point, because two shell keys with two
      // different ideas of when a window owns the keyboard is not a rule anyone
      // can hold in their head.
      //
      // It used to release on keydown, then on keyup unless held as a zoom
      // modifier; then it was given up entirely, on the argument that Esc is the
      // single worst key to take because every terminal program, editor and
      // dialog is waiting for it. That argument is still true, and it is an
      // argument about FULL SCREEN -- the state where you have explicitly asked
      // for nothing but the window, where every strip the shell owns is already
      // hidden, and where the ship on the frame is a way out that costs no key at
      // all. Standing at a flattened window on the road is the ordinary working
      // view, and there Esc means what it means everywhere else in computing:
      // back out of the thing I stepped into.
      //
      // WHAT THIS COSTS, PLAINLY: Esc no longer reaches an application you are
      // merely standing in front of, so leaving vi's insert mode needs full
      // screen (or the click-outside gesture to leave first). Held-Esc as a wheel
      // modifier also goes with it in flat mode -- the first keydown releases you
      // -- but that hatch was already redundant, because `ctrl`/`cmd`+wheel means
      // the shell anywhere including over the window (see the wheel handler).
      if (ev.key === 'Escape') {
        // Recorded on EVERY Escape, repeat or not, so "the handler never ran"
        // and "the handler ran and declined" stop looking the same.
        state.escSeen = { at: state.frames, repeat: !!ev.repeat, held: escHeld,
                          full: !!state.full, mode: state.mode }
        const mine = state.mode === 'flat' && !state.full
        if (mine) {
          // TAKEN PROPERLY. The surface's own keydown is bound to the canvas and
          // this listener is capture-phase on `window`, so without both of these
          // the window would be left AND the application would get the Esc.
          ev.preventDefault()
          ev.stopImmediatePropagation()
        }
        // LEAVING HAPPENS ON KEYUP, NOT HERE, AND THAT IS WHAT LETS ONE KEY DO
        // BOTH JOBS.
        //
        // Releasing on keydown was the first cut of this and it silently killed
        // the other thing Esc does: holding it is a wheel modifier that means
        // "the shell, wherever the pointer is", which is how you zoom a window
        // you are standing in. The very first keydown walked you out, so
        // `escIsHeld()` was never true by the time a wheel arrived and the zoom
        // could not be reached at all. Reported, and correctly.
        //
        // So the press is only a decision once it ENDS: a tap leaves, and a hold
        // that something USED is a modifier and leaves nothing. That is the
        // distinction `escUsed` was always for -- the wheel handler sets it
        // through `noteEscUsed()` -- and it is why this file used to work this
        // way before Esc was given up entirely.
        if (!ev.repeat && !escHeld) {
          escHeld = true
          escUsed = false
          escOwned = mine
        }
      }
    },
    { capture: true },
  )

  window.addEventListener(
    'keyup',
    (ev) => {
      if (ev.key !== 'Escape') return
      const owned = escOwned
      const used = escUsed
      escHeld = false
      escOwned = false
      state.escZoomGesture = used
      escUsed = false
      // A TAP LEAVES THE WINDOW; A HOLD THAT WAS USED LEAVES NOTHING.
      //
      // `owned` is what keeps this honest about which press it is answering: an
      // Esc that shut the map returned long before `escOwned` was set, and an Esc
      // pressed on the road or in full screen never owned one either. Without it
      // this listener would walk you out of a window on the release of a key that
      // was aimed at something else entirely.
      //
      // The mode is re-read rather than trusted from keydown, because a press can
      // outlive the state it began in -- Esc+wheel can end with you somewhere
      // else, and releasing the key is not a second instruction to leave.
      state.escUp = { at: state.frames, owned, used }
      if (!owned || used) return
      if (state.mode !== 'flat' || state.full) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      release()
      // The same pair the chord uses. `release()` moves the camera; the blur is
      // what actually takes the keyboard back off the client, which is settled by
      // DOM focus here rather than by a flag.
      canvas.blur()
      state.escLeft = { at: state.frames }
    },
    { capture: true },
  )

  // A KEY CANNOT STAY HELD ACROSS A BLUR. The browser stops delivering keyups to
  // a window that has lost focus, so an Esc released elsewhere would leave this
  // latched and the next scroll would silently be a zoom.
  window.addEventListener('blur', () => {
    escHeld = false
    escUsed = false
    // AND THE CLAIM ON THE PRESS. Left latched, the next Escape keyup to arrive
    // -- one belonging to an entirely different press -- would read as a tap this
    // view had taken and walk you out of a window you were using.
    escOwned = false
  })

  // Read by the wheel handler above. A function rather than a shared `let` so
  // there is one owner of the fact and the wheel only asks.
  escIsHeld = () => escHeld
  noteEscUsed = () => {
    escUsed = true
  }
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
