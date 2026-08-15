# Paper Roads — documents as a second window kind

**Status: `spec` for §5–§9, `proposed` for §10. §1–§4 are measurements and citations.**

Author: Claude, 2026-08-15. Prompted by Travis: *"could we build simple apps that only render
bendscript.com and runefort.com protocols? then this app could also use WRL as its sort of JS/CSS
replacement?"*

Read [`RUNBOOK.md`](RUNBOOK.md) for the shell in general and
[`OP_VOCABULARY_DRAFT.md`](OP_VOCABULARY_DRAFT.md) for the ruling this depends on.

---

## 0. The one-line version

The road network does not need a browser. It needs **a window that is not a process** — and the
shell already builds one of those for ramps. Point that mechanism at `.bend` and `.rune` documents
and you get a pane that costs ~1 KB instead of ~3 MB, which is the entire reason "thousands" is a
different conversation from "dozens".

---

## 1. The premise that had to be corrected first

The prompt proposed **WRL as a JS/CSS replacement**. It cannot be, and the reason is in WRL's own
README rather than anywhere in this repo:

> WRL Core 0.1.2, the writable surface. Five roles, one texture, **no behaviours**.

Mailboxes, behaviour blocks, capability walls and deterministic supervision are in the *authored
design* — "forty-six sections, written down, tier-marked, **not built**." A language with no
behaviours cannot lay out a paragraph, resolve a threshold, or handle a click. A pane written in
WRL Core today would render nothing.

What WRL *is* strongest at is the same README's honest claim:

> describing a **network of identities** precisely enough that the description is a hash and the run
> is a film.

That is not a JS replacement. It is a **wiring** layer, and it happens to be the thing tracks and
replay already hand-roll (§9).

**DOCTRINE — corrected.** WRL is not the scripting layer of this stack. The op vocabulary is. Any
plan that has WRL computing layout is a plan that has not read `reference.html#tiers`.

## 2. The four layers, and which one is missing

| Web layer | This stack | State (measured) |
|---|---|---|
| HTML — document semantics | **BendScript** `.bend.json` | `@bendscript/core`, 96 tests green, 20-doc corpus |
| CSS — layout | **RuneFort** `.rune.json` | `@runefort/core` web components exist in `packages/core/src/` |
| JS — interaction | **the op vocabulary** — 16 closed ops through one seam | drafted, **unruled** |
| — | **WRL** — which pane feeds which, sealed to a `sem-` id | Core 0.1.2 frozen; no behaviours |

Three of four exist as artifacts. The missing one is the interaction layer, which is exactly the
ruling already pending in `OP_VOCABULARY_DRAFT.md` §8.

**This raises the stakes on that ruling.** It was a tracks feature. It is now the scripting layer of
a document runtime as well. A second consumer is the strongest evidence the seam is real — §9 of the
draft asked for exactly this test and it now has a candidate.

## 3. The cost measurement that decides the scale question

Two window kinds already exist in `m2/`, and they are not the same order of magnitude.

**A live window** (`rrabbit.js` `makeSign` ← `adoptSurfaceTexture`):

```js
const rt = new THREE.WebGLRenderTarget(width, height)
rt.depthTexture = new THREE.DepthTexture(width, height)
```

Per window: one Wayland client **process**, one EGL image, one video decode path, one colour render
target and one depth texture. At 1024×768 RGBA that is ~3 MB of VRAM for the colour target alone,
before the depth texture and before the client's own memory.

**A canvas object** (`ramps.js` `makeRamp`, [ramps.js:487](../m2/ramps.js:487)):

```js
const canvas = document.createElement('canvas')
canvas.width = 512; canvas.height = 320
const tex = canvasTexture(THREE, canvas)
```

No process, no proxy, no encoder. The shell paints it.

**The documents themselves**, measured on `bendscript.com/test-corpus/v0.1/` (2026-08-15):

```
n=20  min=300 B  max=4224 B  mean=1067 B   (21,350 B total)
```

So the arithmetic that answers "thousands or millions":

| | 1,000 panes | 1,000,000 panes |
|---|---|---|
| as `.bend` documents | ~1 MB | ~1 GB |
| as live windows (VRAM only) | ~3 GB | ~3 TB |
| as live windows (processes) | 1,000 | 1,000,000 |

**A million documents is a storage problem. A million windows is not a problem, it is a category
error.** The whole idea rests on those being different kinds of object, and in this shell they
already are.

Note the second-order limit: ~1 GB exceeds `localStorage` (5–10 MB) by two orders of magnitude, so
the store is IndexedDB or a server — never the mechanism `tracks.js` uses today.

## 4. Why the culling is easier here than on a canvas

The infinite-canvas literature reaches for quadtrees, R-trees and spatial hashes because a canvas is
2-D and unbounded in both axes. **A road is not.**

- A road is a **sorted 1-D axis** of mileposts. `roadOrder(district)` already returns it in order.
  Culling on a road is a binary search and a slice, not a tree query.
- **Districts are the chunks.** The workspace graph is already the streaming unit — you are in
  exactly one district, and its neighbours are its exits.
- The slot algebra already exists and already refuses: `slotAt` / `slotFree` / `nextFreeSlot` /
  `nearestFreeSlot`, with `SLOT_GAP = 4` and `DASH_MAX = 96`.

At current constants a road holds roughly 46 slots (two sides, every 4th dash, first slot at
`SLOT_FIRST`). One million panes is therefore ~22,000 roads — which the district graph permits,
because it is a graph and not an array.

**DOCTRINE — proposed.** The load-nearest algorithm for paper roads is *ordinary chunk streaming*
with the 1-D case already solved by `roadOrder`. What would test it: place N panes, drive the road,
and measure frame time against N. If frame time is flat in N and rises only with the *visible*
count, the road shape is carrying the culling. If it rises with N, something is touching every pane
per frame and the shape is not being used.

## 5. The three fidelity tiers (this is the LOD story)

A pane is not one thing at all distances. Three tiers, matching what the shell can afford:

| Tier | When | What it is | Cost |
|---|---|---|---|
| **read** | you are standing in it | real DOM via `CSS3DRenderer`, real text selection, real `@runefort/core` web components | ~1 pane |
| **paint** | on the road ahead, legible | shell-painted canvas → `canvasTexture`, same path as `makeRamp` | tens |
| **card** | far, or off the current road | one quad from a shared atlas: title + block count + edge count | thousands |

The **read** tier is the interesting one, because it means `@runefort/core` does not have to be
reimplemented. It is already Custom Elements; `CSS3DRenderer` positions real DOM in 3-D. The cost is
that CSS3D does not composite with WebGL depth — so it is correct exactly when one pane is in front
of everything else, which is what "standing in a window" already means in this shell.

**The refusal that goes with it:** a pane MUST NOT be promoted to **read** tier while another is
already there. The shell has one `flatMilepost`; two DOM overlays would occlude each other with no
depth test to arbitrate. This is a hard refusal, not a budget.

## 6. What a paper pane is, concretely

```
  .bend.json  ──▶ parse ──▶ layout ──▶ draw commands ──▶ canvas ──▶ canvasTexture ──▶ road slot
  .rune.json  ──▶ parse ──▶ grid   ──▶ draw commands ──┘
```

Four modules, and the split is chosen so that **the part with arithmetic in it has no THREE and no
DOM**, and is therefore testable on a host that cannot open a WebGL context:

| Module | Depends on | Testable headless |
|---|---|---|
| `m2/paper/bend-layout.js` | nothing | **yes** — pure functions over JSON |
| `m2/paper/rune-layout.js` | nothing | **yes** |
| `m2/paper/paint.js` | a 2-D context | partly |
| `m2/paper.js` | THREE, `world.js` | no — needs the guest |

This is not decoration. Per `TRACKS_HANDOFF.md` §1 the dev host **cannot open the 3D shell**, so any
design that puts the layout arithmetic behind a WebGL context is a design that can only be tested
through a `scp`-to-FreeBSD loop. Keeping layout pure is what makes this work testable at all.

## 7. Where the documents come from

The Gemini protocol is the cautionary case: a well-designed small document format with, after five
years, roughly 3,900 capsules. **A document runtime with no corpus is an empty world.**

This one is not starting empty, and the corpus is already committed rather than hoped for:

- `bendscript.com/test-corpus/v0.1/` — 20 documents, checked in, spanning every core primitive.
- **Graphonomous is BendScript's gating adopter** (spec §14.3.1): every memory node with textual
  content is exportable as a single-block `.bend` document under `bendscript.memory.v1`. That is a
  corpus that grows on its own, from a loop that already runs.
- `runefort.com/forts/` and `examples/` — existing `.rune` layouts.

**The honest statement:** the first useful pane in this shell renders a Graphonomous node, not a web
page. That is a smaller claim than "a browser" and it is the one that is actually true.

## 8. What this is NOT

Naming these now, because each will be argued for later.

- **Not a web browser.** No HTML parser, no CSS cascade, no JS engine, no TLS stack. Ladybird is the
  measure of what a real independent engine costs — a nonprofit, a full-time team, and 2026 for a
  first alpha, after starting inside SerenityOS in 2019. Nothing in this document is on that scale
  and nothing in it should be described as if it were.
- **Not a replacement for the live windows.** `foot`, `firefox` and every real application stay
  Wayland surfaces. Paper panes are additive. A shell that could only show documents would be a
  worse shell.
- **Not a general renderer for arbitrary `.bend`.** v0.1 renders the `core` vocabulary. Unknown block
  kinds render a fallback and are preserved — which is what BendScript §2.2 already requires.
- **Not authoring.** BendScript §0 states `.bend` files are not hand-authored. A viewer that cannot
  write is honest; an editor is a separate decision and needs the op vocabulary ruled first.

## 9. Where WRL actually enters

Not as script. As **wiring**, and only once there is more than one pane.

A road with N panes on it has a question no single pane can answer: which pane's output feeds which
pane's input, and does that arrangement mean the same thing tomorrow? That is precisely a network of
durable identities connected by textured routes — the thing WRL Core 0.1.2 *can already express*,
and can already seal to a `sem-` id.

The payoff is not syntax, it is **identity**: a road's arrangement of panes becomes one content
address. Two roads that seal to the same id are the same road. That is the property tracks wants
(`OP_VOCABULARY_DRAFT.md` §4: *sealed into the track's identity*) and currently approximates by
hand.

**This is deferred.** It requires panes with inputs and outputs, and v0.1 panes have neither. Stated
here so the layering is on record before anyone proposes WRL as a template language.

## 10. Build order

Smallest first, each rung falsifiable on its own.

| # | Rung | Proof it worked |
|---|---|---|
| 1 | `bend-layout.js` — `.bend` → draw commands, pure | **done** — `node test/paper-layout.mjs`, 145 assertions over the real 20-doc corpus |
| 1b | `paint.js` + `dev.html` — commands → 2-D canvas | **done** — all 20 painted, 479 commands, 0 blank |
| 2 | `paper.js` — panes on a road slot | **done** — 5 panes on the road in the FreeBSD guest, both tiers visible (§13) |
| 3 | `.rune` panes via the same seam | **done** — `node test/rune-layout.mjs`, 59 assertions; 4 real floors, 15 rooms, **no fourth command kind** |
| 4 | the **card** tier + a shared atlas | **done** — 400 panes, best-case frame flat, 56 canvases not 400 (§14) |
| 5 | IndexedDB store + district-chunk streaming | **done** — 10,000 documents, 500 on the road, 24 canvases (§15) |
| 6 | `CSS3DRenderer` **read** tier | text selectable in the pane you stand in |
| 7 | WRL wiring (§9) | two roads with the same arrangement seal to the same id |

Rungs 1–3 do not need the op vocabulary. **Rung 6 does** — the moment a pane accepts a click, that
click has to pass the same seam a recorded op does, or the recorder acquires a second vocabulary and
`OP_VOCABULARY_DRAFT.md` §0's whole argument is lost.

---

## 11. The defect the first render found

Rung 1 passed 133 assertions and was wrong in a way no assertion asked about.

Every block kind drew correctly. Corpus doc 12 — **one paragraph and nine edges** — drew the
paragraph and stopped. So did doc 17 (six cross-document edges) and doc 05. The `stats.edges` count
was right the whole time; nothing rendered it.

BendScript §6 opens with *"Edges are the protocol's reason to exist."* A renderer that draws blocks
and hides edges is not a partial BendScript renderer — **it is a renderer of the part BendScript
shares with markdown**, which is the part that needed no new format. The pane looked finished
because prose is the part you notice.

Fixed with an **edge rail** (§2.4 keeps edges document-level on purpose, so they render as a
document-level band rather than inline anchors — inlining them would re-couple what the format
deliberately separated). The rail is what makes the vocabulary-namespaced predicates visible:
`bendscript.argument.v1:rebuts`, `bendscript.spec.v1:satisfies`,
`bendscript.memory.v1:consolidated-from`. Those strings are the entire difference between this and
a markdown viewer, and until the rail existed not one of them reached a pixel.

> **A renderer is not tested by whether it drew something. It is tested by whether the thing the
> format exists for reached the screen.**

## 12. What the second format settled, and two things it exposed

Rung 3 existed to falsify one claim: that `rect` / `line` / `text` is a **closed** set rather than
"the three things the first format happened to need". A second, unrelated format — grids, not prose
— was the test.

**It needed no fourth command.** 4 floors, 15 rooms, 148 commands, kinds used `{line, rect, text}`.
A room border is drawn as four thin rects rather than a stroked path, precisely because adding
`strokeRect` would be the fourth command arriving through the back door.

### 12.1 The shipped documents are not the spec's shape

The protocol spec §3 describes a flat `{ runefort, grid, rooms, claims, neighbors, state_bindings }`.
The **only real RuneFort document in the repo** — `runefort.com/forts/welcome.json` — is
`campus → buildings → floors → rooms`, with `columns` / `cell_height` / `gap` on the floor and
`state_class` written straight onto the room. `@runefort/core` ships `rune-campus.js`,
`rune-building.js` and `rune-elevator.js`, so the hierarchy is the implemented model.

Meanwhile the protocol spec's §11 still lists **"Nesting. A room inside a room (zoomable). Worth
adding to core, or push to a vocabulary?"** as an *open question for v0.2*. The shipped app answered
it and the spec was never told.

`floorsOf()` normalises both and `stats.shape` reports which arrived, because rendering only the spec
shape would render nothing that exists, and rendering only the app shape would silently bless the
drift. **This is a runefort.com spec issue, not an RRABBIT one** — flagged here because this is where
it surfaced.

### 12.2 A canvas pane cannot be a conformant Runefort renderer

Renderer contract §5 MUST-4: *"Each room MUST be focusable (keyboard) and have a stable accessible
name."* MUST-5 requires arrow/`hjkl` focus movement along neighbour edges.

A canvas has no focus and no accessibility tree. The **paint** tier therefore satisfies §5.1 (layout,
which explicitly allows "visually equivalent"), §5.3 (state classes, visually) and §5.2 in part — and
**cannot** satisfy §5.4 or §5.5 at all. It is a *viewer*, not a conformant renderer, and should not
be described as one.

This is the strongest argument yet for rung 6: the **read** tier uses `CSS3DRenderer` and real
`@runefort/core` Custom Elements, which have real focus and a real accessible name for free.
Conformance is not a nice-to-have that arrives with polish — it arrives with the DOM or it does not
arrive.

## 13. Rung 2 in the guest, and what it did NOT establish

Five panes stand on the first road in the FreeBSD guest: three `.bend` documents and two Runefort
floors, at alternating sides, placed through the same slot algebra windows use. Corpus doc 19 renders
at the **paint** tier with its heading, its typed link and its five-phase list legible from the
driver's seat; doc 12's **edge rail** is readable on the opposite side; and doc 06 mid-road has
already dropped to the **card** tier (`4 blocks · 0 edges · core`). So both tiers are real, and the
tier boundary is visible in one frame.

`slotFree` learned about panes (`world.js` `papers`), because the algebra knew two occupants —
windows and ramps — and a third it had never heard of is a pane a window gets placed on top of. That
failure would not read as an incomplete slot table; it would read as a document that vanished.

**Clicks are deliberately not wired.** A pane is inert. Wiring a click now would create the second
interaction vocabulary that `OP_VOCABULARY_DRAFT.md` §0 exists to prevent — the moment a pane accepts
input, that input has to pass the same seam a recorded op does. Rung 6 is gated on the ruling, not on
effort.

### 13.1 The frame cost is NOT measured, and the gauge cannot measure it

The dash read 17.1 ms/frame with no panes and 51.2 with five, which looks like a finding and is not
one. Sampling three more times while feeding input gave **67.7 / 34.3 / 67.4** — the spread is the
**idle brake** engaging and disengaging between samples, not pane cost. See
`project_rrabbit_idle_brake`: the brake keys on input, so a gauge read from a screenshot is sampling
the brake as much as the scene.

What the design does guarantee, from the code rather than from a measurement: `syncPaper` repaints
**only on tier change**, so a settled pane costs no layout per frame and is three draw calls (frame,
quad, post). What is unmeasured is whether that holds at N in the hundreds. **Rung 4's proof —
"frame time flat in N" — is still owed, and needs an in-page harness, not a photograph of a dial.**

### 13.2 Two guest traps, each of which cost a cycle

- **Do not `pkill firefox` to change the shell's URL.** Firefox *is* the kiosk session leader; killing
  it drops the whole X session to the SDDM greeter. Recovery is `virsh send-key` one keycode at a
  time (a multi-keycode `send-key` is one *chord*, not typing) to log back in.
- **`rrabbit-session` already has the escape hatch:** `RRABBIT_URL_EXTRA` is appended to the shell
  URL, exactly as `RRABBIT_DIR` overrides the install path. Set it in `~/.xprofile` and log in. The
  guest currently carries `export RRABBIT_URL_EXTRA=papers=seed`; **delete that line to get a clean
  road back.**
- A reload via Ctrl+R raises a `beforeunload` confirm dialog. It is dismissed with `KEY_ENTER`
  ("Leave page" is focused), and a screenshot that still shows the old road may simply be a dialog
  nobody answered.

## 14. Rung 4 — the number, and the estimator that had to be changed to get it

`?papers=bench` sweeps N ∈ {0, 25, 50, 100, 200, 400}, samples 50 rAF intervals per step after a
12-frame warmup, and **draws its own result on the glass** — the guest has no console, so an overlay
is what makes a screenshot a valid instrument again: what is photographed is a number the page
computed rather than a needle being interpreted.

Measured in the FreeBSD guest, two runs:

```
   N |  med ms |  p95 ms |  min ms | hz | paint/card/hid | cvs | atlas
   0 |   50.31 |   85.42 |   16.08 |  0 |          0/0/0 |   0 | 0p 0
  25 |   50.29 |   84.34 |   16.06 |  0 |         0/0/25 |   0 | 0p 0
  50 |   50.22 |   68.32 |   16.08 |  0 |         0/0/50 |   0 | 0p 0
 100 |   51.28 |  152.90 |   17.06 |  0 |        56/44/0 |  56 | 1p 44
 200 |  118.50 |  186.84 |   17.08 |  0 |       56/144/0 |  56 | 2p 144
 400 |  118.63 |  186.18 |   17.02 |  0 |      56/332/12 |  56 | 4p 332
```

### 14.1 The median is the wrong estimator, and the bench said so itself

First run's medians: 67.5 / 51.5 / 50.7 / 118.3 / 118.6 / 102.4. **N=25 was faster than N=0**, and the
sequence is non-monotonic in both runs. A cost curve cannot go down when you add work, so what those
numbers measure is the scene's noise floor — live clients decoding, software rasterisation in a VM —
and not panes. The first version of this bench printed `87.15 us/pane` from exactly that data. It was
noise wearing a decimal point.

**Frame-time noise is one-sided.** Nothing makes a frame finish sooner than the work in it allows;
stalls only ever make frames longer. So the **minimum** is the robust estimator — the closest thing
to "what this frame costs when nothing else interferes" — and contamination can only push the other
samples up and away from it. The bench now reports `min` as the verdict and prints
`NON-MONOTONIC = noise-dominated, do not quote as per-pane cost` beside the median so the retired
mistake cannot be made again from the same table.

Its resolution is one vsync. A best case pinned near 16.6 ms cannot resolve a cost below that, so the
claim is a **bound**, not a zero.

### 14.2 What the numbers say

- **Best case: 16.08 ms at N=0 → 17.02 ms at N=400.** Delta 0.94 ms — under one frame of headroom for
  four hundred documents.
- **The cleanest rows are 100 → 400**, where panes were actually being drawn: min 17.06 → 17.08 →
  17.02. Tripling N moved the best-case frame by **0.06 ms**.
- `hz = 0` on every row in both runs, so the idle brake was never capping and these numbers are about
  panes. That is a *recorded* fact, not an assumption — §13.1's failure was assuming it.

### 14.3 The result that matters more than the frame time

**`cvs` is 56 at N=100, at N=200 and at N=400.** Paint canvases are bounded by `READ_Z` — by what is
close enough to read — and not by N. Before this rung every pane allocated a 640×420 canvas in
`build()` whether or not it would ever be read: 400 panes was ~428 MB of backing store before the
first frame, and the *card* tier, whose whole purpose is to be the cheap one, was paying the read
tier's price.

Now 400 panes hold 56 canvases plus 4 atlas pages (~124 MB against ~428 MB), and the 56 does not move
when N does. **That is the property rung 5 rests on** — 10,000 panes will hold 56 canvases too,
because the bound is the road ahead, not the corpus.

### 14.4 Caveats, stated rather than discovered later

- The N=25 and N=50 rows show every pane `hidden` in this run and `paint` in the first. Those steps
  run while the shell is still in its opening shot, so their tier mix is not representative and they
  are not evidence about drawing cost. The rows above 100 are.
- 400 panes were placed **unslotted** at quarter-dash spacing. A real road's spacing rule allows ~23
  per side, so this sweep is denser than any road will be. That is the right direction for a bound.
- The bench measures rAF intervals. It is not a profiler and cannot say *where* time went — only
  whether it grows with N.

## 15. Rung 5 — ten thousand documents, and three instruments that lied first

`?papers=store` seeds a real IndexedDB store and streams one road's chunk out of it. Measured in the
guest:

```
store            idb
corpus           10000 documents across 24 districts
written/refused  10000 / 0
open / write     55.9 ms / 2336.7 ms
chunk load       204.8 ms          <- entering the road
resident panes   500               (bounded by the DISTRICT)
scene objects    1386              (bounded by what is DRAWN)
paint canvases   24                (bounded by a BUDGET)
tiers            paint 24 / card 438 / hidden 38
atlas            5 pages, 438 cards, 5 textures
frame            min 17.1 ms   med 152.04 ms   hz 0
```

**The question was never "can 10,000 panes be drawn"** — they cannot all be on one road and nobody
would look at them. It was whether the cost of standing on a road is proportional to *that road* or
to the corpus behind it. Three numbers answer it, and none of them moved with the corpus: 10,000
stored, 500 resident, 24 canvases held.

### 15.1 A pane is a record until it is on screen

`build()` used to add a frame and a post to the scene the moment a pane was placed. At 400 that is
800 objects; at 10,000 it is **twenty thousand**, and three.js visits every one per frame to discover
it is invisible — `visible = false` skips the draw, not the walk. Nothing enters the scene graph now
until a tier asks for it. A pane on another road costs one JS object and its document.

### 15.2 The store is the first thing here that could not use `localStorage`

`tracks.js`, `layout.js` and `workspaces.js` all persist to `localStorage`, which is 5–10 MB. A
million documents is ~1 GB (§3), so this is the first part of the shell that had to reach for
IndexedDB. The store is split adapter-from-logic — validation, chunking and the district index are
pure and run under `node` (`test/store.mjs`, 55 assertions, 10k put in 15 ms), while `idbAdapter` and
`memoryAdapter` are the two backs. Same discipline as injecting `measure` in `bend-layout.js`, and for
the same reason: IndexedDB does not exist under `node`, so a store written straight against it could
only ever be tested through the FreeBSD deploy loop.

### 15.3 The bound that was true and still too loose

With distance as the only criterion, a 500-pane road put **128** documents at the paint tier at once
and best-case frame time went 17 ms → **33 ms**. The bound was working exactly as designed — canvases
tracked what was in view rather than the corpus — and it was still wrong, because `READ_Z` asks
"could this be read from here", which down a long road at a shallow angle is true of far more panes
than anyone is reading.

So distance now decides *eligibility* and **count decides the tier**: the nearest `PAINT_MAX = 24` are
laid out and everything else in range is a card, which is what it looked like at that distance anyway.
128 canvases → 24, and 33.16 ms → 17.10 ms, back to one vsync.

> **A bound can be correct and still be the wrong bound.** "Bounded by what is in view" was true the
> whole time; it just was not a frame budget.

### 15.4 Three instruments that produced plausible wrong numbers

Rung 5 cost more cycles to *measure* than to build, and every one of them was the instrument rather
than the code:

1. **A stale overlay reads exactly like a fresh one.** A `Ctrl+R` swallowed by the `beforeunload`
   dialog left the previous run's panel on screen. Caught only because two runs reported timings
   agreeing to three decimal places — which is impossible. The overlay now prints `ran at <ISO>` and
   `+N ms after load`. Same failure class as the stopped counter in `TRACKS_HANDOFF.md` §3.
2. **A snapshot taken mid-stream reads as an empty world.** One run reported `resident=watch loads=1
   got=500` beside `resident panes 0` — four numbers that look contradictory and are not. The shell
   had moved district, the auto-stream dropped the outgoing panes *synchronously* and was still
   fetching the incoming ones. Every count was correct for the instant sampled, and that instant was
   the gap between two districts. The bench now waits for `!streamBusy() && streamResident() ===
   state.district` and prints `settled` / `IN FLIGHT`.
3. **The shell moves district during startup, later than any settle window.** Three attempts to bind
   the chunk to "the district the shell is on" all came back `seeded into home / district now build`.
   The `arrived` hook takes the camera to a newly adopted window and clients connect on their own
   schedule. Racing it was the wrong shape; **every real road gets a chunk** instead — which is also
   what a real corpus looks like, since documents live on the road they belong to and not on the one
   you happen to boot into.

### 15.5 What rung 5 did not establish

- `med 152 ms` is still noise-dominated (§14.1) and is not a per-pane cost. The `min` is the estimator.
- Nothing was measured above 10,000. The claim is that cost tracks the road rather than the corpus,
  evidenced at 10k; it is not a claim about a million.
- The chunk load (~200 ms) blocks nothing but is not incremental — entering a road with a very large
  chunk would show up as a hitch. Paging a chunk is not built.

## DOCTRINE

- **measured** — with a 10,000-document store, standing on a road costs 500 records, 1,386 scene
  objects and 24 canvases, and best-case frame time is one vsync. The corpus does not appear in any
  of those three numbers.
- **corrected** — "bounded by what is in view" was a true bound and the wrong one. A frame budget is
  a count, not a distance. §15.3.
- **measured** — best-case frame time is flat in N to within one vsync across N=0→400, and paint
  canvases are bounded by view distance (56) rather than by N. Both in the guest, brake verified off.
- **corrected** — the median is not usable as a per-pane cost in this scene, and the first version of
  the bench quoted it as one. Frame noise is one-sided, so the minimum is the estimator.
- **measured** — five panes render on a real road in the guest at two tiers. **Not measured** — what
  a pane costs per frame; §13.1 says why the obvious instrument cannot answer it.
- **falsifiable, survived** — `{rect, line, text}` is closed. A second format with no prose in it
  fit without widening the set. Had RuneFort needed an arc or a gradient the honest move would have
  been to widen the set on the record, not to special-case one renderer.
- **measured** — a `.bend` document averages 1,067 bytes across the 20-document v0.1 corpus
  (min 300, max 4,224). A live window costs ~3 MB of VRAM for its colour target alone plus a
  process. The two are not the same kind of object and no scale claim should treat them as one.
- **corrected** — WRL Core 0.1.2 has no behaviours and cannot serve as the scripting layer. The op
  vocabulary is that layer. Cited to WRL's own README and `reference.html#tiers`, not inferred.
- **proposed** — that the road's 1-D milepost order and the district graph are already the spatial
  index, so paper roads need chunk streaming and not a tree. What would test it: §4.
- **proposed** — that keeping layout pure (no THREE, no DOM) is what makes this buildable on a host
  that cannot open a WebGL context. What would test it: rung 1 ships with a passing node test run on
  the dev host, having never touched the guest.
- **measured** — the layout half runs under `node` on a host that cannot open a GL context, and the
  painting half runs in an ordinary 2-D canvas. Neither needed the FreeBSD guest. Only rung 2 will.
- **corrected** — a passing test suite said nothing about whether edges rendered, because every
  assertion was about blocks. §11. What would have caught it earlier: asserting on the *format's own
  reason to exist* rather than on its primitives one at a time.
- **open** — where the store lives. IndexedDB is assumed in §3 on the arithmetic alone; nothing has
  been measured, and a million-row IndexedDB read pattern is not something this repo has evidence
  about.

---

*Sources consulted 2026-08-15: [Ladybird](https://ladybird.org/) and its
[FAQ](https://github.com/LadybirdBrowser/ladybird/blob/master/Documentation/FAQ.md) for the cost of a
real engine; [infinite-canvas culling](https://infinitecanvas.cc/guide/lesson-008) and
[tile-based rendering](https://infinitecanvas.cc/guide/lesson-035) for the 2-D case this one avoids;
[Gemtext](https://geminiprotocol.net/docs/gemtext-specification.gmi) and
[What is Gemini?](https://drewdevault.com/gemini.html) for §7's cautionary number.*
