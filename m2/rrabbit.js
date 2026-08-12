// RRABBIT -- the one who is the windows.
//
// Not the one who draws them: the one who IS them. RRABBIT is the sign standing
// on the road, the surface that flattens to 1:1 under you, the rect in the
// ledger that decides a click belongs to it. Its question is always *what am I,
// and where do I stand* -- never how anybody gets here.
//
// Everything below was moved out of m2/shell.js unchanged; attachRrabbit()
// hands over the bindings the moved code used to close over.
//
// It calls into Travel exactly once, and the call is the interesting one:
// when a window dies WHILE YOU ARE STANDING IN IT, RRABBIT tells Travel to let
// go. That is the whole conversation between the two personalities, and it runs
// in this direction only.

import * as THREE from 'three'
import { state, signs, sideQueue, ledgerSlot, keyOf, ACC, COOL, SCENE_ID, windowZ } from './world.js'
import * as ws from './workspaces.js'
import { release } from './travel.js'

let renderer, gl, scene, camera, session
export function attachRrabbit(c) {
  ;({ renderer, gl, scene, camera, session } = c)
}

// Mileposts are PER WORKSPACE -- each road numbers its own windows -- and the
// counter now lives on the workspace node (ws.takeMilepost) rather than in an
// array indexed in parallel with a list of names.
let nextSlot = 0

// How far off the centreline a sign stands.
//
// THE WINDOWS USED TO OVERHANG THE ROAD. At 260 a 300-wide sign spans x=110..410
// while the road is only 320 wide (x = -160..160), so its inner edge stood over
// the tarmac. Nothing on the road minded until the gantry arrived to span it --
// and because the gantry is NEARER than the windows, perspective spreads it
// wider on screen than they are, so it covered their inner quarter and there was
// no width, height or distance for it that did not. Reported as the sign getting
// in the way of the windows while scrolling by.
//
// So the windows step back and the gantry narrows to the road it spans: the sign
// clears the road entirely (330 - 150 = 180 > 160) and the gantry's panels stay
// well inside it.
const SIGN_OFFSET = 330

// The `-->` is wider than it is tall, so the grab is not square. HANDLE is the
// hit-area unit; the visible text gets its own proportions.
const HANDLE = 34
const GRIP_W = 58
const GRIP_H = 29
// Turned 45 degrees, so `-->` points the way dragging it actually takes the
// corner: up and out. How far out it has to sit is then not a taste -- a
// rectangle rotated 45 degrees has an axis-aligned half-extent of
// (w + h) / 2 / sqrt(2), and anything less than that overlaps the surface again.
const GRIP_REACH = (GRIP_W / 2 + GRIP_H / 2) / Math.SQRT2 + 1
const PAD = 80

// The grab's face: the text `-->`, and nothing else.
//
// It was a boxed cyan card, then a panel with a diagonal grip, and both were the
// same mistake in different clothes -- a picture, hung next to a window, which
// is a thing that draws pictures. Asked for plainly: just show `-->`. It reads
// as "pull this way", it is the same monospace as every other word in the shell,
// and there is no panel to be mistaken for a second frame.
//
// The only decoration is a shadow, because the glyphs have to survive being over
// the road, a neighbouring sign, or nothing at all.
let grabTex = null
function grabTexture() {
  if (grabTex) return grabTex
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 64
  const g = c.getContext('2d')
  g.clearRect(0, 0, 128, 64)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  // Sized to FILL the quad. At 46px the glyphs sat in a wide transparent margin,
  // which put the visible arrow much further from the corner than the mesh
  // actually is and made it read as floating loose rather than attached.
  g.font = 'bold 58px ui-monospace, monospace'
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 10
  g.fillStyle = '#' + ACC.toString(16).padStart(6, '0')
  // Twice, so the shadow is dark enough to read against a lit sign.
  g.fillText('-->', 64, 35)
  g.fillText('-->', 64, 35)
  grabTex = new THREE.CanvasTexture(c)
  grabTex.colorSpace = THREE.SRGBColorSpace
  return grabTex
}

// ------------------------------------------------------------------- signs

// Adopt a Greenfield surface texture as a three.js map. Shared by signs and by
// popups so the two can never drift on colour space or the flip.
// three r160 has no ExternalTexture class; setRenderTargetTextures is the
// supported way in at this revision. It dereferences
// `renderTarget.depthTexture` UNCONDITIONALLY, and a plain render target has
// none, so the call dies with "Invalid value used as weak map key" three lines
// before the branch that handles `depthTexture === undefined` -- hence a depth
// texture that is never used.
//
// The flip is at SAMPLE time (repeat/offset) because `flipY` is an UPLOAD-time
// flag and adoption does no upload.
//
// THE TWO BUFFER PATHS DISAGREE ABOUT WHICH WAY IS UP, and the fix is not one
// constant. A web client's shm buffer is uploaded straight to the texture, so
// it arrives bottom-up and needs the flip. A NATIVE client's frame is h264 and
// is decoded through a shader that RENDERS INTO the texture, which flips it
// once already -- flipping again turns it upside down.
//
// Measured on a real xterm: `[travis@PX13 RRABBIT]` came out as
// `[ɿɒʌiƨ@bXI3 ЯЯAᙠᙠIT]` at the bottom of the window. The giveaway is `P` → `b`,
// which is a VERTICAL mirror; a horizontal one would have given `ꟼ`. Choosing
// the axis by reading the glyph beat guessing at it.
//
// `mimeType` is a property, so it survives minification -- unlike the class
// names that broke in the built bundle (see isSurface above).
function adoptSurfaceTexture(rs, view) {
  const { width, height } = rs.size
  const rt = new THREE.WebGLRenderTarget(width, height)
  rt.depthTexture = new THREE.DepthTexture(width, height)
  renderer.setRenderTargetTextures(rt, rs.texture.texture)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  const mime = view?.surface?.state?.bufferContents?.mimeType
  const alreadyUpright = mime === 'video/h264' || mime === 'image/png'

  // THE DECODED TEXTURE IS BIGGER THAN THE SURFACE. Measured on a real xterm:
  // surface 960x653, texture 1024x770. h264 decodes into a padded allocation
  // and the picture occupies a sub-rect of it, so mapping the texture 0..1 --
  // which is what a plain three material does -- puts the padding on the sign
  // as well, and the seam between picture and padding is the "tear" this was
  // filed as.
  //
  // Which sub-rect is not a guess: Greenfield's own YUV->RGB pass builds its
  // quad with `textureMinU = 1 - width / texture.width` running to 1, so the
  // picture sits at the BOTTOM-RIGHT of the allocation. Sampling the same
  // window here is agreeing with the decoder rather than second-guessing it.
  //
  // For an unpadded buffer (every shm client) sx = sy = 1 and this reduces
  // exactly to the previous repeat/offset, flip and all.
  const tw = rs.texture?.size?.width || width
  const th = rs.texture?.size?.height || height
  const DIAG = new URLSearchParams(location.search).get('uv')
  const sx = DIAG === 'full' ? 1 : width / tw
  const sy = DIAG === 'full' ? 1 : height / th
  const ox = DIAG === 'topleft' ? 0 : 1 - sx
  const oy = DIAG === 'topleft' ? 0 : 1 - sy
  if (alreadyUpright) {
    tex.repeat.set(sx, sy)
    tex.offset.set(ox, oy)
  } else {
    tex.repeat.set(sx, -sy)
    tex.offset.set(ox, oy + sy)
  }
  return { rt, tex }
}

function makeSign(view, milepost, district, side, lane) {
  const rs = view.renderStates[SCENE_ID]
  if (!rs || !rs.texture || !rs.texture.texture) return null
  const { width, height } = rs.size
  if (!width || !height) return null

  const { rt, tex } = adoptSurfaceTexture(rs, view)

  // One sign is sized to ITS OWN surface. M0's board was a fixed rectangle and
  // a 250x250 client filled a corner of it -- correct behaviour, wrong framing.
  const sw = 300
  const sh = (sw * height) / width
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )

  // Which side of the road, and where along it. The side used to be forced by
  // milepost parity, like RAVIO's billboards; it is now whatever the window was
  // opened with, because "open one on the left" is a thing you can ask for from
  // the enter gantry. Parity is still the default when nobody said.
  mesh.position.set(ws.laneX(district) + side * SIGN_OFFSET, 40 + sh / 2, windowZ(lane, side))
  mesh.rotation.y = -side * 0.42
  scene.add(mesh)

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(sw + 14, sh + 14),
    new THREE.MeshBasicMaterial({ color: COOL }),
  )
  frame.position.copy(mesh.position)
  frame.rotation.copy(mesh.rotation)
  frame.translateZ(-2)
  scene.add(frame)

  // A post, so the sign stands on the road rather than floating -- and so
  // there is geometry that can occlude the sign behind it.
  //
  // It must stop AT the sign's bottom edge, not run through it. An overlapping
  // post covered the lower face and made a readback sample amber, which read as
  // the window being the wrong way up. Furniture that crosses the picture is
  // also an instrument that lies about the picture.
  const postTop = mesh.position.y - sh / 2
  const postH = postTop + 30
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(14, postH, 14),
    new THREE.MeshStandardMaterial({ color: ACC, roughness: 0.6 }),
  )
  post.position.set(mesh.position.x, postTop - postH / 2, mesh.position.z)
  scene.add(post)

  // THE RESIZE GRAB, at the TOP-right corner of the surface.
  //
  // A child of the mesh, so it inherits the sign's pose for free and stays glued
  // to the corner through the flatten -- the same trick the popup quads use.
  //
  // TOP, and the reason is a few lines above: a sign STANDS ON THE ROAD.
  // `mesh.position.y = 40 + sh / 2`, so its bottom edge is pinned at y=40 and it
  // grows upward. The bottom corner therefore does not move when the window gets
  // taller -- drag it down and the grab sits perfectly still under the pointer
  // while the window changes somewhere else, which is indistinguishable from a
  // resize that does not work. It was reported as exactly that. The top corner
  // is the one that tracks the drag, because it is the edge that moves.
  //
  // It is also the half of the frame that is free: the tube rack is parented to
  // the camera along the bottom and the `why` line sits under it, so a grab down
  // there is buried in furniture even when it is on screen.
  //
  // Hidden except on the window you are standing in -- out on the road it would
  // be a fleck on a distant sign that does nothing, and every pointer path here
  // has to be able to say what it hit.
  const handle = new THREE.Mesh(
    new THREE.PlaneGeometry(GRIP_W, GRIP_H),
    new THREE.MeshBasicMaterial({ map: grabTexture(), transparent: true, toneMapped: false }),
  )
  // WHOLLY OUTSIDE THE SURFACE. Its inner corner meets the surface's outer
  // corner exactly, so it sits on the frame's corner and extends away from the
  // window: it covers no client pixel at all.
  //
  // Inside the corner is where a gripper looks right and it is the wrong place
  // here, because the thing underneath is somebody else's application. A shell
  // that draws its own controls over a client's interface has decided its
  // chrome matters more than the program, and it does not. Reported.
  handle.rotation.z = Math.PI / 4
  handle.position.set(sw / 2 + GRIP_REACH, sh / 2 + GRIP_REACH, 3)
  handle.userData.resizeHandle = true
  handle.visible = false
  mesh.add(handle)

  // THE HIT AREA IS BIGGER THAN THE GRIP and sits beyond the corner, because
  // that is where a hand aims when reaching for the edge of a window from
  // outside it -- reported as the indicator not showing when hovering there.
  //
  // An invisible MATERIAL rather than an invisible object: three skips
  // material.visible === false when drawing and still raycasts the mesh, which
  // is exactly the pair of properties this needs.
  const grabPad = new THREE.Mesh(
    new THREE.PlaneGeometry(PAD, PAD),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  // The pad is bigger than the grip and reaches FURTHER OUT, never further in:
  // its inner edge is the surface's edge. An invisible target over the client
  // area obstructs nothing you can see and still eats the click that was meant
  // for the application, which is the same fault wearing a disguise.
  grabPad.position.set(sw / 2 + PAD / 2, sh / 2 + PAD / 2, 3)
  grabPad.userData.resizeHandle = true
  mesh.add(grabPad)

  state.adopted++
  return { mesh, frame, post, handle, grabPad, tex, rt, size: { width, height } }
}

// The grab is only live on the window you are IN. Cheap enough to reconcile
// every frame, and reconciling beats remembering: the flattened window changes
// under this from four different places (flatten, release, a window dying, a
// resize rebuilding the sign) and none of them should have to know about it.
function syncHandles() {
  const flatKey = `${state.flatDistrict}:${state.flatMilepost}`
  for (const s of signs.values()) {
    if (!s.handle) continue
    s.handle.visible = state.mode === 'flat' && `${s.district}:${s.milepost}` === flatKey
  }
}

// A surface's size is not known when it is created -- the first buffer decides
// it, and renderStates are only built once the view intersects the scene. So
// signs are adopted lazily, every frame, until they take.
function adoptPending() {
  const views = session?.renderer?.topLevelViews ?? []
  for (const view of views) {
    const k = keyOf(view)
    const existing = signs.get(k)
    if (existing && existing.mesh) {
      // Invariant 6: content changes, PLACEMENT DOES NOT. The milepost is the
      // window's address and is never recomputed.
      const rs = view.renderStates[SCENE_ID]
      if (rs && (rs.size.width !== existing.size.width || rs.size.height !== existing.size.height)) {
        // A resized surface is a new texture allocation. Rebuild the sign in
        // place, at the SAME milepost.
        //
        // BUILD THE REPLACEMENT BEFORE DROPPING THE OLD ONE. This used to drop
        // first and leave a record with no mesh, so the window vanished for
        // however many frames it took the next buffer to arrive -- once, that is
        // a blink nobody sees; during a resize drag it is one per configure, and
        // it is what "really flashy and glitchy" was. If the new sign cannot be
        // built yet, the old one keeps standing, which is the correct thing to
        // show: the window has not changed yet.
        const rebuilt = makeSign(view, existing.milepost, existing.district, existing.side, existing.lane)
        if (rebuilt) {
          dropSign(k)
          signs.set(k, {
            milepost: existing.milepost,
            district: existing.district,
            slot: existing.slot,
            side: existing.side,
            lane: existing.lane,
            view,
            ...rebuilt,
          })
          rebuilt.mesh.userData.signKey = k
        }
      }
      continue
    }
    // Invariant 6, widened by M4: a window's address is now (district,
    // milepost) and neither half is ever recomputed. The ledger slot is
    // assigned once for the same reason -- a window that moved in the ledger
    // would change where its input lands.
    const district = existing?.district ?? state.district
    const milepost = existing?.milepost ?? ws.takeMilepost(district)
    const slot = existing?.slot ?? nextSlot++
    // The side is claimed at ADOPTION, the same moment and for the same reason
    // the district is: the surface does not exist when the click happens, so
    // the request has to wait here for it.
    const side = existing?.side ?? sideQueue.shift() ?? (milepost % 2 === 0 ? 1 : -1)
    // The place on that side, taken once and never recomputed -- invariant 6
    // covers this for the same reason it covers the milepost.
    const lane = existing?.lane ?? ws.takeLane(district, side)
    placeInLedger(view, slot)
    const built = makeSign(view, milepost, district, side, lane)
    // The view is kept so input can be mapped back into the flat output. It is
    // re-read every frame rather than cached at build time: a view object is
    // replaced when a surface is remapped.
    signs.set(
      k,
      built
        ? { milepost, district, slot, side, lane, view, ...built }
        : { milepost, district, slot, side, lane, view },
    )
    if (built) built.mesh.userData.signKey = k
  }
  for (const [k, s] of signs) {
    const v = views.find((x) => keyOf(x) === k)
    if (v) s.view = v
  }
  state.signs = [...signs.values()].filter((s) => s.mesh).length

  // Surfaces that went away.
  //
  // A window can close WHILE YOU ARE IN IT -- the client exits, the surface is
  // destroyed, and without this the shell sits flat against a milepost that no
  // longer has anything on it, with input routed to a surface that is gone.
  // Proven by pressing Escape in the test client, which exits on ESC.
  const live = new Set(views.map(keyOf))
  for (const k of [...signs.keys()]) {
    if (live.has(k)) continue
    const dying = signs.get(k)
    // BOTH halves of the address. Mileposts restart in every workspace, so
    // matching on the milepost alone let a window dying at build:2 release you
    // from home:2 -- a window you were still using, closed by a window you were
    // not.
    if (dying && dying.milepost === state.flatMilepost && dying.district === state.flatDistrict) release()
    dropSign(k, true)
  }
}

function dropSign(k, forget = false) {
  const s = signs.get(k)
  if (!s) return
  for (const o of [s.mesh, s.frame, s.post]) if (o) scene.remove(o)
  if (s.rt) s.rt.dispose()
  // The grab is a CHILD of the mesh, so removing the mesh takes it off screen
  // and leaves its geometry and material behind. One per resize is not much and
  // a drag makes a lot of them. (The texture is shared and outlives every sign,
  // which is why it is not disposed here.)
  for (const o of [s.handle, s.grabPad]) {
    if (!o) continue
    o.geometry.dispose()
    o.material.dispose()
  }
  if (forget) signs.delete(k)
}

// MINIFICATION EATS CLASS NAMES. `impl.constructor.name === 'Surface'` works in
// the dev server and is DEAD in the built bundle -- measured: the shipped shell
// reports constructor names of `ko`, `ro`, `mQ`. Everything keyed on those names
// silently stopped: popups did not render at all in the production build, and
// the detector that exists to catch exactly that was dead too.
//
// PROPERTY names survive (esbuild does not mangle them by default), so identify
// by SHAPE. `positionerState` is unique to XdgPopup among surface roles.
//
// The lesson generalises past this file: a type check that depends on a name
// the build tool is free to rewrite is a check that works until you ship it.
const isSurface = (impl) => !!impl && !!impl.resource && !!impl.state && 'mapped' in impl
const isPopupRole = (role) => !!role && role.positionerState !== undefined

// ----------------------------------------------------------------- popups
//
// AN xdg_popup COULD NOT MAP IN GREENFIELD 1.0.0-rc1 (and still cannot on
// master). `surface.mapped = true` happens in exactly one place --
// `FloatingDesktopSurface.commit()`, reached via `DesktopSurface.commit()` --
// and XdgToplevel, ShellSurface and XWaylandShellSurface all call it while
// XdgPopup does not. So a popup got its role, got its buffer, and sat at
// `mapped: false` forever: no menus, dropdowns or tooltips for ANY client.
//
// That is now FIXED AT THE SOURCE, not worked around:
//   patches/greenfield-xdgpopup-map.patch  -- the upstream-ready diff
//   tools/patch-compositor.mjs             -- applies it to the installed dist
//
// What remains here is a DETECTOR, not a fix. A shell that silently repaired
// this would hide a missing patch until someone wondered where the menus went.
// If this ever counts above zero, the patch did not apply.
function checkPopupsMapped() {
  const clients = session?.display?.clients
  if (!clients) return
  let stranded = 0
  for (const client of Object.values(clients)) {
    for (const o of Object.values(client.connection?.wlObjects ?? {})) {
      const impl = o?.implementation
      if (!isSurface(impl)) continue
      if (!isPopupRole(impl.role)) continue
      if (!impl.mapped && impl.state?.bufferContents) stranded++
    }
  }
  state.strandedPopups = stranded
  if (stranded && !state.strandedWarned) {
    state.strandedWarned = true
    console.warn(
      `RRABBIT: ${stranded} popup(s) have a buffer and are not mapped. ` +
        'The @gfld/compositor patch is missing -- run: node tools/patch-compositor.mjs',
    )
  }
}

// A popup is drawn ON ITS PARENT'S SIGN, at the position the COMPOSITOR
// computed from the client's XdgPositioner. The shell does not invent a
// position -- spec §7 feared there was no rectangle to anchor to on a receding
// billboard, but the ledger has one: both surfaces have a rect there, and the
// difference between them is the offset in parent-surface pixels.
//
//   local x = (dx + popupW/2 - parentW/2) * scale
//   local y = -(dy + popupH/2 - parentH/2) * scale     (y is up in the plane)
//
// A menu that overhangs its window overhangs its sign too, which is correct.
function popupsByParentKey() {
  const out = new Map()
  const clients = session?.display?.clients
  if (!clients) return out
  for (const client of Object.values(clients)) {
    for (const o of Object.values(client.connection?.wlObjects ?? {})) {
      const impl = o?.implementation
      if (!isSurface(impl)) continue
      if (!isPopupRole(impl.role)) continue
      if (!impl.mapped) continue
      const view = impl.role.view
      const rs = view?.renderStates?.[SCENE_ID]
      if (!rs?.texture?.texture || !rs.size.width) continue
      // Walk up: a submenu's parent is another popup, and it still belongs to
      // the toplevel's sign.
      let p = impl.parent
      let guard = 0
      while (p && guard++ < 8) {
        const pv = p.role?.view
        if (pv && signs.has(keyOf(pv))) {
          const k = keyOf(pv)
          if (!out.has(k)) out.set(k, [])
          out.get(k).push({ view, rs })
          break
        }
        p = p.parent
      }
    }
  }
  return out
}

function syncPopups() {
  const byParent = popupsByParentKey()
  for (const [k, sign] of signs) {
    if (!sign.mesh) continue
    sign.popups = sign.popups ?? new Map()
    const live = byParent.get(k) ?? []
    const liveKeys = new Set(live.map((p) => keyOf(p.view)))

    for (const { view, rs } of live) {
      const pk = keyOf(view)
      let q = sign.popups.get(pk)
      const size = { w: rs.size.width, h: rs.size.height }
      if (q && (q.size.w !== size.w || q.size.h !== size.h)) {
        sign.mesh.remove(q.mesh)
        q.rt.dispose()
        sign.popups.delete(pk)
        q = undefined
      }
      if (!q) {
        const { rt, tex } = adoptSurfaceTexture(rs, view)
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
        )
        // A child of the sign, so it inherits the sign's pose for free and
        // stays glued to the window through the flatten.
        mesh.userData.popupView = view
        sign.mesh.add(mesh)
        q = { mesh, rt, size }
        sign.popups.set(pk, q)
        state.popupQuads++
      }
      const g = sign.mesh.geometry.parameters
      const scale = g.width / sign.size.width
      const pr = view.regionRect
      const sr = sign.view.regionRect
      const dx = pr.x0 - sr.x0
      const dy = pr.y0 - sr.y0
      q.mesh.scale.set(size.w * scale, size.h * scale, 1)
      q.mesh.position.set(
        (dx + size.w / 2 - sign.size.width / 2) * scale,
        -(dy + size.h / 2 - sign.size.height / 2) * scale,
        1.5, // just proud of the sign face, so it never z-fights the window
      )
    }

    for (const [pk, q] of [...sign.popups]) {
      if (liveKeys.has(pk)) continue
      sign.mesh.remove(q.mesh)
      q.rt.dispose()
      sign.popups.delete(pk)
    }
  }
}

// ---------------------------------------------------------------- the ledger

// Put a window at its own rect in the flat output. `positionOffset` is the same
// lever Greenfield's own FloatingDesktopSurface uses to drag a window, so this
// is placement rather than a trick.
function placeInLedger(view, slot) {
  const p = ledgerSlot(slot)
  const cur = view.positionOffset
  if (cur && cur.x === p.x && cur.y === p.y) return
  view.positionOffset = p
  state.placed++
}

export {
  adoptSurfaceTexture,
  makeSign,
  adoptPending,
  syncHandles,
  dropSign,
  isSurface,
  isPopupRole,
  checkPopupsMapped,
  popupsByParentKey,
  syncPopups,
  placeInLedger,
}
