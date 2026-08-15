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
      return el(`h${lvl}`, { 'data-block': b.id ?? '' }, spans())
    }
    case 'paragraph':
      return el('p', { 'data-block': b.id ?? '' }, spans())
    case 'code':
      return el('pre', { 'data-block': b.id ?? '' }, [
        el('code', b.language ? { 'data-language': b.language } : {}, [txt(b.text ?? '')]),
      ])
    case 'quote':
      return el('blockquote', { 'data-block': b.id ?? '' },
        (b.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))
    case 'list':
      return el(b.ordered ? 'ol' : 'ul', { 'data-block': b.id ?? '' },
        (b.items ?? []).map((item) => el('li', {},
          (item?.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))))
    case 'list-item':
      return el('li', {}, (b.blocks ?? []).map((n) => blockSpec(n, resolve, depth + 1)).filter(Boolean))
    case 'divider':
      return el('hr', { 'data-block': b.id ?? '' })
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
    kids.push(el('section', { class: 'paper-edges', 'aria-label': `${edges.length} typed edges` }, [
      el('h2', {}, [txt(`Edges (${edges.length})`)]),
      el('ul', {}, edges.map((e) => {
        const state = resolve(e?.object) ?? 'pending'
        return el('li', { 'data-predicate': String(e?.predicate ?? ''), 'data-resolution': state }, [
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
  }, doc?.title ? [el('h1', { class: 'paper-title' }, [txt(doc.title)]), ...kids] : kids)
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
export function runeToSpec(floor, { signals = {}, classFor = null } = {}) {
  const cols = Number.isInteger(floor?.columns) && floor.columns > 0 ? floor.columns : 6
  const rooms = (floor?.rooms ?? []).filter((r) => r && typeof r === 'object')

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
    const kids = [el('h3', { class: 'rune-room-label' }, [txt(name)])]
    if (r.body) kids.push(el('p', { class: 'rune-room-body' }, [txt(r.body)]))

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
             `grid-row:${Number(rw) + 1}/span ${Math.max(1, Number(h) || 1)}`,
    }, kids)
  })

  return el('div', {
    class: 'paper-read paper-read-rune',
    role: 'grid',
    'aria-label': floor?.label || floor?.id || 'Runefort floor',
    'data-columns': String(cols),
    style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${floor?.gap ?? '10px'}`,
  }, cells)
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
