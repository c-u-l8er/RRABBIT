# Tier 1 proof

**One road, one pane, one transition** — and then **two apps across that boundary**.
`../docs/ROAD_SHELL.md` §12 and §12.4a.

```
published sign  →  read pose  →  LIVE pane  →  leave read pose  →  published sign
                                     │
                              state preserved
                          stale messages rejected
```

**Checkpoint repaired 2026-09-12.** The clean-tree receipt for `43c8b60` failed its
handoff stage. The final sabotage executable had survived restoration because its
source timestamps were restored too, so Cargo considered that executable fresh.
The sweep now restores with fresh timestamps, propagates failures, and runs the
handoff battery against the restored executable. Cite the dated receipt for the
tested revision and counts; this header is not a substitute for a complete run.

Geometry is an **acceptance gate**, not a note — road 1000 × 653, pane 522 × 262 at
the requested rect — and so is **containment**: across 73 samples taken from the
pane's creation through its settling, it is never visible or interactive outside
that rectangle. The host holds it contained ~2.7 s, then reveals it in one step.

```bash
node tools/verify.mjs              # every instrument, one command, writes a receipt
node tools/verify.mjs --sweep      # …and the sabotage sweep (~20 min)
```

`verify` runs each stage below, writes `receipts/VERIFY-<stamp>.md` with the commit, the host's
capabilities and every count, and **states what it skipped and why** — a stage the host cannot
run is a gap, not a pass, and the summary refuses to say "all held" when anything was skipped.
The pieces still run standalone:

```bash
cargo build --release && cargo test --release   # the registry invariants, no renderer needed
node tools/check-acl.mjs           # the static gate: three lists agree, no capability names a window
node tools/proof-battery.mjs       # the round trip, containment, the authority boundary
node tools/handoff-battery.mjs     # two apps, one live pane: routing, acceptance, eviction
node tools/geometry-probe.mjs      # the portable geometry contract — also the macOS gate
node tools/renderer-crash.mjs      # SIGKILL the pane's renderer; read what the host makes of it
node tools/pose-screenshot.mjs     # WHERE the pane is, in pixels (needs a display + ImageMagick)
bash tools/sabotage.sh             # break one law at a time; the battery must go red
node --test tools/verification-result.test.mjs # reporting, process exits, sweep completeness
```

`tools/sabotage.sh` breaks one law at a time and requires the relevant battery to go red —
ten of them now, three against the handoff. It reports
**three** outcomes — falsifier, red-but-not-on-the-named-law, or genuinely green — because the
first version called a red run green whenever its grep pattern drifted, and it drifted twice.

An accidental edit once injected two sabotages at the same time. The static gate caught the
authority one before any test ran; **nothing static could catch the skipped layout call.** Only
the live geometry gate found it, which is the argument for geometry being a gate.

---

## The second proof — two apps, one live pane

`tools/handoff-battery.mjs`. Two packages in the coordinator's
catalogue: `notes` (accepts `document`, produces `summary`) and `digest` (accepts `summary`,
produces **nothing**). Both signs render with **zero** live panes; routing reads the
declaration and refuses an unroutable kind by name; the ledger stays empty while an app works,
and the road has *nothing to route* until the coordinator accepts; eviction is how the second
app stands; `digest` is never granted `offer` and the host refuses it when it tries; each app
keeps its exact state across being evicted for the other; and there is **at most one live pane
at every observation**. These sample apps share an origin and use package-prefixed storage
keys. That prevents accidental key collisions; it does not prevent one app reading another's
storage. The earlier claim of cross-app storage confidentiality is retracted.

`N = 1` was not a blocker here and assuming it would be is worth naming: the budget limits
*simultaneous* live panes, and two apps, routing, eviction, state and sequential promotion are
all provable under it.

**A grant derived from a declaration** is the piece worth keeping: `packages::grants_for` reads
the manifest's `produces` and grants `offer` only where something is produced, with the instance
capability mirroring it — so what an app may do is a consequence of what it said it was. That
refusal is defended at three layers, and the sabotage that falsifies it has to dismantle all
three.

## What this is not

- **Not the road.** No three.js, no dashes on a curve, no LOD atlas. The road here is DOM,
  because what is under test is the **transition** and the **authority boundary**, not the
  rendering. A harness that also had to be the road would prove neither first.
- **Not a branch of `super/cockpit`.** §13 #1 — whether the road becomes `main` and demotes the
  cockpit — is unruled, and re-rooting the cockpit to run this would answer it by accident.
- **Not a product.** Nothing here ships. It exists to make one claim falsifiable.

## The two seams, which is the whole point

| | where | what it does | what it enforces |
|---|---|---|---|
| `apply(op)` in `ui/index.html` | page | closed table, validation, log, refusal **feedback** | nothing, against its own page |
| `authorize()` in `src/principal.rs` | host | principal → grants → allow/refuse, **before the effect** | everything |

The principal is host-derived: every command takes `webview: tauri::Webview`, which Tauri
injects from the **actual invoking webview** — the page cannot supply or forge it. `by` is
carried on the op record for the log and never reaches `authorize`; `tools/check-acl.mjs`
greps the authority module to prove the word does not appear in it.

**`capabilities/road.json` grants `allow-privileged-intent` to the road on purpose.** The ACL
layer is already proven by `super/cockpit`'s battery; what is under test here is the seam
check, so the road must be *able* to invoke and be refused by the principal instead.

## Layout

```
build.rs              every command declared to the ACL (fails OPEN if one is missing)
capabilities/         one capability per webview; `webviews:` and never `windows:`
src/principal.rs      the ruling — bindings, generations, grants, refusal codes
src/main.rs           the commands; each authorizes before any effect
ui/app.json           the app's manifest, including its PUBLISHED sign
ui/index.html         the road: the page-side vocabulary seam, and the sign renderer
ui/pane.html          a CD app: beats, holds its own state, knows its own generation
tools/check-acl.mjs   the static gate
tools/proof-battery.mjs   the live battery — real WebDriver clicks and keys
tools/sabotage.sh     four broken laws; each must turn the battery red
```

## Traps this harness paid for

1. **A CSP that names `connect-src` for IPC blocks the app from fetching its own manifest.**
   `connect-src ipc: http://ipc.localhost` excludes `'self'`, so `fetch('app.json')` throws
   `TypeError: Load failed` — and the symptom is a page that never becomes ready, with nothing
   in the console. `__TAURI__` and the host-injected generation were both fine, which is what
   made it look like a load-order problem. **Every CD app manifest is a fetch**, so this would
   have hit the road shell on its first app.
2. **`/value` appends, and localStorage outlives the app.** The battery typed into an already
   full field on its second run and reported the previous run. It went unnoticed while the
   suite was green and was exposed by the sabotage sweep — four sabotages each reddened two
   assertions they do not touch. `typeInto` clears first.
3. **Restoring the source is not restoring the artifact.** `sabotage.sh` put the source back
   without rebuilding, so the next battery run measured the sabotaged binary. Same class as
   ROAD_SHELL.md §10.7: `frontendDist: "ui"` bakes the UI in, so **`cargo build --release`
   after every change**, including after an undo.
4. **`set_size_request` is a minimum, and margins are subtracted twice.** Two rounds of the read
   pose: alignment alone gave 685 × 560 (margin to far edge), and returning the margins in the
   overlay's child position gave 207 × 169 — which is 522−315 by 262−93. The position goes in
   the rectangle `get-child-position` returns; the margins are zero. `src/layout.rs` has both.
5. **The read pose is asynchronous.** ~2.8 s to settle here; the pane is full-window at first
   paint. A check made the instant `promote` returns reads 1000 × 653 — and *passed* under the
   sabotage that removes the layout call. Both geometry assertions are measured after settle.
6. **Pushing identity into a page races its first script.** Injecting the generation with
   `eval` at startup left the road issuing its opening op with `generation: undefined` and never
   finishing load. `whoami` is the bootstrap: the page asks, because the host resolves identity
   from the injected webview on every call anyway.
7. **A `str.replace` that matches nothing still prints success.** Two edits reported themselves
   done and changed nothing, and one was then stated as fact. Every replacement asserts its
   anchor; the static gate is what caught the false one.
8. **A synchronous `#[tauri::command]` runs on the main thread.** A command that waits for GTK
   to allocate blocks the layout pass it is waiting for — the overlay sat at GTK's
   never-allocated sentinel `(-1,-1,1,1)` for the full deadline, every time, while `place` and
   `allocation` both *succeeded* (`with_webview` runs inline when already on the main thread).
   Every instrument answered; only the layout never happened. `async fn` is the fix.
9. **Contained means opacity 0 + insensitive, not hidden.** A GTK widget that has never been
   shown is never laid out, so hiding it means waiting for an allocation that cannot arrive.
10. **A difference of two captures is not a position measurement.** Clicking `read` also hides
   the sign and rewrites the status block, so the changed region came back `1915x1386` —
   essentially the whole window. The pane has to **identify itself**: it paints a colour that
   appears nowhere else, and the bounding box of that colour is the rectangle. (Capture caveats:
   this box is GNOME/Wayland with no `grim`, so the app is launched `GDK_BACKEND=x11` and read
   through XWayland — the layout is backend-independent, the capture path is not the shipping
   one. `import -window root` and `-window <title>` both fail here; the window id from
   `_NET_CLIENT_LIST` is what works.)
11. **A renderer crash deletes the WebDriver session** — `invalid session id: session deleted
   because of page crash or hang`. The crash cannot be watched through the channel that set it
   up, so the road records the timeline into its own `localStorage`, a later session reads it
   back, and the road drives its own recovery because nothing else can still reach the host.
12. **Each webview gets its own `WebKitWebProcess`.** The road's and the pane's are separate —
   which is why a pane crash does not take the shell down, and is worth knowing before assuming
   it.
13. **`whoami` takes no echoed generation**, so a reusable label leaks: an instance that
   outlived its `close()` could resolve the name to the *successor's* binding and stop being
   old. A pane label is `pane-<generation>`, never reused, with its capability minted per
   instance at runtime — a static capability file cannot express that.

## Not exercised, named rather than implied

- **Source availability** (kill the dev server). There is no dev server here — the UI is baked
  into the binary — so the condition cannot arise. Reaching it needs a pane loaded from an
  **external origin**, and whether a live pane may do that is **ROAD_SHELL.md §13 #7, an open
  [TRAVIS] decision**. Building it would answer that ruling by accident, which is the reason
  this harness is standalone in the first place. **Blocked on a ruling, not on effort.**
- ~~An actual renderer crash.~~ **MEASURED** — `tools/renderer-crash.mjs`, 12 held · 0 failed.
  `SIGKILL` to the pane's own `WebKitWebProcess`: `unresponsive` and never `gone` while the dead
  pane is left alone, `present` true throughout, the road untouched and still answering,
  WebKitGTK does not respawn it, and demote-then-promote recovers into a new instance.
- ~~The pane's on-screen position.~~ **MEASURED** — `tools/pose-screenshot.mjs`:
  `1044x524+630+186` against an expected 1044 × 524 at (630, 186), **delta 0 on all four**.
  It is a bench instrument, not a gate: it needs a real display, an X server and ImageMagick.
  Pictures in `../docs/tier1-read-pose.png` (what a person sees) and
  `../docs/tier1-read-pose-probe.png` (the self-identifying frame the measurement reads).
- **Anything on macOS.** Nothing here has been run on a Mac. macOS is an **explicitly
  unverified target**, and its runtime check is a **release gate, not a development blocker**.
  CI compiles and unit-tests on `macos-14` and prints on every run that it validated no
  geometry, no containment and no input — `tools/geometry-probe.mjs` is the real gate, in one
  command, on any Apple Silicon Mac (borrowed or hosted will do).
