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
| districts = amp workspaces | districts = **workspaces** (one Wayland output each) |
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

- **`xdg_popup` positioning.** A popup is placed relative to a rectangle on its
  parent surface. On a receding, curved billboard there is no such rectangle.
  Every right-click menu, combobox and tooltip in every application is this
  problem. **Working assumption: a popup forces the flatten.** Unproven.
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

**M1 — many windows, one road. PASSED (2026-08-08).** See §11.

OLD:**M1 — many windows, one road.** `surfaceCreated`/`surfaceDestroyed` →
billboards. Milepost addressing (invariant 6). Titles from
`surfaceTitleUpdated`, app ids from `surfaceAppIdUpdated`.

**M2 — the flatten. PASSED (2026-08-08).** See §12. Originally: Fly into a window; it goes fronto-parallel and 1:1; input
routes (§6); focus follows (invariant 7); `Ctrl+Alt+Shift+Esc` gets you out.
This is the milestone where it becomes usable rather than a demo.

**M3 — the tubes.** `bridge.py` on FreeBSD sysctl. §3.1.

**M4 — districts.** Workspaces as Wayland outputs. R shows all of them.

**M5 — the session.** An xsession entry in T&R's `overlay-desktop`, beside
icewm, never instead of it.

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
