// THE READ TIER: a pane made of real elements, standing in the world.
//
// WHY REAL ELEMENTS. PAPER_ROADS.md §12.2 recorded that a canvas pane cannot be a
// conformant Runefort renderer -- §5.4 requires every room to be focusable with a
// stable accessible name and §5.5 requires focus to move along neighbour edges,
// and a canvas has no focus and no accessibility tree. Those do not arrive with
// polish. They arrive with elements or they do not arrive. So this tier is not the
// pretty one; it is the only one that can claim conformance, and
// `test/dom-spec.mjs` is the claim.
//
// CSS3DRenderer, NOT AN OVERLAY. The pane stays where it is on the road, at its
// own position and its own angle, so reading one is continuous with driving past
// it rather than a modal that replaces the world. The cost is that CSS3D does not
// composite with WebGL depth -- the DOM layer is always in front. That is exactly
// correct for the one case this tier is used in and wrong for every other, which
// is why only ONE pane may be at the read tier at a time.
//
// SUPERSEDES, DOES NOT REFUSE. §5 of PAPER_ROADS originally specified "a pane MUST
// NOT be promoted to read tier while another is already there" as a hard refusal.
// `test/ops.mjs` §4 measured what that does to replay: a human who reads A, leaves,
// then reads B produces the plan [read A, read B] -- because `unread` is not
// plannable -- and replaying it REFUSES at the second step with the first pane
// still open. Superseding makes the replay land where the human did. The refusal
// is still enforced, but by making the second read close the first rather than by
// saying no.

import * as THREE from 'three'
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js'
import { bendToSpec, runeToSpec } from './dom-spec.js'
import { classFor } from './rune-layout.js'
import { hooks } from '../world.js'

let renderer = null
let layer = null
let scene3d = null
let camera = null
let current = null // { pane, object, root }

// The DOM the pane is drawn into is 640x420 CSS pixels and the quad it replaces is
// 300x197 world units, so the object is scaled to match. Without this the pane
// would be laid out correctly and be twice the size of the road.
const PX_W = 640
const PX_H = 420
const W = 300
const SCALE = W / PX_W

export function attachRead(ctx) {
  camera = ctx.camera
  if (renderer) return
  scene3d = new THREE.Scene()
  renderer = new CSS3DRenderer()
  layer = renderer.domElement
  layer.id = 'paper-read-layer'
  layer.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:35',
    // POINTER EVENTS OFF, ALWAYS, ON THE LAYER. Reported: "clicking anywhere on
    // the dashboard does nothing". The layer is `inset:0`, so flipping IT to
    // `auto` while a pane was open made the whole viewport eat every click meant
    // for the road, the gantry and the cockpit -- while the pane itself, a few
    // hundred pixels of it, was the only thing that needed them.
    //
    // This is the same fault the flat-mode `swallow` had when it exempted only
    // `#map` (TRACKS_HANDOFF.md §3), and the comment that used to sit here CITED
    // that fault while committing it. The layer never takes the pointer; only the
    // pane's own root element does, in `openRead`.
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(layer)
  injectStyle()
  resize()
  window.addEventListener('resize', resize)
  // §5.5 lives here rather than on each room, because focus movement is a property
  // of the floor and a listener per room is N listeners to remove.
  layer.addEventListener('keydown', onKey)
}

function resize() {
  if (renderer) renderer.setSize(window.innerWidth, window.innerHeight)
}

export function renderRead() {
  if (renderer && current) renderer.render(scene3d, camera)
}

// ---- open / close -----------------------------------------------------------

export function openRead(pane, { resolve } = {}) {
  if (!renderer) return { ok: false, why: 'READ_NO_LAYER' }
  if (!pane) return { ok: false, why: 'READ_NO_PANE' }
  // Supersede rather than refuse -- see the header.
  if (current) closeRead()

  const root = document.createElement('div')
  root.className = 'paper-read-root'
  root.style.cssText = `width:${PX_W}px;height:${PX_H}px`

  const spec = pane.format === 'rune'
    ? runeToSpec(pane.doc, { classFor })
    : bendToSpec(pane.doc, { resolve: resolve ?? pane.resolve ?? (() => 'pending') })
  root.appendChild(mount(spec))

  const object = new CSS3DObject(root)
  object.position.copy(pane.readPose.position)
  object.rotation.copy(pane.readPose.rotation)
  object.scale.setScalar(SCALE)
  scene3d.add(object)

  // The PANE takes the pointer. The layer never does.
  root.style.pointerEvents = 'auto'
  current = { pane, object, root }

  // TAKE THE KEYBOARD FROM THE CLIENTS. Greenfield binds keydown/keyup to its own
  // canvas, so without this a document being read also types into whatever
  // application had focus.
  hooks.shellKeyboard?.(true)

  // Focus the first focusable thing, so a keyboard user is inside the pane rather
  // than having to find it. `preventScroll` because focusing an element inside a
  // fixed layer otherwise scrolls the page under it.
  const first = root.querySelector('[tabindex="0"], a[href], h1')
  first?.focus?.({ preventScroll: true })

  return { ok: true, pane: pane.key }
}

export function closeRead() {
  if (!current) return false
  scene3d.remove(current.object)
  current.root.remove()
  current = null
  hooks.shellKeyboard?.(false)
  return true
}

export const readingKey = () => current?.pane?.key ?? null
export const isReading = () => !!current

// ---- mounting ---------------------------------------------------------------

// A spec tree becomes elements. The spec is what `test/dom-spec.mjs` asserts
// against, so anything this function adds is untested -- which is why it adds
// nothing. It sets exactly what the spec says and no more.
function mount(spec) {
  if (spec.tag === '#text') return document.createTextNode(spec.text ?? '')
  const e = document.createElement(spec.tag)
  for (const [k, v] of Object.entries(spec.attrs ?? {})) {
    if (v == null || v === '') continue
    e.setAttribute(k, String(v))
  }
  for (const c of spec.children ?? []) e.appendChild(mount(c))
  return e
}

// ---- §5.5 neighbour navigation ----------------------------------------------

const NAV = {
  ArrowRight: 1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: 1,
  l: 1, h: 1, k: 1, j: 1,
}

function onKey(ev) {
  if (!current) return
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    // Routed through the seam like everything else -- Escape is a human sending
    // `unread`, not a shortcut that reaches past the vocabulary.
    hooks.paperUnread?.()
    return
  }
  if (!NAV[ev.key]) return

  const from = ev.target?.closest?.('[data-room]')
  if (!from) return
  const names = (from.getAttribute('data-neighbors') ?? '').split(' ').filter(Boolean)
  if (!names.length) return

  // A neighbour naming a room that is not on this floor is skipped rather than
  // focused -- arrowing to nothing reads as a dead key, which is worse than not
  // moving. Same refusal `layoutRune` makes when it declines to draw the line.
  const rooms = names
    .map((n) => current.root.querySelector(`[data-room="${CSS.escape(n)}"]`))
    .filter(Boolean)
  if (!rooms.length) return

  // Direction chooses the neighbour whose grid position lies that way; with no
  // such neighbour the focus stays put rather than jumping somewhere arbitrary.
  const back = ev.key === 'ArrowLeft' || ev.key === 'h' || ev.key === 'ArrowUp' || ev.key === 'k'
  const vertical = ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'k' || ev.key === 'j'
  const axis = (el) => {
    const s = el.getAttribute('style') ?? ''
    const m = vertical ? /grid-row:(\d+)/.exec(s) : /grid-column:(\d+)/.exec(s)
    return m ? Number(m[1]) : 0
  }
  const hereAxis = axis(from)
  const wanted = rooms
    .filter((r) => (back ? axis(r) < hereAxis : axis(r) > hereAxis))
    .sort((a, b) => (back ? axis(b) - axis(a) : axis(a) - axis(b)))[0]

  const target = wanted ?? null
  if (!target) return
  ev.preventDefault()
  ev.stopPropagation()
  target.focus({ preventScroll: true })
}

// ---- styling -----------------------------------------------------------------

function injectStyle() {
  if (document.getElementById('paper-read-style')) return
  const s = document.createElement('style')
  s.id = 'paper-read-style'
  s.textContent = `
#paper-read-layer .paper-read-root {
  background:#03040a; color:#d7dbe8; overflow:auto; padding:18px 20px;
  border:2px solid #2de2e6; border-radius:4px; box-sizing:border-box;
  font:15px/1.5 ui-sans-serif,"DejaVu Sans",system-ui,sans-serif;
}
#paper-read-layer h1,#paper-read-layer h2,#paper-read-layer h3 { color:#f2c14e; margin:.5em 0 .35em; line-height:1.25 }
#paper-read-layer h1 { font-size:24px } #paper-read-layer h2 { font-size:19px } #paper-read-layer h3 { font-size:16px }
#paper-read-layer p { margin:.5em 0 }
#paper-read-layer pre { background:#0b0e1a; color:#2de2e6; padding:10px; overflow:auto; border-radius:3px }
#paper-read-layer blockquote { border-left:3px solid #2de2e6; margin:.6em 0; padding-left:12px; color:#a9b2c6 }
#paper-read-layer hr { border:0; border-top:1px solid #232838; margin:1em 0 }
#paper-read-layer a { color:#2de2e6 }
#paper-read-layer a[data-resolution="broken"] { color:#e2564d; text-decoration-style:wavy }
#paper-read-layer a[data-resolution="pending"] { color:#8b93a7 }
#paper-read-layer a[data-resolution="unauthorized"] { color:#f2c14e }
#paper-read-layer .paper-unknown { border:1px dashed #3a4258; padding:6px 8px; margin:.5em 0 }
#paper-read-layer .paper-unknown-label { font:11px ui-monospace,monospace; color:#8b93a7; display:block }
#paper-read-layer .paper-edges { margin-top:14px; border-top:1px solid #232838; padding-top:8px }
#paper-read-layer .paper-edges ul { list-style:none; padding:0; margin:0; font:12px ui-monospace,monospace }
#paper-read-layer .paper-edges li { padding:2px 0 }
#paper-read-layer .paper-predicate { color:#f2c14e; font-weight:700; margin-right:8px }
#paper-read-layer .rune-room {
  background:#0e1424; border:1px solid #243049; border-radius:3px; padding:8px 10px; overflow:hidden;
}
/* §5.3 -- the class names the protocol requires, doing real work. */
#paper-read-layer .runefort-state-warm { background:#231c0d; border-color:#5c4718 }
#paper-read-layer .runefort-state-hot  { background:#2a1410; border-color:#6b2a1e }
#paper-read-layer .runefort-state-fault{ background:#31090c; border-color:#8b1b22 }
#paper-read-layer .runefort-state-idle { background:#0a0c14; border-color:#1b2030 }
#paper-read-layer .rune-room:focus { outline:2px solid #f2c14e; outline-offset:1px }
#paper-read-layer .rune-room h3 { margin:0 0 4px; font-size:13px }
#paper-read-layer .rune-room p { margin:0; font-size:11px; color:#8b93a7 }
`
  document.head.appendChild(s)
}
