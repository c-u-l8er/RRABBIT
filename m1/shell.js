// M1 -- many windows, one road.
//
// M0 proved the road can occlude a live Wayland surface, using Greenfield's own
// scene canvas as a CanvasTexture. That shortcut puts EVERY window on ONE
// billboard and costs a full canvas upload per frame. M1 needs one sign per
// window, so it takes the path spec §2.2 describes: share the GL context, let
// Greenfield decode, and composite here.
//
// THE THREE THINGS THAT MAKE THIS WORK, none of them obvious:
//
// 1. `canvas.getContext('webgl')` on a canvas that ALREADY has a context
//    returns that same context. So handing Greenfield three.js's canvas shares
//    the context with no patch to Greenfield at all -- provided three is on a
//    WebGL1 context, which is why we create it ourselves and pass it in.
//    ('webgl' does not return an existing 'webgl2' context; they are distinct
//    types and the request would return null.)
//
// 2. Greenfield's per-surface textures are created by
//    View.ensureRenderStatesForMatchingScenes(), which runs from
//    applyTransformations() -- NOT from Scene.render(). So Scene.render can be
//    suppressed and the textures still fill. Greenfield decodes; we composite.
//
// 3. A view only gets a renderState if its region INTERSECTS the scene region.
//    A window outside the output has no texture at all -- not a black one, none.
//    The Wayland output is the window ledger; the road is a view of it.

import * as THREE from 'three'
import { createAppLauncher, createCompositorSession, initWasm } from '@gfld/compositor'

const ACC = 0xf2c14e
const COOL = 0x2de2e6
const BG = 0x03040a

// Spacing between mileposts. RAVIO measured its way to S=300 for a change feed
// of 15-25 rows/hour against a road passing 1800 signs/hour. Windows invert
// that problem -- there are 5-30 of them, not thousands -- so this is NOT
// RAVIO's S and must not be assumed to transfer (spec §7).
const MILE = 260
const SCENE_ID = 'road'

export const state = {
  compositor: 'idle',
  surfaces: 0,
  signs: 0,
  adopted: 0,
  frames: 0,
  decodes: 0,
  suppressed: 0,
  error: null,
  frameError: null,
}

let renderer, gl, scene, camera, session
let nextMilepost = 1
// surface key -> { milepost, mesh, tex, rt, size }
const signs = new Map()

const keyOf = (view) => `${view.surface.resource.client.id}:${view.surface.resource.id}`

// ---------------------------------------------------------------- the world

function buildWorld(canvas) {
  // Create the context OURSELVES, as WebGL1, so that Greenfield's later
  // getContext('webgl') returns this very object. If three were left to make a
  // WebGL2 context, Greenfield's request would return null and initScene would
  // throw "This browser doesn't support WebGL!" -- which reads as a browser
  // problem and is in fact a context-type mismatch.
  gl = canvas.getContext('webgl', {
    alpha: false,
    depth: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer = new THREE.WebGLRenderer({ canvas, context: gl })
  renderer.setPixelRatio(1)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.Fog(BG, 1400, 4200)

  camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 6000)
  camera.position.set(0, 105, 260)

  scene.add(new THREE.AmbientLight(0xffffff, 1.2))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(-200, 400, 300)
  scene.add(key)

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 6000),
    new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9 }),
  )
  road.rotation.x = -Math.PI / 2
  road.position.set(0, -30, -2600)
  scene.add(road)

  resize()
  window.addEventListener('resize', resize)
}

function resize() {
  const w = window.innerWidth || 1280
  const h = window.innerHeight || 720
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// ------------------------------------------------------------------- signs

function makeSign(view, milepost) {
  const rs = view.renderStates[SCENE_ID]
  if (!rs || !rs.texture || !rs.texture.texture) return null
  const { width, height } = rs.size
  if (!width || !height) return null

  // Adopt Greenfield's WebGLTexture. three r160 has no ExternalTexture class;
  // setRenderTargetTextures is the supported way in at this revision.
  //
  // It dereferences `renderTarget.depthTexture` UNCONDITIONALLY --
  // `properties.get(renderTarget.depthTexture)` -- and a plain render target
  // has none, so the call dies with "Invalid value used as weak map key" three
  // lines before the branch that handles `depthTexture === undefined`. Giving
  // the target a depth texture it will never use is the cost of staying on the
  // public API rather than writing __webglTexture ourselves.
  const rt = new THREE.WebGLRenderTarget(width, height)
  rt.depthTexture = new THREE.DepthTexture(width, height)
  renderer.setRenderTargetTextures(rt, rs.texture.texture)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  // A Wayland surface is top-left origin; a GL texture is bottom-left. flipY is
  // an UPLOAD-time flag and we are not uploading, so it does nothing here --
  // the flip has to happen at SAMPLE time, via the uv transform.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(1, -1)
  tex.offset.set(0, 1)

  // One sign is sized to ITS OWN surface. M0's board was a fixed rectangle and
  // a 250x250 client filled a corner of it -- correct behaviour, wrong framing.
  const sw = 300
  const sh = (sw * height) / width
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )

  // Alternate sides of the road, like RAVIO's billboards.
  const side = milepost % 2 === 0 ? 1 : -1
  mesh.position.set(side * 260, 40 + sh / 2, -milepost * MILE)
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

  state.adopted++
  return { mesh, frame, post, tex, rt, size: { width, height } }
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
        dropSign(k)
        signs.set(k, { milepost: existing.milepost })
      }
      continue
    }
    const milepost = existing?.milepost ?? nextMilepost++
    const built = makeSign(view, milepost)
    signs.set(k, built ? { milepost, ...built } : { milepost })
  }
  state.signs = [...signs.values()].filter((s) => s.mesh).length

  // Surfaces that went away.
  const live = new Set(views.map(keyOf))
  for (const k of [...signs.keys()]) if (!live.has(k)) dropSign(k, true)
}

function dropSign(k, forget = false) {
  const s = signs.get(k)
  if (!s) return
  for (const o of [s.mesh, s.frame, s.post]) if (o) scene.remove(o)
  if (s.rt) s.rt.dispose()
  if (forget) signs.delete(k)
}

// --------------------------------------------------------------- the frame

function frame() {
  try {
    adoptPending()
    // Greenfield decoded into OUR context and left its own bindings behind.
    // three caches GL state and would otherwise trust a cache that is no longer
    // true. This call exists for exactly this kind of interop.
    renderer.resetState()
    renderer.render(scene, camera)
    state.frames++
  } catch (e) {
    if (!state.frameError) state.frameError = String(e && e.stack ? e.stack : e)
  }
  requestAnimationFrame(frame)
}

// ------------------------------------------------------------- the readback

function pixelAt(cx, cy) {
  const px = new Uint8Array(4)
  gl.readPixels(
    Math.round(cx),
    Math.round(renderer.domElement.height - cy),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    px,
  )
  return [px[0], px[1], px[2]]
}

const isBlack = ([r, g, b]) => r < 12 && g < 12 && b < 12

// Sweep each sign's own face, so "is this window on the road?" is answered per
// window and never by one guessed point (spec §10.1).
function sweepSign(s, n = 8) {
  if (!s.mesh) return null
  const g = s.mesh.geometry.parameters
  let content = 0
  let total = 0
  const lit = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const local = new THREE.Vector3(
        -g.width / 2 + (g.width * (i + 0.5)) / n,
        -g.height / 2 + (g.height * (j + 0.5)) / n,
        0,
      )
      const world = s.mesh.localToWorld(local)
      const v = world.project(camera)
      const sx = ((v.x + 1) / 2) * renderer.domElement.width
      const sy = ((1 - v.y) / 2) * renderer.domElement.height
      if (sx < 0 || sy < 0 || sx >= renderer.domElement.width || sy >= renderer.domElement.height) continue
      const rgb = pixelAt(sx, sy)
      total++
      if (!isBlack(rgb)) {
        content++
        lit.push(...rgb)
      }
    }
  }
  let digest = 0
  for (const v of lit) digest = (digest * 31 + v) >>> 0
  return { total, content, digest }
}

// ORIENTATION. A Wayland surface is top-left origin; a GL texture is
// bottom-left. Greenfield does no UNPACK_FLIP_Y on upload, so the correction
// has to happen at sample time -- and getting it backwards is invisible against
// a radially symmetric test pattern and glaring against a real application.
//
// So do not eyeball it. Attach the foreign texture to a framebuffer and read
// its OWN texels: row 0 is the first row Greenfield uploaded, i.e. the TOP of
// the surface. Then read the screen above and below the sign's centre. Whichever
// screen sample matches texel row 0 tells us which way up the sign is.
function orientationOf(s) {
  if (!s.mesh) return null
  const { width, height } = s.size
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    // the raw WebGLTexture, not three's wrapper
    renderer.properties.get(s.tex).__webglTexture,
    0,
  )
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  const readTexel = (x, y) => {
    const p = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p)
    return [p[0], p[1], p[2]]
  }
  // Row 0 and row h-1 are both white margin in this client, so THEY CANNOT
  // DISCRIMINATE. Sample at 20% and 80% of the height instead, and refuse to
  // answer if even those agree -- an inconclusive test that returns a boolean
  // is worse than one that returns nothing.
  const yNear = Math.floor(height * 0.2)
  const yFar = Math.floor(height * 0.8)
  const texNear = complete ? readTexel(Math.floor(width / 2), yNear) : null
  const texFar = complete ? readTexel(Math.floor(width / 2), yFar) : null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fb)
  // three cached bindings we just trampled.
  renderer.resetState()
  renderer.render(scene, camera)

  const g = s.mesh.geometry.parameters
  const screenAt = (fy) => {
    const world = s.mesh.localToWorld(new THREE.Vector3(0, g.height * fy, 0))
    const v = world.project(camera)
    return pixelAt(((v.x + 1) / 2) * renderer.domElement.width, ((1 - v.y) / 2) * renderer.domElement.height)
  }
  // Texel row `yNear` is 20% down from the FIRST uploaded row. If the sign is
  // upright that lands 20% down from the sign's top, i.e. local fy = +0.3.
  const screenUprightSlot = screenAt(0.3)
  const screenFlippedSlot = screenAt(-0.3)

  const dist = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : Infinity)
  const separation = dist(texNear, texFar)
  if (!complete || separation < 24) {
    return { complete, texNear, texFar, separation, inconclusive: true }
  }
  const errUpright = dist(screenUprightSlot, texNear) + dist(screenFlippedSlot, texFar)
  const errFlipped = dist(screenFlippedSlot, texNear) + dist(screenUprightSlot, texFar)
  return {
    complete,
    texNear,
    texFar,
    separation,
    errUpright,
    errFlipped,
    // "upright" == the surface's top is drawn at the TOP of the sign.
    upright: errUpright < errFlipped,
    inconclusive: errUpright === errFlipped,
  }
}

// CALIBRATION. The test client's pattern is mirror-symmetric about its own
// midline, so no sample of it can ever decide the flip -- `__orient` correctly
// refuses. So test the half of the path that is OURS, with a source that is
// asymmetric by construction: a texture whose FIRST uploaded rows are red and
// whose last are blue, adopted through the exact same code as a real surface.
//
// If red lands at the top of the quad, then texel row 0 renders at the top, and
// since Greenfield uploads a surface top-row-first (there is no UNPACK_FLIP_Y
// anywhere in its render path), a window is upright.
window.__calibrate = () => {
  const W = 4
  const H = 4
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const first = y < H / 2 // first rows of the DATA, i.e. low texel rows
      data[i] = first ? 255 : 0
      data[i + 1] = 0
      data[i + 2] = first ? 0 : 255
      data[i + 3] = 255
    }
  }
  const glTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, glTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const rt = new THREE.WebGLRenderTarget(W, H)
  rt.depthTexture = new THREE.DepthTexture(W, H)
  renderer.setRenderTargetTextures(rt, glTex)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.magFilter = tex.minFilter = THREE.NearestFilter
  // THE LINE UNDER TEST -- identical to makeSign().
  tex.repeat.set(1, -1)
  tex.offset.set(0, 1)

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )
  quad.position.set(0, 105, camera.position.z - 300)
  scene.add(quad)
  renderer.resetState()
  renderer.render(scene, camera)

  const at = (fy) => {
    const v = quad.localToWorld(new THREE.Vector3(0, 160 * fy, 0)).project(camera)
    return pixelAt(((v.x + 1) / 2) * renderer.domElement.width, ((1 - v.y) / 2) * renderer.domElement.height)
  }
  const top = at(0.35)
  const bottom = at(-0.35)
  scene.remove(quad)
  rt.dispose()
  gl.deleteTexture(glTex)

  const isRed = (c) => c[0] > 120 && c[2] < 120
  const isBlue = (c) => c[2] > 120 && c[0] < 120
  return {
    top,
    bottom,
    // Red is the FIRST uploaded row. Upright means it renders at the top.
    upright: isRed(top) && isBlue(bottom),
    flipped: isBlue(top) && isRed(bottom),
  }
}

window.__orient = () => {
  const out = []
  for (const s of signs.values()) if (s.mesh) out.push({ milepost: s.milepost, ...orientationOf(s) })
  return out
}

window.__m1 = () => {
  const out = { ...state, mileposts: [], sweeps: [] }
  for (const [k, s] of signs) {
    out.mileposts.push({ key: k, milepost: s.milepost, built: !!s.mesh, size: s.size ?? null })
    if (s.mesh) out.sweeps.push({ milepost: s.milepost, ...sweepSign(s) })
  }
  return out
}

// Drive: move the camera down the road so occlusion by nearer posts is real.
window.__drive = (z) => {
  camera.position.z = z
  camera.lookAt(0, 105, z - 900)
  return camera.position.z
}

// ---------------------------------------------------------- the compositor

async function main() {
  const status = document.getElementById('status')
  const say = (t) => {
    if (status) status.textContent = t
  }

  try {
    buildWorld(document.getElementById('gl'))
    frame()

    await initWasm()
    session = await createCompositorSession('rrabbit-m1')
    window.__session = session

    session.userShell.events.notify = (v, m) => {
      state.error = `${v}: ${m}`
      say(`notify ${v}: ${m}`)
    }
    session.userShell.events.surfaceCreated = () => {
      state.surfaces++
      say(`${state.surfaces} surface(s)`)
    }
    session.userShell.events.surfaceDestroyed = () => {
      state.surfaces--
    }

    // Greenfield's output IS our canvas, so it gets our context.
    session.userShell.actions.initScene(SCENE_ID, document.getElementById('gl'))

    // Suppress Greenfield's compositing. Its Scene would paint every window
    // flat across our canvas, over the road. We want only the decode, which
    // happens elsewhere (see the header note 2).
    const gfScene = session.renderer.scenes[SCENE_ID]
    if (!gfScene) throw new Error('scene not registered under ' + SCENE_ID)
    gfScene.render = () => {
      state.suppressed++
      session.userShell.events.sceneRefreshed?.(SCENE_ID)
    }

    session.globals.register()
    state.compositor = 'up'

    // Many windows. Three separate clients, so three separate wl_clients.
    const launcher = createAppLauncher(session, 'web')
    for (let i = 0; i < 3; i++) {
      const app = launcher.launch(new URL(`${location.origin}/clients/simple-shm/app.html`), () => {})
      app.onError = (e) => {
        state.error = String(e)
      }
    }
    say('compositor up -- launching 3 clients')
  } catch (e) {
    state.error = String(e && e.stack ? e.stack : e)
    say(`FAILED: ${e}`)
    console.error(e)
  }
}

window.addEventListener('load', main)
