// A PANE THAT STANDS ON A ROAD AND IS NOT A PROCESS.
//
// Every window on a road until now has been a live Wayland client: a process, an
// EGL image, a video decode, a WebGLRenderTarget and a depth texture. That is the
// cost class that caps the shell at dozens of windows, and it is the right cost for
// a running application. It is the wrong cost for a document.
//
// `ramps.js` has always built the other kind of road object -- a canvas the shell
// paints, hung on a mesh, with nothing behind it. This module is that mechanism
// pointed at BendScript and Runefort documents. See docs/PAPER_ROADS.md for the
// measurement that makes it worth doing: a `.bend` file is 1,067 bytes on average
// across bendscript.com's own corpus, against ~3 MB of VRAM for one window's colour
// target alone.
//
// THE LAYOUT IS NOT IN THIS FILE, and that is the arrangement that made the work
// testable. `paper/bend-layout.js` and `paper/rune-layout.js` have no THREE and no
// DOM, so `node test/*.mjs` runs 204 assertions on a dev host that cannot open a GL
// context. What is here is the part that genuinely needs the scene, and it is thin
// on purpose.
//
// A PANE IS A THIRD SLOT OCCUPANT. `world.js` `papers` is the registry and
// `slotAt`/`slotFree` consult it, so a window cannot be placed on top of a pane.
// Without that the collision would not read as "the slot table is incomplete", it
// would read as a document that vanished.

import * as THREE from 'three'
import { canvasTexture, papers, dashZ, slotFree, nextFreeSlot, state, DASH_MAX } from './world.js'
import * as ws from './workspaces.js'
import { layoutBend, cardOf, THEME } from './paper/bend-layout.js'
import { layoutRune, floorsOf, RUNE_THEME } from './paper/rune-layout.js'
import { paint, paintCard, measurerFor } from './paper/paint.js'

let scene = null
export function attachPaper(c) {
  scene = c.scene
}

// Pixels of canvas. The pane is drawn once at this size and mapped onto a quad --
// the world size below is independent, so a pane can be made physically bigger
// without re-laying-out its text.
const PX_W = 640
const PX_H = 420
// World units. Matched to the window signs beside them (rrabbit.js builds those
// from the surface size) so a road carrying both does not read as two scales.
const W = 300
const H = 197
const ROAD_Y = -30
const STAND_X = 190
const STAND_Y = 34

const keyOf = (district, side, dash) => `${district}:${side > 0 ? 'r' : 'l'}:${dash}`

// ---- painting ---------------------------------------------------------------

// The full read of a document. Returns what the layout reported so a caller can
// see overflow and truncation rather than only the pixels.
function repaint(p) {
  const ctx = p.canvas.getContext('2d')
  const measure = measurerFor(ctx)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, PX_W, PX_H)

  let r
  if (p.format === 'rune') {
    r = layoutRune(p.doc, { width: PX_W, height: PX_H, measure, theme: RUNE_THEME })
  } else {
    r = layoutBend(p.doc, { width: PX_W, height: PX_H, measure, theme: THEME, resolve: p.resolve })
  }
  paint(ctx, r.commands)

  // OVERFLOW IS DRAWN, not only reported. A pane that runs out of box and stops
  // looks exactly like a document that was that short, and on a road you cannot
  // scroll to find out. A rule and a count is the smallest honest mark.
  if (r.overflow) {
    ctx.fillStyle = '#e2564d'
    ctx.fillRect(0, PX_H - 3, PX_W, 3)
    ctx.font = '11px ui-monospace, monospace'
    ctx.fillText('more below', 10, PX_H - 8)
  }

  p.tex.needsUpdate = true
  p.last = r
  return r
}

function paintAsCard(p) {
  const ctx = p.canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  paintCard(ctx, p.card, { width: PX_W, height: PX_H, theme: THEME })
  p.tex.needsUpdate = true
}

// ---- placing ----------------------------------------------------------------

function build(p) {
  p.canvas = document.createElement('canvas')
  p.canvas.width = PX_W
  p.canvas.height = PX_H
  // Not a bare CanvasTexture -- 640x420 is not a power of two and the pane
  // repaints when its tier changes. Same reason ramps.js gives.
  p.tex = canvasTexture(THREE, p.canvas)

  p.mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({ map: p.tex, toneMapped: false }),
  )
  // Turned in toward the driver, the same way and for the same reason a ramp board
  // and a window sign are: a pane square to the road is edge-on until you are level
  // with it, and by then you have driven past what it says.
  p.mesh.rotation.y = -p.side * 0.42
  p.mesh.userData.paperKey = p.key

  p.frame = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 10, H + 10),
    new THREE.MeshBasicMaterial({ color: 0x2de2e6 }),
  )
  p.frame.rotation.y = p.mesh.rotation.y

  p.post = new THREE.Mesh(
    new THREE.BoxGeometry(6, STAND_Y + H / 2, 6),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 }),
  )

  scene.add(p.frame)
  scene.add(p.mesh)
  scene.add(p.post)
  position(p)
}

function position(p) {
  const x = ws.laneX(p.district) + p.side * STAND_X
  const z = dashZ(p.dash)
  const y = ROAD_Y + STAND_Y + H / 2
  p.mesh.position.set(x, y, z)
  // Half a unit behind the pane along its own normal, so the border does not
  // z-fight with the document it is framing.
  p.frame.position.set(x + p.side * 0.5, y, z - 0.5)
  p.post.position.set(x, ROAD_Y + (STAND_Y + H / 2) / 2, z)
}

// Put a document on a road. Returns the pane, or null with a reason -- never a
// silent no-op, because "nothing appeared" is the one outcome that cannot be
// debugged from the outside.
export function placePaper(doc, { district = state.district, side = 1, dash = null, format = 'bend', resolve } = {}) {
  if (!scene) return { ok: false, why: 'PAPER_NO_SCENE' }
  if (!doc || typeof doc !== 'object') return { ok: false, why: 'PAPER_NO_DOC' }
  if (!ws.has(district)) return { ok: false, why: 'PAPER_NO_ROAD' }

  const s = side > 0 ? 1 : -1
  let at = dash
  if (at == null) at = nextFreeSlot(district, s, 0, 'window')
  else if (!slotFree(district, s, at, 'window')) at = null
  if (at == null || at >= DASH_MAX) return { ok: false, why: 'PAPER_NO_SLOT' }

  const key = keyOf(district, s, at)
  if (papers.has(key)) return { ok: false, why: 'PAPER_SLOT_TAKEN' }

  const p = {
    key, district, side: s, dash: at, format, doc, resolve,
    card: format === 'rune'
      ? { title: doc.label || doc.id || '(floor)', blocks: doc.rooms?.length ?? 0, edges: doc.neighbors?.length ?? 0, vocabulary: 'runefort' }
      : cardOf(doc),
    tier: null, canvas: null, tex: null, mesh: null, frame: null, post: null, last: null,
  }
  papers.set(key, p)
  build(p)
  // Painted at its tier by the next sync rather than here, so there is exactly one
  // place that decides what a pane is showing.
  syncPaper()
  return { ok: true, paper: p, dash: at, side: s }
}

export function removePaper(key) {
  const p = papers.get(key)
  if (!p) return false
  for (const m of [p.mesh, p.frame, p.post]) {
    if (!m) continue
    scene.remove(m)
    m.geometry?.dispose?.()
    m.material?.dispose?.()
  }
  p.tex?.dispose?.()
  papers.delete(key)
  return true
}

export function clearPapers() {
  for (const k of [...papers.keys()]) removePaper(k)
}

// ---- the tiers (PAPER_ROADS.md §5) ------------------------------------------

// How far up the road a pane is readable. Measured against the window signs
// already on the road rather than chosen: past roughly this distance a 15px line
// on a 300-unit quad is under a pixel tall on screen and the paint tier is drawing
// detail nobody can resolve.
const READ_Z = 1500

// Reconcile every pane with where the camera is. THIS IS THE CULLING SEED: a pane
// on another road is hidden outright, and a pane far up this one is downgraded to
// a card. Both are decisions about what to DRAW, not about what to keep -- the
// document stays in `papers` either way, which is what makes the cheap tier cheap.
export function syncPaper() {
  const camZ = 260 + (state.roadZ ?? 0)
  for (const p of papers.values()) {
    const here = p.district === state.district
    const vis = here && !state.overview
    for (const m of [p.mesh, p.frame, p.post]) if (m) m.visible = vis
    if (!vis) continue

    const want = Math.abs(dashZ(p.dash) - camZ) < READ_Z ? 'paint' : 'card'
    if (want === p.tier) continue
    p.tier = want
    if (want === 'paint') repaint(p)
    else paintAsCard(p)
  }
}

// Raycast targets, for travel.js's pointer pass. Same shape as `rampMeshes`.
export function paperMeshes() {
  const out = []
  for (const p of papers.values()) if (p.mesh?.visible) out.push(p.mesh)
  return out
}

export const paperAt = (hit) => papers.get(hit?.object?.userData?.paperKey) ?? null

// ---- the report --------------------------------------------------------------

// `window.__papers()`. Every number a claim about panes needs, and the tier
// breakdown in particular -- "there are 40 panes" and "40 panes are being laid out
// every frame" are different facts and only the second one is a cost.
export const paperReport = () => ({
  count: papers.size,
  byTier: [...papers.values()].reduce((a, p) => ((a[p.tier ?? 'unbuilt'] = (a[p.tier ?? 'unbuilt'] ?? 0) + 1), a), {}),
  byDistrict: [...papers.values()].reduce((a, p) => ((a[p.district] = (a[p.district] ?? 0) + 1), a), {}),
  visible: [...papers.values()].filter((p) => p.mesh?.visible).length,
  overflowing: [...papers.values()].filter((p) => p.last?.overflow).length,
  truncated: [...papers.values()].filter((p) => p.last?.truncated).length,
  panes: [...papers.values()].map((p) => ({
    key: p.key, format: p.format, tier: p.tier, dash: p.dash,
    title: p.card.title, cmds: p.last?.commands.length ?? 0,
    overflow: !!p.last?.overflow, stats: p.last?.stats ?? null,
  })),
})

// ---- the demo seed -----------------------------------------------------------

// Places the bundled samples on the road you are standing on. This is a DEMO, not
// a store: rung 5 in docs/PAPER_ROADS.md is where documents come from somewhere.
// Exposed as `window.__seedPapers()` rather than run at startup, because a shell
// that silently invents road furniture is a shell you cannot get a clean reading
// from.
export async function seedPapers(district = state.district) {
  const { BEND, FORT } = await import('./paper/samples.js')
  const placed = []
  let side = 1
  for (const doc of BEND) {
    placed.push(placePaper(doc, { district, side, format: 'bend' }))
    side = -side
  }
  for (const floor of floorsOf(FORT).slice(0, 2)) {
    placed.push(placePaper(floor, { district, side, format: 'rune' }))
    side = -side
  }
  return { placed: placed.filter((r) => r.ok).length, refused: placed.filter((r) => !r.ok).map((r) => r.why) }
}
