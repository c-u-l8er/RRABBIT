# RRABBIT — the road as a windowing system

RRABBIT is the second half of **T&R (Travel & RRABBIT)**. Travel is the distro;
RRABBIT is the thing you sit in. It is a fork of RAVIO's world, re-missioned from
*rendering amp's work* to *managing an operating system's windows*.

RAVIO drives past signs that report a build harness. RRABBIT drives past signs
that **are the running applications**.

---

## 1. What this is, and what it deliberately is not

**It is not a replacement desktop.** It shows only windows that were launched
into it. It does not mirror, adopt, or reparent an existing icewm session.

This is the scoping decision Collabora made for `wxrd` and it is the reason wxrd
shipped where Project Looking Glass (Sun, 2004–2006) did not. The recorded
complaint against Looking Glass — *"nothing that couldn't be done better in
2D"* — is what happens when a 3D shell has to be a complete desktop on day one.
The compositors that survived (Compiz, DWM) were 3D **effects on a 2D desktop**,
never true 3D windowing.

T&R's SDDM offers both sessions. `tandr-session` still starts icewm+tint2. A
second xsession entry starts RRABBIT. A bug in RRABBIT must never be a machine
you cannot use.

**The design rule that makes it survivable: 3D is for navigation; work happens
fronto-parallel and pixel-exact.** RAVIO already built this — the "road IS the
page" morph (`roadWorld`/`roadHinge`, `readPitch` collapsing a 3,360-unit span
into a 200-unit band while the ship dollies in). A window flying toward you and
*flattening into a real, square, 1:1 surface* is that same code path. A window
you are typing into is never at an angle.

---

## 2. The architecture, verified

Greenfield is an in-browser Wayland compositor (TypeScript + WASM + WebGL).
Native apps are h264-encoded server-side by gstreamer, shipped over a WebRTC
datachannel, decoded by a WASM decoder in a worker, and colour-converted
YUV+A→RGBA in WebGL.

The naive integration does not work, and the reason is worth recording because
it is not obvious from the README.

### 2.1 What does not work

- **`initScene(canvasCreator)` is one canvas per _scene_, not per surface.**
  A scene is a Wayland `Output` — a virtual monitor. Greenfield composites every
  window into it with its own `SceneShader`. One scene would put every window on
  one billboard.
- **Scenes are not scoped.** `Renderer.render()` ends in
  `for (const scene of sceneList) scene.render(viewStack)` — *every scene renders
  every view*. Partitioning windows across scenes does not happen by itself.
- **One WebGL context per window is a dead end anyway.** Browsers cap live
  contexts at ~16. That is a ceiling on the number of windows, imposed by an
  implementation detail, which is exactly the kind of limit that should not exist
  in a window manager.

### 2.2 What does work

`View.renderStates` is `{ [sceneId: string]: RenderState }`, and
`RenderState.texture` is a **per-surface WebGL texture** holding that one
window's decoded pixels. That is precisely the billboard's want. The only
obstacle is that it lives in the scene's GL context, and WebGL textures do not
cross contexts.

So: **give Greenfield three.js's context.**

1. Patch `setupCanvasGLContext` to accept an existing context instead of calling
   `canvas.getContext('webgl')`. Hand it `renderer.getContext()`.
2. Patch `Renderer.render()` to skip `scene.render(viewStack)`. We want
   `updateRenderStatesPixelContent(view)` — the decode — and nothing else.
   Greenfield decodes; **RRABBIT composites**.
3. Adopt each surface texture with three.js's public
   `renderer.setRenderTargetTextures(renderTarget, glTexture)`, then use
   `renderTarget.texture` as an ordinary material map. *(three r160 has no
   `ExternalTexture` class — `setRenderTargetTextures` is the supported path at
   this revision, and RAVIO vendors r160.)*
4. `renderer.resetState()` around the boundary. three.js caches GL state and
   Greenfield does not know that; this call exists for exactly this interop.

Both patches are small and surgical. Greenfield is AGPL-3.0, so a fork is
expected and licensed for — see §9.

### 2.3 The claim this deletes

RAVIO spec §9 recorded that *"play any website on the drive-in screen is NOT
deliverable"*: `HTMLTexture` excludes cross-origin content by design, and
`CSS3DRenderer` renders real DOM in a separate layer with **no depth compositing
against WebGL**, so the road cannot pass in front of it.

A decoded Wayland surface is not a web page. It is a texture we own, in our own
context, in our own depth buffer. **The road can occlude a live Firefox window.**

§9's ban is unchanged as written — it was about web pages, and it is still true
about web pages. This is a different source.

**M0 exists to prove exactly this and nothing else.** If the road cannot occlude
a real window, every section below is void.

---

## 3. The mappings

| RAVIO | RRABBIT |
|---|---|
| signs = amp journal rows | signs = **windows** (one surface, one sign) |
| 7 tubes = lane ratings | tubes = **CPU, RAM, swap, disk, net, temp, load** |
| districts = amp workspaces | districts = **workspaces** (a stretch of road each; NOT an output — §15.1) |
| `bridge.py` → amp API | `bridge.py` → compositor state + sysinfo |
| milepost = journal position | milepost = **a window's address** |
| P / R / C / D | kept, re-missioned — §5 |

### 3.1 The tubes

RAVIO's rating shape is `{value, n, why, bar}` where `bar` is the gauge redline
and `why` is prose. That shape survives intact, which is why the tube rack needs
no geometry change:

| tube | value | bar (redline) | why |
|---|---|---|---|
| CPU | load / ncpu | 1.0 | top process by cpu |
| RAM | used / total | 0.9 | top process by rss |
| SWAP | used / total | 0.25 | "swapping is a fault, not a level" |
| DISK | used / total on `/` | 0.9 | filesystem + free bytes |
| NET | bytes/s vs observed max | — | busiest interface |
| TEMP | °C / critical | 0.85 | sensor name |
| LOAD | 1-min load / ncpu | 1.0 | 1/5/15 triple |

`why` is not decoration. RAVIO invariant 1 — *the road may never move for a
reason the viewer cannot read off a sign* — means a tube in the red must **say
what is doing it**. A gauge that reports a number and declines to name the
process is the thing that comment in `steer()` was written against.

**FreeBSD, not Linux.** The bridge reads `sysctl` (`kern.cp_time`,
`vm.stats.vm.*`, `hw.ncpu`, `dev.cpu.0.temperature`), not `/proc`. Written
against FreeBSD 15 first because that is what T&R is; a Linux reader is a second
implementation of the same contract, for developing on this Arch box.

---

## 4. Invariants

Inherited from RAVIO, still binding:

1. **The road may never move for a reason the viewer cannot read off a sign.**
2. **Milepost purity** — a sign's content is a pure function of its milepost.
3. **One voice at a time.**
4. **Nothing is recorded until asked; nothing is on disk until saved.**
5. **Writes go through the bridge.**

New, and specific to being a shell:

6. **A window is nailed to a milepost when it opens. The milepost is its
   address.** This is the one real conflict with invariant 2: a live window's
   *content* changes with wall-clock time, so it cannot be milepost-pure the way
   a journal row is. The invariant is narrowed, not abandoned — **content
   changes, placement does not**. Drive back and the window is where you left
   it. This is the actual UX argument for 3D that Looking Glass never had: the
   road is a *spatially addressed* window list.

7. **Focus follows the flatten, never the drive-by.** A window becomes keyboard
   focus only when it has flattened to fronto-parallel. Passing a window at 15
   u/s must not steal your keystrokes.

8. **There is always a way out that does not depend on the 3D scene.**
   `Ctrl+Alt+Shift+Esc`, listened for in **capture phase**. This is the PARKVPS
   escape hatch and the reasoning transfers exactly: a focused client eats every
   key including Esc. Not Esc+CapsLock — CapsLock is a lock, not a modifier, so
   it steals Esc from vi whenever the light is on and the browser cannot see it.

---

## 5. Scenes, re-missioned

RAVIO's gearbox is a P/R/C/D gate right of the wheel (design x 1452–1604, the
only empty column). Three rules made every awkward case fall out and they still
hold: a gear feeds the **existing** `holdT` stop term rather than adding a second
kind of not-moving; a scene pins to `stageRect()`; one element per source,
re-parented rather than duplicated.

| gear | RAVIO | RRABBIT |
|---|---|---|
| **D** | the road | the road — windows as signs, flying past |
| **P** | drive-in, grown from the bezel | **the focused window, full frame** — the flatten's destination |
| **R** | c u l8er full frame | **the district overview** — all workspaces at once |
| **C** | camera + mic | camera + mic (unchanged; it is a shell feature too) |

P is already two layers — `#park` z-10 screen, `#pchrome` z-4 rail behind it,
because the rail sits exactly where the shifter is bolted. **The rail's tab strip
is the window list.** That is not a new widget; PARKVPS already proved the shape
by making it the fleet list.

---

## 6. Input

We composite, so we route. Greenfield's `addInputOutput` binds DOM listeners to
a scene canvas and maps client coordinates to surface coordinates — that path is
bypassed along with `scene.render`.

The replacement:

```
pointer → raycast the billboard quad → hit UV → surface-local px → Greenfield Seat
```

RAVIO already has every piece of this. `world/index.html` has a working
`intersectObjects` pick path, with two defects already found and fixed that would
otherwise be re-found here:

- `ribbons` held `{g,x0,x1,yLift}` — **the mesh was built inline and dropped**,
  so `intersectObjects` threw on a plain object.
- A conveyor's **cached `boundingSphere` is stale**, because positions are
  rewritten in place every frame. Null it before picking.
- `#dashcv` is `inset:0` + `pointer-events:auto` at z-index 6, so **`#gl` never
  receives a click**. Scene picking lives in the dash handler's no-hit
  fall-through.

---

## 7. Not solved, and not pretended otherwise

These are named now so that no milestone can quietly claim them.

- ~~**`xdg_popup` positioning.**~~ **CLOSED — see §16.** The billboard has no
  rectangle, but the ledger does, and the compositor computes the position from
  the client's own positioner. The working assumption ("a popup forces the
  flatten") turned out to be unnecessary: a popup is a child quad on the sign
  and works while driving. Separately, §16.1 found that popups cannot map at all
  in rc1 — a defect one layer below this entry.
- **Drag and drop, clipboard, XWayland.** Greenfield implements core + xdg-shell.
  Everything else is ours to answer.
- **Keyboard routing across a moving scene** — see invariant 7.
- **Encode cost.** One h264 encode per window, server-side. This is the same cost
  model that reshaped RAVIO M6, and it will set the real window ceiling long
  before anything in the renderer does. **Unmeasured.**
- **Tempo.** `dial_check.py` measured amp's change feed at 15–25 rows/hour against
  a road passing 1800 signs/hour, and that forced `S = 30 → 300`. Windows invert
  it: there are 5–30 of them, and at one sign per ~20s, driving past 20 windows is
  a 7-minute commute. **The window channel needs its own spacing or a "gather"
  affordance.** Same class of error as expecting `evidence` to carry every
  timescale — do not assume S transfers.

---

## 8. Milestones

**M0 — the occlusion proof. PASSED (2026-08-08).** See §10.

**M1 — many windows, one road. PASSED (2026-08-08).** See §11. Titles from
`surfaceTitleUpdated` and app ids from `surfaceAppIdUpdated` are **not** done —
signs carry no caption yet.

**M2 — the flatten. PASSED (2026-08-08).** See §12.

**M3 — the tubes. PASSED (2026-08-08).** See §14. The FreeBSD reader is written but UNVERIFIED (§14.3).

**M4 — districts. PASSED (2026-08-08).** See §15. NOT as Wayland outputs — §15.1 records why that shape does not work.

**M5 — the session. BUILT (2026-08-08), NOT BOOTED on T&R.** See §17. Verified
off-target including in Firefox; the bochs-VGA/no-DRM gate is untested (§17.2).

---

## 9. Licence

Greenfield is **AGPL-3.0**. RRABBIT links it as a library and patches it, so
RRABBIT is a derivative work and ships AGPL-3.0. For a shell in an open distro
that is the correct and intended outcome. It is recorded here because AGPL's
network clause is a real constraint on anything hosted, and the decision should
never be a surprise later.

three.js r160 is MIT and already vendored by RAVIO with sha256 provenance in
`world/assets/PROVENANCE.json`. That convention carries over.

---

## 10. M0 — the occlusion proof, and what it cost

**Passed 2026-08-08.** `m0/` — evidence in `docs/m0-occlusion.png`.

A pure-TypeScript Wayland client (Greenfield's `simple-shm`, vendored to
`m0/client/`) connects to a Greenfield session; its output canvas is used as a
three.js `CanvasTexture` on a billboard at z −600; an amber pylon at z −300 and
a gantry at z −330 stand between it and the camera.

**Measured, not merely seen:**

| | |
|---|---|
| surfaces | 1 (a real `wl_surface`) |
| scene refreshes | 827 → 1005 → 1048 → 1091, climbing |
| board sweep, 12×12 | 44–46 of 144 samples amber — the occluders **cut the live surface** |
| liveness digest | 3949704467 → 1972077845 → 472223074, changing every read |

A changing digest with steady occlusion is the whole claim: the surface is live,
and geometry is in front of it. This is what `CSS3DRenderer` cannot do and why
RAVIO §9 ruled the equivalent out for web pages. **§2.3 stands.**

M0 deliberately used the scene-canvas `CanvasTexture` shortcut, **not** the
shared-context path of §2.2 — the gate is occlusion, and one window does not
need per-surface textures. M1 does.

### 10.1 Findings that would cost a day if re-derived

- **The debug preview's CSS size silently became the Wayland output
  resolution.** `Scene.ensureResolution` installs a `ResizeObserver` that sets
  `canvas.width/height` from `clientWidth/clientHeight`. Styling the corner
  control view `width:256px` made the compositor's screen 256×150. Shrink it
  with **`transform: scale()`**, which scales what is painted and does not touch
  `clientWidth`. *A debug affordance decided a product dimension.*
- **A `CanvasTexture` does not re-allocate when its source canvas is resized.**
  It stays at the size of its first upload, and the new smaller content lands in
  a corner of the old allocation with the rest black. Reads as a broken texture;
  is a wrong-shaped one. Watch the size and dispose+rebuild. RAVIO already had
  this rule for `VideoTexture` (§9.1) — **it is a `CanvasTexture` rule too.**
- **Sampling one point is not an instrument.** The first run reported the board
  black because the probe point was aimed where the surface was not — which is
  indistinguishable from a dead pipeline, and sent the diagnosis to
  `preserveDrawingBuffer` (wrong: `toDataURL` returned 12,370 bytes vs 2,118 for
  a blank canvas, which is what disproved it). Sweep the face and report
  coverage. *A hole in the arithmetic looks exactly like a hole in the data* —
  the same lesson RAVIO's milepost tape recorded, in a new costume.
- **Greenfield takes seconds to begin compositing.** Read at 6 s:
  `sceneRefreshes: 1`, and it looks dead. Read at ~15 s: 827. **A too-early read
  is a false negative**, the same class as RAVIO's "measurements must outlast a
  frame".
- **The control view earned its place on the first run.** Corner alive +
  billboard black localised the fault to the texture upload immediately. Without
  it, "compositor broken" and "texture broken" are the same screenshot.

### 10.2 Harness findings (`agent-browser`)

- **The shared default session produced no frames at all** — raw
  `requestAnimationFrame` fired **exactly once** and stopped, with
  `visibilityState: "visible"`. Greenfield's render loop is also rAF, so both
  stalled and it read as two bugs. Use an isolated `--session` plus software GL:

  ```
  --args --use-angle=swiftshader,--enable-unsafe-swiftshader,--disable-gpu-vsync,--disable-frame-rate-limit
  ```

- **`--args` is IGNORED once the daemon is running** (`⚠ --args ignored: daemon
  already running`) — `agent-browser close` first, or the flags silently do
  nothing and the failure looks like the page.
- **`eval` keeps globals between calls**, so `const t = …` twice throws
  `Identifier 't' has already been declared` mid-run. Wrap each eval in an IIFE.

---

## 11. M1 — many windows, one road

**Passed 2026-08-08.** `m1/` — evidence in `docs/m1-many-windows.png` and
`docs/m1-driving.png`.

Three separate `wl_client`s, three surfaces, three signs, each sized to its own
surface and carrying its own adopted texture. The shared-context path of §2.2,
built.

| | |
|---|---|
| surfaces / signs / adopted | 3 / 3 / 3 |
| per-sign sweep | **64 of 64** samples carry content, on every sign |
| digests | three distinct, all changing every read |
| mileposts | 1, 2, 3 — unchanged after driving to z −420 (**invariant 6**) |
| orientation | `upright: true`, by calibration (§11.2) |
| Greenfield patches | **none** |

M0's board was one fixed rectangle with a 250×250 client in the corner. M1's
signs are 64/64 because **one surface is one sign, sized to the surface.**

### 11.1 The shared context needs no patch

§2.2 called for patching `setupCanvasGLContext`. It does not need patching:
**`canvas.getContext('webgl')` on a canvas that already has a context returns
that same context.** Hand Greenfield three.js's canvas and the context is shared.

The condition is that three must be on a **WebGL1** context — `'webgl'` will not
return an existing `'webgl2'` context, they are distinct types and the request
returns `null`, which surfaces as Greenfield throwing *"This browser doesn't
support WebGL!"*. That reads as a browser problem and is a context-type
mismatch. So create the context yourself and pass it to `WebGLRenderer`.

Suppressing the paint is a one-line runtime override of `scene.render`, and it
is safe because **render states are created in `View.applyTransformations()`,
not in `Scene.render()`** — the decode still runs, the textures still fill.
Frame callbacks also still fire, so clients keep drawing.

This is monkey-patching a published `1.0.0-rc1`, not a supported API.
`session.renderer` and `view.renderStates` are internals. **Recorded as a real
risk:** an rc bump can move them, and the failure would be at runtime.

### 11.2 Findings

- **A view only gets a renderState if it INTERSECTS the scene region.** A window
  outside the output has no texture at all — not a black one, none.
  `ensureRenderStatesForMatchingScenes` filters on `notEmpty(visibleRegion)`.
  Consequence for the design: **the Wayland output is the window ledger and must
  be big enough to hold every window; the road is a view of it, not a
  replacement for it.** This constrains M4's districts.
- **`setRenderTargetTextures` dereferences `renderTarget.depthTexture`
  unconditionally.** `properties.get(renderTarget.depthTexture)` on a plain
  render target puts `null` into a `WeakMap` and throws *"Invalid value used as
  weak map key"* — three lines above the branch that handles
  `depthTexture === undefined`. Give the target a `DepthTexture` it will never
  use. (three r160.)
- **`flipY` is an UPLOAD-time flag and adoption does no upload**, so it does
  nothing here. A Wayland surface is top-left origin and a GL texture is
  bottom-left, so the correction must happen at SAMPLE time:
  `repeat.y = -1, offset.y = 1`.
- **A symmetric test pattern cannot verify orientation.** `simple-shm` draws
  concentric circles in a square, which are mirror-symmetric about the midline,
  so *no* sample pair of it can ever decide the flip. The first version of the
  test compared two white margin rows, got a distance of 0, and returned
  `upright: false` from `0 < 0`. **An inconclusive test that returns a boolean is
  worse than one that returns nothing** — it now reports `inconclusive`. The
  answer came from `__calibrate()`, which tests OUR path with a texture that is
  asymmetric by construction (first rows red, last rows blue) and reads back
  red-at-top.
- **Furniture that crosses the picture is an instrument that lies about the
  picture.** The sign post ran through the lower face, so a readback sample came
  out amber and read as the window being upside down. The post now stops at the
  sign's bottom edge.
- A sweep of a sign that has gone behind the camera reports `0/0`, not a
  failure. **Refusing to answer has to work in both directions** — the same rule
  RAVIO's soak report had to learn about slopes.

---

## 12. M2 — the flatten

**Passed 2026-08-08.** `m2/` — evidence in `docs/m2-flat.png`. `m1/` is frozen.

Fly into a sign; arrive fronto-parallel and pixel-exact; point and type into the
real client; leave with a chord that no application can swallow.

| claim | measurement |
|---|---|
| pixel-exact | surface 250×250 → screen **250.00 × 250.00**, `scale: 1.0000` |
| fronto-parallel | top edge **250.00**, bottom edge **250.00** (equal ⇒ no foreshortening) |
| pointer maps | UV (0.5,0.5)→(125,125), (0.1,0.1)→(25,25), (0.9,0.9)→(225,225), (0.25,0.75)→(62,188) |
| routing resolves | `pickView` returned the aimed surface for **every** milepost |
| keyboard arrives | plain ESC while flat → the client **exited** → 3 surfaces became 2 |
| escape chord | Ctrl+Alt+Shift+Esc → `flat` → `driving`, by a real key press |
| placement | mileposts unchanged by flying, and by a neighbour being destroyed |

The camera flies to the window; **the window never moves** (invariant 6).

### 12.1 Pixel-exact, and why it is checkable

A world length L at distance d covers `L / (2·d·tan(fov/2))` of the viewport
height, so `d = signWorldHeight · viewportPx / (surfacePx · 2·tan(fov/2))`.

`__flatMetrics` measures the sign's **projected corners**, not the formula that
placed the camera — checking the formula against its own prediction would be
testing the arithmetic against itself, which RAVIO already had to learn on the
yoke and the dials.

### 12.2 Input needs no synthetic DOM events

`ButtonEvent` is a plain object `{x, y, timestamp, buttonCode, released,
buttons, sceneId}` in **canvas-pixel space**, and `session.inputQueue` takes it.
So: raycast the sign → hit UV → the surface's rect in the flat output → queue.
That is exactly what Greenfield's own listeners do, one step further down.

Greenfield's listeners are silenced with a **capture-phase `stopPropagation` on
`window`** — capture at window runs before target-phase listeners on the canvas.

### 12.3 The finding that makes invariant 7 a SAFETY property

**Every window occupies the identical rect `[0,0,250,250]` in the flat output.**
Greenfield stacks them all at the origin. So the flat output *cannot tell windows
apart by position*, and `pickView` can only separate them by stacking order.

Pointer routing is correct **only because the flatten calls `activateSurface`,
which raises the view**, making the flattened window topmost before any event is
routed. Invariant 7 was written as a UX rule — *focus follows the flatten, never
the drive-by* — and it turns out to be the thing that keeps input from landing in
the wrong application. Routing input to a non-flat window (a hover preview on the
road, say) would hit whichever window happened to be on top.

Consequence for **M4**: §11.2 said the output must be big enough to hold every
window. It now also has to *place* them — RRABBIT must lay windows out in the
flat output itself if it ever wants position-based routing.

### 12.4 Three more

- **`activateSurface` is not enough for keyboard.** Greenfield's keydown listener
  is on the canvas and its `focus` handler is what calls
  `notifyKeyboardFocusIn()`. Without an explicit `canvas.focus()` the surface is
  activated, looks focused, and receives **no keys at all**.
- **A window can close while you are inside it.** The client exits, the surface
  is destroyed, and the shell sat flat against an empty milepost with input
  routed to a surface that no longer existed. Found by pressing ESC in a client
  that exits on ESC — i.e. by the keyboard test succeeding. Now releases.
- **1:1 on a small surface is a small picture**: a 250×250 client fills 250×250
  of a 1280×720 viewport. The tunable is **integer** scale only (2×, 3×) —
  non-integer resampling is the exact thing pixel-exactness was protecting.

### 12.5 Still not proved

- **No native application has been through any of this.** Every window so far is
  an in-browser WASM/JS client. `compositor-proxy` + the gstreamer encode is
  where §7's per-window cost stops being theoretical.
- `xdg_popup` (§7) is untouched, and a popup is the first thing a real menu does.
- Pointer *hover* on the road is deliberately not routed — see §12.3.

---

## 13. Native applications — how far they get, and where they stop

**WORKING as of 2026-08-08 — see §18. The sections below record how it failed
first, and are kept because the diagnosis is what led to the fix.**

This was run before M3 on purpose: it is the one remaining thing that could
invalidate the architecture, and every later milestone gets more expensive to
redo. The architecture survives — the browser half is proved by M0–M2 — but
`@gfld/compositor-proxy@1.0.0-rc1` does not deliver frames on this machine.

### 13.1 How far it gets

| step | result |
|---|---|
| prebuilt native addons load (`libwestfield.so`, `libproxy-encoding.so`, 3 `.node`) | ✅ all deps resolve, no build needed |
| proxy listens | ✅ 127.0.0.1:8912 |
| nested Wayland compositor spawns | ✅ `WAYLAND_DISPLAY=wayland-1` |
| XWayland starts | ✅ display `:2`, XWM connection handled |
| native app launches and **stays running** | ✅ `xterm` pid alive |
| client connects, 4 data channels open | ✅ |
| browser compositor sees the surface | ✅ `surfaces: 1`, `mapped: true` |
| **a buffer arrives** | ❌ `hasBuffer: false`, `renderStates: []`, rect `[0,0,0,0]` |
| a sign is built | ❌ |

So the whole control path works and the **content path never starts**. No frame
is ever encoded or delivered, so §7's per-window encode cost is **still
unpriced** — nothing has exercised it.

### 13.2 The two-GPU crash, which is the finding worth keeping

The session process died with **`SIGTRAP`** on every attempt. The cause, only
visible at `LOG_LEVEL=trace`:

```
[EGL] eglCreateContext error: EGL_BAD_CONTEXT: Failure in argument parsing
ERROR: Failed to create GstGLContext: EGL_BAD_CONTEXT
Proxy session exited: SIGTRAP
```

GStreamer's GL element cannot create an EGL context against the **NVIDIA**
driver, and GLib's `ERROR` level calls `abort()` — which is why a GL
configuration problem presents as a signal rather than a message.

This machine has **two GPUs** — `renderD128` is `nvidia`, `renderD129` is
`amdgpu` — and the proxy defaults to `renderD128`. Passing
`--render-device=/dev/dri/renderD129` **removes the crash entirely**: the session
survives and the app reports `open`. Frames still do not flow, so this is a
necessary fix and not a sufficient one.

**A single-GPU NVIDIA machine would have had no way out of this**, which matters
for T&R: the target is a QEMU guest with bochs `std` VGA and no DRM kmod at all.
That gate (spec §"the VGA/DRM experiment") is now more suspect, not less.

### 13.3 Packaging defects in `@gfld/compositor-proxy-cli@1.0.0-rc1`

All four had to be worked around before the proxy would start at all:

- **The published `dist/` is incomplete** — it contains only `main.js`;
  `main-controller.js`, `main-args.js` and `SessionProcess.js` were never
  published, so the CLI cannot run as installed (`Cannot find module
  './main-controller.js'`). The package *does* ship its `src/`, and the CLI has
  no native code of its own, so it can be rebuilt: bundle `src/main.ts` and
  `src/SessionProcess.ts` with esbuild, `--external:@gfld/compositor-proxy`.
- **The bin has no shebang**, so npm's wrapper hands JavaScript to the shell
  (`line 1: use strict: command not found`).
- **`SessionProcess` is `fork()`ed as a sibling file**
  (`fork(path.join(__dirname, './SessionProcess'))`), so a single-file bundle can
  never work — and in a `"type": "module"` package the output directory needs its
  own `{"type":"commonjs"}` or the fork is parsed as ESM.
- **`--allow-origin` cannot take the comma-separated list its own help
  advertises.** The value is written raw into `Access-Control-Allow-Origin`, and
  a list is invalid CORS — with `credentials: 'include'` it must be exactly one
  origin. The symptom is a preflight that returns **204** followed by a `GET`
  that fails as `TypeError: Failed to fetch`, with **nothing at all in the proxy
  log**, which reads like the proxy being down.

### 13.4 A launcher finding that is not Greenfield's fault

**A GApplication single-instance app cannot be launched into a nested
compositor.** `gnome-text-editor` was the first choice — GTK4, Wayland-native,
real glyphs, real menus. Launching it handed off over D-Bus to the copy already
running in the user's own session (`--gapplication-service`, pid alive since the
previous day) and the new process exited immediately. The proxy reports this as
a launch error with no explanation.

Applies to most modern GTK/GNOME apps. `xterm` was used instead; `firefox` needs
`--new-instance --no-remote` for the same reason, which the app config sets.

### 13.5 Narrowed further (same day)

More was ruled out after the first write-up:

- **The system's GStreamer GL is healthy.** `videotestsrc ! glupload !
  glcolorconvert ! gldownload ! pngenc` succeeds on this box in all three of:
  default, `GST_GL_WINDOW=surfaceless`, and `LIBGL_ALWAYS_SOFTWARE=1`. So the
  fault is in **how the proxy sets up EGL** (it binds `EGL_PLATFORM_DEVICE_EXT`
  to a chosen render node) and not in the machine.
- **There is no non-GL encoder to fall back to.** Every pipeline in
  `gst_frame_encoder.c` — including the `png` fallback that exists for surfaces
  too small for x264 — begins with `glupload`. GL is not the fast path, it is the
  *only* path.
- `LIBGL_ALWAYS_SOFTWARE=1` makes it **worse**: `SIGSEGV` instead of `SIGTRAP`.
- With `--render-device=renderD129` (AMD) plus
  `GST_GL_WINDOW=surfaceless GST_GL_PLATFORM=egl GST_GL_API=gles2` the session is
  **stable, with no GL errors at all** — 4 channels open and stay open, the app
  runs, the surface exists — and still `bufferContents` is null. The encoder does
  not error; it simply never emits.
- Firefox fails differently and earlier (`Data connection closed. Code: 1006`,
  one channel instead of four), so it is not a second data point for the same
  fault. xterm is the better subject.
- **The Docker image is not a usable test.** The only published tag of
  `udevbe/compositor-proxy-cli` is **`20231106`** — November 2023, against
  browser-side packages published in late 2025. It would pair an old proxy with a
  new compositor.

**The remaining route is to build `@gfld/compositor-proxy` from source against
this system's gstreamer 1.26.10 rather than trusting the prebuilt addons.**
Every library dependency is already present — libffi, libudev, gbm, libdrm, egl,
gstreamer-1.0/app-1.0, graphene. Only the build *tools* are missing:

```
sudo pacman -S --needed cmake ninja
```

### 13.6 What to try next

In rough order of cost:

1. Run the proxy in the project's **Docker image**, which pins the gstreamer/GL
   stack the addons were built against.
2. Force the software GL path (`LIBGL_ALWAYS_SOFTWARE=1`) so gstgl stops
   negotiating with a vendor driver at all — the encode is h264 either way.
3. Build `@gfld/compositor-proxy` from source against this system's gstreamer
   rather than using the prebuilt addons.
4. Ask upstream. The rc1 packaging defects in §13.3 are worth reporting whatever
   happens to the frame path.

---

## 14. M3 — the tubes

**Passed 2026-08-08.** `bridge.py` + `m2/tubes.js` — evidence in
`docs/m3-tubes.png`.

Seven gauges reading the real machine, in RAVIO's unchanged rating shape
`{value, n, why, bar}`. Measured on this box:

| tube | value | n | bar | why |
|---|---|---|---|---|
| CPU | 0.74 | 74% | 1.0 | busiest process, named |
| RAM | 0.73 | 22597 MB of 31192 | 0.9 | `largest: claude-desktop at 1055 MB` |
| **SWAP** | **0.49** | 16761 MB of 34312 | **0.25** | `swapping is a fault, not a level` |
| DISK | 0.45 | 409 GB of 902 | 0.9 | `/ -- 493 GB free` |
| NET | 0.25 | 0.13 MB/s | — | `wlan0 -- scaled against the busiest 1.64 MB/s seen` |
| TEMP | 0.72 | 71.8 C | 0.85 | `hottest: k10temp` |
| LOAD | 0.58 | 21.23 | 1.0 | `14.83 / 13.35 / 13.28 over 24 cpus` |

Geometry checked against data rather than admired: `fillY == value × TUBE_H` on
every tube, SWAP is the only red one, and NET is the only one with no redline
ring because it is the only one with `bar: null`.

**Invariant 1, working end to end**: SWAP is over its redline and the strip
reads *"SWAP 49% over 25% — swapping is a fault, not a level"*. The rack is not
permitted to show a number it cannot explain.

### 14.1 Two states that must never collapse into one

- **Unknown is not zero.** `value: null` (no sensor, or no interval sampled yet)
  renders dim, empty, and captioned `?`. Drawing it as an empty tube would claim
  the machine is idle. Same distinction RAVIO's milepost tape needed between
  *quiet* and *not held*.
- **A bridge that is down is not a machine that is idle.** Verified by killing
  `bridge.py`: the last values stay on the rack and the strip turns grey with
  *"tube bridge unreachable — showing last known values"*. Blanking the rack
  would have been a claim about the machine.

### 14.2 Findings

- **A gauge scaled against a peak that includes its own sample always reads
  100%.** NET has no knowable ceiling — we never interrogated the link speed —
  so it scales against the busiest second ever observed. Folding the current
  rate in *before* dividing made every new maximum read exactly full: measured
  `value: 1.0` at `0.00 MB/s`, i.e. the first byte transferred pinned the
  needle. Scale against the **prior** peak, and report `null` until there is a
  prior peak to scale against. *Refusing to answer has to work in both
  directions* — the rule RAVIO's soak report learned about slopes.
- **A camera's children are only rendered if the camera is itself in the scene
  graph.** `scene.add(camera)`. Without it the rack exists, updates correctly,
  and is invisible — nothing errors.
- **A 128px label canvas clipped `72.0 C` to `72.0 (`** — a temperature that
  reads as a typo rather than as a truncation.
- **The per-tube exception guard earned its place immediately.** A `None`-seeded
  peak threw `'>' not supported between float and NoneType`; the rack stayed up
  and printed the error in that tube's own `why` instead of taking the other six
  down with it.

### 14.3 The FreeBSD reader is UNVERIFIED

`bridge.py` selects `FreeBSDReader` on `platform.system() == 'FreeBSD'`. It is
written from documented sysctl names (`kern.cp_time`, `vm.stats.vm.*`,
`hw.ncpu`, `dev.cpu.0.temperature`) plus `swapctl -sk` and `netstat -ibn`, and
**has never been run** — there is no FreeBSD host in this loop yet. Only the
Linux reader is measured. `disk` is shared between them because `statvfs` is
POSIX.

Known risk on FreeBSD: `dev.cpu.0.temperature` requires `coretemp` or `amdtemp`
to be loaded, so TEMP will report unknown on a stock image — which the rack
draws as unknown rather than as cold, per §14.1.

---

## 15. M4 — districts

**Passed 2026-08-08.** Evidence in `docs/m4-district.png`, `docs/m4-overview.png`.

Three workspaces, each a road of its own, windows opening into whichever one you
are standing in, and an overview that holds all of them at once.

| claim | measurement |
|---|---|
| windows open in the district you are in | `home:1 home:2 build:1 build:2 watch:1` |
| mileposts restart per district | yes — two `:1`s and two `:2`s across three roads |
| addresses survive switching | identical list after `0 → 2 → overview` |
| the camera really travels | district 0 `x −2600`, district 2 `x +2600`, overview `[0,1150,4600]` |
| **ledger rects are distinct** | 5 windows, **5 distinct rects** |
| **routing resolves by POSITION** | every window's centre resolves to itself, **with no flatten** |
| flatten still pixel-exact | district 1 milepost 2 → `scale 1.0000`, edges `250 / 250` |
| release returns to YOUR district | released in district 1 → camera back at district 1 |

### 15.1 Districts are a partition of the road, not of outputs

Spec §3 said "one Wayland output each". That is the wrong shape, and §11.2 and
§12.3 are why:

- every scene renders every view, so extra outputs do not partition anything
- a view only gets a texture where it **intersects** a scene's region
- and a scene's region is its canvas — the visible one

So there is **one** flat output, the ledger, and every window lives in it at its
own slot. The road is a *view* of the ledger; a district is a stretch of road.
§3's table is updated accordingly.

### 15.2 The ledger fix — §12.3 closed

§12.3 recorded that every window sat at the identical rect `[0,0,250,250]`, so
`pickView` could only tell windows apart by stacking order, and pointer routing
was correct *only* because the flatten raised its target first.

`view.positionOffset` — the same lever Greenfield's own `FloatingDesktopSurface`
uses to drag a window — places each window in its own grid cell. Measured: five
windows, five distinct rects, and **each one's centre resolves to itself with no
flatten and no raising**. The ledger is addressable by position now, which is
what a window manager is supposed to be. Invariant 7 remains a good rule; it is
no longer the only thing standing between a click and the wrong application.

### 15.3 Invariant 6, widened

A window's address is now **(district, milepost)**, and the **ledger slot** is a
third thing assigned once and never recomputed — a window that moved in the
ledger would change where its input lands.

Consequence worth stating: **a milepost alone no longer names a window.**
Mileposts restart in every district, so every lookup takes the district too, and
`flattenTo` defaults it to the one you are standing in.

### 15.4 "Too far to see" has two independent causes

The first overview rendered **black**. Fog was the obvious suspect — driving fog
is `far 4200` and the outer roads are 5000+ units away — but widening the fog
alone changed nothing, because **the camera's far plane is 6000** and the roads
sit 6000–12000 out. They were clipped before fog was ever consulted.

Both budgets have to move together (`setRange(fog, far)`), and the two failures
are pixel-for-pixel identical. Worth remembering as a class: an empty render has
a near-plane/far-plane explanation *and* a fog explanation, and checking one
proves nothing about the other.

Also: **frame where the windows are, not where the road goes.** Mileposts start
at 1, so the occupied stretch is the first few hundred units; framing all 6000
put every sign in a thin band at the horizon.

### 15.5 A key that must not reach the application

District keys (`1`..`3`, `O`) are deliberately **dead while flat**. A digit typed
into a focused application has to reach the application, not move you to another
workspace. Same family as invariant 7 and the `Ctrl+Alt+Shift+Esc` chord: the
shell may only take input the application would not have wanted.

---

## 16. Popups — §7's open problem, closed

**Passed 2026-08-08.** `clients/menu-shm/` + `syncPopups()` in `m2/shell.js`.
Evidence in `docs/m6-popup.png` and `docs/m6-popup-closed.png`.

§7 listed `xdg_popup` as the thing with no known answer, and called it the first
thing a real menu does. It is now working, and the reason it took a detour is
that **the problem was one layer below where §7 was looking.**

| claim | measurement |
|---|---|
| a real `xdg_popup` exists | client `menu-shm`, positioner anchored to a 120×26 bar at (12,12) |
| the compositor computes its position | popup rect `[132, 38, 262, 134]` = `BAR.x+BAR.width`, `BAR.y+BAR.height` |
| it renders on its parent's sign | overhanging the window's right edge, as a menu should |
| **input reaches the menu** | aimed at popup centre → scene point `[197, 86]` = the rect's exact centre |
| **and resolves to the POPUP** | `pickView` → the popup's own surface, not the window behind it |
| closing removes it | quad gone, `popupSurfaces: 0`, sign clean |

### 16.1 An xdg_popup cannot map in Greenfield 1.0.0-rc1

`surface.mapped = true` happens in exactly one place —
`FloatingDesktopSurface.commit()` — and that is reached from `XdgToplevel`,
`ShellSurface` and `XWaylandShellSurface`. **`XdgPopup.onCommit` never calls
it.** It acks the configure, schedules a render, and stops.

Measured directly: a surface with role `XdgPopup`, `hasBuffer: true`,
`mapped: false`, and no view anywhere. The client believed it had drawn a menu.

**This is not a 3D problem.** It is the reason no menu, dropdown, combobox or
tooltip can appear in this compositor at all, for any client, native or web.
Anyone building on rc1 will hit it the first time a user right-clicks.

**FIXED AT THE SOURCE (2026-08-08), not worked around.** The first version of
this section described a 10 Hz scan in the shell that finished the map itself.
That is gone. The fix mirrors `XdgToplevel.onCommit` exactly:

```diff
   this.committed = true
+  this.desktopSurface.commit()
   surface.session.renderer.render()
```

`FloatingDesktopSurface.commit()` already returns early while
`surface.size === undefined`, so the bufferless first commit is unaffected.

- `patches/greenfield-xdgpopup-map.patch` — the upstream-ready source diff,
  written against `packages/compositor/src/XdgPopup.ts`.
- `tools/patch-compositor.mjs` — applies the same change to the compiled dist
  that npm ships, since no released build carries it. It matches an exact string
  and **fails loudly** rather than applying to the wrong place, and runs from
  `postinstall` and `build`.

Verified with the shell-side workaround entirely removed: `stranded: 0`, popup
`mapped: true`, in the view stack, with a texture, composited onto its sign, and
a click resolving to the popup's own surface.

What remains in the shell is a **detector, not a fix** (`checkPopupsMapped`). A
shell that silently repaired this would hide a missing patch until someone
wondered where the menus went; instead it counts stranded popups and names the
command that fixes them. *(Caveat on how that was tested: reverting the patch did
produce the warning, but vite's in-memory module cache made that particular run
not cleanly isolated. The positive case — patch applied, workaround removed,
popups working — was verified on a freshly started server.)*

**rc1 and master are identical here**, so this is a live upstream bug, not
something already fixed in a newer build. It belongs in a report alongside
§13.3's packaging defects.

### 16.2 The billboard has no rectangle. The ledger does.

§7's worry was exact as far as it went: *"a popup is positioned relative to a
rectangle on its parent surface, and on a receding, curved billboard there is no
such rectangle."*

But the shell never needed to invent one. Once mapped, the popup has its own
rect in the flat output, its parent has one, and **the difference between them
is the offset in parent-surface pixels** — computed by the compositor from the
client's own `XdgPositioner`. The sign already knows how many world units it
spends per surface pixel, so:

```
local x =  (dx + popupW/2 - parentW/2) * scale
local y = -(dy + popupH/2 - parentH/2) * scale
```

M4's ledger (§15.2) is what makes this available. Placing windows at distinct
rects was done to fix input routing; it turned out to be the thing that makes
popups possible too.

The quad is a **child of the sign mesh**, so it inherits the sign's pose for
free and stays glued to the window through the flatten and the drive.

### 16.3 Findings

- **The raycast has to be recursive.** Popup quads are children of their sign,
  and `intersectObjects(meshes, false)` skipped them — which made every popup
  decorative: visible, and impossible to click.
- **A popup carries its own ledger rect, and routing must use it.** Mapping a
  menu click through the *parent's* rect would land somewhere in the window
  behind the menu — a bug that would look like "the menu does nothing" while
  quietly clicking whatever is underneath.
- **Nothing in this project could produce a popup**, which is why the problem sat
  open. `simple-shm` draws a toplevel and stops, and every native app is blocked
  behind §13. `menu-shm` was written to make the case exist.
- `menu-shm` is deliberately **vertically asymmetric** (cyan top half, dark
  bottom), which re-confirms upright orientation by eye — something §11.2 proved
  `simple-shm` structurally cannot do.
- A submenu's parent is another popup, so the walk up to the owning sign is a
  loop, not one hop.

---

## 17. M5 — the session

**Built and verified off-target 2026-08-08. NOT booted on T&R.** Evidence in
`docs/m5-firefox-boot.png`.

The shell now runs as a session: `npx vite build` on a workstation, and the
image ships the output. **The target needs Python only** — `bridge.py` serves
the built bundle *and* the seven gauges on one port, so there is no node and no
build toolchain in the distro.

| piece | where |
|---|---|
| built bundle (8.3 MB: 6.5 shell + 1.8 h264 worker) | `dist/`, gitignored |
| server for both shell and gauges | `bridge.py` |
| session script | `travel-and-rrabbit/overlay-desktop/usr/local/bin/rrabbit-session` |
| session entry, BESIDE the cockpit | `.../xsessions/rrabbit.desktop` |
| Firefox prefs (the gate — §17.2) | `.../share/rrabbit/user.js` |
| install into the image | `build-image.sh`, from `RRABBIT_DIST` |
| `python3` | added to `tandr-desktop.conf` |

### 17.1 Verified

- **The built bundle runs from `bridge.py` alone** — no vite, no node.
- **Firefox runs the whole shell**, which had never been tested: everything up to
  here was Chrome. Reported by the shell itself from headless Firefox 147:
  `crossOriginIsolated: true`, `SharedArrayBuffer: true`, compositor up,
  **5 surfaces → 5 signs**, 1132 frames, 3 districts, tubes polling, no errors.
- COOP/COEP are served on every response; `/` redirects to `/m2/`; path
  traversal is refused.
- The session script **falls back to the T&R cockpit** when there is no bridge
  or no python, waits for a real HTTP answer rather than an open port, and kills
  its bridge on every exit path.

### 17.2 NOT verified — the gate

**No T&R image has been built or booted with this session.** The whole thing
turns on WebGL surviving on a bochs `std` VGA adapter with Xorg `scfb` and no
DRM kernel module. `user.js` forces the software path
(`webgl.force-enabled`, `gfx.webrender.software`, `layers.acceleration.disabled`)
and that is a **hypothesis**, not a measurement.

§13.2 made this less comfortable, not more: GStreamer's GL could not create a
context on this machine's NVIDIA node, and a QEMU guest has *no* GPU at all.
The browser's software path is a different code path from gstreamer's and has
every reason to work — but "has every reason to work" is what §13 said too.

### 17.3 Findings

- **The rack booted FULL, and only a second browser showed it.** The fill
  geometry is 1 unit tall and scaled to the value, so an unscaled fill is ~5×
  the tube: seven amber bars running off the top of the frame before a single
  reading existed. Chrome never showed it because the bridge answered within the
  first frames; Firefox, starting slower, drew it every time. §14.1 says a gauge
  with nothing to report shows nothing — **that has to hold at t=0**, which is
  exactly when it is easiest to forget. Now dim, empty, captioned `?`.
- **A headless browser cannot be asked, so give it a way to speak.**
  `POST /api/report` plus `?report=<seconds>`; the shell posts what it managed
  to do. "The screenshot looked fine" is not a measurement, and the screenshot
  in question was of the bug above.
- **`firefox --screenshot` quits on load**, so it can never observe anything
  time-dependent. The first beacon run returned nothing for exactly this reason.
- **Wait for an ANSWER, not for a port** — PARKVPS learned this against SLIRP,
  and a session script handing a URL to a browser has the same failure.

---

## 18. Native applications — working

**2026-08-08.** A real `xterm` runs on the road: X11 → XWayland → nested
compositor → h264 → browser → GPU texture → sign. Evidence in
`docs/m7-native-xterm.png`.

| claim | measurement |
|---|---|
| a native client is on the road | `surfaces: 1`, `signs: 1`, size **960×653** |
| frames arrive | `hasBuffer: true`, sweep `26/64`, non-zero digest |
| the flatten is pixel-exact | 960×653 surface → **960.00 × 960.00 edges**, `scale 1.0000` |
| it is legible | the prompt reads `[travis@PX13 RRABBIT]$` |

### 18.1 The prebuilt addon was built against a different gstreamer

§13 exhausted the environment and never found the cause because it was not in
the environment. The official build (`docker/compositor-proxy-cli-build.sh`)
**compiles its own gstreamer at branch 1.20**, with `gl_winsys=egl` and
`gl_api=opengl`. This machine has **1.28.6** — eight minor versions on. The
shipped `libproxy-encoding.so` links a gstreamer GL that is not the one
installed, which is why the pipeline connected, negotiated, logged nothing, and
emitted nothing.

Building the addon from source against the system gstreamer fixes it. It
compiled clean — 29 targets, GCC 16.1.1, no warnings — and needed only `cmake`
and `ninja`; every library was already present.

**So `ldd` resolving is not evidence that a native module matches its
dependencies.** Every symbol resolved the whole time §13 was failing.

### 18.2 The two buffer paths disagree about which way is up

A web client's shm buffer is uploaded straight to the texture and arrives
bottom-up, so it needs the uv flip. A native client's frame is h264 and is
decoded **through a shader that renders into** the texture, which flips it once
already — flipping again turns it upside down.

Measured on the xterm: `[travis@PX13 RRABBIT]` came out as
`[ɿɒʌiƨ@bXI3 ЯЯAᙠᙠIT]` at the bottom of the window. The axis was read off one
glyph: **`P` → `b` is a vertical mirror**; a horizontal one would have given `ꟼ`.
The flip is now chosen per `bufferContents.mimeType`.

### 18.3 THE BUILT BUNDLE WAS NOT THE SHELL I HAD BEEN TESTING

Found while inspecting the native client: **minification mangles class names.**
The production bundle reports constructor names of `ko`, `ro`, `mQ`, so every
`impl.constructor.name === 'Surface'` check was dead in the shipped artifact.

Consequences, none of which produced an error:

- **popups did not render at all in the built shell** — `popupsByParentKey()`
  keyed on the mangled name, so §16 worked only in the dev server;
- the detector written to catch exactly that (`checkPopupsMapped`) was **also**
  keyed on names, so it could never have fired.

**Property** names survive esbuild, so identification is by shape now
(`isSurface`, `isPopupRole` — `positionerState` is unique to `XdgPopup`).
Verified in the *built* bundle: `popupQuads: 1`, `stranded: 0`, popup click
resolves to `[197, 86]`.

A type check that depends on a name the build tool may rewrite is a check that
works until you ship it. §17 tested that the built bundle *ran*; it did not test
that every feature still worked in it.

### 18.4 Not clean yet

- **Frames tear.** The screenshot shows a diagonal split and heavily blurred
  glyphs — damage-region or keyframe artifacts in the h264 path, unmeasured.
- **Reloading the shell orphans the remote client.** The proxy session outlives
  the page and is keyed by `compositorSessionId`, so a reload joins a session
  whose client is bound to a browser connection that is gone: `app: open`,
  `surfaces: 0`, and an `xterm` still running. Restart the proxy between runs.
- The per-window encode cost is **still unmeasured** — one window is not a cost
  model.
- The addon build is not automated and lives outside this repo.
  *(Closed in §19.)*

## 19. The addon build, made reproducible

§18 left the fix for §13 living in a scratch clone under `/tmp`, which is a
tmpfs on this machine and lost it at the next reboot. It is now
`tools/build-addons.sh`: clone at a pinned commit, `cmake -G Ninja`,
`ninja install`, replace `node_modules/@gfld/compositor-proxy/dist/addons`, and
record a hash manifest at `tools/addons.lock.json`. The source tree lives in
`~/.cache/rrabbit`, deliberately not `/tmp`. `npm run addons` is the entry point.

The install **replaces** the addons directory rather than copying over it.
Overlaying left behind a `libwayland-server.so` symlink that one build produced
and the next did not, and the manifest then recorded it as if it belonged.

### 19.1 The check has to be an identity check

The failure it guards against emits no error at all, so there is nothing to
catch at runtime — the question "is the installed addon the one built here?" has
to be asked before anything starts. `tools/check-addons.mjs` compares sha256
against the manifest and fails on two conditions:

- **the files differ.** If they match `dist/addons.prebuilt-backup`, it says so
  in those words — that is what an `npm install` does.
- **the system gstreamer moved since the build.** An Arch upgrade re-creates
  §18.1 exactly, and silently.

Wired in at both ends: `postinstall` runs it with `--warn` (an `npm install`
legitimately restores the prebuilts, and should say so rather than fail), and
`npm run proxy` runs it as a hard gate.

**All three branches were made to fire before being trusted**, because §18.3 was
a detector that could never have fired: prebuilts restored → named as prebuilts,
exit 1; manifest gstreamer edited to 1.20.0 → named as drift, exit 1; `--warn` →
exit 0. `.comment` in the binary is a readable corroborator — the npm prebuilt
says `GCC: (Ubuntu 13.2.0-4ubuntu3)`, a local build says `GCC: (GNU) 16.1.1` —
but the hash is what decides.

### 19.2 The run recipe was prose, so `npm run proxy` did not work

The render device and the `GST_GL_*` triple existed only in §13.5 and §18.1 as
sentences. The script had neither, so the documented-working configuration was
not the one the repo could actually run. Both now live in `tools/proxy.sh`, and
the render node is chosen by **PCI vendor id** (`0x1002`) rather than by number:
the numbering has been stable because it follows PCI order, but picking the
NVIDIA node aborts inside GLib, so the choice is worth naming.

### 19.3 npm's `1.0.0-rc1` is not the `1.0.0-rc1` tag

Building the git tag `1.0.0-rc1` (`240c494`) produces addons that install,
load, start, and then deliver a window that **has no size and never gets a
buffer**: `mapped: true`, `rect: [0,0,0,0]`, `hasBuffer: false`, so no sign is
built and nothing is ever encoded. Building `6c578f4` (master at the time)
gives `rect: [0,0,960,653]`, `hasBuffer: true`. Reproduced twice each way.

So the addon must be built from the commit npm actually published, which is not
the commit the tag names. `build-addons.sh` pins the sha rather than tracking
`master`, because "whatever master is today" is not reproducible either.

**I first read this as the tag giving zero surfaces, and that was wrong** — it
was §19.4 happening to land on the tag's first run. The tag's real defect is
one layer up and only visible in `__views()`, not in the surface count.

### 19.4 The XWayland session start is flaky, on every build

Roughly one start in three delivers no surface at all. The signature is exact
and readable in the proxy log:

| | XWM connections | channels | surfaces |
|---|---|---|---|
| good | 1 | 4 | 1 |
| bad | 2 | 2 | 0 |

The bad case logs `XWayland started.` twice within 3 ms and the second
`upsertXWMConnection` throws `open EEXIST` from `new Socket({fd})` — the
displayfd read fires twice and the second attempt re-wraps a live fd. It is not
caught into a retry; the session just proceeds without a working window manager.

Measured 1-of-3 on `6c578f4` and 1-of-3 on the tag, so it is upstream and not
something this repo introduced. Until it is fixed, **a single failed start
proves nothing** — restart the proxy and check `XWM=` in the log before drawing
any conclusion from `surfaces: 0`.

### 19.5 `decodes` is a counter that can never move

`state.decodes` is declared at `m2/shell.js:96` and incremented nowhere. It
reads as a hard "no frames were decoded" signal and means nothing. Left in place
here only because removing it is a separate change; do not use it as evidence.

### 19.6 Still not clean

The tear is worse than §18.4 described. Flattened to 1:1 (`scale: 1.0000`, edges
equal) the prompt `[travis@PX13 RRABBIT]$` is legible and upright, so orientation
and geometry are right — but a large diagonal region of the frame is filled with
flat cyan and green that are not xterm's colours at all. That is not a blur or a
damage-region seam; most of the surface is never written. Unmeasured, and it is
the next thing to look at in the h264 path.

## 20. The tear, measured — two of it was ours

**2026-08-09.** §18's closing note called this "damage-region or keyframe
artifacts in the h264 path, unmeasured", and guessed at the encoder. Two of the
three things wrong were on this side of the wire, in how the shell shares one
WebGL context with Greenfield.

### 20.1 three left a vertex array bound, and Greenfield has none of its own

Greenfield's YUV→RGB pass converts a decoded frame with a full-screen triangle
strip: `bindBuffer`, two `vertexAttribPointer` calls, `drawArrays`. It never
binds a vertex array, because it was written for a context nobody else touches.

three does bind one, and leaves it bound when `render()` returns. The conversion
runs from a WebCodecs callback in its own task, so it recorded its attribute
pointers into **three's** VAO and then drew using whatever else three had left
in it.

| | measurement |
|---|---|
| extension present | `OES_vertex_array_object` ✓ |
| `VERTEX_ARRAY_BINDING_OES` after `render()` returned | **non-null** (before) |
| same, after `leaveNeutralVertexState()` | **null** |

The visible half of this was a full-canvas artifact — the surface stretched
across the whole viewport in blurred, magnified glyphs, over the road. It is
gone. It also silently corrupted the VAO three used next, which nothing was
looking for.

Greenfield's `Program.use()` reports `BUG? use gl program failed` by calling
`getError()` straight after `useProgram` — but `getError` returns the first
error since anyone last asked and clears it, so that message names the wrong
call. Sampling the flag at a fixed point in our own frame gives `glErrors: 0`
over thousands of frames: three is not leaving errors behind, and the message is
Greenfield draining its own.

### 20.2 The decoded texture is bigger than the surface

Measured on a real `xterm`:

| | width | height |
|---|---|---|
| surface (`renderState.size`) | 960 | 653 |
| decoded texture (`renderState.texture.size`) | **1024** | **770** |

A plain three material maps a texture `0..1`, so the sign was showing the
padding as well as the picture. Which sub-rect holds the picture is not a guess:
Greenfield's own shader builds its quad from `textureMinU = 1 - width /
texture.width` running to `1`, so the picture sits at the bottom-right of the
allocation, and `adoptSurfaceTexture` now samples that same window. For an
unpadded buffer — every shm client, verified at 250×250 → 250×250 — the maths
reduces exactly to the previous repeat/offset, flip included, and the web
clients render unchanged.

### 20.3 What is left is upstream, and it is a shear

With both fixed, the flattened `xterm` is legible and correctly oriented, and a
**constant-slope diagonal** still divides it: picture above, flat cyan below.

- It is not our sampling. `?uv=full` maps the entire allocation and the boundary
  survives with the same slope, so it is in the decoded content.
- Flat cyan is what YUV→RGB gives for chroma left at its default, so the region
  below the boundary was **never written**, rather than written wrongly.
- A constant slope is a row-stride artifact, not a partial decode — a partial
  decode stops on a macroblock row and leaves a horizontal edge.

Not settled, and not fixable from here without patching `@gfld/compositor`'s
WebCodecs path. The obvious A/B — a different encoder — **could not be run**:
`vaapih264enc` is not installed (no `gstreamer-vaapi`), and `nvh264` needs the
NVIDIA node, which is the one gstgl cannot make an EGL context on (§13.5). That
is a missing measurement, stated as one.

### 20.4 The cyan was chroma read from the wrong offset

**2026-08-09, later.** §20.3 called the remainder "upstream, and a shear". Half
of that was right. The measurement that settles it is the decoded frame's own
geometry, read where it arrives:

| | width | height |
|---|---|---|
| coded | 1024 | **770** |
| visible | 1024 | **768** |
| surface | 960 | 653 |

`VideoFrame.allocationSize()` and `copyTo()` default their `rect` to the
**visible** rect, so the buffer holds 1024×768. `onComplete` then labels that
same buffer with the **coded** size. Two rows of difference, and the arithmetic
downstream is:

- `lumaSize = 1024 * 770 = 788,480`, against 786,432 bytes of luma that exist —
  so the Y slice eats the first **2,048 bytes of the U plane**;
- U and V are therefore both read 2,048 bytes — **four chroma rows** — late;
- V runs **3,072 bytes past the end** of the buffer, where `subarray()` clamps
  silently and the tail of the chroma texture is never written.

Displaced chroma is the diagonal. Never-written chroma is the flat cyan under
it. Patched in `patches/greenfield-webcodec-visible-size.patch`: label the
buffer with the size that was written.

**Result: the cyan is gone.** `renderState.texture.size` now reports
1024×**768**, matching the bytes, and the region that read flat cyan reads
neutral. A diagonal boundary remains on the **luma** side, so this was two
faults wearing one shape, and one of them is fixed.

Two process notes worth more than the fix:

- **I patched the wrong site twice before the right one.** `opaqueOutput` and
  `alphaOutput` record a `codedSize` that the I420 path never reads —
  `onComplete` builds its own. Patching them changed nothing and looked exactly
  like the patch not working.
- **The dev server served stale transforms for several rounds**, so three
  measurements that appeared to say "the patch had no effect" were measuring
  code that was never loaded. `curl` the module through the dev server and grep
  it before believing any negative result; the built bundle served by
  `bridge.py` has no such cache and is the honest place to test.

## 21. The reload orphan, closed — and the encode cost, still not priced

### 21.1 A reload no longer strands the client

The session id was the constant `'rrabbit-m1'`. The proxy keys its own session
off it, so reloading the shell rejoined a proxy session whose client was bound
to a browser connection that no longer existed: `app: open`, `surfaces: 0`, the
application still running. The documented workaround was to restart the proxy
between runs, which is a strange thing to have to do to the machine you are
developing against.

Each page load now takes a fresh id, and `pagehide` calls `session.terminate()`
so the old one is reaped rather than left to time out. `?session=<id>` pins one
for the case where rejoining deliberately is the point.

Measured against a proxy that was **not** restarted between loads:

| load | session id | surfaces |
|---|---|---|
| 1 | `rrabbit-msmicobc-fl7jph` | 1 |
| 2 | `rrabbit-msmid136-d8keme` | 1 |
| 3 | `rrabbit-msmidq7s-dcllqm` | 1 |

`xterm` process count after all three: **1**. The old clients are closed, not
accumulated.

### 21.2 The encode cost is still not priced, and now I know why not

§7 asked what a window costs. Two harnesses were built and **neither produced a
cost model**, which is the honest result rather than a number to quote.

`/busy-xterm` was added to `proxy/applications.json` — a window that never stops
changing — so the measurement would be of encoding rather than of an idle
window. Then:

| N windows | proxy CPU | shell fps | browser CPU |
|---|---|---|---|
| 0 | — | 60.9 | 7% |
| 1 | 0.4% | 51.4 | 13% |
| 2 | 0.4% | 61.0 | 7% |
| 3 | 0.3% | 60.9 | — |
| 4 | 0.4% | 60.9 | 7% |

Nothing here is monotonic in N, so none of it is a cost model. Three reasons,
all worth more than the table:

- **The proxy is not where the money is.** Eight threads, no children, and CPU
  flat at ~0.4% while Chrome sat at 425%. The expensive half of this pipeline
  is decode and composite, not encode — so "per-window encode cost" may be the
  wrong question, or at least not the first one.
- **Frame rate cannot answer it.** The shell is vsync-capped at ~61 fps, so it
  reports the same number until it falls off a cliff. Headroom is invisible to
  it.
- **The N=0 row is not a baseline.** With no `?remote`, the shell auto-launches
  its web clients, so that row has five surfaces in it, not zero.

### 21.3 Native launches drop above two

Asking for four `/busy-xterm` instances produced **two surfaces**, twice, with
no error surfaced in the shell. Three produced three. This was found while
trying to measure something else and is not diagnosed — but it means the
multi-window case is not merely unpriced, it is **not reliable**, and any cost
measurement that ignores that is measuring a smaller fleet than it asked for.

## 22. The seam between Travel and RRABBIT

**2026-08-10.** T&R names two personalities, not two layers. Travel navigates —
the road, the camera, the flight, the districts; its question is always *where
am I and how do I get to the other thing*. RRABBIT **is** the windows — the sign
on the road, the surface that flattens to 1:1 under you, the rect that decides a
click belongs to it; its question is *what am I and where do I stand*.

`m2/shell.js` held both, at 1,565 lines, with nothing in it marking which was
which. It is now four files:

| file | who |
|---|---|
| `m2/travel.js` | poses, districts, overview, flatten, flight, input |
| `m2/rrabbit.js` | texture adoption, signs, popups, ledger placement |
| `m2/world.js` | the stage neither owns: scene handles, the `signs` ledger, `state` |
| `m2/shell.js` | world construction, the frame, the tubes, the diagnostics |

### 22.1 A cut, not a rewrite

Every function body moved **verbatim**. The bindings they used to close over as
module-level `let`s are handed across by `attachTravel(ctx)` / `attachRrabbit(ctx)`
instead, which is why no line inside a moved function changed. `attach()` is
re-callable rather than one-shot because `session` does not exist at
`buildWorld()` time — it is created later in `main()`, and the second call is
what fills it in. Reading through `ctx` on every access would have been tidier
and would have meant editing every moved line; that trade was refused
deliberately.

The bundle went from 6,524.50 kB to 6,524.98 kB — the difference is comments.

### 22.2 The conversation is two reads and one call

The reason the seam is drawable at all is that the interface is tiny:

- **Travel → RRABBIT**: nothing. Travel reads the shared `signs` ledger for
  which sign stands at an address, and `view.regionRect` for the rect it owns.
  Both are data, not calls.
- **RRABBIT → Travel**: exactly one call. When a window dies *while you are
  standing in it*, `adoptPending()` calls `release()`. A window that vanishes
  under a driver who is inside it has to say so.

### 22.3 Re-measured, not assumed

Everything the old file carried, checked after the cut:

| | measurement |
|---|---|
| adoption | `surfaces 5`, `signs 5`, `adopted 5` |
| ledger (M4) | `placed 7`, five distinct slots across three districts |
| districts | `__district(1)` → camera at `districtX(1) = 0` |
| flatten (M2) | `mode flat`, `flatMilepost 1`; release returns to `driving` |
| flip line | `__calibrate` → `top [0,0,255]`, `bottom [255,0,0]`, `flipped: true` |
| **input across the seam** | `lastScenePoint [480,338]`, **`lastPickMatched: true`** |
| native h264 | `surfaces 1`, texture 1024×768 |
| health | `glErrors 0`, `frameError null`, 0 console errors |

`lastPickMatched` is the one that matters. Travel raycasts the sign, converts
the hit UV through RRABBIT's ledger rect, and Greenfield's own `pickView` — which
knows nothing about either personality — resolves that point back to the same
surface. The two halves agree, and something outside both of them says so.

**A trap worth naming:** `__calibrate` first returned all zeros after the split,
which reads exactly like a regression. It is not. That diagnostic places its
test quad at `x = 0`, which was in front of the camera before M4 introduced
districts and is district 1's road afterwards. Run from district 0 it measures
empty space. The diagnostic is pre-M4 and nobody had noticed.
