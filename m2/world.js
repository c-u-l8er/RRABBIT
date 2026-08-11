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

import { root as workspaceRoot } from './workspaces.js'

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

// The exit gate stands one clear run past the LAST window on a road -- read off
// the signs actually standing there rather than computed from a count, because
// the two sides advance independently and neither one's ordinal knows how far
// down the road the other has got.
//
// An empty road still has an exit gate: a workspace with nothing in it is still
// somewhere you can leave.
export function lastWindowZ(district) {
  let z = windowZ(0, -1)
  for (const s of signs.values()) if (s.mesh && s.district === district) z = Math.min(z, s.mesh.position.z)
  return z
}

export const exitZOf = (district) => lastWindowZ(district) - GATE_GAP

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
