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
import { signs, ACC, COOL, ENTER_Z, exitZOf } from './world.js'
import * as ws from './workspaces.js'

let scene = null
export function attachGantry(c) {
  scene = c.scene
}

// The beam sits lower than it used to, to make room ABOVE it for the name board.
// At 440 units away the frustum top is y=349, so a board hung over a beam at 300
// would have been clipped -- the same trap the first gantry fell into.
const BEAM_Y = 262
const BOARD_H = 46
// The gantry spans THE ROAD and nothing wider. It used to be 400 across with
// 190-wide panels, which put its outer edge over the windows standing beside the
// road -- see SIGN_OFFSET in rrabbit.js for the measurement. Uprights sit at the
// kerb (the road is 320 wide) and the panels stay inside them.
const BEAM_W = 330
const SPAN_X = 158
const PANEL_MAX_W = 130

const GREEN = '#0b6b3a'
const BLUE = '#12386e'
const GREY = '#2a2f3a'
const ACC_CSS = '#' + ACC.toString(16).padStart(6, '0')

// `${workspaceId}:${kind}` -> { group, kind, panels: [...] }
const gates = new Map()

// ------------------------------------------------------------- the lane panel

function drawPanel(canvas, p) {
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  const live = p.tone !== 'barred'
  g.clearRect(0, 0, W, H)
  g.fillStyle = p.tone === 'enter' ? BLUE : p.tone === 'barred' ? GREY : GREEN
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
// leaving -- and it is deliberately not a panel: it carries no action, it is not
// clickable, and it must not look like something that is.
function drawBoard(canvas, name, count) {
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  g.clearRect(0, 0, W, H)
  g.fillStyle = '#0a0d16'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = ACC_CSS
  g.lineWidth = 6
  g.strokeRect(3, 3, W - 6, H - 6)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = ACC_CSS
  g.font = 'bold 62px ui-monospace, monospace'
  g.fillText(`${name}   ·   ${count === 1 ? '1 window' : `${count} windows`}`, W / 2, H / 2 + 4)
}

function makeBoard() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 128
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BEAM_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )
  mesh.position.set(0, BEAM_Y + BOARD_H / 2 + 12, 6)
  return { mesh, tex, canvas }
}

function makePanel() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )
  return { mesh, tex, canvas }
}

// ------------------------------------------------------------- what to show
//
// The panel row for a gate, as DATA. Working out what a sign says is a different
// job from hanging it, and keeping them apart is what lets __gantry() report the
// sign's own state instead of re-deriving it from the graph.
const countIn = (id) => [...signs.values()].filter((s) => s.district === id).length

function enterRow() {
  // Left and right, because "insert a window on the left" is the thing that was
  // asked for and a launcher with no side would have to invent one.
  return [
    { key: 'open:-1', action: { kind: 'open', side: -1 }, title: '‹ left', sub: 'open window', tone: 'enter' },
    { key: 'open:1', action: { kind: 'open', side: 1 }, title: 'right ›', sub: 'open window', tone: 'enter' },
  ]
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

  scene.add(group)
  return { group, kind, panels: [], board, boardKey: null }
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
  const bkey = `${w?.name}:${here}`
  if (bkey !== gate.boardKey) {
    gate.boardKey = bkey
    gate.boardName = w?.name ?? id
    gate.boardCount = here
    drawBoard(gate.board.canvas, gate.boardName, here)
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
      const pw = Math.min(PANEL_MAX_W, (BEAM_W * 0.95) / row.length)
      const ph = pw / 2
      const x0 = -(pw * row.length) / 2 + pw / 2
      row.forEach((_, i) => {
        const p = makePanel()
        p.mesh.scale.set(pw, ph, 1)
        p.mesh.position.set(x0 + i * pw, BEAM_Y - 18 - ph / 2, 6)
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
  for (const gate of gates.values()) for (const p of gate.panels) out.push(p.mesh)
  return out
}

export const actionOf = (mesh) => mesh?.userData?.gantryAction ?? null

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
    z: Math.round(gate.group.position.z),
    x: Math.round(gate.group.position.x),
    panels: gate.panels.map((p) => ({ title: p.title, sub: p.sub, tone: p.tone, action: p.action })),
  }))
