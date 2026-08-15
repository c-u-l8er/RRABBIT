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
import { hooks, state, signs, titles, renames, sideQueue, ledgerSlot, keyOf, ACC, COOL, SCENE_ID, windowZ, roadOrder, slotFree, nextFreeSlot, nearestFreeSlot, SLOT_FIRST, SLOT_GAP, canvasTexture } from './world.js'
import * as ws from './workspaces.js'
import * as layout from './layout.js'
import { release, rekeyZoom } from './travel.js'
// THE SAME SHIP AS THE YOKE'S HORN. `saucer()` is one function, drawn on the
// wheel's boss, on the full-screen button below, and on the flying exit in
// dash.js -- so the mark that takes you into a window's own screen and the mark
// that brings you back are visibly one object, and none of the three can drift.
import { saucer } from './dash.js'

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

// ---------------------------------------------------------------------------
// HOW BIG A WINDOW IS, IN WORLD UNITS -- one scale, used everywhere.
//
// This used to be `sw = 300` for EVERY window, with the height taken from the
// surface's aspect. Two things fall out of that, and both were reported:
//
//   1. A 250x250 client and a 1920x1080 client got the SAME 300-wide board, at
//      wildly different pixel-to-world scales. The board never told you how big
//      the window was, only what shape it was.
//   2. The resize grab could not change a sign's width. Drag it wider, the
//      preview scales the quad wider, you let go, the client reallocates, the
//      sign is rebuilt -- at 300 wide again, just shorter. The width snapped
//      back every time. "The --> resizing doesn't actually resize things."
//
// So world size is now surface size times ONE constant, and a bigger window is a
// bigger sign. The constant is chosen so the CANONICAL window is exactly the
// 300-wide board the road was laid out around -- which makes this change a
// no-op at the canonical size, and a difference only as a window departs from
// it. Everything the road's geometry was tuned against still holds there.
const SIGN_W = 300
// The window this scale is calibrated on. Nothing is CONFIGURED to this size --
// asking for it at adoption was tried and taken back out, see
// askForRememberedSize -- it exists so the constant below has a stated origin
// rather than being a bare 0.3125.
const DEFAULT_PX = { w: 960, h: 600 }
const UNITS_PER_PX = SIGN_W / DEFAULT_PX.w

// The inner edge of a sign, measured from its road's centre line. A sign must
// CLEAR THE ROAD: the road is 320 wide (±160), so 180 leaves 20 units of verge,
// and the gantry's width was cut to match on the same argument.
//
// Pinned as the INNER edge rather than as a centre offset, which is what
// `SIGN_OFFSET = 330` was: 330 - 300/2 = 180, identical while every sign was 300
// wide, and wrong the moment one is not. A 600-wide sign at a fixed centre of
// 330 reaches x=30 and lies across its own road. Pinning the inner edge means a
// sign grows OUTWARD, away from the traffic, which is also what a roadside
// board does.
const SIGN_INNER = SIGN_OFFSET - SIGN_W / 2

// The `-->` is wider than it is tall, so the grab is not square. HANDLE is the
// hit-area unit; the visible text gets its own proportions.
const HANDLE = 34
const GRIP_W = 40
const GRIP_H = 20
// Turned 45 degrees, so `-->` points the way dragging it actually takes the
// corner: up and out. How far out it has to sit is then not a taste -- a
// rectangle rotated 45 degrees has an axis-aligned half-extent of
// (w + h) / 2 / sqrt(2), and anything less than that overlaps the surface again.
const GRIP_REACH = (GRIP_W / 2 + GRIP_H / 2) / Math.SQRT2 + 1
const PAD = 66
// `(prev)--` is eight characters, so the quad is wide and short. Its hit pad is
// taller and wider, the same allowance the resize grab's pad makes.
//
// SMALLER AND CLOSER, asked for -- and the resize arrow was asked for exactly
// this once already ("smaller, closer, and only there when you reach for it").
// A control that only appears when you reach for it does not need to announce
// itself, so it can be small; and the nearer it sits to the edge it acts on, the
// more it reads as part of that edge rather than as something floating beside
// the window.
//
// Only the HEIGHT is chosen. The width comes from the text (stepTexture), so the
// quad has no transparent margin to hold the glyphs away from the window.
//
// STEP_GAP clears the FRAME, not the surface. The frame is `sw + 14`, so its
// edge is 7 out from the picture -- an inner edge at 6 was sitting on the cyan
// border rather than beyond it, which is the one place a control must not be:
// half on the chrome of the thing it acts on. 8 is one unit clear of it.
const STEP_H = 20
const STEP_GAP = 8

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
  grabTex = canvasTexture(THREE, c)
  return grabTex
}

// The close control's face: `X--`, which is `-->` read in a mirror.
//
// Asked for as "--X", and drawn the other way round on purpose: the two are the
// same shape pointing away from opposite corners of the same window, so the tail
// belongs on the inside and the head on the outside in BOTH of them. `-->` at
// the top right has its head out to the right; `X--` at the top left has its X
// out to the left. Written "--X" it would point back INTO the window, which is
// the one thing neither control does.
//
// RED, and the only red anything in this shell. The resize grab is amber like
// the rest of the furniture because dragging a window bigger is not a decision;
// closing one is, and it is next to a control you are going to be reaching for
// with the same hand.
// THE STEP CONTROLS, on the middle of each side edge: `(prev)--` on the left and
// `--(next)` on the right.
//
// Same family as `-->` and `X--` -- text, a shadow, no panel -- and the dashes
// point INTO the window on these two, which is the opposite of the corner pair
// and is right for the opposite reason. The corner controls act on this window
// and reach away from it; these two bring another window HERE, so the arrow
// comes from the edge you are pointing at back to where you are standing.
// THE QUAD IS SIZED TO THE TEXT, not the text to the quad.
//
// It was a fixed 256x64 canvas with `--(next)` drawn centred in it. Eight
// characters of 40px monospace is about 192px, so roughly 32px of transparent
// canvas sat either side of the glyphs -- and on an 88-wide quad that is eleven
// world units of nothing between the window's edge and the first thing you can
// see. Asked twice to bring it closer; the second time it was already 9 units
// out and the gap being complained about was entirely inside the texture.
//
// EXACTLY THE TRAP `-->` HIT AND HAD FIXED: "the glyphs sat in a wide
// transparent margin, which put the visible arrow much further from the corner
// than the mesh actually is". Written down, in this file, and walked into again
// by a control built later. So: measure the text, cut the canvas to it, and let
// the quad take its aspect from that -- then the mesh edge IS the glyph edge and
// STEP_GAP means what it says.
const STEP_FONT = 44
const stepTex = { prev: null, next: null }
function stepTexture(which) {
  if (stepTex[which]) return stepTex[which]
  const text = which === 'prev' ? '(prev)--' : '--(next)'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = `bold ${STEP_FONT}px ui-monospace, monospace`
  const w = Math.ceil(measure.measureText(text).width)
  const c = document.createElement('canvas')
  c.width = w
  c.height = Math.round(STEP_FONT * 1.35)
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold ${STEP_FONT}px ui-monospace, monospace`
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 10
  g.fillStyle = '#' + COOL.toString(16).padStart(6, '0')
  // Twice, so the shadow is dark enough to read against a bright window.
  g.fillText(text, c.width / 2, c.height / 2 + 1)
  g.fillText(text, c.width / 2, c.height / 2 + 1)
  const tex = canvasTexture(THREE, c)
  stepTex[which] = { tex, aspect: c.width / c.height }
  return stepTex[which]
}

// THE TWO ANSWERS, and NEITHER OF THEM IS THE BUTTON YOU JUST PRESSED.
//
// A second press on `X--` used to be the yes, on the argument that two presses of
// one control is what a two-stage button means everywhere else. Asked to remove it,
// and the ask is right: that shape only guards against a stray click, not against a
// determined one, and a double-click -- which is a single gesture your hand makes
// without deciding twice -- went straight through it. The pointer has to TRAVEL to
// the yes now. Distance is the confirmation; a second click in the same place is
// not a second decision.
//
// `close--X` ends in the glyph of the control that asked, so the answer is visibly
// the same act as the button you came from; `<--keep` points back the other way.
// Both wear the arrows the shell uses everywhere for "this leads there".
//
// Sized from the text like the step controls, for the same reason: a fixed quad
// either crops a word or leaves a word swimming in it, and both read as a control
// somebody forgot to finish.
const answerTex = {}
function answerTexture(which) {
  if (answerTex[which]) return answerTex[which]
  const text = which === 'keep' ? '<--keep' : 'close--X'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = `bold ${STEP_FONT}px ui-monospace, monospace`
  const w = Math.ceil(measure.measureText(text).width)
  const c = document.createElement('canvas')
  c.width = w
  c.height = Math.round(STEP_FONT * 1.35)
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold ${STEP_FONT}px ui-monospace, monospace`
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 10
  // The close answer wears the close control's own red; the cancel wears the name
  // board's cream, which is this shell's colour for "text that is just telling you
  // something". Colour is the whole difference between the two, so it is the one
  // thing about them that is not shared.
  g.fillStyle = which === 'keep' ? '#f3ead4' : '#ff6b6b'
  g.fillText(text, c.width / 2, c.height / 2 + 1)
  g.fillText(text, c.width / 2, c.height / 2 + 1)
  const tex = canvasTexture(THREE, c)
  answerTex[which] = { tex, aspect: c.width / c.height }
  return answerTex[which]
}

// THE BROADCAST CONTROL'S FACE: `&--`, at the BOTTOM LEFT.
//
// WRITTEN `--&` FIRST, AND THAT WAS BACKWARDS ON THE GLASS. The reasoning was
// that the dashes should run into the mark because the window flows TO the
// ampersand -- which reads well in a sentence and wrong on a window. Every
// control here is rotated 45 degrees into its corner, so what actually decides
// the direction is which END of the string ends up outboard: `X--` has its X out
// to the top left, `-->` has its head out to the top right, and `--&` put the
// ampersand up and to the RIGHT, pointing back into the window it is mounted on.
// It looked like an arrow aimed at the client area.
//
// So the mark goes outboard like the other two: `&--`, ampersand out to the
// bottom left, dashes reaching back in. The corner pair on the left edge now
// lean the same way and read as one fitting.
//
// CYAN, and the third colour on a window. `-->` is amber because a resize is
// furniture; `X--` is red because closing cannot be undone. Broadcasting is
// neither -- it is reversible and it is not chrome -- and cyan is already this
// shell's colour for a live thing (the lane edges, the redline, the map's
// links). A control that shares a colour with a control that means something
// else is a control you have to remember rather than read.
let castTex = null
function castTexture() {
  if (castTex) return castTex
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 64
  const g = c.getContext('2d')
  g.clearRect(0, 0, 128, 64)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = 'bold 58px ui-monospace, monospace'
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 10
  g.fillStyle = '#' + COOL.toString(16).padStart(6, '0')
  // Twice, so the shadow is dark enough to read against a lit surface -- the
  // same two-pass the other three controls use.
  g.fillText('&--', 64, 35)
  g.fillText('&--', 64, 35)
  castTex = canvasTexture(THREE, c)
  return castTex
}

// THE FULL-SCREEN BUTTON'S FACE: the ship, on the top of the post.
//
// The post is the one piece of a window's furniture that is neither the picture
// nor a corner control -- it is what the window STANDS ON -- and a button there
// reads as belonging to the whole window rather than to one of its edges. It is
// also the only spot on a window that is empty at every size.
//
// No panel and no border, like every other control in this shell: the ship is
// drawn on transparent and given the same shadow the marks get, so it survives
// being over a lit surface or over the road behind it.
// THE CANVAS IS CUT TO THE DRAWING, 2:1 and not square.
//
// `saucer()` spans about 190 x 84 in its own units -- it is a saucer, so it is
// twice as wide as it is tall. On a square canvas the top and bottom thirds were
// transparent, which pushed the VISIBLE ship a third of a quad below the post it
// was supposed to be capping. That is exactly the trap `-->` and `--(next)` both
// hit and both wrote down: measure the drawing, cut the canvas to it, and let the
// quad take the aspect -- or the mesh is in one place and the mark is in another.
let fullTex = null
function fullTexture() {
  if (fullTex) return fullTex
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const g = c.getContext('2d')
  g.clearRect(0, 0, 256, 128)
  g.save()
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 12
  g.translate(128, 70)
  // 1.2: 190 units across becomes 228 of the 256, leaving margin for the shadow.
  saucer(g, 1.2)
  g.restore()
  fullTex = canvasTexture(THREE, c)
  return fullTex
}

let closeTex = null
function closeTexture() {
  if (closeTex) return closeTex
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 64
  const g = c.getContext('2d')
  g.clearRect(0, 0, 128, 64)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = 'bold 58px ui-monospace, monospace'
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 10
  g.fillStyle = '#ff6b6b'
  g.fillText('X--', 64, 35)
  g.fillText('X--', 64, 35)
  closeTex = canvasTexture(THREE, c)
  return closeTex
}

// THE NAME BOARD over a window, and the way into the menu about it.
//
// A canvas texture rather than glyph geometry, for the reason the gantry panels
// give: the text changes whenever the client changes its title, and geometry
// text needs a font asset and a build step. Redrawn only when the string
// actually changes -- see syncTitles.
//
// The address is on it as well as the title. A client picks its own title and
// two of them can pick the same one; `home:2` is the shell's name for the window
// and is the thing the map, the keyboard and every report in here agree on. The
// title tells you what it is, the address tells you which one.
const PLATE_H = 26

// THE NAME BOARD IS TEXT, AND NOTHING ELSE.
//
// It was a bordered card with the window's address in grey on the right, and
// both were asked to go. They are the same mistake the resize grab already made
// and had corrected: a picture hung next to a window, which is a thing that
// draws pictures. `-->` won that argument by being three characters and a
// shadow, and this is the same answer -- the name, in the same monospace as
// every other word in the shell, with a shadow so it survives being over a lit
// sign or over nothing at all.
//
// THE ADDRESS IS GONE FROM IT TOO. `home:2` was there because a client can name
// two windows the same thing and the shell needs one name that is unique. That
// is still true and it is still not the board's job: the map says the address on
// the window's own page, and out here you are looking AT the window rather than
// looking it up.
function plateTexture(title, width) {
  const px = 3 // canvas pixels per world unit, so the text is not soft
  const c = document.createElement('canvas')
  c.width = Math.max(64, Math.round(width * px))
  c.height = Math.round(PLATE_H * px)
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold ${Math.round(PLATE_H * px * 0.72)}px ui-monospace, monospace`
  g.shadowColor = 'rgba(3,4,10,0.95)'
  g.shadowBlur = 12
  g.fillStyle = '#f3ead4'
  // CLIPPED, not shrunk. A title that changes size as the client edits it is a
  // board that moves while you are reading it.
  g.save()
  g.beginPath()
  g.rect(0, 0, c.width, c.height)
  g.clip()
  // Twice, so the shadow is dark enough to read against a bright window.
  g.fillText(title, c.width / 2, c.height / 2)
  g.fillText(title, c.width / 2, c.height / 2)
  g.restore()
  const tex = canvasTexture(THREE, c)
  return tex
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
// THE TWO BUFFER PATHS AGREE ABOUT WHICH WAY IS UP, once the upload is not
// being flipped behind their backs. They used to disagree, and this function
// used to branch on `mimeType` because of it -- an shm buffer needed the flip
// and an h264 frame did not. That was never a property of either format:
// three.js leaves UNPACK_FLIP_Y_WEBGL switched on, so Greenfield's plane
// uploads were flipped by whatever three had textured last, and the h264 path
// flipped a second time in its render-into-texture pass. `fenceScenePasses` in
// shell.js now pins the unpack state off, so both paths land the same way:
//
//   shm    upload row 0 -> texel row 0            = the surface's top row
//   h264   the YUV pass draws its quad with v=minV at clip y=-1, and clip y=-1
//          is framebuffer row 0, which is destination texel row 0 -- and v=minV
//          is the source's first row. Same answer, by a longer road.
//
// So texel row 0 is the top of the picture either way, and either way it wants
// the flip, because three samples v=0 at the BOTTOM of a plane. One rule, no
// branch. (The old branch was measured, not guessed -- on a real xterm,
// `[travis@PX13 RRABBIT]` came out `[ɿɒʌiƨ@bXI3 ЯЯAᙠᙠIT]`, a vertical mirror.
// It measured the accident faithfully.)
// THE PART OF THE BUFFER THAT IS ACTUALLY THE WINDOW.
//
// A client drawing its own decorations paints a shadow into its buffer and then
// calls `xdg_surface.set_window_geometry` to say which rectangle of it is the
// window. Nothing here read that, so a sign showed the whole buffer -- window
// AND shadow -- and the shadow is unpainted, which arrives as opaque black once
// the encoder has been through it. Measured on this image: mousepad committed a
// 775x443 buffer whose window rect is `{x:26, y:23, w:723, h:391}`, and the
// board carried a black margin on the left, the top and the bottom.
//
// VALIDATED, NOT TRUSTED. Greenfield's `surface.geometry` is not always the xdg
// rect -- on `foot` it reported `{y:-26, h:338}` against a 312-tall buffer, i.e.
// a rectangle taller than the thing it describes and starting above it. That is
// a bounding box of something else, and using it as an inset would crop a
// window to a lie. Anything that does not sit inside the buffer is refused and
// the whole buffer is used, which is exactly the old behaviour.
function windowRectOf(surface, size) {
  const g = surface?.geometry
  if (!g?.size) return null
  const x = g.x0, y = g.y0, w = g.size.width, h = g.size.height
  if (![x, y, w, h].every(Number.isFinite)) return null
  if (w <= 0 || h <= 0) return null
  if (x < 0 || y < 0) return null
  if (x + w > size.width || y + h > size.height) return null
  // A rect that IS the buffer is not a crop; say so rather than doing the
  // arithmetic and landing back where we started.
  if (x === 0 && y === 0 && w === size.width && h === size.height) return null
  return { x, y, w, h }
}

function adoptSurfaceTexture(rs, crop) {
  const { width, height } = rs.size
  const rt = new THREE.WebGLRenderTarget(width, height)
  rt.depthTexture = new THREE.DepthTexture(width, height)
  renderer.setRenderTargetTextures(rt, rs.texture.texture)
  const tex = rt.texture
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  // THE DESTINATION TEXTURE IS BIGGER THAN THE SURFACE. Measured on foot in the
  // tr4 guest: surface 696x468, texture 768x512. The encoder pads a surface up
  // to its alignment, Greenfield sizes the destination to the DECODED frame and
  // then draws only the surface into it, so mapping the texture 0..1 -- which is
  // what a plain three material does -- puts the unwritten margin on the sign as
  // well. That seam is what got filed as the "tear".
  //
  // WHICH sub-rect is arithmetic, not a guess. The YUV pass calls
  // `viewport(0, 0, width, height)` on a framebuffer the size of the whole
  // texture, and a GL viewport is anchored at the BOTTOM-LEFT -- so the picture
  // is written to texels [0..width) x [0..height) and the margin is the top and
  // the right. (This read bottom-RIGHT before, from the source-side
  // `textureMinU`; that is where the pass READS in the padded decode, not where
  // it WRITES. The two are different windows and the difference is a black band
  // down one side and along the top -- photographed.)
  //
  // For an unpadded buffer (every shm client) sx = sy = 1 and this reduces
  // exactly to the plain flip.
  // THE DESTINATION SIZE, TAKEN FROM THE DESTINATION.
  //
  // This used to read `rs.__codedSize` FIRST -- the DECODER's
  // codedWidth/codedHeight, stamped by the h264 pass in shell.js -- under a
  // comment claiming `rs.texture.size` is "the SURFACE size even when the
  // texture behind it holds a padded decoded frame". That claim is false, and it
  // is half of the black border. Greenfield allocates the destination with
  //
  //     renderState.texture.setContentBuffer(null, opaque.codedSize)   YUVA2RGBA.js:66-67
  //
  // so `rs.texture.size` IS the destination texture's own size, by construction.
  // Measured on gnome-text-editor through the proxy: surface 1010x627,
  // `rs.texture.size` 1024x640, `__codedSize` 1024x**642**. Two different
  // numbers -- and dividing the UVs by the decoder's one is dividing by a
  // texture that does not exist.
  //
  // `__codedSize` is kept as a DIAGNOSTIC (`__views().coded`) because decoder
  // coded size vs destination size is a real thing to be able to compare. It is
  // no longer arithmetic.
  const tw = rs.texture?.size?.width || rs.__codedSize?.w || width
  const th = rs.texture?.size?.height || rs.__codedSize?.h || height
  // WHICH CORNER THE PICTURE IS IN -- DERIVED, and it is the ORIGIN.
  //
  // This was CHOSEN before, from one photograph ("a 613-wide surface in a
  // 640-wide frame put exactly 27 black columns on the LEFT"), and choosing was
  // the mistake: two pipelines disagreed and there was no way to settle it
  // except taking another photograph. The shader answers it outright.
  // `YUV2RGBShader.updateShaderData`, which is the ONE thing that ever writes
  // this texture:
  //
  //     const { width, height } = renderState.size          // the surface
  //     this.gl.viewport(0, 0, width, height)               // <-- the destination rect
  //
  // The framebuffer is `renderState.texture.texture`, allocated at
  // `opaque.codedSize`; the viewport is anchored at the GL ORIGIN. So the
  // picture is written to destination texels [0, width) x [0, height) and the
  // padding is the far edges -- ALWAYS, on every decoder, because neither
  // `renderState.size` nor the viewport call depends on one. The far corner was
  // never reachable.
  //
  // (`textureMinU/V` in the same function is the mirror of this on the SOURCE
  // planes, and reading it as if it described the destination is how the far
  // corner got written down. The spec note says as much: "that is where the pass
  // READS in the padded decode, not where it WRITES".)
  //
  // Measured after, gnome-text-editor through the host proxy, one window:
  //
  //   was (far corner)   blackTop 0  blackBottom 14  blackLeft 0  blackRight 14
  //   now (origin)       blackTop 0  blackBottom  0  blackLeft 0  blackRight  0
  //
  // 14 was exactly `tw - width` (1024 - 1010): **the black band WAS padX**, which
  // is why resizing appeared to add black edges (pad 80 -> an 83 px band) and why
  // a window whose destination ran far enough ahead of its surface went black
  // outright. Both were reported from the image as separate faults.
  //
  // `?uv=far` restores the old arithmetic and `?uv=full` samples the whole
  // destination texture, padding included -- the way to SEE a margin rather than
  // argue about it. Runbook §8.
  const DIAG = new URLSearchParams(location.search).get('uv')

  // Zero unless someone asks for the old behaviour. For an unpadded buffer
  // (every shm client) tw === width and this was always zero anyway, which is
  // why no web client ever showed the band.
  const padX = DIAG === 'far' ? tw - width : 0
  const padY = DIAG === 'far' ? th - height : 0

  // THE RECT THAT WAS ACTUALLY WRITTEN, clamped to the allocation. `viewport` is
  // clipped by GL, so a frameSize larger than the texture it was drawn into
  // leaves the overhang unwritten -- and sampling it would put the cleared
  // colour back on the glass by a different route than the one just closed.
  // Equal to width/height in every ordinary frame; this only bites on the one
  // frame where a size change is half-applied.
  const pw = Math.min(width, tw)
  const ph = Math.min(height, th)

  // The window rect inside the surface, in surface pixels. Without a crop this
  // is the whole written rect. Clamped for the same reason: a crop declared
  // against a buffer bigger than the allocation would reach past it.
  const gx = Math.min(crop ? crop.x : 0, pw)
  const gy = Math.min(crop ? crop.y : 0, ph)
  const gw = Math.min(crop ? crop.w : pw, pw - gx)
  const gh = Math.min(crop ? crop.h : ph, ph - gy)

  if (DIAG === 'full') {
    tex.repeat.set(1, -1)
    tex.offset.set(0, 1)
    return { rt, tex }
  }

  // u runs left to right in both spaces, so it is a straight translate+scale.
  // v is flipped by the quad, so the sign's TOP edge (quad v=1) has to land on
  // the picture's first row and its bottom edge on the last:
  //   quad v=1 -> offset + 1 * (-gh/th) = (padY + gy) / th
  tex.repeat.set(gw / tw, -gh / th)
  tex.offset.set((padX + gx) / tw, (padY + gy + gh) / th)
  return { rt, tex }
}

function makeSign(view, milepost, district, side, dash) {
  const rs = view.renderStates[SCENE_ID]
  if (!rs || !rs.texture || !rs.texture.texture) return null
  const { width, height } = rs.size
  if (!width || !height) return null

  // The window, not the buffer. A client that draws its own shadow commits a
  // buffer bigger than its window; the board should be the window.
  const crop = windowRectOf(view.surface, rs.size)
  const { rt, tex } = adoptSurfaceTexture(rs, crop)

  // One sign is sized to ITS OWN surface, at the one scale every sign uses. M0's
  // board was a fixed rectangle and a 250x250 client filled a corner of it --
  // correct behaviour, wrong framing. A fixed 300 WIDTH was the next version of
  // the same mistake: it framed the picture perfectly and still told you nothing
  // about how big the window was, and it is what made the resize grab unable to
  // change a width. See UNITS_PER_PX.
  //
  // Sized to the CROP, so the frame lands on the window's own edge rather than
  // on the outside of its shadow.
  const sw = (crop ? crop.w : width) * UNITS_PER_PX
  const sh = (crop ? crop.h : height) * UNITS_PER_PX
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  )

  // HOW HIGH is decided here and nowhere else -- a sign STANDS ON the road, so
  // its bottom edge is pinned at y=40 and a taller window grows upward. Which
  // side of the road and where along it are decided by positionSign below, from
  // facts that can change after the sign is built.
  mesh.position.y = 40 + sh / 2
  scene.add(mesh)

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(sw + 14, sh + 14),
    new THREE.MeshBasicMaterial({ color: COOL }),
  )
  frame.position.y = mesh.position.y
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
  post.position.y = postTop - postH / 2
  scene.add(post)

  // Which side of the road, and where along it. The side used to be forced by
  // milepost parity, like RAVIO's billboards; it is now whatever the window was
  // opened with, because "open one on the left" is a thing you can ask for from
  // the enter gantry -- and, since windows can be moved, whatever it was last
  // put on. Parity is still the default when nobody said.
  positionSign({ mesh, frame, post }, district, side, dash)

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
  // `chrome` is the general fact -- this object belongs to the shell and not to
  // the client -- and `resizeHandle` is what it does. pickView filters on the
  // general one, so a control added later cannot forget to opt out of being
  // mistaken for a click on the application. That mistake is not a missed click:
  // a hit that resolves to no view reads as a click OUTSIDE the window, which is
  // the gesture that leaves it.
  handle.userData.chrome = true
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
  grabPad.userData.chrome = true
  mesh.add(grabPad)

  // THE CLOSE CONTROL, at the mirror of the grab -- top LEFT, wholly outside the
  // surface, same size, same distance out, turned the other way.
  //
  // IT IS DRAWN WHENEVER YOU ARE IN THE WINDOW, unlike the grab beside it, and
  // the difference is deliberate rather than an oversight. The grab appears only
  // when you reach for it because a resize is a thing you go looking for at the
  // edge you want to move, and an arrow parked there permanently is clutter. A
  // close control has to be FINDABLE: a way out that you can only see once you
  // are already pointing at it is one you have to be told about.
  const closeBtn = new THREE.Mesh(
    new THREE.PlaneGeometry(GRIP_W, GRIP_H),
    new THREE.MeshBasicMaterial({ map: closeTexture(), transparent: true, toneMapped: false }),
  )
  closeBtn.rotation.z = -Math.PI / 4
  closeBtn.position.set(-(sw / 2 + GRIP_REACH), sh / 2 + GRIP_REACH, 3)
  closeBtn.userData.closeButton = true
  closeBtn.userData.chrome = true
  closeBtn.visible = false
  mesh.add(closeBtn)

  const closePad = new THREE.Mesh(new THREE.PlaneGeometry(PAD, PAD), new THREE.MeshBasicMaterial({ visible: false }))
  closePad.position.set(-(sw / 2 + PAD / 2), sh / 2 + PAD / 2, 3)
  closePad.userData.closeButton = true
  closePad.userData.chrome = true
  mesh.add(closePad)

  // THE BROADCAST CONTROL, at the bottom left -- diagonally opposite the resize
  // grab and directly under the close. Same size, same distance out, wholly
  // outside the surface: it covers no client pixel, which is the rule the grab
  // established and every control since has kept.
  //
  // DRAWN ONLY WHEN REACHED FOR, like `-->` and unlike `X--`. The close control
  // has to be findable by someone who has never seen this shell; broadcasting is
  // a thing you go looking for, and a permanent cyan mark on every window you
  // stand in is the clutter the other corners already argued against.
  const castBtn = new THREE.Mesh(
    new THREE.PlaneGeometry(GRIP_W, GRIP_H),
    new THREE.MeshBasicMaterial({ map: castTexture(), transparent: true, toneMapped: false }),
  )
  // +45 WITH THE MARK FIRST, and both halves were needed. Measured off the two
  // renders rather than reasoned about: at -45 a string's LEFT end lands up and
  // to the left (which is how `X--` gets its X outboard at the top corner), and
  // at +45 the left end lands down and to the left. This is the BOTTOM corner,
  // so outboard is down-left -- the mark has to be the left end of the string
  // AND the lean has to be +45.
  //
  // Getting one of the two right is what produced both wrong versions: `--&` at
  // +45 put the ampersand up-right, pointing back into the client area, and
  // `&--` at -45 was `X--`'s lean copied to a corner that is its mirror.
  castBtn.rotation.z = Math.PI / 4
  castBtn.position.set(-(sw / 2 + GRIP_REACH), -(sh / 2 + GRIP_REACH), 3)
  castBtn.userData.castButton = true
  castBtn.userData.chrome = true
  castBtn.visible = false
  mesh.add(castBtn)

  const castPad = new THREE.Mesh(new THREE.PlaneGeometry(PAD, PAD), new THREE.MeshBasicMaterial({ visible: false }))
  castPad.position.set(-(sw / 2 + PAD / 2), -(sh / 2 + PAD / 2), 3)
  castPad.userData.castButton = true
  castPad.userData.chrome = true
  mesh.add(castPad)

  // THE FULL-SCREEN BUTTON, on the top of the post -- centred under the surface
  // rather than at a corner, because it acts on the whole window and not on one
  // of its edges. A child of the MESH like every other control, so it rides the
  // flatten; the post itself is a scene child and would have needed its own
  // pose kept in step.
  // A CAP ON THE POST. Two to one like its canvas, and sat so its own bottom
  // edge meets the post's top -- the ship rests ON the timber the way a finial
  // does, rather than floating partway down it.
  const FULL_W = 84
  const FULL_H = FULL_W / 2
  const fullBtn = new THREE.Mesh(
    new THREE.PlaneGeometry(FULL_W, FULL_H),
    new THREE.MeshBasicMaterial({ map: fullTexture(), transparent: true, toneMapped: false }),
  )
  // z = 12, NOT 3 like the corner controls. Those sit outside the surface's own
  // outline with nothing behind them, so 3 units proud is enough. This one is
  // centred on the POST, which is a 14-deep box running z -7..+7 about the sign's
  // plane -- at 3 the ship was inside the timber and read as a faint scratch on
  // it. 12 clears the post's near face with room for the shadow.
  // UP BY HALF ITS OWN HEIGHT, so the ship sits ASTRIDE the post's top end
  // rather than hanging below it -- a finial, which is what "like a cap" means.
  // Its centre lands on the surface's bottom edge; the lower half is over the
  // post and the upper half overhangs the window by FULL_H/2.
  //
  // THAT OVERHANG IS A REAL COST and it is taken on purpose. Every other control
  // in this shell sits wholly outside the surface because "a shell that draws its
  // own controls over a client's interface has decided its chrome matters more
  // than the program". This one is 21 units into the picture, at the bottom
  // centre, and it was asked for twice. The pad below is cut to exactly the mark
  // so the cost stops there: no invisible target reaches further in than the
  // thing you can see, which is the half of that rule that must not bend.
  // Then a quarter of its height back DOWN. Centring the mark on the post's top
  // put the saucer's DISC -- its widest part, and the bit that reads as resting
  // on something -- above the timber with only the dome over the picture. The
  // drawing is not vertically centred in its own canvas (the dome takes the top
  // third), so the mark's centre and the mark's seat are not the same point.
  fullBtn.position.set(0, -(sh / 2) + 4 - FULL_H / 4, 12)
  fullBtn.userData.fullButton = true
  fullBtn.userData.chrome = true
  fullBtn.visible = false
  mesh.add(fullBtn)

  // CUT TO THE MARK, not the usual square pad. A PAD-sized target centred on the
  // button would reach 37 units into the window's bottom centre and quietly eat
  // clicks meant for the application -- "the same fault wearing a disguise", as
  // the grab pad's own note puts it. This one is the ship's width, and its top
  // edge is the ship's top edge, so everything you can see is clickable and
  // nothing you cannot see is.
  const fullPad = new THREE.Mesh(
    new THREE.PlaneGeometry(FULL_W, PAD),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  fullPad.position.set(0, -(sh / 2) + 4 - FULL_H / 4 - (PAD / 2 - FULL_H / 2), 12)
  fullPad.userData.fullButton = true
  fullPad.userData.chrome = true
  mesh.add(fullPad)

  // THE NAME BOARD, between the two of them.
  //
  // A unit quad scaled by the layout, the same trick the gantry panels use, so
  // the texture can be swapped for a longer title without rebuilding geometry.
  // It spans the gap the two corner controls leave, and it is the click target
  // for everything about this window that is not "resize it" or "close it".
  const plateW = Math.max(120, sw - 2 * (GRIP_REACH + GRIP_W / 2))
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }),
  )
  plate.scale.set(plateW, PLATE_H, 1)
  plate.position.set(0, sh / 2 + GRIP_REACH, 3)
  plate.userData.titlePlate = true
  plate.userData.chrome = true
  plate.visible = false
  mesh.add(plate)

  const platePad = new THREE.Mesh(
    new THREE.PlaneGeometry(plateW, PAD),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  platePad.position.set(0, sh / 2 + GRIP_REACH, 3)
  platePad.userData.titlePlate = true
  platePad.userData.chrome = true
  mesh.add(platePad)

  // THE ANSWER ROW, above the name board and drawn only while the question is open.
  //
  // Above rather than beside: the two corner controls own the corners, the step
  // controls own the side edges, and the row over the board is the only edge of a
  // window with nothing on it -- so this is the one place a pair of buttons can
  // appear without covering a control you might have been reaching for instead.
  //
  // The board itself asks the question (syncTitles), which is why there is no third
  // mesh here for the text: the sign that says which window this is, is the sign
  // that should say which window is about to close.
  const answer = {}
  for (const which of ['keep', 'close']) {
    const dir = which === 'keep' ? -1 : 1
    const face = answerTexture(which)
    const aw = STEP_H * face.aspect
    const btn = new THREE.Mesh(
      new THREE.PlaneGeometry(aw, STEP_H),
      new THREE.MeshBasicMaterial({ map: face.tex, transparent: true, toneMapped: false }),
    )
    btn.position.set(dir * (aw / 2 + 8), sh / 2 + GRIP_REACH + PLATE_H * 1.15, 3)
    btn.userData.answerButton = which
    btn.userData.chrome = true
    btn.visible = false
    mesh.add(btn)
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(aw + 24, PLATE_H * 1.6),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pad.position.copy(btn.position)
    pad.userData.answerButton = which
    pad.userData.chrome = true
    mesh.add(pad)
    answer[which] = { btn, pad }
  }

  // `(prev)--` and `--(next)`, on the middle of each side edge, hover-only like
  // the two corner controls. Outside the surface for the same reason all of them
  // are: the thing underneath is somebody else's application.
  const step = {}
  for (const which of ['prev', 'next']) {
    const dir = which === 'prev' ? -1 : 1
    const face = stepTexture(which)
    const stepW = STEP_H * face.aspect
    const btn = new THREE.Mesh(
      new THREE.PlaneGeometry(stepW, STEP_H),
      new THREE.MeshBasicMaterial({ map: face.tex, transparent: true, toneMapped: false }),
    )
    btn.position.set(dir * (sw / 2 + STEP_GAP + stepW / 2), 0, 3)
    btn.userData.stepButton = dir
    btn.userData.chrome = true
    btn.visible = false
    mesh.add(btn)
    // The pad does NOT shrink with the button. It is what you aim at, the button
    // is only what you see, and making the target smaller because the label got
    // smaller is how a control ends up needing to be hunted for.
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(stepW + 32, PAD),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pad.position.copy(btn.position)
    pad.userData.stepButton = dir
    pad.userData.chrome = true
    mesh.add(pad)
    step[which] = { btn, pad }
  }

  state.adopted++
  return {
    mesh,
    frame,
    post,
    handle,
    grabPad,
    closeBtn,
    closePad,
    castBtn,
    castPad,
    fullBtn,
    fullPad,
    plate,
    platePad,
    plateW,
    prevBtn: step.prev.btn,
    prevPad: step.prev.pad,
    nextBtn: step.next.btn,
    nextPad: step.next.pad,
    keepBtn: answer.keep.btn,
    keepPad: answer.keep.pad,
    shutBtn: answer.close.btn,
    shutPad: answer.close.pad,
    // HOW FAR THE SHELL'S OWN FURNITURE STICKS UP PAST THE PICTURE, in world
    // units, recorded on the ledger because Travel has to know it and cannot
    // import this module (RRABBIT imports Travel, for release()).
    //
    // It is what "can you see all of the window" means now. The flatten's fit
    // used to be the surface's own height, which was the whole window until
    // there was a name board and a close control standing above the top edge --
    // and then arriving put both of them off the top of the screen, behind the
    // status line. Measured in the shot that found it: the plate was half
    // covered and the `X--` was hard against the frame edge.
    //
    // The close control is turned 45 degrees, so its half-extent is GRIP_REACH
    // by that constant's own construction; its top is therefore twice out.
    //
    // THE ANSWER ROW IS IN HERE TOO even though it is drawn only while a close is
    // being asked about. Fitting to it always costs a few units of frame and means
    // the prompt cannot appear off the top of the screen -- and a confirm you have
    // to scroll to is a confirm you answer by guessing.
    chromeTop: Math.max(2 * GRIP_REACH, GRIP_REACH + PLATE_H * 1.15 + STEP_H / 2),
    tex,
    rt,
    size: { width, height },
    // The destination-texture size this sign's UVs were computed from -- the
    // TEXTURE's own size, which is what adoptSurfaceTexture divides by, not the
    // decoder's coded size. A sign built before the first decode has none, and
    // its UVs are the unpadded fallback -- so this has to be compared, not
    // assumed settled.
    coded: rs.texture?.size ? { w: rs.texture.size.width, h: rs.texture.size.height } : null,
    // The window rect this sign was built against, kept so adoptPending can tell
    // that a client has DECLARED one since -- a change that moves the picture
    // without changing the buffer size, and would otherwise never be noticed.
    crop,
  }
}

// WHERE THE THREE PIECES OF A SIGN STAND, from the three facts that decide it.
//
// One function called from two places, because there are now two ways a sign
// arrives at a position: it is built there, or it is MOVED there. A second copy
// of this arithmetic in syncPlacement would be a copy that can disagree with the
// one in makeSign, and the disagreement would look like a window drifting off
// its own road.
//
// The frame steps back along the MESH'S OWN NORMAL rather than subtracting from
// z. At a 24-degree turn that offset is mostly z but partly x, and the code this
// replaced set the frame's x to the mesh's x flat -- throwing the x part away.
// It got away with it because what was left is still enough to keep the frame
// behind the picture; it would not have got away with it at a sharper turn.
//
// The post's y is NOT touched: how high a sign stands is decided by its own
// surface's height, once, in makeSign. Moving a window along the road does not
// change how tall it is.
const SIGN_TURN = 0.42
// FROM THE INNER EDGE, not from a fixed centre. Signs are no longer all one
// width, and a centre offset that was right at 300 puts a 600-wide sign across
// its own road. `SIGN_INNER + sw/2` is identical at 300 and correct at any
// width -- the board grows away from the traffic.
//
// ONE FUNCTION, because syncPlacement asks the same question every frame to
// decide whether a mesh is where its address says. That test used to inline
// `laneX + side * SIGN_OFFSET`, a second copy of arithmetic this file already
// warns about copying -- and with a width in it, the copy would answer "not
// where it should be" forever for any sign that is not 300 wide.
function signX(district, side, mesh) {
  const halfW = (mesh?.geometry?.parameters?.width ?? SIGN_W) / 2
  return ws.laneX(district) + side * (SIGN_INNER + halfW)
}

function positionSign(parts, district, side, dash) {
  const { mesh, frame, post } = parts
  mesh.position.x = signX(district, side, mesh)
  mesh.position.z = windowZ(dash)
  mesh.rotation.y = -side * SIGN_TURN
  if (frame) {
    frame.position.copy(mesh.position)
    frame.rotation.copy(mesh.rotation)
    frame.translateZ(-2)
  }
  if (post) {
    post.position.x = mesh.position.x
    post.position.z = mesh.position.z
  }
}

// KEEP EVERY SIGN WHERE ITS ADDRESS SAYS IT IS.
//
// A sign's x is `laneX(district) + side * SIGN_OFFSET`, computed once when the
// window is adopted -- and `laneX` is not a constant. It centres the whole set,
// so adding a workspace moves EVERY existing lane sideways, and assigning a
// number moves two of them. The roads follow (syncRoads reconciles them every
// frame); the windows did not, so they were left hanging over the gap where
// their road used to be.
//
// It reconciles z and the turn as well now, and that is the whole mechanism
// behind moving a window: the move functions below change `district`, `side` and
// `lane` on the RECORD and nothing else. Nobody moves a mesh. The next frame
// notices the position those fields resolve to is not the position the mesh is
// at, and puts it right -- which means a move is correct by the same code path
// that was already keeping every other window honest.
//
// WHAT THIS DOES TO INVARIANT 6. The invariant was "a window's address --
// workspace, milepost, side -- is never recomputed", and it is now narrower and
// more accurate: **nothing moves a window except someone moving it**. Adoption,
// a resize, a new buffer, a remapped surface, a neighbouring workspace being
// created -- none of those may change where a window stands, and none of them
// do. An explicit move does, because that is what it is for.
//
// The x/z test catches a side change on its own: flipping the side moves x by
// 2 * SIGN_OFFSET, so there is no case where the turn is stale and the position
// is not.
// A WINDOW ON ANOTHER NETWORK'S ROAD IS NOT IN THIS WORLD.
//
// `laneX` can only answer for the network it is laying out, and for anything else
// it answers 0 -- which is not a position, it is the absence of one. Left to run,
// this loop would take every window belonging to every other network and stack
// them all down the middle of the middle road. That is the one thing multi-tenancy
// could break that nothing else would notice, because the windows are still alive
// and the compositor is still perfectly happy.
//
// So they are hidden instead, and hiding is the honest answer rather than a
// workaround: the road they stand on is not laid, so there is nowhere for them to
// be. Their ADDRESS is untouched -- district, milepost, side and lane all still
// say exactly where they will stand when that network is selected again -- which
// is invariant 6 doing what it is for. Switching back puts them straight back.
//
// They still have to come OUT of every raycast, and that is not automatic: three
// raycasts a mesh you hand it directly whether or not it is visible. See `aim` and
// `scenePointFromEvent` in travel.js.
function syncPlacement() {
  for (const s of signs.values()) {
    if (!s.mesh) continue
    const here = ws.inActive(s.district)
    for (const part of [s.mesh, s.frame, s.post]) if (part) part.visible = here
    // A window mid-repack has been taken off the grid and has nowhere to be yet.
    // It cannot be seen either -- a frame never runs inside a repack, which is
    // synchronous -- but placing one would resolve its z to NaN and take the mesh
    // out of the scene for good.
    if (!here || !Number.isInteger(s.dash)) continue
    const x = signX(s.district, s.side, s.mesh)
    const z = windowZ(s.dash)
    if (s.mesh.position.x === x && s.mesh.position.z === z) continue
    positionSign(s, s.district, s.side, s.dash)
  }
}

// ------------------------------------------------------------ moving a window
//
// Three moves, because there are three questions you can ask about where a
// window is: which side of the road it is on, how far along that side it is,
// and WHICH ROAD. They are separate operations rather than one `place()` with
// three arguments because they have genuinely different answers to "and where
// exactly?" -- crossing keeps your place, reordering swaps with a neighbour, and
// changing road puts you at the end of the new one.
//
// None of them touch the scene. See syncPlacement.

const signAt = (district, milepost) =>
  [...signs.values()].find((s) => s.mesh && s.district === district && s.milepost === milepost) ?? null

const rowOf = (district, side) =>
  [...signs.values()]
    .filter((s) => s.mesh && s.district === district && s.side === side)
    .sort((a, b) => a.dash - b.dash)

// THE FIRST DASH ON A SIDE WITH ROOM FOR A WINDOW.
//
// FILLING HOLES RATHER THAN APPENDING. A dash is a place, not an address -- unlike
// a milepost there is no harm at all in a later window standing where an earlier
// one did -- and appending past every gap is what turns a road that has been worked
// on into a mile of empty tarmac with the windows at the far end of it.
//
// "Room" is world.js slotFree, which is the same question a ramp asks, against the
// same occupants. That is the whole of what replaced firstFreeLane, takeClearLane,
// freeLaneNear and rampBlocksLane: four functions that each knew a bit of how the
// two grids collided, replaced by one grid where they cannot.
const firstFreeSlot = (district, side, self) => nextFreeSlot(district, side, SLOT_FIRST, 'window', self)

// LAY A WHOLE SIDE OUT AGAIN, in the order given, from the head of the road.
//
// Every member is taken off the grid FIRST -- `dash = null`, which slotFree reads as
// "not standing anywhere yet" -- because a repack in place has each window blocking
// the slot the next one wants, and the row would walk itself down the road one pass
// at a time. It steps by SLOT_GAP and asks for the next free dash rather than
// assuming one, so a ramp part-way down a road is stepped over instead of built on.
function repack(district, side, row, dryRun = false) {
  // WHERE THEY WERE, taken before they are taken off the grid. Comparing against
  // `s.dash` after the clear compares against the null that was just written, so
  // every window counts as moved and "moved: 4" is reported for a road that did not
  // change -- which is the one number this function exists to be believed about.
  const was = new Map(row.map((s) => [s, s.dash]))
  for (const s of row) s.dash = null
  let want = SLOT_FIRST
  let moved = 0
  for (const s of row) {
    const at = nextFreeSlot(district, side, want, 'window', s)
    if (at === null) break
    if (was.get(s) !== at) moved++
    s.dash = at
    want = at + SLOT_GAP
  }
  // A DRY RUN PUTS EVERYTHING BACK. The map has to know whether the tidy would do
  // anything before it offers the button, and the only honest answer is the one this
  // function would give -- a road with a ramp part-way down it has permanent holes
  // that no tidy can close, so "are the dashes a uniform run?" says yes-there-are-gaps
  // forever and the button becomes one you press to find out.
  if (dryRun) for (const s of row) s.dash = was.get(s)
  return moved
}

// Would closing this road up move anything? Runs the real packing and undoes it,
// rather than reimplementing the rule somewhere it could drift from.
export function tidyPreview(district) {
  if (!ws.has(district)) return 0
  let moved = 0
  for (const side of [-1, 1]) moved += repack(district, side, rowOf(district, side), true)
  return moved
}

const placement = (s) =>
  s && { district: s.district, milepost: s.milepost, side: s.side > 0 ? 'right' : 'left', dash: s.dash }

// ACROSS THE ROAD, KEEPING ITS DASH. A window at dash 11 on the left becomes a
// window at dash 11 on the right, directly opposite where it was.
//
// THIS USED TO DRIFT, AND IT WAS A RATCHET. The first version asked "which ordinal
// on the other side stands nearest where I am now?", worked it out from the z, and
// rounded. The two sides were half a MILE out of step, so that question's answer was
// ALWAYS exactly x.5 -- and rounding x.5 always goes the same way. Every crossing
// moved the window half a MILE further from the entrance and crossing back moved it
// another half. Sent one across and back four times and it was 2640 units down the
// road, which is exactly what was reported: they "just kept moving further and
// further back".
//
// The rule that cannot do that is the one with no arithmetic in it: your place is
// yours, the side is what changes. ONE GRID MAKES IT LITERAL -- the two sides share
// the dashes now, so "keep your place" is keeping the same integer rather than
// keeping an ordinal whose meaning differed by side. Crossing is its own inverse by
// construction.
//
// IT MOVES ONE WINDOW. It briefly swapped with whoever held the far slot, on the
// argument that a swap is drift-free. Wrong, and the question that showed it is the
// obvious one: crossing the road is a thing you ask of ONE window, and a control
// that quietly moves a second is one you cannot use without checking what else it
// did. If the opposite slot is occupied it takes the NEAREST free dash on that side
// instead -- a bump, not a ratchet, because no half-step is being rounded, so
// crossing back returns to the dash it came from whenever that dash is still free.
export function flipWindowSide(district, milepost) {
  const s = signAt(district, milepost)
  if (!s) return null
  const side = -s.side
  const dash = nearestFreeSlot(district, side, s.dash, 'window', s)
  if (dash === null) return null
  s.side = side
  s.dash = dash
  return placement(s)
}

// ONE PLACE ALONG THE ROAD. delta < 0 is toward the entrance.
//
// IT USED TO MEAN ONE PLACE ALONG ITS OWN SIDE, and that was almost always
// nothing at all. Windows alternate sides by default, so a road with four
// windows on it is usually two files of two -- and a window alone on its side
// has no same-side neighbour, so both arrows were disabled and the control was
// dead. Reported as nearer and further not working, which is precisely what a
// permanently disabled pair of buttons is.
//
// The sides are separate for SPACING -- that argument still stands and is why
// windowZ takes a side. They are not separate for "where am I in the queue":
// you drive past all of them in one sequence, and that sequence is what moving
// one place along means.
//
// A SWAP OF THE WHOLE PLACE -- side and ordinal together -- so the two windows
// exchange positions exactly and nothing else on the road moves. Crossing the
// road can therefore happen as a side effect of moving along it, which is
// correct: the window in front of you may be on the other side.
export function nudgeWindowAlong(district, milepost, delta) {
  const s = signAt(district, milepost)
  if (!s) return null
  const road = roadOrder(district)
  const i = road.indexOf(s)
  const j = i + Math.sign(delta)
  if (i < 0 || j < 0 || j >= road.length) return null
  const other = road[j]
  const side = s.side
  const dash = s.dash
  s.side = other.side
  s.dash = other.dash
  other.side = side
  other.dash = dash
  return placement(s)
}

// ONTO ANOTHER ROAD ENTIRELY.
//
// This is the one that changes the window's ADDRESS, and it has to: a milepost
// is unique on its road, and the number this window holds may already be in use
// on the destination. So it takes a fresh one there and its old one is retired
// -- mileposts are never reissued, which is exactly what makes retiring one
// safe. Everything keyed by the address has to come along, and there are two
// such things: the remembered zoom, and the shell's idea of which window you are
// standing in.
//
// It takes the FIRST FREE place on its side of the new road, not the end of it.
// There is no "where it already was" to preserve on a road it has never been on,
// so the choice is between the first gap and the far end -- and the far end has
// the same ratchet crossing the road had: send a window to the next workspace
// and back a few times and it walks off down both roads, one MILE per trip,
// through the empty slots it keeps leaving behind. The first gap is stable.
//
// A CLOSED WORKSPACE HAS NO ROAD -- syncRoads lays one per OPEN workspace -- so
// a window moved onto one would stand in the air over nothing. Refusing is the
// truthful answer, the same one a barred lane on the exit gate gives.
export function moveWindowTo(district, milepost, dest) {
  const s = signAt(district, milepost)
  const d = ws.get(dest)
  if (!s || !d || !d.open || dest === district) return null
  const to = ws.takeMilepost(dest)
  const dash = firstFreeSlot(dest, s.side, s)
  if (dash === null) return null
  // Both halves of the address change at once, so the zoom is rekeyed from the
  // old pair before either is overwritten.
  rekeyZoom(district, milepost, dest, to)
  if (state.flatDistrict === district && state.flatMilepost === milepost) {
    state.flatDistrict = dest
    state.flatMilepost = to
  }
  s.district = dest
  s.milepost = to
  s.dash = dash
  return placement(s)
}

// DROPPED ONTO ANOTHER WINDOW ON THE SAME ROAD: take its place.
//
// INSERT, not swap, and this is the one place the two part company. The buttons
// swap because `one place along` names a pair and moving anything else would be
// moving a window nobody mentioned. A drag names a POSITION -- you carried this
// row to that spot in the list and let go -- so the answer has to be that it is
// now at that spot and everything else closed up behind it.
//
// Renumbering the rest is free here in a way it never is for mileposts or lane
// numbers: an ordinal on a side is a PLACE, not an address. Nothing is keyed by
// it, and the list is renumbered 0..n afterwards, so a road cannot grow a gap by
// being rearranged.
//
// Dropping across the two sides crosses the road as well, landing at the target's
// place on the target's side -- which is the same thing the gesture looks like.
export function reorderWindowTo(district, milepost, ontoMilepost) {
  const s = signAt(district, milepost)
  const onto = signAt(district, ontoMilepost)
  if (!s || !onto || s === onto) return null
  const from = s.side
  const side = onto.side
  const row = rowOf(district, side).filter((x) => x !== s)
  const at = row.indexOf(onto)
  if (at < 0) return null
  row.splice(at, 0, s)
  s.side = side
  repack(district, side, row)
  // The side it LEFT closes up too, or crossing the road leaves a hole behind
  // and the next thing to look at that road sees a gap it did not make.
  if (from !== side) repack(district, from, rowOf(district, from))
  return placement(s)
}

// CLOSE THE ROAD UP -- every window on it back to 0, 1, 2 on its own side, in
// the order it already stands in.
//
// A road grows holes honestly: a window closes and its slot stays empty, and one
// or two gaps read as a road you have been working on rather than as a fault.
// They accumulate, though, and a road with the last window a kilometre past the
// first is one you have to drive rather than read. Two things fill it with
// holes -- closing windows, and (until this commit) moving them -- so a road
// could get into that state before there was any way out of it but a restart.
//
// It changes NO addresses. Every window keeps its milepost, its workspace and
// its side; only how far along it stands changes, and the order is preserved
// exactly, so nothing you were looking for is anywhere unexpected afterwards.
export function tidyRoad(district) {
  if (!ws.has(district)) return null
  let moved = 0
  for (const side of [-1, 1]) moved += repack(district, side, rowOf(district, side))
  return { district, moved, left: rowOf(district, -1).length, right: rowOf(district, 1).length }
}

// ARMED IS NOT VISIBLE. The grab is live on the window you are standing in; it
// is only DRAWN when the pointer is near it, because an arrow parked permanently
// beside a window is one more thing between you and looking at the window.
//
// So this decides armed and Travel decides shown -- and handleUnder has to test
// ARMED rather than visible, or the control could only be hit while it was
// already being pointed at, which is a control nobody can ever find.
// The ACTION stays one function for both surfaces (requestCloseWindow); the ASKING
// is per surface, because the map's prompt is two DOM buttons on the row you asked
// from and this one is two quads over the window, and neither could sensibly be the
// other. What must not be duplicated is the closing, and it is not. The unanswered
// question lives in `state.closeAsking` -- see world.js for why it is there and not
// in either module that uses it.
function syncHandles() {
  const flatKey = `${state.flatDistrict}:${state.flatMilepost}`
  // A QUESTION ABOUT A WINDOW YOU ARE NO LONGER IN IS NOT A QUESTION.
  //
  // Leaving is an answer of "no", and it is the same fault the ramp hover had: a
  // state that outlives the thing it was about comes back later attached to
  // whatever is there now. Here that would be a live confirm sitting over a
  // DIFFERENT window, one press from closing it.
  if (state.closeAsking && (state.mode !== 'flat' || state.closeAsking !== flatKey)) state.closeAsking = null
  for (const s of signs.values()) {
    if (!s.handle) continue
    const armed = state.mode === 'flat' && `${s.district}:${s.milepost}` === flatKey
    // The PAD carries armed too, not just the grip. Everything that hit-tests a
    // control raycasts its pad, and reading armed off a different object than
    // the one being aimed at is how a control ends up live in one place and dead
    // in another.
    s.handle.userData.armed = armed
    if (s.grabPad) s.grabPad.userData.armed = armed
    if (!armed) s.handle.visible = false
    // The close control and the name board are armed by the same test, and then
    // they part company on being DRAWN.
    //
    //   `X--` follows the grab exactly: only there when you reach for it. It was
    //   drawn permanently for one build, on the argument that a way out has to
    //   be findable -- and asked for as hover-only, which settles it. The two
    //   corner controls are a matched pair and behaving differently was the odd
    //   thing about them.
    //
    //   The name board is always up, because it is the only one of the three
    //   that SAYS something. A label you have to hover to read is not a label,
    //   and it is also the thing your pointer aims at to find the other two.
    // NOTHING IS ARMED WHILE FULL SCREEN IS ON. The point of full screen is that
    // the shell shows you nothing but the window, and a control that is invisible
    // and still clickable is worse than one you can see -- it is a click into the
    // application that the shell quietly ate. The only way out is the flying ship
    // (dash.js), which is deliberately NOT part of this ledger.
    const chromeOn = armed && !state.full
    for (const o of [s.closeBtn, s.closePad, s.castBtn, s.castPad,
                     s.fullBtn, s.fullPad, s.plate, s.platePad]) {
      if (o) o.userData.armed = chromeOn
    }
    if (s.fullBtn) s.fullBtn.visible = chromeOn
    if (!armed && s.closeBtn) s.closeBtn.visible = false
    // `--&` is drawn on the same test as `X--` and for the same reason: it has
    // to be FINDABLE. Nobody hovers the bottom-left corner of a window to see
    // whether a feature is hiding there.
    // NOT drawn on `armed` any more -- `setCastHot` in travel.js draws it, the
    // same way `-->` is drawn, so it appears only when you reach for it. Armed
    // still decides what the pointer can HIT, which is why the pad above keeps
    // it: a control that could only be hit while already visible is a control
    // nobody can find, and that is the trap syncHandles' own note describes.
    if (!armed && s.castBtn) s.castBtn.visible = false
    // AND "ALWAYS UP" MEANS FROM THE ROAD TOO, which it did not.
    //
    // It was drawn on `armed`, and armed is "you are standing IN this window" --
    // so the one control that says what a window IS could only be read from
    // inside the one window you had already chosen. Every other window on the
    // road was a rectangle of somebody's pixels with no name on it, which is the
    // exact question you are asking while driving past. Asked for, and it is the
    // same argument the board already made against being hover-only, carried one
    // step further out.
    //
    // ARMED IS UNTOUCHED. It still decides what the pointer can HIT -- clicking a
    // window from the road flattens you into it, and a name board that took that
    // click out on the road would put a menu between you and the window instead.
    // Drawn everywhere, pressable where it always was.
    //
    // Windows on another network's road are hidden by clearing `mesh.visible`
    // (syncPlacement), and three does not draw the children of an invisible
    // parent -- so this cannot light up a road you are not looking at.
    // The name board is the one thing drawn from the road as well as from inside,
    // so it answers to `state.full` rather than to `armed`.
    if (s.plate) s.plate.visible = !state.full
    // A STEP CONTROL IS ARMED ONLY IF THERE IS SOMEWHERE TO STEP TO. At the ends
    // of a road one of them points at nothing, and a control that is drawn and
    // then does nothing is worse than one that is not there -- you press it
    // twice before deciding the feature is broken.
    if (s.prevBtn) {
      const road = armed ? roadOrder(s.district) : []
      const i = road.indexOf(s)
      for (const [o, p, ok] of [
        [s.prevBtn, s.prevPad, i > 0],
        [s.nextBtn, s.nextPad, i >= 0 && i < road.length - 1],
      ]) {
        const live = armed && ok
        o.userData.armed = live
        p.userData.armed = live
        if (!live) o.visible = false
      }
    }
    // THE ANSWERS ARE DRAWN AND ARMED TOGETHER, which is the opposite of every
    // other control on the window and is the point of them. The grab and the step
    // arrows are live before they are drawn, because they answer a pointer that has
    // gone looking for them; these two answer a question the shell asked, so being
    // aimable while invisible would mean a click in empty space could close a
    // window.
    if (s.keepBtn) {
      const asking = armed && state.closeAsking === flatKey
      for (const [o, p] of [
        [s.keepBtn, s.keepPad],
        [s.shutBtn, s.shutPad],
      ]) {
        o.visible = asking
        o.userData.armed = asking
        p.userData.armed = asking
      }
    }
  }
}

// WHAT THE NAME BOARD SAYS, kept up with what the client calls itself.
//
// A title arrives whenever the client feels like sending one -- at map time,
// after a document loads, on every keystroke in some editors -- so the string is
// checked every frame and the TEXTURE is rebuilt only when it has actually
// changed. That is the same discipline the gantry panels keep, and for the same
// reason: redrawing a canvas per frame per window is the one way a name board
// could cost anything.
//
// A window with no title yet says what it is rather than nothing. Plenty of
// clients never set one at all.
function syncTitles() {
  for (const s of signs.values()) {
    if (!s.plate) continue
    // AND WHILE A CLOSE IS BEING ASKED ABOUT, THE BOARD ASKS IT. The board is the
    // one part of the chrome whose job is words, it is always drawn, and it names
    // the window -- so putting the question anywhere else would mean printing the
    // window's name twice to say which one is about to go.
    const want = state.closeAsking === `${s.district}:${s.milepost}` ? `close ${labelOf(s)}?` : labelOf(s)
    if (s.plateText === want) continue
    s.plateText = want
    s.plate.material.map?.dispose()
    s.plate.material.map = plateTexture(want, s.plateW)
    s.plate.material.needsUpdate = true
  }
}

// WHAT A WINDOW IS CALLED: yours if you have named it, the client's otherwise,
// and something rather than nothing if neither. One function, so the board, the
// map's list and the map's window page cannot disagree about it.
export function nameOf(sign) {
  const k = sign?.mesh?.userData?.signKey ?? ''
  return renames.get(k) || titles.get(k) || 'untitled window'
}

// AND HOW IT IS WRITTEN: in round brackets, every time it is SHOWN.
//
// `mail` could be an application, a road, a network or a file. `(mail)` is a
// window -- the same job the shell already gives `--road-->` for a road and
// `[network]` for a network, and the one noun in that vocabulary that had no
// mark of its own. Brackets rather than a colour so it survives being read out,
// written down, or printed on a canvas that has one fill colour.
//
// SEPARATE FROM `nameOf` ON PURPOSE. `nameOf` is the window's NAME -- what the
// rename box is holding, what a report prints, what gets compared. If the
// brackets lived there they would come back round through the rename box and be
// saved into the name itself, and the next pass would say `((mail))`.
export const labelOf = (sign) => `(${nameOf(sign)})`

// NAME IT YOURSELF, and clearing the name falls back to the client's.
//
// Keyed by the SURFACE, not by the address, so it survives every move -- a
// window you named does not lose its name by crossing the road or changing
// workspace, which is the one thing that would make naming useless.
export function renameWindow(district, milepost, name) {
  const s = signAt(district, milepost)
  const k = s?.mesh?.userData?.signKey
  if (!k) return null
  const clean = String(name ?? '').trim().slice(0, 40)
  if (clean) renames.set(k, clean)
  else renames.delete(k)
  return { district, milepost, name: nameOf(s), mine: !!clean }
}

// ASK THE CLIENT TO CLOSE. Not "destroy the surface" -- that is the compositor
// pulling a window out from under a program that may have unsaved work in it.
// `requestClose` is xdg_toplevel.close, which is the polite request every window
// manager sends, and a client is allowed to put up a dialog instead of going.
//
// BY SHAPE, NOT BY CLASS NAME, for the reason startResize states: minification
// renames constructors and every check keyed on one was dead in the shipped
// bundle. `requestClose` is a method name and survives.
//
// So this returns "asked", never "closed". The window goes away when its surface
// is destroyed, which adoptPending notices on a later frame -- and if you were
// standing in it, that is the path that already releases you.
export function requestCloseWindow(district, milepost) {
  const s = signAt(district, milepost)
  const role = s?.view?.surface?.role
  if (typeof role?.requestClose !== 'function') return null
  role.requestClose()
  return { district, milepost, asked: true }
}

// ASKING IS NOT RESIZING, AND ONE ASK IS NOT ENOUGH.
//
// `configureSize` is a request. The client acks it and reallocates in its own time,
// Greenfield DROPS a queued configure that a newer one supersedes, and a client that
// is still starting up may do nothing with the first one at all -- which is the
// state every window is in at exactly the moment this runs. A single fire-and-forget
// ask would restore the shape on a client that happened to be ready and silently
// not on one that was not, which is the worst of the two possible behaviours because
// it looks like the feature working intermittently.
//
// So it is re-asked at a rate a client can absorb until the surface is OBSERVED to
// be the size, or until a deadline decides the client is refusing rather than
// lagging. That is the same discipline, the same cadence and the same reasoning as
// the resize drag's own settle loop (travel.js holdFlatScale) -- and a client with a
// minimum size larger than the remembered one is refusing legitimately, so the
// deadline has to exist or this would ask forever.
//
// The record is dropped either way. A window whose client will not take the size is
// left at whatever it chose, and the shape stays remembered for the next one to
// arrive at that address -- forgetting it here would let one stubborn client erase
// a decision that was never about it.
const RESTORE_EVERY = 220
const RESTORE_FOR = 6000
const restoring = new Map()

function askForRememberedSize(k, view, district, milepost, size) {
  // A REMEMBERED SIZE, AND ONLY A REMEMBERED SIZE.
  //
  // A canonical size for every fresh window was tried here and TAKEN BACK OUT,
  // because it made static clients render black. Kept as a comment rather than
  // deleted, because the size is still wanted and the reason it cannot be asked
  // for yet is the interesting part:
  //
  //   `adoptSurfaceTexture` allocates a NEW, EMPTY render target every time a
  //   sign is built, and a sign is rebuilt when its surface changes size. The
  //   rebuild is triggered BY the new size -- which the shell only learns from
  //   the commit that has already rendered into the OLD target. So every resize
  //   loses exactly one frame. A client that animates repaints immediately and
  //   nobody notices; a static one -- a dialog, a "restore session" prompt --
  //   has already painted its only frame, and its board stays black for good.
  //
  // CORRECTED 2026-08-14, and the correction matters because the fix named below
  // CANNOT BE BUILT AS WRITTEN. The render target is new but its texture is not:
  // `setRenderTargetTextures` attaches Greenfield's own GL texture, and
  // Greenfield never allocates a second one. `YUVA2RGBA.convertYUVAArrayBufferInto`
  // does, in one pass and in this order (YUVA2RGBA.js:32-37):
  //
  //     renderState.size = frameSize                                  // the shell's trigger
  //     if (!sizeEquals(renderState.texture.size, opaque.codedSize))
  //       renderState.texture.setContentBuffer(null, opaque.codedSize) // texImage2D(null)
  //     ...then it draws the new frame into it
  //
  // So the old picture is discarded by `texImage2D(null)` and the new one written
  // BEFORE `rs.size` is observable to `adoptPending` on the next shell frame.
  // At rebuild time there is nothing left to carry: the "old target" and the new
  // one are the same texture, and it already holds the new frame. Anything that
  // wants the previous picture has to snapshot it BEFORE the pass runs, and
  // `fenceScenePasses` in shell.js is the only place that sees "about to run".
  //
  // Which also means a resized window should not be black at all -- and the
  // black one photographed on the image is explained by the uv corner instead
  // (see `DIAG` in adoptSurfaceTexture: the black band IS padX).
  //
  // Measured on the image: a Firefox "Restore Session" dialog took the canonical
  // 960x600, its sign was correctly 300x187.5, and the glass was empty. Windows
  // that REFUSED the size (Firefox's main window at 1212x546) were never rebuilt
  // and rendered perfectly -- which is the tell, and the wrong way round.
  //
  // The resize path has always had this hole; asking at adoption is what made
  // every window walk into it. Carrying the old picture into the new target is
  // the fix, and it belongs to the resize path, not here.
  const want = layout.sizeOf(district, milepost)
  if (!want) return false
  if (size && size.width === want.w && size.height === want.h) return false
  const role = view?.surface?.role
  // BY SHAPE, NOT BY CLASS NAME -- minification renames constructors and every
  // check keyed on one was dead in the shipped bundle. Same test startResize makes.
  if (typeof role?.configureSize !== 'function') return false
  role.configureSize({ width: want.w, height: want.h })
  restoring.set(k, { w: want.w, h: want.h, sentAt: performance.now(), until: performance.now() + RESTORE_FOR })
  return true
}

function restoreSizes() {
  if (!restoring.size) return
  const now = performance.now()
  for (const [k, job] of [...restoring]) {
    const s = signs.get(k)
    // Arrived, gone, or out of time. A surface that was destroyed mid-restore takes
    // its job with it rather than leaving one that can never finish.
    if (!s || !s.size || (s.size.width === job.w && s.size.height === job.h) || now > job.until) {
      restoring.delete(k)
      continue
    }
    if (now - job.sentAt < RESTORE_EVERY) continue
    job.sentAt = now
    s.view?.surface?.role?.configureSize?.({ width: job.w, height: job.h })
  }
}

// What the shell is holding, and what it is in the middle of asking for. Read off
// the store and the live jobs rather than recomputed, so "it remembered" and "it
// actually put it back" are two separate answers -- a size that is remembered and
// refused must not report as a size that was restored.
export const layoutReport = () => ({
  remembered: layout.report(),
  restoring: [...restoring].map(([k, j]) => ({ at: k, want: [j.w, j.h], got: signs.get(k)?.size ?? null })),
  live: [...signs.values()]
    .filter((s) => s.size)
    .map((s) => ({ at: `${s.district}:${s.milepost}`, size: [s.size.width, s.size.height] })),
})

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
      // A SIZE CHANGE OR A WINDOW-RECT CHANGE. The second one matters on its own:
      // a client may commit its first buffer and only then call
      // set_window_geometry, which moves the picture inside a buffer whose size
      // never changed. Comparing sizes alone leaves that sign showing the shadow
      // for the rest of its life.
      const nextCrop = rs ? windowRectOf(view.surface, rs.size) : null
      const cropMoved = JSON.stringify(nextCrop) !== JSON.stringify(existing.crop ?? null)
      // THE FIRST DECODE ARRIVES AFTER THE FIRST SIGN. Adoption needs a buffer,
      // not a decoded frame, so a sign is routinely built before anything knows
      // the destination texture is padded. Without this the padding stays on the
      // glass for the life of the window.
      //
      // KEYED ON THE DESTINATION TEXTURE, not on `__codedSize`, because that is
      // what `adoptSurfaceTexture` now divides by. Watching the decoder's number
      // while the UVs depend on the texture's is watching the wrong dial: the two
      // were measured 1024x642 and 1024x640 on the same frame, so one can move
      // while the other does not.
      const nextCoded = rs?.texture?.size
        ? { w: rs.texture.size.width, h: rs.texture.size.height }
        : null
      const codedMoved = JSON.stringify(nextCoded) !== JSON.stringify(existing.coded ?? null)
      if (rs && (rs.size.width !== existing.size.width || rs.size.height !== existing.size.height || cropMoved || codedMoved)) {
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
        const rebuilt = makeSign(view, existing.milepost, existing.district, existing.side, existing.dash)
        if (rebuilt) {
          dropSign(k)
          signs.set(k, {
            milepost: existing.milepost,
            district: existing.district,
            slot: existing.slot,
            side: existing.side,
            dash: existing.dash,
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
    // WHERE it goes is claimed at ADOPTION, the same moment and for the same
    // reason the district is: the surface does not exist when the click happens,
    // so the request has to wait here for it. The queue carries a DASH as well as
    // a side now, because a window can be asked for at a particular marker -- the
    // same request, on the same grid, that builds a ramp.
    const want = existing ? null : (sideQueue.shift() ?? null)
    const side = existing?.side ?? want?.side ?? (milepost % 2 === 0 ? 1 : -1)
    // The place on that side, taken once and never recomputed -- invariant 6
    // covers this for the same reason it covers the milepost. A dash that was
    // asked for and has since been taken falls back to the first that is free
    // rather than refusing: the surface is already here, and a window that does
    // not appear because its slot was claimed while it was starting is a window
    // that reads as a launch that failed.
    const asked = Number.isInteger(want?.dash) && slotFree(district, side, want.dash, 'window')
    const dash = existing?.dash ?? (asked ? want.dash : firstFreeSlot(district, side, null))
    placeInLedger(view, slot)
    const built = makeSign(view, milepost, district, side, dash)
    // The view is kept so input can be mapped back into the flat output. It is
    // re-read every frame rather than cached at build time: a view object is
    // replaced when a surface is remapped.
    signs.set(
      k,
      built
        ? { milepost, district, slot, side, dash, view, ...built }
        : { milepost, district, slot, side, dash, view },
    )
    if (built) built.mesh.userData.signKey = k
    // PUT IT BACK THE SHAPE IT WAS. A window that arrives at an address the shell
    // has a remembered size for is asked for that size the moment it is adopted --
    // which is the only moment it can be, because until a surface has a buffer
    // there is nothing to configure and no sign to hang the request on.
    askForRememberedSize(k, view, district, milepost, built?.size)
    // AND GO AND LOOK AT IT. Only for a window that has actually been built --
    // a record with no mesh has nowhere to fly to yet, and adoptPending will be
    // back next frame.
    if (built) hooks.arrived?.(district, milepost)
  }
  restoreSizes()
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
  // EVERY control the sign owns, and the list is the thing that goes stale. The
  // cast pair was added and not added here, which is a texture and two geometries
  // left behind on every window that closes -- invisible until a soak.
  for (const o of [s.handle, s.grabPad, s.closeBtn, s.closePad, s.castBtn, s.castPad,
                   s.fullBtn, s.fullPad, s.plate, s.platePad, s.prevBtn, s.prevPad,
                   s.nextBtn, s.nextPad, s.keepBtn, s.keepPad, s.shutBtn, s.shutPad]) {
    if (!o) continue
    o.geometry.dispose()
    o.material.dispose()
  }
  // The name board's texture is NOT shared -- there is one per window and it is
  // rebuilt whenever the title changes -- so unlike the grab's it has to go.
  s.plate?.material?.map?.dispose()
  if (forget) {
    signs.delete(k)
    renames.delete(k)
    // Only when the surface is really gone. A sign dropped to be REBUILT (a
    // resize) keeps its key, and forgetting the title there would blank the name
    // board on every configure of a drag.
    titles.delete(k)
  }
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
      // A POPUP DRAWS ITS OWN SHADOW TOO, and this was the one surface that never
      // got told. `windowRectOf` exists because a client paints a shadow into its
      // buffer and names the real rectangle with `set_window_geometry`; the
      // unpainted margin arrives as OPAQUE BLACK once the encoder has been
      // through it. That fix was wired into `makeSign` and not into here, so
      // every menu carried its own shadow as a black L down the left and along
      // the top -- photographed on mousepad's Edit menu, and it is the same
      // 26x23 inset this file already measured on mousepad's toplevel.
      //
      // THE CROP IS THREE CHANGES, NOT ONE, because a cropped quad is a different
      // size AND a different origin: the texture has to be sampled through it,
      // the quad has to be scaled to it, and the popup's offset from its parent
      // has to be measured between the two VISIBLE origins rather than between
      // two buffer origins. Doing only the first would sample the menu correctly
      // and then hang it in the wrong place, which is harder to see and worse.
      const crop = windowRectOf(view.surface, rs.size)
      const size = { w: crop ? crop.w : rs.size.width, h: crop ? crop.h : rs.size.height }
      // WHAT THE UVs WERE COMPUTED FROM, so a rebuild happens when any of it
      // moves. The coded size is in here for the same reason `adoptPending`
      // carries it: the first decode lands AFTER the first quad, so a popup
      // adopted before it would keep the padding on the glass for its whole life
      // -- and a menu is short-lived enough that "its whole life" is all of it.
      const rebuildKey = [
        crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : '-',
        rs.texture?.size ? `${rs.texture.size.width}x${rs.texture.size.height}` : '-',
      ].join('|')
      if (q && (q.size.w !== size.w || q.size.h !== size.h || q.rebuildKey !== rebuildKey)) {
        sign.mesh.remove(q.mesh)
        q.rt.dispose()
        sign.popups.delete(pk)
        q = undefined
      }
      if (!q) {
        const { rt, tex } = adoptSurfaceTexture(rs, crop)
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
        )
        // A child of the sign, so it inherits the sign's pose for free and
        // stays glued to the window through the flatten.
        mesh.userData.popupView = view
        sign.mesh.add(mesh)
        q = { mesh, rt, size, rebuildKey }
        sign.popups.set(pk, q)
        state.popupQuads++
      }
      const g = sign.mesh.geometry.parameters
      // EVERY LENGTH HERE IS IN THE PARENT'S VISIBLE PIXELS, NOT ITS BUFFER'S.
      // `makeSign` builds the parent's plane from its CROP (`sw = crop.w * ...`)
      // but records `size` as the buffer, so `g.width / sign.size.width` was the
      // world scale divided by the wrong number -- off by exactly the ratio the
      // shadow takes up, which put every menu on a window with decorations
      // slightly too small and slightly off-centre. Same reason the centring term
      // below is the parent's crop and not its buffer.
      const pcrop = sign.crop
      const parentW = pcrop ? pcrop.w : sign.size.width
      const parentH = pcrop ? pcrop.h : sign.size.height
      const scale = g.width / parentW
      const pr = view.regionRect
      const sr = sign.view.regionRect
      // Buffer origin PLUS the crop, on both sides: the offset that matters is
      // between the two pictures, and each buffer's picture starts at its own
      // crop. With no crop anywhere this is the old arithmetic exactly.
      const dx = pr.x0 + (crop ? crop.x : 0) - (sr.x0 + (pcrop ? pcrop.x : 0))
      const dy = pr.y0 + (crop ? crop.y : 0) - (sr.y0 + (pcrop ? pcrop.y : 0))
      q.mesh.scale.set(size.w * scale, size.h * scale, 1)
      q.mesh.position.set(
        (dx + size.w / 2 - parentW / 2) * scale,
        -(dy + size.h / 2 - parentH / 2) * scale,
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
  syncPlacement,
  syncHandles,
  syncTitles,
  dropSign,
  isSurface,
  isPopupRole,
  checkPopupsMapped,
  popupsByParentKey,
  syncPopups,
  placeInLedger,
}
