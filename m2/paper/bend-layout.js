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

// THE ONE PLACE THE TWO TIERS GET THEIR GEOMETRY, and the reason it exists.
//
// The canvas tier and the DOM tier were laying the same document out with two
// independent sets of numbers -- a 16px pad here against `18px 20px` there, a
// 21px body advance here against `15px/1.5` (22.5) there, `y += 6` before a
// heading here against `margin:.5em` there. Every one of those differences is a
// different wrap point, so entering a pane re-flowed it. Reported as "some of the
// windows are still changing font sizes before and after click", which is what a
// reflow looks like when the sizes are in fact identical.
//
// This is the same fix `runeMetrics` already is for the RuneFort tier, and its
// comment in read.js is the standing rule: anything geometric that goes back into
// the stylesheet re-opens the jank.
//
// PADDING, NOT MARGIN, on the DOM side. CSS collapses adjacent vertical margins
// and a canvas has no such rule, so any margin-based spacing is a difference the
// two tiers cannot both implement. Every gap below is additive on both sides.
export const BEND_METRICS = {
  pad: 18,
  bodySize: 15,
  // The advance from one baseline to the next. `15 * 1.5` rounded, which is what
  // the CSS was already doing to the body font.
  bodyLine: 22,
  headSize: HEADING_SIZE,
  // 1.25, matching the stylesheet's `line-height` for headings.
  headLine: (lvl) => Math.round(HEADING_SIZE[lvl] * 1.25),
  headAbove: 12,
  headBelow: 6,
  paraBelow: 8,
  codeSize: 13,
  codeLine: 17,
  codePad: 10,
  codeBelow: 10,
  quoteIndent: 14,
  quoteBar: 3,
  quoteBelow: 8,
  listIndent: 22,
  listBelow: 4,
  ruleAbove: 10,
  ruleBelow: 10,
  // THE DOCUMENT TITLE, which is not a heading block -- it is `doc.title`, drawn
  // above the blocks with a rule under it. The canvas drew it at 19px bold and the
  // DOM tier gave it a plain `h1`, which the stylesheet sized at 30: the single
  // largest size disagreement between the two tiers, on the one line of every
  // document you look at first.
  titleSize: 19,
  titleLine: 26,
  titleBelow: 10,
  // THE EDGE RAIL. The last thing on every document that has edges, and the last
  // place the two tiers still disagreed after everything above was unified -- 40px
  // of it, measured, which is two lines of drift at the bottom of the page.
  railAbove: 10,
  railGap: 8,
  railLabelSize: 11,
  railLabelLine: 16,
  railSize: 12,
  railLine: 17,
  railBelow: 4,
}
const M = BEND_METRICS

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
    // FROM THE METRICS, so the box the canvas wraps in is the box the DOM wraps in.
    // 16 here against `18px 20px` there meant the two tiers had different line
    // widths, so they broke lines in different places -- which is a re-flow on
    // entering the pane whatever the fonts do.
    pad = BEND_METRICS.pad,
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
  //
  // `advance` is the BASELINE-TO-BASELINE distance, not a gap between lines. It
  // used to be a gap and the difference is the bug that made multi-line headings
  // and quotes render broken.
  //
  // THE FIRST BASELINE IS ONE LINE DOWN FROM THE BLOCK'S TOP, and that is the whole
  // correction. `paint` draws text with `textBaseline = 'alphabetic'`, so a command
  // at the block's own top edge puts the entire ascender ABOVE that edge -- through
  // the bottom of whatever was drawn before it. One line got away with it because
  // the caller happened to add a gap first; a wrapped heading did not, because
  // every line after the first is spaced correctly and only the first one is
  // lifted, so the block collides upward and reads as broken leading. Reported as
  // "the multi lined headers are rendering broken", and the quote is the same
  // fault seen through its own bar.
  //
  // The total height is UNCHANGED -- N lines still occupy N advances. Only the
  // baselines inside it move down by one, which is where they belong.
  function flow(spans, x0, maxW, base, advance) {
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

    // Down to the first baseline before anything is emitted -- see the header.
    y += base.size

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
      // A SPACE NEVER BREAKS A LINE BY ITSELF, which is what CSS does and what this
      // did not. Counting a trailing space against the measure made the canvas wrap
      // one word earlier than the DOM on any line that ended near the edge -- so
      // the same document came out taller here than there, and every line after the
      // first divergence was in a different place. Measured at 420 units wide: 84px
      // of extra height over a ~600px document, which is four lines.
      if (!tk.space && lineW + w > maxW && line.length) {
        emitLine()
        y += advance
      }
      line.push(tk)
      lineW += w
    }
    emitLine()
    // The last line's DESCENDER, not another whole advance: the baselines have
    // already been walked, and adding a full line here would leave every block
    // trailing one empty row it never drew into.
    y += advance - base.size
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
      y += M.headAbove
      flow(b.spans, x0, maxW, { size: M.headSize[lvl], weight: 700, italic: false, mono: false, color: theme.accent }, M.headLine(lvl))
      y += M.headBelow
      return
    }

    if (kind === 'paragraph') {
      flow(b.spans, x0, maxW, { size: M.bodySize, weight: 400, italic: false, mono: false, color: theme.fg }, M.bodyLine)
      y += M.paraBelow
      return
    }

    if (kind === 'code') {
      // NOT wrapped. Code that soft-wraps is code that has been changed, and the
      // spec gives a code block `text` rather than spans precisely because it has
      // no inline structure to reflow. Long lines run past the box and are counted
      // as overflow.
      const f = font(M.codeSize, { mono: true })
      const lines = String(b.text ?? '').split('\n')
      const h = lines.length * M.codeLine + M.codePad * 2
      // THE PLATE IS SIZED FROM THE SAME ARITHMETIC THE TEXT THEN WALKS, so the two
      // cannot drift, and it starts at the block's own top rather than 2px above it.
      push({ op: 'rect', x: x0, y, w: maxW, h, color: theme.codeBg })
      y += M.codePad
      for (const ln of lines) {
        // Down to the baseline first -- the same correction `flow` makes, and code
        // has to make it by hand because it does not wrap and so does not use it.
        y += f.size
        if (!push({ op: 'text', x: x0 + M.codePad, y, text: ln, font: f, color: theme.cool })) break
        y += M.codeLine - f.size
      }
      y += M.codePad + M.codeBelow
      return
    }

    if (kind === 'quote') {
      const barX = x0
      const top = y
      for (const nb of b.blocks ?? []) block(nb, indent + M.quoteIndent, depth + 1)
      // THE BAR SPANS WHAT THE QUOTE ACTUALLY OCCUPIES. It used to end at
      // `y - top - 6` -- a constant borrowed from the paragraph's old trailing gap,
      // so with any other block inside, or any change to that gap, the bar stopped
      // short of its own text or ran past the end of it. Reported as the quoted text
      // being janked on the road and coming right on entering.
      push({ op: 'rect', x: barX, y: top, w: M.quoteBar, h: Math.max(4, y - top), color: theme.cool })
      y += M.quoteBelow
      return
    }

    if (kind === 'list') {
      const ordered = !!b.ordered
      let n = 1
      for (const item of b.items ?? []) {
        const marker = ordered ? `${n}.` : '•'
        // ON THE SAME BASELINE AS THE ITEM'S FIRST LINE, which `flow` now puts one
        // line below the block's top. Drawn at the top itself, the marker sat a
        // whole line height above the text it belongs to.
        push({ op: 'text', x: x0, y: y + M.bodySize, text: marker, font: font(M.bodySize), color: theme.dim })
        const before = y
        for (const nb of item?.blocks ?? []) block(nb, indent + M.listIndent, depth + 1)
        // An item whose blocks drew nothing still consumed a marker; move on so the
        // next marker does not land on top of it.
        if (y === before) y += M.bodyLine
        n++
      }
      y += M.listBelow
      return
    }

    if (kind === 'list-item') {
      for (const nb of b.blocks ?? []) block(nb, indent, depth + 1)
      return
    }

    if (kind === 'divider') {
      y += M.ruleAbove
      push({ op: 'line', x: x0, y, x2: x0 + maxW, y2: y, color: theme.rule, w: 1 })
      y += M.ruleBelow
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
    // Baseline first, then the rest of the line, then the rule -- the same walk
    // every block makes now, so the title cannot be the one thing on the page
    // whose spacing is a hand-picked pair of numbers.
    y += M.titleSize
    push({ op: 'text', x: pad, y, text: String(doc.title), font: font(M.titleSize, { weight: 700 }), color: theme.accent })
    y += M.titleLine - M.titleSize
    push({ op: 'line', x: pad, y, x2: width - pad, y2: y, color: theme.rule, w: 1 })
    y += M.titleBelow
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
    y += M.railAbove
    push({ op: 'line', x: pad, y, x2: width - pad, y2: y, color: theme.rule, w: 1 })
    y += M.railGap + M.railLabelSize
    push({ op: 'text', x: pad, y, text: `EDGES (${stats.edges})`, font: font(M.railLabelSize, { mono: true, weight: 700 }), color: theme.dim })
    y += M.railLabelLine

    const f = font(M.railSize, { mono: true })
    const shown = doc.edges.slice(0, maxEdges)
    for (const e of shown) {
      const state = resolve(e?.object) ?? 'pending'
      // The predicate is the load-bearing half -- a vocabulary-namespaced one is
      // the whole reason the edge is not a markdown link -- so it is drawn at full
      // width and the object is what gets clipped when there is not room.
      const pred = String(e?.predicate ?? '?')
      // Down to the baseline first, the same correction every other run makes.
      y += M.railSize
      push({ op: 'text', x: pad, y, text: pred, font: font(M.railSize, { mono: true, weight: 700 }), color: theme.accent })
      const px = pad + measure(pred, font(M.railSize, { mono: true, weight: 700 })) + 8
      let obj = String(e?.object ?? '?')
      const room = width - pad - px
      while (obj.length > 6 && measure('→ ' + obj, f) > room) obj = obj.slice(0, -2)
      if (obj !== String(e?.object ?? '?')) obj = obj.slice(0, -1) + '…'
      push({ op: 'text', x: px, y, text: '→ ' + obj, font: f, color: theme[state] ?? theme.pending })
      y += M.railLine - M.railSize
    }
    if (stats.edges > shown.length) {
      y += M.railLabelSize
      push({ op: 'text', x: pad, y, text: `+ ${stats.edges - shown.length} more`, font: font(M.railLabelSize, { mono: true, italic: true }), color: theme.dim })
      y += M.railLabelLine - M.railLabelSize
    }
    y += M.railBelow
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
