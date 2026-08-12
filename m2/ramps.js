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
  windowAtOn,
  canvasTexture,
  RAMP_SPAN,
  RAMP_OUT,
} from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'

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
//   DEPARTURE        the curve away, with an edge line down each shoulder -- see
//                    "no gore fill" below for the part that was tried and removed
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

// THE SIGN STANDS AT THE MOUTH, NOT AT THE FAR END.
//
// It was at the ramp's far end, 980 units out and 560 down the road, which put it
// where you cannot read it -- reported. It stands where a real exit direction sign
// stands now: at the gore, beside the road, facing the traffic that has to decide.
//
// BOARD_STAND_X CAME BACK IN TO 300, and the shared grid is what paid for it.
//
// It was 300, which is where you want it -- close, big, unmissable -- and it drew
// straight over a window standing 600 units further down the road, because the two
// were at almost the same x and the nearer one wins. So it went out to 600, past
// where any window sign can reach (they span x = 180..480).
//
// That was the right fix for two grids and the wrong one for a single grid. A ramp
// now RESERVES its own stretch of its own side -- one dash in front and four behind,
// which is the sweep it actually occupies (world.js slotFree) -- so no window can
// stand where the sign is. The clearance is enforced rather than bought with
// distance, and the sign can be where it belongs: on the verge beside the tarmac.
//
// It stays a little in FRONT of the dash so you read it and then reach the turn --
// the same argument GATE_GAP makes for the gates.
// FOUR LINES NOW, SO THE BOARD IS TALLER RATHER THAN TIGHTER. A fourth row squeezed
// into the old height would have shrunk the destination -- the one line you read at
// speed -- to buy room for the one you already know. 216/135 is 1.6, which is the
// canvas's 512/320: the two ratios MUST match or the text draws squashed, which is
// the mistake the gate board made first and the reason this line exists at all.
const BOARD_W = 216
const BOARD_H = 135
const BOARD_Y = 40
const BOARD_STAND_X = 300
const BOARD_STAND_Z = 70

const ACC_CSS = '#' + ACC.toString(16).padStart(6, '0')
const COOL_CSS = '#' + COOL.toString(16).padStart(6, '0')

// workspace id -> { line, pads, count, ramps: Map<at, {deck, board, tex, canvas, key}> }
const lines = new Map()

// Only the ramp's SIGN answers to the pointer now -- the centre line is amber
// whatever is under it. Kept as an address rather than a mesh because a ramp's board
// is rebuilt whenever the ramp is moved or flipped.
const rampHot = { district: null, at: null }

// AND WHICH DASH THE POINTER IS ON, held the same way and for a stronger reason:
// a dash is an INSTANCE, so there is no object to hang a highlight on even if we
// wanted one.
const dashHot = { district: null, at: null }

// ------------------------------------------------------------------ the line

// One allocation per road, sized once. An InstancedMesh cannot grow, and a road
// that gets longer is the ordinary case -- so the buffer is the cap (world.js
// DASH_MAX) and `count` is how much of it is in use.
const DASH_MAX_INSTANCES = 96
// THE CENTRE LINE IS AMBER AND NEVER ANYTHING ELSE.
//
// It carried three other colours for a while, each defensible on its own: cool for a
// dash that holds a ramp, a cool-ward gradient on the run-up so an exit announced
// itself early, and white under the pointer. Asked to stop -- "keep it yellow
// always" -- and the ask is right. A centre line is a road marking, and a road
// marking that changes colour to tell you about the traffic is not a marking any
// more, it is a display. What the markers hold is the map's job to say, and what the
// pointer is on is the cursor's.
//
// So there is no per-instance colour at all now: one material, one colour, and the
// InstancedMesh is back to a single uniform. `instanceColor` and the three palettes
// that fed it are gone rather than always-set-to-amber, because a channel nothing
// writes is a channel somebody re-enables by accident.
//
// WHICH LEFT NO WAY TO SEE WHICH DASH YOU ARE AIMING AT, and that was reported: the
// markers are a grid of addresses you click, and every one of them looks exactly
// like every other one under the pointer. The cursor turns into a hand, which says
// "something here is clickable" and not "this one".
//
// The answer is the one the paragraph above already names -- "what the pointer is on
// is the cursor's" job -- taken literally. A CURSOR is drawn, not the marking: a thin
// open frame around the cell the pointer is in, in the shell's own cream rather than
// in road amber, so it can never be mistaken for paint. The dash inside it is the
// same colour it was a moment ago and the same colour as every other dash. Nothing
// about the road changed; something was added on top of it, and it goes away.
//
// THE FRAME IS THE CELL, NOT THE STRIPE. What answers the click is the invisible pad
// (PAD_W across, most of a pitch long), not the 14-wide painted dash -- so a frame
// drawn tight around the stripe would advertise a target far smaller than the one
// that is really there, and every near miss would look like a bug. It is also the
// footprint a window or a ramp occupies when it stands here, which is what you are
// aiming at the marker to decide.
const MARK_PAD = 6
const MARK_T = 3
const MARK_COLOUR = 0xf3ead4

function makeLine(district) {
  const n = DASH_MAX_INSTANCES
  const line = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(LINE_W, DASH_LEN),
    new THREE.MeshBasicMaterial({ color: ACC }),
    n,
  )
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

// An open rectangle lying flat on the road: four thin bars sharing one geometry,
// so the cursor is one mesh and one draw call however long the road is. Built in
// the XZ plane already -- no rotation to keep in step with the dashes.
//
// DoubleSide because a flat quad in the ground plane is seen from a camera that can
// end up fractionally below it during a flight, and a cursor that blinks out when
// the camera dips is a cursor you stop trusting.
function frameMesh(w, h, t) {
  const pos = []
  const idx = []
  const bar = (x0, z0, x1, z1) => {
    const a = pos.length / 3
    pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1)
    idx.push(a, a + 1, a + 2, a, a + 2, a + 3)
  }
  const hw = w / 2
  const hh = h / 2
  bar(-hw, -hh, hw, -hh + t)
  bar(-hw, hh - t, hw, hh)
  bar(-hw, -hh + t, -hw + t, hh - t)
  bar(hw - t, -hh + t, hw, hh - t)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  return new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ color: MARK_COLOUR, side: THREE.DoubleSide, toneMapped: false }),
  )
}

// ONE cursor for the whole world, not one per road. There is exactly one pointer.
let mark = null

// The cursor's own reconcile, called from syncRamps for the same reason everything
// else in here is: the hover can change between frames without this module being
// told, and the map can open on top of it.
function syncMark() {
  if (!mark) {
    mark = frameMesh(PAD_W + MARK_PAD * 2, DASH_PITCH * 0.9 + MARK_PAD * 2, MARK_T)
    mark.frustumCulled = false
    mark.renderOrder = 2
    scene.add(mark)
  }
  // Only on the road you are standing on, which is also the only road whose pads
  // are raycast (rampMeshes) -- so this is belt and braces rather than a second
  // rule that could disagree with the first.
  const on =
    !state.mapOpen && dashHot.district === state.district && Number.isInteger(dashHot.at)
  mark.visible = on
  if (on) mark.position.set(ws.laneX(state.district), LINE_Y + 0.4, dashZ(dashHot.at))
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
  for (let i = 0; i < want; i++) {
    P.set(x, LINE_Y, dashZ(i))
    M.compose(P, Q, ONE)
    entry.line.setMatrixAt(i, M)
    entry.pads.setMatrixAt(i, M)
  }
  entry.line.count = want
  entry.pads.count = want
  entry.count = want
  entry.line.instanceMatrix.needsUpdate = true
  entry.pads.instanceMatrix.needsUpdate = true
}

// ----------------------------------------------------------------- the board

// THE EXIT SIGN SPEAKS THE SAME LANGUAGE AS THE GATE BOARD.
//
//     1:2-2 [main]              1:2-2 [main]
//     --home-->                  <--home--
//     [open sentience]         [open sentience]
//     exit 7                       exit 7
//
//     a ramp on the right      the same ramp, left
//
// It was three plain lines -- network, road, exit number -- which said the right
// things in the wrong grammar, and in a different grammar from the board hanging
// over the road twenty feet away. WRL's notation is the shell's one way of writing
// "this edge, in that box", so both signs write it that way: the destination road
// as an arrow in amber, the network it lands in in brackets, cool when the ramp
// leaves this network and muted when it does not.
//
// THE NETWORK IS ALWAYS PRINTED, even for a ramp that stays put. `home` in a
// network you are not looking at is not identified by its name, and a sign that
// only names the network sometimes makes you work out which case you are in.
//
// AND SO IS THE ONE YOU ARE LEAVING, which is the row on top. Asked for, and the
// reason is the same one the destination row already stands on, pointed the other
// way: a bracketed name on its own says WHICH network, never WHOSE side of the move
// it is on, so a sign carrying exactly one of them makes you supply the other from
// memory -- and the whole point of a ramp is that it is the one control in the shell
// whose two ends can be in different networks.
//
// THE ARROW IS WHAT SAYS WHICH WAY, so the row carries no `from`. It was `from
// [main]`, on the argument that two bracketed names stacked together are a pair you
// have to work out the direction of -- and that argument forgot what is stacked
// BETWEEN them. `--home-->` already points, and once the three rows are read as one
// line the label is a word doing a job the punctuation was doing better. Asked for,
// and it leaves the sign written in one notation instead of a notation plus a
// caption.
//
// AND THE ROW IS THE GATE BOARD'S ROW, `1:2-2 [main]` -- track 1, at window 2 of 2,
// in the network `main`. Asked for, and it is the better version of the same idea:
// the gantry hanging over this road already answers "where am I" in exactly that
// format, and a second sign twenty feet away answering the same question in a
// shorter format would be two vocabularies for one fact. Now the two signs agree
// word for word, and the ramp board's top row is simply the gate board's bottom row
// repeated where you need it -- at the turn, where the gate is behind you.
//
// IT IS MUTED AND NOT COOL, which is the one place this deviates from that board.
// Cool is "which of several" over there; on THIS sign cool already means "the ramp
// leaves this network", which is the single distinction the sign exists to draw. A
// cool top row would spend the only colour that carries meaning here on the row that
// carries the least.
//
// AND IT REPAINTS AS YOU DRIVE, once per window you pass -- `at` is the first thing
// on a ramp board that moves without anything being edited. The gate board already
// accepted that cost for the same field and says so; the difference is that a road
// can carry several ramps, so it is one repaint per ramp per window passed rather
// than one. Still not per frame: the key only moves when the count does.
//
// WHEN THE TWO NETWORKS MATCH, SEEING THE SAME NAME TWICE IS THE ANSWER. A ramp
// inside one network is legal -- it is a shortcut past the exit gate -- and `[main]`
// over `[main]` says so at a glance, which no single row can.
//
// One function for the row, used by the painter AND by the redraw key, so a board
// cannot go on saying something the key has stopped noticing.
const whereRow = (district) =>
  `${tracks.activeIndex()}:${windowAtOn(district)}-${[...signs.values()].filter((s) => s.district === district).length}` +
  ` [${ws.tenant(ws.tenantOf(district))?.name ?? '?'}]`
//
// It is the from-ROAD's network, not the active one. They are the same thing while
// you are looking at this sign, and reading it off the ramp is what keeps this row
// and the `crosses` test two views of one fact rather than two facts that can
// disagree.
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
  g.textAlign = 'center'
  g.textBaseline = 'middle'

  // Shrink to fit rather than truncate where it can: these are four short lines
  // on a wide sign, and a name that has to be cut is cut from its own end.
  const fit = (text, max, room) => {
    let px = max
    g.font = `bold ${px}px ui-monospace, monospace`
    while (px > 22 && g.measureText(text).width > room) {
      px -= 2
      g.font = `bold ${px}px ui-monospace, monospace`
    }
    let cut = text
    while (cut.length > 2 && g.measureText(cut).width > room) {
      cut = cut.slice(0, -1)
      g.font = `bold ${px}px ui-monospace, monospace`
    }
    return cut
  }
  const room = W - 44

  // Where you are, smallest and dimmest of the four: it is the only row on the sign
  // you could have answered without reading it, so it takes the least of the board.
  //
  // The rows are RETURNED as well as painted, so a report can say what the sign
  // reads without anybody having to read pixels off a canvas -- and it returns what
  // `fit` actually drew, shrunk or cut, rather than what it was handed.
  const rows = []
  const row = (text, size, y, colour) => {
    g.fillStyle = colour
    const drawn = fit(text, size, room)
    g.fillText(drawn, W / 2, H * y)
    rows.push(drawn)
  }
  row(whereRow(r.from), 34, 0.17, '#8a97ab')
  // THE ARROW POINTS THE WAY THE TARMAC GOES.
  //
  // It was `--home-->` on both sides, which is WRL's notation for the edge and says
  // nothing false -- but a road sign is read while you are deciding which way to
  // turn, and one that points right above a ramp peeling off to the left is worse
  // than one that does not point at all. Asked for, and the direction is free: the
  // ramp already knows which side it is on, the deck's geometry is baked from it,
  // and the board is turned in toward the driver by the same sign.
  //
  // It is still one notation. `<--home--` is the same edge written the other way
  // round, which is exactly what WRL means by it -- the arrowhead is the end you
  // arrive at, and on this side of the road you arrive to your left.
  const name = to?.name ?? r.to
  row(r.side < 0 ? `<--${name}--` : `--${name}-->`, 58, 0.42, ACC_CSS)
  row(`[${net?.name ?? '?'}]`, 48, 0.66, crosses ? COOL_CSS : '#8a97ab')
  row(to?.open ? `exit ${r.at + 1}` : 'closed', 32, 0.87, '#6b7689')
  return rows
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
  canvas.height = 320
  // NOT a bare CanvasTexture: 512x320 is not a power of two, and this board
  // repaints as you drive. See world.js canvasTexture.
  const tex = canvasTexture(THREE, canvas)

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
  // same colour as the road apart from the road.
  //
  // THEY WERE THE WHITE, and it took measuring the materials to see it. The deck was
  // reported twice as "not blending in with the road", and both times the suspect
  // was the deck -- whose material turns out to be byte-identical to the road's:
  // MeshStandardMaterial, 0x11131f, roughness 0.9, normals up. What was bright was
  // these: 0x8a97ab on a MeshBasicMaterial, which is UNLIT, so it renders at its full
  // value while the tarmac beside it is a dark colour multiplied by the lights. Two
  // 5-wide strips seen almost edge-on merge into one band, and that band was the
  // brightest thing on the road.
  //
  // So they are LIT now, in the same family as the tarmac, one step up from it. An
  // edge line is paint on a road, not a light strip beside one.
  const edges = new THREE.Group()
  for (const e of [-1, 1]) {
    edges.add(
      new THREE.Mesh(
        ribbon(
          () => 5,
          (t) => (e * (RAMP_W_NEAR + (RAMP_W_FAR - RAMP_W_NEAR) * t)) / 2,
          side,
        ),
        new THREE.MeshStandardMaterial({ color: 0x22263a, roughness: 0.95, side: THREE.DoubleSide }),
      ),
    )
  }

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: false }),
  )
  // TURNED IN TOWARD THE DRIVER, the same way and for the same reason a window sign
  // is: a board square to the road is edge-on until you are level with it, and by
  // then you have passed the turn it is announcing.
  board.rotation.y = -side * 0.42
  board.userData.gantryAction = action

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(7, BOARD_Y, 7),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 }),
  )

  scene.add(deck)
  scene.add(edges)
  scene.add(board)
  scene.add(post)
  // The side is remembered on the part because the deck's geometry is BAKED with it
  // -- see syncRamps for why that means a flip is a rebuild and not a reposition.
  return { deck, edges, board, post, tex, canvas, key: '', rows: null, side }
}

function placeRamp(part, district, x, r) {
  const z0 = dashZ(r.at)
  // The deck and its lines are both built in the ramp's own frame with the mouth at
  // the origin, so placing a ramp is moving that frame. Nothing is rebuilt when the
  // road it hangs off moves sideways.
  for (const m of [part.deck, part.edges]) m.position.set(x, 0, z0)
  const sx = r.side > 0 ? 1 : -1
  const bx = x + sx * BOARD_STAND_X
  const bz = z0 + BOARD_STAND_Z
  part.board.position.set(bx, ROAD_Y + BOARD_Y + BOARD_H / 2, bz)
  part.post.position.set(bx, ROAD_Y + BOARD_Y / 2, bz)

  // Redrawn only when what it says changes. A canvas repaint per frame per ramp
  // is the kind of cost that does not show up in a frame time until there are
  // eight of them.
  const to = ws.get(r.to)
  // EVERY NAME THE BOARD PRINTS IS IN THE KEY, including the two it prints about
  // networks. The from-network was not, and it is a name that can be edited from the
  // map -- a board keyed on less than it draws is a board that keeps saying the old
  // thing until something unrelated happens to change.
  const key = [
    r.to,
    to?.name,
    to?.open,
    ws.tenantOf(r.to),
    ws.tenant(ws.tenantOf(r.to))?.name,
    // The whole top row, not the pieces of it -- the track, how far down the road
    // you are, the window count and the network name are four things that each move
    // on their own, and listing them separately is four chances to forget one. The
    // board redraws when what it SAYS changes.
    whereRow(district),
    r.at,
    // The side, because the arrow points from it now. A flip already drops the part
    // and rebuilds it -- the deck's vertices are baked with the side (see syncRamps)
    // -- so a fresh canvas is repainted either way and this line changes nothing
    // today. It is here so the key stays a description of what the board SAYS
    // rather than a list that happens to be complete because of a rule two
    // functions away.
    r.side,
  ].join('|')
  if (key !== part.key) {
    part.key = key
    part.rows = drawBoard(part.canvas, { ...r, from: district })
    part.tex.needsUpdate = true
  }
  // THE SIGN LIGHTS, THE ROAD DOES NOT.
  //
  // Hovering a ramp used to light two things at once: its sign, and its marker on
  // the centre line. Asked for the sign only -- and it is the right split, because
  // the marker is a control in its own right (press it to edit the ramp) rather than
  // a readout of the ramp, so it should answer to the pointer being on IT.
  const hot = rampHot.district === district && rampHot.at === r.at
  part.board.material.color.setHex(hot ? 0xffffff : 0xdedede)
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
  syncMark()
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
      // A FLIP IS A REBUILD, and this is the line that was missing.
      //
      // The deck and its edge lines are ribbons whose vertices are computed with the
      // side folded in -- x is negated and the winding flipped when it is built --
      // so nothing about them can be repositioned onto the other side of the road.
      // Only the board and post are placed from `side` at reconcile time, so flipping
      // one moved the SIGN across the road and left the tarmac where it was.
      //
      // It survived being tested because the check read the board's x to decide which
      // side the ramp was on: a report that asks the one part that did move whether
      // the move happened will always say yes. `__ramps().side` still reads the board
      // -- it is the honest thing to read -- and the deck now cannot disagree with it.
      if (part && part.side !== (r.side > 0 ? 1 : -1)) {
        dropRamp(part)
        entry.ramps.delete(r.at)
        part = null
      }
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
  rampHot.district = null
  rampHot.at = null
  dashHot.district = null
  dashHot.at = null
}

// Hover, so a marker reads as pressable before it is pressed. Held as two
// addresses rather than as a mesh, because the dashes are instances and there is
// no mesh to remember.
export function setRampHover(hit) {
  // A dash pad answers `dash`, never `ramp` -- the marker is a control of its own --
  // so pointing at a marker lights nothing, and pointing at the tarmac or the board
  // lights that ramp's sign.
  const action = hit ? (dashActionOf(hit) ?? hit.object?.userData?.gantryAction ?? null) : null
  const ramp = action?.kind === 'ramp' ? action : null
  rampHot.district = ramp?.district ?? null
  rampHot.at = ramp ? ramp.at : null
  // The two halves of the same move, in one owner. They are mutually exclusive by
  // construction -- one hit, and it is either a pad or it is not -- so a pointer that
  // slides from a marker onto the ramp beside it puts one out as it lights the other,
  // which two independent owners could not promise.
  const dash = action?.kind === 'dash' ? action : null
  dashHot.district = dash?.district ?? null
  dashHot.at = dash ? dash.at : null
}

// What is actually painted on the road, read off the scene rather than off the
// graph. A report that recomputed the dash positions from `dashZ` would agree
// with itself no matter what the instance matrices said.
export const rampReport = () => {
  const out = {
    district: state.district,
    // WHERE THE CURSOR IS, read off the mesh's own transform rather than off
    // `dashHot`. The claim is that a frame is drawn around the dash under the
    // pointer; a report that echoed the address the frame is placed FROM would say
    // yes even if the mesh were parked at the origin or never added to the scene.
    hoverMark: mark
      ? {
          shown: mark.visible,
          x: Math.round(mark.position.x),
          z: Math.round(mark.position.z),
          // The dash that z belongs to, worked back from the geometry -- so "the
          // frame is on dash 6" is an answer about the picture.
          onDash: mark.visible
            ? [...Array(dashCount(state.district)).keys()].find(
                (i) => Math.round(dashZ(i)) === Math.round(mark.position.z),
              ) ?? null
            : null,
          colour: mark.material.color.getHexString(),
        }
      : null,
    roads: [],
  }
  for (const [id, entry] of lines) {
    const m = new THREE.Matrix4()
    const dashes = []
    for (let i = 0; i < entry.count; i++) {
      entry.line.getMatrixAt(i, m)
      const p = new THREE.Vector3().setFromMatrixPosition(m)
      dashes.push({ at: i, z: Math.round(p.z), x: Math.round(p.x) })
    }
    out.roads.push({
      id,
      name: ws.get(id)?.name ?? id,
      // One colour for the whole line, read off the material -- there is no
      // per-instance colour any more and a report that pretended otherwise would be
      // describing a channel that no longer exists.
      lineColour: entry.line.material.color.getHexString(),
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
        // WHICH SIDE THE TARMAC IS ON, from the deck's own vertices. `side` above is
        // read off the board, and the board is the one part that is placed from
        // `side` every frame -- so it moved when a flip was only half-applied and a
        // check that asked it whether the flip had happened said yes. This asks the
        // geometry, which is the half that was wrong.
        deckSide: (() => {
          const g = part.deck.geometry
          if (!g.boundingBox) g.computeBoundingBox()
          return (g.boundingBox.max.x + g.boundingBox.min.x) / 2 > 0 ? 'right' : 'left'
        })(),
        // What the deck is actually made of, next to what the road is made of. The
        // deck reading as a white sheet rather than as tarmac has been reported twice
        // and guessed at twice; a report that says the material's own numbers is the
        // only way to stop guessing.
        deck: {
          type: part.deck.material.type,
          color: part.deck.material.color.getHexString(),
          roughness: part.deck.material.roughness,
          metalness: part.deck.material.metalness,
          side: part.deck.material.side,
          hasNormal: !!part.deck.geometry.attributes.normal,
          hasUV: !!part.deck.geometry.attributes.uv,
          firstNormal: part.deck.geometry.attributes.normal
            ? [0, 1, 2].map((i) => +part.deck.geometry.attributes.normal.array[i].toFixed(3))
            : null,
        },
        edgeColor: part.edges.children[0]?.material.color.getHexString(),
        // The hover, read off the MATERIAL rather than off `rampHot` -- the claim is
        // that the highlight follows the pointer, and a report that re-read the
        // variable the highlight is drawn from would agree with itself whatever the
        // board looked like.
        boardLit: part.board.material.color.getHexString(),
        // What the sign READS, top row first, as painted.
        says: part.rows ?? null,
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
