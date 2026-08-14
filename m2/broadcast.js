// The broadcast: putting a window on the dashboard's TV.
//
// WHY THIS IS A QUAD AND NOT A DRAWING ON THE DASH CANVAS. A window's picture is
// a GPU texture that Greenfield decoded into the context three shares with it
// (see shell.js's header). The cockpit is a 2D canvas on a DIFFERENT element, and
// a 2D context cannot sample a WebGL texture -- not cheaply, not at all without a
// per-frame readback. So the picture stays where it already is, in the road's own
// scene, and the dashboard LEAVES A HOLE where the screen goes: `drawMonitor`
// paints the bezel and skips the glass while something is on air, and this quad
// shows through it.
//
// That is why `monRect()` is exported from dash.js rather than the TV's position
// being written down twice. The thing that paints the fitting and the thing that
// puts a picture in it read one definition, or they come apart at the edges --
// the same discipline the mirrors and the monitor already keep in RAVIO.
//
// PARENTED TO THE CAMERA, like the tube rack used to be -- and here that is
// right for the reason it was wrong there. A gauge floating in front of your eyes
// with nothing under it is an instrument that lost its panel; a TV screen is
// SUPPOSED to be fixed to the frame, because it is part of the cockpit and not
// part of the road.

import * as THREE from 'three'

// How far in front of the eye the screen hangs. Any value inside the near plane
// works -- the quad is scaled from it -- so this is chosen to be comfortably
// clear of near (1) without being far enough out for fog (1400) to touch it.
const DIST = 20

// A sign's identity is the Map key the ledger filed it under, and it lives on
// `mesh.userData.signKey` -- the record itself has no `key` field. Read through
// one helper so this file cannot invent a second answer to "which window is this".
const keyOf = (sign) => sign?.mesh?.userData?.signKey ?? null

export function createTv(camera) {
  const group = new THREE.Group()
  group.position.z = -DIST
  // DEPTH OFF, DRAWN LAST. The road is closer to the camera than 1400 for most
  // of its length and the signs stand up out of it, so a screen bolted to the
  // frame has to win against geometry it is genuinely in front of AND against
  // geometry it is not. Disabling the test and forcing the order is what "this
  // is furniture in the cockpit, not an object in the world" means in GL terms.
  group.renderOrder = 999

  // The backing. A window is almost never 16:9 and the picture is LETTERBOXED
  // rather than stretched -- a broadcast that changed the shape of the window it
  // is showing would be the screen lying about its source -- so the bars have to
  // be something rather than a hole onto the road.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    // TRANSPARENT WITH FULL OPACITY, which sounds like a contradiction and is
    // the whole fix. Left opaque, this quad renders in the OPAQUE pass -- which
    // three draws entirely before the transparent one, regardless of
    // renderOrder. Every transparent object in the scene therefore landed on top
    // of it, and the window's own post ship showed through the letterbox bars in
    // front of the broadcast. Marking it transparent puts it in the same pass as
    // the picture, where renderOrder 999/1000 actually decides the answer.
    new THREE.MeshBasicMaterial({
      color: 0x04060c, depthTest: false, depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
    }),
  )
  back.renderOrder = 999
  group.add(back)

  // THE SAME MATERIAL A SIGN USES, and `transparent` is deliberately NOT on it.
  //
  // It was, for one build, and the screen came out perfectly black while every
  // report insisted it was drawing: `on: true`, `hasMap: true`, the quad sized
  // and placed correctly. A decoded surface's texture carries an alpha channel
  // that the client never wrote, so with blending enabled the whole picture is
  // multiplied by zero. Signs have never set `transparent` -- which is why they
  // have always looked right -- and a broadcast is the same texture on a
  // different quad, so it is the same material.
  //
  // The letterbox bars do not need it either: `back` is a real quad behind this
  // one rather than a hole this one leaves.
  // TRANSPARENT PASS, ALPHA IGNORED. Two constraints that look contradictory:
  //
  //   1. It must be in the TRANSPARENT pass, or every transparent object in the
  //      scene draws after it -- three renders all opaque geometry before any
  //      transparent geometry, and `renderOrder` only sorts WITHIN a pass. Left
  //      opaque, the window's own post ship landed in front of the broadcast.
  //   2. It must NOT blend on the texture's alpha. A decoded surface carries an
  //      alpha channel the client never wrote, so ordinary blending multiplies
  //      the whole picture by zero -- a perfectly black screen with every report
  //      saying it is drawing. (Learned once already; see the note this replaces.)
  //
  // CustomBlending with src=One dst=Zero is "write the source, ignore alpha",
  // which satisfies both: it sits in the transparent list and behaves like an
  // opaque blit. `back` is the same, one renderOrder lower, so the letterbox bars
  // are underneath rather than on top -- which is what marking `back` transparent
  // alone got wrong in the other direction.
  const pic = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      toneMapped: false, depthTest: false, depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
    }),
  )
  pic.renderOrder = 1000
  group.add(pic)

  group.visible = false
  camera.add(group)

  let showing = null   // the sign currently on air
  let lastRect = null

  // A screen rect in CSS pixels -> the camera-space box that exactly covers it.
  // Straight out of the perspective projection: at `DIST` the visible half-height
  // is DIST*tan(fov/2) and the half-width is that times the aspect, so a pixel
  // rect is a linear map. No eyeballing, and it re-derives on every resize.
  function camBox(rect, W, H) {
    const halfH = DIST * Math.tan(((camera.fov / 2) * Math.PI) / 180)
    const halfW = halfH * camera.aspect
    const cx = ((rect.x + rect.w / 2) / W) * 2 - 1
    const cy = 1 - ((rect.y + rect.h / 2) / H) * 2
    return {
      x: cx * halfW,
      y: cy * halfH,
      w: (rect.w / W) * 2 * halfW,
      h: (rect.h / H) * 2 * halfH,
    }
  }

  return {
    group,
    // WHICH WINDOW IS ON AIR, or null. The sign is held rather than its texture,
    // because a window that closes takes its texture with it and the ledger has
    // to be able to notice -- see `sync`.
    set(sign) {
      showing = sign || null
      pic.material.map = showing?.tex || null
      pic.material.needsUpdate = true
      group.visible = !!showing
    },
    showing: () => showing,

    // Called every frame with the rect the dashboard reserved. Cheap: it only
    // touches the scene graph when the rect or the source actually moved.
    sync(rect, W, H, aliveKeys) {
      // A WINDOW THAT CLOSED CANNOT STAY ON AIR. Its texture belongs to a
      // surface that is gone, and three would happily keep drawing the last
      // frame of it -- a screen showing a program that has exited, with no way
      // to tell from the picture. Dropped here rather than in a close handler,
      // because reconciling beats remembering: any route out of a window ends
      // with it missing from the ledger.
      if (showing && aliveKeys && !aliveKeys.has(keyOf(showing))) {
        this.set(null)
        return
      }
      if (!showing) { group.visible = false; return }
      group.visible = true

      const same = lastRect && lastRect.x === rect.x && lastRect.y === rect.y
                && lastRect.w === rect.w && lastRect.h === rect.h
                && lastRect.W === W && lastRect.H === H
                && lastRect.sw === showing.size?.width && lastRect.sh === showing.size?.height
      if (same) return
      lastRect = { ...rect, W, H, sw: showing.size?.width, sh: showing.size?.height }

      const box = camBox(rect, W, H)
      back.position.set(box.x, box.y, 0)
      back.scale.set(box.w, box.h, 1)

      // LETTERBOXED, not stretched. The window keeps its own aspect inside the
      // screen; whichever axis runs out first is the one that fits.
      const sw = showing.size?.width || 16
      const sh = showing.size?.height || 9
      const srcAspect = sw / sh
      const boxAspect = box.w / box.h
      const w = srcAspect > boxAspect ? box.w : box.h * srcAspect
      const h = srcAspect > boxAspect ? box.w / srcAspect : box.h
      pic.position.set(box.x, box.y, 0.01)
      pic.scale.set(w, h, 1)
    },

    report: () => ({
      on: !!showing,
      key: showing ? keyOf(showing) : null,
      source: showing ? { w: showing.size?.width, h: showing.size?.height } : null,
      pic: { w: +pic.scale.x.toFixed(3), h: +pic.scale.y.toFixed(3) },
      back: { w: +back.scale.x.toFixed(3), h: +back.scale.y.toFixed(3) },
      // The letterbox, as a fraction -- 0 means the window filled the screen.
      bars: back.scale.x > 0
        ? +(1 - (pic.scale.x * pic.scale.y) / (back.scale.x * back.scale.y)).toFixed(3)
        : null,
      hasMap: !!pic.material.map,
      // WHERE THE QUAD ACTUALLY IS, projected through the same camera that draws
      // it. Every field above describes what this module INTENDED; a screen that
      // is black while all of them read correctly means the intent is not the
      // problem, and the only way to tell a mis-placed quad from an unlit one is
      // to ask where it landed on screen.
      where: (() => {
        const p = new THREE.Vector3()
        pic.getWorldPosition(p)
        const ndc = p.clone().project(camera)
        let node = pic, chainVisible = true
        while (node) { if (!node.visible) chainVisible = false; node = node.parent }
        return {
          ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)],
          inFrustum: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1,
          chainVisible,
          inScene: !!pic.parent?.parent,
          mapIsRT: !!pic.material.map?.isRenderTargetTexture,
          mapUuidSameAsSource: pic.material.map?.uuid === showing?.tex?.uuid,
        }
      })(),
    }),
  }
}
