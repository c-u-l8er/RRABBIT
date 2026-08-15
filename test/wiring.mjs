// RUNG 7: does a road's arrangement seal to an identity?
// Run: `node test/wiring.mjs` from RRABBIT/.
//
// The claim from PAPER_ROADS.md §9 is exactly one sentence -- "two roads that seal
// to the same id are the same road" -- and it is two assertions: same arrangement
// must give the same id, and any change to the arrangement must give a different
// one. A hash that only satisfies the first is a constant.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { roadPanes, citations, wrlFor, sealRoad } from '../m2/paper/wiring.js'
import { sealWorld, DEMO_WORLD, DEMO_WORLD_SEMANTIC_ID } from '../m2/paper/wrl-core.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(here, '..', '..', 'bendscript.com', 'test-corpus', 'v0.1')

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const pane = (district, side, dash, doc = {}) => ({ district, side, dash, doc })

// ---- 0. THE VENDORED SPINE IS THE REAL ONE -------------------------------
{
  // WRL's own demo world, sealed with THIS copy, against the id WRL publishes for
  // it. If this fails, `m2/paper/wrl-core.js` is a stale or damaged copy and every
  // id below is a number nobody else computes.
  //
  // Through `sealWorld`, which is what WRL's own conformance suite calls. The
  // three-step `parseWrlCore -> graphToIr -> semanticArtifactId` form documented in
  // the module header REFUSES the `(every 2)` sugar that WRL's README and its
  // SHUFFLED fixture both use (`WRL_UNKNOWN_CONFIG_KEY`) -- an upstream
  // discrepancy, found here and worth reporting there.
  const r = await sealWorld(DEMO_WORLD)
  ok('the vendored spine seals WRL\'s demo world', r.ok, r.code ?? r.message)
  ok('to the id WRL publishes for it', r.semanticId === DEMO_WORLD_SEMANTIC_ID,
    `got ${r.semanticId}`)
}

// ---- 1. road order is the order you drive past -----------------------------
{
  const panes = [
    pane('home', 1, 16), pane('home', -1, 8), pane('build', 1, 8),
    pane('home', 1, 8), pane('home', -1, 12),
  ]
  const o = roadPanes(panes, 'home')
  ok('only this road', o.length === 4, `${o.length}`)
  ok('sorted by dash, side breaking the tie',
    o.map((p) => `${p.dash}${p.side > 0 ? 'r' : 'l'}`).join(',') === '8l,8r,12l,16r',
    o.map((p) => `${p.dash}${p.side > 0 ? 'r' : 'l'}`).join(','))
  ok('another road is empty here', roadPanes(panes, 'watch').length === 0)
}

// ---- 2. a road seals, and seals the same twice -----------------------------
{
  const panes = [pane('home', 1, 8), pane('home', -1, 12), pane('home', 1, 16)]
  const a = await sealRoad(panes, 'home')
  const b = await sealRoad(panes, 'home')
  ok('a road seals', a.ok, a.why)
  ok('to a sem- id', /^sem-[0-9a-f]{64}$/.test(a.id ?? ''), String(a.id))
  ok('and seals identically twice', a.id === b.id)
  ok('the source is reported with the id', typeof a.src === 'string' && a.src.includes('profile forge.world.core.v1'))
  ok('three panes, three relays', (a.src.match(/\[relay:r\d+\]\{/g) ?? []).length === 3)
}

// ---- 3. THE CLAIM: same arrangement, same id -------------------------------
{
  // Same shape, DIFFERENT district, different dashes, different documents.
  const one = [pane('home', 1, 8), pane('home', -1, 12), pane('home', 1, 16)]
  const two = [pane('watch', -1, 40), pane('watch', 1, 44), pane('watch', -1, 48)]
  const a = await sealRoad(one, 'home')
  const b = await sealRoad(two, 'watch')
  ok('two roads with the same arrangement seal alike', a.id === b.id, `${a.id}\n        ${b.id}`)

  // And the negative, which is the half that makes it a hash rather than a
  // constant. A fourth pane is a different road.
  const three = [...one, pane('home', -1, 20)]
  const c = await sealRoad(three, 'home')
  ok('one more pane is a different road', c.id !== a.id)
  ok('and it still seals', c.ok)

  // A road with one fewer.
  const d = await sealRoad(one.slice(0, 2), 'home')
  ok('one fewer pane is a different road', d.id !== a.id && d.id !== c.id)

  // An EMPTY road is still a road you can drive, and has its own identity.
  const e = await sealRoad([], 'home')
  ok('an empty road seals', e.ok, e.why)
  ok('and is not any of the others', ![a.id, c.id, d.id].includes(e.id))
}

// ---- 4. citations are read off the documents -------------------------------
{
  const docA = { id: 'AAA', edges: [{ subject: 'bend:AAA', predicate: 'cites', object: 'bend:CCC' }] }
  const docB = { id: 'BBB', edges: [] }
  const docC = { id: 'CCC', edges: [] }
  const panes = [pane('home', 1, 8, docA), pane('home', 1, 12, docB), pane('home', 1, 16, docC)]
  const o = roadPanes(panes, 'home')
  const c = citations(o)
  ok('a citation between two panes on this road is an edge', c.length === 1, JSON.stringify(c))
  ok('and it points the right way', c[0][0] === 0 && c[0][1] === 2, JSON.stringify(c))

  // A citation OUT of the road is not an edge in this network.
  const off = [pane('home', 1, 8, { id: 'AAA', edges: [{ object: 'bend:ELSEWHERE' }] })]
  ok('a citation to a document not on this road is dropped', citations(roadPanes(off, 'home')).length === 0)

  // A fragment addresses a block inside a document; it is still that document.
  const frag = [
    pane('home', 1, 8, { id: 'AAA', edges: [{ object: 'bend:CCC#blk-1.spn-2' }] }),
    pane('home', 1, 12, { id: 'CCC', edges: [] }),
  ]
  ok('a fragment reference still names its document', citations(roadPanes(frag, 'home')).length === 1)

  // Self-citation is not a wire.
  const self = [pane('home', 1, 8, { id: 'AAA', edges: [{ object: 'bend:AAA#blk-9' }] })]
  ok('a self-citation is not an edge', citations(roadPanes(self, 'home')).length === 0)

  // A citation CHANGES THE ID -- the wiring is in the identity, not decoration.
  const withCite = await sealRoad(panes, 'home')
  const noCite = await sealRoad(panes.map((p) => ({ ...p, doc: { ...p.doc, edges: [] } })), 'home')
  ok('citations seal', withCite.ok, withCite.why)
  ok('a cited road is not the same road as an uncited one', withCite.id !== noCite.id)
  ok('and the citation count is reported', withCite.citations === 1)
}

// ---- 5. the emitted source is deterministic -------------------------------
{
  const o = roadPanes([pane('home', 1, 8), pane('home', 1, 12), pane('home', 1, 16), pane('home', 1, 20)], 'home')
  // The same links in a different order must emit the same text, or the id is a
  // hash of the order a Map happened to iterate in.
  const s1 = wrlFor(o, { citations: [[0, 2], [1, 3], [0, 3]] })
  const s2 = wrlFor(o, { citations: [[0, 3], [0, 2], [1, 3]] })
  ok('link order does not change the source', s1 === s2)
  const s3 = wrlFor(o, { citations: [[0, 2], [0, 2], [1, 3], [0, 3]] })
  ok('a duplicated link does not change the source', s1 === s3)
  // A chain link must not be emitted twice.
  const s4 = wrlFor(o, { citations: [[0, 1]] })
  ok('a citation the chain already carries is not re-emitted',
    (s4.match(/\[relay:r0\] --sig--> \[relay:r1\]/g) ?? []).length === 1, s4)
}

// ---- 6. a real road, from the real corpus ---------------------------------
{
  const docs = ['01-plain-prose', '06-list-quote-code', '12-all-core-predicates', '17-cross-doc-edges']
    .map((f) => JSON.parse(readFileSync(join(CORPUS, `${f}.bend.json`), 'utf8')))
  const panes = docs.map((d, i) => pane('home', i % 2 ? 1 : -1, 8 + i * 4, d))
  const r = await sealRoad(panes, 'home')
  ok('a road of real documents seals', r.ok, r.why)
  ok('with four relays', r.panes === 4, String(r.panes))
  console.log(`  (a road of 4 corpus documents -> ${r.id})`)

  // REORDERING THESE DOCUMENTS IS THE SAME ROAD, and that is the design rather
  // than a bug. The corpus documents cite `bafyfake...` ids that are not on this
  // road, so there are no intra-road citations -- and with no citations, every
  // four-pane road has the same wiring. The id is over the WIRING; the documents
  // are content-addressed by BendScript and deliberately not in here (see the
  // module header). Asserting the opposite would be asserting a property this
  // design does not have.
  const swapped = [panes[1], panes[0], panes[2], panes[3]].map((p, i) => ({ ...p, dash: 8 + i * 4 }))
  const s = await sealRoad(swapped, 'home')
  ok('with no citations, reordering is the same road', s.id === r.id, `${s.id}`)
  ok('and there were no citations to find', r.citations === 0, String(r.citations))

  // WITH citations it is a different road, because reordering changes WHICH
  // positions cite which. That is the property that makes this an arrangement id
  // and not a count.
  const A = { id: 'AAA', edges: [{ object: 'bend:CCC' }] }
  const B = { id: 'BBB', edges: [] }
  const C = { id: 'CCC', edges: [] }
  const fwd = await sealRoad([pane('home', 1, 8, A), pane('home', 1, 12, B), pane('home', 1, 16, C)], 'home')
  const rev = await sealRoad([pane('home', 1, 8, C), pane('home', 1, 12, B), pane('home', 1, 16, A)], 'home')
  ok('both seal', fwd.ok && rev.ok, `${fwd.why ?? ''} ${rev.why ?? ''}`)
  ok('a cited pair reordered IS a different road', fwd.id !== rev.id, `${fwd.id}`)
  ok('forward cites 0->2', fwd.citations === 1)
  ok('reversed cites 2->0', rev.citations === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
