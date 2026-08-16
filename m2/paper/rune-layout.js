// A RUNEFORT FLOOR, LAID OUT INTO THE SAME THREE DRAW COMMANDS. No THREE, no DOM.
//
// THIS MODULE IS THE TEST OF THE CLOSED-SET CLAIM. `bend-layout.js` asserted that
// `rect` / `line` / `text` is a closed vocabulary rather than "the three things the
// first format happened to need". A second, unrelated format is what settles that,
// and it does not get a fourth command kind: a room is a rect, its border is a
// rect, its label and body are text, a neighbour edge is a line. If RuneFort had
// needed an arc or a gradient the claim would have been falsified here, and the
// honest move would have been to widen the set on the record rather than to
// special-case one renderer.
//
// A FLOOR IS A PANE; A CAMPUS IS A ROAD. That is the mapping, and it fell out of
// the data rather than being imposed on it -- `forts/welcome.json` is a campus of
// two buildings holding four floors, and a floor is exactly the unit that has one
// grid and one set of rooms. Placing a campus's floors along a road is therefore
// not a metaphor; it is the same containment the format already has.
//
// TWO DOCUMENT SHAPES, BOTH ACCEPTED. The protocol spec §3 describes a flat
// `{ runefort, grid, rooms, claims, neighbors, state_bindings }`. The only real
// document in the repo -- `runefort.com/forts/welcome.json` -- is
// `campus -> buildings -> floors -> rooms`, with `columns`/`cell_height`/`gap` on
// the floor and `state_class` written straight onto the room. Those are different
// documents, and §11 still lists nesting as an OPEN QUESTION for v0.2 while the
// shipped app has already answered it. Rendering only the spec shape would render
// nothing that exists; rendering only the app shape would silently bless a drift.
// So `floorsOf` normalises both and `stats.shape` reports which one arrived.

import { wrapPlain, ellipsize } from './wrap.js'

// §2.4 reserves exactly five canonical state classes. An unknown class is NOT an
// error -- the spec says renderers "should ignore unknown classes gracefully
// (treat as cold)" -- so it is counted and drawn cold.
const STATE = {
  cold: { fill: '#0e1424', edge: '#243049', text: '#9fb0d0' },
  warm: { fill: '#231c0d', edge: '#5c4718', text: '#f2c14e' },
  hot: { fill: '#2a1410', edge: '#6b2a1e', text: '#e2564d' },
  fault: { fill: '#31090c', edge: '#8b1b22', text: '#ff6b6b' },
  idle: { fill: '#0a0c14', edge: '#1b2030', text: '#5d6478' },
}

export const RUNE_THEME = {
  bg: '#03040a',
  title: '#f2c14e',
  dim: '#8b93a7',
  rule: '#232838',
  neighbor: '#2de2e6',
  state: STATE,
}

const font = (size, { weight = 400, italic = false, mono = false } = {}) => ({ size, weight, italic, mono })

// `"150px"` -> 150. A floor writes CSS lengths because its canonical renderer is a
// CSS grid; a canvas has to read them. Anything not in px falls back rather than
// producing NaN geometry, which draws as nothing and reads as a missing room.
function px(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const m = /^\s*(-?[\d.]+)\s*px\s*$/.exec(String(v ?? ''))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) ? n : fallback
}

// Both shapes in, a flat list of floors out. Each carries the path that reached it
// so a pane can say which floor of which building it is showing.
export function floorsOf(doc) {
  const out = []
  if (!doc || typeof doc !== 'object') return out

  if (doc.campus && Array.isArray(doc.campus.buildings)) {
    for (const b of doc.campus.buildings) {
      for (const f of b?.floors ?? []) {
        out.push({ ...f, _shape: 'campus', _building: b.label ?? b.id ?? '', _campus: doc.campus.label ?? doc.campus.id ?? '' })
      }
    }
    return out
  }

  // Spec §3: the document IS one floor, with the grid on `grid` and the rooms at
  // the top level.
  if (Array.isArray(doc.rooms)) {
    out.push({
      id: doc.id ?? 'floor',
      label: doc.title ?? doc.id ?? '',
      columns: doc.grid?.columns,
      rows: doc.grid?.rows,
      rooms: doc.rooms,
      claims: doc.claims,
      neighbors: doc.neighbors,
      state_bindings: doc.state_bindings,
      _shape: 'flat',
      _building: '',
      _campus: doc.title ?? '',
    })
  }
  return out
}

// §2.4 state bindings: a threshold list against a live signal. Evaluated here so a
// pane can colour itself from a signal map without the caller reimplementing the
// comparison. Total by construction -- a malformed threshold yields no class
// rather than throwing, same discipline as OP_VOCABULARY_DRAFT.md §4.
export function classFor(room, floor, signals = {}) {
  if (room?.state_class) return room.state_class
  for (const b of floor?.state_bindings ?? []) {
    if (b?.room !== room?.id) continue
    const v = signals[b.signal]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    for (const t of b.thresholds ?? []) {
      const m = /^\s*(<=|>=|<|>|==)\s*(-?[\d.]+)\s*$/.exec(String(t?.if ?? ''))
      if (!m) continue
      const n = Number(m[2])
      const hit = m[1] === '<' ? v < n : m[1] === '>' ? v > n
        : m[1] === '<=' ? v <= n : m[1] === '>=' ? v >= n : v === n
      if (hit) return t.class
    }
  }
  return null
}

// ONE SOURCE FOR THE GEOMETRY, because there are TWO renderers of a floor and
// they were computing it separately.
//
// The canvas tier (below) and the DOM read tier (`dom-spec.js` + `read.js` CSS)
// both draw a Runefort floor, and they disagreed about nearly every number: the
// room label was 12px bold on canvas and a 13px `h3` in CSS; the canvas drew a
// floor heading with a rule under it and the DOM emitted no heading at all; and
// worst, the canvas COMPRESSES row height to `min(cell_height, fit)` so the grid
// fills the pane, while a CSS grid with no `grid-template-rows` sizes rows to
// their content. So clicking a runefort pane re-flowed it -- reported as "the text
// and box sizes janks to a different size".
//
// The fix is the one this tree already applied to the v0.6 state layout: make one
// function THE walk and have everything else project it. A renderer that computes
// its own numbers is a renderer that will disagree again.
//
// `bend-layout.js`'s heading sizes were matched by hand once (read.js says so in a
// comment). Matched by hand means matched until someone edits one of them, which
// is why this is a function and not a second table.
export function runeMetrics(floor, { width = 512, height = 340, pad = 14 } = {}) {
  const cols = Number.isInteger(floor?.columns) && floor.columns > 0 ? floor.columns : 6
  const gap = px(floor?.gap, 10)
  const heading = floor?.label || floor?.id
  const headBlock = heading ? HEAD_ADVANCE + RULE_GAP : 0
  const top = pad + headBlock
  const cellW = (width - pad * 2 - gap * (cols - 1)) / cols
  const rowsUsed = Math.max(1, ...((floor?.rooms ?? []).map((r) => (r?.position?.[1] ?? 0) + (r?.size?.[1] ?? 1))), 1)
  const declared = px(floor?.cell_height, 96)
  const avail = height - top - pad
  const fit = (avail - gap * (rowsUsed - 1)) / rowsUsed
  const cellH = Math.min(declared, fit)
  return {
    pad, cols, gap, top, cellW, cellH, rowsUsed, declared,
    compressed: cellH < declared - 0.5,
    heading: heading ? `${floor._building ? `${floor._building} · ` : ''}${heading}` : null,
    headSize: HEAD_SIZE,
    headAdvance: HEAD_ADVANCE,
    ruleGap: RULE_GAP,
    labelSize: LABEL_SIZE,
    bodySize: BODY_SIZE,
    lineH: LINE_H,
    roomPadX: ROOM_PAD_X,
    labelBaseline: LABEL_BASELINE,
  }
}

// The numbers themselves, in one place so the metrics and the drawing below
// cannot drift from each other either.
const HEAD_SIZE = 14
const HEAD_ADVANCE = 22
const RULE_GAP = 10
const LABEL_SIZE = 12
const BODY_SIZE = 11
const LINE_H = 14
const ROOM_PAD_X = 8
const LABEL_BASELINE = 17

export function layoutRune(floor, opts = {}) {
  const {
    width = 512,
    height = 340,
    pad = 14,
    measure,
    theme = RUNE_THEME,
    signals = {},
    // Neighbour lines are §2.3's rendering ("may be rendered as connecting
    // lines"), so they are opt-out rather than absent.
    showNeighbors = true,
  } = opts

  if (typeof measure !== 'function') throw new TypeError('layoutRune needs a measure(text, font) function')

  const cmds = []
  const stats = { rooms: 0, neighbors: 0, unknownClasses: 0, clipped: 0, shape: floor?._shape ?? 'unknown' }
  const push = (c) => cmds.push(c)

  push({ op: 'rect', x: 0, y: 0, w: width, h: height, color: theme.bg })

  // PROJECTED, not recomputed. See `runeMetrics` -- the DOM tier reads the same
  // numbers, which is the whole reason they moved out of this function.
  //
  // The floor states a cell height in CSS pixels for a page that scrolls. A pane
  // does not scroll, so the declared height is used only when the grid fits;
  // otherwise rows are compressed to fill the pane and `compressed` says so. The
  // alternative -- honouring the declared height and clipping -- renders the top
  // third of a floor and looks like a floor with three rooms.
  const M = runeMetrics(floor, { width, height, pad })
  const { cols, gap, top, cellW, cellH, compressed } = M

  if (M.heading) {
    push({ op: 'text', x: pad, y: pad + 13, text: M.heading, font: font(M.headSize, { weight: 700 }), color: theme.title })
    const ruleY = pad + M.headAdvance
    push({ op: 'line', x: pad, y: ruleY, x2: width - pad, y2: ruleY, color: theme.rule, w: 1 })
  }

  const cellX = (c) => pad + c * (cellW + gap)
  const cellY = (r) => top + r * (cellH + gap)

  const centers = new Map()

  for (const room of floor?.rooms ?? []) {
    if (!room || typeof room !== 'object') continue
    const [c, r] = Array.isArray(room.position) ? room.position : [0, 0]
    const [w, h] = Array.isArray(room.size) ? room.size : [1, 1]
    if (![c, r, w, h].every((n) => Number.isFinite(n))) continue
    stats.rooms++

    const x = cellX(c)
    const y = cellY(r)
    const rw = w * cellW + (w - 1) * gap
    const rh = h * cellH + (h - 1) * gap
    if (rw <= 0 || rh <= 0) continue

    centers.set(room.id, [x + rw / 2, y + rh / 2])

    const cls = classFor(room, floor, signals)
    const known = cls == null || Object.hasOwn(STATE, cls)
    if (!known) stats.unknownClasses++
    const st = STATE[cls] ?? STATE.cold

    push({ op: 'rect', x, y, w: rw, h: rh, color: st.fill })
    // A border drawn as four thin rects rather than a stroked path: the closed set
    // has no `strokeRect`, and adding one to draw a box would be the fourth command
    // arriving through the back door.
    push({ op: 'rect', x, y, w: rw, h: 1, color: st.edge })
    push({ op: 'rect', x, y: y + rh - 1, w: rw, h: 1, color: st.edge })
    push({ op: 'rect', x, y, w: 1, h: rh, color: st.edge })
    push({ op: 'rect', x: x + rw - 1, y, w: 1, h: rh, color: st.edge })

    const inner = rw - M.roomPadX * 2
    let ty = y + M.labelBaseline
    const lf = font(M.labelSize, { weight: 700 })
    const lab = ellipsize(room.label ?? room.id ?? '', lf, inner, measure)
    if (lab.clipped) stats.clipped++
    push({ op: 'text', x: x + M.roomPadX, y: ty, text: lab.text, font: lf, color: st.text })
    ty += 15

    if (room.body) {
      const bf = font(M.bodySize)
      // How many body lines actually fit, computed rather than assumed -- a fixed
      // line count overflows a 1-row room and wastes a 3-row one.
      const room_lines = Math.max(0, Math.floor((y + rh - 6 - ty) / M.lineH))
      const { lines, clipped } = wrapPlain(room.body, bf, inner, measure, { maxLines: room_lines })
      if (clipped) stats.clipped++
      for (const ln of lines) {
        push({ op: 'text', x: x + M.roomPadX, y: ty, text: ln, font: bf, color: theme.dim })
        ty += M.lineH
      }
    }
  }

  if (showNeighbors) {
    for (const n of floor?.neighbors ?? []) {
      const a = centers.get(n?.from)
      const b = centers.get(n?.to)
      // A neighbour naming a room that is not on this floor is dropped, not drawn
      // to a guessed point. §2.3 allows `linked` across a layout; a line to nowhere
      // would assert an adjacency the document did not state.
      if (!a || !b) continue
      stats.neighbors++
      push({ op: 'line', x: a[0], y: a[1], x2: b[0], y2: b[1], color: theme.neighbor, w: 1 })
    }
  }

  return { commands: cmds, stats, compressed, rows: M.rowsUsed, cols }
}
