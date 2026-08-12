// THE GATES -- the overhead signs that span the road, and everything you can do
// to a road without being inside a window.
//
// A road has two of them, and they have different jobs:
//
//   ENTER, at the head, before the windows -- where windows are CREATED onto
//   this road, on the side you choose. You drive through it to reach the
//   windows, so it is the first thing you meet and the last thing between you
//   and an empty road.
//
//   EXIT, one clear run past the last window -- where the LANES are: one panel
//   per exit naming the workspace it leads to and counting the windows waiting
//   there, plus a panel that makes a new one. You arrive at it by finishing the
//   road, which is when leaving is the thing you want.
//
// Putting both at the head, which is where the first build put the only one,
// made the sign furniture standing among the windows. A gate you pass through is
// a different object from a sign you look at, and the road is long enough to
// have both.
//
// Blue for the entrance and green for the exits, because that is what those
// colours mean on a motorway and neither needs explaining.
//
// The panels are canvas textures rather than geometry text. Text as geometry
// needs a font loader, a typeface asset and a build step; a 2D canvas is already
// in the page, redraws in microseconds, and is the only path that can show a
// number that changes -- which the window count does, constantly.
//
// WHAT THIS MODULE DOES NOT DO: it never acts. It hangs an ACTION on each panel
// and reports which one a mesh carries; Travel decides what a click means and
// shell.js is the only thing that can talk to the compositor. A sign that moved
// the camera or launched a process itself would be a second answer to a question
// that already has an owner.

import * as THREE from 'three'
import { signs, ACC, COOL, ENTER_Z, exitZOf, windowAtOn } from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'

// The enter gate's back panel needs to know where back IS. Travel owns the
// history; this only reads it, the same way it reads the window counts.
let backOf = () => null
export function attachBack(fn) {
  backOf = fn
}

let scene = null
export function attachGantry(c) {
  scene = c.scene
}

// The beam sits lower than it used to, to make room ABOVE it for the name board.
// At GANTRY_VIEW (440 away) the frustum is 488 tall about y=105, so its top edge is
// y=349 -- and a board hung over a beam at 300 was clipped, which is the trap the
// first gantry fell into.
//
// IT CAME DOWN AGAIN, 262 -> 234, when the board went to two rows. The board's top
// edge is BEAM_Y + 12 + BOARD_H = 328, twenty-one units clear; at 262 with a 72-tall
// board it was 346, which is inside the frustum by three units and reads on screen
// as a sign jammed against the top of the window.
const BEAM_Y = 234
// AND BOARD_H IS BEAM_W / 4, WHICH IS NOT A COINCIDENCE. The board's canvas is
// 1024x256 -- powers of two, because a WebGL1 texture that is not is refused
// mipmaps -- so a quad of any other ratio stretches the text. 330/82 is 4.02
// against the canvas's 4.00, so the glyphs are drawn round and stay round.
const BOARD_H = 82
// The gantry spans THE ROAD and nothing wider. It used to be 400 across with
// 190-wide panels, which put its outer edge over the windows standing beside the
// road -- see SIGN_OFFSET in rrabbit.js for the measurement. Uprights sit at the
// kerb (the road is 320 wide) and the panels stay inside them.
const BEAM_W = 330
const SPAN_X = 158
const PANEL_MAX_W = 130
// A LANE PANEL HAS A FLOOR. It used to be `usable / count`, so every exit added
// made every panel narrower and there was no number at which the row said "no" --
// eight exits gave eight slivers with a word in each. A sign you cannot read is
// not a smaller sign, it is a sign that has stopped working.
//
// So the row wraps instead: as many columns as fit at the minimum width, then
// the next row underneath, up to VISIBLE_ROWS -- and past that it scrolls,
// because a gate that grows downward eventually grows into the road.
const PANEL_MIN_W = 96
const PANEL_MIN_H = 44
const ROW_GAP = 6
const VISIBLE_ROWS = 3
// The scrollbar: its own width, plus the gap either side that keeps it off the
// panels and inside the upright.
const BAR_W = 6
const BAR_TOTAL = 16

const GREEN = '#0b6b3a'
const BLUE = '#12386e'
const GREY = '#2a2f3a'
// Brown, the way a motorway signs a place you turn off for rather than a route
// you continue on. The reloop is neither an exit nor an entrance.
const LOOP = '#5a3a1e'
const ACC_CSS = '#' + ACC.toString(16).padStart(6, '0')
const COOL_CSS = '#' + COOL.toString(16).padStart(6, '0')

// `${workspaceId}:${kind}` -> { group, kind, panels: [...] }
const gates = new Map()

// ------------------------------------------------------------- the lane panel

function drawPanel(canvas, p) {
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  const live = p.tone !== 'barred'
  g.clearRect(0, 0, W, H)
  g.fillStyle =
    p.tone === 'enter' || p.tone === 'back' ? BLUE : p.tone === 'loop' ? LOOP : p.tone === 'barred' ? GREY : GREEN
  g.fillRect(0, 0, W, H)
  g.strokeStyle = live ? '#ffffff' : '#8b93a3'
  g.lineWidth = 10
  g.strokeRect(16, 16, W - 32, H - 32)

  g.textAlign = 'center'
  g.fillStyle = live ? '#ffffff' : '#8b93a3'
  g.font = 'bold 70px ui-monospace, monospace'
  g.fillText(p.title, W / 2, H * 0.44)
  g.font = '36px ui-monospace, monospace'
  g.fillText(p.sub, W / 2, H * 0.72)

  if (p.tone === 'barred') {
    // A CLOSED WORKSPACE IS A BARRED EXIT, not a missing one. Leaving it off the
    // gate would make a workspace that exists look like one that does not, and
    // there would then be nothing to click to open it.
    g.strokeStyle = ACC_CSS
    g.lineWidth = 12
    g.beginPath()
    g.moveTo(40, H - 40)
    g.lineTo(W - 40, 40)
    g.stroke()
  }
}

// WHICH ROAD IS THIS. Reported as missing: the enter gate said what its two
// buttons did and never said where you were, so the one sign you meet on
// arriving at a workspace was the one that could not tell you which workspace it
// was. It goes on BOTH gates -- the question is just as live when you are
// leaving -- and pressing it opens the map (see makeBoard).
//
// IT NAMES THE TRACK AND THE NETWORK TOO, and neither is decoration. Ten tracks
// can be parked on the same road, so "which road am I on" stopped being the whole
// answer to "where am I": switching from track 2 to track 5 while both sit on
// `home` changes everything about what `back` will do and nothing about the view.
// The network is the same argument one level out -- two networks can each have a
// road called `home` with two windows on it, and taking a ramp between them
// changes every road in the world.
//
// WHAT THIS COST BEFORE IT WAS MEASURED: each of the three was drawn at its own
// alignment -- track left at 26, label centred at W/2, network right at W-26. Three
// independent alignments on one line is not a layout, it is three claims about the
// same pixels, and the longest one wins. `home · 2 windows` already touched `main`;
// `open sentience` printed straight through the middle of the label. Reported. See
// drawBoard for the shape that replaced it.

const widthOf = (g, text, px, weight = 'bold') => {
  g.font = `${weight} ${px}px ui-monospace, monospace`
  return g.measureText(text).width
}

// THE BOARD READS LIKE A WRL LINE, IN TWO COLUMNS OF TWO ROWS.
//
//     T&R      --home-->
//     1:2-2    [main]
//
// It was `1   home   ·   2 windows   main` -- three facts in the wrong grammar, and
// the sentence a road sign wants is not a list. Asked for the WRL shape instead,
// which says strictly more:
//
//   T&R        whose road this is
//   1:2-2      track 1, at window 2 of 2. The middle number is the one that was
//              missing entirely: how far down the road you have got.
//   --home-->  the road, in WRL's own edge notation -- an arrow, because a road IS
//              an edge, and this shell's whole argument is that the road and the
//              graph are one drawing at two zooms.
//   [main]     the network, in WRL's box brackets -- the notation WRL uses for a
//              named thing you are inside of, which is what a network is.
//
// AND IT IS TWO ROWS BECAUSE ONE ROW CROWDED. On a single line the four fields ran
// together the moment a road or a network had a long name -- reported -- and no
// amount of measuring fixes crowding, it only stops it being overprinting. Rows
// give each field its own space to be long in: the ident column is a fixed width,
// the route column gets everything else, and the two never share a pixel.
//
// The board grew 46 -> 82 units tall to carry them, and the beam came down 262 ->
// 234 to keep it inside the frame. See BEAM_Y and BOARD_H for the two measurements
// that decide those numbers; neither is a taste.
const IDENT = 'T&R'
const BOARD_PAD_X = 30
const BOARD_COL_GAP = 34
const IDENT_FONT = 92
const NUMS_FONT = 62
const ROUTE_MAX = 76
const ROUTE_MIN = 34
const NET_FONT = 62
// Where the two rows sit in the canvas. Row one carries the names, row two the
// numbers and the network -- so reading down the left is "whose, and where in it",
// and reading down the right is "which road, in which network".
const ROW_1 = 0.36
const ROW_2 = 0.79

function drawBoard(canvas, { name, count, at, track, network }) {
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  g.clearRect(0, 0, W, H)
  g.fillStyle = '#0a0d16'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = ACC_CSS
  g.lineWidth = 6
  g.strokeRect(3, 3, W - 6, H - 6)
  g.textBaseline = 'middle'
  g.textAlign = 'left'

  // ---- the ident column. `T&R` dim, because it is the same on every board in the
  // world; the numbers cool, which is this shell's colour for "which of several".
  const nums = `${track}:${at}-${count}`
  const identW = widthOf(g, IDENT, IDENT_FONT)
  const numsW = widthOf(g, nums, NUMS_FONT)
  const colW = Math.max(identW, numsW)

  g.fillStyle = '#8a97ab'
  g.font = `bold ${IDENT_FONT}px ui-monospace, monospace`
  g.fillText(IDENT, BOARD_PAD_X, H * ROW_1)
  g.fillStyle = COOL_CSS
  g.font = `bold ${NUMS_FONT}px ui-monospace, monospace`
  g.fillText(nums, BOARD_PAD_X, H * ROW_2)

  // A rule between the columns, so they read as two fields rather than as four
  // words that happen to be near each other.
  const divX = BOARD_PAD_X + colW + BOARD_COL_GAP / 2
  g.strokeStyle = '#24304a'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(divX, 22)
  g.lineTo(divX, H - 22)
  g.stroke()

  // ---- the route column, everything that is left. Each row shrinks and elides
  // into the same width, so a long road name and a long network name cannot reach
  // each other -- they are on different rows.
  const left = divX + BOARD_COL_GAP / 2
  const room = Math.max(80, W - BOARD_PAD_X - left)

  let px = ROUTE_MAX
  const road = (n) => `--${n}-->`
  while (px > ROUTE_MIN && widthOf(g, road(name), px) > room) px -= 2
  let cut = name
  while (cut.length > 1 && widthOf(g, road(cut + '\u2026'), px) > room) cut = cut.slice(0, -1)
  if (cut !== name) cut += '\u2026'
  g.fillStyle = ACC_CSS
  g.font = `bold ${px}px ui-monospace, monospace`
  g.fillText(road(cut), left, H * ROW_1)

  if (network) {
    let net = String(network)
    const tail = (n) => `[${n}]`
    let npx = NET_FONT
    while (npx > ROUTE_MIN && widthOf(g, tail(net), npx) > room) npx -= 2
    while (net.length > 1 && widthOf(g, tail(net + '\u2026'), npx) > room) net = net.slice(0, -1)
    if (net !== String(network)) net += '\u2026'
    g.fillStyle = COOL_CSS
    g.font = `bold ${npx}px ui-monospace, monospace`
    g.fillText(tail(net), left, H * ROW_2)
  }
}

function makeBoard() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BEAM_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )
  mesh.position.set(0, BEAM_Y + BOARD_H / 2 + 12, 6)
  // THE BOARD IS A BUTTON, on both gates. It said where you were and did
  // nothing, which made it the largest, most legible thing on the road that
  // could not be pressed -- and the map is the one control every road wants
  // within reach at both ends. Asked for at the beginning and the end, which is
  // exactly the two gates.
  mesh.userData.gantryAction = { kind: 'map' }
  return { mesh, tex, canvas }
}

function makePanelTex(cw, ch, w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
  )
  return { mesh, tex, canvas }
}

// Panels are a unit quad and get their real size from placePanels, so a scroll
// or a re-wrap never has to touch geometry.
const makePanel = () => makePanelTex(512, 256, 1, 1)

// ------------------------------------------------------------- what to show
//
// The panel row for a gate, as DATA. Working out what a sign says is a different
// job from hanging it, and keeping them apart is what lets __gantry() report the
// sign's own state instead of re-deriving it from the graph.
const countIn = (id) => [...signs.values()].filter((s) => s.district === id).length

function enterRow() {
  const row = []
  // BACK IS AT THE ENTRANCE because the entrance is where you arrive, and the
  // moment you most want the road you just left is the moment you realise this
  // is not it. It names its destination rather than saying "back", so it is a
  // decision you can make without having to remember the trail.
  const back = backOf()
  if (back && ws.get(back)) {
    row.push({
      key: `back:${back}:${ws.get(back).name}`,
      action: { kind: 'back' },
      title: '‹ back',
      sub: ws.get(back).name,
      tone: 'back',
    })
  }
  // Left and right, because "insert a window on the left" is the thing that was
  // asked for and a launcher with no side would have to invent one.
  row.push(
    { key: 'open:-1', action: { kind: 'open', side: -1 }, title: '‹ left', sub: 'open window', tone: 'enter' },
    { key: 'open:1', action: { kind: 'open', side: 1 }, title: 'right ›', sub: 'open window', tone: 'enter' },
  )
  return row
}

function exitRow(id) {
  const row = ws.exitsOf(id).map((to) => {
    const dest = ws.get(to)
    const n = countIn(to)
    return {
      key: `exit:${to}:${dest.open}:${n}:${dest.name}`,
      action: { kind: 'exit', to },
      title: dest.name,
      sub: dest.open ? (n === 1 ? '1 window' : `${n} windows`) : 'closed',
      tone: dest.open ? 'exit' : 'barred',
    }
  })
  // THE RELOOP. Every other panel here leaves the road; this one is the road
  // turning back on itself, which is the thing you want when you have driven to
  // the end of it and the windows are all behind you. It is deliberately the
  // same shape as an exit, because taking it feels the same -- you pick a lane
  // and you come out at an entrance. It just happens to be this one's.
  row.push({ key: 'loop', action: { kind: 'reloop' }, title: '⟲ back', sub: 'to the entrance', tone: 'loop' })
  row.push({ key: 'new', action: { kind: 'newLane' }, title: '+ lane', sub: 'new workspace', tone: 'exit' })
  return row
}

// ---------------------------------------------------------------- the gantry

function buildGate(kind) {
  const group = new THREE.Group()
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a5262, roughness: 0.6, metalness: 0.3 })

  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(16, BEAM_Y + 30, 16), steel)
    leg.position.set(sx * SPAN_X, (BEAM_Y - 30) / 2, 0)
    group.add(leg)
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(BEAM_W, 18, 18), steel)
  beam.position.set(0, BEAM_Y, 0)
  group.add(beam)

  // A thin lit strip under the beam, so a gate reads as a structure at a glance
  // rather than as three bars that happen to meet -- and so the two gates are
  // told apart before either is close enough to read.
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(BEAM_W, 3, 3),
    new THREE.MeshBasicMaterial({ color: kind === 'enter' ? COOL : ACC, toneMapped: false }),
  )
  trim.position.set(0, BEAM_Y - 12, 8)
  group.add(trim)

  const board = makeBoard()
  group.add(board.mesh)

  const flat = (color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, toneMapped: false }))
    m.visible = false
    group.add(m)
    return m
  }
  const bar = { track: flat(0x0a0f1a), thumb: flat(ACC) }

  scene.add(group)
  return { group, kind, panels: [], board, boardKey: null, bar, scroll: 0 }
}

// How the row breaks into a grid. Pure arithmetic, so the layout and the thing
// that draws it cannot disagree.
//
// THE BAR TAKES ITS SPACE FROM THE PANELS, like a scrollbar anywhere else, which
// is why this is computed twice: once to find out whether there is anything to
// scroll, and again with the width the bar leaves if there is. Once, not until
// it settles -- narrowing can only ever add rows, so a second pass cannot take
// the bar away again, and a loop would be solving a problem that does not exist.
function layoutIn(usable, n) {
  const cols = Math.max(1, Math.min(n, Math.floor(usable / PANEL_MIN_W)))
  const pw = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, usable / cols))
  return { cols, pw, ph: Math.max(PANEL_MIN_H, pw / 2), rows: Math.ceil(n / cols) }
}

function grid(n) {
  const full = BEAM_W * 0.95
  let g = layoutIn(full, n)
  const bar = g.rows > VISIBLE_ROWS
  if (bar) g = layoutIn(full - BAR_TOTAL, n)
  return { ...g, bar, maxScroll: Math.max(0, g.rows - VISIBLE_ROWS) }
}

// Positioning is separate from building, because scrolling moves panels without
// changing what any of them says.
function placePanels(gate) {
  const g = grid(gate.panels.length)
  gate.grid = g
  gate.scroll = Math.min(gate.scroll ?? 0, g.maxScroll)
  gate.panels.forEach((p, i) => {
    const r = Math.floor(i / g.cols)
    const c = i % g.cols
    // Centre each row on its own count, so a last row of one sits in the middle
    // rather than hanging off the left upright.
    const inRow = Math.min(g.cols, gate.panels.length - r * g.cols)
    const x0 = -(g.pw * inRow) / 2 + g.pw / 2
    const shown = r - gate.scroll
    p.mesh.visible = shown >= 0 && shown < VISIBLE_ROWS
    p.mesh.scale.set(g.pw, g.ph, 1)
    p.mesh.position.set(x0 + c * g.pw, BEAM_Y - 18 - g.ph / 2 - shown * (g.ph + ROW_GAP), 6)
  })
  placeBar(gate, g)
}

// A SCROLLBAR RATHER THAN A SENTENCE.
//
// The strip used to read `v 1  scroll here`, which says there is more and cannot
// say how much more -- a bar says both at once and says it in the shape everyone
// already reads: how far down you are, and how much of the whole you are looking
// at. It is two flat quads and no text, so it also stops being something that
// has to be redrawn every time a number under it changes.
function placeBar(gate, g) {
  const on = g.maxScroll > 0
  gate.bar.track.visible = on
  gate.bar.thumb.visible = on
  if (!on) return

  const trackH = VISIBLE_ROWS * g.ph + (VISIBLE_ROWS - 1) * ROW_GAP
  const top = BEAM_Y - 18
  const x = (g.pw * g.cols) / 2 + BAR_TOTAL / 2

  // z=12, not 6. The uprights are BoxGeometry 16 deep, so they occupy z -8..8 --
  // a bar at 6 is INSIDE the leg it sits beside, which is exactly as visible as
  // not drawing it. The panels get away with 6 because nothing is behind them.
  gate.bar.track.scale.set(BAR_W, trackH, 1)
  gate.bar.track.position.set(x, top - trackH / 2, 12)

  // The thumb is the fraction of the rows you can see, sat at the fraction you
  // have scrolled past -- so a gate with one row hidden shows a long thumb near
  // the top, and one with ten shows a short one that actually travels.
  const thumbH = Math.max(8, (trackH * VISIBLE_ROWS) / g.rows)
  const travel = trackH - thumbH
  const t = g.maxScroll ? gate.scroll / g.maxScroll : 0
  gate.bar.thumb.scale.set(BAR_W, thumbH, 1)
  gate.bar.thumb.position.set(x, top - t * travel - thumbH / 2, 13)
}

function syncGate(id, kind, z, row) {
  const gkey = `${id}:${kind}`
  let gate = gates.get(gkey)
  if (!gate) {
    gate = buildGate(kind)
    gates.set(gkey, gate)
  }
  gate.group.position.set(ws.laneX(id), 0, z)

  const w = ws.get(id)
  const here = countIn(id)
  // The track has to be IN THE KEY or the board never redraws when you switch --
  // the name and the count are both unchanged by switching tracks, which is the
  // whole case this was added for.
  // JUST THE NUMBER, not `labelOf`. The board's format is `track:at-total` and a
  // track that has been named would put a word inside a number.
  const trackLabel = String(tracks.activeIndex())
  // The network belongs in the key for the same reason the track does, and even
  // more so: two networks can have a road with the same name and the same window
  // count, so a key without it would leave the board naming the network you left.
  const netLabel = ws.activeTenantName()
  // AND `at` HAS TO BE IN THE KEY, which makes this the first thing on the board
  // that changes while you are merely scrolling. It is one canvas repaint per window
  // you drive past -- not per frame, because the key only moves when the count does.
  const at = windowAtOn(id)
  const bkey = `${w?.name}:${here}:${at}:${trackLabel}:${netLabel}`
  if (bkey !== gate.boardKey) {
    gate.boardKey = bkey
    gate.boardName = w?.name ?? id
    gate.boardCount = here
    gate.boardAt = at
    gate.boardTrack = trackLabel
    gate.boardNetwork = netLabel
    drawBoard(gate.board.canvas, {
      name: gate.boardName,
      count: here,
      at,
      track: trackLabel,
      network: netLabel,
    })
    gate.board.tex.needsUpdate = true
  }

  // Rebuild the row only when what it SAYS changes -- `key` folds the action,
  // the name, the count and the open state into one string, so a road whose
  // window count is steady costs one comparison per panel per frame and nothing
  // else.
  const same = gate.panels.length === row.length && gate.panels.every((p, i) => p.key === row[i].key)
  if (!same) {
    const reusable = gate.panels.length === row.length
    if (!reusable) {
      for (const p of gate.panels) {
        gate.group.remove(p.mesh)
        p.mesh.geometry.dispose()
        p.mesh.material.dispose()
        p.tex.dispose()
      }
      gate.panels = []
      row.forEach(() => {
        const p = makePanel()
        gate.group.add(p.mesh)
        gate.panels.push(p)
      })
    }
    row.forEach((spec, i) => {
      const p = gate.panels[i]
      Object.assign(p, spec)
      // What a click on this mesh MEANS. Read back by actionOf(); the mesh is
      // the only thing a raycast hands you.
      p.mesh.userData.gantryAction = spec.action
      drawPanel(p.canvas, spec)
      p.tex.needsUpdate = true
    })
  }
  placePanels(gate)
  return gkey
}

// Reconcile both gates on every open road with the graph. Safe to call every
// frame: when nothing has changed the work is one string compare per panel.
//
// It runs in the frame loop rather than once because the numbers on the signs
// are live. A sign is adopted lazily -- a window can appear on a road seconds
// after its gate was built -- and a lane that says "0 windows" about a road with
// two on it is worse than a lane that says nothing.
export function syncGantries() {
  if (!scene) return
  const want = new Set()

  for (const w of ws.list()) {
    if (!w.open) continue
    want.add(syncGate(w.id, 'enter', ENTER_Z, enterRow()))

    // The exit gate stands past the LAST window, so it moves down the road as
    // the road fills up.
    want.add(syncGate(w.id, 'exit', exitZOf(w.id), exitRow(w.id)))
  }

  for (const [k, gate] of [...gates]) {
    if (want.has(k)) continue
    scene.remove(gate.group)
    gate.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    for (const p of gate.panels) p.tex.dispose()
    gate.board.tex.dispose()
    gates.delete(k)
  }
}

// ------------------------------------------------------------- what Travel asks

export function gantryMeshes() {
  const out = []
  // Only what is ON the gate. three raycasts a mesh you hand it directly whether
  // or not it is visible, so a scrolled-off lane would still take clicks through
  // the ones drawn over it.
  for (const gate of gates.values()) {
    for (const p of gate.panels) if (p.mesh.visible) out.push(p.mesh)
    // The board too, now that pressing it means something. It is never scrolled
    // off -- it is not on the panel grid -- so it needs no visibility test.
    if (gate.board?.mesh) out.push(gate.board.mesh)
  }
  return out
}

export const actionOf = (mesh) => mesh?.userData?.gantryAction ?? null

// Scroll the gate a given panel belongs to. Returns false when there is nothing
// off-screen, so the wheel falls through to driving the road -- a gate that fits
// must not swallow the scroll that moves you.
export function scrollGateOf(mesh, delta) {
  for (const gate of gates.values()) {
    if (!gate.panels.some((p) => p.mesh === mesh)) continue
    const max = gate.grid?.maxScroll ?? 0
    if (max === 0) return false
    const next = Math.min(max, Math.max(0, (gate.scroll ?? 0) + Math.sign(delta)))
    if (next === gate.scroll) return false
    gate.scroll = next
    placePanels(gate)
    return true
  }
  return false
}

// Hover. A panel that does nothing when you point at it does not read as
// clickable, and there is no cursor out here in the scene -- so the panel
// brightens instead, which is the same signal a real sign gives when your
// headlights reach it.
let hovered = null
export function setHovered(mesh) {
  if (hovered === mesh) return
  if (hovered) hovered.material.color.setHex(0xffffff)
  hovered = mesh && actionOf(mesh) ? mesh : null
  // MeshBasicMaterial multiplies its map by `color`, so >1 is a real brighten
  // rather than a wash -- the texture keeps its own contrast.
  if (hovered) hovered.material.color.setRGB(1.45, 1.45, 1.45)
}

// What the gates are actually saying, read off the panels rather than off the
// graph -- a report that re-derived the answer would agree with the graph by
// construction and prove nothing about what is on the sign.
export const gantryReport = () =>
  [...gates.entries()].map(([k, gate]) => ({
    gate: k,
    kind: gate.kind,
    board: gate.boardKey,
    rows: gate.grid?.rows ?? 0,
    cols: gate.grid?.cols ?? 0,
    scroll: gate.scroll ?? 0,
    bar: gate.bar?.track?.visible
      ? {
          thumbFraction: +(gate.bar.thumb.scale.y / gate.bar.track.scale.y).toFixed(3),
          atTop: gate.bar.thumb.position.y === gate.bar.track.position.y + gate.bar.track.scale.y / 2 - gate.bar.thumb.scale.y / 2,
        }
      : null,
    shown: gate.panels.filter((p) => p.mesh.visible).length,
    z: Math.round(gate.group.position.z),
    x: Math.round(gate.group.position.x),
    panels: gate.panels.map((p) => ({ title: p.title, sub: p.sub, tone: p.tone, action: p.action })),
  }))
