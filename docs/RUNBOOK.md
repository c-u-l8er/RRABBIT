# RRABBIT runbook — bringing the stack up, and proving it

The spec (`docs/spec/README.md`) records *what was found and why*. This file is
the other half: the commands, the port map, and the measurements that settle an
argument. It exists because every session so far has re-derived the same six
facts before it could start work.

Nothing here is optional folklore — each rule below is a trap someone already
fell into, with the section of the spec that records it.

---

## 1. The port map

Five servers, and they are not interchangeable.

| port | what | started by | notes |
|---|---|---|---|
| **8911** | vite dev — the shell from source, HMR | `npm run m0` | iterate here |
| **8912** | compositor-proxy — native applications | `npm run proxy` | needs the addon and a GL device |
| **8913** | `bridge.py` — the **built** shell + the seven tubes | `python3 bridge.py 8913` | stdlib only; this is what the distro ships |
| **8905** | PARKVPS `vpsd/api.py` — the machines | `python3 vpsd/api.py --port 8905` | QEMU lives behind this |
| **8890** | RAVIO `bridge.py` — the sky road | `python3 bridge.py --port 8890` | its MACHINES rail reads 8905 |

All are in the repo-root `.claude/launch.json` (`rrabbit-m0`, `rrabbit-bridge`,
`parkvps`, `ravio`).

**`--allow-origin` must name the page's port, not the proxy's.** It now defaults
to **both** (`8911,8913`) and `proxy.sh` prints what it allowed — a list needs
`patches/proxy-cli-multi-origin.md`, because upstream wrote the value into the
header verbatim and `Access-Control-Allow-Origin` may name exactly one origin, so
a comma list refused every entry.

If you serve the shell from anywhere else, say so, or the launch fails with a
CORS refusal that reads exactly like the proxy being down:

```bash
RRABBIT_ALLOW_ORIGIN=http://127.0.0.1:9000 npm run proxy
```

**Restart the proxy between page reloads.** A proxy session outlives the page and
is keyed by `compositorSessionId`, so a reload joins a session whose client is
gone — a window that never appears, with nothing in any log. Spec §21.1.

---

## 2. Launching a window

```js
window.__launch('/tandr-tr4-foot')     // any path in proxy/applications.json
```

`?remote=…` fires during **boot**, which makes it useless for anything that has
to be armed *before* the first frame — a probe on the decoder, say. `__launch`
is the same one launch path, on demand.

`proxy/applications.json` is schema-validated with `additionalProperties:false`.
An extra annotation field makes compositor-proxy **throw before opening the
socket** — the whole proxy goes down for one stray key.

It ships in the build now (`shipApplications()` in `vite.config.ts`), so the
built menu is the real list rather than `NATIVE_MIRROR`. Add a program in one
place.

### Which programs actually open, measured 2026-08-13

| | |
|---|---|
| `xterm`, `glxgears` | open (XWayland) |
| `foot · tr4` | opens (guest, via waypipe) |
| `gnome-text-editor` | opens **only** with `DBUS_SESSION_BUS_ADDRESS` pointed at a nonexistent path |

A GTK application inherits `DBUS_SESSION_BUS_ADDRESS`, finds the copy already
running on your desktop, hands off and exits 0 in under 100 ms. It looks exactly
like a crash and it is a feature. Any single-instance GTK app needs the same
entry. `WAYLAND_DISPLAY` is *not* the problem — `launchApplication` sets it to
the proxy's own socket, last, over `process.env`.

---

## 3. Measurements that settle arguments

These are the probes that actually decided things. Prefer them to reasoning.

### Is a frame reaching the browser, and what shape is it?

Monkey-patch the decoder from the console *before* launching:

```js
var RealVD = window.VideoDecoder
window.VideoDecoder = function (init) {
  var d = new RealVD({ output: f => { console.log(f.format, f.codedWidth, f.codedHeight,
                                                  f.visibleRect, f.allocationSize()); init.output(f) },
                       error: init.error })
  return d
}
window.VideoDecoder.isConfigSupported = RealVD.isConfigSupported.bind(RealVD)
```

Wrapping `VideoFrame.prototype.copyTo` and logging the returned `PlaneLayout[]`
gives the per-plane offset and stride — which is how you tell a padded decode
from a stride bug. This single probe is what found §23.

### Which way is a window up?

Inject a texture that is asymmetric *by construction* through the real upload
path, and read the glass back:

```js
var cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d')
cx.fillStyle = '#ff0000'; cx.fillRect(0, 0, W, H / 2)      // FIRST rows
cx.fillStyle = '#0000ff'; cx.fillRect(0, H / 2, W, H / 2)
scene['image/bitmap']({ size: { width: W, height: H },
                        pixelContent: await createImageBitmap(cv) }, renderState)
```

Red at the top of the sign means texel row 0 renders at the top, which means a
window is upright.

**`simple-shm` cannot settle orientation.** Its pattern is mirror-symmetric about
its own midline, so no sample of it can decide the flip — `__orient` correctly
reports `inconclusive`. Do not try to read it by eye either.

### Where is a control on the cockpit?

Compute it. **Do not scan with `window.__dashAt`** — it calls `hooks.dashHit`,
which is *not* pure: it toggles the ST&RT menu and knocks the gear stick, so a
scan closes the menu it is measuring and you conclude the menu will not stay
open. (`dash.hit()` is pure; `hooks.dashHit` is the layer that acts on it.)

The dash is drawn in a 1920×1080 design box (`dash.js`, `layout()`):

```
s = W / 1920                         // W, H are the canvas size
ty = H - 1080 * s                    // + the hidden-slide term when it is sliding
clientX = design.x * s
clientY = design.y * s + ty
```

`__dash()` reports every rectangle in design space (`startRect`, `startMenu`),
and `startMenuRect`/`startRows` in `dash.js` derive the rows from the list
length. One conversion, no probing, no side effects.

### Logging out — the power key, and why it can refuse

The cockpit's bottom-left corner is now two controls: **POWER** at design `x=22`
and **ST&RT** moved right to `x=80`. Power opens a confirm plate; the one row on
it posts `bridge.py /api/logout`.

**Nothing in the browser can end the session.** `window.close()` will not close
the last window of a kiosk, and the page has no session to end. The chain is:

```
shell POST /api/logout  ->  bridge reads the pidfile  ->  SIGTERM the browser
     ->  `wait` in rrabbit-session returns  ->  the script exits  ->  the greeter
```

The pidfile (`/tmp/rrabbit-browser.pid`, `RRABBIT_BROWSER_PIDFILE`) holds
`<pid> <comm>`. Both fields are checked before anything is signalled: pids are
reused, and a session that died without clearing its file would otherwise arm
this endpoint against whatever inherited the number. `comm` is recorded by
`rrabbit-session` *at launch* rather than assumed here, because `firefox` may be
a wrapper and then the waited-on process is not called `firefox` at all.

**A bridge you started by hand REFUSES, and that is correct** — there is no
session, and a shell that reached for the nearest Firefox would kill the one you
are developing in. The refusal is printed on the plate itself:

```bash
curl -s -X POST http://127.0.0.1:8913/api/logout
```

| answer | what it means |
|---|---|
| `409 no session to end — nothing wrote …` | served outside a session; expected on a workstation |
| `409 pid N is X, not Y` | stale pidfile, or the wrong process inherited the pid |
| `409 pid N is not running` | the session died without clearing its file |
| `200 {ok, pid, signal}` | signalled — if the page is still there, the browser ignored it |

`__dash().powerWhy` is the sentence on the plate; `__m1().lastLogout` carries the
status code and pid behind it. **Any message left on that plate is a fault**,
successes included — a logout that worked takes the page with it.

### The target has no devtools — use the report endpoint

The only machine that matters runs a kiosk Firefox with no address bar and no
console, so a diagnostic you cannot reach there is not a diagnostic.

```
RRABBIT_URL_EXTRA="remote=/notes,/firefox&report=45"   # in rrabbit-session
grep -a REPORT /tmp/rrabbit-bridge.log | tail -1 | sed 's/^REPORT //' | python3 -m json.tool
```

`?remote=` launches at boot — **comma-separated, so it opens more than one** —
and `?report=<secs>` posts to `bridge.py /api/report`, which prints it. **No
clicking**, which matters — see the click note under §5.

**The report REPEATS, so `tail -1` is "what is true now".** It used to fire once,
which meant every question about a *window* had to be asked by guessing, before
the page loaded and from a shell script, how long it would take to open one —
and anything needing two programs up at the same time was a race against a timer
set in the past. It now re-arms after each POST settles (one in flight, never a
queue). Set `report=10` while iterating.

**Do not `: >` the bridge log to clear it.** bridge.py holds it open at its
current offset, so truncating punches a NUL hole that the next write skips past —
and `grep` then treats the file as binary and silently matches nothing. Use
`grep -a`, or restart the bridge.

The fields that actually discriminate, and what each rules out:

| `proxyBase` | `?proxy=` never reached the shell |
| `programsFrom` | the built-in mirror still in use |
| `h264` | a missing decoder (asked, not assumed) |
| `appStates` | the launch failing |
| **`views`** | **frames arriving and not being adopted** |
| `errors` | everything else |

`views: []` with `appStates: open` means the signalling socket connected and **no
surface ever existed** — a completely different fault from a view that exists with
`hasBuffer:false`. That pair is what found §27.7 after two turns of guessing.

`errors` is bounded at 20 and keeps the **first**, not the last: the tube poll can
emit hundreds of identical failures, and the error that explains a failure is
almost always the first one.

### Does the quad carry a picture?

`state.decodes` is **declared and never incremented** (spec §19.5). It reads as
"no frames decoded" and means nothing. Use a GL readback:

```js
var c = document.querySelector('#gl'), g = c.getContext('webgl'), px = new Uint8Array(4)
g.readPixels(x, c.height - y, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px)
```

or `__views()` for `hasBuffer`/`rect`, or `__orient()` for the flip.

### Is the built bundle the shell you tested?

Minification mangles class names, so `constructor.name === 'Surface'` checks are
dead in the shipped artifact and nothing errors (spec §18.3). Identify by shape
(`isSurface`, `positionerState`), and grep the bundle for the strings your fix
depends on:

```bash
npm run build
grep -c "video/h264\|UNPACK_FLIP_Y_WEBGL\|resetState" dist/assets/shell-*.js
```

**Testing that the bundle runs is not testing that its features still work in it.**

---

## 4. The shared GL context — the rule the whole shell turns on

three.js and Greenfield draw into **one** WebGL context. Upstream that context is
Greenfield's alone, so its passes set only what they use and inherit defaults for
everything else. Here they inherit whatever three left switched on.

`fenceScenePasses()` in `shell.js` is the one seam that fixes this, and it wraps
all three of `Scene`'s entry points — `video/h264`, `image/bitmap`, `image/png`.

Two things about it that are not negotiable:

- **Per-pass, not around `renderer.render`.** The passes run in a microtask that
  `render()` queues, so state set outside it is only still true by luck.
- **`renderer.resetState()` on the way out**, or three keeps drawing the road on
  Greenfield's settings.

If you ever add a fourth entry point to `Scene`, it goes in the fence. Spec §23.

---

## 5. Driving a FreeBSD guest with no browser at all

The T&R image is graphical, and for a long time the only way to look at it was a
browser pointed at PARKVPS. It is not. QEMU will hand you the framebuffer and
take keystrokes directly:

```bash
cd PARKVPS
python3 vpsd/vps.py screenshot tr4 /tmp/g.ppm && magick /tmp/g.ppm /tmp/g.png
python3 vpsd/vps.py type tr4 driver @tab driver @ret      # log in at the greeter
python3 vpsd/vps.py type tr4 @2                           # a key the shell reads
python3 vpsd/vps.py click tr4 72 702                      # the ST&RT button
```

The guest has a `usb-tablet`, which is **absolute** — a pixel on the screenshot
is a pixel to click, with no pointer warping and no relative drift. Screenshot,
read the coordinate off the picture, click it.

**This reaches places ssh cannot.** ssh tells you what a shell says is true;
`screenshot` shows you the screen — the greeter before anyone has logged in, a
session that failed to start, an X server on the wrong VT. `ps aux | grep firefox`
returning rows does not mean anything is on the display.

`magick` is present on this host; there is no python `PIL`.

### Getting a new shell build into a running guest

The image ships `dist/` and `bridge.py` to `/usr/local/share/rrabbit/` and runs
them under Firefox kiosk. Replacing the bundle in a running instance takes about
a second and does not need an image rebuild:

```bash
cd RRABBIT && npm run build
tar czf - dist | ssh $OPTS park@127.0.0.1 \
  'sudo rm -rf /usr/local/share/rrabbit/dist.new &&
   sudo mkdir -p /usr/local/share/rrabbit/dist.new &&
   sudo tar xzf - -C /usr/local/share/rrabbit/dist.new --strip-components=1 &&
   sudo mv /usr/local/share/rrabbit/dist /usr/local/share/rrabbit/dist.old &&
   sudo mv /usr/local/share/rrabbit/dist.new /usr/local/share/rrabbit/dist'
```

Then **reboot the guest** — `service sddm restart` orphans an Xorg on VT 9, after
which every new display server *and* the greeter crash in ~22 ms, which presents
exactly like the session you just installed being broken.

Confirm you are running what you built, by hash, not by looking:

```bash
ssh $OPTS park@127.0.0.1 'sha256 -q /usr/local/share/rrabbit/dist/assets/shell-*.js'
sha256sum dist/assets/shell-*.js
```

**Replace `dist`, never overlay it.** The 0.4 image carried **five** orphan
`shell-*.js` bundles from earlier builds. Same class of bug as the addons
manifest (spec §19): an overlay leaves files that then look like they belong.

### Native programs inside the guest — the host's proxy, over the network

The image carries no compositor-proxy and cannot (no node, no gstreamer, no
`/dev/dri`). It does not need its own: under QEMU user-mode networking the host
answers on the default gateway and SLIRP maps it to the host's **loopback**, so
`--bind-ip=127.0.0.1` is already reachable from the guest at `10.0.2.2:8912` with
nothing exposed.

`rrabbit-session` appends `?proxy=http://10.0.2.2:8912` **only when the default
route is `10.0.2.2`** — anywhere else that is someone else's router.
`RRABBIT_PROXY` overrides in either direction (empty string = never).

This also needs `publicBaseURL` in `patches/proxy-cli-multi-origin.md`: the proxy
hands back a `signalURL` built from `--base-url`, and a static value would tell
the guest to connect to *itself*. Check it landed by grepping the proxy log for
the address the client came back on:

```bash
grep "New signaling connection" proxy.log      # must say 10.0.2.2 for a guest
```

It also needs the **client-side** correction in `shell.js`: the proxy builds each
application's protocol-channel URL from the static `--base-url` with no request
in scope, so it tells a guest to connect to `127.0.0.1` — itself. The shell
rewrites the proxy's own `/channel` and `/signal` WebSocket URLs to the host it
actually reached the proxy on. Server-side and client-side corrections carry
*different transports* (HTTP vs WebSocket); neither is redundant.

**Working**: a host application renders on the guest's road
(`docs/m12-host-app-in-guest.png`).

### Where it shows up

RAVIO's **MACHINES** rail (shift into **P — the drive-in**, `g` cycles gears)
lists `PARKVPS /api/fleet` and opens each guest as a tab at
`http://127.0.0.1:8905/desktop/<name>`. That URL is a plain page and can be
opened on its own — which is the quickest way to see a guest's screen in a
browser, and it does not need RAVIO to be running.

---

## 6. Harness traps (agent-browser)

- **Isolated session + software GL, or you measure nothing:**
  `--args "--use-angle=swiftshader,--enable-unsafe-swiftshader,--disable-gpu-vsync,--disable-frame-rate-limit"`.
  `--args` is **ignored if the daemon is already running** — `agent-browser close --all`
  first, or set `AGENT_BROWSER_ARGS` in the environment, which survives.
- **A blocked profile stays blocked.** After repeated context losses Chrome
  answers `Web page caused context loss and was blocked` and *every* later
  `getContext('webgl')` in that profile returns null. A fresh `--session` name is
  a fresh profile.
- **RRABBIT survives SwiftShader; RAVIO does not.** RRABBIT (4 canvases) renders
  headless. RAVIO (5) loses its context on load, which kills the dash canvas that
  owns gear changes and key handling — so `g` does nothing and the app looks
  broken. It is the harness. Do not report it as a RAVIO fault without a
  real-GPU browser (spec §"READ FIRST" in the start-menu notes).
- **`screenshot` takes an absolute path.** A relative one is written relative to
  the daemon's cwd, not yours, and the command still prints `✓ saved`.
- **`click` takes a selector, not coordinates.** `click 1120 737` matches nothing,
  **exits 0 and dispatches no event**. A coordinate click is `mouse move X Y` →
  `mouse down` → `mouse up`. Prove the event arrived before trusting it.
- **`console` output is cumulative across page loads**, so a stale error from a
  previous load reads as a live one.
