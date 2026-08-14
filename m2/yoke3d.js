// The yoke as a MESH, on its own WebGL canvas above the dashboard.
//
// Ported from `RAVIO/world/yoke3d.js`. Every constant is RAVIO's: the HALF 1.17
// framing, the 26-degree lens, the 64 extrude steps, the three lights and their
// positions, the -0.34 resting lean. The shape comes from `RIM_HALF` in dash.js
// -- the SAME authored profile the flat fallback draws -- so the mesh and the
// fallback are one object rather than two drawings that will drift.
//
// WHY A SECOND CONTEXT, and in RRABBIT the reason is sharper than in RAVIO. The
// road's context is SHARED WITH GREENFIELD (see shell.js's header): three and
// the compositor hand each other the same `WebGLRenderingContext`, and the whole
// M1 result rests on that. Adding a yoke to the road's scene would put it behind
// the dashboard it belongs to, and giving it its own renderer on that context
// means a third party trampling state that two already have to negotiate. A
// small transparent canvas with a context of its own touches neither.
//
// AND IT IS ALLOWED TO FAIL. A browser grants a finite number of WebGL contexts
// and the road's is the one that matters -- if this one cannot be had, the
// cockpit keeps the flat `wheel()` in dash.js and says so in `__yoke()`. That is
// why the fallback was never deleted: a dashboard with a flat wheel is worse
// than one with a lit mesh and far better than one with no wheel at all.

import * as THREE from 'three'
import { RIM_HALF, saucer } from './dash.js'

// The rim's cross-section: a rounded bar, wide across the face and shallower
// through it, which is what a hand wraps around. ExtrudeGeometry sweeps a 2D
// shape along a path, so this is drawn in the plane PERPENDICULAR to the rim.
function gripSection(w, h) {
  const s = new THREE.Shape()
  const r = Math.min(w, h) * 0.48
  s.moveTo(-w / 2 + r, -h / 2)
  s.lineTo(w / 2 - r, -h / 2)
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
  s.lineTo(w / 2, h / 2 - r)
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
  s.lineTo(-w / 2 + r, h / 2)
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
  s.lineTo(-w / 2, -h / 2 + r)
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
  return s
}

// The rim centreline, lifted out of dash.js's 2D profile into 3D. Same points,
// same mirror, so the mesh and the fallback are the same object -- and the tips
// are pulled slightly toward the pilot, which is what stops the grips reading as
// a flat ring seen at an angle.
function rimCurve() {
  const half = RIM_HALF.map(([x, y]) => [x, y])
  const full = half.concat(half.slice(0, -1).reverse().map(([x, y]) => [-x, y]))
  return new THREE.CatmullRomCurve3(
    full.map(([x, y]) => new THREE.Vector3(x, -y, 0.1 * (1 - Math.abs(y)))),
    false, 'catmullrom', 0.5,
  )
}

export function makeYoke(canvas, palette) {
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  } catch (e) {
    return null
  }
  // THREE FAULTS, NOT ONE. A constructor that threw, a renderer that came back
  // without a context, and a context that was granted and then lost are three
  // different things, and a bare `if (!renderer)` reports the first two as the
  // same event. `__yoke()` names which.
  if (!renderer || !renderer.getContext()) return null
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  // ON AXIS, framed from the mesh's actual extent rather than by eye. The yoke
  // reaches +-1.11 units and RAVIO's first camera framed +-1.05, which sliced
  // both grips down their outer edge -- and because the canvas is exactly the
  // square the dash reserves, it read as the DASH trimming them rather than as
  // the camera. HALF is that extent plus room for a tip to swing at full roll.
  const HALF = 1.17
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 40)
  camera.position.set(0, 0, HALF / Math.tan(((26 / 2) * Math.PI) / 180))
  camera.lookAt(0, 0, 0)

  const yoke = new THREE.Group()
  scene.add(yoke)

  // MOSTLY DIFFUSE, and that is not a style choice. A metal in a
  // MeshStandardMaterial is lit by what it REFLECTS, so with no environment map
  // a high metalness renders very nearly black -- the mesh there, correctly
  // placed, and invisible. There is no env map here on purpose, so the material
  // has to earn its shading from the lights instead.
  const body = new THREE.MeshStandardMaterial({
    color: 0x1c2233, metalness: 0.22, roughness: 0.55,
  })
  const trim = new THREE.MeshStandardMaterial({
    color: palette.rim, metalness: 0.25, roughness: 0.35,
    emissive: palette.rim, emissiveIntensity: 0.35,
  })

  // ---- the rim, swept along the profile.
  // 64 steps, not 120: RAVIO measured 15k triangles at 120 costing 11.7ms a
  // frame (p50 27 -> 39 on the same scene), and halving it is invisible on a
  // curve this smooth at 200px across.
  const rim = new THREE.Mesh(
    new THREE.ExtrudeGeometry(gripSection(0.2, 0.26), {
      extrudePath: rimCurve(), steps: 64, bevelEnabled: false,
    }), body)
  yoke.add(rim)

  // ---- the spokes. They RUN INTO the rim rather than up to it: a spoke that
  // stops at its own length leaves a seam of background between the two and the
  // yoke reads as parts laid next to each other. Each is pushed past the
  // centreline so the join is hidden inside the tube, which is how it is made.
  const bar = new THREE.Mesh(
    new THREE.ExtrudeGeometry(gripSection(0.17, 0.15), {
      depth: 2.06, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2,
    }), body)
  bar.rotation.y = Math.PI / 2
  bar.position.set(-1.03, 0, 0)
  yoke.add(bar)
  const stem = new THREE.Mesh(
    new THREE.ExtrudeGeometry(gripSection(0.2, 0.14), {
      depth: 0.9, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2,
    }), body)
  stem.rotation.x = Math.PI / 2
  stem.position.set(0, 0.04, 0)
  yoke.add(stem)

  // ---- the boss, and the horn painted on its face
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.2, 40), body)
  boss.rotation.x = Math.PI / 2
  boss.position.z = 0.06
  yoke.add(boss)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.365, 0.016, 10, 44), trim)
  ring.position.z = 0.16
  yoke.add(ring)

  // THE HORN IS THE SAME `saucer()`, drawn once into an offscreen canvas and
  // used as a texture -- so the ship on the hub and the ship the flat fallback
  // draws are one function, not two that will drift.
  const face = document.createElement('canvas')
  face.width = face.height = 256
  const fc = face.getContext('2d')
  fc.translate(128, 132)
  saucer(fc, 1.15)
  // TAGGED sRGB, or it comes out washed out. The renderer's output is sRGB, so
  // an untagged texture is taken as linear and converted a second time, which
  // lifts every dark value and drains the colour -- it reads exactly like a
  // faded decal. The same trap the old tube labels hit.
  const tex = new THREE.CanvasTexture(face)
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const horn = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 40),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
  horn.position.z = 0.165
  yoke.add(horn)

  // ---- light. Weighted toward the COOL sky term with the warm key kept down:
  // RAVIO's first pass ran a 2.1 key at 0xffe6bd and the yoke came out pale and
  // tan -- a prop lit for a different room, sitting in a cockpit whose every
  // other surface is dark navy under amber.
  scene.add(new THREE.HemisphereLight(0x4a5878, 0x05060b, 0.95))
  const key = new THREE.DirectionalLight(0xffe6bd, 1.35)
  key.position.set(-2.4, 3.2, 2.6)
  scene.add(key)
  // The dash's own amber thrown up from below -- the light this thing would
  // actually be sitting in.
  const bounce = new THREE.PointLight(palette.rim, 9, 9, 2)
  bounce.position.set(0.6, -1.5, 1.4)
  scene.add(bounce)

  let lastW = 0, lastH = 0
  return {
    render(roll, pitch, w, h) {
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h
        // Capped at 1.5. This is one small matte object with no text on it, and
        // the pixels are the expensive part of putting a second context on a
        // page that is already running a compositor.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      yoke.rotation.z = roll
      // The resting lean is the flat version's REST, one storey up: you are
      // above this thing looking down, but here it is the OBJECT that leans and
      // the light that finds the top faces, rather than a projection standing in.
      yoke.rotation.x = -0.34 + pitch
      renderer.render(scene, camera)
    },
    // A mesh on its own context cannot be asked what it is showing by looking at
    // the DOM, and a screenshot of it is a black square whether it is empty or
    // merely unlit. So it reports.
    stats() {
      const box = new THREE.Box3().setFromObject(yoke)
      return {
        calls: renderer.info.render.calls,
        tris: renderer.info.render.triangles,
        parts: yoke.children.length,
        box: [box.min.toArray().map((n) => +n.toFixed(2)),
              box.max.toArray().map((n) => +n.toFixed(2))],
        size: [renderer.domElement.width, renderer.domElement.height],
        cam: camera.position.toArray().map((n) => +n.toFixed(2)),
      }
    },
    // GIVING THE CONTEXT BACK IS NOT `renderer.dispose()`.
    //
    // That frees three's own objects and leaves the CONTEXT alive -- the browser
    // still counts it against a limit that is small and shared across every tab.
    // shell.js has handed the road's context back on `pagehide` since the day a
    // reload started costing one; this one was not in that reaper, so from the
    // moment it existed every reload of the shell leaked a context. The symptom
    // is a null context on a page that worked a minute ago, and it does not look
    // like a leak -- it looks like the machine broke.
    dispose() {
      try {
        renderer.dispose()
        renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext()
      } catch {
        /* leaving anyway -- nothing here is worth blocking an unload for */
      }
    },
  }
}
