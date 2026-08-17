// PUBLISHING A TRACK -- the rung the ladder exists for, and the one that has been
// missing. A track can be recorded, refused and replayed on this machine, and
// until now there has been no way to hand one to anybody.
//
// THE ADDRESS IS THE HASH OF THE BUNDLE, AND THE GUARD IS INSIDE THE BUNDLE.
// That sentence is the whole design. A published track arrives from a stranger,
// so the question is not "do I trust them" but "can this have been tampered with
// since it was sealed" -- and if what the track REQUIRES lives inside the bytes
// the id is derived from, then weakening the guard changes the address. You are
// not trusting the sender. You are checking the arithmetic.
//
// This is why `requires` is DERIVED here at seal time rather than accepted as an
// argument: a caller who could pass their own `requires` could pass an empty one.
//
// PUBLIC TRACKS ONLY, v0, deliberately. CONFIDENTIALITY.md rules four classes of
// data and this is class A -- the one with NO confidentiality requirement at all,
// which is precisely why it ships first. Nothing here encrypts anything, and
// nothing here should: a published track is meant to be read.
//
// NOT WIRED INTO THE SHELL YET. Pure functions over plain objects, no imports, no
// DOM, so it can be tested on its own and so adding it cannot disturb a running
// build. The wiring is a separate step and belongs to whoever owns the reel.

// The identity prefix. `sem-` is a WRL world, `scen-`/`replay-` are TRAVIIS rungs,
// and a track is NONE of those -- it is a recording over a LIVE OS world, which is
// a different layer (PUBLISH_PATH.md §3, and the plan's risk R9: conflating the two
// fails quietly). studbook §10.5 asks whether the identity ladder admits a new
// prefix at all, and that is Travis's ruling to make, not a decision to take here.
//
// So `track-` is PROVISIONAL and says so. If §10.5 comes back "no", this constant
// changes and every id changes with it -- which is the honest consequence of
// publishing before the ruling, and the reason nothing is published from it yet.
export const PREFIX = 'track-'

export const BUNDLE_KIND = 'computedriven.track.v1'

// WHAT MAY BE REPLAYED **HERE** AND WHAT MAY BE REPLAYED **THERE** ARE TWO
// QUESTIONS, and this list is the second one.
//
// `ops.js` marks an op `plan: true` when it belongs in a plan at all — replayable,
// on this machine, by the person who recorded it. This list is the **publish
// boundary**: what may cross into a stranger's world. It is a SUBSET, and it is
// used in both directions — `seal` drops everything outside it on the way out,
// and `check` refuses everything outside it on the way in.
//
// The two were briefly held to be the same list, asserted as an equality, and the
// assertion went red the moment the mailbox ops arrived. Syncing the list would
// have made the test green and shipped `ack` and `reply` across a machine
// boundary, which is the thing the test was there to prevent it doing quietly.
// Duplicated as data rather than imported so this module stays dependency-free.
export const PLANNABLE = ['drive', 'park', 'read', 'close', 'resize', 'cast', 'mail']

// PLANNABLE HERE, REFUSED AT THE BOUNDARY — each with its reason, because a
// considered exclusion and a forgotten one look identical in a list. Every op
// `ops.js` marks plannable must appear in exactly one of these two, which is what
// keeps the duplication from rotting: a new plannable op fails `test/publish.mjs`
// until somebody classifies it.
//
// One thread runs through all four: **they write to the recipient's own
// correspondence or their agents.** `ops.js`'s arguments for marking them
// plannable are sound and are all arguments about the same machine.
export const WITHHELD = {
  // `ops.js`: "ACK IS PLANNABLE **BECAUSE** IT IS IDEMPOTENT." True, and it is an
  // argument about REPETITION, not about WHOSE INBOX. A `Math.max` high-water mark
  // replayed twice lands in the same place; replayed against a different inbox it
  // marks a stranger's mail read, once, and there is no un-read.
  ack: 'marks the recipient’s own mail read; idempotent is not the same as harmless',
  // `ops.js`: in the plan so a replay does not diverge at the first question the
  // agent asked. That argues for the recording CARRYING the answer, not for
  // posting it as somebody else. `reply()` returns `signed: false` because the
  // principal question is unruled (Core 0.2.1 §16.2) — and a machine boundary is
  // the worst possible place to answer an unruled question by default.
  reply: 'posts the author’s words into the recipient’s queue as the recipient, unsigned',
  // §24.2's own two words, against an agent that is not the author's.
  rest: 'parks an agent belonging to the recipient',
  wake: 'wakes an agent belonging to the recipient',
}

// Refusals are typed and named, never booleans -- the shell's existing discipline
// (TRACK_ROAD_GONE and friends), continued. A caller must be able to tell "this is
// not a bundle" from "this bundle is fine and your world moved", because the first
// is the sender's problem and the second is yours.
export const REFUSE = {
  MALFORMED: 'TRACK_BUNDLE_MALFORMED',
  VERSION: 'TRACK_BUNDLE_VERSION',
  ID_MISMATCH: 'TRACK_BUNDLE_ID_MISMATCH',
  EMPTY: 'TRACK_EMPTY',
  ROAD_GONE: 'TRACK_ROAD_GONE',
  OP_UNKNOWN: 'OP_UNKNOWN',
  // A VERB WE KNOW AND WILL NOT RUN FOR A STRANGER, which is not the same answer
  // as a verb we have never heard of. `OP_UNKNOWN` says "your build is newer than
  // mine"; this says "your build is the same as mine and the answer is still no".
  // Conflating them would make a deliberate refusal read as a version skew, and
  // the obvious repair for a version skew is to upgrade and try again.
  OP_WITHHELD: 'OP_WITHHELD',
}

const bad = (why, detail = null) => ({ ok: false, why, detail })

// CANONICAL BYTES, or the address is a lottery.
//
// Two bundles that mean the same thing must hash the same, so key order cannot be
// whatever the engine happened to produce. Keys are sorted at every level and
// there is no whitespace. Undefined-valued keys are DROPPED rather than serialised
// as null -- that matches `JSON.stringify` semantics, and getting it wrong is a
// real bug with a known history: Workbench's canonicalizer used to throw on
// exactly this input.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

async function sha256Hex(bytes) {
  // `crypto.subtle` rather than node:crypto, because this has to run in the shell
  // (a browser) as well as in the test runner, and Node has exposed the same API
  // on the global since 18. One implementation, two hosts.
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// WHAT THE TRACK NEEDS IN ORDER TO RUN, read off the steps themselves.
//
// Derived, never declared. This is the same argument the WRLM D' host makes about
// model output -- "the ops are derived, not generated" -- applied one layer down:
// a `requires` somebody hands you is a claim, and a `requires` computed from the
// steps is a fact about them.
export function requirementsOf(steps) {
  const roads = new Set()
  const ops = new Set()
  for (const s of steps) {
    ops.add(s.op)
    // `road` names a road directly; `district` is the road a pane stands on. Both
    // are things that must still exist on the machine replaying this.
    if (typeof s.road === 'string') roads.add(s.road)
    if (typeof s.district === 'string') roads.add(s.district)
  }
  return { roads: [...roads].sort(), ops: [...ops].sort() }
}

// Turn a live track into something that can be handed over.
//
// `track` is the shape tracks.js persists: { id, name, rec, recCut, ... }.
// `recCut` is carried into the bundle ON PURPOSE. It counts what fell off the
// front of a capped recording, and a replay that does not know it is holding a
// tail would claim to be the whole drive. The shell already refuses to lose that
// number quietly; publishing must not be where it gets dropped.
export async function seal(track, { engine = 'unknown' } = {}) {
  if (!track || typeof track !== 'object' || !Array.isArray(track.rec)) {
    return bad(REFUSE.MALFORMED, 'not a track')
  }

  const steps = track.rec
    .filter((s) => s && typeof s.k === 'string' && PLANNABLE.includes(s.k))
    .map(({ t, k, ...args }) => ({ t, op: k, ...args }))

  if (!steps.length) return bad(REFUSE.EMPTY, 'no replayable steps')

  const bundle = {
    kind: BUNDLE_KIND,
    v: 1,
    steps,
    requires: requirementsOf(steps),
    provenance: {
      engine,
      name: typeof track.name === 'string' && track.name ? track.name : '',
      steps: steps.length,
      // Not the wall-clock hour. tracks.js already decided a recording is about a
      // drive and not about the afternoon it happened in; the same holds here, and
      // it keeps a published track from carrying a timestamp nobody asked for.
      spanMs: steps.length ? steps[steps.length - 1].t - steps[0].t : 0,
      truncated: Number.isInteger(track.recCut) ? track.recCut : 0,
    },
  }

  const bytes = new TextEncoder().encode(canonical(bundle))
  return { ok: true, id: PREFIX + (await sha256Hex(bytes)), bytes, bundle }
}

// Read a bundle somebody else sealed, and re-derive its id from its own bytes
// before believing a word of it. This is the only place trust enters, and it
// does not: an id that does not match the content is refused by name.
export async function open(bytes, expectedId = null) {
  let text
  try {
    text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  } catch {
    return bad(REFUSE.MALFORMED, 'undecodable')
  }

  let bundle
  try {
    bundle = JSON.parse(text)
  } catch {
    return bad(REFUSE.MALFORMED, 'not json')
  }

  if (!bundle || typeof bundle !== 'object' || bundle.kind !== BUNDLE_KIND) {
    return bad(REFUSE.MALFORMED, 'wrong kind')
  }
  if (bundle.v !== 1) return bad(REFUSE.VERSION, String(bundle.v))
  if (!Array.isArray(bundle.steps) || !bundle.steps.length) return bad(REFUSE.EMPTY)
  if (!bundle.requires || typeof bundle.requires !== 'object') {
    return bad(REFUSE.MALFORMED, 'no requires')
  }

  // Re-canonicalise what we parsed rather than hashing the bytes as they arrived.
  // A sender who pads or reorders keys produces the same MEANING and must produce
  // the same id -- and one who changed a step produces a different id and is
  // caught. Hashing the raw bytes would make whitespace part of the identity.
  const id = PREFIX + (await sha256Hex(new TextEncoder().encode(canonical(bundle))))
  if (expectedId && expectedId !== id) return bad(REFUSE.ID_MISMATCH, id)

  // THE GUARD CANNOT HAVE BEEN WEAKENED, and this is why the whole thing works:
  // `requires` is derivable from `steps`, both are inside the hash, so a bundle
  // whose stated requirements do not match its own steps is not a bundle somebody
  // edited successfully -- it is one whose id no longer matches. Checked anyway,
  // because a mismatch here means the sealer and the opener disagree, and that is
  // a HOST fault worth surfacing rather than a tampering attempt.
  const derived = requirementsOf(bundle.steps)
  const stated = bundle.requires
  const same =
    JSON.stringify(derived.roads) === JSON.stringify(stated.roads ?? []) &&
    JSON.stringify(derived.ops) === JSON.stringify(stated.ops ?? [])
  if (!same) return bad(REFUSE.MALFORMED, 'requires does not match steps')

  return { ok: true, id, bundle }
}

// Can this machine run it? Roads before anything moves -- the same two-phase split
// replay already makes, and for the same reason: a route whose third step names a
// road that is gone must never take the first.
//
// `hasRoad` and `knownOps` are passed in rather than imported so this stays pure
// and so a caller can ask the question about a world it is not standing in.
export function check(bundle, { hasRoad, knownOps = PLANNABLE } = {}) {
  const req = bundle?.requires
  if (!req) return bad(REFUSE.MALFORMED, 'no requires')

  for (const op of req.ops ?? []) {
    // Withheld is asked FIRST, and only when the caller has not substituted its
    // own `knownOps` -- a caller that passed a list has answered this question
    // itself. A bundle carrying `ack` is not a bundle from the future.
    if (knownOps === PLANNABLE && Object.hasOwn(WITHHELD, op)) {
      return bad(REFUSE.OP_WITHHELD, `${op}: ${WITHHELD[op]}`)
    }
    if (!knownOps.includes(op)) return bad(REFUSE.OP_UNKNOWN, op)
  }
  for (const road of req.roads ?? []) {
    if (!hasRoad(road)) return bad(REFUSE.ROAD_GONE, road)
  }
  return { ok: true }
}
