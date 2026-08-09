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

**M0 — the occlusion proof.** One real Wayland client (`weston-terminal` or
`foot`), one billboard, the shared-context texture path of §2.2. Proof: a
screenshot where **the road passes in front of a live, updating application
window**, plus a readback showing the texture changing between frames. Nothing
else. If this fails, stop.

**M1 — many windows, one road.** `surfaceCreated`/`surfaceDestroyed` →
billboards. Milepost addressing (invariant 6). Titles from
`surfaceTitleUpdated`, app ids from `surfaceAppIdUpdated`.

**M2 — the flatten.** Fly into a window; it goes fronto-parallel and 1:1; input
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
