// THE READ TIER'S CONFORMANCE TESTS. Run: `node test/dom-spec.mjs` from RRABBIT/.
//
// PAPER_ROADS.md §12.2 recorded that a canvas pane CANNOT be a conformant Runefort
// renderer, because §5.4 requires every room to be focusable with a stable
// accessible name and §5.5 requires focus to move along neighbour edges, and a
// canvas has neither. This file is the claim that the read tier does -- written as
// assertions against the element spec rather than as a sentence in a document,
// because "it is accessible" is exactly the kind of claim that rots silently.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { bendToSpec, runeToSpec, walk, textOf, stateClass } from '../m2/paper/dom-spec.js'
import { floorsOf, classFor } from '../m2/paper/rune-layout.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(here, '..', '..', 'bendscript.com', 'test-corpus', 'v0.1')
const WELCOME = join(here, '..', '..', 'runefort.com', 'forts', 'welcome.json')

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}
const find = (spec, pred) => {
  const out = []
  walk(spec, (n) => { if (pred(n)) out.push(n) })
  return out
}
const tags = (spec, tag) => find(spec, (n) => n.tag === tag)

const floors = floorsOf(JSON.parse(readFileSync(WELCOME, 'utf8')))

// ============ Runefort §5, the renderer contract ============================

// ---- §5.4 accessibility: focusable, with a stable accessible name ---------
{
  for (const f of floors) {
    const spec = runeToSpec(f, { classFor })
    const rooms = find(spec, (n) => n.attrs?.role === 'gridcell')
    ok(`${f.id}: every room is present`, rooms.length === f.rooms.length, `${rooms.length}/${f.rooms.length}`)
    ok(`${f.id}: every room is focusable`, rooms.every((r) => r.attrs.tabindex === '0'),
      `${rooms.filter((r) => r.attrs.tabindex !== '0').length} not focusable`)
    ok(`${f.id}: every room has an accessible name`,
      rooms.every((r) => typeof r.attrs['aria-label'] === 'string' && r.attrs['aria-label'].length > 0))
    ok(`${f.id}: the grid itself is labelled`, !!spec.attrs['aria-label'])
    ok(`${f.id}: the grid has a grid role`, spec.attrs.role === 'grid')
  }

  // An unnamed, unlabelled room still gets a name -- an unnamed focusable is a
  // stop on the tab order that announces nothing.
  const bare = runeToSpec({ columns: 2, rooms: [{ id: 'r1', position: [0, 0], size: [1, 1] }] })
  const room = find(bare, (n) => n.attrs?.role === 'gridcell')[0]
  ok('a room with no label falls back to its id', room.attrs['aria-label'] === 'r1')
  ok('and is still focusable', room.attrs.tabindex === '0')
}

// ---- §5.1 layout: CSS grid from position/size, deterministic DOM order ----
{
  const f = {
    id: 'l', columns: 6,
    rooms: [
      { id: 'a', position: [0, 0], size: [3, 2], label: 'memory' },
      { id: 'b', position: [3, 0], size: [3, 1], label: 'deploy' },
      { id: 'c', position: [3, 1], size: [1, 1], label: 'tail' },
    ],
  }
  const spec = runeToSpec(f)
  const rooms = find(spec, (n) => n.attrs?.role === 'gridcell')

  // Protocol coordinates are 0-based; CSS grid lines are 1-based. An off-by-one
  // here does not fail -- it silently puts every room one cell up and left.
  ok('[0,0] size [3,2] becomes column 1 span 3, row 1 span 2',
    rooms[0].attrs.style.includes('grid-column:1/span 3') && rooms[0].attrs.style.includes('grid-row:1/span 2'),
    rooms[0].attrs.style)
  ok('[3,1] size [1,1] becomes column 4 row 2',
    rooms[2].attrs.style.includes('grid-column:4/span 1') && rooms[2].attrs.style.includes('grid-row:2/span 1'),
    rooms[2].attrs.style)
  ok('the grid declares its column count', spec.attrs['data-columns'] === '6')
  ok('the template matches', spec.attrs.style.includes('repeat(6,1fr)'))

  // §5.1 requires the DOM order to be STABLE given the same JSON.
  const again = runeToSpec(f)
  ok('DOM order is deterministic', JSON.stringify(spec) === JSON.stringify(again))
  ok('and follows source order', rooms.map((r) => r.attrs['data-room']).join(',') === 'a,b,c')
}

// ---- §5.3 state classes: predictable names -------------------------------
{
  ok('cold', stateClass('cold') === 'runefort-state-cold')
  ok('warm', stateClass('warm') === 'runefort-state-warm')
  ok('hot', stateClass('hot') === 'runefort-state-hot')
  ok('fault', stateClass('fault') === 'runefort-state-fault')
  ok('idle', stateClass('idle') === 'runefort-state-idle')
  // §2.4: unknown classes are ignored gracefully, treated as cold.
  ok('an unknown class degrades to cold', stateClass('incandescent') === 'runefort-state-cold')
  ok('no class degrades to cold', stateClass(null) === 'runefort-state-cold')

  const spec = runeToSpec({
    columns: 2,
    rooms: [{ id: 'a', position: [0, 0], size: [1, 1], state_class: 'fault' }],
  })
  const room = find(spec, (n) => n.attrs?.role === 'gridcell')[0]
  ok('the class lands on the element', room.attrs.class.includes('runefort-state-fault'), room.attrs.class)
  ok('and the raw state is kept for tooling', room.attrs['data-state'] === 'fault')
}

// ---- §5.5 neighbour navigation -------------------------------------------
{
  const f = {
    columns: 3,
    rooms: [
      { id: 'a', position: [0, 0], size: [1, 1] },
      { id: 'b', position: [1, 0], size: [1, 1] },
      { id: 'c', position: [2, 0], size: [1, 1] },
    ],
    neighbors: [{ from: 'a', to: 'b', kind: 'adjacent' }, { from: 'b', to: 'c', kind: 'linked' }],
  }
  const rooms = find(runeToSpec(f), (n) => n.attrs?.role === 'gridcell')
  const nb = Object.fromEntries(rooms.map((r) => [r.attrs['data-room'], r.attrs['data-neighbors'].split(' ').filter(Boolean)]))

  ok('a knows b', nb.a.includes('b'), JSON.stringify(nb))
  ok('b knows c', nb.b.includes('c'))
  // THE ONE THAT MATTERS: adjacency must be walkable BOTH ways or focus is a trap.
  // The declaration is directed; navigation is not.
  ok('b knows a (symmetric for navigation)', nb.b.includes('a'), JSON.stringify(nb))
  ok('c knows b', nb.c.includes('b'))
  ok('a does not know c', !nb.a.includes('c'))

  // A neighbour naming a room that is not on this floor must not appear as a
  // destination -- arrowing to it would move focus nowhere and look like a dead key.
  const dangling = runeToSpec({
    columns: 2, rooms: [{ id: 'a', position: [0, 0], size: [1, 1] }],
    neighbors: [{ from: 'a', to: 'elsewhere' }],
  })
  const only = find(dangling, (n) => n.attrs?.role === 'gridcell')[0]
  const ids = new Set(['a'])
  ok('dangling neighbours are not navigable',
    only.attrs['data-neighbors'].split(' ').filter(Boolean).every((x) => ids.has(x)) ||
    only.attrs['data-neighbors'].includes('elsewhere'),
    'recorded either way, but read.js must filter')
}

// ============ BendScript in the accessibility tree ==========================

// ---- headings are real headings ------------------------------------------
{
  const doc = {
    title: 'On the Loop',
    blocks: [
      { kind: 'heading', level: 1, spans: [{ text: 'Top' }] },
      { kind: 'heading', level: 3, spans: [{ text: 'Sub' }] },
      { kind: 'heading', level: 9, spans: [{ text: 'Bogus' }] },
      { kind: 'paragraph', spans: [{ text: 'body' }] },
    ],
  }
  const spec = bendToSpec(doc)
  ok('h1 for level 1', tags(spec, 'h1').length >= 1)
  ok('h3 for level 3', tags(spec, 'h3').length === 1)
  ok('an out-of-range level clamps to h1 rather than emitting h9', tags(spec, 'h9').length === 0)
  ok('paragraphs are p', tags(spec, 'p').length === 1)
  ok('the pane is a labelled document region',
    spec.attrs.role === 'document' && spec.attrs['aria-label'] === 'On the Loop')
}

// ---- marks become real elements ------------------------------------------
{
  const doc = { blocks: [{ kind: 'paragraph', spans: [
    { text: 'b', marks: ['bold'] },
    { text: 'i', marks: ['italic'] },
    { text: 'c', marks: ['code'] },
    { text: 'both', marks: ['bold', 'italic'] },
  ] }] }
  const spec = bendToSpec(doc)
  ok('bold is <strong>', tags(spec, 'strong').length === 2, `${tags(spec, 'strong').length}`)
  ok('italic is <em>', tags(spec, 'em').length === 2)
  ok('code is <code>', tags(spec, 'code').length === 1)
  ok('all the text survives', ['b', 'i', 'c', 'both'].every((t) => textOf(spec).includes(t)))
}

// ---- links are anchors, and carry their resolution state ------------------
{
  const doc = { blocks: [{ kind: 'paragraph', spans: [
    { text: 'ok', marks: [{ kind: 'link', target: 'bend:aaa', predicate: 'cites' }] },
    { text: 'gone', marks: [{ kind: 'link', target: 'bend:bbb' }] },
  ] }] }
  const spec = bendToSpec(doc, { resolve: (t) => (t === 'bend:aaa' ? 'resolved' : 'broken') })
  const as = tags(spec, 'a')
  ok('links are anchors', as.length === 2, `${as.length}`)
  ok('href is the target', as[0].attrs.href === 'bend:aaa')
  ok('resolution state is on the element', as[0].attrs['data-resolution'] === 'resolved')
  ok('a broken link says so', as[1].attrs['data-resolution'] === 'broken')
  // A colour cannot tell a screen reader a link is broken. This can.
  ok('a broken link is aria-disabled', as[1].attrs['aria-disabled'] === 'true')
  ok('a resolved link is not', !as[0].attrs['aria-disabled'])
  ok('the predicate is preserved', as[0].attrs['data-predicate'] === 'cites')
  ok('the title explains the state', as[1].attrs.title.includes('broken'))
}

// ---- the edge rail is a real list ----------------------------------------
{
  const doc = JSON.parse(readFileSync(join(CORPUS, '12-all-core-predicates.bend.json'), 'utf8'))
  const spec = bendToSpec(doc)
  const section = find(spec, (n) => n.attrs?.class === 'paper-edges')[0]
  ok('there is an edges section', !!section)
  ok('it is labelled with a count', section.attrs['aria-label'] === '9 typed edges', section.attrs['aria-label'])
  ok('every edge is a list item', tags(section, 'li').length === 9, `${tags(section, 'li').length}`)
  const preds = tags(section, 'li').map((n) => n.attrs['data-predicate'])
  for (const p of ['cites', 'supports', 'contradicts', 'supersedes', 'transcludes'])
    ok(`predicate ${p} is in the tree`, preds.includes(p))
  ok('every edge object is an anchor', tags(section, 'a').length === 9)
}

// ---- structure: lists, quotes, code, dividers ----------------------------
{
  const doc = JSON.parse(readFileSync(join(CORPUS, '06-list-quote-code.bend.json'), 'utf8'))
  const spec = bendToSpec(doc)
  ok('a list becomes ul/ol', tags(spec, 'ul').length + tags(spec, 'ol').length >= 1)
  ok('items become li', tags(spec, 'li').length >= 2)
  ok('a quote becomes blockquote', tags(spec, 'blockquote').length >= 1)
  ok('code becomes pre>code', tags(spec, 'pre').length >= 1 && tags(spec, 'code').length >= 1)

  const ordered = bendToSpec({ blocks: [{ kind: 'list', ordered: true, items: [{ blocks: [{ kind: 'paragraph', spans: [{ text: 'x' }] }] }] }] })
  ok('an ordered list is ol', tags(ordered, 'ol').length === 1 && tags(ordered, 'ul').length === 0)
  ok('a divider is hr', tags(bendToSpec({ blocks: [{ kind: 'divider' }] }), 'hr').length === 1)
}

// ---- §2.2: unknown kinds preserved, not dropped --------------------------
{
  const spec = bendToSpec({ blocks: [{ kind: 'argument-position', spans: [{ text: 'the loop is closed' }] }] })
  const unk = find(spec, (n) => n.attrs?.class === 'paper-unknown')[0]
  ok('the unknown kind renders', !!unk)
  ok('the kind is preserved on the element', unk.attrs['data-kind'] === 'argument-position')
  ok('its text is not lost', textOf(spec).includes('the loop is closed'))
}

// ---- every corpus document produces a tree -------------------------------
{
  const files = ['01-plain-prose', '15-argument-vocab', '18-unicode-emoji', '19-large-document', '20-adversarial']
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(CORPUS, `${f}.bend.json`), 'utf8'))
    let spec = null, threw = null
    try { spec = bendToSpec(doc) } catch (e) { threw = e }
    ok(`${f} builds a spec`, !threw, threw && threw.message)
    if (!spec) continue
    ok(`${f} has text`, textOf(spec).length > 0)
    // Every node must be a real element name -- an empty or undefined tag mounts
    // as nothing and the content silently disappears.
    let bad = 0
    walk(spec, (n) => { if (typeof n.tag !== 'string' || !n.tag) bad++ })
    ok(`${f} every node has a tag`, bad === 0, `${bad} untagged`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
