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
import { classFor, runeMetrics } from './rune-layout.js'
import { BEND_METRICS } from './bend-layout.js'
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
    // UNDER THE COCKPIT. `index.html` sets the shell's stacking contract and this
    // layer was outside it at 35 -- above the dashboard (3), the yoke (4), the
    // strips that carry invariant 1 (5) and the map (6). So a RuneFort pane drew
    // OVER the spaceship, which is not a depth question the CSS3D layer can lose
    // on its own merits: it does not composite with WebGL depth at all, so
    // whatever number it carries it is in front of the whole road. The only place
    // it can sit correctly is between the scene (auto) and the instruments.
    //
    // Reported: "the runefort window should never appear in front of or
    // z-indexed above the spaceship dashboard".
    'position:fixed', 'inset:0', 'z-index:2',
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

  // A LINK IN A DOCUMENT MUST NEVER NAVIGATE, and this is a hard rule rather than
  // a routing preference.
  //
  // A BendScript link's href is its target URI -- `bend:bafyfake01` -- and this
  // shell is a KIOSK FIREFOX. Letting that reach the browser asks the OS to find
  // an application for an unknown scheme, so the guest put a redirect prompt over
  // the road. Reported exactly that. There is no href here that a browser should
  // ever act on: an internal one is a place on the road, and an external one is
  // not this shell's to open.
  //
  // Raised as a hook, not resolved here. This module draws a pane; it does not
  // decide what following a link means -- the same division that moved Escape out
  // to travel.js's ladder.
  layer.addEventListener('click', (ev) => {
    const a = ev.target?.closest?.('a[href]')
    if (!a) return
    ev.preventDefault()
    ev.stopPropagation()
    hooks.paperFollow?.(a.getAttribute('href'), current?.pane ?? null)
  })
}

function resize() {
  if (renderer) renderer.setSize(window.innerWidth, window.innerHeight)
}

let pendingScroll = 0

export function renderRead() {
  if (!renderer || !current) return
  renderer.render(scene3d, camera)
  // AFTER the render, because that is the call that attaches the element. Applied
  // once, and only once the element has an extent to apply it to -- a pane whose
  // document fits has `scrollHeight === clientHeight` and nothing to restore.
  if (pendingScroll > 0) {
    const r = current.root
    if (r.scrollHeight > r.clientHeight) {
      r.scrollTop = pendingScroll
      pendingScroll = 0
    }
  }
}

// ---- open / close -----------------------------------------------------------

// HOW FAR DOWN A DOCUMENT YOU ARE IS ONE NUMBER, AND IT LIVES ON THE PANE.
//
// It was briefly two: `p.scrollY`, which the canvas tier repaints at and which the
// wheel moves while you drive past, and a private map in here for the DOM tier.
// Two numbers meant scrolling a document on the road and then entering it put you
// back at its title -- the shell forgetting, in the space of one click, something
// it was already holding.
//
// THEY ARE IN THE SAME UNITS, which is what makes this possible rather than a
// coincidence: the canvas is `w * PX_PER_UNIT` pixels wide and the DOM root is laid
// out at exactly that many CSS pixels, so an offset means the same distance down
// the same document in both. `openRead` reads it, `closeRead` writes it back.
//
// It also covers what the map was added for: a resize tears the read tier down and
// rebuilds it -- a LIVE resize does that many times in one drag -- and the offset
// survives because it was never stored in here.

export function openRead(pane, { resolve } = {}) {
  if (!renderer) return { ok: false, why: 'READ_NO_LAYER' }
  if (!pane) return { ok: false, why: 'READ_NO_PANE' }
  // Supersede rather than refuse -- see the header.
  if (current) closeRead()

  const root = document.createElement('div')
  root.className = 'paper-read-root'
  // THE PANE'S OWN PIXEL SIZE, not a constant. A resized pane's canvas is
  // `w * PX_PER_UNIT` px, and a DOM tier fixed at 640x420 would lay the same
  // document out at a different width and then be scaled to fit -- which is
  // exactly the "font size changes when I click on them" that was reported.
  const px = Math.round((pane.w ?? W) * (PX_W / W))
  const py = Math.round((pane.h ?? 197) * (PX_W / W))
  // THE PAD COMES FROM THE METRICS TOO, and it is inline for the same reason every
  // other number now is: the canvas wraps at `width - pad*2` and the stylesheet
  // used to say `18px 20px`, so the two tiers had different line widths and broke
  // lines in different places. Identical fonts at different measures still re-flow.
  root.style.cssText = `width:${px}px;height:${py}px;padding:${BEND_METRICS.pad}px`

  // THE SAME GEOMETRY THE CANVAS TIER USED, at this pane's pixel size.
  //
  // Without this the two tiers computed a floor independently and disagreed about
  // the row height, the room padding, both font sizes and whether there is a floor
  // heading at all -- so entering a runefort pane re-flowed it. Reported as "the
  // text and box sizes janks to a different size ... i want it to be consistent as
  // it zooms". `runeMetrics` is now the one source and both tiers project it.
  const rune = pane.format === 'rune'
  const spec = rune
    ? runeToSpec(pane.doc, { classFor, metrics: runeMetrics(pane.doc, { width: px, height: py }) })
    : bendToSpec(pane.doc, { resolve: resolve ?? pane.resolve ?? (() => 'pending') })
  // A rune floor owns its own padding, from the metrics, because the canvas's
  // `pad` is part of the grid arithmetic (`cellW` is derived from it). The root's
  // 18/20 would add to it and shift every column.
  if (rune) root.style.padding = '0'
  root.appendChild(mount(spec))

  const object = new CSS3DObject(root)
  object.position.copy(pane.readPose.position)
  object.rotation.copy(pane.readPose.rotation)
  object.scale.setScalar((pane.w ?? W) / px)
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

  // AFTER the focus, not before: `focus()` scrolls its element into view, and a
  // scroll restored first is a scroll that call then undoes. `preventScroll`
  // covers the layer, not this element's own scroller.
  // DEFERRED, NOT SET HERE, and the reason is worth writing down: a CSS3DObject's
  // element is not attached to the document until the renderer next runs, so at
  // this point `root` has no layout and no scroll extent -- assigning `scrollTop`
  // to a detached element is silently a no-op. Measured: a pane scrolled to 277 on
  // the road opened at 0. `renderRead` applies it on the first frame that the
  // element actually has somewhere to scroll to.
  pendingScroll = pane.scrollY || 0

  // WHAT WAS ACTUALLY RENDERED, not what the caller believed it asked for. The
  // seam panel reported `[rune]` beside a BendScript document on screen, and there
  // was no way to tell from the outside which of the two was wrong. Reporting the
  // rendered format and title from the place that renders them makes the pair
  // checkable instead of a matter of opinion.
  return { ok: true, pane: pane.key, format: pane.format, title: pane.card?.title ?? null }
}

export function closeRead() {
  if (!current) return false
  // Written back to the pane on the way out, so the rebuild a resize forces lands
  // where the reader was -- and so the canvas the road draws can be repainted at
  // the same place by whoever closed it.
  //
  // UNLESS THE RESTORE NEVER RAN. A tier that opens and closes inside one frame --
  // which is exactly what a live resize drag does, many times a second -- has a
  // `scrollTop` of 0 because the element was never attached long enough to take
  // one. Writing that back would zero the pane's real position on the first frame
  // of every drag, which is the bug this whole pair exists to prevent, arrived at
  // from the other side.
  if (current.pane && !pendingScroll) current.pane.scrollY = current.root.scrollTop || 0
  pendingScroll = 0
  scene3d.remove(current.object)
  current.root.remove()
  current = null
  hooks.shellKeyboard?.(false)
  return true
}

export const readingKey = () => current?.pane?.key ?? null
export const readingPane = () => current?.pane ?? null
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
/* NO BORDER HERE. The pane already has one: paper.js builds p.frame as a plane
   w+10 x h+10 behind the pane, which draws as a 5-unit cyan band around it AND
   carries the close/resize/cast buttons, so it is the border that cannot be
   removed. This tier drawing its own 2px cyan edge inside that band is why a
   runefort pane appeared to have two borders -- reported as exactly that.
   It also narrowed the content box by 4px against a canvas tier that has no
   border, so removing it makes the two tiers agree on width as well.
   (No backticks: template literal. Second time this bit in one session.) */
#paper-read-layer .paper-read-root {
  background:#03040a; color:#d7dbe8; overflow:auto;
  border-radius:4px; box-sizing:border-box;
  font-family:ui-sans-serif,"DejaVu Sans",system-ui,sans-serif;
}
/* COLOUR ONLY, FROM HERE DOWN.
   Every size, line-height, padding and gap for a BendScript block now arrives as
   an inline style from BEND_METRICS, which is the object bend-layout.js lays the
   CANVAS out with -- see dom-spec.js. This stylesheet used to carry its own set
   (margin .5em, line-height 1.5, padding 18px 20px) and the two disagreed about
   the box, the advance and every block gap, so entering a pane re-flowed the
   document even though the font sizes matched.
   The rune rules below already learned this; the same rule holds here. Anything
   geometric that reappears in this file re-opens the jank.
   NO BACKTICKS IN THIS COMMENT -- it lives inside a template literal, which two
   other comments in this same file already record having been bitten by. Third. */
#paper-read-layer h1,#paper-read-layer h2,#paper-read-layer h3,
#paper-read-layer h4,#paper-read-layer h5,#paper-read-layer h6 { color:#f2c14e }
#paper-read-layer pre { background:#0b0e1a; color:#2de2e6; overflow:auto; border-radius:3px }
#paper-read-layer blockquote { color:#a9b2c6 }
#paper-read-layer hr { border:0; border-top:1px solid #232838 }
#paper-read-layer a { color:#2de2e6 }
#paper-read-layer a[data-resolution="broken"] { color:#e2564d; text-decoration-style:wavy }
#paper-read-layer a[data-resolution="pending"] { color:#8b93a7 }
#paper-read-layer a[data-resolution="unauthorized"] { color:#f2c14e }
#paper-read-layer .paper-unknown { border:1px dashed #3a4258; padding:6px 8px; margin:.5em 0 }
#paper-read-layer .paper-unknown-label { font:11px ui-monospace,monospace; color:#8b93a7; display:block }
#paper-read-layer .paper-edges { border-top:1px solid #232838 }
#paper-read-layer .paper-edges ul { list-style:none; font-family:ui-monospace,monospace }
#paper-read-layer .paper-predicate { color:#f2c14e; font-weight:700; margin-right:8px }
/* COLOURS AND BORDERS ONLY. Padding, both font sizes and the row height come from
   runeMetrics as inline styles, because they are the numbers the canvas tier also
   draws with -- a stylesheet competing with them is how the two tiers came to
   disagree. Anything geometric that appears here again will re-open the jank.
   (No backticks in this comment: it lives inside a template literal, the same
   trap reel.js records above its own stylesheet.) */
#paper-read-layer .rune-room {
  background:#0e1424; border:1px solid #243049; border-radius:3px; overflow:hidden;
}
#paper-read-layer .rune-floor-head { color:#f2c14e }
/* §5.3 -- the class names the protocol requires, doing real work. */
#paper-read-layer .runefort-state-warm { background:#231c0d; border-color:#5c4718 }
#paper-read-layer .runefort-state-hot  { background:#2a1410; border-color:#6b2a1e }
#paper-read-layer .runefort-state-fault{ background:#31090c; border-color:#8b1b22 }
#paper-read-layer .runefort-state-idle { background:#0a0c14; border-color:#1b2030 }
#paper-read-layer .rune-room:focus { outline:2px solid #f2c14e; outline-offset:1px }
#paper-read-layer .rune-room p { color:#8b93a7 }
`
  document.head.appendChild(s)
}
