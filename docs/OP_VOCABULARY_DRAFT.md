# The Op Vocabulary — a draft for ruling

**Status: `spec`. Nothing here is built. Nothing here is ratified.**
**This is a [TRAVIS] decision in the same class as the identity ladder** — once tracks are recorded
against a vocabulary, changing it invalidates every recording. That is exactly why WRL's six ops are
frozen and why `studbook` §7.2 *asks* before adding a key prefix rather than adding one.

Author: Claude, 2026-08-15. For review by Travis, GPT, Fable.

---

## 0. What this is for

Three complaints arrived together, and they have one cause:

1. Replay does not record lane scrolling, window clicking, resizes, program launches — it captures
   4 of ~15 verbs the desktop actually has.
2. There were no transport controls. *(Now built — see §6. They survive this proposal.)*
3. There is no way to expose the desktop's programmability to WRL in a code editor.

The cause is that the recording is an ad-hoc `{t, k, …}` shape invented for one feature. Fixing (1)
by adding eleven more `k` values makes (3) permanently harder, because the "API" would then be
whatever the recorder happened to log.

**One decision fixes all three: a closed vocabulary of typed ops, applied through a single seam.**

---

## 1. The seam

```
   human drives   ──▶ ┌───────────────────────────┐
   replay         ──▶ │                           │
   WRL program    ──▶ │   apply(op)  ← ONE SEAM   │ ──▶ the world
   code editor    ──▶ │                           │
   an agent       ──▶ └───────────────────────────┘
                                   │
                          the log IS the track
```

- **Recording** = log what passed the seam. Automatic — which is why the current recorder is missing
  eleven verbs: each one has to be remembered by hand today.
- **Replay** = feed the log back through the seam.
- **Transport** = ops are discrete and countable, so step/scrub is arithmetic.
- **WRL** = a program that emits ops. *It needs no separate desktop API: the vocabulary is the API.*
- **The code editor** edits the op list, which already is the program.

This is D′ one layer up. In WRLM the model emits text and the **host derives** the typed edit. Here
the human drives and the **shell derives** the typed op. In neither case does the actor hand the
world a mutation directly.

---

## 2. The rule that decides granularity

> **Record the arrival, not the input.**

Already implicit in `go` and `in`; worth making explicit because it settles every borderline case.

Scrolling is the test. Forty wheel notches is a macro — brittle, meaningless once the road changes
length. `park(build, z=340)` is a track. Same information; only one survives the world moving.

Applied:

| The input | Recorded as | Not as |
|---|---|---|
| 40 wheel notches down a road | `park(road, z)` — coalesced, final position | 40 scroll deltas |
| click a window, then click inside it | `enter(district, milepost)` | a click at (412, 233) |
| drag a window to a new slot | `move(from, to)` | a pointer path |
| type into an application | **nothing** (see §5) | keystrokes |

**Corollary:** an op must be replayable against a world that has *moved*, or it does not belong in
the vocabulary. That is the same test `checkStep` already applies.

---

## 3. The proposed vocabulary

Grouped by what they act on. Names are provisional; the *shape* is the proposal.

### Navigation — where the ship is

| Op | Args | Precondition | Existing verb |
|---|---|---|---|
| `drive` | `road` | road exists and is open | `goDistrict` |
| `park` | `road, z` | road exists and is open | `parkRoad` |
| `enter` | `road, milepost` | window present at arrival | `goWindow` |
| `leave` | — | standing in a window | `release` |
| `back` | — | trail is non-empty | `goBack` |
| `exit` | `to` | exit exists | `goExit` |
| `dash` | `road, at` | dash exists | `goDash` |

### Window — what is on the road

| Op | Args | Precondition | Existing verb |
|---|---|---|---|
| `full` / `unfull` | — | standing in a window | `enterFull` / `exitFull` |
| `resize` | `dw, dh` | standing in a window | `resizeFlatBy` |
| `zoom` | `road, milepost, k` | window present | `rekeyZoom` |
| `place` | `program, road, milepost` | slot free | `dropAt` |
| `close` | `road, milepost` | window present | `requestCloseWindow` |

### Shell — which world you are looking at

| Op | Args | Precondition | Existing verb |
|---|---|---|---|
| `track` | `n` | 1 ≤ n ≤ 999 | `goTrack` |
| `gear` | `P\|R\|C\|D` | gear is built | `dash.setGear` |
| `map` | `open\|close` | — | `toggleMap` |

**Sixteen ops.** Comparable to WRL's six and `GoalSpecV1`'s 4 + 9 — a closed set, not an open API.

---

## 4. Preconditions reuse `GoalSpecV1`'s shape

Not its implementation — §3.4 of the positioning plan stands, a `sem-` world is not an OS world.
What transfers is the **discipline**, which is the part that matters:

- **closed AST**, not an open predicate language — or it accidentally becomes a second WRL
- **bounded** — depth and node caps, so an adversarial precondition cannot hang the shell
- **total** — a malformed world evaluates to `false`, never throws. A guard that can throw is not a
  guard.
- **sealed into the track's identity** — *the load-bearing one.* A track must not be editable to
  weaken its own precondition. Without this a precondition is a suggestion.

The current `checkStep` is a hand-written approximation of exactly this. It should become data.

---

## 5. What is deliberately NOT in the vocabulary

Naming these now, because each will be argued for later and the reasons should predate the argument.

- **Keystrokes and pointer coordinates.** They make a macro. If a track needs to type, it needs an
  op that says *what* is being typed and *into what*, not which keys moved.
- **Anything inside an application's surface.** The shell does not own that world and cannot state
  a precondition over it. This is the honest boundary of the whole approach, and it should be stated
  on `computedriven.com` rather than discovered by a user.
- **Timing as semantics.** Timestamps are evidence, not instructions. A replay that must reproduce
  original delays is a recording, not a program.
- **`out`.** Leaving a window is real and worth logging, but replaying it is a no-op the driver
  already performs. It stays in the *log*, not in the *plan* — the split `replaySteps` already makes.

---

## 6. What is already built and survives this

The transport (shipped 2026-08-15, `001e0bd3`) reads **an ordered list of discrete steps** and never
asks what a step means. Its one point of contact with the current kinds is a single `phrase()`
function, written to be the only thing that needs rewriting.

Measured: starts paused at `i: 0`; five full gaps pass with `ran: 0`; a second replay is refused
`TRACK_BUSY`; double-pause is idempotent; stop clears state.

So the ordering was: build the vocabulary-independent part, propose the vocabulary. The event kinds
do not survive; the controls do.

---

## 7. Migration — what happens to existing recordings

Honest answer: **they are discarded.** Current recordings hold 4 kinds; the vocabulary has 16 and
different argument shapes. A translator would be inventing `park` positions nobody recorded.

The store key moves `rrabbit.tracks.v2` → `v3`, and `load()` already treats a saved set as untrusted
input from an older build — so the drop is a no-op in code and needs no migration path. **This is
cheap now and expensive later**, which is an argument for ruling sooner rather than after tracks
have been published.

---

## 8. What has to be ruled

1. **Freeze the vocabulary at all?** The alternative is an open, growable set — cheaper today,
   and it forecloses sealing preconditions into identity, which forecloses tracks being transferable.
2. **These sixteen ops, or a different cut?** Especially: is `zoom` semantic or cosmetic? Is `gear`
   part of the world or part of the viewer?
3. **Does the identity ladder admit a `track-` prefix?** Same question `studbook` §7.2 asks, and it
   is not mine to answer.
4. **Discard existing recordings** (§7), or build a lossy translator?
5. **Sequencing.** This is a refactor before a feature — visible progress pauses. That cost is real
   and it is a scheduling decision, not a technical one.

## 8b. WHAT THE EXPERIMENT FOUND (added 2026-08-15, after rung 6)

**§9's test has been run.** `m2/ops.js` implements the seam; `test/ops.mjs` is the experiment. This
section reports the result. **Nothing here is ratified** — §8's five questions are still yours.

Rung 6 of `PAPER_ROADS.md` forced the issue rather than choosing the timing: the moment a pane
accepts a click, that click either passes the same seam a recorded op does, or the recorder acquires
a second vocabulary — which is exactly the accretion §0 exists to stop.

### 8b.1 The seam held

Four ops built: **`drive`** and **`park`** (two of the sixteen in §3, wired to the same `goDistrict`
a gate calls) and **`read`** / **`unread`** (proposed, §8b.3). Three consumers — a pointer, a
program, a replay — reach an identical world through one `apply()`. `test/ops.mjs` §3 asserts it by
running the same sequence all three ways and comparing.

**No consumer needed a special case.** §6 of that file asserts it mechanically: the same op applied
under six different `by` values produces byte-identical effects, so the seam cannot grow a branch on
who is calling without a test failing. `by` is recorded and never consulted.

`replay()` is a `for` loop over `apply` — which is the strongest form the claim can take, because
anything replay needed that `apply` lacked would appear right there as a branch.

### 8b.2 The finding: §5's reasoning about `out` needs one more condition

§5 drops `out` from the plan because *"replaying it is a no-op the driver already performs"*. That
reasoning is sound, and it is **not sound in general**. Measured (`test/ops.mjs` §4):

A human reads pane A, leaves, reads pane B. `unread` is not plannable, so the plan is
`[read A, read B]`. If `read` **refuses** while another pane is open — which is what
`PAPER_ROADS.md` §5 originally specified, as a hard refusal — then **replaying that plan fails at
step 2** with the first pane still open. The human succeeded; the replay of their own recording does
not.

> **A non-plannable op is only safe to drop when the op that follows it IMPLIES it.**

`out` satisfies this because entering a window implicitly leaves the previous one. `unread` did not,
until `read` was changed to **supersede** rather than refuse. The refusal is still enforced — one
pane at a time — but by the second read closing the first, not by saying no.

This is a condition §5 should state, whatever the ruling. It is cheap to satisfy and silent when
violated: the recording looks fine and only fails when replayed.

### 8b.3 The sixteen are already not sixteen

`read` and `unread` are not in §3's table, because §3 predates paper roads. A whole class of object
now stands on roads and can be entered, and it needed two verbs nobody had budgeted.

That is **evidence for freezing rather than against it** — but it sharpens §8.1: the question is not
"can we enumerate the verbs" (we could not, one rung later) but "is the set closed **at a version**,
with additions being a deliberate act". `test/ops.mjs` §8 pins the table's contents, so adding a verb
breaks a test and has to be argued for rather than slipping in because a feature needed it.

### 8b.4 What is still open, unchanged

- **§4's load-bearing item is NOT done.** Preconditions are hand-written JS closures. They are total
  (a throw is caught and reported as a refusal) and bounded, but they are **not data and not sealed
  into a track's identity** — so a track can still be edited to weaken its own guard. The seam makes
  this easier to fix later; it does not fix it.
- **Nothing was rerouted.** travel.js's own callers are untouched; the ops call the same functions a
  gate does. So this is additive and reversible, and the "refactor before a feature" cost in §8.5 has
  not been paid — it is still ahead.
- The recording still covers 4 of ~15 verbs (§8b.1's four are the seam's, not the recorder's).

## 9. DOCTRINE

- **proposed** — that a closed op vocabulary applied through one seam is what makes tracks
  generalizable to WRL, and that the current ad-hoc recording cannot get there by accretion. What
  would test it: implement `drive`/`park`/`enter` through a seam and check whether recording,
  replay, and a hand-written WRL-ish program all drive the same code path with no per-consumer
  branching. If any consumer needs a special case, the seam is wrong.
- **proposed** — "record the arrival, not the input" as the granularity rule. What would test it:
  record a drive, change the road's length, replay. Arrival-based ops should still land correctly;
  input-based ones will not.
