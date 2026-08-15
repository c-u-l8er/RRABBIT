// LAYOUT TESTS THAT RUN ON THE DEV HOST. No browser, no GL context, no guest.
//
// This is the whole reason `bend-layout.js` has no THREE and no DOM in it
// (PAPER_ROADS.md §6). Run: `node test/paper-layout.mjs` from RRABBIT/.
//
// The corpus is NOT a fixture written for this test -- it is bendscript.com's own
// 20-document v0.1 conformance corpus, which exists to exercise the protocol
// surface rather than this renderer. A renderer that passes against documents
// written for someone else's purpose has been tested; one that passes against its
// own fixtures has been described.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { layoutBend, cardOf, THEME } from '../m2/paper/bend-layout.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(here, '..', '..', 'bendscript.com', 'test-corpus', 'v0.1')

// An EXACT fake, not an approximation of a real font. The point of injecting
// `measure` is that layout is deterministic given widths; a test that used real
// metrics would be testing the font.
const measure = (text, f) => text.length * f.size * (f.weight >= 700 ? 0.62 : 0.6)

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const docs = readdirSync(CORPUS).filter((f) => f.endsWith('.json')).sort()
console.log(`corpus: ${docs.length} documents from ${CORPUS}\n`)

const KINDS = new Set(['rect', 'line', 'text'])
const W = 512, H = 320, PAD = 16

// ---- 1. totality: every corpus document lays out, none throws --------------
for (const f of docs) {
  const doc = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'))
  let r = null, threw = null
  try { r = layoutBend(doc, { width: W, height: H, measure }) } catch (e) { threw = e }
  ok(`${f} lays out`, !threw, threw && threw.message)
  if (!r) continue

  ok(`${f} emits commands`, r.commands.length > 0)
  ok(`${f} closed command set`, r.commands.every((c) => KINDS.has(c.op)),
    [...new Set(r.commands.map((c) => c.op))].filter((k) => !KINDS.has(k)).join(','))
  ok(`${f} every text has finite coords`, r.commands.filter((c) => c.op === 'text')
    .every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)))
  ok(`${f} height is a real number`, Number.isFinite(r.height) && r.height > 0)
}

// ---- 2. wrapping actually wraps -------------------------------------------
{
  const long = 'wallriderlang '.repeat(60).trim()
  const doc = { blocks: [{ kind: 'paragraph', spans: [{ text: long }] }] }
  const r = layoutBend(doc, { width: W, height: H, measure })
  const texts = r.commands.filter((c) => c.op === 'text')
  const rows = new Set(texts.map((c) => c.y))
  ok('long paragraph wraps to many lines', rows.size > 8, `rows=${rows.size}`)

  // The real assertion: no drawn word ends past the right pad. A wrap that
  // "looks wrapped" but overhangs is the bug this catches.
  const over = texts.filter((c) => c.x + measure(c.text, c.font) > W - PAD + 0.5)
  ok('no text overhangs the box', over.length === 0, `${over.length} overhanging`)
}

// ---- 3. wrapping flows ACROSS spans, not per span --------------------------
{
  // Twelve one-word spans that together exceed one line. Per-span wrapping would
  // put each on its own row; correct flow packs several per row.
  const spans = Array.from({ length: 12 }, (_, i) => ({ text: `word${i} `, marks: i % 2 ? ['bold'] : [] }))
  const r = layoutBend({ blocks: [{ kind: 'paragraph', spans }] }, { width: 200, height: H, measure })
  const rows = new Set(r.commands.filter((c) => c.op === 'text').map((c) => c.y))
  ok('spans share lines', rows.size < 12 && rows.size > 1, `rows=${rows.size} for 12 spans`)
  ok('bold spans keep their weight', r.commands.some((c) => c.op === 'text' && c.font.weight === 700))
}

// ---- 4. unknown block kinds fall back, never vanish (§2.2) -----------------
{
  const doc = { blocks: [{ kind: 'argument-position', spans: [{ text: 'the loop is closed' }] }] }
  const r = layoutBend(doc, { width: W, height: H, measure })
  ok('unknown kind is counted', r.stats.unknown === 1, `unknown=${r.stats.unknown}`)
  ok('unknown kind names itself', r.commands.some((c) => c.op === 'text' && c.text.includes('argument-position')))
  ok('unknown kind still draws its text', r.commands.some((c) => c.op === 'text' && c.text.includes('closed')))
}

// ---- 5. adversarial nesting terminates and SAYS it truncated --------------
{
  let deep = { kind: 'paragraph', spans: [{ text: 'bottom' }] }
  for (let i = 0; i < 400; i++) deep = { kind: 'quote', blocks: [deep] }
  const t0 = Date.now()
  const r = layoutBend({ blocks: [deep] }, { width: W, height: H, measure })
  ok('400-deep nesting terminates', Date.now() - t0 < 2000, `${Date.now() - t0}ms`)
  ok('400-deep nesting reports truncation', r.truncated === true)
  ok('400-deep nesting did not reach the bottom', !r.commands.some((c) => c.op === 'text' && c.text === 'bottom'))
}

// ---- 6. a huge document hits the command cap and says so ------------------
{
  const blocks = Array.from({ length: 40000 }, (_, i) => ({ kind: 'paragraph', spans: [{ text: `line ${i}` }] }))
  const r = layoutBend({ blocks }, { width: W, height: H, measure })
  ok('command cap holds', r.commands.length <= 20000, `${r.commands.length} commands`)
  ok('command cap is reported', r.truncated === true)
}

// ---- 7. overflow is reported, not clipped silently ------------------------
{
  const many = Array.from({ length: 40 }, () => ({ kind: 'paragraph', spans: [{ text: 'a paragraph' }] }))
  const tall = layoutBend({ blocks: many }, { width: W, height: 100, measure })
  const room = layoutBend({ blocks: many }, { width: W, height: 4000, measure })
  ok('overflow true when content exceeds box', tall.overflow === true)
  ok('overflow false when it fits', room.overflow === false)
  ok('height is content height, not box height', tall.height === room.height && tall.height > 100)
}

// ---- 8. edge resolution states are distinguished (§6.4) -------------------
{
  const doc = { blocks: [{ kind: 'paragraph', spans: [
    { text: 'here', marks: [{ kind: 'link', target: 'bend:aaa' }] },
    { text: ' and ' },
    { text: 'there', marks: [{ kind: 'link', target: 'bend:bbb' }] },
  ] }] }
  const r = layoutBend(doc, { width: W, height: H, measure,
    resolve: (t) => (t === 'bend:aaa' ? 'resolved' : 'broken') })
  const colors = new Set(r.commands.filter((c) => c.op === 'line').map((c) => c.color))
  ok('two resolution states get two colours', colors.size === 2, [...colors].join(','))
  ok('resolved uses the resolved colour', colors.has(THEME.resolved))
  ok('broken uses the broken colour', colors.has(THEME.broken))
  ok('links are counted', r.stats.links === 2, `links=${r.stats.links}`)

  // An unresolved reference must NOT default to `resolved` -- that would be the
  // renderer asserting something nobody checked.
  const d = layoutBend(doc, { width: W, height: H, measure })
  ok('default resolution is pending', d.commands.filter((c) => c.op === 'line')
    .every((c) => c.color === THEME.pending))
}

// ---- 8b. the edge rail: a document that is ONLY edges must not render blank -
{
  // Corpus doc 12 is one paragraph and nine edges. The first version of this
  // renderer drew the paragraph and nothing else, which is a markdown viewer.
  const doc = JSON.parse(readFileSync(join(CORPUS, '12-all-core-predicates.bend.json'), 'utf8'))
  const withRail = layoutBend(doc, { width: W, height: H, measure })
  const without = layoutBend(doc, { width: W, height: H, measure, showEdges: false })

  ok('doc 12 has nine edges', withRail.stats.edges === 9, `edges=${withRail.stats.edges}`)
  ok('the rail draws something', withRail.commands.length > without.commands.length + 9,
    `${withRail.commands.length} vs ${without.commands.length}`)

  const texts = withRail.commands.filter((c) => c.op === 'text').map((c) => c.text)
  ok('the rail is labelled with a count', texts.some((t) => t === 'EDGES (9)'), texts.slice(0, 4).join('|'))
  for (const p of ['cites', 'supports', 'contradicts', 'supersedes', 'transcludes'])
    ok(`predicate "${p}" is drawn`, texts.includes(p))

  // maxEdges caps the rail and SAYS it capped -- silent truncation would make a
  // 40-edge document look like an 8-edge one.
  const capped = layoutBend(doc, { width: W, height: H, measure, maxEdges: 3 })
  const ct = capped.commands.filter((c) => c.op === 'text').map((c) => c.text)
  ok('rail respects maxEdges', ct.filter((t) => t.startsWith('→ ')).length === 3)
  ok('rail reports what it dropped', ct.some((t) => t === '+ 6 more'), ct.filter((t) => t.includes('more')).join('|'))

  // Object refs are clipped to the box like everything else.
  const long = { blocks: [], edges: [{ subject: 'a', predicate: 'cites', object: 'bend:' + 'z'.repeat(400) }] }
  const r = layoutBend(long, { width: 240, height: H, measure })
  const over = r.commands.filter((c) => c.op === 'text').filter((c) => c.x + measure(c.text, c.font) > 240 - PAD + 0.5)
  ok('long edge objects are clipped to the box', over.length === 0, `${over.length} overhanging`)

  // A doc with no edges gets no rail at all -- an empty "EDGES (0)" header would
  // be chrome asserting the document has a graph section when it has none.
  const none = layoutBend({ blocks: [{ kind: 'paragraph', spans: [{ text: 'hi' }] }] }, { width: W, height: H, measure })
  ok('no edges, no rail', !none.commands.some((c) => c.op === 'text' && String(c.text).startsWith('EDGES')))
}

// ---- 9. determinism -------------------------------------------------------
{
  const doc = JSON.parse(readFileSync(join(CORPUS, docs[docs.length - 1]), 'utf8'))
  const a = layoutBend(doc, { width: W, height: H, measure })
  const b = layoutBend(doc, { width: W, height: H, measure })
  ok('same input, same commands', JSON.stringify(a.commands) === JSON.stringify(b.commands))
}

// ---- 10. the card tier costs nothing and still says something -------------
{
  for (const f of docs.slice(0, 5)) {
    const doc = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'))
    const c = cardOf(doc)
    ok(`${f} card has a title`, typeof c.title === 'string' && c.title.length > 0)
    ok(`${f} card counts blocks`, Number.isInteger(c.blocks))
  }
  const empty = cardOf(null)
  ok('card of nothing does not throw', empty.title === '(untitled)' && empty.blocks === 0)
}

// ---- 11. a missing measure is refused loudly ------------------------------
{
  let threw = false
  try { layoutBend({ blocks: [] }, { width: W, height: H }) } catch { threw = true }
  ok('missing measure is refused', threw)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
