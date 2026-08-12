// THE CENTRE LINE, AND THE RAMPS THAT HANG OFF IT.
//
// Two things live in this file because they are one thing seen twice: the yellow
// dashes down the middle of a road are a row of ADDRESSES, and a ramp is what you
// build at one of them. Drawing the dashes without making them pointable would be
// decoration; making them pointable without drawing them would be an invisible
// grid you have to be told about.
//
// WHAT A RAMP IS FOR. The exit gate at the end of a road carries lanes to the
// other workspaces IN THIS NETWORK -- numbered, ordered, laid out by hops from the
// root. A ramp goes somewhere that has no lane number here at all: a workspace in
// ANOTHER network. That is why it is not another kind of gate lane. It is placed
// where you decide it goes, part-way down the road, the way a real exit ramp is;
// and it says which network it lands in on its own board, because the name of a
// workspace in a network you are not looking at is not enough to identify it.
//
// TWO INSTANCED MESHES PER ROAD, AND THE SECOND ONE IS INVISIBLE. A centre-line
// dash is about 14 units wide on a 320-wide road -- correct, and far too thin to
// aim at from 300 units back. So the visible line is thin and a second set of
// 90-wide quads sits under it with `visible: false` on the material, taking the
// clicks. That is the same trick the window chrome already uses for its close and
// grab pads (rrabbit.js), and it works because three raycasts a mesh you hand it
// directly without consulting whether it would be drawn.
//
// Instanced rather than one mesh per dash: a long road wants sixty of them, every
// open road has a line, and sixty quads per road as separate objects is sixty draw
// calls for a painted stripe. Per-instance colour is what makes hover possible
// without breaking that.

import * as THREE from 'three'
import {
  state,
  signs,
  ACC,
  COOL,
  DASH_LEN,
  DASH_PITCH,
  dashZ,
  dashCount,
  RAMP_SPAN,
  RAMP_OUT,
} from './world.js'
import * as ws from './workspaces.js'

let scene = null
export function attachRamps(c) {
  scene = c.scene
}

// The visible dash. Narrow, amber, flat on the tarmac and a hair above it -- at
// exactly the road's y it z-fights with the road and flickers.
const LINE_W = 14
const PAD_W = 96
const ROAD_Y = -30
const LINE_Y = ROAD_Y + 0.6

// ---- the shape of an off-ramp ---------------------------------------------
//
// IT WAS A ROTATED QUAD 240 UNITS LONG AND IT DID NOT READ AS A ROAD. It also
// ended its board at x=240, which is inside the window row (a right-hand sign
// spans x = 180..480) -- so the one thing a ramp has to be able to say, where it
// goes, was printed on top of a window.
//
// So it is built the way a real diverge is built, and the vocabulary is the real
// one because each part is doing the job it does out there:
//
//   TAPER            it starts ON the tarmac in the lane it leaves by, so it reads
//                    as part of the road you are already driving
//   DECELERATION RUN a short stretch near-parallel to the road before anything
//                    turns -- this is what makes it a road leaving rather than a
//                    branch drawn at an angle
//   DEPARTURE        the curve away, sweeping past x=480 so the board at the end
//                    stands clear of every window, with an edge line down each
//                    shoulder -- see "no gore fill" below for the part that was
//                    tried and removed
//
// The deck is a RIBBON sampled along that curve, not a quad: a curve is the whole
// difference between "a road goes that way" and "something is attached here".
//
// It also drops slightly as it goes, which costs nothing and is what an off-ramp
// does -- and it means the far end can never z-fight with the road plane.
const RAMP_W_NEAR = 116
const RAMP_W_FAR = 92
const RAMP_MOUTH_X = 104
const RAMP_DROP = 16
const RAMP_SEGS = 26

const BOARD_W = 240
const BOARD_H = 84
const BOARD_Y = 52

const ACC_CSS = '#' + ACC.toString(16).padStart(6, '0')
const COOL_CSS = '#' + COOL.toString(16).padStart(6, '0')

// workspace id -> { line, pads, count, ramps: Map<at, {deck, board, tex, canvas, key}> }
const lines = new Map()

const dashHot = { district: null, at: null }
const rampHot = { district: null, at: null }

// ------------------------------------------------------------------ the line

// One allocation per road, sized once. An InstancedMesh cannot grow, and a road
// that gets longer is the ordinary case -- so the buffer is the cap (world.js
// DASH_MAX) and `count` is how much of it is in use.
const DASH_MAX_INSTANCES = 96
// Amber is the line. White is what your pointer is on. Cool is a slot that
// already carries a ramp -- the same colour this shell uses everywhere else for
// "this goes somewhere else" -- so an occupied marker never reads as a free one.
const DIM = new THREE.Color(ACC)
const LIT = new THREE.Color(0xffffff)
const TAKEN = new THREE.Color(COOL)

// THE EXIT ANNOUNCES ITSELF BEFORE YOU ARE LEVEL WITH IT.
//
// A road tells you about an exit in advance -- that is what the advance guide sign
// is for out there -- and a ramp you can only find by already being beside it is
// one you discover by accident. So the few dashes leading up to a ramp's marker are
// blended from amber toward cool, strongest nearest the exit. It costs one lerp per
// dash and nothing on screen when a road has no ramps.
const APPROACH = 3
const APPROACH_COLOURS = Array.from({ length: APPROACH }, (_, i) =>
  new THREE.Color(ACC).lerp(new THREE.Color(COOL), 0.6 - 0.18 * i),
)

function makeLine(district) {
  const n = DASH_MAX_INSTANCES
  const line = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(LINE_W, DASH_LEN),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    n,
  )
  // setColorAt allocates instanceColor on first use, filled with white -- so the
  // material's own colour has to be white or every instance would be tinted by it
  // twice. Seed every slot, including the ones past `count`: an allocated
  // instanceColor that was never written is what draws a black dash.
  for (let i = 0; i < n; i++) line.setColorAt(i, DIM)
  line.frustumCulled = false
  line.userData.dashLine = district
  scene.add(line)

  const pads = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(PAD_W, DASH_PITCH * 0.9),
    new THREE.MeshBasicMaterial({ visible: false }),
    n,
  )
  pads.frustumCulled = false
  pads.userData.dashPad = district
  scene.add(pads)
  return { line, pads, count: 0, ramps: new Map() }
}

const M = new THREE.Matrix4()
const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
const ONE = new THREE.Vector3(1, 1, 1)
const P = new THREE.Vector3()

// Instances beyond the count are parked at a zero scale rather than left where
// they were: `count` only limits what is DRAWN via instanceMatrix usage in
// three's renderer through `mesh.count`, and setting that is enough for drawing
// but the raycast walks `mesh.count` too -- so the only thing that must be true is
// that both are set together. Both are, below.
function placeLine(entry, district, x) {
  const want = Math.min(DASH_MAX_INSTANCES, dashCount(district))
  const ramps = ws.rampsOf(district)
  const byAt = new Map(ramps.map((r) => [r.at, r]))
  for (let i = 0; i < want; i++) {
    P.set(x, LINE_Y, dashZ(i))
    M.compose(P, Q, ONE)
    entry.line.setMatrixAt(i, M)
    entry.pads.setMatrixAt(i, M)
    // A hovered ramp lights its own marker as well as its board, because the
    // marker is the part of a ramp that is on the road you are driving.
    const hot =
      (dashHot.district === district && dashHot.at === i) ||
      (rampHot.district === district && rampHot.at === i)
    // Nearest ramp AHEAD of this dash, within the run-up. `at - i` because dashes
    // number away from the head of the road, so a bigger index is further along.
    let lead = -1
    for (const r of ramps) {
      const gap = r.at - i
      if (gap >= 1 && gap <= APPROACH && (lead < 0 || gap < lead)) lead = gap
    }
    entry.line.setColorAt(
      i,
      hot ? LIT : byAt.has(i) ? TAKEN : lead > 0 ? APPROACH_COLOURS[lead - 1] : DIM,
    )
  }
  entry.line.count = want
  entry.pads.count = want
  entry.count = want
  entry.line.instanceMatrix.needsUpdate = true
  entry.pads.instanceMatrix.needsUpdate = true
  entry.line.instanceColor.needsUpdate = true
}

// ----------------------------------------------------------------- the board

function drawBoard(canvas, r) {
  const to = ws.get(r.to)
  const net = ws.tenant(ws.tenantOf(r.to))
  const crosses = ws.tenantOf(r.to) !== ws.tenantOf(r.from)
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  g.clearRect(0, 0, W, H)
  g.fillStyle = '#0b1220'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = crosses ? COOL_CSS : ACC_CSS
  g.lineWidth = 10
  g.strokeRect(5, 5, W - 10, H - 10)
  // THE NETWORK NAME IS THE TOP LINE, and it is the whole reason this board
  // exists. A workspace called "home" in a network you are not looking at is
  // indistinguishable from the "home" you are standing on; the network is what
  // tells them apart, so it is not a subtitle.
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = crosses ? COOL_CSS : '#9fb0c8'
  g.font = 'bold 42px ui-monospace, monospace'
  g.fillText(crosses ? (net?.name ?? '?').slice(0, 18) : 'this network', W / 2, H * 0.28)
  g.fillStyle = '#f3ead4'
  g.font = 'bold 66px ui-monospace, monospace'
  g.fillText((to?.name ?? r.to).slice(0, 16), W / 2, H * 0.62)
  g.fillStyle = '#6b7689'
  g.font = '34px ui-monospace, monospace'
  g.fillText(to?.open ? 'exit ' + (r.at + 1) : 'closed', W / 2, H * 0.87)
}

// The ramp's centreline, in the road's own frame: x out to the right, z down the
// road. `t` runs 0 (on the tarmac) to 1 (at the board).
//
// A cubic, and the control points are the anatomy. P1 sits almost straight ahead
// of P0 -- that is the deceleration run, and it is what stops the ramp reading as
// a diagonal line stuck onto the road. P2 is thrown well out to the side so the
// sweep is already past the window row by the time it gets there, and P3 lands at
// RAMP_OUT with the curve still opening rather than hooking back.
const CURVE = new THREE.CubicBezierCurve(
  new THREE.Vector2(RAMP_MOUTH_X, 0),
  new THREE.Vector2(RAMP_MOUTH_X + 46, -RAMP_SPAN * 0.42),
  new THREE.Vector2(RAMP_OUT * 0.63, -RAMP_SPAN * 0.78),
  new THREE.Vector2(RAMP_OUT, -RAMP_SPAN),
)

// A flat strip laid along a curve: sample the centreline, step sideways along the
// normal by half the width, and stitch the two edges into quads.
//
// `widthAt`/`offset` are functions so the same builder makes the deck (wide,
// tapering) and its edge lines (thin, pushed out to each side). One builder means
// the lines cannot drift off the deck they are drawn on.
// MIRRORED FOR A LEFT-HAND RAMP, and the winding has to mirror with it. Negating x
// turns every triangle inside out, `computeVertexNormals` then points them at the
// ground, and a MeshStandardMaterial lit from above renders that black -- so a left
// ramp would be built, be clickable, and be invisible. Flipping the index order back
// is the whole fix and it is why the triangles are emitted twice below.
function ribbon(widthAt, offset, side, segs = RAMP_SEGS) {
  const pos = []
  const idx = []
  const sx = side > 0 ? 1 : -1
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const p = CURVE.getPoint(t)
    const d = CURVE.getTangent(t)
    // The left-hand normal of a 2D tangent in the x/z plane. Getting this
    // consistent is what keeps the winding the same all the way along, and a flip
    // mid-ribbon shows up as a pinch.
    const n = new THREE.Vector2(-d.y, d.x).normalize()
    const half = widthAt(t) / 2
    const c = new THREE.Vector2(p.x + n.x * offset(t), p.y + n.y * offset(t))
    const y = ROAD_Y + 0.4 - RAMP_DROP * t
    pos.push(sx * (c.x - n.x * half), y, c.y - n.y * half)
    pos.push(sx * (c.x + n.x * half), y, c.y + n.y * half)
    if (i > 0) {
      const a = (i - 1) * 2
      if (sx > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      else idx.push(a + 2, a + 1, a, a + 2, a + 3, a + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// THERE IS DELIBERATELY NO GORE FILL.
//
// One existed: a translucent amber wedge between the road's edge and the ramp's
// inner shoulder, from the painted nose widening downstream -- the real anatomy,
// and the right idea. What it looked like on a near-black road was a patch of brown
// dirt beside the tarmac, and it was reported as exactly that. Amber at a third
// opacity over #11131f is mud; there is no opacity at which it is paint.
//
// A road marking is a LINE, and the ramp already has two of them along its
// shoulders. Those carry the diverge on their own -- the curve says a road leaves,
// the lines say where its edges are -- so the fill was the only part of the
// anatomy that was decoration rather than information, and it is the part that is
// gone. If a gore ever comes back it has to come back as strokes.

function makeRamp(district, r) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace

  const action = { kind: 'ramp', district, at: r.at, to: r.to }
  const side = r.side > 0 ? 1 : -1

  // THE DECK IS THE SAME COLOUR AS THE ROAD, not a lighter one. It was 0x191c2c
  // against the road's 0x11131f, meaning to read as "tarmac, but a different
  // road"; what it actually read as at a grazing angle was a sheet of paper lying
  // on the ground. A road leaving a road is the same material -- the edge lines are
  // what tell them apart, which is true out there too.
  const deck = new THREE.Mesh(
    ribbon(
      (t) => RAMP_W_NEAR + (RAMP_W_FAR - RAMP_W_NEAR) * t,
      () => 0,
      side,
    ),
    // DoubleSide because it is a flat surface seen from a low camera and a winding
    // mistake would make the whole ramp vanish rather than look wrong -- and a
    // vanished ramp reads as a ramp that was never built.
    new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9, side: THREE.DoubleSide }),
  )
  deck.userData.gantryAction = action

  // Edge lines on both shoulders -- the pair of thin strips that tell a deck the
  // same colour as the road apart from the road. Pale rather than white: an edge
  // line brighter than the centre line would make the ramp shout louder than the
  // road it leaves.
  const edges = new THREE.Group()
  for (const e of [-1, 1]) {
    edges.add(
      new THREE.Mesh(
        ribbon(
          () => 5,
          (t) => (e * (RAMP_W_NEAR + (RAMP_W_FAR - RAMP_W_NEAR) * t)) / 2,
          side,
        ),
        new THREE.MeshBasicMaterial({ color: 0x8a97ab, side: THREE.DoubleSide }),
      ),
    )
  }

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: false }),
  )
  // FACING THE APPROACH. A plane's normal is +Z, and rotation.y maps it to
  // (sin f, 0, cos f) -- so pointing it back up the road AND inward, at the driver
  // rather than at the scenery, is one atan2 of the vector from the board to where
  // the road came from. Square to the ramp would be edge-on until you were level
  // with it, which is the trap the window signs already solved by turning.
  board.rotation.y = Math.atan2(-side * RAMP_OUT * 0.5, RAMP_SPAN + 420)
  board.userData.gantryAction = action

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(7, BOARD_Y, 7),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 }),
  )

  scene.add(deck)
  scene.add(edges)
  scene.add(board)
  scene.add(post)
  return { deck, edges, board, post, tex, canvas, key: '' }
}

function placeRamp(part, district, x, r) {
  const z0 = dashZ(r.at)
  // The deck and its lines are both built in the ramp's own frame with the mouth at
  // the origin, so placing a ramp is moving that frame. Nothing is rebuilt when the
  // road it hangs off moves sideways.
  for (const m of [part.deck, part.edges]) m.position.set(x, 0, z0)
  const end = CURVE.getPoint(1)
  const sx = r.side > 0 ? 1 : -1
  part.board.position.set(x + sx * end.x, ROAD_Y - RAMP_DROP + BOARD_Y + BOARD_H / 2, z0 + end.y)
  part.post.position.set(x + sx * end.x, ROAD_Y - RAMP_DROP + BOARD_Y / 2, z0 + end.y)

  // Redrawn only when what it says changes. A canvas repaint per frame per ramp
  // is the kind of cost that does not show up in a frame time until there are
  // eight of them.
  const to = ws.get(r.to)
  const key = `${r.to}|${to?.name}|${to?.open}|${ws.tenantOf(r.to)}|${ws.tenant(ws.tenantOf(r.to))?.name}|${r.at}`
  if (key !== part.key) {
    part.key = key
    drawBoard(part.canvas, { ...r, from: district })
    part.tex.needsUpdate = true
  }
  const hot = rampHot.district === district && rampHot.at === r.at
  part.board.material.color.setHex(hot ? 0xffffff : 0xbfbfbf)
  // The action carries the destination, which can be re-pointed from the map
  // without the mesh being rebuilt.
  part.deck.userData.gantryAction.to = r.to
  part.board.userData.gantryAction.to = r.to
}

function dropRamp(part) {
  // The edge lines are a group of two, so the loop has to walk into it -- a
  // dispose that misses them leaks a geometry per ramp built and removed, which is
  // exactly the thing that only shows up after an afternoon of rewiring.
  for (const m of [part.deck, part.board, part.post, ...part.edges.children]) {
    scene.remove(m)
    m.geometry.dispose()
    m.material.dispose()
  }
  scene.remove(part.edges)
  part.tex.dispose()
}

// ---------------------------------------------------------- reconciliation
//
// Same shape and the same reasons as syncRoads and syncGantries: called every
// frame, safe when nothing moved, and the single place the scene is made to agree
// with the graph. A ramp can be built from the map while you are mid-flight, so
// there is no moment at which construction could happen instead.
export function syncRamps() {
  if (!scene) return
  // A HOVER THAT IS MASKED IS STILL A HOVER, and that was the bug.
  //
  // While the map is open the canvas gets no pointermove, so whatever was last
  // under the pointer stays under it forever as far as this module knows. Hiding
  // the highlight for the duration -- which is what this used to do -- fixes the
  // picture and not the state: shut the map without moving the mouse and the mask
  // lifts on a hover that is minutes stale, so the marker you pressed lights up
  // again with the pointer nowhere near it. Reported as a highlight that would not
  // go back.
  //
  // Clearing it is the same one line in a better place. The map is a full-screen
  // overlay: while it is up, nothing on the road IS hovered, and that is a fact
  // rather than a display rule.
  if (state.mapOpen) clearHover()
  const want = new Set()
  for (const w of ws.openList()) {
    want.add(w.id)
    const x = ws.laneX(w.id)
    let entry = lines.get(w.id)
    if (!entry) {
      entry = makeLine(w.id)
      lines.set(w.id, entry)
    }
    placeLine(entry, w.id, x)

    const live = new Set()
    for (const r of ws.rampsOf(w.id)) {
      live.add(r.at)
      let part = entry.ramps.get(r.at)
      if (!part) {
        part = makeRamp(w.id, r)
        entry.ramps.set(r.at, part)
      }
      placeRamp(part, w.id, x, r)
    }
    for (const [at, part] of [...entry.ramps]) {
      if (live.has(at)) continue
      dropRamp(part)
      entry.ramps.delete(at)
    }
  }
  for (const [id, entry] of [...lines]) {
    if (want.has(id)) continue
    for (const part of entry.ramps.values()) dropRamp(part)
    for (const m of [entry.line, entry.pads]) {
      scene.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    }
    lines.delete(id)
  }
}

// WHAT IS CLICKABLE OUT HERE. Only the road you are standing on: the dashes on
// the road two lanes over are visible and they are 2600 units off to the side, so
// a ray that reaches them has passed through everything on your own road first --
// and a ramp built by aiming across a gap at a road you are not on is a ramp
// built by accident.
export function rampMeshes() {
  const out = []
  const entry = lines.get(state.district)
  if (entry) {
    out.push(entry.pads)
    for (const part of entry.ramps.values()) out.push(part.deck, part.board)
  }
  return out
}

// The dash a raycast hit, from the instance it hit. This is the only place an
// instanceId is turned back into a dash number, and it is why the pads mesh
// carries the workspace id in userData rather than being looked up by position.
// THE MARKER IS THE HANDLE; THE RAMP IS THE ROAD.
//
// A dash that carries a ramp used to BE that ramp: clicking the marker drove you
// down it. That made the one thing a built ramp had no control for -- changing it --
// reachable only through the map's own list, and it made the marker and the deck
// two ways of doing one thing while nothing did the other. Asked for the other way
// round, and it is the better division: the mark painted on the centre line is what
// you press to edit, the tarmac and the board are what you press to drive. So this
// always answers `dash`, and the page it opens is the edit page when the slot is
// occupied and the builder when it is not -- which is one page either way.
export function dashActionOf(hit) {
  const district = hit?.object?.userData?.dashPad
  if (!district || !Number.isInteger(hit.instanceId)) return null
  return { kind: 'dash', district, at: hit.instanceId }
}

function clearHover() {
  dashHot.district = null
  dashHot.at = null
  rampHot.district = null
  rampHot.at = null
}

// Hover, so a marker reads as pressable before it is pressed. Held as two
// addresses rather than as a mesh, because the dashes are instances and there is
// no mesh to remember.
export function setRampHover(hit) {
  const action = hit ? (dashActionOf(hit) ?? hit.object?.userData?.gantryAction ?? null) : null
  const dash = action?.kind === 'dash' ? action : null
  const ramp = action?.kind === 'ramp' ? action : null
  dashHot.district = dash?.district ?? null
  dashHot.at = dash ? dash.at : null
  rampHot.district = ramp?.district ?? null
  rampHot.at = ramp ? ramp.at : null
}

// What is actually painted on the road, read off the scene rather than off the
// graph. A report that recomputed the dash positions from `dashZ` would agree
// with itself no matter what the instance matrices said.
export const rampReport = () => {
  const out = { district: state.district, roads: [] }
  for (const [id, entry] of lines) {
    const m = new THREE.Matrix4()
    const dashes = []
    for (let i = 0; i < entry.count; i++) {
      entry.line.getMatrixAt(i, m)
      const p = new THREE.Vector3().setFromMatrixPosition(m)
      const c = new THREE.Color()
      entry.line.getColorAt(i, c)
      dashes.push({ at: i, z: Math.round(p.z), x: Math.round(p.x), lit: c.getHexString() })
    }
    out.roads.push({
      id,
      name: ws.get(id)?.name ?? id,
      drawn: entry.count,
      clickable: id === state.district,
      dashes,
      ramps: [...entry.ramps.entries()].map(([at, part]) => ({
        at,
        to: part.deck.userData.gantryAction.to,
        toName: ws.get(part.deck.userData.gantryAction.to)?.name ?? null,
        // Read off the BOARD's x against the road's, not off the record -- the claim
        // being made about sides is that the geometry mirrors, and a report that
        // repeated the stored side would agree with itself either way.
        side: part.board.position.x > ws.laneX(id) ? 'right' : 'left',
        // The hover, read off the MATERIAL rather than off `rampHot` -- the claim is
        // that the highlight follows the pointer, and a report that re-read the
        // variable the highlight is drawn from would agree with itself whatever the
        // board looked like.
        boardLit: part.board.material.color.getHexString(),
        board: [
          Math.round(part.board.position.x),
          Math.round(part.board.position.y),
          Math.round(part.board.position.z),
        ],
      })),
    })
  }
  out.windowsOnThisRoad = [...signs.values()].filter((s) => s.district === state.district).length
  return out
}
