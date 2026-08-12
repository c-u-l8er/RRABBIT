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
import { state, signs, ACC, COOL, DASH_LEN, DASH_PITCH, dashZ, dashCount } from './world.js'
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

// The ramp itself: a strip of tarmac peeling off to the right of the centre line,
// with a board at the end of it naming where it goes.
//
// RIGHT, and it has to be short. Windows stand at x = +/-330 with posts under
// them, so a ramp long enough to look like a motorway slip road would run through
// the window row. 240 units of x is as far as it can go and still stop clear of a
// post; the length and the angle are then decided by that rather than chosen.
const RAMP_DX = 240
const RAMP_DZ = -330
const RAMP_W = 120
const BOARD_W = 210
const BOARD_H = 74
const BOARD_Y = 46

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
    //
    // AND NOTHING IS HOVERED WHILE THE MAP IS OPEN. The map is a full-screen
    // overlay, so the canvas stops receiving pointermove and the last hover
    // freezes -- which is visible the moment you shut the map again, as a white
    // dash under a pointer that is nowhere near it. Clicking a marker opens the
    // map, so this is the ordinary path and not an edge case.
    const hot =
      !state.mapOpen &&
      ((dashHot.district === district && dashHot.at === i) ||
        (rampHot.district === district && rampHot.at === i))
    entry.line.setColorAt(i, hot ? LIT : byAt.has(i) ? TAKEN : DIM)
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

function makeRamp(district, r) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace

  // The deck. Flat like the road and the same colour, so it reads as tarmac
  // rather than as a panel lying down.
  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(RAMP_W, Math.hypot(RAMP_DX, RAMP_DZ)),
    new THREE.MeshStandardMaterial({ color: 0x191c2c, roughness: 0.9 }),
  )
  deck.rotation.x = -Math.PI / 2
  // Rotated about the world's up axis AFTER the flattening, which for a plane
  // laid down with rotation.x is rotation.z -- not rotation.y. Getting this wrong
  // tips the deck up on its edge and it disappears from above.
  //
  // NEGATIVE, and the sign is worth the algebra rather than a guess. Euler XYZ
  // applies Rz first, so the quad spins within its own surface and is then laid
  // down: local +Y = (0,1,0) becomes (-sin t, 0, -cos t). The deck must run along
  // (RAMP_DX, 0, RAMP_DZ), so -sin t = DX/len with DX positive -- which needs a
  // negative angle. Positive puts the ramp out the left side of the road.
  deck.rotation.z = -Math.atan2(RAMP_DX, -RAMP_DZ)
  deck.userData.gantryAction = { kind: 'ramp', district, at: r.at, to: r.to }

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: false }),
  )
  // Facing back UP the road, turned in toward the driver -- the same 24-degree
  // family the window signs use, for the same reason: a board square to the road
  // is edge-on until you are level with it.
  board.rotation.y = -0.5
  board.userData.gantryAction = { kind: 'ramp', district, at: r.at, to: r.to }

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(6, BOARD_Y, 6),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 }),
  )

  scene.add(deck)
  scene.add(board)
  scene.add(post)
  return { deck, board, post, tex, canvas, key: '' }
}

function placeRamp(part, district, x, r) {
  const z0 = dashZ(r.at)
  part.deck.position.set(x + RAMP_DX / 2, ROAD_Y + 0.3, z0 + RAMP_DZ / 2)
  part.board.position.set(x + RAMP_DX, ROAD_Y + BOARD_Y + BOARD_H / 2, z0 + RAMP_DZ)
  part.post.position.set(x + RAMP_DX, ROAD_Y + BOARD_Y / 2, z0 + RAMP_DZ)

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
  for (const m of [part.deck, part.board, part.post]) {
    scene.remove(m)
    m.geometry.dispose()
    m.material.dispose()
  }
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
export function dashActionOf(hit) {
  const district = hit?.object?.userData?.dashPad
  if (!district || !Number.isInteger(hit.instanceId)) return null
  const at = hit.instanceId
  const r = ws.rampAt(district, at)
  // A dash that carries a ramp IS that ramp -- the deck and the board are the
  // big targets, and the marker under them must not open the builder for a slot
  // that is already spoken for.
  if (r) return { kind: 'ramp', district, at, to: r.to }
  return { kind: 'dash', district, at }
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
