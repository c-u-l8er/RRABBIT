# Tracks · Reel · Replay — session handoff

**Written 2026-08-15. Continue development from this file.**

Read `docs/RUNBOOK.md` first for the shell in general; this covers only the tracks/reel/replay
work and the deploy loop that made it testable.

---

## 1. The deploy loop — read this before anything else

The dev host **cannot run the 3D shell**: two other sessions hold the WebGL context pool, so
`buildWorld` throws and `createDash` never runs. That means no dash, no gate, no driving, and no
screenshots worth taking. **The FreeBSD guest is the test environment.** Everything below exists
because of that.

### Getting a build into the guest

```bash
cd /home/travis/ProjectAmp2/RRABBIT && npm run build
tar czf /tmp/rrabbit-dist.tgz dist
scp -P 2224 /tmp/rrabbit-dist.tgz driver@127.0.0.1:/tmp/
ssh -p 2224 driver@127.0.0.1 'rm -rf $HOME/rrabbit/dist.new && mkdir -p $HOME/rrabbit/dist.new && tar xzf /tmp/rrabbit-dist.tgz -C $HOME/rrabbit/dist.new --strip-components=1 && rm -rf $HOME/rrabbit/dist.prev && mv $HOME/rrabbit/dist $HOME/rrabbit/dist.prev && mv $HOME/rrabbit/dist.new $HOME/rrabbit/dist && sha256 -q $HOME/rrabbit/dist/assets/shell-*.js'
```

Then **Ctrl+R in the shell**. No reboot, no logout — it is a page in a Firefox kiosk.

Compare the printed hash against `sha256sum dist/assets/shell-*.js` on the host. They must match.

### Why it goes to `$HOME/rrabbit` and not `/usr/local/share/rrabbit`

`driver` **is not in the sudoers file** (`sudo` fails regardless of password) and the shipped
directory is `root:wheel 0755`. `driver` is in `wheel` but the group has no write bit.

`rrabbit-session` was written with the escape hatch — *"Overridable so the session logic can be
exercised off-target"*:

```sh
RRABBIT_DIR=${RRABBIT_DIR:-/usr/local/share/rrabbit}
BRIDGE=$RRABBIT_DIR/bridge.py
```

and `bridge.py` serves the `dist` **beside itself** (`DIST = dirname(abspath(__file__)) + "/dist"`).
So a user-owned copy is a complete install. `~/.xprofile` sets it, and SDDM's `Xsession` sources
`$HOME/.profile` and `$HOME/.xprofile`.

**To revert to the shipped shell:** delete `~/.xprofile` and log in again. Nothing under
`/usr/local` was touched.

### Guest access

| | |
|---|---|
| VM | `tandr-preview`, libvirt **user session** (`virsh -c qemu:///session`) |
| Network | usermode, `hostfwd=tcp:127.0.0.1:2224-:22` — **there is no guest IP** |
| ssh | `ssh -p 2224 driver@127.0.0.1`, key auth is installed |
| sudo | **unavailable** — `driver is not in the sudoers file` |
| Screenshot without any credentials | `virsh -c qemu:///session screenshot tandr-preview out.ppm` |

`virsh screenshot` is the highest-value probe here — it reaches the greeter, a failed session, and
anything ssh cannot see. It caught a deploy that had never happened when the AHEAD mirror still read
old text.

### Two host traps

- **`cd` does not persist between tool calls.** Every build/deploy command must start with
  `cd /home/travis/ProjectAmp2/RRABBIT`. A build "failing" with `npm error` is usually this.
- **Vite's dev server versions module URLs.** `await import('/m2/tracks.js')` in a console gets a
  **different instance** than `travel.js` holds, so any cross-module probe on `localhost:8914`
  measures two parallel copies and proves nothing. The built bundle has one instance (verified).
  Test through the `window.__*` globals, which close over the real graph.

---

## 2. What is built

### Tracks — `m2/tracks.js`

Was ten fixed slots; now **sparse 1–999, created on demand**.

- `Map` keyed by id, not a dense array. `ensure(300)` costs one entry, not three hundred.
- Fresh shell starts with **one** track, not zero.
- `remove()` refuses the last track — the gantry reads a label and the map draws a marker; there is
  no state for "no track".
- Store key `rrabbit.tracks.v2`. `load()` treats a saved set as untrusted input from an older build,
  which is why v1 needed no migration.

**The digit grammar is bounded by the population, not the ceiling.** `canGrow(prefix)` asks whether
any track that *exists* has this as a proper prefix. With nine or fewer tracks nothing can grow, so
every switch commits on the keystroke and the 600 ms timer never runs. **1–999 is faster than the
fixed 10 was.** Reading `MAX` here instead would make every single-digit press wait.

### The recording — the trail is not the log

`history` and `rec` are separate and must stay separate:

| | `history` | `rec` |
|---|---|---|
| job | what `back` can walk | what happened |
| `back` | **truncates it** | never touches it |
| cap | 32, silently shifted | `REC_MAX` 4096, loss counted in `recCut` |
| contents | road ids only | `go` · `land` · `in` · `out`, with relative `t` |

A short trail beside a long recording means you reversed out of somewhere. That gap is the honest
picture and both columns are shown in the reel because of it.

`arrive(id, {record:false})` still records — as `land`. A restore is not on the trail but it *did
happen*, and a log that omitted it could not be replayed: the next step would start from a road the
replayer was never told it was on.

`prune()` deliberately does **not** touch `rec`. `at`/`roads`/`history` are claims about where you
can go now; `rec` is a claim about what happened and stays true after a road is gone.

### The reel — `m2/reel.js`, gear **R**

Not a key. `dash.js` has had `{ id: 'R', name: 'REEL' }` all along and `setGear` refuses anything in
`unbuilt`; the scene existing is all R was waiting for. `unbuilt` is now `['P','C']`.

Per row: `drive` · `replay` · `walk` · `clear rec` · `delete`, plus live rename and a make-box.
`walk` is the same replay started paused.

Mutual exclusion with the map is enforced **by the callers** (`0` in travel.js, `onGear` in
shell.js) so `map.js` and `reel.js` never import each other.

### Replay — `precheck` / `perform` / transport

**A macro repeats; a track checks.** Two phases, and the split is forced not chosen:

- **precheck** — roads, before anything moves. A route whose third step names a deleted road never
  takes the first.
- **at arrival** — windows, which are not answerable in advance because surfaces arrive after the
  module loads. `load()` already made this split for `in`.

Refusals are typed `TRACK_*` (not `WRL_*` — studbook §7.5: a caller should be able to tell which
layer refused): `TRACK_EMPTY`, `TRACK_ROAD_GONE`, `TRACK_ROAD_CLOSED`, `TRACK_WINDOW_GONE`,
`TRACK_BUSY`.

**No silent repair.** A step whose road is gone is refused by name, never remapped.

The transport bar (`#transport`, z-44) reads an ordered list of discrete steps and never asks what a
step *means* — one `phrase()` function is its only contact with the kinds. **It survives the op
vocabulary change intact.**

Two rules that came out of use:

- **The end is a place to stand, not an exit.** Reaching the last step holds paused, so `back` stays
  live and you leave with `[X]` or Esc.
- **A replay is a round trip.** Exiting returns you to the road *and window* you were in when you
  pressed it, via `driveToTrack` (which releases, sets `goingBack` so the drive home is not recorded,
  and re-enters the window). If the road you started from is gone it stays put rather than guessing.

**Step back works only because ops record arrivals, not deltas** — state after step k is fully
described by step k, so going back is re-performing k−1, not reversing k. Forty wheel deltas cannot
be rewound; `park(road, z)` can. That is the granularity rule paying off as a capability.

---

## 3. Bugs found, and the two lessons worth carrying

**The one that cost four rounds:**

```css
#transport { display: flex; }      /* id-selector author rule */
#transport[hidden] { display: none; }   /* ← required, was missing */
```

`display` from an id selector outranks the UA's `[hidden] { display: none }`, so `el.hidden = true`
set the attribute and changed nothing. The bar was correctly told to hide **55 times** and stayed
up — so a replay that *had* ended looked like one that would not stop.

> **When a control "does not respond", measure whether its EFFECT is reaching the screen before
> measuring whether its INPUT is reaching the code.**

And the instrument that misled me: once the replay stopped, the poll was cleared, so the counters
froze. `esc 4/0` was a **stopped clock** read as evidence about handlers.

> **An instrument that stops updating reads as a measurement, not as silence.** Put a heartbeat on
> any counter you intend to trust.

Two real bugs found while chasing it, both worth keeping fixed:

- Esc for replay was on a **bubble** listener; three capture-phase branches in `travel.js` can stop
  propagation first. It lives in the capture listener now.
- The flat-mode pointer `swallow` exempted only `#map`. A replay step that *enters a window* puts the
  shell in flat mode, which killed every button on the bar. Now exempts `#transport, #reel, #map`.

**Stale text removed** (both were teaching the dead ten-track model): the `#status` hint panel and
`map.js`'s key hint. `#status` is now `hidden` when empty — clearing the text left a bordered empty
box — and both writers (`say`, `offerReload`) un-hide it, because a crash report in a hidden panel is
a failure reported nowhere.

**Glyphs:** `⏮⏸▶⏭⏹` are U+23Ex and the image's font has no such block — every button wore tofu. All
controls are ASCII now: `|< back`, `> play`, `|| pause`, `>| step`, `[X]`.

---

## 4. Where this sits on the ladder

`DRIVE → TRACK → REPLAY → GENERALIZE → AUTONOMOUS`

| rung | status |
|---|---|
| DRIVE | `live_local` |
| TRACK | `live_local` — sparse 1–999, reel, recording |
| REPLAY | `live_local` — preconditions, refusals, transport, round trip |
| GENERALIZE | `spec` — blocked on the op vocabulary |
| AUTONOMOUS | `spec` — WRLM D′ is step 4, unauthorized |

---

## 5. What is next, and what is blocked on a ruling

**The op vocabulary is the next phase** and it is a **[TRAVIS] decision**, not a task. Draft is at
[`docs/OP_VOCABULARY_DRAFT.md`](OP_VOCABULARY_DRAFT.md), beside this file.

Its argument in one line: the recording is an ad-hoc `{t,k,…}` shape, and adding the eleven missing
verbs by accretion makes WRL permanently harder. A **closed vocabulary of ~16 typed ops through one
seam** gives recording, replay, transport, WRL, and the code editor one code path —
*the vocabulary is the desktop API*, so there is no separate "expose the API to WRL" project.

Granularity rule: **record the arrival, not the input.** Forty wheel notches is a macro;
`park(road, z)` is a track.

Five rulings in §8 of that draft. **§7 has a deadline**: existing recordings get discarded, which is
cheap now and expensive once tracks have been published.

### Known gaps in what shipped

- **Recording covers 4 of ~15 verbs.** No lane scrolling (`parkRoad`), no window clicks, no resize,
  no program launch. Deliberately not fixed by adding kinds — see above.
- The check/use race is **narrowed, not closed**. A road can still go away between `checkStep` and
  the drive. Stated in the code, not claimed away.
- Preconditions are hand-written JS, not data. They should become `GoalSpecV1`'s *shape* — closed
  AST, bounded, total, **sealed into the track's identity** so a track cannot be edited to weaken its
  own guard.

---

## 6. Uncommitted, and the other open work

Seven files modified and **not committed** as of writing:

```
m2/index.html  m2/map.js  m2/reel.js  m2/shell.js  m2/tracks.js  m2/travel.js  m2/world.js
```

Last commit on the branch is `643ced8`, which is another session's.

Elsewhere in the portfolio, from the same session:

- `../../RECONCILIATION_LEDGER.md` (repo root) — 9 defects, law count derived at **118**
  (`STACK_SITEMAP.md` says 116, wrong in two places), 24 of 25 domains serve 200
  (`container.app` does not resolve), WRLM 4/4 batteries green, and **D9: the generator prints 297
  inhabited cells where the brief says 298** — unresolved, one `build_pool.py` run settles it.
- `../../COMPUTEDRIVEN_POSITIONING_PLAN.md` (repo root) — portfolio tiering, T&R Cloud on
  Cloudflare R2, the WRLM/D′ section, risks R9–R13.

Both live at the repo root rather than under `docs/`, which is the stackdocs aggregation site and
would have swept them into the atlas build.

`/usr/local/share/rrabbit` in the guest has **seven** stale `dist.*` directories
(`dist.o3 dist.o4 dist.old dist.old2 dist.prev dist.prev2`). Cleaning needs root.
