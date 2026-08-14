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

## 23. The window has a picture — the state was three's all along

**2026-08-13.** §20 ended with "a diagonal boundary remains on the **luma**
side", §18.2 recorded that "the two buffer paths disagree about which way is
up", and the T&R guest work stopped at a `foot` window that had a rectangle,
a title, a buffer and no picture. All three are the same fault, and it was
never in the encoder, the channel or the decoder.

Measured with a `foot` window from the `tr4` FreeBSD guest, x264, at the moment
Greenfield's conversion pass runs:

| GL state Greenfield inherits | value | Greenfield assumes |
|---|---|---|
| `CULL_FACE` | **enabled**, `BACK` / `CCW` | disabled |
| `DEPTH_TEST` | **enabled** | disabled |
| `BLEND` | **enabled** | disabled |
| `UNPACK_FLIP_Y_WEBGL` | **true** | false |
| clear colour | the road's navy | `(0,0,0,0)` |

Upstream that context belongs to Greenfield alone, so its passes set only what
they use. Here they inherit whatever three.js last left switched on.

### 23.1 Back-face culling drew exactly half the window

`YUV2RGBShader.updateShaderData` lays out **six** vertices — two triangles'
worth — and `draw()` issues them as a `TRIANGLE_STRIP`. That still covers the
quad, because the two triangles in the middle are degenerate. But a strip
alternates winding, so the two real triangles come out with **opposite**
winding, and back-face culling drops one of them.

Half a window, split corner to corner, picture on one side and clear colour on
the other. That is the "constant-slope diagonal" of §20.3, and it is why it
survived `?uv=full`: it was never a sampling window, it was a missing triangle.

**Only native windows were affected, and that is the tell.** `Scene`'s three
entry points are not alike: `image/bitmap` and `image/png` are a `texImage2D`,
which does not rasterise and so cannot be culled. Only `video/h264` runs a
shader pass. Every report of this fault named native applications, for four
weeks, and the shape of the report was the diagnosis.

### 23.2 The flip was never a property of the format

§18.2 branched on `mimeType` because an shm buffer needed the flip and an h264
frame did not. That was three's `UNPACK_FLIP_Y_WEBGL` left on: it flips every
plane upload, so which way a window was up depended on **which three.js texture
happened to be uploaded last**. The h264 path then flipped a second time in its
render-into-texture pass, and the two paths landed opposite ways round.

With the unpack state pinned off, both land the same way and the branch is gone:

- shm — upload row 0 → texel row 0, which is the surface's top row;
- h264 — the YUV pass draws `v = minV` at clip `y = -1`, clip `y = -1` is
  framebuffer row 0, framebuffer row 0 is destination texel row 0, and
  `v = minV` is the source's first row. Same answer by a longer road.

Either way texel row 0 is the top of the picture, and either way it wants the
flip, because three samples `v = 0` at the bottom of a plane.

### 23.3 §20.2 sampled the window the pass READS, not the one it WRITES

Both are real and they are not the same rectangle.

| | width | height |
|---|---|---|
| surface (`renderState.size`) | 696 | 468 |
| destination texture (`renderState.texture.size`) | **768** | **512** |

The pass calls `viewport(0, 0, 696, 468)` on a framebuffer the size of the whole
768×512 texture, and **a GL viewport is anchored at the bottom-left** — so the
picture is written to texels `[0..696) × [0..468)` and the margin is the top and
the right. `adoptSurfaceTexture` was sampling the far corner, from
`textureMinU`, which is where the pass reads inside the *padded decode*. The
cost was a black band down one side and along the top, photographed before and
after. `?uv=farcorner` still selects the old window; `?uv=full` still maps the
whole allocation.

### 23.4 The fix is a fence, and it is per-pass

`fenceScenePasses` (shell.js) wraps all three of `Scene`'s entry points:
neutralise the raster and unpack state on the way in, `renderer.resetState()` on
the way out so three stops drawing the road on Greenfield's settings.

Per-**pass**, not around `renderer.render` — the passes run in a microtask that
`render()` queues, so anything set outside it is only still true by luck. The
first attempt set the state in the pace wrapper and changed nothing on screen,
which is the whole reason this is written down.

### 23.5 Verified

| | measurement |
|---|---|
| native `foot` (tr4 guest, x264) | `surfaces 1`, `rect [0,0,696,468]`, `hasBuffer true` |
| the glass | `$ ls` / `$ ls bin` / `ls: bin: No such file or directory` — **legible, upright, filling the sign** |
| decoded frame | I420, coded 768×514, visible 768×512, `copyTo` layout tight at stride 768/384/384 |
| orientation, upload path | a red-top/blue-bottom bitmap through the fenced `image/bitmap` → glass reads **red at top, blue at bottom** |
| web client regression | `simple-shm` 250×250 renders unchanged |
| two windows together | `2 surface(s)`, one shm + one native, no console errors, no proxy errors |
| frame cadence | median **17.4 ms**, p90 17.5 over 335 frames |

The frame number is rAF cadence in headless SwiftShader, so it says the fence
costs no frames **in this harness** — it is not a GPU cost measurement, and
`renderer.resetState()` once per conversion pass has not been priced on real
hardware.

### 23.6 Two things this turned up and did not fix

- **Every window is one sRGB encode too bright, and always has been.** A known
  `#242424` uploaded through `image/bitmap` reads **105** on the glass;
  `sRGB_encode(36/255) = 106`. The map's `colorSpace = SRGBColorSpace` decode is
  not reaching the shader while the output encode is. It is **not** the h264
  path — the bitmap path measures identically — so it is in how RRABBIT adopts
  an external render-target texture, and it predates all of this.
- **`vah264enc` still aborts the proxy.** `gst_frame_encoder.c:350` `g_error`s
  when the encoded sample carries no `BUFFER_CONTENT_SERIAL`; `x264enc` copies
  the meta, `vah264enc` does not propagate input metas. Falling back to the head
  of the FIFO would work *if* output order equals input order — true for these
  zerolatency, no-B-frame pipelines, but an assumption, not a measurement.

## 24. In the distro, and in the machines rail

**2026-08-13, same day as §23.** The fix was built, shipped into the running T&R
guest, and looked at — with no browser in the loop for the guest half.

### 24.1 The built bundle carries it

`npm run build`, then grep the artifact for the strings the fix depends on —
`video/h264`, `image/bitmap`, `UNPACK_FLIP_Y_WEBGL`, `resetState`, `CULL_FACE` —
all present. String keys and GL constant lookups are property accesses, so
minification cannot touch them, unlike the class-name checks of §18.3.

Verified the built shell end to end, not just that it loads: `bridge.py` on 8913
serving `dist/`, proxy started with `RRABBIT_ALLOW_ORIGIN=http://127.0.0.1:8913`,
`foot` from the tr4 guest launched into it — **legible, upright, filling the
sign**, same as the dev server.

### 24.2 A running guest takes a new shell in about a second

The image ships `dist/` + `bridge.py` to `/usr/local/share/rrabbit/`; replacing
that directory over ssh and rebooting the guest is enough. Proved by hash rather
than by looking — guest and workstation both
`415a97c8c2eaa9ddca47ba0c554cdb4409e003aa430a13aa5eda98bd7c122b42`.

**The 0.4 image was carrying five orphan `shell-*.js` bundles** from earlier
builds. Same class as the addons manifest (§19): an overlay leaves files that
then look like they belong. Replace `dist`, never overlay it.

### 24.3 §"the shell cannot be evaluated in a VM" needs an amendment

That note was written when the guest ran an older build and reported firefox at
216% CPU. Measured now, on `tandr-desktop-0.4` with the current shell and two
`simple-shm` windows:

| | |
|---|---|
| the shell's own frame time | **17.1–17.2 ms** |
| guest CPU / LOAD (its own tubes) | 74–79% / 2.08–3.08 |

So it is not unusable — it renders the full cockpit at rAF cadence and costs most
of a small guest to do it. "Expensive" was right; "un-demoable" was not. Still an
`scfb` framebuffer with no 3D, so this is software rasterisation being fast
enough, not hardware appearing.

**Native windows still cannot originate inside the guest.** The image has no
node, no gstreamer and no compositor-proxy by design ("Nothing here needs node" —
`build-image.sh`), and the guest has no `/dev/dri` at all. Only in-browser shm
clients run there. §23's fix hardens that path (the unpack state is pinned rather
than inherited) but adds no new capability inside the VM.

### 24.4 Seeing it

QEMU hands over both directions, so a graphical guest needs no browser and no
agent inside it: `vps.py screenshot <name> <path>` writes the framebuffer,
`vps.py type <name> driver @tab driver @ret` types at the greeter. Both added to
PARKVPS today. That is how every image in this section was captured, including
the SDDM greeter — which ssh cannot see at all.

RAVIO's **MACHINES** rail (gear **P**, the drive-in) lists PARKVPS's fleet and
frames each guest at `http://127.0.0.1:8905/desktop/<name>`. That URL stands on
its own and shows the T&R desktop running the fixed shell.

**RAVIO itself could not be driven in the test harness** and that is not a RAVIO
fault: headless Chrome on SwiftShader loses the context on load with RAVIO's five
canvases where RRABBIT's four survive, and the dead dash canvas is the one that
owns gear changes — so `g` does nothing and the app reads as broken. Not
attributed further; that needs a real-GPU browser (§the start-menu note).

### 24.5 Not done

The golden image is **unchanged** — only the running `tr4` instance has the fix.
Rebuilding it would mean running `make.sh`/`build-image.sh` while a parallel
session has 161 uncommitted lines in exactly those two files, which is the
live-tree hazard this repo has already been bitten by. Deliberately not run.

See `docs/RUNBOOK.md` for the port map, the probes, and the traps.

## 25. "Programs are not startable from the ST&RT menu"

**2026-08-13.** Reported against the distro. Two separate things, and the second
one is mine.

### 25.1 What was actually true

Web clients **do** start from the menu, in the guest, with a real click —
`6 surface(s)`, `3 windows here`. Native programs do not, and cannot: the image
ships no compositor-proxy (§24.3), so `PROXY_BASE` names `http://127.0.0.1:8912`
inside a guest that has nothing on that port. Five of the seven rows.

That part is a limitation. The fault is that **nothing said so.**

### 25.2 The reporting half of "try, then report" never ran

§"THERE IS NO PROBE" replaced a lying probe with a promise: offer the row, and
let the first launch that actually fails record why and refuse the rest. The
promise was wired to `app.onError`. Measured with the proxy stopped:

| | before | after |
|---|---|---|
| `appStates[prog]` | `error` | `error` |
| `onError` fired | **no** | — |
| `state.error` | **null** | names the address |
| `lastLaunch.ok` | **`true`** | `false`, with `why` |
| the other native rows | **`ok:true`** | `ok:false`, and they say why |
| anything on screen | **nothing** | `Text Editor: no compositor-proxy at …` |

So: the menu shut, no window opened, every row still claimed it was fine, and the
shell's own record said the launch succeeded. Exactly "I clicked it and nothing
happened", which is the failure this shell is least willing to ship.

**`onStateChange('error')` is the failure signal; `onError` is not.** Upstream
calls `onError` only from the signalling socket's own `error` event — and a
browser `WebSocket` error event carries no `.error`, so even when it fires it has
nothing to say. `RemoteAppLauncher.error()` closes everything and reports through
`onStateChange`. Both are wired now; the state change is the one that works.

Two smaller things fixed with it, because each on its own would have left the
same silence:

- **`state.error` was never displayed anywhere** — it existed only in `__m1()`.
  The failure now goes to `say()`, the strip the shell already uses to say things.
- **`lastLaunch.ok` was set synchronously and never amended.** A launch that is
  accepted and then fails now says so, so `__m1()` stops agreeing with a window
  that is not there.
- The refusal **names the address that did not answer** rather than saying
  "compositor-proxy is not answering — npm run proxy". In the distro that
  instruction is wrong: there is no proxy to start, and the URL is the fact.

### 25.3 Verified in the guest, with real clicks

`vps.py click` (added to PARKVPS today, alongside `screenshot` and `type` — the
guest has a `usb-tablet`, so a pixel on the screenshot is a pixel to click). Web
program from the menu → a window opens. Native program → the strip says
`Text Editor: no compositor-proxy at http://127.0.0.1:8912`, and reopening the
menu shows all five native rows greyed with that line on each.

![the menu says why](../docs/m10-rows-refused.png)

### 25.4 A probe that invalidated itself

Worth recording because it nearly produced a wrong answer. I scanned for the
menu's rows with `window.__dashAt(x, y)` — and `__dashAt` calls `hooks.dashHit`,
which **is not pure**: it toggles the ST&RT menu and knocks the gear stick. 1500
scan points closed the menu I was measuring, and the first reading said the menu
would not stay open. `dash.hit()` is pure and documented as such; `hooks.dashHit`
is the layer that acts on it, and `__dashAt`'s own comment says it really does
knock the stick. Compute the rectangles from `layout()` instead:
`s = W / 1920`, `ty = H - 1080 * s`, `clientX = design.x * s`,
`clientY = design.y * s + ty`.

## 26. Applications that actually open

**2026-08-13.** §25 made the failure legible. It did not make anything start.
Four separate reasons a program would not open, none of them the same fault.

### 26.1 The proxy allowed one origin, and the shell has two

`tools/proxy.sh` allowed `http://127.0.0.1:8911`. The built shell is served by
`bridge.py` on **8913** — which is also the origin inside the T&R image. Every
native launch from the built shell was refused by CORS and reported as
**"compositor-proxy is not answering"**, while the proxy answered fine.

`--allow-origin`'s help says *"Value can be comma seperated domains"*. It is not:
the value went into the header verbatim, and `Access-Control-Allow-Origin` may
name exactly one origin — so a list refused every entry on it. Patched to echo
the request's origin when it is on the list
(`patches/proxy-cli-multi-origin.md`), and `proxy.sh` now defaults to both ports
and prints which it allowed.

This is the one that had the worst shape: confidently wrong, about the wrong
component, on a page that cannot probe.

### 26.2 The built menu listed the programs that do not work and hid the one that does

`proxy/applications.json` was not in the build, so every built shell — including
the distro's — fell back to `NATIVE_MIRROR`, a hand-copied constant. It had
drifted: five host programs, and **not** `foot · tr4`, which is the one native
entry that demonstrably opens a window.

The file now ships (`shipApplications()` in `vite.config.ts`, parsed at build
time so a malformed file fails the build rather than the menu). The mirror stays
as the fallback for a shell served from somewhere that has no `proxy/` at all.

### 26.3 gnome-text-editor exited 0 in 76 ms, and Wayland had nothing to do with it

The child inherits `DBUS_SESSION_BUS_ADDRESS`, finds the
`gnome-text-editor --gapplication-service` already running on the host desktop,
hands the request off to it and exits — the ordinary GTK single-instance
handoff. Its entry now points `DBUS_SESSION_BUS_ADDRESS` at a path that does not
exist, so GApplication cannot register and runs its own instance. **It opens.**

**A correction:** the earlier note that "compositor-proxy sets no
`WAYLAND_DISPLAY` for children" is wrong. It is absent from `proxy-cli.js` and
`SessionProcess.js`, but `launchApplication` in the library sets it last, over
`process.env` — the log line shows `WAYLAND_DISPLAY: "wayland-7"` and the proxy's
own `Listening on:` line says `wayland-7`. That was always right, and it sent me
looking at the wrong environment variable.

**Also corrected:** §"the native-app path is broken on this host" no longer
holds. `xterm` and `glxgears` both open through XWayland today.

### 26.4 `open` and `closed` are the socket's states, not the program's

Measured: a program that exits immediately cycles
`open → closed → open → closed` as the launcher reconnects; one that is running
sits at `open`. Neither says whether a window appeared, so neither can be used to
report "it did not start" — which is why a program that failed this way was
silent even after §25.

A window is the only evidence a program ran. `launchProgram` now watches the
surface count and, if nothing arrives in **12 s**, says
`no window within 12s — the program may have exited`. It is a timeout, worded as
what was observed rather than as a verdict, and it does **not** mark the proxy
down: the proxy answered, and blaming it would refuse every other native row
because one application on this host is unhappy. A named failure clears it, so
one click never prints two reasons.

### 26.5 Verified

From the **built** shell on 8913, with `npm run proxy` at its defaults and no
environment overrides: Text Editor opens (a real GNOME window, showing a real
file), and `foot · tr4` opens beside it — `2 surface(s)`, `2 windows here`, both
legible.

Still true, and unchanged: **inside the T&R image there is no proxy at all**
(§24.3), so native rows there refuse and now say the address that did not answer.

## 27. The distro's shell, pointed at the host's proxy

**2026-08-13.** §24.3 said native windows cannot originate inside the T&R image —
no node, no gstreamer, no `/dev/dri`. True, and beside the point: the proxy does
not have to be *ours*. It is reachable over the network, so the guest's shell can
use the host's.

### 27.1 Nothing has to be exposed

Under QEMU user-mode networking the host answers on the default gateway, and
SLIRP maps it to the host's **loopback** — so `--bind-ip=127.0.0.1` is already
reachable from the guest at `10.0.2.2:8912`. Verified with `fetch` from inside
tr4: the proxy's own 403 came back, which is exactly what the host gets.

The guest's page origin is `http://127.0.0.1:8913` — the same literal string as
the host's built shell, so §26.1's allow-list already covers it.

### 27.2 `--base-url` is one address, and there are two ways in

The proxy hands the client a `signalURL`/`baseURL` built from `--base-url`. A
static value is right for exactly one caller: the host browser reaches the proxy
on `127.0.0.1:8912`, the guest on `10.0.2.2:8912`, and whichever one is not in
the flag gets sent to an address that is not there — the guest would have been
told to connect to *itself*.

Patched to answer with the host the client actually used (`publicBaseURL`, beside
`pickAllowOrigin`; `patches/proxy-cli-multi-origin.md`). One proxy, both callers.

### 27.3 Detected, not assumed

`rrabbit-session` now appends `?proxy=…` **only when the default route is
`10.0.2.2`** — QEMU's own gateway. Anywhere else that address belongs to somebody
else's router, and pointing at it would fill the menu with programs that fail
slowly instead of refusing honestly. `RRABBIT_PROXY` overrides either way, and
the session logs which it chose.

### 27.4 What is proven, and what is not — SUPERSEDED by §27.6, kept for the reasoning

**Proven, from the host proxy's own log** — the component that cannot be wrong
about this:

```
Launching application gnome-text-editor …
Child process started.
New signaling connection from http://10.0.2.2:8912/signal?compositorSessionId=…
New Wayland client.
```

The guest reached the host, the host started a real application, the client
connected back — **and the address it was told to come back to was
`10.0.2.2`**, which is §27.2 working.

**Not working: no window appears on the guest's road.** The map still counts four
windows (`home 1`, `build 2`, `watch 1`), all `simple-shm`. The application is
running on the host with a live Wayland client and nothing renders in the guest.

Ruled out already: **not a missing decoder** — the image ships `openh264-2.6.0`
and `ffmpeg-8.1.2`.

Two candidates, and they are distinguishable:

- the frames never arrive or never decode in the guest's Firefox;
- a surface arrives and no sign is built from it (`adoptPending`). The §26.4
  watchdog says `no window within 12s` only when the surface count does **not**
  move, and it stayed quiet — which, if the shell was the current build, points
  at the second.

Neither can be settled without reading state out of a kiosk Firefox with no
devtools. `bridge.py`'s `POST /api/report` + `?report=<secs>` exists for exactly
that and is the instrument to use next.

### 27.5 A harness note that cost real time

Driving the guest by absolute clicks is workable but the shell reacts to misses:
a click that lands on the road **drives**, and while driving the cockpit slides
away, which dismisses the ST&RT menu. So a click that opens the menu followed by
a click that misses a row leaves no menu and a moving road, and the next attempt
looks like the menu refusing to open. Wait for `DRIVE 0`, and read the state off
the map (`0`) rather than hunting with the camera — it names every window and
which road it is on.

### 27.6 RESOLVED — and the report endpoint is what resolved it

![a host application on the guest's road](../docs/m12-host-app-in-guest.png)

A GNOME Text Editor running on the Arch host, drawn as a window on the road
inside the FreeBSD guest. `surfaces: 1`, `signs: 1`, `hasBuffer: true`,
`mapped: true`, rect **1202×770**.

**Both of §27.4's candidates were wrong**, and neither could have been
distinguished by looking harder at the compositor. `POST /api/report` settled it
in one boot, once it carried the right fields:

| field | what it said | what it ruled out |
|---|---|---|
| `proxyBase` | `http://10.0.2.2:8912` | `?proxy=` not reaching the shell |
| `programsFrom` | `applications.json` | the mirror still being used |
| `h264` | `supported: true` | a missing decoder |
| `appStates` | `open` | the launch failing |
| **`views`** | **`[]`** | frames arriving and not being adopted |
| **`errors`** | **`Failed to connect to application.`** | everything else |

`views: []` with `appStates: open` is the pair that names it: the signalling
socket connected and **no surface ever existed**. The error came from
`onProtocolChannel` — the per-application channel closed before it ever opened.

### 27.7 The proxy tells the client to connect somewhere it cannot know

`NativeAppContext.js` builds each application's protocol-channel URL from
`config.public.baseURL` — the single static `--base-url` — and **there is no
request in scope there**, so unlike the HTTP replies (§27.2) it cannot answer
with the host the client actually used. It can only repeat the flag, which said
`127.0.0.1:8912`. Inside a guest, that is the guest.

So the signalling socket connected (its URL comes from the HTTP reply, which
§27.2 had already fixed) and the protocol channel dialled the guest itself.

Corrected in `shell.js`, where the answer is known: we reached the proxy at
`PROXY_BASE`, so that is its address *for us*, whatever it believes. A narrow
rewrite over `window.WebSocket`, scoped to the proxy's own `/channel` and
`/signal` paths and a no-op when the hosts already agree — vite's HMR socket
shares that global and must not be touched.

**Two transports, two places, and neither covers the other**: WebSocket URLs are
corrected on the client because the server cannot know; the HTTP `baseURL` (used
for clipboard and file transfer) is corrected on the server, where a request *is*
in scope. Said here because one of them looks redundant until you ask which
transport it carries.

One `rejection: Error: websocket error` remains in the report — the reconnecting
socket's first attempt. Nothing user-facing (`error: null`), and not chased.

### 27.8 What the report endpoint needed to be useful

It existed and it could not have answered this. It carried `surfaces`, `signs`
and `error`, all of which said "nothing happened" without saying where. Added:
`proxyBase`, `programsFrom`, `appStates`, `lastLaunch`, `views`, `h264`, and a
bounded `errors` buffer — the shell had **no console capture at all**, so on the
one machine that matters every error went to nobody.

Bounded at 20, and **first** rather than last: the tube poll can emit hundreds of
identical failures (§the note above `pollTubes`), and the error that explains a
failure is almost always the first one.

`rrabbit-session` gained `RRABBIT_URL_EXTRA`, because a kiosk with no address bar
made every query-string diagnostic in this shell unreachable on the target.
`?remote=…&report=45` launches at boot and posts what it managed to do — no
clicking, which §27.5 is about.

## 28. The windows have to be the OS's own

**2026-08-13, and a scope correction from the operator.** §27 got a real GNOME
Text Editor onto the guest's road. It is running on the *laptop*, forwarded in.
That is a development bridge and it is **not the product**: a stranger who
downloads T&R has no host proxy, so they get the refusal, and the address in it
names a machine that is not theirs.

`rrabbit-session`'s proxy default is therefore **off**. It first auto-detected
the QEMU gateway and switched itself on — right for this laptop, wrong for
everyone else. An operator who wants the bridge sets `RRABBIT_PROXY`; nobody
gets it by accident.

### 28.1 The real thing is available — measured, from inside the guest

`pkg` on FreeBSD 15 has everything compositor-proxy needs:

| | |
|---|---|
| `node24-24.18.0` (+ `node22`, `npm`) | the proxy itself |
| **`gstreamer1-1.28.6`** | **the same version as the host** |
| `gstreamer1-plugins-x264-1.28.6` | software encode, which is what a guest with no `/dev/dri` must do |
| `mesa-dri-26.1.3`, `libdrm`, `graphene`, `libffi`, `glib` | the addon's pkg-config deps |
| `cmake`, `ninja`, `meson`, `pkgconf` | to build it |

The matching gstreamer version is the one that matters. §18.1 is this repo's
signature failure — an addon built against a *different* gstreamer links,
negotiates, logs nothing and emits no frames — and same-version on both sides
removes it before it can happen.

### 28.2 The three risks, named before starting

1. **The addon may not build on FreeBSD.** It is C against gstreamer-gl, gbm and
   libdrm, built by Greenfield's cmake. Nobody has compiled it there.
2. **gstgl needs a GL context and the guest has no `/dev/dri`.** Software GL
   (mesa `swrast`/llvmpipe, surfaceless EGL) is the only route. Plausible;
   unproven.
3. **It may build, run, and still be too slow to ship.** The guest already spends
   ~75% of four vCPUs software-rasterising the shell (§24.3). Adding software GL
   *and* software x264 for every window may not leave anything. This is the risk
   that a successful build does not retire.

### 28.3 What is NOT downloadable today, which is a separate blocker

Worth stating because it is the shorter path to a page on computedriven.com and
it is not the proxy's fault:

- the published release (`v0.3`) carries only the two **server** images —
  364 MB and 626 MB, headless, no X, no shell. **Nothing published runs RRABBIT
  at all.**
- the desktop image that does is **5.18 GiB**, and GitHub's per-file cap is 2 GB.

Measured, not assumed: an 800 MiB sample of that image compresses **4.83×** with
`zstd -9`, so the whole thing lands near **1.07 GiB** — under the cap. A
compressed asset is the unblock, not different hosting.

Also gating any rebuild: the golden predates this week's shell entirely, and
`build-image.sh`/`make.sh` carry uncommitted work from a parallel session.

### 28.4 Risk 1, first half: every dependency resolves on FreeBSD

Measured inside `tr4`, after `pkg install`, against the exact list
`tools/build-addons.sh` preflights:

| module | version |
|---|---|
| glib-2.0 | 2.86.4 |
| gstreamer-1.0 / -app / -video / -allocators | **1.28.6** |
| gstreamer-gl-1.0 | **1.28.6** |
| graphene-1.0 | 1.10.8 |
| egl / opengl | 1.5 / 4.5 |
| libffi | 3.6.0 |
| gbm | 26.1.3 |
| libdrm | 2.4.133 |

Twelve of twelve, and gstreamer at the **same 1.28.6 as the workstation** —
which is the version-skew trap of §18.1 closed before it can open.

Two naming traps for whoever writes this into `build-image.sh`:

- FreeBSD has **`gstreamer1-plugins`**, not `gstreamer1-plugins-base`. The
  obvious name fails the whole `pkg install` line.
- `gstreamer-gl-1.0` is **not** in it. It comes from its own port,
  **`gstreamer1-plugins-gl`**, and it is the one module the addon cannot be
  built without.

Also present: `node24-24.18.0`, `cmake 3.31.12`, `ninja 1.13.2`.

Nothing here says the C compiles — that is the next measurement, running now —
only that it can be attempted, which yesterday was unknown.

### 28.6 tr4 cannot build it either, and that settles where the build belongs

With `llvm19-lite` installed, clang compiles and then cannot **link**:

```
ld: error: cannot open crt1.o: No such file or directory
ld: error: unable to find library -lc
```

The image has no base-system development files — no CRT objects, no linkable
libc. Those are pkgbase `FreeBSD-*-dev` sets and live in a `FreeBSD-base` repo
this image does not even have configured; only `FreeBSD-ports` is.

That is not a gap to fill. **A runtime image is not a build environment**, and
installing ~1 GB of LLVM plus base dev sets into the thing users download to make
it self-hosting would be the wrong trade in both directions.

`builder` — the stock FreeBSD 15.1 cloud image `make.sh` already builds on — has
`cc`, `clang`, `/usr/lib/crt1.o` and `/usr/lib/libc.so`. So the addon is built
there and the binary is shipped, which is exactly what `ic32` already does and
what `build-image.sh`'s `STACK_DIST` mechanism is shaped for.

### 28.7 The real blocker: greenfield vendors libwayland-server, and it is Linux-only

On the builder — full base system, `cc`, `crt1.o`, libc all present — the
compile gets 30 objects in and stops:

```
native/wayland/src/wayland-server/wayland-os.c:34:10:
  fatal error: 'sys/epoll.h' file not found
```

Greenfield does not link the system libwayland; it **vendors** it, and that copy
uses Linux syscall APIs. The whole Linux-only surface, counted rather than
guessed:

| header | uses |
|---|---|
| `sys/epoll.h` | `epoll_create`/`_create1`/`_ctl`/`_wait` — 16 calls |
| `sys/eventfd.h` | `eventfd` — 6 |
| `sys/timerfd.h` | `timerfd_create` — 2 |
| `sys/signalfd.h` | `signalfd` — 6 |

No `linux/*` headers anywhere, and nothing else exotic. **That is a contained
surface, and it is the exact set `libepoll-shim` exists to cover** — it
implements all four over kqueue, and it is how wlroots and sway build on
FreeBSD. FreeBSD also has its own `wayland-1.25.0`, so linking the system
library instead of the vendored copy is a second route if the shim is not enough.

This is the answer to "will it build on FreeBSD": **not as-is, and the reason is
one library's event loop rather than anything about the encoder, gstreamer or
the GPU.** Attempt with the shim is running.

### 28.8 IT BUILDS ON FreeBSD — risk 1 retired

On `builder` (FreeBSD 15.1, full base system), all three addons and all three
shared libraries compile:

```
proxy-encoding-addon.node   proxy-poll-addon.node   wayland-server-addon.node
libproxy-encoding.so        libwayland-server.so.0  libwestfield.so
```

`file` says ELF 64-bit FreeBSD; `strings libproxy-encoding.so` shows the x264
pipeline compiled in; `ldd` reports **no unresolved libraries**.

Three things make it build, and each was a separate stop:

1. **`libepoll-shim`** — for the vendored libwayland-server's epoll/eventfd/
   timerfd/signalfd (§28.7).
2. **`-DHAVE_SYS_UCRED_H=1 -DHAVE_XUCRED_CR_PID=1`** — and this one is a
   pleasant surprise: `wayland-os.c` *already has* a `#if defined(__FreeBSD__)`
   branch using `struct xucred`. Upstream ported it and then guarded the include
   behind a feature macro their CMake never defines, because their build only
   ever ran on Linux. FreeBSD 15's `<sys/ucred.h>` has both `xucred` and
   `cr_pid`; both were checked before being asserted.
3. **`-I/usr/local/include`** — base `cc` does not search the ports include
   path, so `EGL/egl.h` is missing even with mesa installed. The oldest FreeBSD
   build wart there is, and nothing to do with Greenfield.

Captured as **`tools/build-addons-freebsd.sh`**, the sibling of the Linux
script, pinned to the same commit — keep the two on the same ref or the
platforms diverge silently.

**What this does and does not settle.** It settles that the code compiles and
links on FreeBSD, which was the unknown. It does **not** settle risk 2 (gstgl
needs a GL context and the guest has no `/dev/dri`, so software mesa is the only
route) or risk 3 (the guest already spends ~75% of four vCPUs on the shell;
software GL plus software x264 per window may leave nothing). Those are the next
two measurements, in that order.

## 29. The proxy runs in the OS, and then dies for want of a GPU

**2026-08-13.** §28 got the addons built. This is the rest of the way, and the
result is a hard, specific blocker with a clean shape.

### 29.1 It runs

The FreeBSD-native addons plus the proxy's JS (`ws`, `@gfld/xtsb`, the package
itself — all platform-independent) installed to
`/usr/local/share/rrabbit/gfproxy`, started by `rrabbit-session` beside the
bridge:

```
Compositor proxy started. Listening on 127.0.0.1:8912
```

The shell's default `PROXY_BASE` is already `http://127.0.0.1:8912`, so inside
the guest that is the guest — no `?proxy=`, no host, nothing borrowed.
`programsFrom: applications.json`, listing `foot`, which is installed here.

### 29.2 And then the session process segfaults

```
Can't open device path: /dev/dri/renderD128: No such file or directory
Can't initialize EGL, wl_dmabuf and wl_drm disabled.
Proxy session exited: SIGSEGV
```

`LIBGL_ALWAYS_SOFTWARE=1` and `GALLIUM_DRIVER=llvmpipe` do not help, and the
reason is in the first line: the code opens the **DRM render node directly** to
build its EGL display, rather than going through libGL where a software driver
could answer.

Note the second line: it *intends* to degrade — it disables `wl_dmabuf` and
`wl_drm` and carries on. The crash is downstream of that, which means there is
already a no-EGL path and something in it assumes the display exists. **That is
a findable fix in C, and there is now a FreeBSD build environment to test one
in.**

### 29.3 A render node cannot be conjured in this VM

`drm-66-kmod` — FreeBSD's port of the Linux DRM subsystem — installs exactly:

```
amdgpu.ko  i915kms.ko  radeonkms.ko  drm.ko  ttm.ko  dmabuf.ko
```

**No virtio-gpu. No vgem. No vkms.** There is no software or paravirtual DRM
device for FreeBSD, so a QEMU guest cannot be given `/dev/dri` short of VFIO
passthrough — which needs root and IOMMU, the premise PARKVPS exists without.

### 29.4 The distinction that matters for the product

This blocker is **VM-specific, not product-fatal**, and the difference is worth
stating plainly because it cuts the opposite way to how it first reads:

**Read §29.7 before trusting this table.** It was right about EGL and wrong
about the session: the fourth crash had nothing to do with `/dev/dri` and would
have hit on bare metal too.

| where T&R runs | `/dev/dri` | native windows |
|---|---|---|
| real hardware — AMD, Intel, older Radeon | **yes**, via the drivers above | should work |
| QEMU/KVM guest | **no**, and cannot be given one | blocked on §29.2 |

The download page's own framing is "a USB or VM or your main HDD/SSD". On the
metal, the drivers exist. In a VM — which is how nearly everyone will try it
first — the no-EGL path has to be fixed, or native windows are a bare-metal-only
feature and the page has to say so.

### 29.5 Where this leaves the three risks

| | |
|---|---|
| 1. does it build on FreeBSD | **retired** (§28.8) |
| 2. GL context without `/dev/dri` | **landed, and it is a crash rather than slowness** |
| 3. is it fast enough | **still unmeasured** — nothing has encoded a frame here yet |

Risk 3 cannot be measured until risk 2 is cleared, and clearing risk 2 means
either patching greenfield's EGL setup or testing on hardware that has a render
node.

### 29.6 Two real fixes, and the crash moved

`patches/greenfield-surfaceless-egl.diff` — two hunks, both confirmed live in the
FreeBSD build and both visible in the proxy log:

```
No DRM device -- falling back to surfaceless EGL
Using EGL_PLATFORM_SURFACELESS_MESA (software rendering)
EGL has no DRM device -- wl_dmabuf and wl_drm disabled, clients will use shm.
```

1. **`westfield_egl_new` no longer returns NULL without a device.**
   `EGL_MESA_platform_surfaceless` is in the client extensions here, needs no
   device, and resolves to llvmpipe. EGL now initialises in a guest with no
   `/dev/dri`.
2. **The dmabuf/drm globals are only created when there is a real DRM fd.**
   Both exist to hand clients an fd to import through; with surfaceless there is
   none, so each logged `Failed to get DRM FD from renderer` and the session
   died. Clients fall back to shm, which is what a software renderer wants.

A third thing was needed and is **not a patch**: `RENDERER_ALLOW_SOFTWARE=1`.
Greenfield already refuses `EGL_MESA_device_software` unless that is set, and
says so in its own error. It is in `rrabbit-proxy` now.

**And it still SIGSEGVs**, past all three. `views: []`, `surfaces: 0`, and the
shell reports the honest refusal.

Three crashes in a chain, each fix revealing the next. **The next one needs a
backtrace, not a fourth guess** — the session is a spawned child, so that means
a core dump or attaching to it, and that is the next piece of work rather than
more reading.

Nothing about this is on the shipping path yet. `rrabbit-session` still defaults
the proxy off for a downloaded image, and the native rows still refuse and name
the address, which remains the honest state.

### 29.7 The backtrace, and the fourth crash: a kqueue cannot be made non-blocking

The backtrace was the right next step and it ended the guessing in one reading.

Two things made it cheap. The session is a spawned child, but it does all its
work on one IPC message, so **the whole of it can be run in the main process**:
a dozen lines calling `initSurfaceBufferEncoding()` + `createSession()` with the
config `proxy-cli` builds from `rrabbit-proxy`'s argv reproduces the SIGSEGV
with no browser and no fork, under `gdb --args node`. And `curl` **does** spawn a
session — the earlier note that only the browser could was wrong; `authRequest`
wants an `x-compositor-session-id` **header**, nothing more.

```
Thread 1 "MainThread" received signal SIGSEGV
0x00000008036a022f in uv_poll_start () from /usr/local/lib/libuv.so.1
#1  start_poll () at .../dist/addons/proxy-poll-addon.node
```

`rdi` is 0 at the fault, which reads like a null handle and is not one:

```
uv_poll_start+23:  mov    %rdi,%r14        # r14 = the handle: 0x84319a540, valid
uv_poll_start+43:  mov    0x8(%r14),%rdi   # rdi = handle->loop  -> 0
uv_poll_start+47:  mov    0x68(%rdi),%rbx  # SIGSEGV
```

`handle->loop` is NULL, and `rax` still holds `0xffffffe7` — **-25, `UV_ENOTTY`**
— because nothing in `uv_poll_start` writes rax before the fault. That is
`uv_poll_init`'s return value. It returns *before* `uv__handle_init` when it
fails, so the handle is untouched, and `start_poll` **never checks it**.

`ktrace` names the syscall exactly:

```
fstat(13)                                   ok            <- the kqueue
kevent(9, {ident=13, EVFILT_READ, EV_ADD})  0             <- uv__io_check_fd PASSES
ioctl(13, FIONBIO)                          ENOTTY
fcntl(13, F_SETFL, O_RDWR|O_NONBLOCK)       ENOTTY        <- libuv's own fallback
SIGSEGV
```

`wl_event_loop_get_fd()` returns libwayland's epoll fd; libwayland's epoll here
is **libepoll-shim**, and libepoll-shim's epoll is a **kqueue** (`kqueuex(1)`).
`uv_poll_init` insists on making the polled fd non-blocking, tries `ioctl` and
then `fcntl`, and a kqueue rejects both with `ENOTTY`. There is no third thing
to try.

**This one is not VM-specific.** Nothing in it touches `/dev/dri` — it is the
wayland event loop fd, which is a kqueue on FreeBSD whether there is a GPU or
not. §29.4's table needs reading again with that in mind: the "on the metal it
should work" row was true about *EGL* and false about the session as a whole.

`patches/greenfield-poll-uv-init-check.diff` does three things. It checks the
return value. On failure it falls back to a thread parked in `poll(2)` on the fd
that wakes the loop through a `uv_async_t` — legitimate precisely because
`uv__io_check_fd` **succeeded**: the kernel is willing to report readiness on
that fd, only the gratuitous FIONBIO is in the way. And it reports the first
napi failure with any pending JS exception, which is what found §29.8 twenty
minutes later.

### 29.8 The fifth crash was not a crash — it was silence

With the poll fixed the session came up and stayed up, `foot` connected, `New
Wayland client.` was logged — and then nothing. The watcher span at **441,265
`poll()` calls in ten seconds**, every one of them readable, with only 5
`kevent(13)` in the whole trace: `wl_event_loop_dispatch` was never running, so
nothing ever drained the queue.

The new error reporting said why on the first run:

```
poll addon: napi_call_function(...) returned napi status 10
poll addon: uncaught exception in the display fd callback:
Error: ENOENT: no such file or directory, open '/proc/8358/status'
    at NativeWaylandCompositorSession.findMatchingNativeAppContext
```

Greenfield matches a connecting client to the app that launched it by walking up
its parent pids out of Linux's `/proc/<pid>/status`. **FreeBSD has no procfs
mounted by default.** The throw happens inside a *native* callback, so it had
nowhere to go: it stayed pending on the napi env, and status 10 is
`napi_pending_exception` — every later callback failed the same way, and the
upstream `NAPI_CALL` macro declines to rethrow when an exception is already
pending. One unreadable file, and the compositor went permanently deaf on the
first client to connect, without printing a character.

`patches/greenfield-freebsd-proc-pid.diff` falls back to `ps -o ppid=,comm=`.
It is JS rather than C, so `build-addons*.sh` cannot deliver it;
`tools/patch-compositor-proxy.mjs` applies it to an installed proxy's `dist/`.

### 29.9 Where this leaves the three risks

The proxy's own HTTP API, on the image, with a real spawned session child:

```
GET /foot  ->  201
{"baseURL":"ws://127.0.0.1:8922","signalURL":"...","key":"fe0f...","pid":"9526","name":"foot"}
SESSION ALIVE          <- the thing that used to SIGSEGV instantly
9526 foot              <- launched, running
New Wayland client.    <- and no exception this time
```

| | |
|---|---|
| 1. does it build on FreeBSD | **retired** (§28.8) |
| 2. GL context without `/dev/dri` | **retired** — EGL initialises, the session lives, a client connects |
| 3. is it fast enough | **still unmeasured** — no frame has been encoded here yet |

Idle cost of the fallback watcher, measured rather than assumed: **0.12 s of CPU
over 15 s**, about 0.8%. The 441k-spin was the poisoned-callback state, not the
thread design; once the callback drains the queue the thread blocks like any
other poll.

### 29.10 The sixth fault, and it works

**Correction to a claim made an hour earlier in this section.** "The proxy logs
no request at all, so the launch never leaves the page" was **wrong**. It rested
on a page reload that was never confirmed to have happened — `MS/FRAME` is a
frame *time*, not a counter, so it does not tell you a page reloaded. Restarting
the session properly (kill the kiosk, log in at the greeter with
`vps.py type tr4 driver @tab driver @ret`) and reading the proxy's own log shows
the opposite: the request arrives, `foot` launches and connects, the browser
opens its channels — **and then the session dies in the encoder.**

```
{name:"foot",msg:"warn: no decoration manager available - using CSDs"}   <- foot IS running
{name:"app",msg:"channel (re)connection from .../channel?id=2&..."}      <- the browser IS attached
libEGL warning: Not allowed to force software rendering when API explicitly selects a hardware device.
[EGL] command: eglCreateContext, error: EGL_BAD_CONTEXT   (x10)
** ERROR **: Failed to create GstGLContext: EGL_BAD_CONTEXT
{name:"main",msg:"Proxy session exited: SIGTRAP"}
```

This is why the earlier `curl` test passed and the browser did not: the encoder
is only built when a **browser attaches and a surface needs encoding**. A launch
alone never reaches it.

`egl_init` always records the display's `EGL_DEVICE_EXT`, and on the surfaceless
path that is the **software** device — but the display was built by the
*surfaceless* platform, not the *device* platform. Its only reader is
`gst_frame_encoder_ensure_gst_gl_setup`, and a non-NULL device sends it down
`gst_gl_display_egl_device_new_with_egl_device()`, which builds a **second,
separate EGLDisplay** and then asks it to create a context sharing ours. Two
displays cannot share a context: `eglQueryContext` answers `EGL_NOT_INITIALIZED`,
`eglCreateContext` answers `EGL_BAD_CONTEXT`, and `gst_gl_display_create_context`
calls `g_error` — which is fatal.

One line, in `patches/greenfield-surfaceless-egl.diff`: report
`EGL_NO_DEVICE_EXT` after a successful surfaceless init, and the encoder takes
the other branch and wraps the display we already have.

**`RRABBIT/docs/m14-foot-in-the-os.png`.** A live FreeBSD terminal on the road,
sign reading `(foot)`, glass reading
`driver@tr4:/usr/local/share/rrabbit/gfproxy $`, in a guest with **no
`/dev/dri`** — surfaceless llvmpipe EGL, software x264, and the picture arrives
in the browser. The map names it: `(foot) · home:1 · left · 270×234`.

Six faults, all of them FreeBSD-specific, none of them requiring a GPU to fix.

| | |
|---|---|
| 1. does it build on FreeBSD | **retired** (§28.8) |
| 2. GL context without `/dev/dri` | **retired** — and a window with a picture in it |
| 3. is it fast enough | **partly** — an idle session costs 0.8% CPU; a moving picture is unmeasured |

**Build note:** copy addons from the cmake **install** tree
(`ninja install` → `dist/addons/`), never from `build/`. The build-tree binaries
carry the build RPATH; only the installed ones get `$ORIGIN/shared`, and
`wayland-server-addon.node` taken from `build/` dies with
`Shared object "libwestfield.so" not found`.

**Found on the way, not fixed:** the ST&RT menu lists programs this proxy does
not have (`Firefox`, `XTerm`, `glxgears` — a development host's list). Launching
one gets a **404**, the shell reports it as `no compositor-proxy at …`, and
because one failure sets `proxyUp = false` it then **refuses every other row,
including `foot · tr4`, which works**. A 404 for "this proxy has no such
program" is not the same fact as "there is no proxy", and conflating them hides
a working program behind a broken one.

### 29.11 The image gets its own programs, and the proxy gets committed

The "development host's list" above was not a display bug — `vite.config.ts`
bakes `proxy/applications.json` into the bundle, and that file is whatever the
person at this keyboard is launching. A built shell therefore advertised
`gnome-text-editor`, `glxgears`, and a `foot · tr4` entry **containing the
absolute path of an ssh key in the builder's home directory**. None of those can
exist on the target, and one of them names a stranger's key.

- **`proxy/applications.image.json`** is now what a build ships: Terminal
  (`foot`), Notes (`mousepad`, 2.2 MiB, GTK3 which firefox already pulls in),
  Firefox, XTerm — programs that exist on the image. `RRABBIT_APPLICATIONS`
  overrides it for a build meant to run here.
- The build **fails loudly** if the shipped list contains a `/home/` or
  `/Users/` path. Verified by trying: it names the offending key path.
- **`rrabbit-proxy` and the proxy's start in `rrabbit-session` are now in the T&R
  overlay**, so a rebuilt image carries them. Previously both lived only as hand
  edits on one running guest, which is why §29.9's fixes would not have survived
  an image rebuild.
- `rrabbit-proxy` reads `--applications` from **the file the shell bundle
  ships** (`dist/proxy/applications.json`). One file on the image, so the menu
  and the proxy cannot disagree about what exists.
- **`XDG_RUNTIME_DIR` or the wayland socket is named `0`.** FreeBSD has no
  logind; SDDM sets it for a real session, so `rrabbit-session` is fine, but a
  proxy started by hand is not — and the failure is silent and misdirecting:
  `WAYLAND_DISPLAY="0"`, every native app falls back to X, and what you see is
  `Gtk-WARNING: cannot open display: :2`. I lost a round to exactly this and
  briefly believed the Notes entry was broken. `rrabbit-proxy` now makes a 0700
  directory and says so. With it, `mousepad` survives where it died.

`travel-and-rrabbit/sync-overlay.sh` pushes overlay changes into a **running**
guest instead of rebuilding. It **reports by default**: the guest had accumulated
hand edits (the proxy start) that the overlay lacked, so a blind push would have
switched native windows back off.
