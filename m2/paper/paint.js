// DRAW COMMANDS ONTO A 2-D CONTEXT. This module makes no decisions.
//
// Everything that could be decided differently -- where a line breaks, what an
// unknown block kind looks like, whether something overflowed -- was decided in
// `bend-layout.js`, which has no canvas and therefore runs under `node`. What is
// left here is a `switch` over three command kinds, and it is deliberately that
// dull: a bug in this file shows up as the wrong pixels for the right layout,
// which is a different and much smaller search than a bug that could be either.
//
// A 2-D CONTEXT IS NOT A WEBGL CONTEXT. That is the practical reason this split
// pays off twice: the shell cannot be opened on the dev host because the GL
// context pool is held, but a paper pane's painting can be rendered and looked at
// in an ordinary page. Only the step that hangs the canvas on a road (`paper.js`)
// needs the guest.

// THE ONE PLACE A FONT BECOMES A STRING. Both the painter and the measurer must
// agree exactly -- `measureText` under a different font than the one that draws is
// how you get a layout that is right by arithmetic and wrong on screen.
export function fontCss(f) {
  const fam = f.mono
    ? 'ui-monospace, "DejaVu Sans Mono", monospace'
    : 'ui-sans-serif, "DejaVu Sans", system-ui, sans-serif'
  return `${f.italic ? 'italic ' : ''}${f.weight} ${f.size}px ${fam}`
}

// The measurer to hand `layoutBend` when there is a real canvas. Cached per font
// string because setting `ctx.font` is not free and a paragraph asks for the same
// handful of fonts hundreds of times.
export function measurerFor(ctx) {
  let last = null
  return (text, f) => {
    const css = fontCss(f)
    if (css !== last) { ctx.font = css; last = css }
    return ctx.measureText(text).width
  }
}

export function paint(ctx, commands) {
  let lastFont = null
  ctx.textBaseline = 'alphabetic'
  for (const c of commands) {
    if (c.op === 'rect') {
      ctx.fillStyle = c.color
      ctx.fillRect(c.x, c.y, c.w, c.h)
    } else if (c.op === 'line') {
      ctx.strokeStyle = c.color
      ctx.lineWidth = c.w ?? 1
      ctx.beginPath()
      // The half-pixel is what keeps a 1px rule from landing across two rows of
      // pixels and rendering as a 2px grey smear.
      ctx.moveTo(c.x, c.y + 0.5)
      ctx.lineTo(c.x2, c.y2 + 0.5)
      ctx.stroke()
    } else if (c.op === 'text') {
      const css = fontCss(c.font)
      if (css !== lastFont) { ctx.font = css; lastFont = css }
      ctx.fillStyle = c.color
      ctx.fillText(c.text, c.x, c.y)
    }
    // No default branch, and that is the closed-set claim doing its job: a command
    // kind that is not one of the three cannot arrive here, because `layoutBend` is
    // the only thing that emits them and it only emits three.
  }
}

// THE CARD TIER (PAPER_ROADS.md §5). Not a laid-out document -- a laid-out
// document is exactly the cost this tier exists to avoid. Title and two counts.
export function paintCard(ctx, card, { width, height, theme }) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = theme.rule
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, width - 2, height - 2)

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.accent
  ctx.font = fontCss({ size: Math.round(height * 0.16), weight: 700, italic: false, mono: false })
  // One line, clipped with an ellipsis. A card that wrapped would be a small
  // document, and then it would need the layout it is meant to skip.
  const max = width - 24
  let t = card.title
  while (t.length > 4 && ctx.measureText(t).width > max) t = t.slice(0, -2)
  if (t !== card.title) t = t.slice(0, -1) + '…'
  ctx.fillText(t, 12, Math.round(height * 0.42))

  ctx.fillStyle = theme.dim
  ctx.font = fontCss({ size: Math.round(height * 0.11), weight: 400, italic: false, mono: true })
  ctx.fillText(`${card.blocks} blocks · ${card.edges} edges`, 12, Math.round(height * 0.66))
  ctx.fillStyle = theme.cool
  ctx.fillText(card.vocabulary, 12, Math.round(height * 0.86))
}
