// The cockpit -- RAVIO's dashboard, seated in RRABBIT.
//
// `gauge()`, `tube()`, `tubeRack()`, `wheel()` and `saucer()` are RAVIO's own
// primitives from `RAVIO/world/dash.js`, kept close to verbatim so this reads as
// THE SAME instrument panel rather than a lookalike -- the same discipline the
// rest of this fork keeps with `S`, `BOOST_X` and the hood clip. The design
// space is RAVIO's 1920x1080 and every constant that places an instrument
// (WHEEL, RACK, HOOD, the dial centres) is the number RAVIO measured, unchanged.
//
// WHAT IS DIFFERENT IS ONLY WHAT THE INSTRUMENTS ARE WIRED TO. RAVIO's rack
// showed seven lane ratings and its dials showed evidence and road speed. This
// one shows the seven machine gauges the bridge reads, and two dials measured
// here: how much of a frame the shell is spending, and how fast the camera is
// actually travelling. Nothing on this panel is a decorative number -- a reading
// that has not been taken draws `n/r` and no needle (invariant 6).
//
// WHERE IT LIVES. Its own 2D canvas over the 3D scene, exactly as RAVIO does it,
// and NOT the shared `#gl` canvas -- that one belongs to Greenfield and three
// together (see shell.js's header) and painting 2D on it is not available at any
// price. Static in screen space, which is also the cheapest thing you can hand an
// encoder: an unchanging region costs almost nothing.
//
// IT NEVER TAKES THE POINTER. `#dashcv` is `pointer-events: none` and there is
// no hit test in this file. RRABBIT resolves clicks by raycasting the road and
// by a capture-phase listener on `window`, and a canvas lying over the whole
// viewport is the exact shape of the bug that once killed every click in the
// graph box. The dashboard is an instrument panel here, not a control surface.

import { ORDER, formatValue } from './tubes.js'

// The palette. Same three values as world.js's ACC/COOL/BG, as strings, because
// everything below is a 2D context and none of it wants a THREE hex int.
export const P = {
  accent: '#f2c14e', rim: '#c8862a', warn: '#ff5a3c',
  panel: '#140f08', panel2: '#241a10',
  cool: '#2de2e6', ink: '#f3ead4',
  // The station on the TV. RAVIO's says `traaviis.com`; this cockpit belongs to
  // ComputeDriven and says so. One constant, read by the thing that draws the
  // label and by nothing else -- there is no second copy to fall out of step.
  label: 'computedriven.com',
}

const DW = 1920, DH = 1080

// ---------------------------------------------------------------- primitives

function rrPath(c, x, y, w, h, r) {
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath()
}

function rr(c, x, y, w, h, r) {
  c.beginPath(); rrPath(c, x, y, w, h, r)
}

// A palette colour at an alpha. Reads its argument at CALL time, so a palette
// change takes on the next frame with nothing to invalidate.
export function tint(hex, a) {
  const h = String(hex).replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16)
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
}

// TWO COLOURS MIXED TO ONE OPAQUE COLOUR. Not `tint`: a tint is a colour WITH a
// hole in it, and every place that wanted "a hint of cyan over the panel" got a
// hint of cyan over whatever happened to be behind the panel as well. The menus
// use this, because a menu is the one thing on this dashboard that is allowed to
// be over a moving picture and must not show it through.
function mix(hexA, hexB, t) {
  const rd = (hex) => {
    const h = String(hex).replace('#', '')
    const n = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const a = rd(hexA), b = rd(hexB)
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')'
}

// Toward white, for the parts of a lit filament that are hotter than the paint.
function lift(hex, k) {
  const h = String(hex).replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16)
  const up = (v) => Math.round(v + (255 - v) * k)
  return 'rgb(' + up((n >> 16) & 255) + ',' + up((n >> 8) & 255) + ',' + up(n & 255) + ')'
}

// The ship on the horn. RAVIO draws the same saucer on its own hub, and that is
// not decoration there either -- going outside means seeing your own horn from
// the outside. Kept because the hub is the one place a fork can carry the
// original's face without claiming anything about the machine.
export function saucer(c, s) {
  c.save(); c.scale(s, s); c.translate(-100, -64); c.lineWidth = 2
  c.beginPath(); c.moveTo(30, 58); c.quadraticCurveTo(100, 110, 170, 58); c.closePath()
  c.fillStyle = '#16182a'; c.fill(); c.strokeStyle = '#6bf2c8'; c.stroke()
  c.beginPath(); c.ellipse(100, 58, 95, 18, 0, 0, Math.PI * 2)
  c.fillStyle = '#101220'; c.fill(); c.strokeStyle = '#6bf2c8'; c.stroke()
  c.beginPath(); c.ellipse(100, 56, 36, 30, 0, Math.PI, 2 * Math.PI, false); c.closePath()
  c.fillStyle = '#1a1d2e'; c.fill(); c.strokeStyle = '#e8b75a'; c.stroke()
  c.globalAlpha = 0.3
  c.beginPath(); c.ellipse(93, 40, 14, 9, 0, 0, Math.PI * 2)
  c.fillStyle = '#6bf2c8'; c.fill(); c.globalAlpha = 1
  for (const [x, y, col] of [[52, 62, '#e8b75a'], [76, 66, '#6bf2c8'], [100, 67, '#e8b75a'],
                             [124, 66, '#6bf2c8'], [148, 62, '#e8b75a']]) {
    c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fillStyle = col; c.fill()
  }
  c.restore()
}

// An UNRECORDED reading gets no needle and no arc -- only a dashed rest and the
// letters n/r. Invariant 6: an absence is not a zero, and a needle pinned at the
// bottom of the dial would read as "measured, and it is nothing".
export function gauge(c, cx, cy, rad, val, label) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25
  c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2)
  c.fillStyle = '#05060a'; c.fill()
  c.lineWidth = 3; c.strokeStyle = P.rim; c.stroke()
  c.beginPath(); c.arc(cx, cy, rad - 10, a0, a1)
  c.lineWidth = 7; c.strokeStyle = 'rgba(255,255,255,0.12)'; c.stroke()

  if (val !== null && val !== undefined) {
    const v = Math.max(0, Math.min(1, val))
    c.beginPath(); c.arc(cx, cy, rad - 10, a0, a0 + (a1 - a0) * v)
    c.lineWidth = 7; c.strokeStyle = P.accent; c.stroke()
  }
  for (let k = 0; k <= 10; k++) {
    const a = a0 + ((a1 - a0) * k) / 10, r1 = rad - 17, r2 = rad - 25
    c.beginPath()
    c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
    c.strokeStyle = k > 7 ? P.warn : 'rgba(255,255,255,0.55)'
    c.lineWidth = 2; c.stroke()
  }
  if (val !== null && val !== undefined) {
    const na = a0 + (a1 - a0) * Math.max(0, Math.min(1, val))
    c.beginPath(); c.moveTo(cx, cy)
    c.lineTo(cx + Math.cos(na) * (rad - 19), cy + Math.sin(na) * (rad - 19))
    c.strokeStyle = P.warn; c.lineWidth = 3.5; c.stroke()
  } else {
    c.save(); c.setLineDash([4, 5])
    c.beginPath(); c.arc(cx, cy, rad - 19, a0, a1)
    c.strokeStyle = 'rgba(255,255,255,0.20)'; c.lineWidth = 2; c.stroke()
    c.restore()
    c.fillStyle = 'rgba(255,255,255,0.45)'; c.font = '700 13px Arial'
    c.textAlign = 'center'; c.fillText('n/r', cx, cy + 5)
  }
  c.beginPath(); c.arc(cx, cy, 7, 0, Math.PI * 2); c.fillStyle = P.accent; c.fill()
  c.fillStyle = 'rgba(255,255,255,0.75)'; c.font = '700 13px Arial'
  c.textAlign = 'center'; c.fillText(label, cx, cy + rad * 0.62)
}

// ---------------------------------------------------------------- the yoke
//
// A hand controller with two rectangular grips, drawn as SOLID GEOMETRY rather
// than as strokes with a highlight painted on: every face is projected through
// one transform, so the depth answers to the controls instead of being a picture
// of depth that stays put while the thing under it moves.
//
// Yoke space is x right, y down, z toward the eye. Roll turns the face in its own
// plane; pitch tilts the whole column about the horizontal. Roll first, then
// pitch: a rolled yoke pitches about the cockpit's horizontal, not about its own
// rotated axis, because the column is bolted to the console and not to you.
function yokeProject(roll, pitch, persp) {
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  return (x, y, z) => {
    const rx = x * cr - y * sr, ry = x * sr + y * cr
    const py = ry * cp + z * sp
    const pz = -ry * sp + z * cp
    const k = persp / (persp - pz)
    return [rx * k, py * k, pz]
  }
}

// Outlines as POINT LISTS, because a projected rounded rect is not a rounded
// rect and arcTo would quietly straighten the near corners.
function rrPoints(x, y, w, h, r, seg = 3) {
  const pts = []
  const corner = (ax, ay, a0) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg)
      pts.push([ax + Math.cos(a) * r, ay + Math.sin(a) * r])
    }
  }
  corner(x + w - r, y + r, -Math.PI / 2)
  corner(x + w - r, y + h - r, 0)
  corner(x + r, y + h - r, Math.PI / 2)
  corner(x + r, y + r, Math.PI)
  return pts
}

function ringPoints(r, n = 20) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  return pts
}

// THE RIM IS ONE PIECE, and that is the whole difference between a yoke and two
// posts with a bar through them: a squared-off ring with the top centre missing,
// so the sides sweep up into tips and carry on round the bottom as one band.
//
// The centreline is an AUTHORED PROFILE, not a formula -- RAVIO's, verbatim. A
// superellipse was the obvious reach and it is wrong in a way worth keeping
// written down: its widest point is a corner, so cutting the top out leaves two
// tips that point SIDEWAYS and read as hooks.
export const RIM_HALF = [
  [-0.44, -0.70], [-0.78, -0.50], [-0.95, -0.16], [-0.97, 0.20],
  [-0.80, 0.52], [-0.46, 0.72], [0.00, 0.78],
]

// Catmull-Rom through the profile: it passes THROUGH its control points, which
// is what makes a hand-placed outline editable.
function spline(pts, per) {
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b, c2, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t
      out.push([0, 1].map((j) => 0.5 * (2 * b[j] + (-a[j] + c2[j]) * t
        + (2 * a[j] - 5 * b[j] + 4 * c2[j] - d[j]) * t2
        + (-a[j] + 3 * b[j] - 3 * c2[j] + d[j]) * t3)))
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

// Thickness follows the hand: widest out at nine and three where you hold it,
// narrowing across the bottom and into the tips. Keyed to |x| rather than to the
// angle, so it stays right however the profile above is nudged.
function rimPoints(rad) {
  const wSide = rad * 0.125, wBot = rad * 0.072, S = rad * 0.87
  const full = RIM_HALF.concat(RIM_HALF.slice(0, -1).reverse().map(([x, y]) => [-x, y]))
  const line = spline(full, 4)
  const n = line.length - 1
  const mid = line.map(([x, y]) => [x * S, y * S])
  const half = line.map(([x]) => wBot + (wSide - wBot) * Math.min(1, Math.abs(x)))
  // Outward normal from the neighbours rather than from calculus: the shape is
  // sampled anyway, and a numeric normal cannot disagree with the points it is
  // taken between.
  const nrm = mid.map((_, i) => {
    const p0 = mid[Math.max(0, i - 1)], p1 = mid[Math.min(n, i + 1)]
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
    const L = Math.hypot(dx, dy) || 1
    return [dy / L, -dx / L]
  })
  const off = (i, s) => [mid[i][0] + nrm[i][0] * half[i] * s, mid[i][1] + nrm[i][1] * half[i] * s]
  // A round cap at each tip. Square-ended, the grips finish on a hard edge and
  // the yoke reads as cut off rather than as something moulded.
  const cap = (i, from, to) => {
    const out = []
    const a0 = Math.atan2(from[1] - mid[i][1], from[0] - mid[i][0])
    const a1 = Math.atan2(to[1] - mid[i][1], to[0] - mid[i][0])
    let d = a1 - a0
    while (d <= -Math.PI) d += Math.PI * 2
    while (d > Math.PI) d -= Math.PI * 2
    for (let k = 1; k < 4; k++) {
      const ang = a0 + d * (k / 4)
      out.push([mid[i][0] + Math.cos(ang) * half[i], mid[i][1] + Math.sin(ang) * half[i]])
    }
    return out
  }
  const outer = mid.map((_, i) => off(i, 1))
  const inner = mid.map((_, i) => off(i, -1))
  return outer
    .concat(cap(n, outer[n], inner[n]))
    .concat(inner.slice().reverse())
    .concat(cap(0, inner[0], outer[0]))
}

// One slab: back face, then the wall around its edge, then the front face. The
// wall is what makes it a solid -- an offset drop-shadow gives the same first
// impression and then disagrees with the light the moment anything turns.
//
// BANDED, not one fill per edge. RAVIO measured this: the rim is a hundred-odd
// segments and a fill() each cost 14ms a frame, p50 26 -> 40 on the same scene.
const LIGHT = [-0.55, -0.835] // up and to the left
function slab(c, pts, project, t, face, rimCol) {
  const back = pts.map(([x, y]) => project(x, y, 0))
  const front = pts.map(([x, y]) => project(x, y, t))
  c.beginPath()
  back.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
  c.closePath(); c.fillStyle = '#04050a'; c.fill()
  const BANDS = 7
  const bucket = Array.from({ length: BANDS }, () => [])
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const ex = back[j][0] - back[i][0], ey = back[j][1] - back[i][1]
    const len = Math.hypot(ex, ey) || 1
    // Outward normal of this edge in screen space. The winding is clockwise in
    // canvas coordinates, so the outward side is (ey, -ex).
    const sh = Math.max(0, (ey / len) * LIGHT[0] + (-ex / len) * LIGHT[1])
    bucket[Math.min(BANDS - 1, Math.floor(sh * BANDS))].push(i)
  }
  for (let b = 0; b < BANDS; b++) {
    if (!bucket[b].length) continue
    const m = 0.18 + 0.82 * ((b + 0.5) / BANDS)
    c.beginPath()
    for (const i of bucket[b]) {
      const j = (i + 1) % pts.length
      c.moveTo(back[i][0], back[i][1]); c.lineTo(back[j][0], back[j][1])
      c.lineTo(front[j][0], front[j][1]); c.lineTo(front[i][0], front[i][1])
      c.closePath()
    }
    c.fillStyle = 'rgb(' + Math.round(9 + 96 * m) + ',' + Math.round(10 + 66 * m)
                + ',' + Math.round(17 + 26 * m) + ')'
    c.fill()
  }
  c.beginPath()
  front.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
  c.closePath()
  c.fillStyle = face; c.fill()
  c.lineWidth = 2.5; c.strokeStyle = rimCol; c.stroke()
}

// Where the yoke is and how big, in design space -- RAVIO's measured constants.
export const WHEEL = { x: 1246, y: 968, r: 160 }

// The square the MESH's canvas takes, in client px. 1.054 because the farthest
// point of the rim under roll is ~0.99 of the radius and the bevel stands a
// little proud of that; anything tighter clips a tip at full deflection. Matched
// to yoke3d's HALF (1.17 against a mesh reaching 1.11) so a design px is the
// same size in both and the yoke lands at the radius this constant promises.
export function wheelRect(W, H, ty, s) {
  const R = WHEEL.r * 1.054
  return { x: (WHEEL.x - R) * s, y: ty + (WHEEL.y - R) * s, w: R * 2 * s, h: R * 2 * s }
}

export function wheel(c, cx, cy, rad, roll, pitch) {
  // YOU ARE LOOKING DOWN AT IT. Straight on, a slab shows no side wall at all
  // and the whole extrusion is wasted. The column stands out of the console
  // below eye level, so its face is tilted away from you at rest and the lit top
  // edge is visible; the control then moves either side of that pose instead of
  // starting edge-on. Both numbers are set by what the extrusion has to SHOW: at
  // 15 thick and 11 degrees the visible top wall is 3 design px and the whole
  // solid reads as a flat outline, so T is near a tenth of the span and 22
  // degrees of look-down turns that into ~13 design px of lit edge.
  const REST = 0.38
  roll = roll || 0; pitch = REST + (pitch || 0)
  const T = 34 // slab thickness, design px
  const project = yokeProject(roll, pitch, rad * 4)
  c.save(); c.translate(cx, cy)

  // Rim, then the spokes it carries, then the boss over both: the order the
  // parts are assembled in, so a spoke runs INTO the rim and BEHIND the horn.
  slab(c, rimPoints(rad), project, T, '#101219', P.rim)
  slab(c, rrPoints(-rad * 0.86, -rad * 0.085, rad * 1.72, rad * 0.17, rad * 0.06),
       project, T * 0.8, '#0c0d12', P.rim)
  slab(c, rrPoints(-rad * 0.115, 0, rad * 0.23, rad * 0.72, rad * 0.06),
       project, T * 0.8, '#0c0d12', P.rim)
  slab(c, ringPoints(rad * 0.3), project, T + 6, '#0a0b10', P.accent)

  // The horn rides the face it is mounted on: magnified by the hub's own `k`,
  // squashed by the pitch, turned by the roll. Screen-space order, because that
  // is the order the projection applies them in -- roll inside the pitch.
  const [hx, hy, hz] = project(0, 0, T + 6)
  const k = (rad * 4) / (rad * 4 - hz)
  c.save()
  c.translate(hx, hy)
  c.scale(k, k * Math.cos(pitch))
  c.rotate(roll)
  saucer(c, rad * 0.0041)
  c.restore()
  c.restore()
}

// ---------------------------------------------------------------- the tubes
//
// A tube is the right instrument for a machine gauge for the same reason it was
// the right one for a lane rating: it either glows or it doesn't, so a reading
// the bridge could not take is a DARK tube rather than a bar of length zero --
// invariant 6 rendered as hardware.
export function tube(c, x, y, w, h, v, bar, name) {
  const r = w * 0.5, baseH = h * 0.17
  const gy = y, gh = h - baseH

  // glass envelope: dome on top, straight sides
  c.beginPath()
  c.moveTo(x, gy + gh)
  c.lineTo(x, gy + r * 0.9)
  c.quadraticCurveTo(x, gy, x + r, gy)
  c.quadraticCurveTo(x + w, gy, x + w, gy + r * 0.9)
  c.lineTo(x + w, gy + gh)
  c.closePath()

  const glass = c.createLinearGradient(x, gy, x + w, gy)
  glass.addColorStop(0, 'rgba(120,140,180,0.10)')
  glass.addColorStop(0.35, 'rgba(200,220,255,0.05)')
  glass.addColorStop(1, 'rgba(80,100,140,0.12)')
  c.fillStyle = glass; c.fill()
  c.strokeStyle = 'rgba(180,200,240,0.28)'; c.lineWidth = 1.5; c.stroke()

  // the filament: height AND heat both track the value
  if (v !== null && v !== undefined) {
    const fh = Math.max(4, v * (gh - 22))
    const fy = gy + gh - 8 - fh
    c.save()
    c.beginPath(); c.moveTo(x, gy + gh); c.lineTo(x, gy + r * 0.9)
    c.quadraticCurveTo(x, gy, x + r, gy)
    c.quadraticCurveTo(x + w, gy, x + w, gy + r * 0.9)
    c.lineTo(x + w, gy + gh); c.closePath(); c.clip()

    const glow = c.createRadialGradient(x + r, fy + fh * 0.6, 1, x + r, fy + fh * 0.6, w * 1.5)
    const hot = v >= (bar ?? 1)
    glow.addColorStop(0, hot ? tint(lift(P.accent, 0.45), 0.95) : tint(P.rim, 0.85))
    glow.addColorStop(0.45, hot ? tint(P.accent, 0.35) : tint(P.rim, 0.28))
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = glow; c.fillRect(x - w, gy, w * 3, gh)

    // the element itself
    c.strokeStyle = hot ? lift(P.accent, 0.72) : lift(P.rim, 0.4)
    c.lineWidth = 2.4; c.beginPath()
    c.moveTo(x + r - w * 0.18, gy + gh - 8)
    c.lineTo(x + r - w * 0.18, fy)
    c.lineTo(x + r + w * 0.18, fy)
    c.lineTo(x + r + w * 0.18, gy + gh - 8)
    c.stroke()
    c.restore()
  }

  // the redline the bridge set, etched on the glass
  if (typeof bar === 'number') {
    const by = gy + gh - 8 - bar * (gh - 22)
    c.strokeStyle = tint(P.warn, 0.85); c.lineWidth = 1.5
    c.beginPath(); c.moveTo(x - 2, by); c.lineTo(x + w + 2, by); c.stroke()
  }

  // bakelite base + pins
  c.fillStyle = '#0b0c12'
  c.fillRect(x - 2, gy + gh, w + 4, baseH)
  c.strokeStyle = tint(P.rim, 0.5); c.lineWidth = 1
  c.strokeRect(x - 2, gy + gh, w + 4, baseH)
  c.fillStyle = tint(P.rim, 0.55)
  for (let i = 0; i < 3; i++) c.fillRect(x + 3 + (i * (w - 6)) / 2.6, gy + gh + baseH, 2, 4)

  if (v === null || v === undefined) {
    c.fillStyle = 'rgba(255,255,255,0.30)'; c.font = '700 10px Arial'
    c.textAlign = 'center'; c.fillText('n/r', x + r, gy + gh * 0.58)
  }

  c.fillStyle = 'rgba(255,255,255,0.62)'; c.font = '700 10px Arial'
  c.textAlign = 'center'
  c.fillText(name.toUpperCase(), x + r, gy + h + 16)
}

// The tube rack's footprint in design space, named once, and the same footprint
// RAVIO's thirty-band spectrum had before it. Seven machine gauges rather than
// seven lane ratings, so the slot arithmetic is unchanged and only the source
// moved.
export const RACK = { x: 982, base: 790, w: 30 * (13 + 8) - 8, top: 790 - 74 }

// base+16 (the labels) must clear the wheel rim at ~809, and base-th (the tube
// tops) must stay below the dash lip at ~713. Both hold at th=74.
function tubeRack(c, rack, drawn) {
  const x0 = RACK.x, base = RACK.base, span = RACK.w
  const slot = span / ORDER.length
  const tw = slot - 14, th = 74

  // -28, not RAVIO's -14. RAVIO prints no number above a tube -- a lane rating
  // is a 0..1 and the filament IS the reading. A machine gauge is not: "74.1 C"
  // and "25555 MB of 31189" are the parts you actually want, and they are what
  // the old 3D rack put on a plane above each tube. Keeping them costs a row,
  // and at RAVIO's -14 the caption and the readouts were 8px apart and touching.
  c.fillStyle = 'rgba(255,255,255,0.30)'; c.font = '600 11px Arial'
  c.textAlign = 'left'
  c.fillText('THE MACHINE', x0, base - th - 28)

  ORDER.forEach((name, i) => {
    const d = rack.tubes[name]?.data ?? null
    // `typeof === number`, so a bridge that answers `null` for a sensor it does
    // not have draws a dark tube instead of an empty one.
    const v = d && typeof d.value === 'number' ? d.value : null
    const bar = d && typeof d.bar === 'number' ? d.bar : undefined
    const x = x0 + i * slot
    tube(c, x, base - th, tw, th, v, bar, name)

    // The number the tube is reading, above its dome. It used to be a 256px
    // CanvasTexture on a plane; here it is text on the same canvas as the glass
    // it labels, which is the whole reason "72.0 C" can no longer be clipped to
    // "72.0 (" by a texture that ran out of room.
    const over = v !== null && bar !== undefined && v > bar
    c.fillStyle = v === null ? 'rgba(255,255,255,0.35)' : over ? P.warn : P.accent
    c.font = '700 12px Arial'; c.textAlign = 'center'
    c.fillText(formatValue(name, d), x + tw / 2, base - th - 6)

    // WHAT WAS ACTUALLY PAINTED, recorded as it is painted. `__tubes()` used to
    // report `fill.scale.y` and `fill.material.color` off the meshes, which is
    // the honest shape of that report -- it described the picture rather than
    // the payload. There are no meshes now, so the drawing writes down what it
    // drew and the report reads that instead of recomputing it.
    drawn[name] = {
      value: v,
      bar: bar ?? null,
      fill: v === null ? 0 : +Math.max(4 / (th - 22), v).toFixed(5),
      barShown: bar !== undefined,
      lit: v !== null,
      color: v === null ? null : over ? P.warn : P.rim,
    }
  })
}

// ---------------------------------------------------------------- the panel

// The hood, and the one number anything cutting against it has to read. `lw` is
// the crown's own stroke, drawn CENTRED on the curve, so half of it lies above
// the line it is cutting at.
export const HOOD = { edge: 752, ctrl: 666, lw: 3 }

// The hood's crown, in design space. A quadratic's midpoint is at t=0.5:
// 0.25*edge + 0.5*ctrl + 0.25*edge.
export const CROWN = 0.25 * HOOD.edge + 0.5 * HOOD.ctrl + 0.25 * HOOD.edge

// HOW FAR ABOVE THE CROWN THE DASHBOARD ACTUALLY REACHES -- RAVIO's dashReach,
// and the distinction is not pedantry. The tube rack stands PROUD of the hood:
// its caption sits at design 660 against a crown at 709.5, so anything that
// clears the crown is still 50px inside the rack. `#why` was pinned to the crown
// and the strip landed straight across "THE MACHINE" the first time it had
// something to say. An instrument panel overlapping the bottom of a windshield
// is what an instrument panel does; a WARNING hidden behind one is invariant 1
// failing quietly, which is the one thing this rack exists not to do.
export const REACH = Math.min(CROWN, RACK.top - 42)

// ------------------------------------------------------------------- the TV
//
// RAVIO's monitor, at RAVIO's rect. The station label is the one thing that
// changes: this cockpit is ComputeDriven's, so it reads `computedriven.com`.
export const MON = { x: 352, y: 720, w: 576, h: 324 }

// THE BEZEL IS BIGGER THAN THE SCREEN -- 16px each side, 40 above for the label
// and the ON AIR lamp, 18 below. Anything deciding "where is the monitor" from
// MON alone is asking about the picture when it meant the fitting.
export function monBezel(m, pad = 0) {
  return { x: m.x - 16 - pad, y: m.y - 40 - pad,
           w: m.w + 32 + pad * 2, h: m.h + 58 + pad * 2, r: 20 + pad }
}

// Where the screen lands in CANVAS pixels, under the same transform the dash is
// drawn with. Exported because the broadcast quad has to be positioned into it
// from the road's scene -- the thing that paints the fitting and the thing that
// puts a picture in it read one definition, or they come apart at the edges.
export function monRect(W, H, ty, s) {
  return { x: MON.x * s, y: ty + MON.y * s, w: MON.w * s, h: MON.h * s }
}

// ---- the tuner: channel, controls, and the way in ---------------------------
//
// THE STATION LABEL IS THE CHANNEL CHANGER. RAVIO's `traaviis.com` sits above
// the screen and opens the controls when pressed; here the same place names what
// is ON the screen and opens the list of everything else you could put there.
// With nothing broadcasting it falls back to the station's own name, because a
// tuner with no channel still belongs to somebody.
//
// The window's name is written `(like this)` -- round brackets are this shell's
// mark for a window, the way `--road-->` is its mark for a road and `[network]`
// for a network. It is the one noun in that vocabulary that used to have none.
//
// EVERY RECTANGLE BELOW IS DERIVED ONCE and read by both the painter and the hit
// test. That is not tidiness: a menu row whose click target is a row above where
// it is drawn deletes the wrong window, and it is the exact failure the shifter's
// `shiftAt` exists to prevent.
const TUNER = { h: 22, menuW: 300, rowH: 28, ctlW: 62, ctlH: 20, gap: 6 }

// Where the label/dropdown trigger sits, in design space.
export function tunerRect() {
  const m = MON
  return { x: m.x + 4, y: m.y - 34, w: m.w * 0.62, h: TUNER.h }
}

// The controls, right-aligned in the band ON AIR used to occupy. A list rather
// than one rect, because "modification/configuration" is plural by nature and
// the next one added should be an entry here, not another hand-placed box.
export function tunerControls(st) {
  const m = MON
  const out = []
  if (!st.onAir) return out
  const items = [{ action: 'delete', label: 'delete', tone: 'warn' }]
  let x = m.x + m.w - 4
  for (const it of items) {
    x -= TUNER.ctlW
    out.push({ ...it, x, y: m.y - 33, w: TUNER.ctlW, h: TUNER.ctlH })
    x -= TUNER.gap
  }
  return out
}

// The open dropdown's rows. Drops DOWN from the label into the screen, which is
// where a dropdown goes and is also the only place on this panel with room.
export function tunerRows(list) {
  const t = tunerRect()
  return (list || []).map((it, i) => ({
    ...it,
    x: t.x, y: t.y + t.h + 4 + i * TUNER.rowH, w: TUNER.menuW, h: TUNER.rowH,
  }))
}

function drawTuner(c, st) {
  const m = MON
  const t = tunerRect()
  const name = st.onAir ? `(${st.castTitle || 'a window'})` : P.label

  // the trigger
  c.textAlign = 'left'; c.textBaseline = 'middle'
  c.fillStyle = st.onAir ? P.cool : P.accent
  c.font = '700 17px Arial'
  const label = name.length > 34 ? name.slice(0, 33) + '…' : name
  c.globalAlpha = st.menuOpen ? 1 : 0.72
  c.fillText(label, t.x + 2, t.y + t.h / 2)
  const lw = c.measureText(label).width
  // The caret is what says this is a control and not a caption -- the same
  // problem RAVIO's underlined label had, solved the way a dropdown solves it.
  c.font = '700 11px Arial'
  c.fillText(st.menuOpen ? '\u25B2' : '\u25BC', t.x + 10 + lw, t.y + t.h / 2 + 1)
  c.fillRect(t.x + 2, t.y + t.h / 2 + 9, lw, 1)
  c.globalAlpha = 1
  c.textBaseline = 'alphabetic'

  // the controls where ON AIR used to be
  for (const ctl of tunerControls(st)) {
    rr(c, ctl.x, ctl.y, ctl.w, ctl.h, 5)
    c.fillStyle = 'rgba(4,6,12,0.82)'; c.fill()
    c.lineWidth = 1.2
    c.strokeStyle = ctl.tone === 'warn' ? tint(P.warn, 0.75) : 'rgba(255,255,255,0.3)'
    c.stroke()
    c.fillStyle = ctl.tone === 'warn' ? P.warn : 'rgba(255,255,255,0.62)'
    c.font = '700 11px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText(ctl.label, ctl.x + ctl.w / 2, ctl.y + ctl.h / 2 + 1)
    c.textBaseline = 'alphabetic'
  }
  c.textAlign = 'left'
}

// THE ONE OPAQUE COLOUR EVERY MENU ON THIS DASHBOARD IS BACKED WITH.
//
// Not a near-opaque rgba. The two menus are the only things here that are drawn
// over a LIVE PICTURE -- the tuner's drops into the screen, and while a window is
// broadcasting that screen is a hole punched clean through this canvas with
// `destination-out` (see drawMonitor). Anything less than alpha 1 over that hole
// is not "slightly translucent", it is the client's own moving pixels showing
// through the list you are reading. `rgba(4,6,12,0.96)` and a 0.2 cyan for the
// live row were both doing exactly that.
const MENU_BG = '#04060c'
const MENU_LIVE = mix(MENU_BG, '#2de2e6', 0.22)

// The whole rectangle a dropdown occupies, rows and padding together. Painted as
// ONE opaque plate before any row is drawn, so the notches between the rounded
// row corners have panel behind them rather than sky.
function menuPlate(c, x, y, w, h) {
  rr(c, x, y, w, h, 8)
  c.fillStyle = MENU_BG; c.fill()
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,0.22)'; c.stroke()
}

// Drawn LAST, over the punched screen and over the card alike -- a menu that a
// broadcast could show through would be unreadable exactly when it is being used.
function drawTunerMenu(c, st) {
  if (!st.menuOpen) return
  const rows = tunerRows(st.castList || [])
  const t = tunerRect()
  const top = t.y + t.h + 4
  const h = Math.max(1, rows.length) * TUNER.rowH
  c.save()
  // ALPHA 1 REGARDLESS OF WHAT THE PANEL IS DOING. `draw()` fades the whole
  // cockpit while it slides out of the way, and that fade is right for an
  // instrument and wrong for a menu -- a half-faded list over a live window is
  // the same unreadable thing by a different route.
  c.globalAlpha = 1
  menuPlate(c, t.x - 4, top - 4, TUNER.menuW + 8, h + 8)
  if (!rows.length) {
    c.fillStyle = 'rgba(255,255,255,0.42)'; c.font = '600 12px Arial'
    c.textAlign = 'left'; c.textBaseline = 'middle'
    // NOT AN EMPTY BOX. A dropdown with nothing in it and no explanation reads
    // as broken; this one says where channels come from.
    c.fillText('nothing broadcasting \u2014 press --& on a window', t.x + 12, top + TUNER.rowH / 2)
    c.textBaseline = 'alphabetic'
    c.restore()
    return
  }
  for (const r of rows) {
    rr(c, r.x, r.y, r.w, r.h, 6)
    c.fillStyle = r.live ? MENU_LIVE : MENU_BG
    c.fill()
    c.lineWidth = 1.5
    c.strokeStyle = r.live ? P.cool : 'rgba(255,255,255,0.22)'
    c.stroke()
    c.save()
    c.beginPath(); rrPath(c, r.x + 8, r.y, r.w - 16, r.h, 6); c.clip()
    c.fillStyle = r.live ? P.cool : 'rgba(255,255,255,0.7)'
    c.font = '700 12px Arial'; c.textAlign = 'left'; c.textBaseline = 'middle'
    c.fillText(`(${r.label})`, r.x + 12, r.y + r.h / 2 + 1)
    c.textBaseline = 'alphabetic'
    c.restore()
  }
  c.restore()
}

function drawMonitor(c, st, i) {
  const m = MON
  const b = monBezel(m)

  rr(c, b.x, b.y, b.w, b.h, b.r)
  c.fillStyle = '#05060b'; c.fill()
  c.lineWidth = 3; c.strokeStyle = P.rim; c.stroke()
  rr(c, m.x - 4, m.y - 4, m.w + 8, m.h + 8, 10)
  c.lineWidth = 5; c.strokeStyle = '#000'; c.stroke()

  // The band above the screen: the channel changer on the left where RAVIO's
  // station label goes, and the controls on the right where its ON AIR lamp was.
  drawTuner(c, st)

  const card = st.card || {}

  // A BROADCAST WINDOW OWNS THE GLASS, AND THE CANVAS MUST NOT PAINT IT.
  //
  // The picture is a quad in the road's scene -- the textures live in the shared
  // GL context and a 2D canvas cannot sample them -- and this canvas sits ON TOP
  // of that scene. So "showing a window" here means painting NOTHING in the
  // screen rect and letting it show through. The black fill and the glass
  // gradient below are exactly what would hide it, which is why this branch is
  // before them and not after: written after, the screen is filled first and the
  // broadcast is behind an opaque rectangle the shell just drew over it.
  if (st.onAir) {
    // PUNCH THE HOLE THROUGH EVERYTHING, not just through the bezel.
    //
    // This canvas is not one layer -- by the time the monitor is drawn, the HOOD
    // has already laid an opaque gradient across the whole bottom band, and the
    // TV's rect is inside it. So "skip the screen fill" and even "cut the screen
    // out of the bezel with evenodd" both leave the quad hidden: the first
    // reveals the bezel, the second reveals the hood. Both were tried, and both
    // produced a perfectly black screen while `tv.report()` correctly said the
    // quad was placed, in frustum, visible and carrying the sign's own texture.
    // Every claim on both sides was true; the paint between them was the fault.
    //
    // `destination-out` erases what is already there in the shape of this path,
    // which is the only operation that goes through ALL of it -- and it takes
    // the rounded corners with it, which clearRect could not.
    c.save()
    c.globalCompositeOperation = 'destination-out'
    rr(c, m.x, m.y, m.w, m.h, 10)
    c.fillStyle = '#000'; c.fill()
    c.restore()

    // NO CAPTION STRIP ANY MORE. The channel changer above the screen already
    // names what is on it, and a second copy of the same name laid over the
    // bottom of the picture was covering client pixels to repeat something two
    // inches away -- the same rule the corner controls keep by sitting wholly
    // outside the surface.
    drawTunerMenu(c, st)
    return
  }

  // screen
  rr(c, m.x, m.y, m.w, m.h, 10); c.fillStyle = '#04060c'; c.fill()

  c.save(); rr(c, m.x, m.y, m.w, m.h, 10); c.clip()
  const g = c.createLinearGradient(0, m.y, 0, m.y + m.h)
  g.addColorStop(0, 'rgba(45,226,230,0.12)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.fillStyle = g; c.fillRect(m.x, m.y, m.w, m.h)

  // The now-playing card. RAVIO's says W.W.W. RAVIO / NOW FLYING / the lane.
  // This one names the gear, the workspace you are on, and -- for the three
  // gears whose scenes are NOT BUILT -- says exactly that, rather than showing
  // a card that implies a scene is a click away.
  const cx = m.x + m.w / 2
  c.textAlign = 'center'
  c.fillStyle = P.accent; c.font = '800 22px Arial'
  c.fillText(card.head || 'T&R', cx, m.y + 42)
  c.fillStyle = 'rgba(255,255,255,0.38)'; c.font = '600 12px Arial'
  c.fillText(card.sub || '', cx, m.y + 64)
  c.fillStyle = '#fff'; c.font = '800 34px Arial'
  c.fillText(String(card.big ?? '—'), cx, m.y + 128)
  c.fillStyle = 'rgba(255,255,255,0.55)'; c.font = '600 15px Arial'
  c.fillText(String(card.line || ''), cx, m.y + 162)
  c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1
  c.beginPath(); c.moveTo(m.x + 40, m.y + m.h - 96)
  c.lineTo(m.x + m.w - 40, m.y + m.h - 96); c.stroke()
  c.fillStyle = card.footWarn ? P.warn : 'rgba(255,255,255,0.30)'
  c.font = '600 12px Arial'
  c.fillText(String(card.foot || ''), cx, m.y + m.h - 56)
  c.restore()
  // The menu opens over the card too: a window you broadcast and then took off
  // the screen is still ON the list, and a list you can only reach while it is
  // in use is one you cannot get back to.
  drawTunerMenu(c, st)
}

// -------------------------------------------------------------- the ST&RT menu
//
// THE OTHER WAY A WINDOW GETS OPENED. Until now the only ones were the two gate
// panels at the entrance -- "‹ left / open window" -- and both of them open the
// SAME program, whichever one the page was booted with. That is a shell you can
// drive but not a shell you can use: there is no way to say WHICH program, and no
// way to say WHERE without going and standing at the gate.
//
// So: a start button, at the bottom-left corner of the panel where every desktop
// since 1995 has put one, and a list that opens UP from it. A row can be pressed,
// which opens that program wherever the road has room; or it can be DRAGGED out
// onto the road and dropped, and then the place you dropped it is the place the
// window stands. shell.js owns both -- this file only says where the controls are
// and paints them, exactly as it does for the shifter and the tuner.
//
// EVERY RECTANGLE IS DERIVED ONCE and read by both the painter and the hit test,
// for the reason written over TUNER: a row whose click target is a row above
// where it is drawn launches the wrong program.
// LEFT OF ST&RT, AND ST&RT MOVED RIGHT TO MAKE THE ROOM. The button used to
// stand on the left edge of the design box with nothing beside it, so "left of
// the start button" was not a place that existed -- it had to be made. The two
// are one cluster now: the way in on the right, the way out on the left, both
// on the bottom rail where a hand already goes looking for them.
export const POWER = { x: 22, y: 1028, w: 46, h: 46, r: 10 }
export const START = { x: 80, y: 1028, w: 200, h: 46, r: 10 }
const SMENU = { w: 348, rowH: 40, pad: 10, headH: 30, gap: 10, footH: 28 }

// Opens UPWARD. There is nothing below the button -- it is already standing on
// the bottom edge of the design box -- so a menu that dropped down would be off
// the frame entirely. Height is derived from the list, so the plate is never
// bigger than what is on it.
export function startMenuRect(n) {
  const rows = Math.max(1, n | 0)
  const h = SMENU.pad * 2 + SMENU.headH + rows * SMENU.rowH + SMENU.footH
  return { x: START.x, y: START.y - SMENU.gap - h, w: SMENU.w, h }
}

export function startRows(list) {
  const m = startMenuRect((list || []).length)
  return (list || []).map((it, i) => ({
    ...it,
    x: m.x + SMENU.pad,
    y: m.y + SMENU.pad + SMENU.headH + i * SMENU.rowH,
    w: m.w - SMENU.pad * 2,
    h: SMENU.rowH,
  }))
}

// `ST&RT`, with the ampersand in the accent -- the same mark the roads, the gate
// boards and the protocol itself are written with. Laid out from three measured
// runs rather than one string, because the whole point is that the middle
// character is a different colour, and centring three separately-coloured runs by
// eye is how a label ends up half a letter off its own button.
function ampWord(c, word, cx, cy, font, plain, accent) {
  const at = word.indexOf('&')
  c.font = font
  if (at < 0) {
    c.fillStyle = plain; c.textAlign = 'center'
    c.fillText(word, cx, cy)
    return
  }
  const a = word.slice(0, at), b = word.slice(at + 1)
  const wa = c.measureText(a).width, wm = c.measureText('&').width, wb = c.measureText(b).width
  let x = cx - (wa + wm + wb) / 2
  c.textAlign = 'left'
  c.fillStyle = plain; c.fillText(a, x, cy); x += wa
  c.fillStyle = accent; c.fillText('&', x, cy); x += wm
  c.fillStyle = plain; c.fillText(b, x, cy)
  c.textAlign = 'center'
}

function drawStart(c, st) {
  const b = START
  c.save()
  c.globalAlpha = 1
  rr(c, b.x, b.y, b.w, b.h, b.r)
  c.fillStyle = st.startOpen ? mix(MENU_BG, '#f2c14e', 0.16) : MENU_BG
  c.fill()
  c.lineWidth = 2
  c.strokeStyle = st.startOpen ? P.accent : P.rim
  c.stroke()
  c.textBaseline = 'middle'
  ampWord(c, 'ST&RT', b.x + b.w / 2, b.y + b.h / 2 + 1, '800 24px Arial',
          st.startOpen ? P.ink : 'rgba(243,234,212,0.82)', P.accent)
  c.textBaseline = 'alphabetic'
  c.restore()
}

// Same opaque plate the tuner's list is backed with, and for the same reason --
// this one hangs over the windshield, which is the live road.
function drawStartMenu(c, st) {
  if (!st.startOpen) return
  const list = st.programs || []
  const m = startMenuRect(list.length)
  c.save()
  c.globalAlpha = 1
  menuPlate(c, m.x, m.y, m.w, m.h)

  c.textBaseline = 'middle'
  c.font = '700 12px Arial'; c.textAlign = 'left'
  c.fillStyle = P.accent
  const head = 'PROGRAMS'
  const headW = c.measureText(head).width // while the 12px font is still set
  c.fillText(head, m.x + SMENU.pad + 2, m.y + SMENU.pad + SMENU.headH / 2)
  // HOW MANY ARE ALREADY OPEN, next to the list of ways to open another. The
  // number is the ledger's own -- there is no second count here to drift.
  if (st.open !== null && st.open !== undefined) {
    c.font = '600 11px Arial'
    c.fillStyle = st.cost ? P.warn : 'rgba(255,255,255,0.42)'
    c.fillText(`·  ${st.open} open`, m.x + SMENU.pad + 2 + headW + 10,
               m.y + SMENU.pad + SMENU.headH / 2)
  }
  // WHERE THE LIST CAME FROM, on the list. A menu that quietly falls back to a
  // built-in copy of `proxy/applications.json` and looks identical to one read
  // off the file is a menu you cannot check.
  c.font = '600 11px Arial'; c.textAlign = 'right'
  c.fillStyle = 'rgba(255,255,255,0.34)'
  c.fillText(String(st.programsFrom || ''), m.x + m.w - SMENU.pad - 2,
             m.y + SMENU.pad + SMENU.headH / 2)

  if (!list.length) {
    c.font = '600 12px Arial'; c.textAlign = 'left'
    c.fillStyle = 'rgba(255,255,255,0.42)'
    c.fillText('no programs — the compositor is not up yet',
               m.x + SMENU.pad + 2, m.y + SMENU.pad + SMENU.headH + SMENU.rowH / 2)
  }

  for (const r of startRows(list)) {
    const hot = st.startHot === r.id
    rr(c, r.x, r.y, r.w, r.h - 2, 6)
    c.fillStyle = hot ? mix(MENU_BG, '#2de2e6', 0.18) : MENU_BG
    c.fill()
    c.lineWidth = 1.2
    c.strokeStyle = hot ? P.cool : 'rgba(255,255,255,0.14)'
    c.stroke()

    c.save()
    c.beginPath(); rrPath(c, r.x, r.y, r.w, r.h - 2, 6); c.clip()
    // A REFUSED ROW IS SHOWN AND SAYS WHY. Hiding the native programs whenever
    // the proxy is down would make "xterm is not in the menu" and "there is no
    // xterm" the same picture, and only one of them is fixable by starting a
    // process.
    c.fillStyle = r.ok ? (hot ? P.cool : P.ink) : 'rgba(243,234,212,0.34)'
    c.font = '700 13px Arial'; c.textAlign = 'left'
    c.fillText(String(r.name), r.x + 12, r.y + r.h / 2 - 6)
    c.fillStyle = r.ok ? 'rgba(255,255,255,0.34)' : tint(P.warn, 0.7)
    c.font = '600 10px Arial'
    c.fillText(String(r.ok ? (r.note || '') : (r.why || 'not available')),
               r.x + 12, r.y + r.h / 2 + 9)
    c.fillStyle = 'rgba(255,255,255,0.28)'
    c.font = '700 10px Arial'; c.textAlign = 'right'
    c.fillText(String(r.kind || ''), r.x + r.w - 12, r.y + r.h / 2 - 5)
    c.restore()
  }

  // THE FOOTER SAYS WHAT IT COSTS ONCE THERE IS A COST TO SAY. Below the line it
  // is the plain how-to; past it, the measured price of the next one. Not a
  // refusal -- how many windows you want is not this menu's call.
  c.save()
  // CLIPPED TO THE PLATE. Both strings are authored to fit, and a footer that
  // silently ran past the edge of its own menu is how you find out one of them
  // was not -- which is exactly what happened to the first wording of the cost.
  c.beginPath(); rrPath(c, m.x, m.y, m.w, m.h, 8); c.clip()
  c.font = '600 11px Arial'; c.textAlign = 'left'
  c.fillStyle = st.cost ? P.warn : 'rgba(255,255,255,0.3)'
  c.fillText(st.cost || 'click to open one  ·  or drag it onto the road',
             m.x + SMENU.pad + 2, m.y + m.h - SMENU.footH / 2 - 4)
  c.restore()
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'
  c.restore()
}

// ------------------------------------------------------------- the power key
//
// THE WAY OUT. Everything else on this panel moves you around inside the
// session; this is the one control that ends it, and it hands you back to the
// greeter -- the same screen with the checkered planet on it that let you in.
//
// IT ASKS FIRST, and that is not politeness. Every other control here is
// recoverable: a wrong gear is a shift back, a wrong channel is another pick, a
// window opened by mistake is a window closed. Logging out takes every open
// program with it and there is no undo, so a single click in the corner of the
// screen must not be able to do it. The plate is the confirmation, and it opens
// upward from the button for the same reason the ST&RT menu does -- the button
// is already standing on the bottom edge of the frame.
// THE FOOTER IS TWO LINES WIDE BECAUSE THE SENTENCES IT HOLDS ARE NOT OURS.
// The plate started at 312 wide with a one-line footer, and the very first
// refusal it was shown -- `no session to end — nothing wrote
// /tmp/rrabbit-browser.pid` -- was clipped mid-path by the plate's own clip
// rect. Every string here comes back from the bridge and names a path, a pid or
// an exception, so the room has to be sized for the longest of those rather than
// for the sentence that was convenient to author.
const PMENU = { w: 380, pad: 10, headH: 30, rowH: 46, footH: 44, footLine: 15, gap: 10 }

// Greedy word wrap to at most `max` lines, with the last one ellipsised if it
// still does not fit. Measured against the font the CALLER has already set --
// wrapping against one font and painting in another is how a fitted line runs
// off the end anyway.
export function wrapLines(c, text, width, max) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (c.measureText(next).width <= width || !line) { line = next; continue }
    lines.push(line)
    line = w
    if (lines.length === max) break
  }
  if (lines.length < max && line) lines.push(line)
  // Whatever did not fit is dropped, and the line that ate it says so rather
  // than ending in the middle of a word as though that were the whole message.
  if (lines.length === max) {
    const used = lines.join(' ')
    if (used.length < String(text).replace(/\s+/g, ' ').trim().length) {
      lines[max - 1] += ' …'
    }
  }
  // AND THEN EVERY LINE IS CLAMPED, because word wrapping cannot help a word
  // that is wider than the line -- and the words this footer gets handed are
  // paths, URLs and exception text, which is exactly where those come from. The
  // greedy loop above puts an oversized word on a line of its own and moves on;
  // without this it left the plate the same way the unwrapped footer did.
  return lines.map((line) => {
    if (c.measureText(line).width <= width) return line
    let cut = line
    while (cut && c.measureText(cut + '…').width > width) cut = cut.slice(0, -1)
    return cut + '…'
  })
}

export function powerMenuRect() {
  const h = PMENU.pad * 2 + PMENU.headH + PMENU.rowH + PMENU.footH
  return { x: POWER.x, y: POWER.y - PMENU.gap - h, w: PMENU.w, h }
}

// One row, because there is one thing to say yes to. Cancelling is a click
// anywhere else, which is what dismisses every other menu on this panel.
export function powerRow() {
  const m = powerMenuRect()
  return { x: m.x + PMENU.pad, y: m.y + PMENU.pad + PMENU.headH,
           w: m.w - PMENU.pad * 2, h: PMENU.rowH }
}

// The IEC standby mark -- a broken ring with a bar standing in the gap. Drawn
// rather than typed: the glyph exists in Unicode (U+23FB) and DejaVu on the
// target does not carry it, so a text version renders as a box on the one
// machine this ships to and looks perfect on the one it was written on.
function powerGlyph(c, cx, cy, r, colour) {
  c.save()
  c.lineWidth = 2.6
  c.lineCap = 'round'
  c.strokeStyle = colour
  c.beginPath()
  c.arc(cx, cy, r, -Math.PI / 2 + 0.62, -Math.PI / 2 - 0.62 + Math.PI * 2)
  c.stroke()
  c.beginPath()
  c.moveTo(cx, cy - r - 2)
  c.lineTo(cx, cy - 1)
  c.stroke()
  c.restore()
}

function drawPower(c, st) {
  const b = POWER
  c.save()
  c.globalAlpha = 1
  rr(c, b.x, b.y, b.w, b.h, b.r)
  // WARM, NOT RED, UNTIL IT IS ARMED. A control that is permanently the colour
  // of a fault reads as a fault -- the rack's redline means something here, and
  // spending it on a button that is merely dangerous when pressed devalues it.
  c.fillStyle = st.powerOpen ? mix(MENU_BG, '#ff5a3c', 0.20) : MENU_BG
  c.fill()
  c.lineWidth = 2
  c.strokeStyle = st.powerOpen ? P.warn : P.rim
  c.stroke()
  powerGlyph(c, b.x + b.w / 2, b.y + b.h / 2 + 1, 11,
             st.powerOpen ? P.warn : 'rgba(243,234,212,0.72)')
  c.restore()
}

function drawPowerMenu(c, st) {
  if (!st.powerOpen) return
  const m = powerMenuRect()
  const r = powerRow()
  c.save()
  c.globalAlpha = 1
  menuPlate(c, m.x, m.y, m.w, m.h)

  c.textBaseline = 'middle'
  c.font = '700 12px Arial'; c.textAlign = 'left'
  c.fillStyle = P.warn
  c.fillText('END THE SESSION', m.x + PMENU.pad + 2, m.y + PMENU.pad + PMENU.headH / 2)
  // HOW MUCH IS ON THE TABLE, counted rather than warned about in the abstract.
  // "You may lose unsaved work" is a sentence every dialog says; "4 open" is the
  // number that actually decides whether you meant to press this.
  if (st.open !== null && st.open !== undefined) {
    c.font = '600 11px Arial'; c.textAlign = 'right'
    c.fillStyle = st.open ? P.warn : 'rgba(255,255,255,0.42)'
    c.fillText(st.open ? `${st.open} open — they all close` : 'nothing open',
               m.x + m.w - PMENU.pad - 2, m.y + PMENU.pad + PMENU.headH / 2)
  }

  const hot = !!st.powerHot
  rr(c, r.x, r.y, r.w, r.h - 2, 6)
  c.fillStyle = hot ? mix(MENU_BG, '#ff5a3c', 0.18) : MENU_BG
  c.fill()
  c.lineWidth = 1.2
  c.strokeStyle = hot ? P.warn : 'rgba(255,255,255,0.14)'
  c.stroke()

  c.save()
  c.beginPath(); rrPath(c, r.x, r.y, r.w, r.h - 2, 6); c.clip()
  c.fillStyle = hot ? P.warn : P.ink
  c.font = '700 13px Arial'; c.textAlign = 'left'
  c.fillText('LOG OUT', r.x + 12, r.y + r.h / 2 - 7)
  c.fillStyle = 'rgba(255,255,255,0.34)'
  c.font = '600 10px Arial'
  c.fillText('back to the greeter', r.x + 12, r.y + r.h / 2 + 8)
  c.restore()

  // THE FOOTER IS WHERE A REFUSAL LANDS. The shell can only end a session it is
  // actually running inside -- a browser tab pointed at the bridge is not one --
  // and when the bridge says so, the reason is printed HERE, on the control that
  // asked, rather than left as a button that visibly did nothing.
  c.save()
  c.beginPath(); rrPath(c, m.x, m.y, m.w, m.h, 8); c.clip()
  c.font = '600 11px Arial'; c.textAlign = 'left'
  c.fillStyle = st.powerWhy ? P.warn : 'rgba(255,255,255,0.3)'
  const foot = wrapLines(c, st.powerWhy || 'anywhere else cancels',
                         m.w - PMENU.pad * 2 - 4, 2)
  // Bottom-aligned inside the footer, so one line sits where one line always sat
  // and a second one grows upward into the room reserved for it.
  const footTop = m.y + m.h - PMENU.pad - (foot.length - 1) * PMENU.footLine - 6
  foot.forEach((line, i) => c.fillText(line, m.x + PMENU.pad + 2, footTop + i * PMENU.footLine))
  c.restore()
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'
  c.restore()
}

// WHAT IS UNDER THE POINTER WHILE A PROGRAM IS BEING DRAGGED, drawn in CLIENT
// pixels rather than design space -- it follows the pointer, and the pointer is
// not on the panel. Same reason the pull tab is measured that way.
//
// The chip says the program; the line under it says the place the drop will
// actually use, as the road reported it. It is not a promise about where the
// window will end up if that slot is taken by the time the surface arrives --
// rrabbit.js falls back to the first free one and says so in `signs`.
function drawDragGhost(c, d, W, H) {
  if (!d) return
  c.save()
  c.globalAlpha = 1
  c.textBaseline = 'middle'

  const label = String(d.name || 'program')
  const hint = String(d.hint || '')
  c.font = '700 13px Arial'
  const wLabel = c.measureText(label).width
  c.font = '600 11px Arial'
  const wHint = c.measureText(hint).width
  const w = Math.max(150, wLabel + 28, wHint + 24)
  const h = hint ? 52 : 30
  // CLAMPED INTO THE FRAME. The chip hangs off the pointer and the pointer goes
  // to the edges -- a hint that says why the drop is refused, printed half off
  // the screen, is a refusal you cannot read.
  const x = Math.min(d.x + 14, Math.max(4, W - w - 4))
  const y = Math.min(d.y + 12, Math.max(4, H - h - 4))

  // ITS OWN PLATE, and the hint is INSIDE it. The hint used to be printed bare
  // on the frame, which meant it landed on whatever the pointer was over -- and
  // the thing the pointer is over during a drag is a lit gate panel, which is
  // the one background it was least readable on.
  rr(c, x, y, w, h, 8)
  c.fillStyle = MENU_BG; c.fill()
  c.lineWidth = 1.5; c.strokeStyle = d.ok ? P.cool : P.warn; c.stroke()

  c.font = '700 13px Arial'; c.textAlign = 'left'
  c.fillStyle = d.ok ? P.cool : P.warn
  c.fillText(label, x + 12, y + 16)
  if (hint) {
    c.font = '600 11px Arial'
    c.fillStyle = d.ok ? 'rgba(255,255,255,0.62)' : tint(P.warn, 0.85)
    c.fillText(hint, x + 12, y + 38)
  }
  c.textBaseline = 'alphabetic'
  c.restore()
}

// -------------------------------------------------------------- the shifter
//
// A four-position gate on the console, RIGHT OF THE WHEEL, at RAVIO's rect. The
// gap is real estate that already existed: the yoke's rim ends at design 1438
// and the DRIVE dial's begins at 1622, so 1452..1604 is the one column on this
// dash wide enough for a control and empty.
//
// Why a shifter rather than a row of buttons -- RAVIO's argument, which carries
// over unchanged: an instrument should be the thing it represents. A gauge is a
// tube because a tube is either lit or dark. A mode selector in a car is a
// gearstick, it has detents you can feel, and it is always in exactly one of
// them. A tab bar would have been three pixels cheaper and one metaphor poorer.
export const GEARS = [
  { id: 'P', name: 'PARK',   sub: 'the drive-in' },
  { id: 'R', name: 'REEL',   sub: 'c u l8er' },
  { id: 'C', name: 'CAMERA', sub: 'the room + mic' },
  { id: 'D', name: 'DRIVE',  sub: 'the road' },
]
export const SHIFT = { x: 1452, y: 828, w: 152, h: 240, r: 16 }

function detent(i) {
  const pad = 34
  const span = SHIFT.h - pad * 2
  return { cx: SHIFT.x + 34, cy: SHIFT.y + pad + (span * i) / (GEARS.length - 1) }
}

// Which detent a design-space point is in, or -1. The plate's full width, and a
// band per gear rather than a small circle -- a detent is a thing you knock the
// stick into, not a target you have to hit.
export function shiftAt(x, y) {
  if (x < SHIFT.x || x > SHIFT.x + SHIFT.w) return -1
  if (y < SHIFT.y || y > SHIFT.y + SHIFT.h) return -1
  let best = -1, bd = 1e9
  for (let i = 0; i < GEARS.length; i++) {
    const d = Math.abs(y - detent(i).cy)
    if (d < bd) { bd = d; best = i }
  }
  return best
}

function drawShifter(c, st) {
  const g = SHIFT, sel = Math.max(0, GEARS.findIndex((x) => x.id === (st.gear || 'D')))
  const hov = st.hoverGear ?? -1
  const ht = st.hoverT || 0

  rr(c, g.x, g.y, g.w, g.h, g.r)
  const plate = c.createLinearGradient(g.x, g.y, g.x, g.y + g.h)
  plate.addColorStop(0, '#1b1409'); plate.addColorStop(1, '#0a0a10')
  c.fillStyle = plate; c.fill()
  c.lineWidth = 2.5; c.strokeStyle = P.rim; c.globalAlpha = 0.75; c.stroke()
  c.globalAlpha = 1

  // the gate: a slot the knob actually runs in
  const a = detent(0), z = detent(GEARS.length - 1)
  c.lineCap = 'round'
  c.beginPath(); c.moveTo(a.cx, a.cy); c.lineTo(z.cx, z.cy)
  c.lineWidth = 26; c.strokeStyle = '#04050a'; c.stroke()
  c.lineWidth = 22; c.strokeStyle = '#0b0d16'; c.stroke()
  c.lineCap = 'butt'

  GEARS.forEach((gr, i) => {
    const d = detent(i)
    const on = i === sel, hot = i === hov ? ht : 0
    // A GEAR WHOSE SCENE IS NOT BUILT IS DRAWN DIMMER AND SAYS SO ON HOVER. It
    // is still in the gate -- a detent you can see and cannot use is honest; a
    // missing detent would say the gate has three positions, which it does not.
    const built = !st.unbuilt || !st.unbuilt.includes(gr.id)
    c.beginPath(); c.arc(d.cx, d.cy, 9, 0, Math.PI * 2)
    c.fillStyle = on ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,' + (0.1 + 0.22 * hot).toFixed(3) + ')'
    c.fill()
    c.textAlign = 'left'; c.textBaseline = 'middle'
    c.font = on ? '900 26px "Arial Black",Arial' : '800 22px Arial'
    c.fillStyle = on ? P.accent
               : 'rgba(255,255,255,' + ((built ? 0.42 : 0.22) + 0.45 * hot).toFixed(3) + ')'
    c.fillText(gr.id, d.cx + 26, d.cy - 5)
    c.font = '600 10px Arial'
    c.fillStyle = on ? tint(P.accent, 0.72)
               : 'rgba(255,255,255,' + ((built ? 0.22 : 0.12) + 0.3 * hot).toFixed(3) + ')'
    c.fillText(gr.name, d.cx + 26, d.cy + 10)
    // The SUBTITLE only under the pointer: it says what the gear is for, which
    // you want while choosing and not while driving. Four permanent captions in
    // a 152px column is a wall of small type on an instrument panel.
    if (hot > 0.02) {
      c.font = '600 10px Arial'
      c.fillStyle = built ? 'rgba(45,226,230,' + (0.85 * hot).toFixed(3) + ')'
                          : 'rgba(255,90,60,' + (0.85 * hot).toFixed(3) + ')'
      c.fillText(built ? gr.sub : 'not built', d.cx + 26, d.cy + 23)
    }
    c.textBaseline = 'alphabetic'
  })

  // THE KNOB, at the selected detent. `gearT` is a POSITION along the gate, not
  // a flag -- the stick slides between notches the way a stick does, so the gear
  // you are in is legible from the hardware and not only from which letter is
  // amber.
  const t = typeof st.gearT === 'number' ? st.gearT : sel
  const i0 = Math.max(0, Math.min(GEARS.length - 1, Math.floor(t)))
  const i1 = Math.max(0, Math.min(GEARS.length - 1, Math.ceil(t)))
  const d0 = detent(i0), d1 = detent(i1), f = t - i0
  const kx = d0.cx + (d1.cx - d0.cx) * f, ky = d0.cy + (d1.cy - d0.cy) * f

  c.beginPath(); c.arc(kx, ky, 16, 0, Math.PI * 2)
  const kn = c.createRadialGradient(kx - 5, ky - 6, 2, kx, ky, 18)
  kn.addColorStop(0, '#5b4a2a'); kn.addColorStop(0.55, '#241a10')
  kn.addColorStop(1, '#0a0a10')
  c.fillStyle = kn; c.fill()
  c.lineWidth = 2.5; c.strokeStyle = P.accent; c.stroke()
  c.beginPath(); c.arc(kx - 4, ky - 5, 4.5, 0, Math.PI * 2)
  c.fillStyle = 'rgba(255,255,255,0.20)'; c.fill()
}

// -------------------------------------------------------------- the mirrors
//
// A mirror head is ONE object made of two things: the housing painted here, and
// a glass that will be a picture later. RAVIO's rects, verbatim.
export const MIRROR = { w: 304, h: 171, y: 536, r: 12, inset: 7, lx: 24, rx: DW - 328 }

export const MIRROR_PERSP_X = 3
export const mirrorPersp = (glassW) => glassW * MIRROR_PERSP_X

// `perspective(P) rotateY(deg)` about (cx, cy), written out longhand. rotateY
// takes a point dx off the axis to dx*cos and pushes it dx*sin away from the
// eye; the divide that follows IS the foreshortening -- near edge grows, far
// edge shrinks, top and bottom cant toward each other. `k` comes back third: it
// is how much the surface is magnified at that point, which is what anything
// drawn ON the face has to be scaled by.
export function mirrorTurn(deg, persp, cx, cy) {
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t)
  return (x, y) => {
    const dx = x - cx, k = persp / (persp + dx * sin)
    return [cx + dx * cos * k, cy + (y - cy) * k, k]
  }
}

// Text on a turned face, drawn a CHARACTER AT A TIME. One `scale()` for the
// whole line is an affine, and an affine cannot taper: at a few degrees that
// error is a third of a pixel, but at a real tilt the near end of a caption is
// magnified some 17% more than the far end, and a line of type that ignores
// that sits on the surface like a decal rather than like something printed on it.
function turnedText(c, text, cx, cy, turn, cos) {
  const total = c.measureText(text).width
  let dx = -total / 2
  for (const ch of text) {
    const cw = c.measureText(ch).width
    const [px, py, k] = turn(cx + dx + cw / 2, cy)
    c.save()
    c.translate(px, py); c.scale(cos * k, k)
    c.fillText(ch, 0, 0)
    c.restore()
    dx += cw
  }
}

// The outline `rr` lays down, walked as points and put through `turn`. Canvas 2D
// cannot do this with its own transform: that transform is AFFINE, and an affine
// maps a rectangle to a parallelogram -- it can squeeze and shear but it cannot
// taper, which is the one thing a turn is made of. The corners are sampled for
// the same reason: the projection of an arc is not an arc.
function rrTurned(c, x, y, w, h, r, turn) {
  const SEG = 5
  const pts = []
  const corner = (ax, ay, a0) => {
    for (let i = 0; i <= SEG; i++) {
      const a = a0 + (Math.PI / 2) * (i / SEG)
      pts.push([ax + Math.cos(a) * r, ay + Math.sin(a) * r])
    }
  }
  corner(x + w - r, y + r, -Math.PI / 2)
  corner(x + w - r, y + h - r, 0)
  corner(x + r, y + h - r, Math.PI / 2)
  corner(x + r, y + r, Math.PI)
  c.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = turn(pts[i][0], pts[i][1])
    if (i) c.lineTo(px, py); else c.moveTo(px, py)
  }
  c.closePath()
}

// Where a mirror's GLASS lands in canvas pixels. Same discipline as monRect:
// the thing that paints the housing and the thing that puts a picture in it
// read one definition.
export function mirrorRect(side, W, H, ty, s) {
  const i = MIRROR.inset
  const x = (side === 'left' ? MIRROR.lx : MIRROR.rx) + i
  return { x: x * s, y: ty + (MIRROR.y + i) * s,
           w: (MIRROR.w - i * 2) * s, h: (MIRROR.h - i * 2) * s }
}

// DOES THIS MIRROR STILL HAVE ITS OWN AIR? A measured overlap against the
// monitor's bezel rather than a threshold picked by eye -- a constant would need
// re-picking the first time MON or MIRROR moves.
export function mirrorClear(side) {
  const m = monBezel(MON)
  const x = side === 'left' ? MIRROR.lx : MIRROR.rx
  // The label plate sits 19px above the housing and is part of the fitting.
  const y = MIRROR.y - 19, h = MIRROR.h + 19
  return !(x < m.x + m.w && x + MIRROR.w > m.x && y < m.y + m.h && y + h > m.y)
}

function drawMirror(c, side, st) {
  const x = side === 'left' ? MIRROR.lx : MIRROR.rx
  const y = MIRROR.y, w = MIRROR.w, h = MIRROR.h
  const live = !!(st.mirrorLive && st.mirrorLive[side])

  // the stalk, drawn first so the housing sits on top of its own mount
  const sx = x + w / 2
  c.beginPath()
  c.moveTo(sx - 13, y + h - 6); c.lineTo(sx + 13, y + h - 6)
  c.lineTo(sx + 9, 764); c.lineTo(sx - 9, 764); c.closePath()
  const sg = c.createLinearGradient(sx - 13, 0, sx + 13, 0)
  sg.addColorStop(0, '#0b0f1c'); sg.addColorStop(0.5, P.panel2); sg.addColorStop(1, '#0b0f1c')
  c.fillStyle = sg; c.fill()
  c.lineWidth = 2; c.strokeStyle = P.rim; c.globalAlpha = 0.6; c.stroke()
  c.globalAlpha = 1

  // The head turns on the stalk drawn above -- the mount stays put, the fitting
  // and its glass swing together. `turn` is null at rest so a mirror nobody is
  // touching keeps `rr`'s real arcs instead of a polygon standing in for them.
  const deg = (st.mirTilt && st.mirTilt[side]) || 0
  const turn = deg
    ? mirrorTurn(deg, mirrorPersp(w - MIRROR.inset * 2), x + w / 2, y + h / 2)
    : null
  if (turn) rrTurned(c, x, y, w, h, MIRROR.r, turn)
  else rr(c, x, y, w, h, MIRROR.r)
  c.fillStyle = '#05070e'; c.fill()
  c.lineWidth = 3; c.strokeStyle = live ? P.accent : P.rim
  c.globalAlpha = live ? 1 : 0.55; c.stroke(); c.globalAlpha = 1

  // A DARK HOUSING WITH NOTHING IN IT is indistinguishable from a rendering
  // fault, so the empty state has to say WHICH nothing it is. Only drawn when
  // the glass is dark; a live mirror has its own picture and does not want a
  // caption over it.
  if (!live) {
    c.save()
    c.textAlign = 'center'; c.textBaseline = 'middle'
    const cos = Math.cos((deg * Math.PI) / 180)
    const line = (text, dy, fill, font) => {
      c.fillStyle = fill; c.font = font
      if (turn) turnedText(c, text, x + w / 2, y + h / 2 + dy, turn, cos)
      else c.fillText(text, x + w / 2, y + h / 2 + dy)
    }
    const empty = st.mirrorEmpty || {}
    line(empty[side]?.[0] || '', -7, 'rgba(255,255,255,0.30)', '700 13px Arial')
    line(empty[side]?.[1] || '', 13, 'rgba(255,255,255,0.18)', '600 11px Arial')
    c.textBaseline = 'alphabetic'
    c.restore()
  }

  // The label sits ABOVE the housing, which is open sky -- and open sky is where
  // the signs are. Amber text straight onto a passing window is two pieces of
  // writing in the same place, so it gets its own ground first.
  const tag = (st.mirrorTag || {})[side] || ''
  c.textAlign = 'left'
  c.font = '700 11px Arial'
  const tw = c.measureText(tag).width
  rr(c, x + 1, y - 19, tw + 14, 16, 5)
  c.fillStyle = 'rgba(4,6,12,0.82)'; c.fill()
  c.fillStyle = live ? P.accent : 'rgba(255,255,255,0.42)'
  c.fillText(tag, x + 8, y - 8)
}

// The top-centre pill. RAVIO's says which lane is on and what milepost you are
// at; this one says which workspace is on and which DASH you are standing at,
// which is the same question asked of the grid this fork actually has.
export const PILL = { w: 520, h: 92, x: DW / 2 - 260, y: 40 }

function pillPlate(c, W, H, s, ty, pill) {
  if (!pill) return
  // PINNED TO THE WINDOW'S TOP, not the design space's. The dash is anchored to
  // the bottom and the design box is taller than most viewports, so a pill at
  // design y=40 is off the top of the screen on anything short. It rides the
  // frame instead, and the transform below is undone for exactly this one plate.
  const x = PILL.x, y = (40 - ty / s) < 0 ? -ty / s + 20 : 40
  c.save()
  c.globalAlpha = 0.86; rr(c, x, y, PILL.w, PILL.h, 18)
  c.fillStyle = '#05060b'; c.fill()
  c.globalAlpha = 1; c.lineWidth = 2.5; c.strokeStyle = P.rim; c.stroke()
  c.textAlign = 'left'; c.textBaseline = 'middle'
  c.fillStyle = 'rgba(255,255,255,0.5)'; c.font = '700 13px Arial'
  c.fillText(pill.lane, x + 26, y + 24)
  c.fillStyle = P.accent; c.font = '900 52px "Arial Black", Arial'
  c.shadowColor = P.accent; c.shadowBlur = 16
  c.fillText(pill.big, x + 24, y + 60)
  c.shadowBlur = 0
  c.fillStyle = pill.warn ? P.warn : P.accent
  c.font = '700 15px Arial'; c.textAlign = 'right'
  c.fillText(pill.right, x + PILL.w - 26, y + 46)
  c.textBaseline = 'alphabetic'
  c.restore()
}

// ---------------------------------------------------------------- the cockpit

// THE DASH IS ANCHORED TO THE BOTTOM AND LIFTED BY ONE TERM. Everything is drawn
// in the original 1920x1080 design space and mapped by one transform, which is
// the only way an authored layout survives a different window size. `hide` is
// the only thing that moves it, and it moves the whole panel rather than
// re-laying it out, so the instruments never move relative to each other.
export function createDash({ canvas, yokeCanvas, makeYoke, rack, state, camera, card, pill,
                             mirrors, onGear, cast, programs, unbuilt = [] }) {
  const c = canvas.getContext('2d')
  const drawn = {}
  let W = 0, H = 0, pr = 1
  // How far down the panel is pushed, 0 = seated, 1 = fully off the bottom.
  let hidden = 0
  let lastT = 0, frameMs = null
  let lastPos = null, speed = null, roll = 0
  let reachY = 0
  let frames = 0
  // The gate. `gear` is which detent the stick is IN; `gearT` is where the knob
  // is between detents, eased -- a position along the gate, not a flag.
  let gear = 'D'
  let gearT = GEARS.findIndex((g) => g.id === 'D')
  let hoverGear = -1, hoverT = 0
  let lastRefusal = null
  // Whether the channel dropdown is open. Dash-local: nothing outside this file
  // needs to know, and a menu whose open-state lived in the shell would be a
  // second thing to keep in step with the thing that draws it.
  let menuOpen = false
  // Whether the ST&RT menu is open, which row the pointer is on, and -- while a
  // program is being dragged out of it -- what the ghost under the pointer says.
  // Dash-local for the same reason `menuOpen` is: shell.js drives all three
  // through the hits this file reports, and nothing else needs to know.
  //
  // `drag` is SET BY THE SHELL rather than tracked here. The drop target is a
  // raycast against the road, which this file cannot do and must not learn to do
  // -- so the shell resolves it and hands back the two strings to paint.
  let startOpen = false
  let startHot = null
  let drag = null
  // The power key's confirm plate: whether it is up, whether the pointer is on
  // the one row, and what the last attempt to end the session came back with.
  //
  // ANYTHING IN `powerWhy` IS A FAULT, INCLUDING THE SUCCESSES. A logout that
  // works takes this page down with it, so a message that is still on the screen
  // long enough to be read means you are still here -- either the bridge refused
  // and said why, or it signalled something that has not gone. That is why the
  // footer paints it in the warn colour without asking which of the two it was.
  let powerOpen = false
  let powerHot = false
  let powerWhy = null
  // THE COCKPIT, PULLED UP OVER A FLATTENED WINDOW. Off by default, because the
  // reason the dash gets out of the way while flat still holds -- the surface is
  // pixel-exact and an instrument panel over it hides client pixels. This is you
  // asking for it anyway, which is a different thing from the shell deciding.
  let flatRaised = false
  // Where the pointer is, in client px. Only used to decide whether to HINT: a
  // tab that is always up is furniture, and one that never appears cannot be
  // found. Null until the pointer has moved at least once.
  let ptrX = null, ptrY = null
  // Advanced by the frame rather than read off the clock, so a tab that was in
  // the background does not bring the ship back mid-screen at a random phase.
  let flyT = 0

  // THE MESH, OR HONESTLY NOT. A second WebGL context is a thing a browser can
  // refuse -- this page already holds one that three and Greenfield share, and
  // that one is the one that matters. If the yoke cannot be built the flat
  // `wheel()` below is drawn instead and `__yoke()` says which happened, because
  // a black square and an unlit mesh look identical in a screenshot.
  let yoke = null, yokeFault = null
  // `?yoke=0` DECLINES IT WITHOUT EDITING CODE. A second context is a real cost
  // on a page that already holds the one three and Greenfield share, and when
  // contexts are the thing you are short of, the way to test that has to not
  // require a rebuild.
  const yokeWanted = new URLSearchParams(location.search).get('yoke') !== '0'
  if (yokeCanvas && makeYoke && yokeWanted) {
    try {
      yoke = makeYoke(yokeCanvas, P)
      if (!yoke) yokeFault = 'no context granted'
    } catch (e) {
      yokeFault = String(e && e.message ? e.message : e)
    }
  } else {
    yokeFault = yokeWanted ? 'not requested' : 'declined by ?yoke=0'
  }
  if (!yoke && yokeCanvas) yokeCanvas.style.display = 'none'

  // ITS OWN REAPER, not a line in shell.js's.
  //
  // shell.js hands the road's context back on `pagehide`, but that listener is
  // registered inside main() AFTER the compositor session exists -- so a shell
  // that fails before then never reaps anything. This context is taken in
  // buildWorld, earlier, and a boot that dies between the two is exactly the
  // case where you are about to reload several times in a row. It reaps itself.
  if (yoke) window.addEventListener('pagehide', () => yoke.dispose())

  // THE DASH'S ONE TRANSFORM, named once. Four things convert design space to
  // client space now -- the painter, the pointer, the yoke's canvas and the TV's
  // quad -- and the first three each used to spell it out. A fourth copy is what
  // finally makes them drift, and the one that drifts is the quad: a screen a few
  // pixels out of its own bezel is the most visible way this could go wrong.
  function layout() {
    const s = W / DW
    return { s, ty: H - DH * s + hidden * (DH - REACH + 40) * s }
  }

  function size() {
    const w = window.innerWidth || 1280
    const h = window.innerHeight || 720
    // Capped at 2. The shell already runs the scene at pixelRatio 1 and a 3x
    // phone ratio would triple this canvas's fill cost for a panel nobody reads
    // at that density.
    pr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * pr)
    canvas.height = Math.round(h * pr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    W = w; H = h
  }

  // WHY THE DASHBOARD GETS OUT OF THE WAY, and it is not a nicety.
  //
  // A flattened window is PIXEL-EXACT (§10.2) -- that is the whole claim M2
  // makes. A panel painted over the bottom third of it does not break the
  // scale, but it does hide part of a surface the shell has just promised is
  // 1:1, and a client with a status bar at the bottom would have it covered by
  // an instrument. So the cockpit slides out while you are standing in a window,
  // and while the map is up for the same reason: that view already spends the
  // whole frame on itself.
  function wantHidden() {
    // The map is never negotiable: that view spends the whole frame on itself.
    const map = document.getElementById('map')
    if (map && !map.hidden) return 1
    if (state?.mode === 'flat') return flatRaised ? 0 : 1
    // Leaving the window puts the cockpit back where it belongs AND forgets that
    // you had pulled it up, so the next window you stand in starts pixel-exact
    // again. A raise is a thing you asked for about THIS window.
    flatRaised = false
    return 0
  }

  // ---- the pull tab --------------------------------------------------------
  //
  // The one control that exists while the dashboard does not, so it is measured
  // in CLIENT pixels rather than design space -- it is about the edge of the
  // screen, not about a position on a panel that is currently off it.
  const PULL = { w: 250, h: 26, reach: 110 }

  // ONE POSITION IN BOTH STATES, and it is not the centre of the frame.
  //
  // Raised, it was put in the band just above the hood -- which is exactly where
  // `#why` is pinned, so the strip that names what is over its redline was
  // printed straight across it. Centred at the bottom instead, it lands on the
  // yoke's left rim. The band under the TV is the one place at the bottom edge
  // that is clear of both, and it is the right place for another reason: what
  // you pull the cockpit up FOR is mostly the screen.
  //
  // Derived from MON rather than measured against this viewport, so it stays put
  // under the bezel at any window size.
  function pullRect() {
    const s = W / DW
    const cx = (MON.x + MON.w / 2) * s
    return {
      x: Math.round(cx - PULL.w / 2),
      y: Math.round(H - PULL.h - 4),
      w: PULL.w, h: PULL.h,
    }
  }

  // Shown while standing in a window, and only then: on the road the dashboard
  // is already up and there is nothing to pull. Raised, it is always shown --
  // a panel you can put up and not take down is a panel that has covered the
  // window you were working in.
  function pullVisible() {
    if (state?.mode !== 'flat') return false
    // Nothing of the cockpit is offered while full screen is on -- including the
    // handle that would bring it back. The ship is the only way out, which is
    // what makes "no permanent bar" true rather than nearly true.
    if (state?.full) return false
    if (flatRaised) return true
    return ptrY !== null && ptrY >= H - PULL.reach
  }

  // ---- the flying exit ------------------------------------------------------
  //
  // FULL SCREEN HAS NO BAR, AND THAT IS THE POINT. A strip pinned to the bottom
  // of the screen is a strip over whatever the application put there -- and the
  // bottom edge is where applications put the things you click. So the way out
  // is not drawn at all until you go looking for it: bring the pointer down to
  // the bottom and the ship comes across the screen; click it and you are out.
  //
  // IT MOVES, and that is not decoration either. A mark that appeared and sat
  // still would be a bar that fades in -- same footprint, same problem, one
  // animation. A ship crossing the screen occupies a different few hundred
  // pixels every moment, so nothing underneath is permanently covered, and it is
  // unmistakably the shell rather than part of the page.
  // BIGGER AND SLOWER than the first pass (34 / 5.2s), and both for the same
  // reason: it is a thing you have to CATCH. At 34px crossing in 5.2s it moved
  // about 270px a second, which is a target you chase rather than one you meet.
  // 64px at 11s is ~130px a second against a 74px radius -- half a second of
  // dwell on any given spot, which is a click and not a reflex test.
  const FLY = { r: 64, band: 120, period: 11 }

  // Its centre right now, in client px, or null when it is not flying. One
  // definition for the painter and the hit test -- a target that lags the mark by
  // a frame is a target you chase.
  function flyAt() {
    if (!state?.full) return null
    if (ptrY === null || ptrY < H - FLY.band) return null
    // A full sweep out and back, eased at the turns so it reads as flying rather
    // than as a value being animated. `flyT` is advanced by the frame, not read
    // off the clock, so a backgrounded tab does not teleport it.
    const t = (Math.sin(flyT * ((Math.PI * 2) / FLY.period)) + 1) / 2
    const margin = FLY.r + 24
    return { x: margin + t * (W - margin * 2), y: H - FLY.band / 2, r: FLY.r }
  }

  function drawFly() {
    const f = flyAt()
    if (!f) return
    c.save()
    c.setTransform(pr, 0, 0, pr, 0, 0)
    // A disc of shadow under it, so the ship reads against a light application
    // as well as a dark one. The shell cannot know what is behind it here.
    c.beginPath(); c.arc(f.x, f.y, f.r * 1.15, 0, Math.PI * 2)
    c.fillStyle = 'rgba(3,4,10,0.55)'; c.fill()
    c.translate(f.x, f.y)
    // Banking into the turn: it leans the way it is going, which is what makes a
    // sweep read as one object flying rather than two ends of a slider.
    const dir = Math.cos(flyT * ((Math.PI * 2) / FLY.period))
    c.rotate(dir * 0.12)
    saucer(c, f.r / 100)
    c.restore()
    // NO CAPTION. There was one -- "click to leave full screen", pinned to the
    // bottom centre -- and it was the very thing full screen exists to avoid: a
    // permanent strip across the bottom of the application, only appearing at the
    // moment you have brought the pointer down to click something there. The ship
    // has to carry its own meaning; a moving mark that is plainly the shell's is
    // the whole affordance.
  }

  function drawPull() {
    if (!pullVisible()) return
    const r = pullRect()
    const hot = ptrX !== null && ptrX >= r.x && ptrX <= r.x + r.w
              && ptrY !== null && ptrY >= r.y - 6 && ptrY <= r.y + r.h + 6
    c.save()
    c.setTransform(pr, 0, 0, pr, 0, 0)
    rr(c, r.x, r.y, r.w, r.h, 8)
    c.fillStyle = hot ? 'rgba(8,14,22,0.94)' : 'rgba(4,6,12,0.82)'
    c.fill()
    c.lineWidth = 1.5
    c.strokeStyle = hot ? P.cool : tint(P.cool, 0.45)
    c.stroke()
    c.fillStyle = hot ? P.cool : tint(P.cool, 0.7)
    c.font = '700 12px ui-monospace, monospace'
    c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText(flatRaised ? '\u25BC  hide the dashboard' : '\u25B2  the dashboard',
               r.x + r.w / 2, r.y + r.h / 2 + 1)
    c.textBaseline = 'alphabetic'
    c.restore()
  }

  function draw(now = 0) {
    if (canvas.width !== Math.round((window.innerWidth || 1280) * pr)
        || canvas.height !== Math.round((window.innerHeight || 720) * pr)) size()

    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    if (lastT) frameMs = now - lastT
    lastT = now
    frames++

    // Eased, so the panel leaves and returns rather than blinking. 6/sec is
    // about 170ms end to end, which is under the flight time it usually
    // overlaps.
    flyT += dt
    const want = wantHidden()
    hidden += (want - hidden) * Math.min(1, dt * 6)
    if (Math.abs(want - hidden) < 0.002) hidden = want
    // A MENU CANNOT OUTLIVE THE PANEL IT STANDS ON. `hit()` already returns null
    // once the cockpit is out of the way, so an open ST&RT menu on a departing
    // dash is a list that is drawn and cannot be pressed -- and it is drawn at
    // full alpha, because that is the whole point of the plate, so it would be
    // the one thing left hanging over a flattened window.
    if (hidden > 0.5 && startOpen) { startOpen = false; startHot = null }
    if (hidden > 0.5 && powerOpen) { powerOpen = false; powerHot = false }

    // HOW FAST YOU ARE ACTUALLY GOING, measured here off the camera rather than
    // read from a field Travel does not publish. Two terms, both real: the
    // distance the camera covered this frame, and how much of that was sideways
    // -- which is the only steering signal this shell has, and it is what the
    // yoke rolls to.
    if (camera) {
      const p = camera.position
      if (lastPos && dt > 0) {
        const dx = p.x - lastPos.x, dy = p.y - lastPos.y, dz = p.z - lastPos.z
        const inst = Math.hypot(dx, dy, dz) / dt
        // Smoothed, because a per-frame speed off a stepped flight is noise you
        // cannot read. The smoothing is on the DISPLAY, not on the measurement:
        // `report()` says so.
        speed = speed === null ? inst : speed + (inst - speed) * 0.15
        const wantRoll = Math.max(-0.7, Math.min(0.7, (dx / dt) / 900))
        roll += (wantRoll - roll) * Math.min(1, dt * 5)
      }
      lastPos = { x: p.x, y: p.y, z: p.z }
    }

    c.setTransform(pr, 0, 0, pr, 0, 0)
    c.clearRect(0, 0, W, H)
    if (hidden >= 0.999) {
      reachY = H
      // THE TAB IS DRAWN AFTER THE EARLY RETURN'S JOB, not before it. This is the
      // one thing that has to exist while the dashboard does not -- a hint that
      // returns nothing because the panel it belongs to is off screen is a hint
      // nobody can ever act on.
      drawPull()
      drawFly()
      drawDragGhost(c, drag, W, H)
      publish()
      return
    }
    c.save()
    c.globalAlpha = 1 - hidden * 0.85

    const { s, ty } = layout()
    c.translate(0, ty)
    c.scale(s, s)

    // The hood: one filled curve from the crown down past the bottom of the
    // design box, so a viewport taller than 1080/1920 still has dash under it
    // rather than a strip of sky beneath the panel.
    const topY = 712
    const BOT = DH + 460
    const grad = c.createLinearGradient(0, topY - 46, 0, BOT)
    grad.addColorStop(0, P.panel2)
    grad.addColorStop(0.18, P.panel)
    grad.addColorStop(1, '#04050a')
    c.beginPath()
    c.moveTo(0, BOT); c.lineTo(0, topY + 40)
    c.quadraticCurveTo(DW / 2, topY - 46, DW, topY + 40)
    c.lineTo(DW, BOT); c.closePath()
    c.fillStyle = grad; c.fill()
    c.beginPath()
    c.moveTo(0, topY + 40)
    c.quadraticCurveTo(DW / 2, topY - 46, DW, topY + 40)
    c.lineWidth = HOOD.lw; c.strokeStyle = P.accent
    c.globalAlpha *= 0.5; c.stroke(); c.globalAlpha /= 0.5

    // FRAME on the left, DRIVE on the right -- RAVIO's two dial centres, to the
    // design pixel. Both read null until they have been measured once, and a
    // dial with nothing to show draws n/r rather than a needle at rest.
    //
    // FRAME is against 33.3ms, so half scale is 60fps and the redline arc at 0.8
    // lands at 26.6ms -- a frame that has missed 30fps. Not against 16.7, where
    // an ordinary 60fps frame would sit pinned at full deflection and the dial
    // would only ever be able to say "bad".
    const frameNorm = frameMs === null ? null : Math.min(1, frameMs / 33.3)
    gauge(c, 176, 892, 122, frameNorm, 'FRAME')
    // 900 units/sec: one GATE_GAP of road per second, which is the run between
    // the gate and the first window and the fastest the flight ever covers
    // ground. A dial needs a full-scale that means something and this is the one
    // number on this road that does.
    const speedNorm = speed === null ? null : Math.min(1, speed / 900)
    gauge(c, 1744, 892, 122, speedNorm, 'DRIVE')

    c.fillStyle = P.accent; c.font = '700 30px Arial'; c.textAlign = 'center'
    c.fillText(speed === null ? '—' : speed.toFixed(0), 1744, 1004)
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.font = '600 13px Arial'
    c.fillText('UNITS/SEC', 1744, 1024)

    c.fillStyle = P.accent; c.font = '700 30px Arial'; c.textAlign = 'center'
    c.fillText(frameMs === null ? '—' : frameMs.toFixed(1), 176, 1004)
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.font = '600 13px Arial'
    c.fillText('MS/FRAME', 176, 1024)

    // MIRRORS BEFORE THE MONITOR, because the monitor is allowed to cover them.
    // They are mounted in the windshield above the hood, so they are painted
    // after the hood and before anything that stands in front of it -- and
    // `mirrorClear` refuses to draw one whose housing the monitor's bezel has
    // taken, rather than drawing a fitting that is about to be painted over.
    const mir = mirrors ? mirrors() : null
    if (mir) {
      for (const side of ['left', 'right']) if (mirrorClear(side)) drawMirror(c, side, mir)
    }

    tubeRack(c, rack, drawn)

    // The knob slides rather than jumps. 8/sec across a four-notch gate is about
    // 130ms end to end, which is a stick being moved and not a value changing.
    const wantGear = GEARS.findIndex((g) => g.id === gear)
    gearT += (wantGear - gearT) * Math.min(1, dt * 8)
    if (Math.abs(wantGear - gearT) < 0.002) gearT = wantGear
    hoverT += ((hoverGear >= 0 ? 1 : 0) - hoverT) * Math.min(1, dt * 9)

    // `card:` NESTED, not spread. drawMonitor reads `st.card`, and spreading it
    // into `st` left every field undefined and the TV quietly painting its own
    // fallbacks -- "T&R" and an em dash -- which looks exactly like a card that
    // has nothing to say rather than like a wiring fault.
    const cs = castState()
    drawMonitor(c, { card: cardOf(), gear, onAir: cs.onAir, castList: cs.list,
                     castTitle: cs.title, menuOpen }, frames)
    drawShifter(c, { gear, gearT, hoverGear, hoverT, unbuilt })

    // THE MESH GOES ON ITS OWN CANVAS, and the flat wheel is skipped when it is
    // up -- painting both would put a flat yoke behind a lit one at the same
    // coordinates. The fallback stays in the file on purpose: see the note where
    // the context is asked for.
    if (yoke) {
      const wr = wheelRect(W, H, ty, s)
      yokeCanvas.style.left = wr.x + 'px'
      yokeCanvas.style.top = wr.y + 'px'
      yokeCanvas.style.width = wr.w + 'px'
      yokeCanvas.style.height = wr.h + 'px'
      yokeCanvas.style.opacity = String(1 - hidden)
      yoke.render(roll, 0, Math.max(1, Math.round(wr.w)), Math.max(1, Math.round(wr.h)))
    } else {
      wheel(c, WHEEL.x, WHEEL.y, WHEEL.r, roll, 0)
    }

    pillPlate(c, W, H, s, ty, pill ? pill() : null)

    // LAST ON THE PANEL, so it covers the hood, the left dial and the mirror it
    // opens across -- which is what a start menu does everywhere else, and is
    // also why `hit()` asks about it first.
    const ps = programState()
    drawPower(c, { powerOpen })
    drawStart(c, { startOpen })
    drawStartMenu(c, { startOpen, startHot, programs: ps.list, programsFrom: ps.from,
                       open: ps.open, cost: ps.cost })
    // AFTER the ST&RT menu, because the two plates overlap and this one is the
    // one that ends the session -- a confirmation half-covered by the list of
    // things it is about to close is a confirmation you cannot read.
    drawPowerMenu(c, { powerOpen, powerHot, powerWhy, open: ps.open })

    c.restore()

    reachY = ty + REACH * s
    // After the restore, so it is in client pixels and rides the frame rather
    // than the panel -- and after `reachY` is set, because that is what it hangs
    // from once the dash is up.
    drawPull()
    drawFly()
    drawDragGhost(c, drag, W, H)
    publish()
  }

  // What the TV is showing. Kept as a function so the gear can pick the card
  // without shell.js having to know the gate exists.
  function cardOf() {
    const from = card ? card(gear) : null
    return from || {}
  }

  // WHAT IS ON AIR AND WHAT IS ON THE LIST, read at call time. Held as a
  // callback rather than pushed in, so the painter and the hit test cannot be
  // looking at two different lists a frame apart -- which is exactly how a chip
  // ends up removing the window next to the one you pressed.
  function castState() {
    const s = cast ? cast() : null
    return { onAir: !!s?.onAir, list: s?.list || [], title: s?.title || null,
             onAirKey: s?.onAirKey ?? null }
  }

  // WHAT THE ST&RT MENU IS OFFERING, read at call time for exactly the reason
  // `castState` is: the painter and the hit test must be looking at ONE list, or
  // a row moves between the frame you saw and the press you made and the shell
  // launches the program under the one you meant.
  function programState() {
    const s = programs ? programs() : null
    return { list: s?.list || [], from: s?.from || '',
             open: s?.open ?? null, cost: s?.cost || null }
  }

  // ---- the one place the cockpit takes a pointer -------------------------
  //
  // The canvas itself is `pointer-events: none` and stays that way. RRABBIT
  // resolves clicks with a raycast against the road from a listener on `#gl`,
  // and a second element competing for the same events is the shape of the bug
  // that once ate every click in the graph box. So instead the dash ANSWERS a
  // question the existing handler asks first: is this point one of my controls?
  // One input path, one owner, and the shifter is still a thing you can knock
  // into gear.
  function designPoint(clientX, clientY) {
    if (hidden > 0.5) return null
    const { s, ty } = layout()
    return [clientX / s, (clientY - ty) / s]
  }

  function hit(clientX, clientY) {
    // THE SHIP IS ASKED BEFORE ANYTHING ELSE. While full screen is on it is the
    // only control the shell has left, and everything below this line is either
    // unarmed or off screen in that state.
    const f = flyAt()
    if (f && Math.hypot(clientX - f.x, clientY - f.y) <= f.r * 1.15) {
      return { kind: 'exitFull' }
    }

    // THE TAB IS ASKED FIRST AND OUTSIDE THE DESIGN TRANSFORM. `designPoint`
    // returns null whenever the cockpit is out of the way, which is exactly when
    // this control is the only one there is -- testing it after would make the
    // pull tab unreachable in the single state it exists for.
    if (pullVisible()) {
      const r = pullRect()
      if (clientX >= r.x && clientX <= r.x + r.w && clientY >= r.y && clientY <= r.y + r.h) {
        return { kind: 'dashPull', action: flatRaised ? 'lower' : 'raise' }
      }
    }
    const p = designPoint(clientX, clientY)
    if (!p) return null
    const box = (b) => p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h

    // THE ST&RT MENU IS ASKED BEFORE EVERYTHING ELSE, because it is painted after
    // everything else. It opens up across the hood, the FRAME dial and the left
    // mirror; testing the dial first would mean a row over it could not be
    // pressed, which is the same paint-order-versus-hit-order fault the tuner's
    // rows already carry a note about.
    // AND THE POWER PLATE BEFORE THE ST&RT MENU, because it is painted after it.
    // The two plates overlap, only one is ever up, and the one on top has to be
    // the one that answers -- the alternative is a click on LOG OUT landing on
    // whichever program row happens to sit under it.
    if (powerOpen) {
      if (box(powerRow())) return { kind: 'power', action: 'logout' }
      if (box(powerMenuRect())) return { kind: 'power', action: 'inside' }
    }
    if (box(POWER)) return { kind: 'power', action: powerOpen ? 'close' : 'menu' }
    if (powerOpen) return { kind: 'power', action: 'dismiss' }

    if (startOpen) {
      const ps = programState()
      for (const r of startRows(ps.list)) {
        if (box(r)) return { kind: 'program', action: 'launch', program: r }
      }
      // Inside the plate but not on a row -- the header, the footer, the padding.
      // Swallowed rather than passed through, or clicking the word PROGRAMS falls
      // into the dial behind it and, worse, dismisses the menu you are reading.
      if (box(startMenuRect(ps.list.length))) return { kind: 'start', action: 'inside' }
    }
    if (box(START)) return { kind: 'start', action: startOpen ? 'close' : 'menu' }
    // Same rule as the tuner's, and stated once more because it is easy to lose:
    // this SAYS the menu should shut, it does not shut it. `hit()` runs on every
    // pointer MOVE as well as on every press.
    if (startOpen) return { kind: 'start', action: 'dismiss' }

    const gi = shiftAt(p[0], p[1])
    if (gi >= 0) return { kind: 'gear', index: gi, id: GEARS[gi].id }
    // ASKED IN PAINT ORDER, TOP FIRST. The menu is drawn last and therefore
    // covers whatever is under it, so testing the screen before the menu would
    // let a click on a channel row fall through into the picture behind it --
    // and that picture's click now flies the camera into a window. A hit test
    // that disagrees with the paint order is not a near miss here; it is the
    // wrong action entirely.
    const st = castState()

    if (menuOpen) {
      for (const r of tunerRows(st.list)) {
        if (box(r)) return { kind: 'channel', action: 'pick', key: r.key, label: r.label }
      }
    }
    for (const ctl of tunerControls({ onAir: st.onAir })) {
      if (box(ctl)) return { kind: 'tvctl', action: ctl.action, key: st.onAirKey }
    }
    if (box(tunerRect())) return { kind: 'channel', action: 'menu' }
    // ANY OTHER PRESS DISMISSES THE MENU -- but this function only SAYS SO, it
    // does not do it.
    //
    // `hit()` MUST BE PURE. It is called from two places: the pointer handler,
    // once per press, and `hover()`, once per pointer MOVE. Closing the menu
    // here closed it on the first move after opening it -- so the dropdown
    // vanished while the pointer was still travelling towards the row it was
    // going to pick, and it read as a menu that would not stay open. A hit test
    // that mutates is a hit test that runs at the wrong times.
    if (menuOpen) return { kind: 'channel', action: 'dismiss' }
    // THE SCREEN IS THE WAY IN. Clicking what is on the TV flies you into that
    // window -- the same gesture as clicking its sign out on the road, which is
    // the point: the TV is a view of a window, so it answers like one.
    if (st.onAir && box({ x: MON.x, y: MON.y, w: MON.w, h: MON.h })) {
      return { kind: 'screen', key: st.onAirKey }
    }
    return null
  }

  // Knocking the stick into a detent. Returns whether the gear actually moved,
  // so the caller can tell "you pressed D and you were in D" apart from "you
  // pressed a gear that is not built" -- two different nothings.
  function setGear(id, why) {
    if (!GEARS.some((g) => g.id === id)) return false
    if (unbuilt.includes(id)) {
      // REFUSED, AND SAID SO. Moving the stick into a detent whose scene does
      // not exist would leave the cockpit reporting PARK with the road still
      // running underneath it -- a state the viewer cannot read off anything in
      // front of them, which is exactly what invariant 1 forbids.
      lastRefusal = { id, at: frames, why: 'no scene behind this gear yet' }
      return false
    }
    if (gear === id) return false
    gear = id
    lastRefusal = null
    if (onGear) onGear(id, why)
    return true
  }

  // WHERE THE DASHBOARD BEGINS, published to CSS so the DOM strips can stand on
  // it. `#why` is bottom-centre and was under the panel the moment this file
  // existed; a warning that names what is over its redline (invariant 1) being
  // hidden behind an instrument is the exact failure the invariant is for. One
  // definition, read by the thing that paints the hood and the thing that has to
  // clear it -- so they cannot drift apart.
  function publish() {
    document.documentElement.style.setProperty('--dashtop', Math.round(reachY) + 'px')
    // ONE SOURCE FOR "the shell is showing nothing but the window": `state.full`
    // is the fact, this mirrors it onto the root element, and the stylesheet only
    // reacts. A second flag in CSS-land is a second thing to get out of step, and
    // the state it would get out of step in is the one where the strips that say
    // what is wrong are hidden.
    document.documentElement.classList.toggle('full', !!state?.full)
  }

  size()
  window.addEventListener('resize', size)

  return {
    draw,
    hit,
    setGear,
    // Where the TV's glass lands on screen, right now, in client pixels -- and
    // `null` while the cockpit is out of the way, which is the quad's cue to
    // stop drawing rather than hang in the air over a flattened window.
    tvRect: () => (hidden > 0.5 ? null : monRect(W, H, layout().ty, layout().s)),
    gear: () => gear,
    // The tuner's menu. Dash-local state with two ways in: the shell opens and
    // shuts it in response to the hits this file reports, and nothing else needs
    // to know it exists.
    // ONE MENU AT A TIME. They overlap on the panel and they are opened by two
    // controls a hand's width apart; two lists up at once is two lists arguing
    // about which of them a click belongs to.
    toggleMenu: () => { menuOpen = !menuOpen; if (menuOpen) startOpen = false; return menuOpen },
    closeMenu: () => { menuOpen = false },
    menuOpen: () => menuOpen,
    // The ST&RT menu, same shape and same reason.
    toggleStart: () => { startOpen = !startOpen; if (startOpen) menuOpen = false; return startOpen },
    closeStart: () => { startOpen = false; startHot = null },
    startIsOpen: () => startOpen,
    // The power key's plate, same shape and the same one-at-a-time rule -- its
    // plate stands across the ST&RT menu's, and it shuts both of the others.
    // OPENING IT CLEARS THE LAST REFUSAL, or a reason from a previous session
    // is still printed under a question you have only just asked again.
    togglePower: () => {
      powerOpen = !powerOpen
      if (powerOpen) { menuOpen = false; startOpen = false; startHot = null; powerWhy = null }
      return powerOpen
    },
    closePower: () => { powerOpen = false; powerHot = false },
    powerIsOpen: () => powerOpen,
    // What the bridge said. Set by the shell; the plate stays up holding it,
    // because an answer on a menu that closed itself is an answer nobody reads.
    setPowerWhy(why) { powerWhy = why ? String(why) : null },
    // The ghost that follows the pointer while a program is being dragged out of
    // the menu. `null` puts it away. Everything in it was worked out by the
    // shell -- this file paints it and does not know what a drop target is.
    setDrag(d) { drag = d ? { ...d } : null },
    // DOES THE COCKPIT OWN THIS POINT? Asked by the shell on a drop, because a
    // program released over the dashboard has not been put anywhere on the road
    // and must not be launched as though it had. The panel is everything below
    // the crown, plus whatever the open menu is standing on top of above it.
    overCockpit(x, y) {
      if (hidden > 0.5) return false
      const p = designPoint(x, y)
      if (!p) return false
      if (p[1] >= REACH) return true
      const inside = (m) => p[0] >= m.x && p[0] <= m.x + m.w && p[1] >= m.y && p[1] <= m.y + m.h
      if (powerOpen && inside(powerMenuRect())) return true
      if (!startOpen) return false
      return inside(startMenuRect(programState().list.length))
    },
    // Idempotent on purpose: both this and the dash's own `pagehide` listener
    // call it, and a double release must be free rather than a throw on the way
    // out of the page.
    dispose() {
      if (!yoke) return
      yoke.dispose()
      yoke = null
      yokeFault = 'released on unload'
    },
    // The pointer moved somewhere on the frame. Only ever consulted for hover,
    // and it costs one arithmetic conversion -- there is no raycast here.
    hover(clientX, clientY) {
      ptrX = clientX === null ? null : clientX
      ptrY = clientY === null ? null : clientY
      const h = clientX === null ? null : hit(clientX, clientY)
      hoverGear = h && h.kind === 'gear' ? h.index : -1
      startHot = h && h.kind === 'program' ? h.program.id : null
      powerHot = !!(h && h.kind === 'power' && h.action === 'logout')
      return h
    },
    // Raising and lowering the cockpit over a flattened window. The shell calls
    // this from the hit it was handed; nothing else sets it.
    setRaised(v) { flatRaised = !!v; return flatRaised },
    raised: () => flatRaised,
    // What the panel is currently showing, for `__dash()`. Every field is a
    // number this file measured or drew -- there is nothing here it was told.
    report: () => ({
      w: W, h: H, pr,
      hidden: +hidden.toFixed(3),
      reachY: Math.round(reachY),
      gear,
      gearT: +gearT.toFixed(3),
      menuOpen,
      // The ST&RT menu as the panel has it: whether it is up, where its plate
      // lands, what is on it and what is being dragged off it. A drag that
      // "does nothing" is either a menu that never opened, a row the pointer
      // never actually entered, or a ghost the shell never handed over -- three
      // different faults that look the same from outside.
      startOpen,
      startHot,
      startRect: { ...START },
      startMenu: startOpen ? startMenuRect(programState().list.length) : null,
      // The power key, reported for the same reason the ST&RT menu is: "logging
      // out did nothing" has three causes -- a plate that never opened, a row
      // the pointer never entered, and a bridge that refused -- and only the
      // third one leaves a message on the screen.
      powerOpen,
      powerHot,
      powerRect: { ...POWER },
      powerMenu: powerOpen ? powerMenuRect() : null,
      powerWhy,
      programs: programState().list.map((p) => ({ id: p.id, kind: p.kind, ok: !!p.ok })),
      drag: drag ? { ...drag } : null,
      flatRaised,
      // The pointer as the dash last heard it. Kept in the report because "the
      // hint does not appear" has two causes that look identical -- the tab's
      // own rule saying no, and the moves never arriving at all.
      ptr: ptrX === null ? null : [Math.round(ptrX), Math.round(ptrY)],
      pull: pullVisible() ? pullRect() : null,
      full: !!state?.full,
      fly: flyAt(),
      pullWouldShow: state?.mode === 'flat',
      unbuilt: [...unbuilt],
      refused: lastRefusal,
      // WHICH WHEEL IS ON SCREEN, named rather than implied. A screenshot cannot
      // tell an unlit mesh from a canvas fallback, and both look like "a wheel".
      yoke: yoke ? { kind: 'mesh', ...yoke.stats() } : { kind: 'flat', why: yokeFault },
      frames,
      frameMs: frameMs === null ? null : +frameMs.toFixed(2),
      speed: speed === null ? null : +speed.toFixed(1),
      speedNote: 'smoothed for display; the dial and this field are the same number',
      roll: +roll.toFixed(3),
      tubes: { ...drawn },
    }),
  }
}
