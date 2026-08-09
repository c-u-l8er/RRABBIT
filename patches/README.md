# Local patches

**These are not optional. Without them the shell is missing features that fail
silently.**

`node_modules/` is gitignored, so a patch applied there survives only because
something re-applies it. Three things keep that true — if you change any of
them, check the others:

1. `package.json` → `"postinstall": "node tools/patch-compositor.mjs"` — runs on
   every `npm install` / `npm ci`.
2. `package.json` → `"build": "node tools/patch-compositor.mjs && vite build"` —
   so a build can never ship an unpatched bundle.
3. `m2/shell.js` → `checkPopupsMapped()` — a runtime **detector**. If a popup
   ever has a buffer and is not mapped, it counts it and prints the command to
   run. The shell deliberately does **not** repair it silently.

`tools/patch-compositor.mjs` matches an **exact string** and exits non-zero if it
does not find it. That is on purpose: if upstream changes `XdgPopup.onCommit`,
the right outcome is a loud failure, not a patch applied to the wrong place.

## greenfield-xdgpopup-map.patch

**An `xdg_popup` can never map in `@gfld/compositor@1.0.0-rc1`** — and master is
byte-identical, so this is live upstream, not something a newer build fixes.

`Surface.mapped` is set in exactly one place, `FloatingDesktopSurface.commit()`,
reached through `DesktopSurface.commit()`. `XdgToplevel`, `ShellSurface` and
`XWaylandShellSurface` all call it. `XdgPopup` does not — it acks the configure,
schedules a render, and returns. The popup surface is created with the right
role, receives its buffer, and sits at `mapped: false` forever.

**Consequence: no menu, dropdown, combobox or tooltip can be shown by any
client, native or web.** It is hit the first time a user right-clicks.

The fix is one line, mirroring `XdgToplevel.onCommit`. `FloatingDesktopSurface`
already returns early while `surface.size === undefined`, so the bufferless
first commit is unaffected.

Not upstreamed — kept local by decision (2026-08-08). The patch file is written
as a ready-to-send diff against `packages/compositor/src/XdgPopup.ts` if that
ever changes. Full write-up: spec §16.
