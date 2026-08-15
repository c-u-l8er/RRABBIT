// The stage both personalities stand on.
//
// T&R is Travel & RRABBIT, and they are two personalities rather than two
// layers. Travel navigates -- the road, the camera, the flight, the districts.
// RRABBIT *is* the windows -- the sign on the road, the surface that flattens
// to 1:1 under you, the rect that decides a click belongs to it. One likes
// going; the other likes being gone to.
//
// This module is what they share and neither owns: the scene handles, the
// window ledger, the numbers the HUD reads. Everything here is deliberately
// personality-free -- if something in this file starts to feel like it belongs
// to one of them, it belongs in travel.js or rrabbit.js instead.
//
// `ctx` is filled once, by buildWorld in shell.js, and then handed to each
// personality's attach(). They copy it into their own bindings so that every
// function moved here from the old single file reads EXACTLY as it did before
// -- the split moved code, it did not rewrite it.

import { root as workspaceRoot, rampsOf } from './workspaces.js'

export const ACC = 0xf2c14e
export const COOL = 0x2de2e6
export const BG = 0x03040a

// MILE IS GONE, AND SO IS THE SECOND COORDINATE SYSTEM IT DEFINED.
//
// A window used to stand at `ENTER_Z - GATE_GAP - ordinal*MILE - (right ? MILE/2 :
// 0)`: its own grid, tuned by eye three times (460, 560, 660), with the two sides
// deliberately half a MILE out of step. A ramp stands on a DASH. Two grids on one
// road, and everything that had to stop them colliding -- the reservation bands,
// windowsBlockDash, rampBlocksLane, the "at most one window slot" arithmetic --
// existed only to translate between them.
//
// So there is one grid: THE DASHES. A window occupies a dash on a side exactly the
// way a ramp does, both are placed and moved by dash number, and a conflict is now
// two footprints overlapping rather than two formulas being compared. The reason
// this is worth the churn is not tidiness -- it is that a dash is a THING YOU CAN
// POINT AT, so "put a window here" and "put an exit here" become the same gesture
// on the same marker.
//
// What it costs, stated plainly: the half-MILE stagger is gone, so a left and a
// right window on the same dash now stand directly opposite each other. That was a
// real property -- it is what made a road with windows down both sides read as
// dense rather than as two files -- and it is recovered by CHOOSING dashes rather
// than by arithmetic nobody can see.

// ---- the shape of a road --------------------------------------------------
//
// A road is not just a line of windows any more. It has an ENTRANCE, a middle,
// and an EXIT, in that order, and you drive through all three:
//
//   z=+260 you start here
//   z=-180 ENTER gantry ... where windows are created onto this road
//          (a long clear run, so the sign is read and passed, not glanced past)
//   z=-1080 milepost 1, milepost 2, ... the windows
//          (the same clear run again)
//   z=...  EXIT gantry ... where the lanes to other workspaces are
//
// The clear run either side of the windows is the point. The first build put
// the gantry 80 units in front of milepost 1 and it read as furniture standing
// among the windows rather than as a gate you pass through -- reported twice,
// once as "it gets in the way" and once as needing to be "way in front of the
// windows so that we have to scroll through it fully and then we see them".
//
// GATE_GAP is that run. At the wheel's 0.6 units per delta and a 120-unit notch
// it is about twelve notches of empty road, which is long enough to feel like
// arriving somewhere and short enough not to be a chore.
export const ENTER_Z = -180
export const GATE_GAP = 900
export const SCENE_ID = 'road'

// Where a window stands: on its dash, like everything else on this road.
//
// It keeps a function of its own rather than every caller reaching for `dashZ`,
// because "where does a window stand" is a question about the road's shape and the
// answer has been rewritten twice already.
export const windowZ = (dash) => dashZ(dash)

// ---- the centre line ------------------------------------------------------
//
// THE DASHES ARE ADDRESSES, not decoration. A yellow centre line down the middle
// of the road is the marking a road has; making each dash a numbered slot is
// what turns it into a row of places you can point at -- which is what a ramp
// needs, because a ramp is not at the gate and not at a milepost, it is at a spot
// on the tarmac.
//
// `dashZ` is arithmetic on constants and NOTHING ELSE. That is deliberate and it
// is the same discipline as a milepost: dash 7 is at the same z whether the road
// has one window on it or twelve, so a ramp built at dash 7 does not move when
// the road around it changes. If this ever grew a term for the window layout,
// every ramp on every road would slide the next time a window opened.
export const DASH_PITCH = 180
export const DASH_LEN = 96
// Just in front of where you park at the head of the road, so dash 0 is the first
// thing under the bonnet rather than something behind you.
export const DASH_0_Z = 200
export const dashZ = (i) => DASH_0_Z - i * DASH_PITCH
// Which dash is nearest a given z -- for the panel that has to say where a ramp
// is in words. NOT used to place anything (see the note in windowZ's neighbour
// about inverses); rounding here decides a label, not a position.
export const dashNear = (z) => Math.max(0, Math.round((DASH_0_Z - z) / DASH_PITCH))

// The exit gate stands one clear run past the LAST THING on a road -- read off
// what is actually standing there rather than computed from a count, because the
// two sides advance independently and neither one's ordinal knows how far down
// the road the other has got.
//
// An empty road still has an exit gate: a workspace with nothing in it is still
// somewhere you can leave.
export function lastWindowZ(district) {
  let z = windowZ(SLOT_FIRST)
  for (const s of signs.values()) if (s.mesh && s.district === district) z = Math.min(z, s.mesh.position.z)
  return z
}

// EVERY WINDOW ON A ROAD, in the order you drive past them.
//
// Both sides interleaved, because that is the order the road presents them in --
// the sides are separate for SPACING and were never separate for "where am I in
// the queue". Out here rather than in either personality because all three callers
// need the same answer and a second copy of the sort is a second copy that can
// disagree: RRABBIT moves windows along it, Travel steps between them with the
// (prev) / (next) controls, and the map lists them in it.
//
// It sorts on the DASH now rather than on a z computed from an ordinal and a side.
// Same order, one less translation -- and two windows facing each other across the
// road share a dash, so the tie is broken by side to keep the order total.
export const roadOrder = (district) =>
  [...signs.values()]
    .filter((s) => s.mesh && s.district === district)
    .sort((a, b) => a.dash - b.dash || a.side - b.side)

// ---- the shape of a ramp --------------------------------------------------
//
// How far down the road an off-ramp reaches from its dash, and how far out to the
// side it ends up. Both live here rather than in ramps.js because the rest of the
// road has to reason about them: the exit gate stands past the ramp's END, and the
// window row has to leave the ramp's mouth clear.
//
// RAMP_OUT is set BY the window row, not chosen: a right-hand window's sign spans
// x = 180..480, so a board at 980 is the first x at which nothing an off-ramp
// carries can end up tangled in a window. RAMP_SPAN is then how much z that sweep
// needs to look like a road rather than a hinge.
export const RAMP_SPAN = 560
export const RAMP_OUT = 980

// A RAMP IS A THING ON THE ROAD, so the gate has to stand past it too -- past its
// far END, not just past the dash it leaves from.
//
// Without this a ramp built far down a long road becomes unreachable the moment
// the windows that made the road long are closed: the gate moves back up, the
// wheel's far stop moves with it, and the marker is left beyond the end of the
// tarmac you are allowed to drive on. A marker you can see and cannot reach is
// worse than no marker.
export function lastRampZ(district) {
  let z = 0
  for (const r of rampsOf(district)) z = Math.min(z, dashZ(r.at) - RAMP_SPAN)
  return z
}

// The furthest pane down a road. Panes are a third slot occupant (see `papers`)
// and the gate has to clear them for the same reason it clears windows: the exit
// is the END of the road, and a document standing past it reads as a road that
// kept going after it ended.
export function lastPaperZ(district) {
  let z = 0
  for (const p of papers.values()) if (p.district === district) z = Math.min(z, dashZ(p.dash))
  return z
}

export const exitZOf = (district) =>
  Math.min(lastWindowZ(district), lastRampZ(district), lastPaperZ(district)) - GATE_GAP

// How many dashes a road needs: enough to run past its own exit gate, and never
// fewer than enough to carry its furthest ramp. Capped, because the count is a
// per-frame reconciliation and an absurd road should cost an absurd road's worth
// of quads and no more.
export const DASH_MAX = 96
export function dashCount(district) {
  const reach = Math.min(exitZOf(district) - GATE_GAP / 2, dashZ(SLOT_FIRST + 2))
  return Math.min(DASH_MAX, Math.ceil((DASH_0_Z - reach) / DASH_PITCH) + 1)
}

// ---- one grid, one notion of "taken" -------------------------------------
//
// This replaced rampBandsOf / rampBlocksLane / windowsBlockDash, which were three
// functions doing one job badly: translating between the window grid and the dash
// grid, in z, with a band whose width had to be argued about. There is one grid
// now, so occupancy is what it should always have been -- two integer ranges either
// overlapping or not.
//
// TWO RULES, ON ONE SIDE OF THE ROAD, AND THEY ARE WRITTEN OUT RATHER THAN
// DERIVED FROM A SHARED "FOOTPRINT":
//
//   window vs window   at least SLOT_GAP dashes apart. Four dashes is 720 units,
//                      which is where the old MILE had been tuned to by eye after
//                      three tries (460, 560, 660) -- a 300-wide sign turned 24
//                      degrees covers 122 units of z on its own, and consecutive
//                      signs any closer clip each other as you scroll past.
//
//   window vs ramp     the window must be outside the ramp's own sweep, which runs
//                      from one dash IN FRONT of it (where its sign stands on the
//                      verge) to four dashes BEHIND (RAMP_SPAN of departure curve).
//
// A symmetric footprint was tried first and gave the wrong answer for the common
// case: non-overlapping [d-3, d+3] boxes force windows SEVEN dashes apart, nearly
// double the spacing anyone asked for. The two rules are different shapes because
// the two things are different shapes, and saying so costs four lines.
export const SLOT_GAP = 4
const RAMP_AHEAD = 1
const RAMP_BEHIND = 4

// The first dash a WINDOW may stand on. GATE_GAP of clear road past the enter gate
// is what makes the gate something you drive through rather than furniture standing
// among the windows, and that run is measured in the same dashes now.
export const SLOT_FIRST = Math.ceil((DASH_0_Z - (ENTER_Z - GATE_GAP)) / DASH_PITCH)
// A ramp may start earlier: it is a marking and a turning, not a structure in the
// way, and an exit you take early is an ordinary thing for a road to offer.
export const RAMP_FIRST = 3

const sideOf = (x) => (x > 0 ? 1 : -1)
const inRampSweep = (dash, at) => dash >= at - RAMP_AHEAD && dash <= at + RAMP_BEHIND

// What stands on this exact dash, on this side. The dash is the address, so this is
// the lookup every "what is here?" question goes through.
export function slotAt(district, side, dash) {
  const s = sideOf(side)
  for (const sign of signs.values()) {
    if (!sign.mesh || sign.district !== district || sideOf(sign.side) !== s) continue
    if (sign.dash === dash) return { kind: 'window', milepost: sign.milepost, sign }
  }
  const r = rampsOf(district).find((x) => x.at === dash && sideOf(x.side) === s)
  if (r) return { kind: 'ramp', to: r.to, at: r.at }
  for (const p of papers.values()) {
    if (p.district === district && sideOf(p.side) === s && p.dash === dash) return { kind: 'paper', paper: p }
  }
  return null
}

// Could something of `kind` stand here without crowding anything already standing on
// this side? `ignore` is a sign being MOVED, which must not block itself -- and a
// sign whose dash is not an integer is one mid-repack, which is not standing
// anywhere yet.
export function slotFree(district, side, dash, kind = 'window', ignore = null) {
  const s = sideOf(side)
  if (!Number.isInteger(dash) || dash < (kind === 'ramp' ? RAMP_FIRST : SLOT_FIRST)) return false
  for (const sign of signs.values()) {
    if (sign === ignore || !sign.mesh || sign.district !== district) continue
    if (sideOf(sign.side) !== s || !Number.isInteger(sign.dash)) continue
    if (kind === 'ramp' ? inRampSweep(sign.dash, dash) : Math.abs(sign.dash - dash) < SLOT_GAP) return false
  }
  for (const r of rampsOf(district)) {
    if (sideOf(r.side) !== s) continue
    if (kind === 'ramp' ? r.at === dash : inRampSweep(dash, r.at)) return false
  }
  // A pane crowds like a window rather than like a ramp: it is a structure standing
  // beside the road, not a marking on it. `ignore` is honoured here too, so moving a
  // pane does not find itself in the way.
  for (const p of papers.values()) {
    if (p === ignore || p.district !== district || sideOf(p.side) !== s) continue
    if (!Number.isInteger(p.dash)) continue
    if (kind === 'ramp' ? inRampSweep(p.dash, dash) : Math.abs(p.dash - dash) < SLOT_GAP) return false
  }
  return true
}

// The nearest free dash at or after `from`, searching outward when asked to stay
// near somewhere in particular. Outward keeps a bumped window as close as it can to
// the place it was aiming for; forward-only is what a brand new window wants,
// because it has no place it was aiming for and the head of the road is where a
// road starts filling up.
export function nextFreeSlot(district, side, from, kind = 'window', ignore = null) {
  const floor = kind === 'ramp' ? RAMP_FIRST : SLOT_FIRST
  for (let d = Math.max(floor, from); d < DASH_MAX; d++) {
    if (slotFree(district, side, d, kind, ignore)) return d
  }
  return null
}

export function nearestFreeSlot(district, side, want, kind = 'window', ignore = null) {
  const floor = kind === 'ramp' ? RAMP_FIRST : SLOT_FIRST
  const start = Math.max(floor, want)
  for (let step = 0; step < DASH_MAX; step++) {
    if (slotFree(district, side, start + step, kind, ignore)) return start + step
    if (start - step >= floor && slotFree(district, side, start - step, kind, ignore)) return start - step
  }
  return null
}

// WHICH WINDOW YOU ARE AT, as a number, for the gate board's `track:at-total`.
//
// Two definitions that have to agree, and do: standing IN a window it is that
// window's place in road order, and driving it is how many windows you have drawn
// level with. At the head of a road both answer 0, which is why the board can say
// `0-2` there and mean something rather than nothing.
//
// It reads `state.roadZ`, which travel.js publishes every frame -- the camera is
// Travel's and this is the one fact about it the furniture needs. `>=` rather than
// `>` so drawing level with a window counts as being at it.
export function windowAtOn(district) {
  const order = roadOrder(district)
  if (state.mode === 'flat' && state.flatDistrict === district) {
    const i = order.findIndex((s) => s.milepost === state.flatMilepost)
    return i < 0 ? 0 : i + 1
  }
  const camZ = 260 + (state.roadZ ?? 0)
  let n = 0
  for (const s of order) if (windowZ(s.dash) >= camZ) n++
  return n
}

// How far ahead of you a gantry sits when you stop in front of it. Measured, not
// chosen: at 320 units the 58-degree frustum is only 355 units tall about y=105
// and a beam at y=300 is clipped off the top of the frame; at 440 the frustum is
// 488 tall and the whole structure is in shot.
export const GANTRY_VIEW = 440

// HOW FAR BACK PAST THE HEAD OF THE ROAD THE WHEEL MAY TAKE YOU, and why it is
// no longer zero.
//
// The wheel used to stop dead at the start (`near: 0`), which put the enter gate
// at exactly GANTRY_VIEW and no further. That was the right stop when the frame
// was all windshield. IT IS NOT ANY MORE: the cockpit now covers the bottom
// third of the screen, so the band the road is actually visible in is the top
// two thirds, and the gate that was framed against a full frame is framed
// against a shorter one. Reported as not being able to see the entrance sign
// properly, which is exactly what a sign standing in the part of the frustum the
// dashboard has taken looks like.
//
// MEASURED, not chosen, and the measurement includes the dashboard:
//
//   the frustum is 2*d*tan(29 deg) = 1.1086*d tall, centred on the camera's y=105
//   the cockpit's crown sits at 596 of 900 px, so the clear band is the top 66.2%
//   the clear band's bottom edge is therefore at y = 105 - 0.1796*d
//   the road surface is at y = -30, and the gantry's feet stand on it
//
//   -30 >= 105 - 0.1796*d   =>   d >= 752
//
// 760 with the margin. At that distance the frustum top is y=526 against a board
// top of 328 (BEAM_Y + 12 + BOARD_H), so the whole structure -- feet, uprights,
// beam and board -- stands clear of both the frame edge and the hood.
export const ENTER_VIEW = 760

// The same distance as a roadZ bound: camera z is 260 + roadZ, and we want
// (camera z - ENTER_Z) === ENTER_VIEW. Named here rather than computed at the
// clamp because the ROAD MESH has to be long enough to still be under you when
// you get there -- two readers, one definition.
export const HEAD_ROOM = ENTER_Z + ENTER_VIEW - 260

// A CANVAS TEXTURE WEBGL1 WILL NOT SILENTLY REBUILD ON EVERY UPLOAD.
//
// This runs on WebGL1, where a texture whose dimensions are not powers of two
// cannot be mipmapped or repeated -- so three quietly RESIZES it to the nearest
// powers of two instead. That is not free and it is not once: it happens on every
// `needsUpdate`, and half the signs in this shell are canvases sized to their own
// text (the name board, the step controls, the close answers) or to a layout that
// is not a power of two (the ramp board at 512x320). The console says so, once per
// upload:
//
//     THREE.WebGLRenderer: Texture has been resized from (512x320) to (512x256)
//
// A sign that repaints as you drive -- which the ramp board now does, because it
// carries how far down the road you are -- therefore paid for a full canvas
// rescale per repaint, per ramp. Measured after one drive: seventeen rescales.
//
// The fix is to stop asking for mipmaps. Nothing here is tiled and nothing needs
// minification filtering beyond linear -- these are flat quads read at reading
// distance -- so `generateMipmaps: false` plus a linear min filter and clamped
// wrapping makes a non-power-of-two canvas legal, uploaded as-is, at its own size.
//
// THE COST, STATED: no mipmaps means more aliasing on a sign seen from far away.
// That is the right way round for these -- the previous behaviour paid for its
// mipmaps by throwing away the resolution first, so a distant sign was being
// smoothed from an image that had already been squashed.
export function canvasTexture(THREE, canvas) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

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
//
// THE DISTRICT LIST AND ITS ARITHMETIC LIVE IN workspaces.js NOW. `DISTRICTS`
// was an array and `districtX` was `index * 2600`; a graph fits in neither, and
// a workspace is identified by its id from here on -- `state.district` and a
// sign's `.district` both hold one.
export const LEDGER_PITCH = 264 // slot spacing in the flat output
export const LEDGER_COLS = 4

export const state = {
  compositor: 'idle',
  surfaces: 0,
  signs: 0,
  adopted: 0,
  frames: 0,
  // Beats spent braked instead of rendering -- see "the idle backoff". Reported
  // rather than silent because an abandoned tab of this page once held 3.4 cores
  // for ten hours and the only number that would have shown it was `frames`
  // climbing, which reads the same as work.
  idleBeats: 0,
  decodes: 0,
  suppressed: 0,
  // Null until the GPU takes the context away mid-session, then the reason. It is
  // the one state the shell cannot come back from, so it is reported rather than
  // counted: `null` and "a number that stopped moving" look the same from outside.
  contextLost: null,
  glErrors: 0,
  lastGlError: 0,
  lastGlErrorFrame: 0,
  sessionId: null,
  // M2
  mode: 'driving', // driving | flying | flat
  flatMilepost: null,
  flatDistrict: null,
  // WHICH WINDOW HAS BEEN ASKED ABOUT AND NOT ANSWERED, as `district:milepost`.
  //
  // Closing is the only act on a window that cannot be undone, so `X--` asks before
  // it does it. The question is asked in travel.js (which owns the pointer) and
  // drawn in rrabbit.js (which owns the chrome), and those two modules cannot import
  // each other -- rrabbit already imports travel for `release`. Shared state is how
  // everything else in that pair is coordinated, and one field beats a second copy
  // of the answer in each module, which is the arrangement where a window closes
  // because the two disagreed about whether the question had been asked.
  closeAsking: null,
  // Non-zero exactly when the flattened window is NOT pixel-exact, which is the
  // only honest way to read a zoom that is now remembered per window.
  flatZoom: 0,
  // FULL SCREEN: the shell shows nothing but the window. Set only while `mode`
  // is 'flat' -- it is a property of standing in a window, not a mode of its own,
  // and every reader treats it that way rather than as a fourth mode.
  full: false,
  fullFrom: null,
  // Wheel gestures begun while flat, and who owned the last one. The zoom used
  // to be hijacked mid-gesture by the window it was growing; these are what make
  // that visible rather than something you have to feel.
  wheelGestures: 0,
  lastAxisToApp: null,
  pointerSent: 0,
  buttonSent: 0,
  lastScenePoint: null,
  lastPickMatched: null,
  released: 0,
  // The workspace you are STANDING IN, by id. It was the index 0; a graph has
  // no meaningful index to default to, so it is the root of the graph.
  district: workspaceRoot(),
  overview: false,
  placed: 0,
  ledgerDistinct: null,
  strandedPopups: 0,
  strandedWarned: false,
  popupQuads: 0,
  lastWasPopup: null,
  popupError: null,
  tubeReader: null,
  tubePolls: 0,
  tubeError: null,
  error: null,
  frameError: null,
}

// surface key -> { milepost, mesh, tex, rt, size, view }
//
// RRABBIT writes it, Travel reads it. It is the one thing both of them need,
// which is why it lives out here rather than with either.
export const signs = new Map()

// `district:side:dash` -> { district, side, dash, format, doc, mesh, ... }
//
// A THIRD KIND OF THING THAT STANDS ON A DASH, and the slot algebra has to know it
// exists. `slotAt`/`slotFree` knew about two occupants -- windows (`signs`) and
// ramps -- so a pane they had never heard of would be a pane a window gets placed
// on top of. That failure would not read as "the slot table is incomplete"; it
// would read as a document that vanished.
//
// paper.js writes it, world.js's slot algebra reads it: the same arrangement
// `signs` already has with RRABBIT, and here for the same reason -- the module
// that owns the object and the module that owns the addressing cannot import each
// other.
export const papers = new Map()

// surface key -> the title the client last set for itself.
//
// GREENFIELD DOES NOT KEEP THIS. `DesktopSurface.setTitle` only fires
// `userShell.events.surfaceTitleUpdated` and stores nothing, so a shell that
// wants to put a name on a window has to be the thing that remembers it. Keyed
// by the same `client:surface` string `keyOf` builds, because
// `toCompositorSurface` is made of exactly those two ids -- so the event and the
// sign meet without a lookup table between them.
//
// Out here with `signs` and for the same reason: shell.js is the only place that
// can hear the event, RRABBIT is the only thing that draws it, and neither owns
// the other.
export const titles = new Map()

// surface key -> the name YOU gave this window, which beats the client's.
//
// A client names its own window and often names it badly, or all of them the
// same, or after a file three directories deep. The shell cannot fix that and it
// can let you overrule it. Session-lifetime on purpose: a window is a live
// surface, and a name for one that has closed is a name for nothing.
export const renames = new Map()

// Filled by buildWorld(), then passed to attachTravel()/attachRrabbit().
export const ctx = {
  renderer: null,
  gl: null,
  scene: null,
  camera: null,
  session: null,
}

// What only shell.js can do, for the modules that must ask for it.
//
// Clicking "open window" on the enter gantry is Travel's click and the
// compositor's action, and the compositor lives in shell.js -- which imports
// travel.js, so travel.js cannot import it back. A mutable object READ AT CALL
// TIME rather than copied at attach time, because shell.js only has a launcher
// once the session is up, which is after the last attach() has run.
export const hooks = {
  // (clientX, clientY) => hit|null -- does the COCKPIT own this point?
  //
  // Asked by Travel's pointer handler before it raycasts, so an instrument
  // painted over the road takes the click that lands on it. A hook rather than a
  // listener on purpose: the dash canvas is `pointer-events: none` and must stay
  // that way, so the dashboard answers a question instead of competing for the
  // event. Same shape and same reason as spawnWindow -- shell.js owns the dash
  // and Travel cannot import it.
  dashHit: null,
  // (district, milepost) => {on, listed} -- put this window on the dashboard's
  // TV and add it to the broadcast list. Travel owns the click on `--&`, the
  // ledger and the quad live in broadcast.js, and shell.js is the only module
  // that can see both. Same shape and same reason as closeWindow.
  castWindow: null,
  spawnWindow: null, // () => boolean -- open a window on the road you are on
  // (district, milepost) => asked -- ask the client to close itself. Travel owns
  // the click on the `X--` control and RRABBIT owns the surface, and Travel
  // cannot import RRABBIT (RRABBIT imports Travel, for release()). Same shape
  // and same reason as spawnWindow.
  closeWindow: null,
  // (district, milepost) => void -- A NEW WINDOW HAS APPEARED; take the camera
  // to it. Reported: when an application throws up a dialog, the ship stays
  // where it was and "it is hard to tell what is happening" -- the window is on
  // the road somewhere behind you and nothing says so. RRABBIT is what notices a
  // surface arriving and Travel is what owns the camera; shell.js is the only
  // module that can see both, which is the same shape and the same reason as
  // spawnWindow and closeWindow above.
  arrived: null,
  // (mine: boolean) => void -- take the keyboard, or give it back.
  //
  // The map can be open WHILE YOU ARE STANDING IN A WINDOW now, and both of them
  // want the keys. Greenfield binds keydown/keyup to the CANVAS (browser/input.js)
  // rather than to window, so this is settled by DOM focus and not by a flag:
  // blur the canvas and the client stops receiving keystrokes and is correctly
  // told it lost focus; focus it again and it has them back. Without this,
  // renaming a workspace from inside a window types the name into the
  // application as well.
  shellKeyboard: null,
  // Fired by `stopReplay` on every exit path so the transport comes down with
  // the thing it was transporting. A hook rather than an import because travel.js
  // must not learn that a bar exists.
  replayEnded: null,
}

// WHERE the next adopted window stands: `{ side, dash }`, and the dash may be null
// for "wherever there is room".
//
// A FIFO rather than a single slot: two clicks on "open window ‹ left" and then
// "open window right" must not both land on the right because the second click
// overwrote the first before either surface arrived. Adoption order is not
// guaranteed to match launch order, so a burst can still cross them over -- what
// this guarantees is that the PLACES REQUESTED are the places used.
//
// It carries a dash now because a window can be asked for AT A PARTICULAR MARKER,
// which is the same request a ramp is made by. The surface does not exist when you
// click the dash, so the request has to wait here for it -- exactly the reason the
// side was already queued rather than passed.
export const sideQueue = []

// A slot in the flat output. The ledger is a grid, one cell per window, so no
// two windows share a rect and `pickView` can resolve a point to a window on
// position alone.
export const ledgerSlot = (i) => ({
  x: (i % LEDGER_COLS) * LEDGER_PITCH,
  y: Math.floor(i / LEDGER_COLS) * LEDGER_PITCH,
})

export const keyOf = (view) => `${view.surface.resource.client.id}:${view.surface.resource.id}`
