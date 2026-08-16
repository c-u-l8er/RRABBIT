// THE DRIVERSIDE MAILBOX -- the queue an agent uses to reach the human, and the
// human uses to reach back.
//
// ============================================================================
// WHY THIS IS NOT A WRL MAILBOX, stated first because the name invites the
// mistake. WRL has a `Mailbox` role and it is frozen (Core 0.2.1 sec.14b, the
// sixth surface-grounded role). This is not that, and it must not pretend to be:
//
//   a WRL mailbox            this
//   -------------------------------------------------------------------------
//   read by another actor    read by a human, at wall-clock time
//   body = 4 lanes x <=32b   unconstrained -- prose, a diff, a link
//   one period, then gone    durable until dealt with
//   replayable world state   a BOUNDARY event; deliberately not world state
//
// The split is not a convenience. Core 0.2.1 sec.7 says a mailbox holds "messages
// in transit, not a memory cell", consumed at a period boundary -- so nothing in
// WRL will hold a message for a human, and a durable driver queue inside a sealed
// world would break replay the moment its resolution depended on when somebody
// looked. sec.6 gives the honest route: wall-clock enters through an explicit
// boundary and is recorded as a signed fact.
//
// So this module is the OUTSIDE of that boundary. See
// `TRVM/WRL_AGENT_MODEL_RULING_PACKET.md` for the inside, which is unruled.
// ============================================================================
//
// PURE DATA, NO THREE AND NO DOM, so `node test/mail.mjs` runs it on the dev host
// -- the same split `m2/paper/bend-layout.js` and `m2/paper/store.js` already use,
// and for the same reason: the interesting properties here are algebraic (does
// acking converge? does a bounded queue admit that it dropped something?) and a
// property you can only check by opening a 3D shell is one nobody re-checks.
//
// WALL-CLOCK IS INJECTED (`wall` on every mutating call) for the same reason
// `measure(text, font)` is injected into bend-layout: a module that reads the
// clock itself cannot be tested for what it does with the clock. It is also the
// honest shape given sec.6 -- wall time is an input crossing a boundary, not
// something the world knows.

// Message kinds. A CLOSED SET, and small on purpose.
//
// The temptation is a free-text `kind` so an agent can say anything. That makes
// the badge unrenderable (what colour is `kind: "hmm"`?) and makes the panel's
// filter a string match. Four kinds cover what an agent has to say to a driver,
// and the ladder they sit on is WRL's own error ladder (WRL.md sec.24.3), which
// already ruled that a normal absence, an expected failure and a genuine fault
// are three different things and must stay distinct.
//
//   note      "here is what I did" -- no answer wanted
//   ask       "I cannot proceed without you" -- an answer IS wanted
//   result    an expected outcome, good or bad (WRL's `Result<T, E>` level)
//   fault     something broke (WRL's `!!` level -- engages supervision)
//
// `ask` is the only kind that blocks an agent, which is why it is worth being a
// kind rather than a flag: the panel can count "2 waiting on you" separately from
// "14 things happened", and those are different demands on a human.
export const KINDS = ['note', 'ask', 'result', 'fault']

// Overflow policy, from WRL.md sec.25's named set. Only two are implemented, and
// the two that are not are absent rather than silently aliased -- a policy name
// that is accepted and does something else is worse than one that is refused.
//
//   shed_oldest   drop the front, COUNT what was dropped        (default)
//   reject        refuse the append, tell the sender            (back-pressure)
//
// DEFAULT IS `shed_oldest` AND THE COUNT IS THE POINT. `m2/reel.js` already hit
// this exact problem and its comment is the rule:
//
//   > A RECORDING THAT LOST ITS FRONT SAYS SO. `recCut` is printed as `+N before`
//   > rather than folded into the total, because a tail that presents as a whole
//   > drive is the one way this list can mislead someone.
//
// A driverside box that quietly loses the oldest unread escalation is that same
// failure with worse consequences, so `cut` is carried and the panel prints it.
// sec.25 also requires it: "Shedding and refusal are recorded as facts."
export const POLICIES = ['shed_oldest', 'reject']

export const DEFAULT_CAP = 256

// Agent status. EXACTLY WRL's two names (Core 0.2.1 sec.20.1: "status (`runnable`
// / `quiescent`)"), not `paused`/`running`, because this is the one part of agent
// *control* that is already in the frozen entity model and renaming it here would
// hide that. Parking an actor is `_` in WRL.md sec.24.2; pausing an agent from the
// road is the same act and should read as the same act.
export const STATUSES = ['runnable', 'quiescent']

const isInt = (v) => Number.isInteger(v)
const isStr = (v) => typeof v === 'string' && v.length > 0

// ---- construction ------------------------------------------------------------

export function emptyState() {
  return { boxes: {}, seq: 0 }
}

// A box stands at a dash on a side of a road, like a window or a pane does, and
// is keyed the same way. `agent` is who owns it.
//
// THE KEY IS THE PLACE, NOT THE AGENT, and that is deliberate even though it
// looks backwards. Everything else on a road is addressed by `district:side:dash`
// -- `slotAt`, `slotFree`, the pane keys, the sign keys -- and a fourth kind of
// occupant that addressed itself differently would be the one the slot algebra
// cannot see. `m2/world.js` records what that costs: a pane the slot table had
// never heard of "would read as a document that vanished".
export const keyOf = (district, side, dash) => `${district}:${side > 0 ? 'r' : 'l'}:${dash}`

export function openBox(state, { district, side, dash, agent, cap = DEFAULT_CAP, policy = 'shed_oldest' }) {
  if (!isStr(district) || !isStr(agent)) return { ok: false, why: 'MAIL_BAD_BOX' }
  if (!isInt(dash) || dash < 0) return { ok: false, why: 'MAIL_BAD_DASH' }
  if (!isInt(cap) || cap < 1) return { ok: false, why: 'MAIL_BAD_CAP' }
  if (!POLICIES.includes(policy)) return { ok: false, why: 'MAIL_BAD_POLICY' }

  const key = keyOf(district, side, dash)
  if (state.boxes[key]) return { ok: false, why: 'MAIL_BOX_EXISTS' }

  state.boxes[key] = {
    key,
    district,
    side: side > 0 ? 1 : -1,
    dash,
    agent,
    cap,
    policy,
    status: 'runnable',
    msgs: [],
    // The acknowledgement HIGH-WATER MARK -- see `ack` for why it is a mark and
    // not a set.
    acked: 0,
    // What shedding has cost, never folded into anything.
    cut: 0,
    // Replies and refusals, append-only. These are the boundary facts.
    out: [],
    refused: 0,
  }
  return { ok: true, key }
}

export function closeBox(state, key) {
  if (!state.boxes[key]) return { ok: false, why: 'MAIL_NO_BOX' }
  delete state.boxes[key]
  return { ok: true }
}

export const boxOf = (state, key) => state.boxes[key] ?? null
export const boxes = (state) => Object.values(state.boxes)
export const boxesOn = (state, district) =>
  boxes(state).filter((b) => b.district === district).sort((a, b) => a.dash - b.dash || a.side - b.side)

// ---- the agent's side --------------------------------------------------------

// An agent puts something in the box.
//
// `seq` IS GLOBAL AND MONOTONE ACROSS ALL BOXES, not per box. Two agents that
// both spoke are two events in one history, and a per-box counter cannot say
// which came first -- which is exactly the question a driver reading two boxes
// asks. Same reasoning the shell already applies to a road's dashes: an address
// that is arithmetic on one counter is one nobody has to reconcile.
export function post(state, key, { kind, subject, body = '', wall = 0, from = null }) {
  const b = state.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  if (!KINDS.includes(kind)) return { ok: false, why: 'MAIL_BAD_KIND' }
  if (!isStr(subject)) return { ok: false, why: 'MAIL_BAD_SUBJECT' }

  if (b.msgs.length >= b.cap) {
    if (b.policy === 'reject') {
      // RECORDED, not just returned. sec.25: refusal is a fact. A sender that is
      // told no and a box that cannot say it ever said no are different systems,
      // and only one of them can be debugged.
      b.refused++
      return { ok: false, why: 'MAIL_BOX_FULL', cap: b.cap }
    }
    // shed_oldest. Shedding an ALREADY-ACKED message costs nothing; shedding an
    // unread one is a real loss and `cut` is how the panel admits it.
    const gone = b.msgs.shift()
    b.cut++
    if (gone.seq > b.acked) b.lostUnread = (b.lostUnread ?? 0) + 1
  }

  const seq = ++state.seq
  b.msgs.push({
    seq,
    kind,
    subject,
    body: String(body ?? ''),
    // Who inside the agent said it, when the agent is more than one part. Free
    // text, never interpreted -- the same discipline `ops.js` applies to `by`.
    from: from ?? b.agent,
    wall,
  })
  return { ok: true, seq }
}

// ---- the driver's side -------------------------------------------------------

// UNREAD IS A PROJECTION, NEVER A STORED COUNT. This is the load-bearing decision
// in the module and it comes straight out of the ruling packet sec.3.4:
//
//   If the count were world state, the driver READING a message would mutate the
//   world -- and a badge maintained as a counter can disagree with the list it
//   claims to count.
//
// The shell has already paid for that mistake in the other direction:
// `m2/workspaces.js` deleted `lanes:{l,r}` and `takeLane` precisely because
// "a counter and a set of windows can disagree; the windows cannot disagree with
// themselves". Same rule, same reason.
export const unread = (b) => (b ? b.msgs.filter((m) => m.seq > b.acked) : [])
export const unreadCount = (b) => unread(b).length

// Of the unread, how many are actually WAITING on the driver. `note` and `result`
// are things to know; `ask` and `fault` are things to do. A badge that fuses them
// makes fourteen log lines look like fourteen demands.
export const waiting = (b) => unread(b).filter((m) => m.kind === 'ask' || m.kind === 'fault')

// Acknowledge everything up to and including `seq`.
//
// A HIGH-WATER MARK, NOT A SET OF READ IDS, and the reason is that this must be a
// join-semilattice: Core 0.2.1 sec.9 freezes fact merge as a union that is
// "commutative, associative, and idempotent". `Math.max` is exactly that, so:
//
//   - acking the same message twice does nothing (idempotent)
//   - acks arriving out of order converge to the same state (commutative)
//   - a replay of the log lands on the same mark no matter how it interleaves
//
// The stated cost, because it IS a cost: you cannot mark one message unread again
// while leaving a later one read. That is the price of monotonicity, and
// monotonicity is what makes the badge reconstructible from the recording rather
// than a number somebody has to maintain. `{facts}` never retracts either.
export function ack(state, key, seq, { by = 'driver', wall = 0 } = {}) {
  const b = state.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  if (!isInt(seq) || seq < 0) return { ok: false, why: 'MAIL_BAD_SEQ' }
  const before = b.acked
  b.acked = Math.max(b.acked, seq)
  if (b.acked !== before) {
    // The ack is itself a boundary fact and is recorded as one -- otherwise "who
    // took responsibility for having seen this" is unanswerable, which for a
    // fault message is the whole question.
    b.out.push({ kind: 'ack', seq: b.acked, by, wall })
  }
  return { ok: true, acked: b.acked, moved: b.acked !== before }
}

// The driver says something back.
//
// NOT SIGNED, AND IT SAYS SO. Core 0.2.1 sec.6 wants a boundary fact to be
// SIGNED, and sec.16.2 forbids introducing a principal-shaped role without its
// own sanction -- so a real signature cannot be minted here without freezing a
// role-system decision nobody ruled on. `by` is therefore a plain string with no
// authority behind it, exactly as `ops.js` treats its own `by`.
//
// This is the same shape `m2/publish.js` used for the `track-` prefix: ship the
// thing, write down that the identity question is open, and do not quietly answer
// it. See the packet's Q1.
export function reply(state, key, text, { by = 'driver', wall = 0, to = null } = {}) {
  const b = state.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  if (!isStr(text)) return { ok: false, why: 'MAIL_EMPTY_REPLY' }
  const fact = { kind: 'reply', text, by, wall, to: isInt(to) ? to : null, signed: false }
  b.out.push(fact)
  return { ok: true, fact }
}

// Park or wake the agent. The two frozen status names, and nothing else.
export function setStatus(state, key, status, { by = 'driver', wall = 0 } = {}) {
  const b = state.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  if (!STATUSES.includes(status)) return { ok: false, why: 'MAIL_BAD_STATUS' }
  if (b.status === status) return { ok: true, status, unchanged: true }
  b.status = status
  b.out.push({ kind: 'status', status, by, wall })
  return { ok: true, status }
}

// ---- paging ------------------------------------------------------------------

// A page of messages, newest first.
//
// NEWEST FIRST because the thing a driver opens a box to find is what just
// happened, and `m2/reel.js` already made this call for the track trail ("the
// trail newest-first"). Consistency across two lists of events in the same shell
// is worth more than either order's merits.
//
// The page carries `unread` and `cut` alongside the rows so a caller cannot draw
// a list without the two facts that qualify it.
export function page(state, key, { from = 0, size = 12 } = {}) {
  const b = state.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  const n = Math.max(1, Math.min(100, size | 0))
  const all = [...b.msgs].reverse()
  const start = Math.max(0, Math.min(from | 0, Math.max(0, all.length - 1)))
  const rows = all.slice(start, start + n)
  return {
    ok: true,
    rows,
    from: start,
    size: n,
    total: b.msgs.length,
    more: start + n < all.length,
    unread: unreadCount(b),
    waiting: waiting(b).length,
    // `+N before`, reel.js's phrasing, for the same reason it exists there.
    cut: b.cut,
    lostUnread: b.lostUnread ?? 0,
    acked: b.acked,
    status: b.status,
    agent: b.agent,
  }
}

// What the badge on the verge shows. One number, and it is the one that means
// "you have something to do" rather than "something happened".
export const badge = (b) => ({
  unread: unreadCount(b),
  waiting: waiting(b).length,
  status: b?.status ?? 'runnable',
})

// Across a whole road -- what the gate board could say without opening anything.
export function roadSummary(state, district) {
  const bs = boxesOn(state, district)
  return {
    boxes: bs.length,
    unread: bs.reduce((a, b) => a + unreadCount(b), 0),
    waiting: bs.reduce((a, b) => a + waiting(b).length, 0),
    quiescent: bs.filter((b) => b.status === 'quiescent').length,
  }
}

// ---- persistence -------------------------------------------------------------

export const STORE_KEY = 'rrabbit.mail.v1'

// THE STORE IS NEVER BELIEVED. Same posture `m2/trackstore.js` ships with: a
// store is a file a previous build wrote, a parallel session wrote, or a user
// edited, and a loader that trusts it turns any of those into a crash inside a
// frame loop. Everything is re-validated and anything that fails is DROPPED AND
// COUNTED -- silently discarding is how a store loses half its rows and reads as
// a feature that forgot.
export function serialize(state) {
  return JSON.stringify({ v: 1, seq: state.seq, boxes: Object.values(state.boxes) })
}

export function parse(text) {
  const dropped = []
  const state = emptyState()
  let raw
  try { raw = JSON.parse(text) } catch { return { state, dropped: ['MAIL_UNPARSEABLE'] } }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return { state, dropped: ['MAIL_BAD_VERSION'] }

  for (const b of Array.isArray(raw.boxes) ? raw.boxes : []) {
    if (!b || !isStr(b.district) || !isStr(b.agent) || !isInt(b.dash)) { dropped.push('MAIL_BAD_BOX'); continue }
    const r = openBox(state, {
      district: b.district,
      side: b.side > 0 ? 1 : -1,
      dash: b.dash,
      agent: b.agent,
      cap: isInt(b.cap) && b.cap > 0 ? b.cap : DEFAULT_CAP,
      policy: POLICIES.includes(b.policy) ? b.policy : 'shed_oldest',
    })
    if (!r.ok) { dropped.push(r.why); continue }
    const box = state.boxes[r.key]
    box.status = STATUSES.includes(b.status) ? b.status : 'runnable'
    box.cut = isInt(b.cut) && b.cut >= 0 ? b.cut : 0
    box.refused = isInt(b.refused) && b.refused >= 0 ? b.refused : 0
    box.lostUnread = isInt(b.lostUnread) && b.lostUnread >= 0 ? b.lostUnread : 0
    for (const m of Array.isArray(b.msgs) ? b.msgs : []) {
      if (!m || !isInt(m.seq) || !KINDS.includes(m.kind) || !isStr(m.subject)) { dropped.push('MAIL_BAD_MSG'); continue }
      box.msgs.push({
        seq: m.seq,
        kind: m.kind,
        subject: m.subject,
        body: typeof m.body === 'string' ? m.body : '',
        from: isStr(m.from) ? m.from : box.agent,
        wall: isInt(m.wall) ? m.wall : 0,
      })
    }
    // Messages must be in seq order or paging and the high-water mark disagree
    // about what "up to here" means.
    box.msgs.sort((x, y) => x.seq - y.seq)
    // THE MARK IS CLAMPED TO WHAT IS ACTUALLY THERE. A stored `acked` past the
    // last message would make `unread` 0 forever on a box that later receives
    // something older -- and a badge stuck on zero is indistinguishable from an
    // agent that has nothing to say.
    const top = box.msgs.length ? box.msgs[box.msgs.length - 1].seq : 0
    box.acked = isInt(b.acked) ? Math.max(0, Math.min(b.acked, top)) : 0
    for (const f of Array.isArray(b.out) ? b.out : []) {
      if (!f || !isStr(f.kind)) { dropped.push('MAIL_BAD_FACT'); continue }
      box.out.push(f)
    }
  }

  // `seq` must clear every message the load actually kept, or the next `post`
  // mints a number that already exists and the high-water mark starts skipping.
  const top = boxes(state).reduce((a, b) => Math.max(a, b.msgs.length ? b.msgs[b.msgs.length - 1].seq : 0), 0)
  state.seq = Math.max(isInt(raw.seq) ? raw.seq : 0, top)
  return { state, dropped }
}
