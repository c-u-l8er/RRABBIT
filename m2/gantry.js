// THE GANTRY -- the overhead sign that spans the road, and the junction.
//
// A workspace's exits are the one thing about the road you could not see from
// the road. M4 put a gateway arch at the head of each street "so a district is
// identifiable from the overview without reading anything", which was true and
// which made it useless at eye level: from the road it was a bare crossbar with
// no uprights and nothing to say it was a gateway, so it got hidden (see the
// frame loop). Hiding it did not restore what it was for.
//
// This is that purpose done properly. A motorway gantry spans YOUR road and
// carries ONE LANE PANEL PER EXIT, each naming where it goes and how many
// windows are waiting there. Clicking a lane drives you down it. It is a sign in
// the world, not an overlay on the screen -- so it obeys the same rules as
// everything else here: it stands somewhere, it is occluded by what is in front
// of it, and you read it by looking at it.
//
// The panels are canvas textures rather than geometry text. Text as geometry
// needs a font loader, a typeface asset and a build step; a 2D canvas is already
// in the page, redraws in microseconds, and is the only path that can show a
// number that changes -- which the window count does, constantly.
//
// WHAT THIS MODULE DOES NOT DO: it never decides where you go. It reports which
// exit a mesh belongs to and lets Travel fly, because navigating is Travel's
// question and a sign that moved the camera itself would be a second answer to
// it. See travel.js.

import * as THREE from 'three'
import { signs, ACC, COOL } from './world.js'
import * as ws from './workspaces.js'

let scene = null
export function attachGantry(c) {
  scene = c.scene
}

// Where the gantry stands on its road, and how big.
//
// z is AHEAD of the driving pose (camera at z = 260 + roadZ, looking to -640) so
// that you drive under it, and it stands BEFORE the first window (milepost 1 is
// at z = -260) because a direction sign you reach after the junction is a sign
// you did not need.
//
// The distance is measured, not chosen for looks. At 320 units away the
// 58-degree frustum is only 355 units tall about y=105 and a beam at y=300 was
// clipped off the top of the frame -- the first build put the panels on screen
// and the structure holding them outside it. At 440 the frustum is 488 tall, so
// the whole gantry is in shot with the panels in the upper third, which is where
// a motorway sign sits when you are under way.
const GANTRY_Z = -180
const BEAM_Y = 300
// The gantry spans THE ROAD and nothing wider. It used to be 400 across with
// 190-wide panels, which put its outer edge over the windows standing beside the
// road -- see SIGN_OFFSET in rrabbit.js for the measurement. Uprights sit at the
// kerb (the road is 320 wide) and the panels stay inside them.
const BEAM_W = 330
const SPAN_X = 158
const PANEL_MAX_W = 130

// id -> { group, panels: [{ mesh, to, count, open, tex, canvas }] }
const gantries = new Map()

// ------------------------------------------------------------- the lane panel

const ACC_CSS = '#' + ACC.toString(16).padStart(6, '0')

// Motorway green with a white border, because that is what a direction sign
// looks like and the whole point is that it needs no explaining.
function drawPanel(canvas, name, count, open) {
  const g = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  g.clearRect(0, 0, W, H)
  g.fillStyle = open ? '#0b6b3a' : '#2a2f3a'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = open ? '#ffffff' : '#8b93a3'
  g.lineWidth = 10
  g.strokeRect(16, 16, W - 32, H - 32)

  g.textAlign = 'center'
  g.fillStyle = open ? '#ffffff' : '#8b93a3'
  g.font = 'bold 74px ui-monospace, monospace'
  g.fillText(name, W / 2, H * 0.44)

  g.font = '38px ui-monospace, monospace'
  if (!open) {
    // A CLOSED WORKSPACE IS A BARRED EXIT, not a missing one. Leaving it off the
    // gantry would make a workspace that exists look like one that does not,
    // and there would then be nothing to click to open it.
    g.fillText('closed', W / 2, H * 0.72)
    g.strokeStyle = ACC_CSS
    g.lineWidth = 12
    g.beginPath()
    g.moveTo(40, H - 40)
    g.lineTo(W - 40, 40)
    g.stroke()
  } else {
    g.fillText(count === 1 ? '1 window' : `${count} windows`, W / 2, H * 0.72)
  }
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

// ---------------------------------------------------------------- the gantry

function buildGantry(id) {
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

  // A thin lit strip under the beam, so the gantry reads as a structure at a
  // glance rather than as three bars that happen to meet.
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(BEAM_W, 3, 3),
    new THREE.MeshBasicMaterial({ color: COOL, toneMapped: false }),
  )
  trim.position.set(0, BEAM_Y - 12, 8)
  group.add(trim)

  scene.add(group)
  return { group, panels: [] }
}

const countIn = (id) => [...signs.values()].filter((s) => s.district === id).length

// Reconcile the gantries with the graph. Safe to call every frame: the only work
// done when nothing has changed is a comparison per panel.
//
// The window count is why this runs in the frame loop rather than once. A sign
// is adopted lazily -- a window can appear on a road seconds after the gantry
// was built -- and a lane that says "0 windows" about a road with two on it is
// worse than a lane that says nothing.
export function syncGantries() {
  if (!scene) return
  const want = new Set()

  for (const w of ws.list()) {
    if (!w.open) continue
    const exits = ws.exitsOf(w.id)
    // No exits, no sign. An empty gantry is a promise of somewhere to go.
    if (exits.length === 0) continue
    want.add(w.id)

    let gy = gantries.get(w.id)
    if (!gy) {
      gy = buildGantry(w.id)
      gantries.set(w.id, gy)
    }
    gy.group.position.set(ws.laneX(w.id), 0, GANTRY_Z)

    // Rebuild the panel row only when the SET of exits changes -- otherwise the
    // meshes are kept and just redrawn, so a changing window count never costs a
    // geometry.
    const sameRow = gy.panels.length === exits.length && gy.panels.every((p, i) => p.to === exits[i])
    if (!sameRow) {
      for (const p of gy.panels) {
        gy.group.remove(p.mesh)
        p.mesh.geometry.dispose()
        p.mesh.material.dispose()
        p.tex.dispose()
      }
      gy.panels = []
      const pw = Math.min(PANEL_MAX_W, BEAM_W * 0.95 / exits.length)
      const ph = pw / 2
      const x0 = -(pw * exits.length) / 2 + pw / 2
      exits.forEach((to, i) => {
        const p = makePanel()
        p.to = to
        p.count = -1
        p.open = null
        p.mesh.scale.set(pw, ph, 1)
        p.mesh.position.set(x0 + i * pw, BEAM_Y - 18 - ph / 2, 6)
        // What a click on this mesh MEANS. Read back by exitOf(); the mesh is
        // the only thing a raycast hands you.
        p.mesh.userData.gantryExit = { from: w.id, to }
        gy.group.add(p.mesh)
        gy.panels.push(p)
      })
    }

    for (const p of gy.panels) {
      const dest = ws.get(p.to)
      if (!dest) continue
      const count = countIn(p.to)
      if (count === p.count && dest.open === p.open && dest.name === p.name) continue
      p.count = count
      p.open = dest.open
      p.name = dest.name
      drawPanel(p.canvas, dest.name, count, dest.open)
      p.tex.needsUpdate = true
    }
  }

  for (const [id, gy] of [...gantries]) {
    if (want.has(id)) continue
    scene.remove(gy.group)
    gy.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    for (const p of gy.panels) p.tex.dispose()
    gantries.delete(id)
  }
}

// ------------------------------------------------------------- what Travel asks

export function gantryMeshes() {
  const out = []
  for (const gy of gantries.values()) for (const p of gy.panels) out.push(p.mesh)
  return out
}

export const exitOf = (mesh) => mesh?.userData?.gantryExit ?? null

// Hover. A panel that does nothing when you point at it does not read as
// clickable, and there is no cursor to change out here in the scene -- so the
// panel brightens instead, which is the same signal a real sign gives when your
// headlights reach it.
let hovered = null
export function setHovered(mesh) {
  if (hovered === mesh) return
  if (hovered) hovered.material.color.setHex(0xffffff)
  hovered = mesh && exitOf(mesh) ? mesh : null
  // MeshBasicMaterial multiplies its map by `color`, so >1 is a real brighten
  // rather than a wash -- the texture keeps its own contrast.
  if (hovered) hovered.material.color.setRGB(1.45, 1.45, 1.45)
}

// What the gantries are actually saying, without reading pixels off them.
export const gantryReport = () =>
  [...gantries.entries()].map(([id, gy]) => ({
    workspace: id,
    x: Math.round(gy.group.position.x),
    lanes: gy.panels.map((p) => ({ to: p.to, name: p.name, count: p.count, open: p.open })),
  }))
