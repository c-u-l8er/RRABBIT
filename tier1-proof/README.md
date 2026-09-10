# Tier 1 proof

**One road, one pane, one transition.** `../docs/ROAD_SHELL.md` §12.

```
published sign  →  read pose  →  LIVE pane  →  leave read pose  →  published sign
                                     │
                              state preserved
                          stale messages rejected
```

**Result, 2026-09-10: 25 held · 0 failed, all five sabotages are falsifiers.**
Static gate: 15 held · 0 failed. Geometry is an **acceptance gate**, not a note:
road 1000 × 653, pane 522 × 262 at the requested rect.

```bash
cargo build --release && node tools/check-acl.mjs && node tools/proof-battery.mjs
node tools/geometry-probe.mjs      # the platform measurement, kept out of the suite
```

`tools/sabotage.sh` breaks one law at a time and requires the battery to go red. It reports
**three** outcomes — falsifier, red-but-not-on-the-named-law, or genuinely green — because the
first version called a red run green whenever its grep pattern drifted, and it drifted twice.

An accidental edit once injected two sabotages at the same time. The static gate caught the
authority one before any test ran; **nothing static could catch the skipped layout call.** Only
the live geometry gate found it, which is the argument for geometry being a gate.

---

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

## Not exercised, named rather than implied

- **Source availability** (kill the dev server). There is no dev server here — the UI is baked
  in — so the condition cannot arise. Unproven.
- **An actual renderer crash.** Only controlled teardown was exercised. Unproven.
- **Anything on macOS.** Nothing in this harness has been run on a Mac.
