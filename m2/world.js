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

// Spacing between two windows ON THE SAME SIDE of the road. RAVIO measured its
// way to S=300 for a change feed of 15-25 rows/hour against a road passing 1800
// signs/hour. Windows invert that problem -- there are 5-30 of them, not
// thousands -- so this is NOT RAVIO's S and must not be assumed to transfer
// (spec §7).
//
// IT WAS 260, AND IT MEANT SOMETHING ELSE. It used to be the gap between
// consecutive MILEPOSTS, with sides forced to alternate -- so same-side
// neighbours were really 520 apart and 260 was never the distance between two
// signs you could see at once. Letting the enter gate choose a side broke that
// silently: ask for the left three times and you get three 300-wide signs 260
// apart, each one standing in front of the next. Reported as new windows being
// too close to see the full contents of while scrolling by.
//
// So MILE now means what it says -- the distance between same-side neighbours --
// and the sides are spaced independently of each other (windowZ below).
//
// 460 was the first honest value and it was still tight: a 300-wide sign turned
// 24 degrees toward the road covers 122 units of z on its own, so consecutive
// signs stood about two sign-widths apart and the nearer one still clipped the
// edge of the next. 560, then 660, both asked for.
//
// `?mile=N` overrides it, because this has now been tuned by eye three times and
// the loop for that should not run through a rebuild. It only affects where
// windows adopted AFTER the page loads are placed -- placement is an address and
// is never recomputed (invariant 6) -- so it is a reload knob, which is what a
// layout constant should be.
const MILE_DEFAULT = 660
export const MILE = (() => {
  const n = Number(new URLSearchParams(location.search).get('mile'))
  return Number.isFinite(n) && n >= 200 && n <= 3000 ? n : MILE_DEFAULT
})()
export const SCENE_ID = 'road'

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

// Where a window stands, from its ordinal ON ITS OWN SIDE of the road.
//
// NOT from its milepost. The milepost is the window's ADDRESS -- unique on the
// road, never reissued, the thing input and the flatten resolve through -- and
// tying position to it made the two sides share one sequence, so what the left
// side did decided where the right side's next window went. They are separate
// files of traffic and they are spaced separately.
//
// The half-MILE offset on the right is what keeps the classic alternating look
// when windows do alternate: the left side lands on the MILEs and the right side
// halfway between them, which is exactly the old stagger -- and it now survives
// three windows in a row on one side instead of collapsing. Deliberately written
// in terms of MILE rather than with the numbers in it, because the numbers have
// already moved twice.
export const windowZ = (laneIndex, side) =>
  ENTER_Z - GATE_GAP - laneIndex * MILE - (side > 0 ? MILE / 2 : 0)

// THERE IS DELIBERATELY NO INVERSE OF windowZ.
//
// One existed for a day. Crossing the road asked "which ordinal on the other
// side stands nearest the z I am at now?", and because the two sides are half a
// MILE out of step the answer is always exactly x.5 -- so the rounding decided
// it, always the same way, and every crossing walked the window half a MILE
// further down the road. See flipWindowSide in rrabbit.js for what replaced it:
// the ordinal is kept and only the side changes, which needs no arithmetic and
// is its own inverse. If a z ever has to be turned back into a lane again, that
// is the trap it is walking into.

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
  let z = windowZ(0, -1)
  for (const s of signs.values()) if (s.mesh && s.district === district) z = Math.min(z, s.mesh.position.z)
  return z
}

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

// WHERE A RAMP CROSSES THE WINDOW ROW, in z.
//
// The ramp leaves the tarmac at its dash and sweeps out to RAMP_OUT. Somewhere in
// between it passes through x = 180..480, which is exactly where a right-hand
// window stands -- and a window sign turned 24 degrees to the road covers about
// 122 units of z on its own. So the two want the same stretch of verge, and the
// one that was there first has to win.
//
// The band runs from a little IN FRONT of the dash -- where the ramp's own sign
// stands, beside the road at the mouth -- back through the crossing, plus a window
// sign's own depth. It grew forward when the sign moved from the far end of the ramp
// to the mouth: a board at x=300 is inside where a window stands, and the whole
// point of the sign being there is that you can read it.
//
// It is deliberately NARROWER THAN A MILE, so a ramp costs at most one window slot
// on its side. A wider band would be tidier to draw and would quietly evict two
// windows for one exit.
const RAMP_BAND_FRONT = 130
const RAMP_BAND_BACK = 520

export function rampBandsOf(district) {
  return rampsOf(district).map((r) => {
    const z0 = dashZ(r.at)
    return { at: r.at, side: r.side > 0 ? 1 : -1, from: z0 - RAMP_BAND_BACK, to: z0 + RAMP_BAND_FRONT }
  })
}

// Would a window standing at this ordinal be in a ramp's way?
//
// A RAMP ONLY RESERVES ITS OWN SIDE. Ramps can leave either way now, so the side
// is no longer a constant of the feature -- and a ramp going left must not evict a
// window on the right, which is 660 units away across the tarmac and cannot be in
// the way of anything.
export function rampBlocksLane(district, side, laneIndex) {
  const s = side > 0 ? 1 : -1
  const z = windowZ(laneIndex, s)
  return rampBandsOf(district).some((b) => b.side === s && z >= b.from && z <= b.to)
}

// And the same question from the other end: is this dash clear of the windows
// already standing there, on the side the ramp would leave by? Asked by the ramp
// planner, so it can offer a slot that will not be built into the side of a window.
export function windowsBlockDash(district, at, side = 1) {
  const s = side > 0 ? 1 : -1
  const z0 = dashZ(at)
  for (const sign of signs.values()) {
    if (!sign.mesh || sign.district !== district) continue
    if ((sign.side > 0 ? 1 : -1) !== s) continue
    const z = windowZ(sign.lane, sign.side)
    if (z >= z0 - RAMP_BAND_BACK && z <= z0 + RAMP_BAND_FRONT) return true
  }
  return false
}

export const exitZOf = (district) => Math.min(lastWindowZ(district), lastRampZ(district)) - GATE_GAP

// How many dashes a road needs: enough to run past its own exit gate, and never
// fewer than enough to carry its furthest ramp. Capped, because the count is a
// per-frame reconciliation and an absurd road should cost an absurd road's worth
// of quads and no more.
export const DASH_MAX = 96
export function dashCount(district) {
  const reach = Math.min(exitZOf(district) - GATE_GAP / 2, dashZ(8))
  return Math.min(DASH_MAX, Math.ceil((DASH_0_Z - reach) / DASH_PITCH) + 1)
}

// EVERY WINDOW ON A ROAD, in the order you drive past them.
//
// Both sides interleaved, because that is the order the road presents them in --
// the sides are separate for SPACING and were never separate for "where am I in
// the queue". Out here rather than in either personality because all three
// callers need the same answer and a second copy of the sort is a second copy
// that can disagree: RRABBIT moves windows along it, Travel steps between them
// with the (prev) / (next) controls, and the map lists them in it.
export const roadOrder = (district) =>
  [...signs.values()]
    .filter((s) => s.mesh && s.district === district)
    .sort((a, b) => windowZ(b.lane, b.side) - windowZ(a.lane, a.side))

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
  for (const s of order) if (windowZ(s.lane, s.side) >= camZ) n++
  return n
}

// How far ahead of you a gantry sits when you stop in front of it. Measured, not
// chosen: at 320 units the 58-degree frustum is only 355 units tall about y=105
// and a beam at y=300 is clipped off the top of the frame; at 440 the frustum is
// 488 tall and the whole structure is in shot.
export const GANTRY_VIEW = 440

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
  glErrors: 0,
  lastGlError: 0,
  lastGlErrorFrame: 0,
  sessionId: null,
  // M2
  mode: 'driving', // driving | flying | flat
  flatMilepost: null,
  flatDistrict: null,
  // Non-zero exactly when the flattened window is NOT pixel-exact, which is the
  // only honest way to read a zoom that is now remembered per window.
  flatZoom: 0,
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
  spawnWindow: null, // () => boolean -- open a window on the road you are on
  // (district, milepost) => asked -- ask the client to close itself. Travel owns
  // the click on the `X--` control and RRABBIT owns the surface, and Travel
  // cannot import RRABBIT (RRABBIT imports Travel, for release()). Same shape
  // and same reason as spawnWindow.
  closeWindow: null,
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
}

// Which side of the road the next adopted window stands on.
//
// A FIFO rather than a single slot: two clicks on "open window ‹ left" and then
// "open window right" must not both land on the right because the second click
// overwrote the first before either surface arrived. Adoption order is not
// guaranteed to match launch order, so a burst can still cross them over -- what
// this guarantees is that the SIDES REQUESTED are the sides used.
export const sideQueue = []

// A slot in the flat output. The ledger is a grid, one cell per window, so no
// two windows share a rect and `pickView` can resolve a point to a window on
// position alone.
export const ledgerSlot = (i) => ({
  x: (i % LEDGER_COLS) * LEDGER_PITCH,
  y: Math.floor(i / LEDGER_COLS) * LEDGER_PITCH,
})

export const keyOf = (view) => `${view.surface.resource.client.id}:${view.surface.resource.id}`
