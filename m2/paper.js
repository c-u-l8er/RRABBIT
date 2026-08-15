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
// context. What is here is the part that genuinely needs the scene.
//
// NOTHING EXPENSIVE IS ALLOCATED UNTIL A TIER ASKS FOR IT. The first version built
// a 640x420 canvas in `build()` for every pane -- ~1.07 MB of backing store each,
// whether or not the pane would ever be close enough to read. A thousand panes was
// a gigabyte of canvas before the first frame, and the CARD tier, whose whole
// purpose is to be the cheap one, was paying the read tier's price. Now:
//
//   paint tier -- own canvas, own texture, own material. Released on downgrade.
//   card tier  -- a cell in the shared atlas. One texture and one material per 96.
//   hidden     -- neither. A pane on another road holds no pixels at all.
//
// and the post, the frame and their materials are shared across every pane, because
// they are identical and N copies of an identical box is N geometries for one
// shape.
//
// A PANE IS A THIRD SLOT OCCUPANT. `world.js` `papers` is the registry and
// `slotAt`/`slotFree` consult it, so a window cannot be placed on top of a pane.
// Without that the collision would not read as "the slot table is incomplete", it
// would read as a document that vanished.

import * as THREE from 'three'
import { canvasTexture, papers, dashZ, slotFree, nextFreeSlot, state, DASH_MAX, hooks } from './world.js'
import * as ws from './workspaces.js'
import { layoutBend, cardOf, THEME } from './paper/bend-layout.js'
import { layoutRune, floorsOf, RUNE_THEME } from './paper/rune-layout.js'
import { paint, paintCard, measurerFor } from './paper/paint.js'
import { allocCard, freeCard, drawCard, planeFor, atlasReport, CARD_W, CARD_H } from './paper/atlas.js'
import { openRead, closeRead, readingKey, isReading, readingPane } from './paper/read.js'
import { grabTexture, castTexture, closeTexture, GRIP_W, GRIP_H, GRIP_REACH, PAD } from './rrabbit.js'
import { register as registerOp, apply as applyOp } from './ops.js'

let scene = null
export function attachPaper(c) {
  scene = c.scene
}

// Pixels of canvas at the paint tier. The pane is laid out once at this size and
// mapped onto a quad -- the world size below is independent, so a pane can be made
// physically bigger without re-laying-out its text.
const PX_W = 640
const PX_H = 420
// World units, and now a DEFAULT rather than a constant -- a pane can be resized.
// See `sizeOf`: the geometry is still shared, but keyed by size instead of being
// one object, so the sharing survives a road whose panes are not all the same.
const W = 300
const H = 197
const MIN_W = 150
const MAX_W = 900
// The canvas is sized FROM the world size, so a bigger pane lays the document out
// wider rather than magnifying the same layout. That is the difference between
// resizing a document and zooming a picture of one, and it is the whole reason
// resize is worth having on a pane at all.
const PX_PER_UNIT = PX_W / W
const sizeOf = (p) => ({ w: p.w ?? W, h: p.h ?? H })
const ROAD_Y = -30
const STAND_X = 190
const STAND_Y = 34

const keyOf = (district, side, dash) => `${district}:${side > 0 ? 'r' : 'l'}:${dash}`

// ---- the shared furniture ---------------------------------------------------
//
// Built once, on first use. Every pane's post is the same box and every pane's
// frame is the same quad, so N panes is one geometry each and not N.
let postGeo = null, postMat = null, frameMat = null, askMat = null
// Keyed by `${w}x${h}`: panes of the same size still share one geometry, which is
// the property rung 4 measured, and a resized pane costs one more entry rather
// than forcing every pane to own its own.
const planeCache = new Map()
function planeGeo(w, h) {
  const k = `${w}x${h}`
  let g = planeCache.get(k)
  if (!g) planeCache.set(k, (g = new THREE.PlaneGeometry(w, h)))
  return g
}
function shared() {
  if (postGeo) return
  // STAND_Y, NOT STAND_Y + H/2. The post runs from the road to the pane's BOTTOM
  // EDGE; the taller version put its top at the pane's CENTRE, so 98 units of post
  // stood up through the middle of every document. Reported as "the post is
  // sticking through the screen", which is exactly what it was.
  postGeo = new THREE.BoxGeometry(6, STAND_Y, 6)
  postMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 })
  frameMat = new THREE.MeshBasicMaterial({ color: 0x2de2e6 })
  // The frame while a close is being asked about. A question nobody can see is a
  // control that did nothing the first time you pressed it.
  askMat = new THREE.MeshBasicMaterial({ color: 0xe2564d })
}

// ---- painting ---------------------------------------------------------------

function layoutOf(p, width, height, measure) {
  return p.format === 'rune'
    ? layoutRune(p.doc, { width, height, measure, theme: RUNE_THEME })
    : layoutBend(p.doc, { width, height, measure, theme: THEME, resolve: p.resolve })
}

function ensurePaint(p) {
  if (p.paintMesh) return
  shared()
  const { w, h } = sizeOf(p)
  const px = Math.round(w * PX_PER_UNIT)
  const py = Math.round(h * PX_PER_UNIT)
  p.canvas = document.createElement('canvas')
  p.canvas.width = px
  p.canvas.height = py
  // Not a bare CanvasTexture -- 640x420 is not a power of two and the pane
  // repaints when its tier changes. Same reason ramps.js gives.
  p.tex = canvasTexture(THREE, p.canvas)
  p.mat = new THREE.MeshBasicMaterial({ map: p.tex, toneMapped: false })

  const ctx = p.canvas.getContext('2d')
  // Laid out AT THE PANE'S SIZE. A bigger pane fits more of the document rather
  // than magnifying the same page, which is what makes resize mean something for a
  // document instead of being a zoom with extra steps.
  const r = layoutOf(p, px, py, measurerFor(ctx))
  paint(ctx, r.commands)

  // OVERFLOW IS DRAWN, not only reported. A pane that runs out of box and stops
  // looks exactly like a document that was that short, and on a road you cannot
  // scroll to find out.
  if (r.overflow) {
    ctx.fillStyle = '#e2564d'
    ctx.fillRect(0, py - 3, px, 3)
    ctx.font = '11px ui-monospace, monospace'
    ctx.fillText('more below', 10, py - 8)
  }
  p.tex.needsUpdate = true
  p.last = r
  // The TV letterboxes on `size`, so a pane on air has to answer the same question
  // a window does. Duck-typed rather than wrapped: broadcast.js reads `tex` and
  // `size` and nothing else, and a wrapper would be a second thing to keep true.
  p.size = { width: px, height: py }

  p.paintMesh = new THREE.Mesh(planeGeo(w, h), p.mat)
  p.paintMesh.rotation.y = -p.side * 0.42
  p.paintMesh.userData.paperKey = p.key
  scene.add(p.paintMesh)
  placeMesh(p, p.paintMesh)
}

function releasePaint(p) {
  if (!p.paintMesh) return
  scene.remove(p.paintMesh)
  // The GEOMETRY is shared and must not be disposed. The material and texture are
  // this pane's own and must be -- that asymmetry is the whole reason the two are
  // separated above.
  p.mat?.dispose?.()
  p.tex?.dispose?.()
  p.paintMesh = null
  p.mat = null
  p.tex = null
  p.canvas = null
}

function ensureCard(p) {
  if (p.cardMesh) return
  shared()
  p.cell = allocCard()
  drawCard(p.cell, (ctx, w, h) => paintCard(ctx, p.card, { width: w, height: h, theme: THEME }))
  { const { w, h } = sizeOf(p); p.cardGeo = planeFor(THREE, w, h, p.cell.uv) }
  p.cardMesh = new THREE.Mesh(p.cardGeo, p.cell.material)
  p.cardMesh.rotation.y = -p.side * 0.42
  p.cardMesh.userData.paperKey = p.key
  scene.add(p.cardMesh)
  placeMesh(p, p.cardMesh)
}

function releaseCard(p) {
  if (!p.cardMesh) return
  scene.remove(p.cardMesh)
  // The geometry carries this pane's atlas rect so it IS its own; the material
  // belongs to the atlas page and must be left alone.
  p.cardGeo?.dispose?.()
  freeCard(p.cell)
  p.cardMesh = null
  p.cardGeo = null
  p.cell = null
}

// ---- placing ----------------------------------------------------------------

function placeMesh(p, m) {
  const x = ws.laneX(p.district) + p.side * STAND_X
  const z = dashZ(p.dash)
  m.position.set(x, ROAD_Y + STAND_Y + H / 2, z)
}

// Where the read tier's DOM object stands: exactly where the quad it replaces
// does. The CSS3D layer has its own scene and its own renderer but the SAME
// camera, so a pose in world units is all it needs -- and using the quad's pose
// rather than a fresh one is what makes reading a pane continuous with driving
// past it instead of a modal that replaces the world.
function readPoseOf(p) {
  const x = ws.laneX(p.district) + p.side * STAND_X
  return {
    position: new THREE.Vector3(x, ROAD_Y + STAND_Y + H / 2, dashZ(p.dash)),
    rotation: new THREE.Euler(0, -p.side * 0.42, 0),
  }
}

// A PANE IS A RECORD UNTIL IT IS ON SCREEN.
//
// The first version added a frame and a post to the scene in `build()` for every
// pane the moment it was placed, hidden or not. At the four hundred rung 4 sweeps
// that is 800 objects; at the ten thousand this rung is about it is TWENTY
// THOUSAND, and three.js visits every one of them per frame to discover it is
// invisible. `visible = false` skips the draw, not the walk.
//
// So nothing enters the scene graph until a tier asks for it, and everything
// leaves when the tier goes back to `hidden`. A pane that is not on your road now
// costs one JS object and its document, and nothing else at all.
function materialize(p) {
  if (p.frame) return
  shared()
  const { w, h } = sizeOf(p)
  p.frame = new THREE.Mesh(planeGeo(w + 10, h + 10), frameMat)
  p.frame.rotation.y = -p.side * 0.42
  addChrome(p, w, h)
  p.post = new THREE.Mesh(postGeo, postMat)

  const x = ws.laneX(p.district) + p.side * STAND_X
  const z = dashZ(p.dash)
  // Half a unit behind the pane along its own normal, so the border does not
  // z-fight with the document it is framing.
  p.frame.position.set(x + p.side * 0.5, ROAD_Y + STAND_Y + H / 2, z - 0.5)
  p.post.position.set(x, ROAD_Y + STAND_Y / 2, z)
  scene.add(p.frame)
  scene.add(p.post)
}

// THE SAME CONTROLS A WINDOW HAS, in the same corners, at the same size and the
// same distance out -- `X--` top-left, `--&` bottom-left, the resize grab
// top-right. The glyph textures and the geometry constants are imported from
// rrabbit.js rather than redrawn, because a pane whose close button is a different
// mark from a window's close button is a second thing to learn for no reason.
//
// PARENTED TO THE FRAME, not to the tier mesh: the tier mesh is destroyed and
// rebuilt every time a pane crosses a tier boundary, and chrome that had to be
// re-added on each crossing would be chrome that is missing for one frame every
// time you drive past.
//
// WHOLLY OUTSIDE THE PANE, which is the rule rrabbit.js established for a client's
// surface and which holds here for a different reason: a control drawn over a
// document covers a word.
function addChrome(p, w, h) {
  const put = (tex, rot, x, y, data) => {
    const btn = new THREE.Mesh(
      planeGeo(GRIP_W, GRIP_H),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
    )
    btn.rotation.z = rot
    btn.position.set(x, y, 3)
    Object.assign(btn.userData, data, { chrome: true, paperKey: p.key })
    // HIDDEN UNTIL THE PANE IS CLOSE ENOUGH TO AIM AT, the rule rrabbit.js set for
    // a window's controls. A control on a card two hundred units up the road is a
    // fleck that does something, and every pointer path here has to be able to say
    // what it hit.
    btn.visible = false
    p.frame.add(btn)
    // The hit area is bigger than the mark and reaches FURTHER OUT, never further
    // in -- an invisible target over the document eats a click meant for a link.
    const pad = new THREE.Mesh(planeGeo(PAD, PAD), new THREE.MeshBasicMaterial({ visible: false }))
    pad.position.set(x < 0 ? -(w / 2 + PAD / 2) : w / 2 + PAD / 2, y < 0 ? -(h / 2 + PAD / 2) : h / 2 + PAD / 2, 3)
    Object.assign(pad.userData, data, { chrome: true, paperKey: p.key })
    p.frame.add(pad)
    return [btn, pad]
  }

  p.chrome = [
    ...put(closeTexture(), -Math.PI / 4, -(w / 2 + GRIP_REACH), h / 2 + GRIP_REACH, { paperClose: true }),
    ...put(castTexture(), Math.PI / 4, -(w / 2 + GRIP_REACH), -(h / 2 + GRIP_REACH), { paperCast: true }),
    ...put(grabTexture(), Math.PI / 4, w / 2 + GRIP_REACH, h / 2 + GRIP_REACH, { paperResize: true }),
  ]
}

function dematerialize(p) {
  if (!p.frame) return
  p.chrome = null
  scene.remove(p.frame)
  scene.remove(p.post)
  // Geometry and material are SHARED across every pane and must not be disposed
  // here -- disposing them would take the next pane's furniture with it.
  p.frame = null
  p.post = null
}

// Put a document on a road. Returns the pane, or a reason -- never a silent no-op,
// because "nothing appeared" is the one outcome that cannot be debugged from the
// outside.
export function placePaper(doc, { district = state.district, side = 1, dash = null, format = 'bend', resolve, unslotted = false } = {}) {
  if (!scene) return { ok: false, why: 'PAPER_NO_SCENE' }
  if (!doc || typeof doc !== 'object') return { ok: false, why: 'PAPER_NO_DOC' }
  if (!ws.has(district)) return { ok: false, why: 'PAPER_NO_ROAD' }

  const s = side > 0 ? 1 : -1
  let at = dash
  // `unslotted` is the BENCH's path and nothing else's: a measurement of what N
  // panes cost to draw must not be capped at the ~23 slots a road's spacing rule
  // allows. It is named rather than inferred so it can never be reached by
  // accident, and a pane placed this way is still a real pane in every other way.
  if (!unslotted) {
    if (at == null) at = nextFreeSlot(district, s, 0, 'window')
    else if (!slotFree(district, s, at, 'window')) at = null
    if (at == null || at >= DASH_MAX) return { ok: false, why: 'PAPER_NO_SLOT' }
  } else if (!Number.isFinite(at)) {
    return { ok: false, why: 'PAPER_NO_DASH' }
  }
  // FRACTIONAL dashes are legal on the unslotted path and only there. `dashZ` is
  // arithmetic and takes any number, and `slotFree` already skips occupants whose
  // dash is not an integer -- so a bench pane at 8.25 cannot block a real window,
  // which is exactly the property that makes packing 400 of them harmless.

  const key = keyOf(district, s, at)
  if (papers.has(key)) return { ok: false, why: 'PAPER_SLOT_TAKEN' }

  const p = {
    key, district, side: s, dash: at, format, doc, resolve,
    card: format === 'rune'
      ? { title: doc.label || doc.id || '(floor)', blocks: doc.rooms?.length ?? 0, edges: doc.neighbors?.length ?? 0, vocabulary: 'runefort' }
      : cardOf(doc),
    tier: null, canvas: null, tex: null, mat: null, cell: null,
    paintMesh: null, cardMesh: null, cardGeo: null, frame: null, post: null, last: null,
  }
  papers.set(key, p)
  // No scene objects yet. `syncPaper` materialises it if and when it is on screen,
  // which is what makes placing ten thousand of them cheap.
  return { ok: true, paper: p, dash: at, side: s }
}

export function removePaper(key) {
  const p = papers.get(key)
  if (!p) return false
  releasePaint(p)
  releaseCard(p)
  dematerialize(p)
  papers.delete(key)
  return true
}

export function clearPapers() {
  for (const k of [...papers.keys()]) removePaper(k)
}

// ---- the tiers (PAPER_ROADS.md §5) ------------------------------------------

// How far up the road a pane is readable. Past roughly this distance a 15px line
// on a 300-unit quad is under a pixel tall on screen and the paint tier is drawing
// detail nobody can resolve.
const READ_Z = 1500
// Past this a pane is not drawn at all. A card is cheap; it is not free, and a
// road can be longer than anyone can see down.
const KEEP_Z = 9000
// How many panes may hold a canvas at once, regardless of how many are close
// enough to qualify. See the second pass in `syncPaper` for the measurement that
// set it: this is a frame-budget cap, not a view-distance one.
const PAINT_MAX = 24

// Reconcile every pane with where the camera is. THIS IS THE CULLING: a pane on
// another road holds no pixels, a pane far up this one is a card, and only what is
// close is laid out. All three are decisions about what to DRAW -- the document
// stays in `papers` either way, which is what makes the cheap tiers cheap.
export function syncPaper() {
  // Entering a road is what triggers a chunk load. Checked here rather than hooked
  // to a navigation event because every path that changes `state.district` -- the
  // gates, the map, a replay, a track switch -- lands in this loop on the next
  // frame anyway, and one check beats five call sites that must each remember.
  if (store && state.district !== resident) streamDistrict(state.district)

  const camZ = 260 + (state.roadZ ?? 0)

  // FIRST PASS: distance, and the two tiers distance alone can decide.
  const near = []
  for (const p of papers.values()) {
    const here = p.district === state.district && !state.overview
    const d = Math.abs(dashZ(p.dash) - camZ)
    p.dist = d
    if (!here || d > KEEP_Z) p.want = 'hidden'
    else if (d >= READ_Z) p.want = 'card'
    else { p.want = 'paint'; near.push(p) }
  }

  // SECOND PASS: the paint budget.
  //
  // MEASURED, and the reason this pass exists. With distance as the only criterion
  // a 500-pane road put 128 documents at the paint tier at once -- 128 canvases,
  // 128 textures, 128 materials -- and the best-case frame went from 17 ms to
  // 33 ms. The bound held (canvases tracked what was in view, not the corpus) and
  // the bound was still too loose: READ_Z asks "could this be read from here",
  // which at a shallow angle down a long road is true of far more panes than
  // anyone is actually reading.
  //
  // So distance decides eligibility and COUNT decides the tier. The nearest
  // PAINT_MAX are laid out; everything else in range is a card, which it was
  // going to look like at that distance anyway.
  if (near.length > PAINT_MAX) {
    near.sort((a, b) => a.dist - b.dist)
    for (let i = PAINT_MAX; i < near.length; i++) near[i].want = 'card'
  }

  // A PANE BEING READ IS NEVER RETIERED. Driving away from one would otherwise
  // release the canvas under a DOM object that is still on screen, and the reader
  // would be left holding a document whose backing had been collected.
  const held = readingKey()
  for (const p of papers.values()) {
    // A PANE BEING READ OR BROADCAST IS NEVER RETIERED.
    //
    // The read case is obvious -- releasing the canvas under a mounted DOM object
    // strands the reader. The BROADCAST case was measured and is the opposite of
    // obvious: an on-air pane whose tier was allowed to fall released its texture,
    // the shell correctly took it off air, and the TV went back to the default
    // panel. Correct by the rule and useless in practice, because watching a pane
    // WHILE DRIVING AWAY FROM IT is the entire reason to cast one. Casting pins the
    // paint tier for exactly as long as the pane is on air.
    if ((held && p.key === held) || p.key === castKey) continue
    if (p.want === p.tier) continue
    p.tier = p.want
    if (p.want === 'paint') { releaseCard(p); materialize(p); ensurePaint(p) }
    else if (p.want === 'card') { releasePaint(p); materialize(p); ensureCard(p) }
    else { releasePaint(p); releaseCard(p); dematerialize(p) }
    // Chrome visibility is NOT a tier question -- see `refreshChrome`. Newly built
    // chrome starts hidden and the hover rule turns it on.
  }
}

// ---- district streaming (rung 5) --------------------------------------------
//
// A DISTRICT IS THE CHUNK, and the workspace graph already drew the boundaries --
// you are always standing in exactly one, and its exits are its neighbours. So
// streaming is not a spatial grid laid over the world; it is the partition the
// world already had.
//
// Entering a district loads its records and leaves every other district's panes
// unbuilt. That is what keeps `papers` -- and therefore the per-frame loop in
// `syncPaper` -- proportional to the road you are on rather than to the corpus.

// The pane on air, by key. Held here rather than read back from the shell because
// `syncPaper` consults it every frame and a hook call per pane per frame to ask
// "are you on television" is a cost with no payer.
let castKey = null
// WHICH PANE THE POINTER IS OVER. Fed by travel.js's pointermove, which owns the
// pointer and already runs one raycast for everything on the road.
let hoverKey = null

// Reported: "the controls should only be showing up when it is in this detailed
// view and only on hover mouse". Two conditions, and both are needed for the same
// reason rrabbit.js gives for a window's chrome: a control on a pane you are
// driving past is a fleck that does something, and a control drawn permanently on
// the pane you ARE reading is clutter over a document.
//
// So: the pane must be the one being read, AND the pointer must be on it.
export function setPaperHover(key) {
  // Pointing somewhere else withdraws the question. A close ask that outlived the
  // pointer would make the NEXT press on `X--` the confirming one.
  if (key !== state.paperAsking) { state.paperAsking = null; hoverKey = key; refreshChrome(); return }
  if (key === hoverKey) return
  hoverKey = key
  refreshChrome()
}

function refreshChrome() {
  const held = readingKey()
  for (const p of papers.values()) {
    if (!p.chrome) continue
    const asking = state.paperAsking === p.key
    // The close mark stays up while the question is open, so the confirming press
    // has something to aim at even after the pointer has wandered.
    const show = !!held && p.key === held && (p.key === hoverKey || asking)
    for (const m of p.chrome) if (m.material.map) m.visible = show
    if (p.frame) p.frame.material = asking ? askMat : frameMat
  }
}

let store = null
let resident = null
let streaming = false
const streamStats = { loads: 0, lastMs: null, lastCount: null, error: null }

export function useStore(s) {
  store = s
  resident = null
}

// Bring `district` in and drop whatever was resident. Idempotent, and a no-op
// without a store so the bench and the demo seed keep working unstreamed.
export function streamDistrict(district = state.district) {
  if (!store || streaming || district === resident || !district) return false
  streaming = true
  const prev = resident
  resident = district
  const t0 = performance.now()

  // The OUTGOING district is dropped first and synchronously. Loading before
  // dropping would hold two districts at once, which is precisely the peak this
  // rung exists to avoid -- and the peak is what runs a host out of memory, not
  // the steady state.
  if (prev) for (const [k, p] of [...papers]) if (p.district === prev) removePaper(k)

  return store.chunk(district).then((recs) => {
    for (const r of recs) {
      placePaper(r.doc, { district: r.district, side: r.side, dash: r.dash, format: r.format, unslotted: true })
    }
    syncPaper()
    streamStats.loads++
    streamStats.lastMs = +(performance.now() - t0).toFixed(1)
    streamStats.lastCount = recs.length
    streamStats.error = null
    return recs.length
  }).catch((e) => {
    streamStats.error = String(e?.message ?? e)
    return 0
  }).finally(() => {
    streaming = false
  })
}

// Is a chunk load in flight? A caller that reports pane counts without asking this
// is reporting a snapshot taken mid-stream: the outgoing district's panes are
// already dropped and the incoming district's have not landed, so the honest state
// of the world reads as zero.
export const streamBusy = () => streaming
export const streamResident = () => resident

// Raycast targets, for travel.js's pointer pass. Same shape as `rampMeshes`.
export function paperMeshes() {
  const out = []
  for (const p of papers.values()) {
    const m = p.paintMesh ?? p.cardMesh
    if (m) out.push(m)
    // Only the pane being READ offers its controls for aiming. The pads are
    // invisible, so leaving them aimable on every pane would put a dead hit area
    // over documents whose controls are not drawn -- a click that lands on nothing
    // visible and does nothing is worse than no control.
    if (p.chrome && p.key === readingKey()) out.push(...p.chrome)
  }
  return out
}

// Re-exported so travel.js can ask without importing read.js -- travel already
// imports paper.js, and a second edge into the read tier would be a second thing
// to keep pointing at the right module.
export const isReadingPaper = () => isReading()
export { readingPane }

export const paperAt = (hit) => papers.get(hit?.object?.userData?.paperKey) ?? null

// ---- the ops (rung 6) --------------------------------------------------------
//
// THE ONLY WAY A PANE IS ENTERED OR LEFT. Not one path for a click and another for
// a replay -- `apply()` is the single door, and `test/ops.mjs` §3 is the assertion
// that three consumers reach the same world through it.
//
// The preconditions are TOTAL: a malformed world evaluates false, never throws
// (OP_VOCABULARY_DRAFT.md §4). They are still hand-written JS rather than the
// sealed data the draft asks for -- that is §4's open item and it is not answered
// here.
export function registerPaperOps() {
  registerOp('read', {
    pre: (op) => {
      const p = papers.get(keyOf(op.district, op.side, op.dash))
      if (!p) return 'OP_NO_PANE'
      if (p.district !== state.district) return 'OP_PANE_NOT_HERE'
      return true
    },
    perform: (op) => {
      const p = papers.get(keyOf(op.district, op.side, op.dash))
      p.readPose = readPoseOf(p)
      hooks.flyToPaper?.(p)
      // The paint tier is ensured UNDER it only when it is not already there.
      // Forcing it unconditionally re-laid the document out on every click, which
      // is half of the reported "they rerender when I click on them" -- the other
      // half was the DOM tier laying out at a different width (see read.js).
      if (p.tier !== 'paint') { releaseCard(p); materialize(p); ensurePaint(p); p.tier = 'paint' }
      else materialize(p)
      const r = openRead(p)
      refreshChrome()
      return r
    },
  })
  registerOp('unread', { pre: () => true, perform: () => { closeRead(); refreshChrome(); return { ok: true } } })

  const paneAt = (op) => papers.get(keyOf(op.district, op.side, op.dash)) ?? null

  registerOp('close', {
    pre: (op) => (paneAt(op) ? true : 'OP_NO_PANE'),
    perform: (op) => {
      const p = paneAt(op)
      // ASKS BEFORE IT DOES IT, the way `X--` does on a window. Closing is the
      // only act on a pane that cannot be undone -- the document survives in the
      // store, but its place on the road does not -- and a control that destroys
      // on the first press is the one control a shell must not have.
      //
      // The ask is state, not a modal: `state.paperAsking` holds the key and the
      // chrome draws differently while it is set, exactly as `state.closeAsking`
      // does for a window.
      if (state.paperAsking !== p.key) {
        state.paperAsking = p.key
        refreshChrome()
        return { ok: true, asked: true, key: p.key }
      }
      state.paperAsking = null
      // Closing the pane you are reading closes the read tier with it. Leaving a
      // DOM object mounted over a document that no longer exists is the one way
      // this could strand a reader.
      if (readingKey() === p.key) closeRead()
      // A closed pane cannot stay on air either, and it is unpinned here rather
      // than left for the shell to notice, so the pin cannot outlive the pane.
      if (castKey === p.key) { castKey = null; hooks.castPaper?.(p) }
      removePaper(p.key)
      return { ok: true }
    },
  })

  registerOp('resize', {
    pre: (op) => {
      if (!paneAt(op)) return 'OP_NO_PANE'
      return Number.isFinite(op.w) ? true : 'OP_BAD_SIZE'
    },
    perform: (op) => {
      const p = paneAt(op)
      // CLAMPED HERE, not by the caller. A precondition that only accepts already
      // legal values makes every caller responsible for the bounds, and one of them
      // will not be.
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(op.w)))
      const h = Math.round(w * (H / W))
      if (w === (p.w ?? W)) return { ok: true, unchanged: true }
      p.w = w
      p.h = h
      // Everything sized is dropped and rebuilt by the next sync: the canvas is a
      // different number of pixels, the quad is a different geometry, and the
      // document is laid out again at the new width rather than stretched.
      const wasReading = readingKey() === p.key
      releasePaint(p)
      releaseCard(p)
      dematerialize(p)
      p.tier = null
      syncPaper()
      if (wasReading) { p.readPose = readPoseOf(p); openRead(p) }
      return { ok: true, w, h }
    },
  })

  registerOp('cast', {
    pre: (op) => {
      const p = paneAt(op)
      if (!p) return 'OP_NO_PANE'
      // A pane can only go on air if it HAS a picture, and only the paint tier has
      // one. Refusing by name beats casting a blank screen, which reads as the TV
      // being broken rather than as the pane being too far away.
      if (!p.tex) return 'OP_PANE_NOT_PAINTED'
      return true
    },
    perform: (op) => {
      const p = paneAt(op)
      const r = hooks.castPaper?.(p)
      if (!r) return { ok: false, why: 'OP_NO_BROADCAST' }
      // Toggled, like a window's `--&`. The key is what pins the tier, so it has to
      // come back off when the broadcast does.
      castKey = r.on ? p.key : null
      return { ok: true, ...r }
    },
  })
}

// What Escape inside a read pane calls. A hook rather than a direct import because
// read.js must not learn that the seam exists -- it draws a pane, it does not
// decide what leaving one means.
export const paperUnread = () => applyOp({ op: 'unread' }, { by: 'pointer' })

// ---- the report --------------------------------------------------------------

// `window.__papers()`. The tier breakdown is the point: "there are 400 panes" and
// "400 panes are being laid out" are different facts and only the second is a cost.
export const paperReport = () => ({
  count: papers.size,
  byTier: [...papers.values()].reduce((a, p) => ((a[p.tier ?? 'unbuilt'] = (a[p.tier ?? 'unbuilt'] ?? 0) + 1), a), {}),
  byDistrict: [...papers.values()].reduce((a, p) => ((a[p.district] = (a[p.district] ?? 0) + 1), a), {}),
  // Canvases actually held, which is the number the lazy-allocation change exists
  // to keep small. It should equal the paint-tier count and nothing more.
  paintCanvases: [...papers.values()].filter((p) => p.canvas).length,
  // Objects actually in the scene graph. three.js walks every one of these per
  // frame whether or not it draws, so this -- not `count` -- is the number that
  // has to stay bounded as the corpus grows.
  sceneObjects: [...papers.values()].reduce((n, p) =>
    n + (p.frame ? 2 : 0) + (p.paintMesh ? 1 : 0) + (p.cardMesh ? 1 : 0), 0),
  paintMax: PAINT_MAX,
  reading: readingKey(),
  casting: castKey,
  asking: state.paperAsking,
  atlas: atlasReport(),
  overflowing: [...papers.values()].filter((p) => p.last?.overflow).length,
  stream: { resident, ...streamStats, store: store?.kind ?? null },
  bench: state.paperBench ?? null,
  seed: state.paperSeed ?? null,
})

// ---- the demo seed -----------------------------------------------------------

// Places the bundled samples on the road you are standing on. A DEMO, not a store:
// rung 5 in docs/PAPER_ROADS.md is where documents come from somewhere.
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
  syncPaper()
  return { placed: placed.filter((r) => r.ok).length, refused: placed.filter((r) => !r.ok).map((r) => r.why) }
}
