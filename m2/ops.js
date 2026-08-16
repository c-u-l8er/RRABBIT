// THE SEAM. One function every actor passes through to change the world.
//
// ============================================================================
// THIS DOES NOT RATIFY THE OP VOCABULARY. docs/OP_VOCABULARY_DRAFT.md §8 lists
// five things that are [TRAVIS] decisions and none of them are answered here.
// What this file is, is the EXPERIMENT that draft's §9 asked for:
//
//   > proposed -- that a closed op vocabulary applied through one seam is what
//   > makes tracks generalizable to WRL. What would test it: implement
//   > drive/park/enter through a seam and check whether recording, replay, and a
//   > hand-written WRL-ish program all drive the same code path with no
//   > per-consumer branching. IF ANY CONSUMER NEEDS A SPECIAL CASE, THE SEAM IS
//   > WRONG.
//
// Rung 6 forced the issue: the moment a pane accepts a click, that click either
// passes the same seam a recorded op does or the recorder acquires a second
// vocabulary -- which is precisely the accretion §0 of the draft exists to stop.
// So the seam is built with the smallest set rung 6 needs, and §16 of
// PAPER_ROADS.md reports whether it held. The finding is the deliverable; the
// vocabulary is still yours to rule on.
// ============================================================================
//
// THE TABLE IS CLOSED; THE IMPLEMENTATIONS ARE INJECTED. `TABLE` names every op
// that exists and the shape of its arguments. `register` supplies the doing. That
// split is not ceremony -- it is what lets `node` test the seam's behaviour
// (validation, refusal, logging, replay) against fake performers, on a host that
// cannot open a GL context. A seam whose only test is a screenshot is a seam
// nobody will refactor.
//
// REFUSALS ARE `OP_*`. studbook §7.5: a caller should be able to tell WHICH LAYER
// refused. `TRACK_*` is the track layer saying a step cannot be taken; `OP_*` is
// the seam saying an op is malformed or its precondition is false. Collapsing them
// would make "this recording is stale" and "this program is wrong" the same error.

// Every op there is. Adding a name here is the decision the draft reserves; adding
// one anywhere else is impossible, which is the point.
//
// `args` is positional-by-name and is validated before anything runs. `plan` marks
// whether the op belongs in a REPLAY PLAN as well as in the log -- see §5 of the
// draft, which already found this distinction for `out`.
export const TABLE = {
  // --- navigation (existing verbs, routed here to test the seam) ---
  drive: { args: ['road'], plan: true },
  park: { args: ['road', 'z'], plan: true },
  // --- panes (rung 6; PROPOSED, not in the draft's sixteen) ---
  read: { args: ['district', 'side', 'dash'], plan: true },
  unread: { args: [], plan: false },
  // `answer` is OPTIONAL and deliberately not in `args`: absent it is the press on
  // `X--`, which asks and can only unask, and `'close'` from the `close--X` target
  // is the only thing that destroys a pane. A plan that means to close one
  // therefore carries the answer -- see paper.js for why `X--` may not be the yes.
  close: { args: ['district', 'side', 'dash'], plan: true },
  resize: { args: ['district', 'side', 'dash', 'w'], plan: true },
  cast: { args: ['district', 'side', 'dash'], plan: true },
  // --- driverside mailboxes (PROPOSED, not in the draft's sixteen) ------------
  //
  // Adding names here is the decision §8 reserves, and these six are added
  // knowingly rather than by drift. The rung-6 argument forces it: the moment a
  // mailbox accepts a click, that click either passes this seam or the recorder
  // acquires a second vocabulary. `m2/mail/box.js` is the world they act on.
  //
  // `mail`/`unmail` mirror `read`/`unread` exactly, including the plan split --
  // opening a box is worth replaying, leaving one is a no-op the driver performs
  // anyway.
  mail: { args: ['district', 'side', 'dash'], plan: true },
  unmail: { args: [], plan: false },
  // ACK IS PLANNABLE **BECAUSE** IT IS IDEMPOTENT. The high-water mark is a
  // `Math.max`, so replaying an ack twice lands in the same place -- which is
  // what makes it safe to put in a plan at all. An ack implemented as a set of
  // read ids would not be, and that is a second reason the mark is a mark.
  ack: { args: ['district', 'side', 'dash', 'seq'], plan: true },
  // REPLY IS PLANNABLE, and this one is a real decision rather than a default.
  // A reply is the driver's answer crossing a boundary, and Core 0.2.1 §6 is why
  // it must be in the plan: wall-clock answers are replayable only if the
  // recording feeds the recorded answer back. Dropping it would make a replayed
  // session diverge at the first question the agent asked.
  reply: { args: ['district', 'side', 'dash', 'text'], plan: true },
  // Park and wake an agent. WRL.md §24.2's own two words, and the status names
  // they set are Core §20.1's `quiescent`/`runnable` -- see m2/mail/box.js.
  rest: { args: ['district', 'side', 'dash'], plan: true },
  wake: { args: ['district', 'side', 'dash'], plan: true },
}

const performers = new Map()
const preconditions = new Map()

export function register(name, { perform, pre = null } = {}) {
  if (!Object.hasOwn(TABLE, name)) throw new Error(`OP_UNKNOWN:${name}`)
  performers.set(name, perform)
  if (pre) preconditions.set(name, pre)
}

export function reset() {
  performers.clear()
  preconditions.clear()
  entries.length = 0
  counts.applied = 0
  counts.refused = 0
  counts.byOp = {}
  counts.byActor = {}
}

// THE LOG IS THE TRACK. Not a parallel structure the recorder has to remember to
// write -- the seam writes it because everything passed through the seam. That is
// the whole argument of the draft's §1, and the reason the current recorder is
// missing eleven verbs is that each one has to be remembered by hand today.
const entries = []
const REC_MAX = 4096
const counts = { applied: 0, refused: 0, cut: 0, byOp: {}, byActor: {} }

let t0 = null
const now = () => {
  const t = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (t0 == null) t0 = t
  return Math.round(t - t0)
}

function record(op, by) {
  entries.push({ ...op, t: now(), by })
  if (entries.length > REC_MAX) { entries.shift(); counts.cut++ }
}

function bad(why, detail) {
  counts.refused++
  return { ok: false, why, detail: detail ?? null }
}

// Apply one op. The ONLY way the world changes through this vocabulary.
//
// `by` says which actor sent it -- a human's pointer, a replay, a program, an
// agent. It is recorded and it is NEVER consulted: the moment the seam branches on
// who is calling, the claim that every consumer drives the same code path is false
// by construction. It exists so the log can be read, not so the behaviour can differ.
export function apply(op, { by = 'unknown', record: shouldRecord = true } = {}) {
  if (!op || typeof op !== 'object') return bad('OP_MALFORMED', 'not an object')
  const name = op.op
  if (typeof name !== 'string' || !Object.hasOwn(TABLE, name)) return bad('OP_UNKNOWN', String(name))

  const spec = TABLE[name]
  for (const a of spec.args) {
    if (op[a] === undefined || op[a] === null) return bad('OP_MISSING_ARG', a)
  }

  const perform = performers.get(name)
  if (!perform) return bad('OP_NOT_REGISTERED', name)

  // PRECONDITION BEFORE EFFECT, always, and total: a precondition that throws is
  // not a guard (draft §4). A thrown precondition is reported as a refusal rather
  // than propagating, because a program that crashes the shell is a worse outcome
  // than a program that is told no.
  const pre = preconditions.get(name)
  if (pre) {
    let okPre
    try { okPre = pre(op) } catch (e) { return bad('OP_PRECONDITION_THREW', String(e?.message ?? e)) }
    if (okPre !== true) return bad(typeof okPre === 'string' ? okPre : 'OP_PRECONDITION_FALSE', name)
  }

  let result
  try { result = perform(op) } catch (e) { return bad('OP_THREW', String(e?.message ?? e)) }
  if (result && result.ok === false) return bad(result.why ?? 'OP_REFUSED', result.detail ?? null)

  counts.applied++
  counts.byOp[name] = (counts.byOp[name] ?? 0) + 1
  counts.byActor[by] = (counts.byActor[by] ?? 0) + 1
  if (shouldRecord) record(op, by)
  return { ok: true, op: name, result: result ?? null }
}

// The log, and the PLAN derived from it. Two different things, and the draft
// already found the distinction for `out`: leaving a window is real and worth
// logging, but replaying it is a no-op the driver performs anyway.
export const log = () => entries.map((e) => ({ ...e }))
export const plan = () => entries.filter((e) => TABLE[e.op]?.plan).map((e) => ({ ...e }))
export const opCounts = () => ({ ...counts, byOp: { ...counts.byOp }, byActor: { ...counts.byActor }, length: entries.length })

// Feed a plan back through the seam. NOT a second code path -- this is a `for`
// loop over `apply`, which is the strongest form the §9 claim can take: if replay
// needed anything `apply` does not already do, it would show up right here as a
// branch.
//
// Recording is off during replay for the same reason `goingBack` exists in
// travel.js: a replay that recorded itself would double the log every time you
// watched one.
export function replay(steps, { by = 'replay', onStep = null, stopOnRefusal = true } = {}) {
  const out = []
  for (let i = 0; i < steps.length; i++) {
    const r = apply(steps[i], { by, record: false })
    out.push({ i, op: steps[i].op, ...r })
    onStep?.(i, steps[i], r)
    if (!r.ok && stopOnRefusal) break
  }
  return { steps: out, ok: out.every((s) => s.ok), ran: out.length }
}

// Check a plan WITHOUT performing it. The draft's §2 split -- roads before
// anything moves -- expressed against the seam instead of by hand in `checkStep`.
// A route whose third step names a deleted road never takes the first.
export function precheck(steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (!s || typeof s !== 'object' || !Object.hasOwn(TABLE, s.op)) return { ok: false, i, why: 'OP_UNKNOWN' }
    for (const a of TABLE[s.op].args) if (s[a] == null) return { ok: false, i, why: 'OP_MISSING_ARG', detail: a }
    const pre = preconditions.get(s.op)
    if (!pre) continue
    let okPre
    try { okPre = pre(s) } catch { return { ok: false, i, why: 'OP_PRECONDITION_THREW' } }
    if (okPre !== true) return { ok: false, i, why: typeof okPre === 'string' ? okPre : 'OP_PRECONDITION_FALSE' }
  }
  return { ok: true, i: -1 }
}
