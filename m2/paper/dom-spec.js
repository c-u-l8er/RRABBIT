// A DOCUMENT AS AN ELEMENT TREE. No DOM, no THREE, no CSS3D.
//
// WHY A SPEC AND NOT DOM DIRECTLY. The canvas tiers emit draw commands rather than
// calling a context, and this is the same move one layer up: `bendToSpec` and
// `runeToSpec` return a plain tree of `{tag, attrs, text, children}` that `read.js`
// turns into elements. `node` has no `document`, so a builder that called
// `createElement` could only be tested through the FreeBSD deploy loop -- and the
// things that most need testing here are precisely the ones a screenshot cannot
// check: whether every room is focusable, whether it has an accessible name,
// whether DOM order is deterministic.
//
// THIS TIER IS WHY THE READ TIER EXISTS AT ALL. PAPER_ROADS.md §12.2 recorded that
// a canvas pane CANNOT be a conformant Runefort renderer: §5.4 requires every room
// to be focusable with a stable accessible name and §5.5 requires focus to move
// along neighbour edges, and a canvas has no focus and no accessibility tree. Those
// are not things that arrive with polish. They arrive with real elements or they do
// not arrive. So the read tier is not "the pretty one" -- it is the only tier that
// can claim conformance, and the assertions in test/dom-spec.mjs are the claim.

// THE CANVAS TIER'S OWN GEOMETRY, imported rather than re-stated. Two renderers
// will never be glyph-identical; they can be given the same box, the same font
// size and the same baseline-to-baseline advance, and then a document does not
// re-flow when you enter it.
import { BEND_METRICS as M } from './bend-layout.js'

const el = (tag, attrs = {}, children = []) => ({ tag, attrs, children })
const txt = (text) => ({ tag: '#text', text: String(text ?? ''), attrs: {}, children: [] })

// Runefort §2.4 reserves five canonical state classes, and §5.3 requires the class
// names a renderer applies to be PREDICTABLE: `runefort-state-<class>`. Not a
// theme decision -- a conformance requirement, so it is computed rather than
// configured.
const STATE_CLASSES = new Set(['cold', 'warm', 'hot', 'fault', 'idle'])
export const stateClass = (c) => `runefort-state-${STATE_CLASSES.has(c) ? c : 'cold'}`

// ---- BendScript -------------------------------------------------------------

function spanSpec(sp, resolve) {
  const text = txt(sp?.text ?? '')
  let node = text
  let link = null
  for (const m of sp?.marks ?? []) {
    if (m === 'bold') node = el('strong', {}, [node])
    else if (m === 'italic') node = el('em', {}, [node])
    else if (m === 'code') node = el('code', {}, [node])
    else if (m && typeof m === 'object' && m.kind === 'link') link = m
    else if (m === 'link') link = { kind: 'link' }
  }
  if (link) {
    const state = resolve(link.target) ?? 'pending'
    // A REAL ANCHOR, and the resolution state on it. §6.4 says a renderer SHOULD
    // indicate which of the four states a reference is in; on canvas that was a
    // colour, and here it can also be `aria-disabled` and a title, which is the
    // thing a colour could never be for somebody using a screen reader.
    node = el('a', {
      href: link.target ?? '#',
      'data-resolution': state,
      'data-predicate': link.predicate ?? '',
      title: `${link.predicate ? link.predicate + ' → ' : ''}${link.target ?? '(no target)'} (${state})`,
      ...(state === 'broken' || state === 'unauthorized' ? { 'aria-disabled': 'true' } : {}),
    }, [node])
  }
  return node
}

function blockSpec(b, resolve, depth) {
  if (!b || typeof b !== 'object' || depth > 12) return null
  const spans = () => (b.spans ?? []).map((s) => spanSpec(s, resolve))

  switch (b.kind) {
    case 'heading': {
      const lvl = Number.isInteger(b.level) && b.level >= 1 && b.level <= 6 ? b.level : 1
      // A real h1..h6, not a styled div. This is the whole point of the tier: the
      // heading structure IS the document outline a screen reader navigates by.
      //
      // THE GEOMETRY IS INLINE AND COMES FROM `BEND_METRICS`, the same object the
      // canvas tier lays out with. It is not in the stylesheet for the reason
      // read.js already records above the rune rules: a stylesheet competing with
      // the numbers the other tier draws with is exactly how the two came to
      // disagree. PADDING, not margin -- CSS collapses adjacent vertical margins
      // and the canvas has no such rule, so a margin is a difference the two tiers
      // cannot both implement.
      return el(`h${lvl}`, {
        'data-block': b.id ?? '',
        style: `font-size:${M.headSize[lvl]}px;line-height:${M.headLine(lvl)}px;` +
               `margin:0;padding:${M.headAbove}px 0 ${M.headBelow}px`,
      }, spans())
    }
    case 'paragraph':
      return el('p', {
        'data-block': b.id ?? '',
        style: `font-size:${M.bodySize}px;line-height:${M.bodyLine}px;margin:0;padding:0 0 ${M.paraBelow}px`,
      }, spans())
    case 'code':
      return el('pre', {
        'data-block': b.id ?? '',
        style: `font-size:${M.codeSize}px;line-height:${M.codeLine}px;margin:0;` +
               `padding:${M.codePad}px;margin-bottom:${M.codeBelow}px`,
      }, [
        el('code', b.language ? { 'data-language': b.language } : {}, [txt(b.text ?? '')]),
      ])
    case 'quote':
      return el('blockquote', {
        'data-block': b.id ?? '',
        style: `border-left:${M.quoteBar}px solid #2de2e6;margin:0;` +
               `padding:0 0 0 ${M.quoteIndent - M.quoteBar}px;margin-bottom:${M.quoteBelow}px`,
      }, (b.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))
    case 'list':
      return el(b.ordered ? 'ol' : 'ul', {
        'data-block': b.id ?? '',
        style: `margin:0;padding-left:${M.listIndent}px;padding-bottom:${M.listBelow}px`,
      }, (b.items ?? []).map((item) => el('li', {},
          (item?.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))))
    case 'list-item':
      return el('li', {}, (b.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))
    case 'divider':
      return el('hr', {
        'data-block': b.id ?? '',
        style: `margin:${M.ruleAbove}px 0 ${M.ruleBelow}px`,
      })
    case 'embed': {
      const state = resolve(b.target) ?? 'pending'
      return el('figure', { 'data-block': b.id ?? '', class: 'paper-embed', 'data-resolution': state }, [
        el('a', { href: b.target ?? '#', 'data-resolution': state }, [txt(b.target ?? '(no target)')]),
      ])
    }
    default: {
      // §2.2: unknown kinds MUST be preserved and SHOULD render a fallback. The
      // kind is kept in an attribute so a round-trip out of the DOM can find it,
      // and it is announced rather than silently styled.
      const kids = Array.isArray(b.spans) ? spans()
        : (b.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean)
      return el('div', {
        class: 'paper-unknown', 'data-kind': String(b.kind ?? 'unknown'), 'data-block': b.id ?? '',
      }, [el('span', { class: 'paper-unknown-label' }, [txt(String(b.kind ?? 'unknown'))]), ...kids])
    }
  }
}

export function bendToSpec(doc, { resolve = () => 'pending' } = {}) {
  const body = (doc?.blocks ?? []).map((b) => blockSpec(b, resolve, 0)).filter(Boolean)

  const edges = Array.isArray(doc?.edges) ? doc.edges : []
  const kids = [el('article', { class: 'paper-doc' }, body)]
  if (edges.length) {
    // The edge rail again, and here it can be a real list with real links --
    // §14.3.4's point, that edges are the protocol's reason to exist, expressed in
    // a form the accessibility tree can walk.
    kids.push(el('section', {
      class: 'paper-edges',
      'aria-label': `${edges.length} typed edges`,
      style: `margin-top:${M.railAbove}px;padding-top:${M.railGap}px;padding-bottom:${M.railBelow}px`,
    }, [
      // NOT the h2 heading size. The canvas draws this label at `railLabelSize`
      // mono, and an h2 here inherited 25px -- the rail's own title was 13px
      // larger on one tier than the other, at the bottom of every document that
      // has edges. It stays an `h2` because it is a real section heading in the
      // outline; only its geometry is pinned.
      el('h2', {
        style: `font-size:${M.railLabelSize}px;line-height:${M.railLabelLine}px;` +
               `font-family:ui-monospace,monospace;margin:0;padding:0`,
      }, [txt(`Edges (${edges.length})`)]),
      el('ul', { style: `margin:0;padding:0;list-style:none;font-size:${M.railSize}px;line-height:${M.railLine}px` }, edges.map((e) => {
        const state = resolve(e?.object) ?? 'pending'
        return el('li', { 'data-predicate': String(e?.predicate ?? ''), 'data-resolution': state, style: 'padding:0' }, [
          el('span', { class: 'paper-predicate' }, [txt(String(e?.predicate ?? '?'))]),
          el('a', { href: String(e?.object ?? '#'), 'data-resolution': state }, [txt(String(e?.object ?? '?'))]),
        ])
      })),
    ]))
  }

  return el('div', {
    class: 'paper-read paper-read-bend',
    // The pane itself is a labelled region, so entering one announces what it is.
    role: 'document',
    'aria-label': doc?.title ? String(doc.title) : 'Untitled BendScript document',
    'data-vocabulary': String(doc?.vocabulary ?? 'core'),
  }, doc?.title ? [el('h1', {
    class: 'paper-title',
    // The canvas draws the title at `titleSize` bold with a rule under it; a bare
    // h1 here inherited the 30px heading size, so the first line of every document
    // changed size the moment you entered the pane.
    style: `font-size:${M.titleSize}px;line-height:${M.titleLine}px;font-weight:700;` +
           `margin:0;padding:0 0 ${M.titleBelow}px;border-bottom:1px solid #232838;` +
           `margin-bottom:${M.titleBelow}px`,
  }, [txt(doc.title)]), ...kids] : kids)
}

// ---- Runefort ---------------------------------------------------------------

// Runefort §5, the renderer contract, is what this function is written against:
//
//   §5.1 layout    -- CSS grid from `position`/`size`, DETERMINISTIC DOM order
//   §5.2 anchors   -- activating a tile surfaces its content
//   §5.3 classes   -- predictable `runefort-state-*` names
//   §5.4 a11y      -- every room focusable, with a stable accessible name
//   §5.5 neighbours-- arrow / hjkl focus movement along neighbour edges
//
// §5.5 needs the graph at the element, so each room carries its neighbours in a
// data attribute; `read.js` reads them on keydown. Putting the adjacency on the
// element rather than in a closure is what lets the nav be tested without a
// renderer.
// `metrics` is `runeMetrics(floor, {width, height})` from rune-layout.js -- the
// SAME object the canvas tier projects. Passing it in rather than importing keeps
// this module free of the layout engine (it is asserted against by
// `test/dom-spec.mjs` as pure spec), while making the two tiers agree by
// construction instead of by two people editing two files in step.
//
// Omitted, it falls back to the old CSS-driven sizing. That path is only for
// callers that have no pane to size against -- a floor rendered at an unknown
// size cannot agree with a canvas that was never drawn.
export function runeToSpec(floor, { signals = {}, classFor = null, metrics = null } = {}) {
  const cols = Number.isInteger(floor?.columns) && floor.columns > 0 ? floor.columns : 6
  const rooms = (floor?.rooms ?? []).filter((r) => r && typeof r === 'object')
  const M = metrics

  const neighbours = new Map()
  for (const n of floor?.neighbors ?? []) {
    if (!n?.from || !n?.to) continue
    if (!neighbours.has(n.from)) neighbours.set(n.from, [])
    if (!neighbours.has(n.to)) neighbours.set(n.to, [])
    neighbours.get(n.from).push(n.to)
    // Adjacency is symmetric for NAVIGATION even where the declaration is
    // directed: `from`/`to` says which way the relation reads, not which way a
    // keyboard may move. A user who arrows into a room must be able to arrow back
    // out of it, or focus is a trap.
    neighbours.get(n.to).push(n.from)
  }

  const cells = rooms.map((r) => {
    const [c, rw] = Array.isArray(r.position) ? r.position : [0, 0]
    const [w, h] = Array.isArray(r.size) ? r.size : [1, 1]
    const cls = classFor ? classFor(r, floor, signals) : (r.state_class ?? null)
    // §5.4: the accessible name is the label, falling back to the id. Never empty
    // -- an unnamed focusable is a stop on the tab order that announces nothing.
    const name = (typeof r.label === 'string' && r.label) || String(r.id ?? 'room')
    // SIZES FROM THE METRICS, not from the stylesheet. The canvas draws the label
    // at `labelSize` bold on a 15px advance and each body line at `bodySize` on a
    // `lineH` advance; the CSS said 13px and 11px with default line-heights, and
    // the difference is what re-flowed a floor the moment you clicked it.
    const kids = [el('h3', {
      class: 'rune-room-label',
      ...(M ? { style: `font-size:${M.labelSize}px;line-height:15px;margin:0;font-weight:700` } : {}),
    }, [txt(name)])]
    if (r.body) {
      kids.push(el('p', {
        class: 'rune-room-body',
        ...(M ? { style: `font-size:${M.bodySize}px;line-height:${M.lineH}px;margin:0` } : {}),
      }, [txt(r.body)]))
    }

    return el('div', {
      class: `rune-room ${stateClass(cls)}`,
      role: 'gridcell',
      // §5.4. Every room, not just the first -- a roving tabindex would be valid
      // too but needs JS to maintain, and a plain 0 cannot get out of step.
      tabindex: '0',
      'aria-label': name,
      id: `rune-room-${r.id ?? name}`,
      'data-room': String(r.id ?? ''),
      'data-neighbors': (neighbours.get(r.id) ?? []).join(' '),
      'data-state': cls ?? 'cold',
      // §5.1: 1-based CSS grid lines from 0-based protocol coordinates.
      style: `grid-column:${Number(c) + 1}/span ${Math.max(1, Number(w) || 1)};` +
             `grid-row:${Number(rw) + 1}/span ${Math.max(1, Number(h) || 1)}` +
             // The canvas puts the label baseline 17px below the room's top edge
             // with 12px text, so the text block starts ~8px in; `6px` top padding
             // on a 15px line lands the baseline in the same place.
             (M ? `;padding:6px ${M.roomPadX}px` : ''),
    }, kids)
  })

  const grid = el('div', {
    class: 'paper-read-grid',
    role: 'grid',
    'aria-label': floor?.label || floor?.id || 'Runefort floor',
    'data-columns': String(cols),
    style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${M ? `${M.gap}px` : (floor?.gap ?? '10px')}` +
           // THE ROW HEIGHT IS THE ONE THAT MATTERED MOST. Without it a CSS grid
           // sizes rows to their content while the canvas compresses them to fill
           // the pane, so every box was a different height in the two tiers.
           (M ? `;grid-auto-rows:${M.cellH}px` : ''),
  }, cells)

  // THE FLOOR HEADING, which the DOM tier simply did not have. The canvas draws
  // "building · floor" and a rule under it and then starts the grid below both, so
  // a DOM tier without one placed the whole grid `headAdvance + ruleGap` higher --
  // every room in a different place, on top of being a different size.
  const head = M?.heading
    ? el('div', {
        class: 'rune-floor-head',
        style: `font-weight:700;font-size:${M.headSize}px;line-height:${M.headAdvance}px;` +
               `height:${M.headAdvance}px;margin-bottom:${M.ruleGap}px;border-bottom:1px solid #232838`,
      }, [txt(M.heading)])
    : null

  return el('div', {
    class: 'paper-read paper-read-rune',
    ...(M ? { style: `padding:${M.pad}px;box-sizing:border-box;height:100%` } : {}),
  }, head ? [head, grid] : [grid])
}

// ---- walking a spec ----------------------------------------------------------

// Used by the tests and by `read.js`. A spec is a tree of plain objects, so the
// walk is the same for both and there is no chance of the tested tree and the
// mounted tree diverging.
export function walk(spec, fn) {
  if (!spec) return
  fn(spec)
  for (const c of spec.children ?? []) walk(c, fn)
}

export function textOf(spec) {
  let out = ''
  walk(spec, (n) => { if (n.tag === '#text') out += n.text })
  return out
}
