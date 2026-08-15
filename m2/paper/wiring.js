// RUNG 7: A ROAD'S ARRANGEMENT OF PANES, AS A WRL NETWORK.
//
// PAPER_ROADS.md §9 put WRL at the wiring layer and said what the payoff would be:
//
//   > The payoff is not syntax, it is IDENTITY: a road's arrangement of panes
//   > becomes one content address. Two roads that seal to the same id are the same
//   > road.
//
// That is what this emits. A road becomes a WRL Core 0.1.2 program, and
// `WRL/wrl.js` -- the real browser port, not a reimplementation -- seals it to a
// `sem-` SemanticArtifactID. Same arrangement, same id, on any host, forever.
//
// WHAT IS AND IS NOT IN THE ID. The seal is over the road's TOPOLOGY: how many
// panes, in what order, and which of them cite each other. It is deliberately NOT
// a hash of the documents -- BendScript already content-addresses those (§5.1 of
// its spec), and putting a doc hash in here would produce an id that changes when
// a typo is fixed, which is the opposite of what "the same road" should mean.
//
//   what IS in the id: the object roles, the order, the edges between them
//   what is NOT:       document contents, district names, dash numbers, sizes
//
// So two roads carrying different documents in the same shape seal alike. That is
// the honest reading of "the same arrangement", and anyone who wants content in
// the identity should compose the two ids rather than conflate them.
//
// THE IDS ARE ORDINAL, NOT ADDRESSES. `r0`, `r1`, ... and not `home:r:8`. A road
// whose panes sit at different dashes but in the same order is the same
// arrangement; keying on the address would make the id a function of where the
// road happens to start, which no reader would predict.
//
// THE ROLE MAPPING, and why it is forced rather than chosen. WRL's port table
// (`PORTS` in wrl.js) is strict: a SignalWire runs sig_out -> sig_in, a
// SocketControl runs socket -> pose, and only certain roles have each. So:
//
//   the road's ENTRANCE   -> Pulser   (out sig_out, no in -- a thing that starts)
//   each PANE             -> Relay    (in sig_in, out sig_out -- takes and passes)
//   the road's EXIT GATE  -> Door     (in sig_in, no out -- a thing that ends)
//
// A road is exactly a chain from a start, through documents, to an end, and that
// is the one shape those three roles can make. The mapping was not designed; it
// fell out of asking which WRL objects a road's parts could legally be.

// `sealWorld` and NOT parse->ir->id by hand. The three-step form is what the
// module's header documents, and it refuses the sugar WRL's own README and
// conformance fixtures use (`(every 2)` -> WRL_UNKNOWN_CONFIG_KEY). `sealWorld` is
// the entry the conformance suite itself calls, so it is the one that agrees with
// the published ids.
import { sealWorld } from './wrl-core.js'

// A pane's position in road order. Both sides interleaved and sorted by dash,
// which is the order you drive past them -- the same total order `roadOrder` uses
// for windows, and for the same reason: the sides are separate for spacing and
// were never separate for "where am I in the queue".
export function roadPanes(panes, district) {
  return panes
    .filter((p) => p.district === district)
    .sort((a, b) => a.dash - b.dash || a.side - b.side)
}

// Which panes cite which, as indices into the ordered list.
//
// A BendScript edge points at a `bend:` URI. Two panes on this road are linked
// when one document's edge names the other's id -- so the wiring is READ OFF THE
// DOCUMENTS rather than declared separately, which is what makes it a description
// of the road rather than a second thing to keep in sync.
export function citations(ordered) {
  const idOf = (p) => (typeof p.doc?.id === 'string' ? p.doc.id : null)
  const index = new Map()
  ordered.forEach((p, i) => { const id = idOf(p); if (id) index.set(id, i) })

  const out = []
  ordered.forEach((p, i) => {
    for (const e of p.doc?.edges ?? []) {
      const obj = String(e?.object ?? '')
      // `bend:<id>` or `bend:<id>#blk`. The fragment addresses a block inside the
      // document and does not change WHICH document is being cited.
      const m = /^bend:([^#]+)/.exec(obj)
      if (!m) continue
      const j = index.get(m[1])
      // A citation to a document that is not on this road is not an edge in this
      // network -- it is a reference OUT of it, and inventing a wire for it would
      // seal a road to an id that describes a road that does not exist.
      if (j == null || j === i) continue
      out.push([i, j])
    }
  })
  return out
}

// The WRL source for a road. Deterministic: same arrangement in, byte-identical
// text out, which is what makes the seal meaningful.
export function wrlFor(ordered, { citations: cites = null } = {}) {
  const n = ordered.length
  const lines = ['profile forge.world.core.v1', '']

  // The entrance. `mode=periodic` in canonical form rather than the `every 2`
  // sugar: both parse, and the sugar is a surface the seal is meant to be
  // independent of, so emitting the canonical form keeps the generator honest
  // about what it is asserting.
  lines.push('[pulser:p0](mode=periodic, period=2, phase=0){sig_out}')
  for (let i = 0; i < n; i++) lines.push(`[relay:r${i}]{sig_in, sig_out}`)
  lines.push('[door:d0]{sig_in}')
  lines.push('')

  // The road itself: entrance into the first pane, each pane into the next, the
  // last into the exit gate. An empty road is still a road you can drive: the
  // pulser wires straight to the door.
  if (n === 0) {
    lines.push('[pulser:p0] --sig--> [door:d0]')
  } else {
    lines.push('[pulser:p0] --sig--> [relay:r0]')
    for (let i = 0; i < n - 1; i++) lines.push(`[relay:r${i}] --sig--> [relay:r${i + 1}]`)
    lines.push(`[relay:r${n - 1}] --sig--> [door:d0]`)
  }

  // THE CITATIONS, AND THE CONSTRAINT THAT SHAPES THEM.
  //
  // The obvious encoding -- a second SignalWire from the citing relay into the
  // cited one -- is REFUSED: `WRL_CONTROLLER_CONFLICT`. Measured, not guessed
  // (test/wiring.mjs characterises it). An input in this profile has exactly one
  // controller, and the chain already spends every relay's `sig_in`.
  //
  // Fan-OUT is legal, so a citation is an extra wire out of the citing relay into
  // a Door of its own, named for the pair it records. The Door is a sink: it
  // asserts "r2 cites r5" without claiming anything drives r5. That the encoding
  // was forced by the port table rather than chosen is the useful part -- it is
  // what a network of durable identities can actually say about a road.
  const extra = [...new Set((cites ?? []).map(([a, b]) => `${a}>${b}`))].sort()
  const wires = extra.map((k) => k.split('>'))
  // Declarations first, then wires, so the emitted text keeps one shape.
  const decls = wires.map(([a, b]) => `[door:c${a}_${b}]{sig_in}`)
  const links = wires.map(([a, b]) => `[relay:r${a}] --sig--> [door:c${a}_${b}]`)
  const head = lines.slice(0, lines.indexOf('', 2))
  const tail = lines.slice(lines.indexOf('', 2))
  return [...head, ...decls, ...tail, ...links].join('\n')
}

// Seal a road. Returns the source, the id, and the counts -- the source alongside
// the id on purpose, because an identity you cannot read the input of is a number
// you have to trust rather than check.
export async function sealRoad(panes, district) {
  const ordered = roadPanes(panes, district)
  const cites = citations(ordered)
  const src = wrlFor(ordered, { citations: cites })
  // A road that cannot be sealed is a finding, not a crash. WRL refuses illegal
  // topologies by design, and if this generator ever emits one the refusal is the
  // thing worth reporting -- with the source, so it can be read.
  const r = await sealWorld(src)
  return r.ok
    ? { ok: true, id: r.semanticId, src, panes: ordered.length, citations: cites.length }
    : { ok: false, why: r.code ?? r.message, src, panes: ordered.length }
}
