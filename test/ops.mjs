// THE SEAM'S TESTS, and in particular the experiment OP_VOCABULARY_DRAFT.md §9
// asked for. Run: `node test/ops.mjs` from RRABBIT/.
//
//   > What would test it: implement drive/park/enter through a seam and check
//   > whether recording, replay, and a hand-written WRL-ish program all drive the
//   > same code path with no per-consumer branching. If any consumer needs a
//   > special case, the seam is wrong.
//
// So §3 below drives an identical sequence three ways and compares the resulting
// world. That is the whole claim, and it is falsifiable here rather than in a
// paragraph.

import { apply, register, reset, log, plan, replay, precheck, opCounts, TABLE } from '../m2/ops.js'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

// A fake world with the same shape the real one has: a current road, a set of
// roads that exist, and at most one pane being read.
function world() {
  return { road: 'home', roads: new Set(['home', 'build', 'watch']), reading: null, moves: [] }
}

// `read` SUPERSEDES rather than refuses -- see §4 for the measurement that forced
// this, which is the sharpest finding in the file.
function wire(w) {
  reset()
  register('drive', {
    pre: (op) => (w.roads.has(op.road) ? true : 'OP_NO_ROAD'),
    perform: (op) => { w.road = op.road; w.moves.push(`drive:${op.road}`) },
  })
  register('read', {
    pre: (op) => (w.roads.has(op.district) ? true : 'OP_NO_ROAD'),
    perform: (op) => {
      const key = `${op.district}:${op.side}:${op.dash}`
      w.reading = key
      w.moves.push(`read:${key}`)
    },
  })
  register('unread', {
    pre: () => true,
    perform: () => { w.reading = null; w.moves.push('unread') },
  })
}

// ---- 1. the table is closed ----------------------------------------------
{
  const w = world(); wire(w)
  ok('an unknown op is refused', apply({ op: 'teleport', to: 'mars' }).why === 'OP_UNKNOWN')
  ok('a non-object is refused', apply('drive').why === 'OP_MALFORMED')
  ok('null is refused', apply(null).why === 'OP_MALFORMED')
  ok('a missing argument is refused', apply({ op: 'drive' }).why === 'OP_MISSING_ARG')
  ok('and it names which one', apply({ op: 'drive' }).detail === 'road')
  ok('registering an op not in the table throws', (() => {
    try { register('fly', { perform: () => {} }); return false } catch { return true }
  })())
  ok('the world was not touched by any refusal', w.moves.length === 0, w.moves.join(','))
}

// ---- 2. preconditions run before effects, and are total ------------------
{
  const w = world(); wire(w)
  const r = apply({ op: 'drive', road: 'nowhere' })
  ok('a false precondition refuses', !r.ok)
  ok('with the precondition\'s own reason', r.why === 'OP_NO_ROAD', r.why)
  ok('and performs nothing', w.road === 'home' && w.moves.length === 0)

  reset()
  register('drive', { pre: () => { throw new Error('boom') }, perform: () => { w.moves.push('should not happen') } })
  const t = apply({ op: 'drive', road: 'home' })
  ok('a throwing precondition refuses rather than propagating', t.why === 'OP_PRECONDITION_THREW')
  ok('and still performs nothing', !w.moves.includes('should not happen'))

  reset()
  register('drive', { perform: () => { throw new Error('kaboom') } })
  ok('a throwing performer is caught', apply({ op: 'drive', road: 'home' }).why === 'OP_THREW')
}

// ---- 3. §9: THREE CONSUMERS, ONE CODE PATH -------------------------------
{
  // The sequence a human drives.
  const wa = world(); wire(wa)
  apply({ op: 'drive', road: 'build' }, { by: 'pointer' })
  apply({ op: 'read', district: 'build', side: 1, dash: 8 }, { by: 'pointer' })
  apply({ op: 'unread' }, { by: 'pointer' })
  apply({ op: 'read', district: 'build', side: -1, dash: 12 }, { by: 'pointer' })
  apply({ op: 'drive', road: 'watch' }, { by: 'pointer' })
  const humanWorld = { road: wa.road, reading: wa.reading, moves: [...wa.moves] }
  const recorded = log()
  const thePlan = plan()

  ok('the log recorded every op', recorded.length === 5, `${recorded.length}`)
  ok('the log knows who sent them', recorded.every((e) => e.by === 'pointer'))
  ok('the log carries relative time', recorded.every((e) => Number.isFinite(e.t)))
  ok('the plan drops the unplannable op', thePlan.length === 4, `${thePlan.length}`)
  ok('and it is `unread` that was dropped', !thePlan.some((e) => e.op === 'unread'))

  // A PROGRAM emits the same ops. No API of its own -- the vocabulary IS the API.
  const wb = world(); wire(wb)
  for (const step of [
    { op: 'drive', road: 'build' },
    { op: 'read', district: 'build', side: 1, dash: 8 },
    { op: 'unread' },
    { op: 'read', district: 'build', side: -1, dash: 12 },
    { op: 'drive', road: 'watch' },
  ]) apply(step, { by: 'program' })
  ok('a program reaches the same world',
    wb.road === humanWorld.road && wb.reading === humanWorld.reading &&
    wb.moves.join(',') === humanWorld.moves.join(','),
    `${wb.moves.join(',')} vs ${humanWorld.moves.join(',')}`)

  // A REPLAY of the recorded PLAN.
  const wc = world(); wire(wc)
  const rep = replay(thePlan, { by: 'replay' })
  ok('the replay ran every planned step', rep.ran === thePlan.length && rep.ok, JSON.stringify(rep.steps.filter((s) => !s.ok)))
  ok('and reaches the same final road', wc.road === humanWorld.road, `${wc.road} vs ${humanWorld.road}`)
  ok('AND THE SAME PANE IS OPEN', wc.reading === humanWorld.reading, `${wc.reading} vs ${humanWorld.reading}`)

  // The claim, stated as an assertion: no consumer needed a special case.
  ok('§9: three consumers, one code path — same world from all three',
    wb.reading === humanWorld.reading && wc.reading === humanWorld.reading &&
    wb.road === humanWorld.road && wc.road === humanWorld.road)

  // A replay must not record itself, or watching one doubles the log.
  const before = opCounts().length
  const wd = world(); wire(wd)
  replay(thePlan, { by: 'replay' })
  ok('a replay does not record itself', opCounts().length === 0, `${opCounts().length}`)
  ok('(the log was reset by wire, so `before` is only a sanity check)', before >= 0)
}

// ---- 4. THE FINDING: the plan/log split is only safe when the dropped op --
// ----    is IMPLIED by its successor ---------------------------------------
{
  // The draft (§5) drops `out` from the plan because "replaying it is a no-op the
  // driver already performs". That reasoning is sound ONLY when the next op
  // implies the dropped one. Here is the same situation with the implication
  // removed: a `read` that REFUSES while another pane is open.
  const w = world()
  reset()
  register('drive', { pre: () => true, perform: (op) => { w.road = op.road } })
  register('read', {
    // The refusing variant -- the one PAPER_ROADS.md §5 originally specified as a
    // hard refusal ("a pane MUST NOT be promoted to read tier while another is").
    pre: () => (w.reading ? 'OP_ALREADY_READING' : true),
    perform: (op) => { w.reading = `${op.district}:${op.side}:${op.dash}` },
  })
  register('unread', { pre: () => true, perform: () => { w.reading = null } })

  apply({ op: 'read', district: 'home', side: 1, dash: 8 }, { by: 'pointer' })
  apply({ op: 'unread' }, { by: 'pointer' })
  apply({ op: 'read', district: 'home', side: -1, dash: 12 }, { by: 'pointer' })
  ok('the human sequence succeeds', w.reading === 'home:-1:12', String(w.reading))

  const p = plan()
  w.reading = null
  const rep = replay(p, { by: 'replay' })
  ok('and REPLAYING ITS PLAN FAILS', !rep.ok)
  ok('on the second read, refused as already-reading',
    rep.steps.find((s) => !s.ok)?.why === 'OP_ALREADY_READING',
    JSON.stringify(rep.steps))

  // Which is why the shipped `read` supersedes instead. Same sequence, superseding
  // performer, and the replay survives.
  const w2 = world(); wire(w2)
  apply({ op: 'read', district: 'home', side: 1, dash: 8 }, { by: 'pointer' })
  apply({ op: 'unread' }, { by: 'pointer' })
  apply({ op: 'read', district: 'home', side: -1, dash: 12 }, { by: 'pointer' })
  const p2 = plan()
  const w3 = world(); wire(w3)
  ok('a superseding read replays cleanly', replay(p2, { by: 'replay' }).ok)
  ok('and lands on the right pane', w3.reading === 'home:-1:12', String(w3.reading))
}

// ---- 5. precheck: roads before anything moves ----------------------------
{
  const w = world(); wire(w)
  const good = [{ op: 'drive', road: 'build' }, { op: 'drive', road: 'watch' }]
  ok('a good plan prechecks', precheck(good).ok)
  ok('and precheck moves nothing', w.moves.length === 0)

  const bad = [{ op: 'drive', road: 'build' }, { op: 'drive', road: 'gone' }, { op: 'drive', road: 'home' }]
  const r = precheck(bad)
  ok('a plan with a dead road is refused', !r.ok)
  ok('and names the failing index', r.i === 1, String(r.i))
  ok('and the reason', r.why === 'OP_NO_ROAD', r.why)
  ok('NOTHING RAN -- the first step was never taken', w.moves.length === 0, w.moves.join(','))

  ok('an unknown op in a plan is caught', precheck([{ op: 'warp' }]).why === 'OP_UNKNOWN')
  ok('a missing arg in a plan is caught', precheck([{ op: 'drive' }]).why === 'OP_MISSING_ARG')
}

// ---- 6. the seam never branches on WHO -----------------------------------
{
  // Mechanical: apply the same op under many actor names and assert the effect is
  // byte-identical. If the seam ever grows a branch on `by`, this fails.
  const results = []
  for (const by of ['pointer', 'replay', 'program', 'agent', 'unknown', '']) {
    const w = world(); wire(w)
    apply({ op: 'read', district: 'build', side: 1, dash: 9 }, { by })
    results.push(`${w.road}|${w.reading}|${w.moves.join(',')}`)
  }
  ok('the actor changes nothing about the effect', new Set(results).size === 1, [...new Set(results)].join(' ≠ '))

  // But it IS recorded, because a log you cannot attribute is a log you cannot audit.
  const w = world(); wire(w)
  apply({ op: 'drive', road: 'build' }, { by: 'agent' })
  ok('the actor is on the entry', log()[0].by === 'agent')
  ok('and counted', opCounts().byActor.agent === 1)
}

// ---- 7. refusals do not enter the log ------------------------------------
{
  const w = world(); wire(w)
  apply({ op: 'drive', road: 'build' }, { by: 'pointer' })
  apply({ op: 'drive', road: 'nowhere' }, { by: 'pointer' })
  apply({ op: 'warp', to: 'x' }, { by: 'pointer' })
  ok('only the applied op is logged', log().length === 1, `${log().length}`)
  ok('refusals are counted separately', opCounts().refused === 2, `${opCounts().refused}`)
  ok('applied is counted', opCounts().applied === 1)
  // A log containing ops that never happened would replay a world that never was.
  // The plan is captured BEFORE re-wiring, because `wire` resets the seam and
  // therefore the log -- reading it afterwards replays an empty plan and passes
  // for the wrong reason.
  const captured = plan()
  ok('the plan holds only the applied op', captured.length === 1, `${captured.length}`)
  const w2 = world(); wire(w2)
  replay(captured, { by: 'replay' })
  ok('the log replays to the same place', w2.road === 'build', w2.road)
  ok('and not to the refused one', w2.road !== 'nowhere')
}

// ---- 8. the table is the vocabulary --------------------------------------
{
  // Pinned deliberately. The whole claim is that this set is CLOSED, so a change
  // to it should break a test and be argued for -- not slip in because a feature
  // needed a verb. That is the discipline OP_VOCABULARY_DRAFT.md §8.1 is asking to
  // be ruled on, enforced here in the meantime.
  // WENT 4 -> 7 when panes got the chrome a window has (close, resize, cast). The
  // pin fired, which is the point of pinning it: three verbs arrived because a
  // feature needed them, and that is exactly the accretion §8.1 is asking whether
  // to forbid. They are here because the alternative was a pane whose close button
  // reached past the vocabulary and mutated the world directly -- which would have
  // made the log wrong rather than the table long.
  // WENT 7 -> 13 for the driverside mailbox. The pin fired again, and the same
  // argument applies with one addition worth recording: `reply` and `ack` are in
  // the table because they are the two acts that CROSS A BOUNDARY -- a human
  // answering an agent, and a human taking responsibility for having read
  // something. Core 0.2.1 §6 makes replay of a wall-clock answer possible only if
  // the recording carries the answer, so a reply that reached past the seam would
  // not merely make the log wrong; it would make a replayed session diverge at
  // the first question an agent asked. That is the strongest case any verb here
  // has had for existing.
  //
  // Six is a lot at once. If §8.1 comes back "the vocabulary is closed at N", the
  // mailbox ops are the first place to look, and `rest`/`wake` are the most
  // droppable of them -- they set a two-valued status and nothing depends on
  // their being separate verbs.
  ok('the table is exactly the thirteen ops built so far',
    Object.keys(TABLE).sort().join(',') === 'ack,cast,close,drive,mail,park,read,reply,resize,rest,unmail,unread,wake',
    Object.keys(TABLE).join(','))
  ok('two are the draft\'s own nav verbs', ['drive', 'park'].every((k) => k in TABLE))
  ok('five are pane verbs, none of them in the draft\'s sixteen',
    ['read', 'unread', 'close', 'resize', 'cast'].every((k) => k in TABLE))
  ok('six are driverside-mailbox verbs, none of them in the draft\'s sixteen either',
    ['mail', 'unmail', 'ack', 'reply', 'rest', 'wake'].every((k) => k in TABLE))
  // `unread` and `unmail` are the only two that are not plannable, and §4 above is
  // why: both are leaving something, which a driver does anyway on the way to the
  // next step. Every other verb changes what a replay would see.
  ok('exactly two ops are unplannable',
    Object.values(TABLE).filter((t) => !t.plan).length === 2)
  ok('...and they are the two "leave it" verbs',
    Object.entries(TABLE).filter(([, t]) => !t.plan).map(([k]) => k).sort().join(',') === 'unmail,unread')
  ok('every op declares its args', Object.values(TABLE).every((t) => Array.isArray(t.args)))
  ok('every op declares whether it is plannable', Object.values(TABLE).every((t) => typeof t.plan === 'boolean'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
