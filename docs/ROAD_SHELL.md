# The road as a window manager — Tier 1

**Status: `spec`. Nothing here is built. Nothing here is ratified.**
**The scope ruling in §1 is Travis's, 2026-09-10. Everything downstream of it is a proposal.**

Author: Claude, 2026-09-10. Companion to `PAPER_ROADS.md` (the pane), `OP_VOCABULARY_DRAFT.md`
(the seam), and `super/docs/app/DESKTOP_SHELL.md` (the host).

**Revised 2026-09-10 after review.** Five things were tightened and each is recorded as a
correction in DOCTRINE rather than edited away: the live budget is separate from pose
eligibility (§4.1); a sign says three things, not one (§5.1); the capability layer is only half
the authority boundary (§6.1); the liveness wording was too absolute (§10.1); and "macOS is
easier" is a hypothesis with a test list (§11). §12 is now the single narrow proof to build
before anything accumulates around it.

---

## 0. The one-line version

**A road that manages web apps needs no new operating system, and no new primitive.** The
Tauri host, the multi-webview primitive, the per-pane authority boundary, the slot allocator,
the op seam, and the three-tier residency ladder all exist and are measured. What does not
exist is a **fourth tier — `live`** — and the manifest that says which app may stand where.

---

## 1. What was asked, and what was ruled

Asked: could a Tauri app host other apps on a T&R road, with entrance signs, exit ramps and
advert billboards, acting as a load balancer for CD-compatible apps — and would it run on a
Mac.

**Ruled: Tier 1 only.** An app on the road **is a webview**. Not a streamed native window
(compositor-proxy's job, and it stays compositor-proxy's job), and not somebody else's Mac
window driven through the Accessibility API. This ruling is what makes the macOS answer cheap
and the authority answer tractable, and §11 and §6 are downstream of it.

The consequence to state plainly: **an application that is not a web application cannot stand
on this road.** `foot`, `xterm`, Firefox-as-a-guest-window are Tier 2 and reach the road only
the way they do today, through `compositor-proxy` into a billboard texture. Tier 1 does not
replace that path and does not compete with it.

---

## 2. What already exists — measured, so no session re-derives it

Five things. Each is in the tree today; each is cited so this document can be checked rather
than believed.

### 2.1 The Tauri host, with the unstable primitive already on and already justified

`super/cockpit/` is a Tauri v2 desktop application. `super/cockpit/Cargo.toml:17` reads
`tauri = { version = "2", features = ["unstable"] }`, and the six comment lines above it say
why in the product's own words:

> `unstable` is what gates `Window::add_child` and `WebviewBuilder` — the multi-webview-per-window
> primitive. Super's browser, Motor and game panes are that primitive … It is the only reason the
> feature is on.

`super/cockpit/src/main.rs:80` draws the topology it expects — `WebView "main"` the cockpit,
`WebView "browser"` a page, `WebView "machine"` a Motor surface. **This document is that
diagram with a road under it.**

### 2.2 An external URL, in a child webview, at an arbitrary rect, with a policy on it

`super/cockpit/src/preview.rs:138` already calls `add_child` with
`WebviewUrl::External(url)`, `on_navigation(allowed)` and
`on_new_window(|_, _| NewWindowResponse::Deny)`, positions it from a caller-supplied rect,
validates that rect against the window's own size, and can `hide`/`close`/re-`navigate` it.

That is an app pane. It exists. **The remaining work is not the mechanism — it is where the
rect comes from and who is allowed to ask for it.**

### 2.3 The per-pane authority boundary, held by a gate

`super/cockpit/capabilities/default.json` grants `webviews: ["main"]` with **no `windows` key
at all**, and its description records why:

> tauri's resolver is an OR over the two lists (`ipc/authority.rs`, resolve_access), so a pane
> hosted INSIDE the cockpit window would have inherited all of this.

`capabilities/terminal.json` is the shape a pane takes: three permissions, `webviews:
["terminal"]`, no `intent`, no core permission, no fourth command. `tools/check-webview-acl.mjs`
fails if `windows` returns, and reconciles **three lists that can each drift alone** —
`generate_handler!` (registered), `build.rs` `AppManifest::commands` (in the ACL), and
`capabilities/` (granted). A command registered but absent from `build.rs` **fails open**.

Upstream now says the same thing: *"On multiwebview windows, prefer specifying webviews and
omitting windows for a fine grained access control."*

### 2.4 The slot allocator — already the placement half of a load balancer

`RRABBIT/m2/world.js` holds it and it is not a sketch:

| | |
|---|---|
| `DASH_PITCH = 180` (l.92) | the addressable grid |
| `SLOT_GAP = 4`, `SLOT_FIRST` (l.220, l.227) | window↔window spacing; the first legal dash |
| `slotAt(district, side, dash)` (l.237) | what stands here — already four occupant kinds |
| `slotFree(…, kind, ignore)` (l.258) | may a `window`/`ramp`/`paper`/`mail` stand here |
| `nextFreeSlot` / `nearestFreeSlot` (l.294, l.302) | forward-fill and outward-search |

A fifth `kind` is an entry in these functions, not a new subsystem. The two spacing rules are
deliberately **not** a shared footprint — `PAPER_ROADS.md` §22 falsified the hypothesis that
would have widened `SLOT_GAP`, so do not widen it here either.

### 2.5 The seam, built and survived its own falsification test

`RRABBIT/m2/ops.js` is `apply(op)` — one function every actor passes through. `TABLE` (l.41)
is closed and currently holds **21 ops**; `register` (l.127) injects the doing, which is what
lets `node test/ops.mjs` exercise validation, refusal, logging and replay with no GL context.

`PAPER_ROADS.md` DOCTRINE records the result: *"falsifiable, survived — the seam serves three
consumers with no per-consumer branch, asserted mechanically rather than by inspection."*

**A road shell is a fourth consumer, and the strongest evidence yet for the pending ruling in
`OP_VOCABULARY_DRAFT.md` §8.** It is also the first consumer whose actor is another program.

---

## 3. The collision, and why the existing design already survives it

**An OS child webview is an axis-aligned rectangle in window coordinates.** It cannot be
rotated 0.42 rad, cannot be perspective-projected, cannot receive a curve, and is composited
by the OS *above* the page rather than into the WebGL scene. A three.js road cannot draw one.

This looks fatal for ten seconds, and then the spec answers it. `docs/spec/README.md` §1:

> A window you are typing into is never at an angle.

and `RRABBIT/m2/paper.js:279` already has the mechanism — the read tier's DOM object stands at
**the quad's own pose**, in a CSS3D layer with its own scene and renderer but **the same
camera**, *"which is what makes reading a pane continuous with driving past it instead of a
modal that replaces the world."*

So the rule falls out rather than being imposed:

> **A live webview exists only in the read pose. At any other pose the app is a picture.**

`read` / `unread` are already the ops for entering and leaving that pose (`ops.js` l.46–47),
already plan-split correctly, and already carry `resize`, `close` and `cast` beside them
(§17 of `PAPER_ROADS.md`, table 4 → 7). **The live tier needs no new navigation verb.**

---

## 4. The residency ladder — a fourth tier

`paper.js` opens with the tier discipline and the reason for it — *"NOTHING EXPENSIVE IS
ALLOCATED UNTIL A TIER ASKS FOR IT"*, after a first version cost ~1.07 MB of canvas per pane
whether or not it would ever be read. Tier 1 adds one rung on top:

| tier | costs | what it is |
|---|---|---|
| `hidden` | nothing | on another road; holds no pixels |
| `card` | a cell in the shared atlas (1 texture / 96) | a distant sign |
| `paint` | own canvas, own texture, own material | a readable sign |
| **`live`** | **a WKWebView/WebKitGTK process** | **the app, running, in the read pose** |

**`live` is the only tier with a process behind it.** Each WKWebView gets its own WebContent
process, and per-webview memory can run to 200+ MB for a heavy page. The ladder's whole job is
to keep that number multiplied by a small integer.

### 4.1 Pose eligibility is not a resource budget

The first draft of this document said *"`live` is bounded by pose, not by policy — one read
pose, one live pane, by construction."* **That is wrong, and the shipped code already
falsifies it.** §17.1 of `PAPER_ROADS.md` records that an on-air pane must **pin its paint
tier** — `castKey` is exempt from retiering, exactly as the read pane is — because watching a
pane *while driving away from it* is the entire reason to cast one. So a tier already outlives
its pose by design, and it was made to on purpose.

Two more reasons the pose cannot serve as the budget: promotion and demotion are asynchronous,
so more than one pane can be eligible during a transition; and a hidden webview is not a paused
webview (§10.4) — a demoted pane that has not been destroyed is still spending.

**So the budget is a separate, explicit rule, and it needs three parts:**

| | v1 | why |
|---|---|---|
| **How many may be live** | **exactly 1** | the smallest number that can be reasoned about, and the only one that needs no eviction policy |
| **When one is unloaded** | on leaving the read pose, unless pinned by `cast` | matches the one exemption that already exists, rather than inventing a second |
| **How its state survives** | the app's checkpoint/resume contract (§10.4) | the shell cannot do this for the app, and must not claim to |

`N > 1` and a `resident` tier are both deliberately out of v1. Raising `N` is a resource
ruling, not a rendering change, and it must be made against a measurement (§11) rather than
against the fact that the panes happen to fit on screen.

**Agent `rest`/`wake` stay separate from all of this** — see §10.5. A pane's residency and an
agent's `quiescent`/`runnable` are two livenesses and this document does not merge them.

---

## 5. The advert sign is published, not screenshotted

The card and paint tiers need a face, and the face cannot be a screenshot of the live pane.
Two reasons, one measured and one structural:

- **Measured:** neither wry nor core Tauri exposes a webview snapshot API — it is an open
  feature request, served today only by community plugins.
- **Structural:** a shell that samples its panes' pixels is a shell that can sample its panes'
  pixels. The whole Wayland-side posture of this stack is that a surface's contents belong to
  its client.

So: **an app's sign face is something the app declares, and the paint tier draws it with the
same `{rect, line, text}` primitive set that survived a second format without widening**
(`PAPER_ROADS.md` DOCTRINE).

**And "a picture everywhere else" means an app-published representation, not a cached image of
the last live frame.** Those are different objects with different lifetimes, and the
no-screenshot decision above forbids the second one whether it comes from an API or from
keeping the last texture around.

### 5.1 Three things a sign can say, and they are not interchangeable

The first draft wrote *"the sign says what the app accepts **and whether it can take work**"* as
though those were one fact. They are not, and collapsing them is how a road ends up advertising
yesterday's capacity.

| | lifetime | who asserts it | may it show work as transferred |
|---|---|---|---|
| **Declared capability** — "accepts documents" | static; changes only when the manifest changes | the app's manifest | no |
| **Reported availability** — "two slots free" | **has an expiry**; stale unless refreshed | the app, at runtime | no |
| **Accepted** — "this task is yours" | one task, one acknowledgement | **the coordinator** | **yes, and only this** |

Rules that follow:

- **Reported availability carries a freshness stamp and is stale by default.** A sign with no
  fresh report shows the declared capability and says the availability is unknown — it does not
  show the last number it heard. *Unknown* and *zero* are different signs.
- **The entrance ramp confirms acceptance before it shows a handoff.** A ramp that animates on
  a *reported* slot is claiming a transfer that may not have happened, which is §10.9's failure
  shape — success reported at every layer, with nothing behind it.
- **The sealed arrangement captures the stable half only.** §18 of `PAPER_ROADS.md` seals a
  road's arrangement to a `sem-` id; that seal must cover layout and declared references and
  **must not** cover reported availability. Otherwise two identical roads seal differently
  because one was busier, and the id stops meaning arrangement.

### 5.2 Discovery belongs to the coordinator, not to the app

Adding `'self'` to the CSP makes an app's own `fetch('app.json')` work, and that is **not** what
§5 claims. *"Renderable before any app is live"* is not satisfied by the app reading its own
sign — that only looks like discovery because the file happens to sit in the same bundle, and
nothing about it works for an app that is not installed, not started, or not trusted to
describe itself.

**The package or the coordinator owns the manifest.** The road asks the host, the host holds the
package, and no pane need ever have existed. In `tier1-proof/` the CSP's `connect-src` is back to
`ipc:` only and the gate asserts two things statically: **the road page contains no `fetch` at
all**, and the CSP does not permit it to fetch its own origin. Both would have gone green under
the convenient fix.

So an **entrance sign** is a declared accept-clause and an **exit ramp** is a declared handoff:
both render from the coordinator's manifest, not from a running process, and a road can be laid
out and sealed **before any app is live**. What cannot be laid out ahead of time is any claim about
capacity — that has an expiry, and it belongs to the coordinator to confirm.

---

## 6. Authority — and the inversion nobody should perform by accident

The pane pattern is settled: **one capability per pane label, `webviews:` and never `windows:`,
generated from the app's manifest, reconciled by `check-webview-acl.mjs`.** `terminal.json` is
the worked example and it is three permissions wide.

**The trap is which webview is `main`.**

Today `main` is the cockpit and `capabilities/default.json` grants it twenty-two commands
including `allow-intent` — human-control authority over the runtime. If the road becomes the
shell, the road becomes `main`, and **the road would inherit all of it**. That is the exact
substitution the ACL gate was built to catch, arriving through the front door rather than as a
one-word edit.

The road does not need human-control authority. It needs placement and sign rendering. So:

- the road gets its **own, small** capability — placement, sign faces, tier transitions;
- **Super's cockpit UI becomes a pane like any other**, keeping `allow-intent` on its own
  `webviews: ["cockpit"]` grant;
- `check-webview-acl.mjs` gains one law: **no capability names more than one webview, and
  `allow-intent` names exactly one.**

Stated as a consequence rather than buried: **making the road the shell demotes the cockpit
from "the trusted surface" to "the surface that happens to hold the runtime grant."** That is
a better boundary than the one that exists, and it is a change to a boundary, which makes it
a ruling and not a refactor.

### 6.1 A small capability is necessary and not sufficient — the seam is the other half

The capability layer gates **which webview may `invoke` which Tauri command**. It says nothing
about what happens *after* one of those commands reaches `apply(op)`. If the road can submit an
op that a privileged performer executes, the small capability bought nothing: the road did not
need cockpit authority, it needed a caller who has it.

**So authorization is checked where `apply(op)` executes, against the authenticated caller and
its grants — not only at the webview boundary.** One shared seam is worth keeping; it does not
follow that every caller reaches every op. `TABLE` stays closed and global; **reachability
becomes per-actor.**

**`by` cannot be that caller.** `ops.js` l.174 is
`apply(op, { by = 'unknown', record: shouldRecord = true } = {})` — **`by` is supplied by the
caller**, defaulted to a string, and exists for the log. Keying authorization on it would be a
check you satisfy by writing its argument, which is a defect class this tree has already
recorded once. The principal has to arrive from the host side, out of the invoking webview's
identity, and the seam has to receive it as something the page cannot set.

**The test to add beside the existing seam test:**

> **Can the road request placement while being unable to acquire cockpit authority?**

Both halves must be asserted, and the refusal half must be refused by the *seam*, not by the
road's own JavaScript declining to call — the same standard `check-webview-acl.mjs` already
holds for Tauri commands, one layer down.

### 6.2 The principal — RULED 2026-09-10

> **The principal is a host-owned identity for a specific pane binding, with explicitly
> assigned grants, resolved from the injected `Webview` through a host-owned binding registry.
> A label alone is an identifier, not authority. A request must not be able to supply the
> authoritative pane label, generation, or grants.**

Five consequences, all of them load-bearing:

1. **`by` remains an untrusted log annotation.** It stays in the record because a log wants to
   know who *said* it did something. It never reaches an authorization decision.
2. **A webview label identifies a surface; it does not confer authority.** The label is how the
   host finds the binding. The grants hang off the binding, not off the string.
3. **The host checks authorization before any operation causes a side effect.** Not after, not
   alongside — a refusal that arrives after the effect is a log entry, not a boundary.
4. **Replacing or unloading a pane revokes its binding**, and a delayed operation from a
   revoked binding is rejected. This is §10.1's generation requirement arriving from the
   authority side as well as the liveness side; they are the same fact.
5. **Replaying an operation requires current authorization.** A recorded identity carries no
   authority. A track is a record of what happened, never a bearer token — which keeps replay
   honest and stops a recording from being a privilege escalation you can save to disk.

#### 6.2.0 What a request may and may not carry

| | who supplies it | why |
|---|---|---|
| the surface | **the host**, from the injected `Webview` | there is no argument to aim elsewhere |
| the grants | **the host**, at bind time, from its own table | a request never mentions them |
| the pane label | **the host**, a constant | no command takes a label parameter, and the gate asserts it |
| the **echoed** generation | the request | it is compared, never trusted — so it can only cause a **refusal**, never an elevation, and it is what makes a *recorded* op detectable as stale (#5) |

**`authorize` takes `&tauri::Webview`, not `&str`.** A string parameter is a check you can
satisfy by building its argument — any caller, including one inside the host crate, could pass a
label the page chose. Taking the injected webview puts the rule in the type system. Measured
consequence: the sabotage that fed `by` to `authorize` as the surface **no longer compiles**.
That is the hardening working, and it is also why that sabotage had to be rewritten as a
short-circuit *before* the check — a law with no writable falsifier is untested.

**Identity is pulled, not pushed.** The first build injected the road's generation with
`Webview::eval` at startup, which **races the page's own first script**: the road issued its
opening op with `generation: undefined`, was refused, and never finished loading — a blank
surface in front of a working host. The repair falls out of the ruling rather than working
around it: since the host resolves identity from the injected webview on every call anyway,
there was never anything for the page to be told. A grant-free `whoami` is the bootstrap, and it
can name only its own caller.

#### 6.2.1 The implementation check that decides whether any of this is real

**If `apply` continues to execute entirely in page JavaScript, adding a principal argument to it
establishes nothing.** The page can call the performer directly, edit the argument, or skip the
seam; a page-side check is advice to itself.

`RRABBIT/m2/ops.js` **is page JavaScript today**, and that is the whole difficulty. So the rule
this design must hold to:

> **Either the authoritative check lives in host-controlled code, or every privileged effect
> passes through a host check.** The second is the practical form here.

Which splits the seam into two things that must not be confused:

| | where | what it is for | what it can enforce |
|---|---|---|---|
| `apply(op)` — the **vocabulary seam** | page | closed op table, validation, logging, replay, refusal *feedback* | nothing, against its own page |
| the **host check** | Rust | principal → grants → allow/refuse, before the effect | everything |

The page-side seam keeps its whole existing job and is still worth having — it is what makes
recording, replay and a WRL program one code path. It simply stops being described as a
boundary. **A privileged op's performer is a Tauri command, and the refusal comes back through
the seam rather than being decided by it.**

This also settles what an unprivileged op is: one whose entire effect is inside the road's own
page (a camera move, a tier the road already owns). Those need no host round trip, and drawing
that line is a per-op decision in `TABLE`, not a global one.

---

## 7. What a CD app declares

Do not invent a fourth manifest. The portfolio already has three layers and they compose:

| layer | file | what it says here |
|---|---|---|
| **[&]** | `*.ampersand.json` | what the app composes with — its accept and produce clauses |
| **PULSE** | `*.pulse.json` | its loop: phases, cadence, the tokens it emits and consumes |
| **RuneFort** | `*.rune.json` | how its pane lays out (`runefort.com` is a layout protocol for tiled file-backed UIs — its spec dir has **no `README.md`**; see `runefort.protocol.md`) |

What is genuinely new is small and belongs in one place — call it the **road manifest**: the
entry URL, the sign face, the capability request, the tier policy, and the checkpoint/resume
contract from §10.4. Everything else is a reference into the three files above.

**Do not claim the road's tiers map onto PULSE's five phase kinds.** They do not. PULSE
sequences a loop over time; the tier ladder is a residency decision about pixels and processes.
CLAUDE.md already records this class of error for the box-and-box rungs, and it is the same
error one layer over.

---

## 8. What the load balancer actually balances

Not CPU. The shell cannot preempt a webview and should not pretend to.

Three decisions, and keeping them apart is the design:

1. **Placement** — which dash on which side. Already solved: `nearestFreeSlot` for a pane that
   was aiming somewhere, `nextFreeSlot` for a new one.
2. **Residency** — which panes hold pixels, which hold a process, which hold nothing. The tier
   ladder, driven by view distance and pose. **This is the only one with a hard resource behind
   it**, which makes it the only honest use of the word "balancing".
3. **Dispatch** — which app gets the next unit of work. A queue keyed by declared accept-clause.

> **Placement is not scheduling.** Moving a pane to another dash must not cancel, pause or
> reroute its work — and dispatching work to an app must not move its pane. The single most
> likely way to ruin this design is to let one gesture do both.

---

## 9. The signs are certificates, or they are decoration

`box-and-box` runs `feasible ▸ permitted ▸ best` over an un-weakenable safety floor, and
**every verdict ships a certificate** (210 enforced property-tested laws + 3 declared-open).
That is exactly the ramp decision:

| sign | rung | question |
|---|---|---|
| entrance sign | alethic / resource | can this app take this work at all |
| lane admission | deontic | is it permitted to |
| exit ramp choice | axiological | is it the best of the open ramps |
| a closed ramp | any refusal | **with a reason printed on the sign** |

A closed ramp that is a greyed-out button is a UI state. A closed ramp that renders a
certificate is a verdict you can argue with, and the second one is the house standard.

---

## 10. Traps already measured. This is the durable part of the document.

Each of these cost someone a session already. None is speculative.

### 10.1 A successful send does not establish that the pane got the message
Measured at D.1.3c·2c·1b·1, **restated 2026-09-10 because the first wording was too absolute.**

`Channel::send` **does** return `Result<()>` — it is not literally fire-and-forget and it can
fail. What it cannot do is confirm receipt: on the non-`tracing` path it goes
`Webview::eval` → `send_user_message` (`tauri-runtime-wry-2.11.4/src/lib.rs:1854`), which posts
to the event loop and returns without a getter, so **`Ok` is queued-for-a-live-runtime, not
received and not processed.** Checked against the published docs, which describe the method in
one sentence and state no delivery semantics at all.

`WebviewEvent` carries **one variant, `DragDrop`**, in 2.11.5 (`tauri-2.11.5/src/app.rs:202`) —
and the enum is `#[non_exhaustive]`, so this is *"there is no termination event today"*, not
*"there can never be one."* Re-check it on a version bump instead of inheriting this sentence.

**What follows for the design:**

- **Generation + acknowledgement is the mechanism.** A bind arriving while a presentation is
  open is a *positive* fact that the old renderer is gone. Acknowledgements make delivery
  observable where `Ok` does not.
- **A missed heartbeat means `unresponsive` or `unknown` — never `dead`.** Sleep, throttling, a
  busy main thread and a backgrounded display all resemble failure. Only a positive fact (a new
  bind, an explicit close, an exited process) may move a pane to `gone`.
- **An old-generation message must never regain control of a replacement pane.** Every message
  carries its generation, the host drops any that is not current, and a re-bind invalidates the
  previous one. Without this, a slow reply from a dead renderer lands in its successor — the
  worst failure available here, because both ends report success.

### 10.2 The road canvas and the pane will fight over the pointer, in both directions
`PAPER_ROADS.md` §21.2 measured that Chrome's `elementFromPoint` over a mounted read pane
returns `CANVAS#gl` — **the canvas swallows clicks meant for the DOM**. A live OS webview
inverts it: the webview is composited above the entire page, so it swallows clicks meant for
the road, and no `elementFromPoint` reaches across the boundary at all.

**Therefore `unread` must never depend on a click landing on the road behind a live pane.** Esc
already lives in the capture chain for exactly this reason — and `PAPER_ROADS.md` DOCTRINE
records that lesson being *written down in `TRACKS_HANDOFF.md` §3 and then repeated anyway*.

### 10.3 Focus has never been routed, and the conformance suite has never been keyed
§21.4: `Tab` then `Return` inside a read pane produced `last: null` — `openRead` focuses
`[tabindex="0"], a[href], h1` and a BendScript title `h1` takes no focus. Worse, stated there
in full: *"The spec-conformance suite and the running pane have never been checked against each
other with a keyboard."* A live pane makes focus routing mandatory rather than cosmetic.

### 10.4 Hiding a webview is not pausing it, and there is no portable primitive that is
`hide()` removes a webview from view. It does not stop its timers, release its process, or
checkpoint its state. macOS suspension behaviour is documented for **app** backgrounding, not
for a hidden webview in a foreground app, and the one preference in that area
(`WKSuspendInBackground`) is not a per-pane control.

**So the shell's only hard lever is destroy.** Anything softer must be cooperative: the app
implements checkpoint/resume, or a `resident` tier is a claim the shell cannot keep. This is
why §4's table stops at `live`.

### 10.5 `rest` / `wake` already mean something else
`ops.js` l.120–121: they park and wake **an agent**, setting WRL Core §20.1's
`quiescent`/`runnable` (`m2/mail/box.js`). Reusing them for pane residency would conflate an
agent's liveness with a surface's. **Either new op names, or a ruling that says the two are the
same thing.** They are not obviously the same thing.

### 10.6 On Linux, adding a child webview COLLAPSES THE PARENT — measured, and worse than reported
`preview.rs` carries the known form: *"Tauri's Linux child WebViews are packed in a vertical
GtkBox; their set_position/set_size methods do not position them inside the cockpit."* Upstream
#13071 confirms it is Linux-specific, and the fix in the tree is a GTK overlay that preserves
the IPC label.

**That undersells it.** Measured 2026-09-10 by `tier1-proof/tools/geometry-probe.mjs`, on the
harness with the workaround deliberately not ported (WebKitGTK, dpr 2):

| | |
|---|---|
| requested read rect | `x=315 y=93` **522 × 262** |
| road **before** promote | **1000 × 653** |
| pane **after** promote | **1000 × 653** — the requested rect ignored entirely |
| road **after** promote | **1000 × 1** |

**The child takes the whole window and the road collapses to one pixel.** It is not that the
pane sits in the wrong place; the road stops having a surface. Any road shell on Linux needs
the overlay from the first pane, not as a polish pass — and a session that skips it will see
the road *vanish* and reach for a rendering bug.

#### 10.6.1 CLOSED on Linux — and it took two GTK facts, both measured

`tier1-proof/src/layout.rs` ports the overlay from `super/cockpit/src/preview.rs`: the road is
moved into a `GtkOverlay` once, and every pane is an overlay child. **Result: road 1000 × 653,
pane 522 × 262 — the requested rect exactly.** Two things the port had to learn that the cockpit
does not need, because its pane is meant to fill the area it is given and ours is a read pose of
a stated size:

- **`set_size_request` is a MINIMUM, and a WebKitWebView's natural size exceeds it.** With
  alignment and margins alone the pane ran from its margin to the far edge: requested 522 × 262
  at (315, 93), allocated **685 × 560** = (1000−315) × (653−93). Turning `hexpand`/`vexpand` off
  did not change it. `get-child-position` is the only place in GTK3 that states an overlay
  child's allocation outright, so the read pose is expressed there.
- **Margins are applied INSIDE the allocation you return, so they are subtracted twice.**
  Returning `(margin_start, margin_top, size_request)` produced **207 × 169**, and 522−315 = 207,
  262−93 = 169. The numbers name the defect. The position belongs in the returned rectangle;
  the margins are zero.

#### 10.6.2 The read pose is reached ASYNCHRONOUSLY, and that is a design fact

Measured: the pane is created at full window size and GTK re-allocates it afterwards —
**~2.8 s to settle** in this harness. A check made the instant `promote` returns reads
1000 × 653; a check after settling reads 522 × 262. Both are true and only one is the claim.

**A road that draws its own chrome will see that first frame.** The window is named here rather
than slept through, and the battery's assertion carries its deadline in its own name.

The corollary bit twice. Sabotage S5 removes the layout call, and the *road* assertion **passed**
under it while measured immediately after `promote`, because the road is still full-size for the
moment before GTK re-allocates. It survived only because the pane assertion failed beside it.
**A geometry assertion made before layout has settled is not a geometry assertion**; both are
now measured after the pane settles, and S5 reddens both.

**The same probe is the macOS test.** On NSView subviews the prediction is the parent stays
1000 × 653 and the child is 522 × 262. One command, and §11 stops being a hypothesis on this
axis. Until it is run, it has not been run.

### 10.7 The UI is baked into the binary
`tauri.conf.json` has `"frontendDist": "ui"`, so `generate_context!` embeds the bytes. Editing
`cockpit/ui/*.js` and re-running changes **nothing**. Cost one full battery run against a file
that plainly defined the missing function. **Always `cargo build --release` after touching the
UI.** For a road whose panes are separate dev servers this will bite twice as often.

### 10.8 The multiwebview API is unstable, and its open bugs are the ones this design leans on
Resize stops working after repeated window resizes (#10131), positioning is lost across
maximize/restore (#11170), the four-corner example stacks vertically (#10420). A road that
repositions panes every frame is the worst case for all three. **Budget for them; do not
discover them.**

### 10.9 An op that reports success at every step and shows nothing
§17.1 — casting a pane returned `ok` at three layers while the screen stayed on the default
panel. *"Three separate layers each answered 'yes' about a thing none of them could show."*
A pane that reports `live` is worth exactly nothing until something reads the rect.

---

## 11. macOS

Tier 1 is what makes this section short. **It is a hypothesis with a test list, not a
finding.** The first draft said "macOS is the easier side"; one deleted workaround does not
establish that, and the section is written as a claim to be falsified.

**The hypothesis:** *Tier 1 ports to macOS with no new mechanism, and the Linux-specific
positioning workaround is removed rather than replaced.*

**What supports it:**
- Tauri targets macOS natively; the webview is WKWebView via wry.
- §10.6's GTK overlay exists because Tauri's Linux child webviews are packed in a vertical
  GtkBox and ignore `set_position`; upstream (#13071) confirms it is Linux-specific and macOS
  uses NSView subviews. **This is the one piece of evidence, and it is about one axis.**
- No transparency is required. A road inside an ordinary window avoids `macOSPrivateApi`
  entirely — which matters, because transparency on macOS has historically required it (and
  that disqualifies App Store submission), with an open bug where it is lost after a DMG build
  (#13415).
- Signing and notarization are a documented path.

**What must be measured before the hypothesis is accepted** — none of these can be argued from
Linux, and each has been a real source of divergence in WKWebView:

| | why it is on the list |
|---|---|
| **focus** | §10.3 — focus routing has never been built on either platform, and WKWebView's first-responder rules are its own |
| **typing / IME** | a live pane is the first surface here that takes text |
| **resize** | #10131 and #11170 are the multiwebview resize and maximize/restore bugs |
| **display scaling** | backing-scale and the `scale_factor` the rect maths in `preview.rs` already depends on |
| **storage** | see the caveat below |
| **recovery** | §10.1's generation + heartbeat, against a *real* WKWebView termination |

**Storage — a correction to the first draft.** `dataStoreIdentifier` on `WebviewBuilder` is
**macOS 14+ and iOS 17+, and unsupported on Windows, Linux and Android.** It initialises a
`WKWebsiteDataStore` with a UUID so cookies and website data land in a per-identifier directory
rather than the shared one. **That is website-data separation, not per-pane security
isolation** — it is not a sandbox, not a process boundary, and not a substitute for the
capability work in §6. Describing it as isolation was an overstatement.

**Frame rate is a measurement, not a headline.** There are reports of a 60 fps cap on macOS
with ProMotion reachable only through a private-API plugin, and WebKitGTK separately masks its
renderer string and can hand back a software rasterizer without saying so. Both are reasons to
**measure this scene** — 1,386 scene objects and 24 canvases at the ten-thousand-document rung
(`PAPER_ROADS.md` §15) — not to name a principal risk in advance.

**Not in scope, by the ruling:** other applications' Mac windows. That was Tier 3 and it is
closed.

**iPad is a different product.** Tauri v2 does build for iOS, multiwebview is unstable there,
and iPadOS has no free window placement. One road, one pane, or don't.

---

## 12. The one narrow proof — BUILT AND GREEN, 2026-09-10

**`RRABBIT/tier1-proof/` — 25 held · 0 failed, static gate 15 held · 0 failed, and all five
sabotages are falsifiers.**

**The first report of this said 23 · 0 with geometry listed as "not measured", and that was the
wrong shape.** Geometry is half the central promise — a road that collapses to one pixel when a
pane goes live has not performed the transition, whatever the authority assertions say. The
read pose is an **acceptance gate** now (§12.1, 2b), not a diagnostic beside one, and the
`geometry-probe` remains only as the platform instrument and the macOS contract.

The rest of this section is what it was specified to do; §12.6 is what it actually found.

**Build exactly one transition and nothing else:**

```
published sign  →  read pose  →  LIVE pane  →  leave read pose  →  published sign
                                     │
                              state preserved
                          stale messages rejected
```

This is the central claim of the whole document. Everything in §§4–9 is arranged around the
promotion and demotion of a single pane, so if that round trip is not sound, the remaining
decisions would accumulate on top of an unproven transition — which is the reason to build this
first rather than the manifest, the dispatch queue, or a second pane.

### 12.1 What the proof must assert

Nine assertions. A screenshot is not one of them — §10.9 records three layers reporting success
over a screen showing nothing, and this transition has exactly that shape.

| # | assertion | fails if |
|---|---|---|
| 1 | the sign renders from the **published** representation, with no live pane in existence | anything reads a texture or a snapshot |
| 2 | `read` promotes exactly one pane to `live`; the child webview exists at the read rect | the rect is wrong, or two are live (§4.1) |
| 3 | pointer and keyboard reach the **pane** while live | §10.2 — the road canvas is still taking the clicks |
| 4 | `unread` demotes: the webview is destroyed and the **published** sign is back | the last frame is kept as the picture (§5) |
| 5 | **state survives the round trip**, via the app's checkpoint/resume — not via the shell | the shell is holding the app's state for it (§10.4) |
| 6 | every host→pane message carries a generation; the pane rejects any that is not current | a stale message is accepted |
| 7 | after demote+promote, a message from the **old** generation is dropped by the host | §10.1 — a dead renderer's reply lands in its successor |
| 8 | a missed heartbeat reports `unresponsive`, and only a positive fact reports `gone` | a sleeping pane is declared dead |
| 9a | the road **successfully performs an allowed placement op** | the allowed half is untested and 9b proves only that nothing works |
| 9b | the **host** refuses a privileged op from the road **even when the request claims `by: 'cockpit'`** | `by` reached a decision, or our JavaScript declined instead of the host refusing |
| 9c | after re-binding, a **captured old-generation** request is rejected | §6.2 #4 — a revoked binding still acts |

### 12.1a The gate is five sabotages now, and one of them is why geometry is a gate

A botched edit injected **two** sabotages into the harness by accident — an authority bypass and
a skipped layout call. **The static gate caught the authority one before any test ran.** Nothing
static could catch the other; only the live geometry assertion found it, and it was found only
because geometry had just been promoted from a note to a gate. That is the argument for the
promotion, made by accident and kept.

### 12.2 The sabotage each assertion owes

The cockpit's own standard, applied here: an assertion that cannot be made to fail has not been
tested. Each sabotage below states **which failure it actually exercises**, because two of them
were originally one and the pair do not test the same thing.

| sabotage | exercises | must read |
|---|---|---|
| delay a heartbeat past the timeout | a slow or throttled pane | `unresponsive`, **never** `gone` |
| replay a captured old-generation request after a re-promote | a revoked binding (§6.2 #4) | rejected by the host |
| forge `by: 'cockpit'` on a privileged op from the road | `by` reaching a decision | refused by the host |
| **kill the pane's dev server while live** | **source availability only** | the road must not upgrade this to `gone` |
| **terminate the renderer / tear the pane down under control** | **renderer death** | `gone`, by a positive fact |
| flip the pane's capability to `windows:` | the ACL gate | `check-webview-acl.mjs` red |

**The dev-server kill and the renderer termination are different tests and the first was
mislabelled.** An already-loaded page keeps running with its origin gone: nothing is fetched, so
nothing fails, and a pane that never reloads may be perfectly healthy for hours. Treating that
as death would make every restarted dev server look like a crash. It is kept — it is a real
condition the road must not over-read — but the renderer-death assertion needs its own,
positive-fact test beside it.

### 12.3 Where it is built, and why not in the cockpit

**In its own harness, not by re-rooting `super/cockpit/`.** §13 #1 — whether the road becomes
`main` and demotes the cockpit — is unruled, and re-rooting the cockpit to run this proof would
answer it by accident, which is precisely the front-door inheritance §6 warns about. A
standalone harness proves the transition without touching the boundary, and the ruling stays
open until it is made deliberately.

### 12.3a What the build settled

- **`tauri::Webview` is injectable as a command argument**, so the principal really is derived
  by the host from the actual invoking webview. That is the mechanism §6.2 needs and it is
  confirmed by the compiler, not by reading docs.
- **The ACL layer and the seam are independently observable.** `capabilities/road.json` grants
  `allow-privileged-intent` to the road on purpose; the road invokes it and the *host* refuses
  with `PRINCIPAL_GRANT_NOT_HELD`. An assertion checks the refusal is not tauri's resolver, so
  the two layers cannot be confused for one another.
- **`N = 1` is enforced where it can refuse**, not where it is convenient: a second `promote`
  returns `TIER_ALREADY_LIVE` from the host.
- **`gone` never comes from a clock.** `liveness` takes the caller's measured `present` fact;
  the timeout can only produce `unresponsive`. Sabotage S3 makes the clock say `gone` and the
  battery reddens.

### 12.4 Then, and only then

1. The manifest and a second pane (§7), with **two** capabilities generated rather than
   hand-written and §6's one-webview law added to the gate.
2. The seam-authorization test from §6.1 — *can the road request placement while being unable
   to acquire cockpit authority?*
3. The same nine assertions on a Mac, plus §11's six-row measurement table, **before** anything
   is built on top of the Mac result.

### 12.5 What would falsify the whole approach

**A consumer that needs a special case at the seam.** That is `OP_VOCABULARY_DRAFT.md` §9's
test; it passed with three consumers, and a road shell is the fourth. If placing and tiering a
live pane cannot go through `apply`, the seam is wrong and this document is wrong with it.

### 12.6 Traps the build paid for, and two of them are about the design

**A CSP that names `connect-src` for IPC blocks an app from fetching its own manifest.**
`connect-src ipc: http://ipc.localhost` — copied from the cockpit, where it is correct —
excludes `'self'`, so `fetch('app.json')` throws `TypeError: Load failed`. The symptom is a
page that never becomes ready **with nothing in the console**, while `window.__TAURI__` and the
host-injected generation are both fine, which reads exactly like a load-order bug. This one is
not incidental to the harness: **§5 makes every CD app's sign a fetched manifest**, so the road
shell would have met it on its first app.

**A battery that is not idempotent reports its previous run.** WebDriver's `/value` appends,
and the pane's `localStorage` outlives the application, so the second run typed into an already
full field. It was invisible while the suite was green — **the sabotage sweep is what exposed
it**, because four sabotages each reddened two assertions they do not touch. Collateral damage
in a sabotage is a defect in the instrument, and the sweep is the only thing that shows it.

**Restoring the source is not restoring the artifact.** `sabotage.sh` put the source back and
did not rebuild, so the next battery run measured the sabotaged binary and reported two
refusals that had already been fixed. Same class as §10.7 — `frontendDist` bakes the UI in —
and the rule is the same: **`cargo build --release` after every change, including after an
undo.**

**A `str.replace` that matches nothing still prints success.** Two edits in this build reported
themselves done and had changed nothing: the CSP revert, and a batch of tool edits lost to a
quoting error. One of them I then stated as fact in a message. **Every replacement asserts its
anchor now**, and the static gate is what caught the CSP claim rather than any reading of it.

**A sweep that greps for a named failure must distinguish "green" from "red elsewhere."** The
first version printed *"the battery stayed green over a broken law"* whenever its pattern
missed — and it missed on two sabotages that **had** reddened the battery, just not on the line
the pattern named. A sweep that reports a red run as green retires a law that is in fact tested.
Three outcomes now: falsifier, red-but-not-on-the-named-law, or genuinely green.

---

## 13. [TRAVIS] decisions this document does not make

1. **Does the road become `main`, demoting the cockpit to a pane?** (§6. It is a boundary
   change, so it is a ruling.)
2. **New op names for tier transitions, or is a pane's residency the same fact as an agent's
   `quiescent`/`runnable`?** (§10.5.)
3. **Is the road manifest a fourth file, or a section inside the [&] manifest?** (§7.)
4. **Does the op vocabulary ruling in `OP_VOCABULARY_DRAFT.md` §8 now cover a *program* as an
   actor?** Every consumer so far has been a human, a replay, or a WRL script inside the shell.
   A CD app dispatching work through the seam is the first actor outside it.
5. ~~**What is the authenticated principal at the seam?**~~ **RULED 2026-09-10 — see §6.2.**
   A host-owned identity for a specific pane binding, with explicitly assigned grants, derived
   by the host from the invoking webview and its current binding generation; the page can
   supply neither. The consequence that reshapes the build is §6.2.1: a page-side `apply`
   cannot enforce this, so every privileged effect passes through a host check.
6. **Is the live budget `N = 1`?** (§4.1 proposes it for v1. Raising it is a resource ruling
   against a measurement, not a rendering change.)
7. **May a live pane load an external origin?** `preview.rs` allows it with `on_navigation`;
   a CD app arguably should be served from a custom URI scheme
   (`register_asynchronous_uri_scheme_protocol`) instead. These are different threat models.

---

## DOCTRINE

- **measured** — the Tauri host, the multi-webview primitive, the external-URL child webview
  with a navigation policy, and the per-webview ACL gate all exist in `super/cockpit/` today.
  The primitive is not a proposal; `Cargo.toml:17` turns it on and says why.
- **found** — an OS child webview is an axis-aligned rectangle and cannot be drawn into a
  three.js scene. The existing read pose already resolves it: **live only in the read pose, a
  picture everywhere else.** No new navigation verb is required.
- **proposed** — a fourth tier, `live`, above `hidden`/`card`/`paint`. What would test it: §12.
- **corrected** — "`live` is bounded by pose, not by policy" was wrong, and `cast` already
  falsifies it: an on-air pane pins its paint tier and outlives its pose on purpose
  (`PAPER_ROADS.md` §17.1). **Pose eligibility is not a resource budget.** The budget is a
  separate rule — how many, when unloaded, how state survives — and v1 is `N = 1`.
- **corrected** — "what the app accepts **and** whether it can take work" was one sentence over
  two facts with different lifetimes. **Declared / reported-with-an-expiry / accepted** are
  three things; only the coordinator's acceptance may show work as transferred, and only the
  declared half may enter the sealed arrangement.
- **found** — a small road capability gates `invoke` and nothing downstream of it. **The seam is
  the other half of the boundary**, and `by` cannot be the principal: `ops.js` l.174 lets the
  caller supply it. A check you satisfy by writing its argument is not a check.
- **ruled** (Travis, 2026-09-10, §6.2) — the principal is a **host-owned identity for a pane
  binding**, derived from the invoking webview and its current generation, with grants the page
  can neither supply nor override. `by` stays an untrusted log annotation; a label identifies a
  surface and confers nothing; revoking a binding rejects its delayed operations; and **a
  recorded identity carries no authority**, so replay needs current authorization.
- **found** — the ruling does not survive a page-side seam. `ops.js` is page JavaScript, and a
  principal argument added to it is advice a page gives itself. **The vocabulary seam (page) and
  the authority check (host) are two things**; the first keeps its whole job and stops being
  called a boundary.
- **corrected** — "kill the pane's dev server" was labelled a renderer-death test and is not
  one: an already-loaded page keeps running with its origin gone. It exercises **source
  availability**, and renderer death needs its own positive-fact test beside it.
- **found** — making the road `main` would hand it the cockpit's twenty-two-command grant,
  including `allow-intent`, through the front door. The gate that exists catches the one-word
  edit and would not catch this.
- **corrected** — "`Channel::send` is fire-and-forget" was too absolute. It returns
  `Result<()>` and can fail; what it cannot do is establish **receipt or processing**, because
  the non-`tracing` path posts to the event loop without a getter. And `WebviewEvent` is
  `#[non_exhaustive]` — one variant *today* (2.11.5), not one variant forever. Re-check on a
  version bump.
- **found** — a missed heartbeat is `unresponsive` or `unknown`, never `gone`; sleep and
  throttling resemble failure. And **an old-generation message must never reach a replacement
  pane** — that is the failure where both ends report success.
- **measured** — no wry or core-Tauri webview snapshot API exists. **The sign face is published
  by the app, not sampled from it** — which is also the answer that makes an advert an advert.
- **found** — hiding a webview is not pausing it and there is no portable primitive that is.
  The shell's only hard lever is destroy; anything softer is a cooperative contract.
- **found** — `rest`/`wake` are already an agent's `quiescent`/`runnable`. Reusing them for pane
  residency conflates two different livenesses.
- **hypothesis, not finding** — "macOS is the easier side." One deleted Linux workaround is
  evidence about **one axis**. Focus, typing/IME, resize, display scaling, storage and recovery
  are unmeasured, and §11 is written as a claim to falsify.
- **corrected** — `dataStoreIdentifier` is **macOS 14+ / iOS 17+, unsupported elsewhere**, and
  it separates **website data**, not processes. Calling it per-pane security isolation was an
  overstatement; it is not a substitute for §6.
- **proposed** — placement, residency and dispatch are three decisions and only residency has a
  hard resource behind it. What would test it: a gesture that moves a pane must leave its queue
  position unchanged, and a dispatch must leave its dash unchanged.
- **not measured** — what the 3D road costs in WKWebView, whether the reported 60 fps cap binds
  it, and how many `live` panes a Mac tolerates. All three are first-week measurements and none
  of them can be argued from here. **The reported cap is not promoted to the principal Mac risk
  until this scene is measured.**
- **measured** — §12's round trip is **built and green**: `RRABBIT/tier1-proof/`, **25 held · 0
  failed**, static gate **15 held · 0 failed**, and **all five sabotages are falsifiers**. Sign
  published by the coordinator (not sampled, not fetched by the app), one live pane at the
  requested rect with the road intact, real clicks and keys into it, app state surviving
  destroy+recreate with the host holding no copy, and every stale generation refused by the host
  in both directions.
- **corrected** — the first report called that green while geometry was failing. **Geometry is
  half the central promise, so it is an acceptance gate, not a diagnostic.** A road that
  collapses to one pixel has not entered the read pose whatever the authority suite says.
- **measured** — §10.6 is **CLOSED on Linux**: road 1000 × 653, pane 522 × 262. It took two GTK
  facts, both of which the cockpit's port does not need — `set_size_request` is a minimum a
  WebKitWebView's natural size exceeds (685 × 560), and margins are subtracted a second time
  inside the allocation you return (207 × 169 = 522−315 by 262−93).
- **found** — the read pose is reached **asynchronously**, ~2.8 s here, full-window at first
  paint. A road drawing its own chrome will see that frame. And **a geometry assertion made
  before layout settles is not one**: measured early, the road check passed under the sabotage
  that removes the layout call.
- **found** — pushing identity into a page RACES its first script. `eval` at startup left the
  road issuing its opening op with `generation: undefined`. **Pull, not push** — and it falls out
  of §6.2, since the host resolves identity per call anyway.
- **found** — `authorize` taking `&tauri::Webview` rather than `&str` made one sabotage
  **uncompilable**. Hardening working; and a law with no writable falsifier is untested, so the
  sabotage moved to a short-circuit before the check.
- **found** — an accidental edit injected two sabotages at once. The static gate caught the
  authority one before any test ran; **nothing static could catch the geometry one.**
- **measured** — `tauri::Webview` is injectable as a command argument, so the principal is
  genuinely host-derived from the invoking webview. §6.2 has a mechanism, not just a rule.
- **found** — a CSP naming `connect-src` for IPC **blocks the app from fetching its own
  manifest**, and fails as a page that never becomes ready with an empty console. §5 makes
  every CD app sign a fetched manifest, so this is the road shell's trap and not the harness's.
- **found** — a green suite proves nothing about its own idempotence. `/value` appends and
  `localStorage` outlives the app; the **sabotage sweep** exposed it by reddening assertions the
  sabotages do not touch. Collateral in a sweep is a defect in the instrument.
- **found, again** — restoring source is not restoring the artifact. The sweep left the
  sabotaged binary in `target/release` and the next run measured it. §10.7, one directory over.
- **measured, and worse than the tree recorded** — on Linux `add_child` gives the child the
  WHOLE window and collapses the parent to **1000 × 1**: the road stops having a surface, rather
  than merely sitting behind a mis-placed pane. §10.6 has the numbers;
  `tier1-proof/tools/geometry-probe.mjs` is the instrument, and **it is also the macOS test** —
  the prediction there is parent 1000 × 653, child 522 × 262.
- **found** — the authority suite stayed 23/23 green through that, because it asserts nothing
  about geometry. That is the separation working: a platform defect must not be able to redden
  an authority battery, and it did not.
- **not measured** — an actual renderer crash (only controlled teardown), source unavailability
  (there is no dev server), and **anything at all on macOS**. `tier1-proof/tools/geometry-probe.mjs`
  is the macOS contract in one command: parent 1000 × 653, child 522 × 262.
