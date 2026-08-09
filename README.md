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

**M0, M1 and M2 pass** (2026-08-08), each with measurements rather than
screenshots alone — spec §10–§12.

- **M0** — the road occludes a live Wayland surface. This was the gate.
- **M1** — many windows ride the road as signs, one adopted GPU texture each,
  at stable milepost addresses. No Greenfield patch was needed after all (§11.1).
- **M2** — flying into a sign arrives fronto-parallel at exactly 1:1, where it
  can be pointed at, typed into, and left with a chord no client can swallow.

**Not done, and not implied:** no *native* application has been through this
path — every window so far is an in-browser WASM/JS client, so §7's per-window
encode cost is still untested. `xdg_popup` is untouched. Signs carry no title
yet. Next is M3, the tubes.

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
