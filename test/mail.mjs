// THE DRIVERSIDE MAILBOX -- does the queue behave like the algebra it claims?
// Run: `node test/mail.mjs` from RRABBIT/.
//
// The claims worth testing here are not "does it store a message". They are:
//
//   1. the unread badge is a PROJECTION -- it cannot disagree with the list
//   2. acknowledgement is a JOIN-SEMILATTICE -- idempotent, commutative,
//      order-independent, so a replayed log converges (Core 0.2.1 sec.9)
//   3. a bounded queue that drops something SAYS SO (WRL.md sec.25, and
//      reel.js's `recCut` rule)
//   4. the store is never believed
//
// And one characterisation test (sec.0) that pins a limitation rather than a
// behaviour, so that the day the limitation lifts, this file says so.

import {
  emptyState, openBox, closeBox, boxOf, boxesOn, keyOf,
  post, ack, reply, setStatus, page, badge, roadSummary,
  unread, unreadCount, waiting,
  serialize, parse, KINDS, POLICIES, STATUSES, DEFAULT_CAP,
} from '../m2/mail/box.js'
import { parseWrlCore, UNWRITABLE_ROLE_IDS, MAILBOX_ROLE, ROLE_IDS } from '../m2/paper/wrl-core.js'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const mk = (over = {}) => ({ district: 'home', side: 1, dash: 12, agent: 'planner', ...over })

// ---- 0. CHARACTERISATION: the doorbell cannot be sealed yet ------------------
//
// This is not a test of this feature. It is a test of the CONSTRAINT this
// feature was built around, written down so it cannot be forgotten.
//
// Core 0.2.1 promoted Mailbox to the sixth surface-grounded role and closed the
// sec.18 gap ("unwritable_role_ids() empties itself"). The browser spine in
// `m2/paper/wrl-core.js` is Core **0.1.2**, where Mailbox is still unwritable --
// and `WRL/wrl.js` upstream is byte-identical, so this is a version lag, not
// local drift.
//
// Consequence: a mailbox on the verge is NOT in the road's sealed `sem-` id, and
// `m2/paper/wiring.js` is deliberately untouched. When the spine is re-copied
// from an updated `WRL/wrl.js`, THESE TWO ASSERTIONS FAIL, and the failure is the
// instruction: wire the mailbox into `wrlFor` and seal the doorbell.
{
  ok('Mailbox is a registry role', ROLE_IDS.includes(MAILBOX_ROLE))
  ok('...but is UNWRITABLE in the vendored 0.1.2 spine (lift me when the port updates)',
    UNWRITABLE_ROLE_IDS.includes(MAILBOX_ROLE))

  // ASSERT ON THE REASON, NOT ON THE THROW. The first draft of this test used a
  // bare `[pulser:p0]{sig_out}`, which refuses with WRL_CLOCK_RANGE ("a 'periodic'
  // pulser needs 'period'") before the parser ever reaches the `~~` line -- so it
  // passed while measuring nothing. A characterisation test that pins the wrong
  // refusal is worse than none: it would keep passing after the port was updated,
  // which is the one moment it exists to speak up.
  const refusal = (src) => {
    try { parseWrlCore(src) } catch (e) { return `${e.code}: ${e.message}` }
    return 'PARSED'
  }
  // A well-formed pulser, canonical clock config, exactly as wiring.js emits --
  // so the only thing left for the parser to object to is the mailbox.
  const P = '[pulser:p0](mode=periodic, period=2, phase=0){sig_out}'

  const objRefusal = refusal(`profile forge.world.core.v1\n\n[mailbox:m0](w=8, cap=16)\n`)
  ok('the 0.1.2 parser refuses a mailbox OBJECT (lift me when the port updates)',
    objRefusal.includes('WRL_UNSUPPORTED_FEATURE') && objRefusal.includes("role 'mailbox'"), objRefusal)

  const routeRefusal = refusal(`profile forge.world.core.v1\n\n${P}\n[pulser:p0] ~~mail~~> [mailbox:m0] (body=0.0.0.1)\n`)
  ok('the 0.1.2 parser refuses a ~~ ROUTE for being a texture, not for anything else',
    routeRefusal.includes('WRL_UNSUPPORTED_FEATURE') && routeRefusal.includes('route texture'), routeRefusal)

  // The control: the same source WITHOUT the mailbox parts must parse, or the two
  // refusals above are about the scaffolding rather than about the mailbox.
  ok('...and the same world minus the mailbox parses fine (the control)',
    refusal(`profile forge.world.core.v1\n\n${P}\n[door:d0]{sig_in}\n\n[pulser:p0] --sig--> [door:d0]\n`) === 'PARSED')
}

// ---- 1. unread is a projection, not a counter --------------------------------
{
  const s = emptyState()
  const { key } = openBox(s, mk())
  const b = boxOf(s, key)

  ok('a fresh box has nothing unread', unreadCount(b) === 0)

  post(s, key, { kind: 'note', subject: 'started' })
  post(s, key, { kind: 'ask', subject: 'which branch?' })
  post(s, key, { kind: 'note', subject: 'waiting' })

  ok('three posted, three unread', unreadCount(b) === 3)
  // The projection cannot disagree with the list because it IS the list.
  ok('unread is a slice of msgs', unread(b).every((m) => b.msgs.includes(m)))
  ok('only the ask is waiting on the driver', waiting(b).length === 1)
  ok('...and it is the right one', waiting(b)[0].subject === 'which branch?')

  const second = b.msgs[1].seq
  ack(s, key, second)
  ok('acking through #2 leaves one unread', unreadCount(b) === 1)
  ok('and nothing waiting', waiting(b).length === 0)

  // The badge is derived from the same projection, so it cannot drift.
  ok('badge agrees with the projection', badge(b).unread === unreadCount(b))
}

// ---- 2. acknowledgement is a join-semilattice --------------------------------
//
// Core 0.2.1 sec.9 freezes fact merge as a union that is commutative,
// associative and idempotent. The high-water mark is `Math.max`, which is exactly
// that -- so a replayed or reordered log has to converge.
{
  const s = emptyState()
  const { key } = openBox(s, mk())
  const b = boxOf(s, key)
  for (let i = 0; i < 6; i++) post(s, key, { kind: 'note', subject: `m${i}` })

  ack(s, key, 4)
  const afterFirst = b.acked
  ack(s, key, 4)
  ok('idempotent: acking the same seq twice changes nothing', b.acked === afterFirst)

  const r = ack(s, key, 2)
  ok('monotone: an OLDER ack cannot walk the mark back', b.acked === afterFirst)
  ok('...and reports that it did not move', r.moved === false)

  // Order independence, checked by running the same acks two different ways and
  // comparing -- not by asserting Math.max works, which would be a test of
  // JavaScript.
  const run = (order) => {
    const t = emptyState()
    const { key: k } = openBox(t, mk())
    for (let i = 0; i < 6; i++) post(t, k, { kind: 'note', subject: `m${i}` })
    for (const q of order) ack(t, k, q)
    return boxOf(t, k).acked
  }
  ok('commutative: [1,5,3] and [3,1,5] converge', run([1, 5, 3]) === run([3, 1, 5]))
  ok('...and both land on the max', run([1, 5, 3]) === 5)

  // Every ack that MOVED the mark is recorded as a boundary fact -- otherwise
  // "who took responsibility for having seen this" is unanswerable.
  const acks = b.out.filter((f) => f.kind === 'ack')
  ok('a moving ack is recorded as a fact', acks.length === 1)
  ok('...and a non-moving one is not', acks.every((f) => f.seq === afterFirst))
}

// ---- 3. a bounded queue admits what it dropped -------------------------------
{
  const s = emptyState()
  const { key } = openBox(s, mk({ cap: 3, policy: 'shed_oldest' }))
  const b = boxOf(s, key)
  for (let i = 0; i < 5; i++) post(s, key, { kind: 'note', subject: `m${i}` })

  ok('the queue is bounded', b.msgs.length === 3)
  ok('and it counts what it shed', b.cut === 2)
  // The one that matters: it shed two UNREAD messages and says so separately.
  // "3 messages, 2 unread" would be a true sentence describing a lie.
  ok('shedding UNREAD messages is counted apart', b.lostUnread === 2)
  ok('the page carries the cut so it cannot be drawn without it', page(s, key).cut === 2)

  const t = emptyState()
  const { key: k2 } = openBox(t, mk({ cap: 2, policy: 'reject' }))
  post(t, k2, { kind: 'note', subject: 'a' })
  post(t, k2, { kind: 'note', subject: 'b' })
  const refused = post(t, k2, { kind: 'note', subject: 'c' })
  ok('reject refuses the append', refused.ok === false && refused.why === 'MAIL_BOX_FULL')
  ok('...tells the sender the bound', refused.cap === 2)
  ok('...and RECORDS the refusal (WRL.md sec.25)', boxOf(t, k2).refused === 1)
  ok('...without losing anything', boxOf(t, k2).msgs.length === 2)
}

// ---- 4. seq is global across boxes -------------------------------------------
//
// Two agents that both spoke are two events in one history. A per-box counter
// cannot answer "which came first", which is the question a driver reading two
// boxes is actually asking.
{
  const s = emptyState()
  const { key: a } = openBox(s, mk({ dash: 8, agent: 'planner' }))
  const { key: b } = openBox(s, mk({ dash: 16, agent: 'builder' }))
  post(s, a, { kind: 'note', subject: 'a1' })
  post(s, b, { kind: 'note', subject: 'b1' })
  post(s, a, { kind: 'note', subject: 'a2' })
  const seqs = [...boxOf(s, a).msgs, ...boxOf(s, b).msgs].map((m) => m.seq).sort((x, y) => x - y)
  ok('seq is unique across boxes', new Set(seqs).size === seqs.length)
  ok('and orders the two histories together', boxOf(s, b).msgs[0].seq === 2)
}

// ---- 5. control, in the frozen vocabulary ------------------------------------
{
  const s = emptyState()
  const { key } = openBox(s, mk())
  ok('an agent starts runnable', boxOf(s, key).status === 'runnable')
  ok('the status names are WRL\'s two', STATUSES.join(',') === 'runnable,quiescent')

  setStatus(s, key, 'quiescent', { by: 'driver' })
  ok('parking an agent is quiescent', boxOf(s, key).status === 'quiescent')
  ok('...recorded as a fact', boxOf(s, key).out.some((f) => f.kind === 'status' && f.status === 'quiescent'))
  ok('a bad status is refused', setStatus(s, key, 'paused').ok === false)

  const r = reply(s, key, 'use main', { by: 'travis' })
  ok('a reply is accepted', r.ok)
  // The packet's Q1 is open, so a reply must not claim to be signed.
  ok('...and admits it is NOT signed (packet Q1)', r.fact.signed === false)
  ok('an empty reply is refused', reply(s, key, '').ok === false)
}

// ---- 6. paging ---------------------------------------------------------------
{
  const s = emptyState()
  const { key } = openBox(s, mk())
  for (let i = 0; i < 10; i++) post(s, key, { kind: 'note', subject: `m${i}` })

  const p0 = page(s, key, { from: 0, size: 4 })
  ok('a page is the size asked for', p0.rows.length === 4)
  ok('newest first', p0.rows[0].subject === 'm9')
  ok('and says there is more', p0.more === true)

  const p1 = page(s, key, { from: 8, size: 4 })
  ok('the last page is short', p1.rows.length === 2)
  ok('...and says there is no more', p1.more === false)
  ok('every page carries the unread count', p0.unread === 10 && p1.unread === 10)
}

// ---- 7. the store is never believed ------------------------------------------
{
  const s = emptyState()
  const { key } = openBox(s, mk({ cap: 8 }))
  post(s, key, { kind: 'ask', subject: 'which branch?', body: 'main or dev', wall: 1000 })
  post(s, key, { kind: 'note', subject: 'ok' })
  ack(s, key, 1)
  reply(s, key, 'main', { by: 'travis' })

  const { state: back, dropped } = parse(serialize(s))
  ok('a round trip drops nothing', dropped.length === 0, dropped.join(','))
  const b = boxOf(back, key)
  ok('the box survives', !!b)
  ok('the messages survive', b.msgs.length === 2)
  ok('the mark survives', b.acked === 1)
  ok('the unread projection survives', unreadCount(b) === 1)
  ok('the boundary facts survive', b.out.length === 2)
  ok('seq clears the highest stored message', back.seq >= 2)

  ok('garbage parses to an empty state', parse('{{{').state.boxes && parse('{{{').dropped.length === 1)
  ok('a wrong version is refused', parse('{"v":9}').dropped[0] === 'MAIL_BAD_VERSION')

  // Bad rows are DROPPED AND COUNTED, never silently discarded.
  const dirty = JSON.stringify({
    v: 1, seq: 5, boxes: [
      { district: 'home', side: 1, dash: 4, agent: 'a', msgs: [{ seq: 1, kind: 'note', subject: 'good' }, { seq: 2, kind: 'wat', subject: 'bad' }] },
      { district: 'home', agent: 'b' },
    ],
  })
  const d = parse(dirty)
  ok('a malformed box is dropped and counted', d.dropped.includes('MAIL_BAD_BOX'))
  ok('a malformed message is dropped and counted', d.dropped.includes('MAIL_BAD_MSG'))
  ok('the good rows survive alongside', boxesOn(d.state, 'home').length === 1)
  ok('...with only the good message', boxesOn(d.state, 'home')[0].msgs.length === 1)

  // THE CLAMP. A stored mark past the last message would pin unread at 0 forever,
  // and a badge stuck on zero is indistinguishable from an agent with nothing to say.
  const ahead = parse(JSON.stringify({
    v: 1, seq: 1, boxes: [{ district: 'home', side: 1, dash: 4, agent: 'a', acked: 999, msgs: [{ seq: 1, kind: 'note', subject: 'x' }] }],
  }))
  ok('an over-far mark is clamped to what exists', boxesOn(ahead.state, 'home')[0].acked === 1)
}

// ---- 8. the road summary -----------------------------------------------------
{
  const s = emptyState()
  const { key: a } = openBox(s, mk({ dash: 8, agent: 'planner' }))
  const { key: b } = openBox(s, mk({ dash: 16, side: -1, agent: 'builder' }))
  openBox(s, mk({ district: 'build', dash: 8, agent: 'other' }))
  post(s, a, { kind: 'ask', subject: 'q' })
  post(s, b, { kind: 'note', subject: 'n' })
  post(s, b, { kind: 'fault', subject: 'boom' })
  setStatus(s, b, 'quiescent')

  const sum = roadSummary(s, 'home')
  ok('the summary counts only this road', sum.boxes === 2)
  ok('unread across the road', sum.unread === 3)
  ok('waiting is the subset that needs you', sum.waiting === 2)
  ok('and it counts parked agents', sum.quiescent === 1)
}

// ---- 9. slot addressing agrees with the rest of the road ---------------------
{
  ok('the key is district:side:dash like everything else', keyOf('home', 1, 12) === 'home:r:12')
  ok('left is l', keyOf('home', -1, 12) === 'home:l:12')
  const s = emptyState()
  ok('a box needs a real dash', openBox(s, mk({ dash: -1 })).ok === false)
  ok('a box needs an agent', openBox(s, mk({ agent: '' })).ok === false)
  openBox(s, mk())
  ok('two boxes cannot share a dash', openBox(s, mk()).why === 'MAIL_BOX_EXISTS')
  ok('closing frees it', closeBox(s, keyOf('home', 1, 12)).ok && openBox(s, mk()).ok)
}

console.log(`\n  mail: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
