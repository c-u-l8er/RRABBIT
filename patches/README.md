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

## greenfield-poll-uv-init-check.diff

**`start_poll` ignored `uv_poll_init`'s return value, and on FreeBSD that is a
SIGSEGV on the first session.** Applied to the source by
`tools/build-addons*.sh`; compiled into `proxy-poll-addon.node`.

`uv_poll_init` returns *before* `uv__handle_init` when it fails, so the handle
is untouched and `handle->loop` is NULL. `uv_poll_start` dereferences it. The
backtrace is `uv_poll_start+47`, `mov 0x8(%r14),%rdi` / `mov 0x68(%rdi),%rbx` —
r14 is a perfectly good handle whose loop is zero.

It fails on FreeBSD because `wl_event_loop_get_fd()` returns libwayland's epoll
fd, libwayland's epoll here is libepoll-shim, and libepoll-shim's epoll is a
**kqueue** — and `uv_poll_init` insists on `ioctl(FIONBIO)`, falling back to
`fcntl(F_SETFL)`. A kqueue rejects both with `ENOTTY`, so there is no third
thing to try. **Not VM-specific**: nothing about it depends on `/dev/dri`.

Three changes, and only the first is a port fix:

1. check the return value, and never start an uninitialised handle;
2. on failure, fall back to a thread parked in `poll(2)` on the fd that wakes
   the loop through a `uv_async_t` — the kernel is willing to report readiness
   on that fd (libuv's own `uv__io_check_fd` registers it and succeeds), only
   the FIONBIO is in the way;
3. report the first napi failure and print any pending JS exception. The
   upstream `NAPI_CALL` macro throws and then carries on, and declines to
   rethrow when an exception is already pending — so a poisoned callback loop is
   completely silent. That silence is what hid the fault below.

Also fixes `static size_t argc` — `napi_get_cb_info` writes the real count back
through it, so a static keeps whatever the smallest call ever passed.

Full write-up: spec §29.7.

## greenfield-freebsd-proc-pid.diff

**Greenfield reads Linux `/proc/<pid>/status` to match a client to the app that
launched it.** FreeBSD has no procfs mounted by default, so `readFileSync` threw
ENOENT — from inside the wl_display fd callback, which is a *native* callback.
The exception had nowhere to go: it stayed pending on the napi env and every
later callback failed with `napi_pending_exception`. **One unreadable file and
the compositor went deaf on the first client to connect, silently.**

`ps -o ppid=,comm=` reports both fields, is POSIX, and costs one fork per client
connection. The `/proc` read is still tried first, so Linux is unchanged; the
fallback also covers a process that exits between connecting and being looked
up, which is a live race on Linux too.

This one is **JS, not C**, so `tools/build-addons*.sh` cannot deliver it to an
installed proxy. `tools/patch-compositor-proxy.mjs` applies the same change to
the built `dist/` of an installed `@gfld/compositor-proxy`:

```
node tools/patch-compositor-proxy.mjs /usr/local/share/rrabbit/gfproxy
```

It is the proxy-side sibling of `tools/patch-compositor.mjs` and follows the
same exact-string, loud-failure rule. **Gap: the T&R image has no committed
installer for `gfproxy` yet, so nothing runs this automatically.** Until that
exists it is a manual step on the image.

Full write-up: spec §29.8.
