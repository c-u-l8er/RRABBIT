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

// Spacing between mileposts. RAVIO measured its way to S=300 for a change feed
// of 15-25 rows/hour against a road passing 1800 signs/hour. Windows invert
// that problem -- there are 5-30 of them, not thousands -- so this is NOT
// RAVIO's S and must not be assumed to transfer (spec §7).
export const MILE = 260
export const SCENE_ID = 'road'

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

// A slot in the flat output. The ledger is a grid, one cell per window, so no
// two windows share a rect and `pickView` can resolve a point to a window on
// position alone.
export const ledgerSlot = (i) => ({
  x: (i % LEDGER_COLS) * LEDGER_PITCH,
  y: Math.floor(i / LEDGER_COLS) * LEDGER_PITCH,
})

export const keyOf = (view) => `${view.surface.resource.client.id}:${view.surface.resource.id}`
