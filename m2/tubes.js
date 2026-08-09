// The tube rack -- the machine, as seven gauges.
//
// RAVIO's rack showed seven LANE RATINGS. RRABBIT's shows CPU, RAM, swap, disk,
// net, temp and load. The rating shape is identical (`{value, n, why, bar}`),
// which is the whole reason this is a new source rather than new geometry.
//
// Two rules carried over from RAVIO, and both are load-bearing:
//
//   1. A tube over its redline MUST NAME WHAT IS DOING IT (invariant 1). The
//      bridge supplies `why` -- "largest: firefox at 1055 MB", "hottest:
//      k10temp" -- and the rack is required to surface it. A gauge that reports
//      0.97 and declines to say what is at 0.97 is an ornament.
//
//   2. A gauge with nothing to report shows NOTHING, not zero. `value: null`
//      means the bridge could not measure it (no sensor, no interval yet), and
//      drawing that as an empty tube would claim the machine is idle. Unknown
//      and zero are different states and the rack must not collapse them --
//      the same distinction RAVIO's milepost tape needed between "quiet" and
//      "not held".

import * as THREE from 'three'

const ACC = 0xf2c14e
const COOL = 0x2de2e6
const WARN = 0xff5a3c
const DEAD = 0x4a4a58

const ORDER = ['cpu', 'ram', 'swap', 'disk', 'net', 'temp', 'load']

// Camera-space layout. The rack is parented to the CAMERA, so it stays under
// your hand however the road moves -- the same reason RAVIO pins the dash to
// the bottom of the frame rather than to the world.
const RACK_Z = -1.2
const RACK_Y = -0.42
const TUBE_H = 0.19
const TUBE_R = 0.05
const PITCH = 0.16

export function createRack(camera) {
  const rack = new THREE.Group()
  const tubes = {}

  const x0 = -((ORDER.length - 1) * PITCH) / 2
  ORDER.forEach((name, i) => {
    const g = new THREE.Group()
    g.position.set(x0 + i * PITCH, RACK_Y, RACK_Z)

    // The glass envelope. Open-ended so the fill inside is visible from the
    // side without depth-sorting two closed shells against each other.
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(TUBE_R, TUBE_R, TUBE_H, 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2a3040,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    g.add(glass)

    // The fill. Scaled from the BASE, not the centre, so it grows upward like
    // a level rather than expanding from the middle like a bar chart.
    const fill = new THREE.Mesh(
      new THREE.CylinderGeometry(TUBE_R * 0.78, TUBE_R * 0.78, 1, 14),
      new THREE.MeshBasicMaterial({ color: DEAD, transparent: true, opacity: 0.9 }),
    )
    // THE RACK STARTS UNKNOWN, NOT FULL. The fill geometry is 1 unit tall and
    // scaled to the value, so an unscaled fill is ~5x the tube -- seven amber
    // bars running off the top of the frame before a single reading exists.
    // Chrome never showed it because the bridge answered within the first
    // frames; Firefox, starting slower, drew it every time. §14.1 says a gauge
    // with nothing to report shows nothing, and that has to hold at t=0 too.
    fill.scale.y = 0.0001
    fill.position.y = -TUBE_H / 2
    g.add(fill)

    // The redline. A ring at the tube's own `bar`, so the threshold is read off
    // the instrument instead of being remembered.
    const bar = new THREE.Mesh(
      new THREE.TorusGeometry(TUBE_R * 1.04, 0.004, 6, 20),
      new THREE.MeshBasicMaterial({ color: WARN }),
    )
    bar.rotation.x = Math.PI / 2
    bar.visible = false
    g.add(bar)

    // Cap and base, so a tube reads as an object rather than a floating tube.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(TUBE_R * 1.15, TUBE_R * 1.15, 0.012, 18),
      new THREE.MeshBasicMaterial({ color: 0x1a1f2c }),
    )
    cap.position.y = -TUBE_H / 2 - 0.006
    g.add(cap)

    const label = makeLabel(name.toUpperCase())
    label.position.set(0, -TUBE_H / 2 - 0.048, 0)
    g.add(label)

    // 256, not 128: "72.0 C" is ~144px at this face and a 128px canvas clipped
    // it to "72.0 (" -- a temperature that reads as a typo.
    const value = makeLabel('?')
    value.position.set(0, TUBE_H / 2 + 0.028, 0)
    g.add(value)

    rack.add(g)
    tubes[name] = { group: g, fill, bar, label, value, data: null }
  })

  // A camera child is only rendered if the camera is in the scene graph.
  camera.add(rack)

  return {
    rack,
    tubes,
    apply(payload) {
      for (const name of ORDER) {
        const t = tubes[name]
        const d = payload?.tubes?.[name]
        t.data = d ?? null
        const v = d ? d.value : null

        if (v === null || v === undefined) {
          // UNKNOWN, not zero. Dim, empty, and the readout says so.
          t.fill.scale.y = 0.0001
          t.fill.material.color.setHex(DEAD)
          t.bar.visible = false
          setLabel(t.value, '?')
          continue
        }

        t.fill.scale.y = Math.max(0.0001, v * TUBE_H)
        t.fill.position.y = -TUBE_H / 2 + (v * TUBE_H) / 2
        const over = d.bar !== null && d.bar !== undefined && v > d.bar
        t.fill.material.color.setHex(over ? WARN : ACC)
        if (d.bar !== null && d.bar !== undefined) {
          t.bar.visible = true
          t.bar.position.y = -TUBE_H / 2 + d.bar * TUBE_H
        } else {
          t.bar.visible = false
        }
        setLabel(t.value, formatValue(name, d))
      }
    },
    // Invariant 1 in one function: everything currently over its redline, with
    // the reason the bridge gave. If this returns rows, the rack owes the
    // viewer an explanation and the DOM strip prints it.
    overRedline() {
      const out = []
      for (const name of ORDER) {
        const d = tubes[name].data
        if (!d || d.value === null || d.bar === null || d.bar === undefined) continue
        if (d.value > d.bar) out.push({ name, value: d.value, bar: d.bar, n: d.n, why: d.why })
      }
      return out
    },
  }
}

function formatValue(name, d) {
  if (name === 'temp') return String(d.n ?? '?')
  if (name === 'load') return String(d.n ?? '?')
  return `${Math.round(d.value * 100)}%`
}

function makeLabel(text, px = 256) {
  const c = document.createElement('canvas')
  c.width = px
  c.height = 64
  const tex = new THREE.CanvasTexture(c)
  // An untagged CanvasTexture is taken as linear and converted twice, which
  // drains every dark value -- RAVIO hit this on the yoke's saucer.
  tex.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.11, 0.0275),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  )
  m.userData.canvas = c
  m.userData.tex = tex
  setLabel(m, text)
  return m
}

function setLabel(mesh, text) {
  if (mesh.userData.last === text) return // a canvas redraw per frame is not free
  mesh.userData.last = text
  const c = mesh.userData.canvas
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  g.fillStyle = '#f3ead4'
  g.font = '700 40px ui-monospace, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, c.width / 2, c.height / 2)
  mesh.userData.tex.needsUpdate = true
}
