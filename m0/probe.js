// M0 -- the occlusion proof.
//
// The gate for the whole of RRABBIT: can 3D geometry pass IN FRONT OF a live,
// updating Wayland surface?
//
// RAVIO spec §9 ruled out "play any website on the drive-in screen" because
// HTMLTexture excludes cross-origin content and CSS3DRenderer renders real DOM
// in a separate layer with NO depth compositing against WebGL -- the road could
// not occlude it. A decoded Wayland surface is not a web page. It is a texture
// we own, in our own depth buffer. This file exists to prove that difference is
// real rather than merely argued.
//
// Deliberately NOT proved here (spec §2.2): the shared-GL-context path that
// gives one texture PER SURFACE. M0 uses Greenfield's own scene canvas as a
// CanvasTexture -- a per-frame upload, and every window on one billboard. That
// is fine for one window and is the cheapest thing that can answer the gate.
// M1 needs the shared context; M0 does not.

import * as THREE from 'three'
import { createAppLauncher, createCompositorSession, initWasm } from '@gfld/compositor'

// RAVIO's palette, so the proof looks like the thing it is a proof for.
const ACC = 0xf2c14e // amber
const COOL = 0x2de2e6 // cyan
const BG = 0x03040a

// RAVIO's sign is 1024x600 (world/sign.js). A window sign is the same shape,
// which is the whole reason the fork seam is one function.
const SIGN_W = 1024
const SIGN_H = 600

export const state = {
  compositor: 'idle',
  app: 'idle',
  surfaces: 0,
  frames: 0,
  sceneRefreshes: 0,
  textureRebuilds: 0,
  error: null,
}

let renderer, scene, camera, billboardTex, gfCanvas, board
let texSize = { w: 0, h: 0 }

// ---------------------------------------------------------------- the world

function buildWorld(glCanvas) {
  renderer = new THREE.WebGLRenderer({
    canvas: glCanvas,
    antialias: true,
    // The probe reads pixels back to prove occlusion. Without this the default
    // framebuffer is undefined after compositing and readPixels returns noise
    // that looks exactly like a failed test.
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(1)
  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.Fog(BG, 900, 2200)

  camera = new THREE.PerspectiveCamera(55, 16 / 9, 1, 4000)
  camera.position.set(0, 90, 260)
  camera.lookAt(0, 90, -600)

  scene.add(new THREE.AmbientLight(0xffffff, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(-200, 400, 300)
  scene.add(key)

  // --- the billboard: a live Wayland surface, 1024x600, at z = -600
  gfCanvas = document.getElementById('gf')
  billboardTex = new THREE.CanvasTexture(gfCanvas)
  // Without this the texture is taken as linear, converted twice, and every
  // dark value lifts -- RAVIO hit this exact bug on the yoke's CanvasTexture.
  billboardTex.colorSpace = THREE.SRGBColorSpace
  billboardTex.minFilter = THREE.LinearFilter
  billboardTex.generateMipmaps = false

  const bw = 420
  const bh = (bw * SIGN_H) / SIGN_W
  board = new THREE.Mesh(
    new THREE.PlaneGeometry(bw, bh),
    new THREE.MeshBasicMaterial({ map: billboardTex }),
  )
  board.position.set(0, 90, -600)
  board.name = 'billboard'
  scene.add(board)
  // Recorded so probe points can be derived from the board rather than
  // hard-coded -- a camera change must never silently invalidate the test.
  board.userData.size = { w: bw, h: bh }

  // Frame around it, so the sign reads as a sign and not as a floating image.
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(bw + 16, bh + 16),
    new THREE.MeshBasicMaterial({ color: COOL }),
  )
  frame.position.set(0, 90, -602)
  scene.add(frame)

  // --- the road: runs from behind the camera to past the billboard
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 2600),
    new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9 }),
  )
  road.rotation.x = -Math.PI / 2
  road.position.set(0, -30, -900)
  scene.add(road)

  // --- THE OCCLUDERS. These are the whole point of M0.
  //
  // A pylon at z = -300 sits between the camera and a billboard at z = -600,
  // so the depth buffer must cut the live surface. If the window is drawn in a
  // separate layer (the CSS3DRenderer failure mode §9 recorded) this is exactly
  // what CANNOT happen, and the pylon will be behind the app.
  const pylonMat = new THREE.MeshStandardMaterial({ color: ACC, roughness: 0.5 })
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(26, 420, 26), pylonMat)
  pylon.position.set(-70, 60, -300)
  pylon.name = 'pylon'
  scene.add(pylon)

  // A gantry across the middle, so occlusion is proved on both axes rather
  // than only the one the pylon happens to test.
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(520, 18, 18), pylonMat)
  gantry.position.set(0, 120, -330)
  gantry.name = 'gantry'
  scene.add(gantry)

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

// A CanvasTexture is ALLOCATED at the size its source had on first upload and
// does NOT re-allocate when that canvas is resized -- the new, smaller content
// lands in a corner of the old allocation and the rest stays black. It reads as
// "the texture is broken"; it is the texture being the wrong shape.
//
// RAVIO already recorded the sibling of this for VideoTexture ("dimensions
// cannot change once used ... dispose and rebuild on change"). Same rule, and
// Greenfield WILL resize this canvas: it syncs the backing store to the output.
function syncTextureSize() {
  const w = gfCanvas.width
  const h = gfCanvas.height
  if (w === texSize.w && h === texSize.h) return
  texSize = { w, h }
  state.textureRebuilds++
  const old = billboardTex
  billboardTex = new THREE.CanvasTexture(gfCanvas)
  billboardTex.colorSpace = THREE.SRGBColorSpace
  billboardTex.minFilter = THREE.LinearFilter
  billboardTex.generateMipmaps = false
  board.material.map = billboardTex
  board.material.needsUpdate = true
  old.dispose()
}

function frame() {
  // A loop that dies silently reads exactly like a feature that never worked.
  // Catch, record ONCE, and keep the loop alive so the rest stays measurable.
  try {
    syncTextureSize()
    // A CanvasTexture does not know its source changed.
    billboardTex.needsUpdate = true
    renderer.render(scene, camera)
    state.frames++
  } catch (e) {
    if (!state.frameError) state.frameError = String(e && e.stack ? e.stack : e)
    state.frameErrors = (state.frameErrors || 0) + 1
  }
  requestAnimationFrame(frame)
}

// ------------------------------------------------------------- the readback
//
// A hidden or software-GL pane cannot be judged from a screenshot alone -- see
// RAVIO's note that the in-app Browser pane reports webgl:false and composites
// black. So the world must answer questions about itself.

function pixelAt(cx, cy) {
  const gl = renderer.getContext()
  const px = new Uint8Array(4)
  // readPixels is bottom-left origin; client coords are top-left.
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

// Where a point in the world lands on screen, so the probe never hard-codes a
// pixel that a camera change would silently invalidate.
function project(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera)
  return [
    ((v.x + 1) / 2) * renderer.domElement.width,
    ((1 - v.y) / 2) * renderer.domElement.height,
  ]
}

const isAmber = ([r, g, b]) => r > 120 && g > 90 && b < 110 && r > b + 60
const isBlack = ([r, g, b]) => r < 12 && g < 12 && b < 12

// Sampling ONE point asks "is the surface at the place I guessed?" and answers
// black when the guess is wrong -- which is indistinguishable from a dead
// pipeline. The first run of M0 failed exactly this way. Sweep the whole board
// face instead and report coverage, so the instrument cannot be fooled by
// where the compositor happens to place a surface.
function sweepBoard(n = 12) {
  const { w, h } = board.userData.size
  const { x, y, z } = board.position
  const lit = []
  let content = 0
  let occluded = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const wx = x - w / 2 + (w * (i + 0.5)) / n
      const wy = y - h / 2 + (h * (j + 0.5)) / n
      const [sx, sy] = project(wx, wy, z)
      const rgb = pixelAt(sx, sy)
      total++
      if (isAmber(rgb)) occluded++
      else if (!isBlack(rgb)) {
        content++
        lit.push(rgb[0], rgb[1], rgb[2])
      }
    }
  }
  // A cheap digest, so two reads seconds apart can prove the surface is LIVE
  // rather than a still frame that happens to be the right colour.
  let digest = 0
  for (const v of lit) digest = (digest * 31 + v) >>> 0
  return { total, content, occluded, digest }
}

window.__m0 = () => {
  const out = { ...state }
  out.sweep = sweepBoard()
  out.points = {
    // Dead on the pylon where it crosses the billboard -- must be amber.
    pylon: { at: project(-70, 60, -300).map(Math.round), rgb: pixelAt(...project(-70, 60, -300)) },
    // Dead on the gantry where it crosses the billboard -- must be amber.
    gantry: { at: project(0, 120, -330).map(Math.round), rgb: pixelAt(...project(0, 120, -330)) },
  }
  out.canvas = [renderer.domElement.width, renderer.domElement.height]
  out.gf = gfCanvas ? [gfCanvas.width, gfCanvas.height] : null
  return out
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
    state.compositor = 'wasm-ready'
    say('wasm ready')

    const session = await createCompositorSession('rrabbit-m0')
    session.userShell.events.notify = (variant, message) => {
      state.error = `${variant}: ${message}`
      say(`notify ${variant}: ${message}`)
    }
    session.userShell.events.surfaceCreated = () => {
      state.surfaces++
      say(`surface up (${state.surfaces})`)
    }
    session.userShell.events.surfaceDestroyed = () => {
      state.surfaces--
    }
    session.userShell.events.sceneRefreshed = () => {
      state.sceneRefreshes++
    }

    session.userShell.actions.initScene('road', gfCanvas)
    session.globals.register()
    state.compositor = 'up'
    say('compositor up -- launching client')

    const app = createAppLauncher(session, 'web').launch(
      new URL(`${location.origin}/client/app.html`),
      () => {},
    )
    app.onStateChange = (s) => {
      state.app = s
      say(`app ${s}`)
    }
    app.onError = (e) => {
      state.error = String(e)
      say(`app error: ${e}`)
    }
  } catch (e) {
    state.error = String(e && e.stack ? e.stack : e)
    say(`FAILED: ${e}`)
    console.error(e)
  }
}

window.addEventListener('load', main)
