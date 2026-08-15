// A BENDSCRIPT DOCUMENT, LAID OUT INTO DRAW COMMANDS. No THREE, no DOM, no canvas.
//
// This is the arithmetic half of a paper pane, and it is separated from the
// painting half for a reason that is about this repo rather than about taste: the
// dev host CANNOT OPEN THE 3D SHELL (TRACKS_HANDOFF.md §1 -- other sessions hold
// the WebGL context pool). Anything that needs a GL context to run can only be
// tested by building, scp'ing to the FreeBSD guest and pressing Ctrl+R. Anything
// that does not can be tested with `node`. So the layout lives here, where it can
// be run on the host, and `paint.js` -- which has no decisions in it -- lives with
// the canvas.
//
// MEASUREMENT IS INJECTED, not assumed. Wrapping needs to know how wide a word is,
// and real font metrics are not guessable: a monospace approximation puts the line
// breaks in the wrong places for every proportional font, which reads as a layout
// bug and traces back to a shortcut taken here. The caller passes `measure(text,
// font)`; the canvas supplies `ctx.measureText`, and a test supplies an exact
// fake. That also means this module is honest about what it does not know rather
// than guessing and being subtly wrong.
//
// THREE DRAW COMMANDS: `rect`, `line`, `text`. A closed set, for the same reason
// the op vocabulary is a closed set (OP_VOCABULARY_DRAFT.md §8.1) -- a renderer
// that can be handed a new command kind at any time is an open API, and every
// consumer then needs a default branch for the kind it has not heard of. Quote
// bars and code backgrounds are rects; dividers and link underlines are lines.
// Nothing so far has needed a fourth.
//
// WHAT DOES NOT FIT IS REPORTED, NEVER SILENTLY CLIPPED. A pane that runs out of
// box and stops drawing looks exactly like a document that was that short. Both
// `overflow` and `truncated` come back on the result so the caller can draw a
// continuation mark and so a test can assert on the difference.

// Per BendScript §2.2. Kinds outside this set are NOT an error -- the spec says a
// processor "MUST preserve it in round-trip and SHOULD render a fallback
// representation", so an unknown kind draws its own name and its text, and is
// counted in `stats.unknown` rather than dropped.
const KNOWN = new Set(['paragraph', 'heading', 'list', 'list-item', 'code', 'quote', 'embed', 'divider'])

// Bounds, so an adversarial document cannot hang the shell. Corpus doc 20 is
// explicitly "deeply nested lists"; these are what make that a truncated render
// instead of a stack overflow. Same discipline OP_VOCABULARY_DRAFT.md §4 asks of
// preconditions: bounded and total, never throwing.
const MAX_DEPTH = 12
const MAX_COMMANDS = 20000

const HEADING_SIZE = [0, 30, 25, 21, 18, 16, 15]

// The road's own palette, so a pane reads as part of this shell rather than as a
// web page that wandered in. Values from world.js ACC/COOL/BG.
export const THEME = {
  bg: '#03040a',
  fg: '#d7dbe8',
  dim: '#8b93a7',
  accent: '#f2c14e',
  cool: '#2de2e6',
  rule: '#232838',
  codeBg: '#0b0e1a',
  // Edge resolution states, per BendScript §6.4: a renderer SHOULD indicate which
  // of the four a reference is in. Drawing all four the same is the thing the spec
  // is explicitly asking renderers not to do.
  resolved: '#2de2e6',
  pending: '#7f8699',
  broken: '#e2564d',
  unauthorized: '#f2c14e',
}

const font = (size, { weight = 400, italic = false, mono = false } = {}) => ({ size, weight, italic, mono })

// Marks are a SET on the span (§2.5), so a span can be bold and italic at once and
// mark order is not significant. `link` is the only mark carrying data.
function markStyle(marks) {
  let weight = 400, italic = false, mono = false, link = null
  for (const m of marks ?? []) {
    if (m === 'bold') weight = 700
    else if (m === 'italic') italic = true
    else if (m === 'code') mono = true
    else if (m && typeof m === 'object' && m.kind === 'link') link = m
    else if (m === 'link') link = { kind: 'link' }
  }
  return { weight, italic, mono, link }
}

// Split keeping the whitespace as its own token, so a line break can drop the
// space it broke on without losing one inside the text.
const tokenize = (text) => String(text ?? '').split(/(\s+)/).filter((t) => t !== '')

export function layoutBend(doc, opts = {}) {
  const {
    width = 512,
    height = 320,
    pad = 16,
    measure,
    theme = THEME,
    // §6.4. Returns 'resolved' | 'pending' | 'broken' | 'unauthorized'. Default is
    // `pending`, which is the true state of a reference nobody has tried to fetch
    // -- NOT `resolved`, which would be the renderer asserting something it has not
    // checked.
    resolve = () => 'pending',
    // Off for a pane too small to carry the rail (a thumbnail is not a lying
    // renderer, it is a smaller one) -- but ON by default, because the default
    // has to be the honest rendering of the format.
    showEdges = true,
    maxEdges = 8,
  } = opts

  if (typeof measure !== 'function') throw new TypeError('layoutBend needs a measure(text, font) function')

  const cmds = []
  const stats = { blocks: 0, spans: 0, edges: 0, unknown: 0, links: 0 }
  let y = pad
  let truncated = false

  const push = (c) => {
    if (cmds.length >= MAX_COMMANDS) { truncated = true; return false }
    cmds.push(c)
    return true
  }

  const inner = (indent) => width - pad * 2 - indent

  // One wrapped run of styled text. Returns the y after it. Used by paragraphs,
  // headings, list items and quotes alike -- they differ in style and indent, not
  // in how text flows.
  function flow(spans, x0, maxW, base, lineGap) {
    // Runs first: a paragraph's spans have different marks but wrap as ONE stream,
    // so the tokens have to be flattened across span boundaries before flowing. A
    // per-span wrap would break the line at every mark change.
    const toks = []
    for (const sp of spans ?? []) {
      stats.spans++
      const st = markStyle(sp?.marks)
      if (st.link) stats.links++
      const f = font(base.size, { weight: st.weight || base.weight, italic: st.italic || base.italic, mono: st.mono || base.mono })
      const color = st.link ? theme[resolve(st.link.target) ?? 'pending'] ?? theme.pending : base.color
      for (const t of tokenize(sp?.text)) toks.push({ t, f, color, link: st.link, space: /^\s+$/.test(t) })
    }

    let line = []
    let lineW = 0
    const emitLine = () => {
      if (!line.length) return
      let x = x0
      for (const tk of line) {
        const w = measure(tk.t, tk.f)
        if (!tk.space) {
          if (!push({ op: 'text', x, y, text: tk.t, font: tk.f, color: tk.color })) return
          // An underline, not a colour change alone: colour is already carrying
          // the resolution state (§6.4), so the link needs a second channel or the
          // two facts collide on one pixel.
          if (tk.link) push({ op: 'line', x, y: y + 3, x2: x + w, y2: y + 3, color: tk.color, w: 1 })
        }
        x += w
      }
      line = []
      lineW = 0
    }

    for (const tk of toks) {
      const w = measure(tk.t, tk.f)
      // A leading space on a fresh line is the break's own whitespace; drop it.
      if (tk.space && !line.length) continue
      if (lineW + w > maxW && line.length) {
        emitLine()
        y += base.size + lineGap
        if (tk.space) continue
      }
      line.push(tk)
      lineW += w
    }
    emitLine()
    y += base.size + lineGap
    return y
  }

  function block(b, indent, depth) {
    if (!b || typeof b !== 'object') return
    if (depth > MAX_DEPTH) { truncated = true; return }
    if (cmds.length >= MAX_COMMANDS) { truncated = true; return }
    stats.blocks++

    const x0 = pad + indent
    const maxW = inner(indent)
    const kind = b.kind

    if (kind === 'heading') {
      const lvl = Number.isInteger(b.level) && b.level >= 1 && b.level <= 6 ? b.level : 1
      y += lvl === 1 ? 6 : 10
      flow(b.spans, x0, maxW, { size: HEADING_SIZE[lvl], weight: 700, italic: false, mono: false, color: theme.accent }, 4)
      y += 4
      return
    }

    if (kind === 'paragraph') {
      flow(b.spans, x0, maxW, { size: 15, weight: 400, italic: false, mono: false, color: theme.fg }, 6)
      y += 6
      return
    }

    if (kind === 'code') {
      // NOT wrapped. Code that soft-wraps is code that has been changed, and the
      // spec gives a code block `text` rather than spans precisely because it has
      // no inline structure to reflow. Long lines run past the box and are counted
      // as overflow.
      const f = font(13, { mono: true })
      const lines = String(b.text ?? '').split('\n')
      const h = lines.length * (f.size + 4) + 12
      push({ op: 'rect', x: x0, y: y - 2, w: maxW, h, color: theme.codeBg })
      y += 8
      for (const ln of lines) {
        if (!push({ op: 'text', x: x0 + 8, y, text: ln, font: f, color: theme.cool })) break
        y += f.size + 4
      }
      y += 10
      return
    }

    if (kind === 'quote') {
      const barX = x0
      const top = y
      for (const nb of b.blocks ?? []) block(nb, indent + 14, depth + 1)
      push({ op: 'rect', x: barX, y: top, w: 3, h: Math.max(4, y - top - 6), color: theme.cool })
      return
    }

    if (kind === 'list') {
      const ordered = !!b.ordered
      let n = 1
      for (const item of b.items ?? []) {
        const marker = ordered ? `${n}.` : '•'
        push({ op: 'text', x: x0, y, text: marker, font: font(15), color: theme.dim })
        const before = y
        for (const nb of item?.blocks ?? []) block(nb, indent + 22, depth + 1)
        // An item whose blocks drew nothing still consumed a marker; move on so the
        // next marker does not land on top of it.
        if (y === before) y += 21
        n++
      }
      y += 4
      return
    }

    if (kind === 'list-item') {
      for (const nb of b.blocks ?? []) block(nb, indent, depth + 1)
      return
    }

    if (kind === 'divider') {
      y += 8
      push({ op: 'line', x: x0, y, x2: x0 + maxW, y2: y, color: theme.rule, w: 1 })
      y += 12
      return
    }

    if (kind === 'embed') {
      // The renderer does not fetch. An embed shows its target and the target's
      // resolution state, which is the honest rendering of "this points somewhere
      // I have not been".
      const state = resolve(b.target) ?? 'pending'
      push({ op: 'rect', x: x0, y, w: maxW, h: 34, color: theme.codeBg })
      push({ op: 'text', x: x0 + 8, y: y + 22, text: `↪ ${b.target ?? '(no target)'}`, font: font(13, { mono: true }), color: theme[state] ?? theme.pending })
      y += 42
      return
    }

    // §2.2 fallback. Named rather than blank, so an unknown kind reads as "this
    // renderer does not know this" instead of as a document with a hole in it.
    stats.unknown++
    push({ op: 'text', x: x0, y, text: `[${kind ?? 'unknown'}]`, font: font(12, { mono: true }), color: theme.pending })
    y += 16
    if (Array.isArray(b.spans)) flow(b.spans, x0, maxW, { size: 14, weight: 400, italic: true, mono: false, color: theme.dim }, 5)
    else if (Array.isArray(b.blocks)) for (const nb of b.blocks) block(nb, indent + 12, depth + 1)
    y += 4
  }

  push({ op: 'rect', x: 0, y: 0, w: width, h: height, color: theme.bg })

  if (doc?.title) {
    push({ op: 'text', x: pad, y: y + 18, text: String(doc.title), font: font(19, { weight: 700 }), color: theme.accent })
    y += 30
    push({ op: 'line', x: pad, y, x2: width - pad, y2: y, color: theme.rule, w: 1 })
    y += 10
  }

  for (const b of doc?.blocks ?? []) block(b, 0, 0)

  stats.edges = Array.isArray(doc?.edges) ? doc.edges.length : 0

  // THE EDGE RAIL. Without this the pane is a markdown viewer that happens to
  // read JSON: the first version drew every block correctly and drew NOTHING for
  // a document with nine edges and one paragraph, which is the exact shape of
  // corpus doc 12. BendScript §6 opens with "Edges are the protocol's reason to
  // exist", so a renderer that shows blocks and hides edges is not a partial
  // BendScript renderer -- it is a renderer of the part BendScript shares with
  // markdown, which is the part that needed no new format.
  //
  // A RAIL RATHER THAN INLINE ANCHORS, because §2.4 puts edges at the document
  // level on purpose ("keeps spans local and edges global"). Drawing them inline
  // would re-couple what the format deliberately separated. Inline link marks
  // already show where a span points; this shows what the DOCUMENT asserts.
  if (showEdges && stats.edges) {
    y += 10
    push({ op: 'line', x: pad, y, x2: width - pad, y2: y, color: theme.rule, w: 1 })
    y += 16
    push({ op: 'text', x: pad, y, text: `EDGES (${stats.edges})`, font: font(11, { mono: true, weight: 700 }), color: theme.dim })
    y += 16

    const f = font(12, { mono: true })
    const shown = doc.edges.slice(0, maxEdges)
    for (const e of shown) {
      const state = resolve(e?.object) ?? 'pending'
      // The predicate is the load-bearing half -- a vocabulary-namespaced one is
      // the whole reason the edge is not a markdown link -- so it is drawn at full
      // width and the object is what gets clipped when there is not room.
      const pred = String(e?.predicate ?? '?')
      push({ op: 'text', x: pad, y, text: pred, font: font(12, { mono: true, weight: 700 }), color: theme.accent })
      const px = pad + measure(pred, font(12, { mono: true, weight: 700 })) + 8
      let obj = String(e?.object ?? '?')
      const room = width - pad - px
      while (obj.length > 6 && measure('→ ' + obj, f) > room) obj = obj.slice(0, -2)
      if (obj !== String(e?.object ?? '?')) obj = obj.slice(0, -1) + '…'
      push({ op: 'text', x: px, y, text: '→ ' + obj, font: f, color: theme[state] ?? theme.pending })
      y += 17
    }
    if (stats.edges > shown.length) {
      push({ op: 'text', x: pad, y, text: `+ ${stats.edges - shown.length} more`, font: font(11, { mono: true, italic: true }), color: theme.dim })
      y += 15
    }
    y += 4
  }

  return {
    commands: cmds,
    // The content's own height, which is what the caller needs to decide whether
    // to grow the pane -- NOT the box height, and not clamped to it.
    height: y + pad,
    overflow: y + pad > height,
    truncated,
    stats,
  }
}

// THE CARD TIER (PAPER_ROADS.md §5). What a pane looks like when it is too far
// away to read: title, and the two counts that say how big the thing is. Derived
// from the document rather than from a layout, because the whole point of the card
// tier is that it costs nothing -- laying a document out to decide it is far away
// would spend exactly what the tier exists to save.
export function cardOf(doc) {
  return {
    title: typeof doc?.title === 'string' && doc.title ? doc.title : '(untitled)',
    blocks: Array.isArray(doc?.blocks) ? doc.blocks.length : 0,
    edges: Array.isArray(doc?.edges) ? doc.edges.length : 0,
    vocabulary: typeof doc?.vocabulary === 'string' ? doc.vocabulary : 'core',
  }
}
