# RRABBIT

The road as a windowing system — half of **T&R (Travel & RRABBIT)**.

**Travel and RRABBIT are two personalities, not two layers.** Travel wants to
navigate: the road, the camera, the flight into a window, the districts. RRABBIT
wants to *be* the windows — the sign standing on the road, the surface that
flattens to 1:1 under you, the rect that decides a click is yours. One likes
going; the other likes being gone to.

This repo is a fork of [RAVIO](../RAVIO)'s world, re-missioned from *rendering a
build harness* to *managing an operating system's windows*, and it holds both of
them — as two modules rather than one file:

| file | who | what is in it |
|---|---|---|
| [`m2/travel.js`](m2/travel.js) | Travel | poses, districts, overview, the flatten, the flight, input routing |
| [`m2/rrabbit.js`](m2/rrabbit.js) | RRABBIT | texture adoption, signs, popups, the ledger rect |
| [`m2/world.js`](m2/world.js) | neither | the stage: scene handles, the `signs` ledger, the numbers the HUD reads |
| [`m2/shell.js`](m2/shell.js) | the wiring | builds the world, drives the frame, owns the diagnostics |

They say very little to each other. Travel reads two things and both come
through the shared ledger rather than a call — which sign stands at an address,
and what rect it owns in the flat output. RRABBIT calls Travel **once**: when a
window dies while you are standing in it, it tells Travel to let go. That is the
whole conversation, and it runs in one direction.

[travel-and-rrabbit](https://github.com/c-u-l8er/travel-and-rrabbit) is the
distribution — it carries Travel's name and is not Travel either.

Signs on the road are no longer journal rows. **They are the running
applications.** The vacuum tubes are no longer lane ratings; they are CPU, RAM,
swap, disk, net, temp and load. Districts are no longer amp workspaces; they are
desktop workspaces. You drive past your windows, fly into one, and it flattens
into a real, square, pixel-exact surface you can type into.

It shows only windows launched into it. It does not replace your desktop.

**Read [`docs/spec/README.md`](docs/spec/README.md) first** — in particular §2,
which records what does *not* work about the obvious integration and why.

## Status

**M0–M5 built, M0–M4 measured** (2026-08-08), each with measurements rather than
screenshots alone — spec §10–§12 and §14–§17. **Booted on T&R 2026-08-09.**

- **M0** — the road occludes a live Wayland surface. This was the gate.
- **M1** — many windows ride the road as signs, one adopted GPU texture each,
  at stable milepost addresses. No Greenfield patch was needed after all (§11.1).
- **M2** — flying into a sign arrives fronto-parallel at exactly 1:1, where it
  can be pointed at, typed into, and left with a chord no client can swallow.
- **M3** — seven tubes reading the real machine, and a rack that is not allowed
  to show a number it cannot explain.
- **M4** — three districts as workspaces, each a road of its own, and a ledger
  where every window has its own rect so input resolves by position (§15.2).
- **popups** — §7's open problem, closed (§16). Also found that an `xdg_popup`
  cannot map at all in Greenfield rc1.
- **M5** — runs as a session: Python-only on the target, and Firefox runs the
  whole shell.
- **BOOT** — **runs on a T&R image** (2026-08-09). Greeter to road on the
  distribution it is built for, in a 4 GB guest with no GPU. Six of seven tubes
  read the real FreeBSD machine; `temp` reports its own absence, because a VM
  has no `dev.cpu.0.temperature`.

Three things that only a real boot could have found, all now fixed:

- **`make.sh` could not carry the shell to the builder at all.** `build-image.sh`
  reads `RRABBIT_DIST` as a path on the machine doing the build, and that machine
  is never the workstation — so there was no route from a built bundle to an
  image. It pushes `dist/` + `bridge.py` now, and refuses a `dist/` older than
  its sources.
- **The FreeBSD tube reader had never executed.** `net` raised `TypeError` on a
  `None` peak the first time it ran. Fixed by giving it the same prior-peak
  protocol `LinuxReader` already had — patching only the crash would have
  re-introduced the bug that note describes, where the first byte pins the gauge
  at 100%.
- **The greeter preselected RRABBIT, and could not select anything else.** Two
  `.desktop` entries, picked by sort order, and `rrabbit` sorts before `tandr` —
  so a fresh image logged into the 3D shell, which is precisely what
  `rrabbit-session` says must never happen. The session label was blank as well:
  it asked SDDM's `SessionModel` for `Qt.DisplayRole`, which that model does not
  publish. T&R now seeds the default and the greeter takes **F2** to change it.

**Native applications work** (§18). A real `xterm` runs on the road — X11 →
XWayland → nested compositor → h264 → browser → GPU texture → sign — flattened
to **960×653 at `scale 1.0000`**, prompt legible. §13 spent its whole length
searching the environment and the cause was not in the environment: the official
addon build **compiles its own GStreamer at branch 1.20** and this machine runs
**1.28.6**, so the shipped `libproxy-encoding.so` linked a GStreamer GL that was
not the installed one. Every symbol resolved the entire time it was silently
emitting nothing — `ldd` resolving is not evidence a native module matches its
dependencies. The rebuild is now `npm run addons`, pinned and hash-checked
(§19).

Still true, and not smoothed over:

- **Frames tear — two thirds fixed, and the rest now measured** (§20). It was
  never a damage-region problem. three left a **vertex array bound** and
  Greenfield's YUV→RGB pass binds none of its own, so it recorded its attribute
  pointers into three's VAO and drew with three's leftovers; that was the
  full-canvas magnified-glyph artifact, and it is gone. Separately the decoded
  texture is **larger than the surface** — 1024×770 for a 960×653 xterm — and
  the sign was mapping the padding too; it now samples the same sub-rect
  Greenfield's own shader does. What remains is a constant-slope diagonal with
  flat cyan below it, inside the decoded content: chroma left at default, so
  never written. That is upstream in `@gfld/compositor`, and the encoder A/B
  that would narrow it could not be run — see §20.3.
- **Per-window encode cost is still unpriced, and §21.2 says why.** Two
  harnesses, neither monotonic in window count. What they did establish: the
  proxy is flat at ~0.4% CPU while the browser sits at 425%, so the expensive
  half is decode and composite, not encode — "per-window encode cost" may be
  the wrong first question.
- **Native launches drop above two** (§21.3). Ask for four windows, get two,
  with nothing reported. Found while measuring something else, not diagnosed.
  The multi-window case is not just unpriced, it is unreliable.
- **Signs carry no titles yet.**

Closed since: a **reload no longer strands the remote client** (§21.1) — each
page load takes a fresh session id and `pagehide` reaps the old one, verified
across three reloads against a proxy that was never restarted, leaving exactly
one `xterm` behind.

`xdg_popup` is no longer on this list — §16 closed it, and found on the way that
a popup cannot map at all in Greenfield rc1.

## Local patches — do not lose these

RRABBIT carries a **required** one-line fix to `@gfld/compositor`: without it an
`xdg_popup` can never map, so **no client can show a menu, dropdown or tooltip**.
`node_modules/` is gitignored, so the fix lives in [`patches/`](patches/) and is
re-applied by `postinstall` and by `build`. A runtime detector warns if it is
ever missing rather than silently repairing it.

Read [`patches/README.md`](patches/README.md) before touching `package.json`
scripts or upgrading `@gfld/compositor`.

## Lineage

- [RAVIO](../RAVIO) — the world this forks, and the source of every measured
  constant (`S`, `BOOST_X`, `MIR_TILT`, the hood clip, the yoke camera framing)
- [PARKVPS](https://github.com/c-u-l8er/PARKVPS) — the fleet whose rail proved
  the tab strip shape, and the origin of the `Ctrl+Alt+Shift+Esc` escape hatch
- [Greenfield](https://github.com/udevbe/greenfield) — the in-browser Wayland
  compositor, AGPL-3.0
- [wxrd](https://www.collabora.com/news-and-blog/news-and-events/wxrd-a-standalone-wayland-compositor-for-xrdesktop.html)
  / [motorcar](https://github.com/evil0sheep/motorcar) — the 3D-windowing prior
  art, and where the scoping decision comes from

## Licence

AGPL-3.0, inherited from Greenfield. See spec §9.
