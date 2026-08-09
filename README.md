# RRABBIT

The road as a windowing system — the second half of **T&R (Travel & RRABBIT)**.

Travel is the distro ([travel-and-rrabbit](https://github.com/c-u-l8er/travel-and-rrabbit)).
RRABBIT is the thing you sit in: a fork of [RAVIO](../RAVIO)'s world, re-missioned
from *rendering a build harness* to *managing an operating system's windows*.

Signs on the road are no longer journal rows. **They are the running
applications.** The vacuum tubes are no longer lane ratings; they are CPU, RAM,
swap, disk, net, temp and load. Districts are no longer amp workspaces; they are
desktop workspaces. You drive past your windows, fly into one, and it flattens
into a real, square, pixel-exact surface you can type into.

It shows only windows launched into it. It does not replace your desktop.

**Read [`docs/spec/README.md`](docs/spec/README.md) first** — in particular §2,
which records what does *not* work about the obvious integration and why.

## Status

**M0–M4 pass** (2026-08-08), each with measurements rather than
screenshots alone — spec §10–§12, §14 and §15.

- **M0** — the road occludes a live Wayland surface. This was the gate.
- **M1** — many windows ride the road as signs, one adopted GPU texture each,
  at stable milepost addresses. No Greenfield patch was needed after all (§11.1).
- **M2** — flying into a sign arrives fronto-parallel at exactly 1:1, where it
  can be pointed at, typed into, and left with a chord no client can swallow.
- **M3** — seven tubes reading the real machine, and a rack that is not allowed
  to show a number it cannot explain.
- **M4** — three districts as workspaces, each a road of its own, and a ledger
  where every window has its own rect so input resolves by position (§15.2).

**Native applications do not work yet** — attempted and written up in spec §13.
The control path is fine (nested compositor, XWayland, the app launches and
stays alive, the browser sees its surface) but **no buffer ever arrives**, so
nothing reaches the road and §7's per-window encode cost is still unpriced. Two
things came out of it worth knowing before anyone repeats it: GStreamer's GL
cannot make an EGL context on this box's NVIDIA node and GLib aborts, so the
failure presents as `SIGTRAP`; and `@gfld/compositor-proxy-cli@1.0.0-rc1` ships
a `dist/` missing three of its four modules.

Also not done: `xdg_popup` is untouched, and signs carry no titles yet.

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
