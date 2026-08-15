// ONE CANVAS AND ONE TEXTURE FOR EVERY CARD ON EVERY ROAD.
//
// THE COST THIS EXISTS TO KILL. A pane used to allocate its own 640x420 canvas in
// `build()` -- ~1.07 MB of backing store -- whether or not it would ever be read.
// A thousand panes was therefore a gigabyte of canvas before a single frame was
// drawn, and the card tier, whose entire purpose is to be the cheap one, was
// paying the expensive tier's price.
//
// Two changes together fix it, and only the pair is enough:
//
//   1. the paint canvas is allocated ON DEMAND and released on downgrade
//      (`paper.js` ensurePaint/releasePaint) -- so a far pane never holds one;
//   2. cards live in a SHARED atlas -- one canvas, one texture, one material for
//      up to 96 of them, at 256x160 each.
//
// The byte saving is ~11x. The saving that actually shows up in a frame is the
// other one: N cards used to be N distinct `THREE.Texture` objects and N
// materials, which is N GPU uploads and N material-state changes. They are now
// one of each, and the per-pane cost is a geometry with the atlas rect baked into
// its UVs.
//
// PAGES GROW, AND NOTHING SHRINKS THEM. A freed cell returns to its page's free
// list and is reused; a page that empties completely is kept. Releasing GPU
// textures on a heuristic is how you get a stutter that only happens after you
// drive somewhere twice, and the memory is bounded by the high-water mark of
// cards ever shown at once, which is bounded by the road.

import * as THREE from 'three'
import { canvasTexture } from '../world.js'

const PAGE = 2048
export const CARD_W = 256
export const CARD_H = 160
const COLS = Math.floor(PAGE / CARD_W) // 8
const ROWS = Math.floor(PAGE / CARD_H) // 12
export const PER_PAGE = COLS * ROWS // 96

const pages = []

function addPage() {
  const canvas = document.createElement('canvas')
  canvas.width = PAGE
  canvas.height = PAGE
  const ctx = canvas.getContext('2d')
  // Cleared to the road's background rather than left transparent: an unallocated
  // cell that is transparent shows whatever the material's blending decides,
  // which at a distance reads as a flickering hole rather than as an empty slot.
  ctx.fillStyle = '#03040a'
  ctx.fillRect(0, 0, PAGE, PAGE)

  const tex = canvasTexture(THREE, canvas)
  const material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
  const p = { canvas, ctx, tex, material, free: [], next: 0, used: 0 }
  pages.push(p)
  return p
}

// A cell, or null if this page is full. `uv` is the rect in 0..1 with V FLIPPED --
// three's UV origin is bottom-left and a canvas's is top-left, so a cell drawn at
// canvas row 0 is the TOP of the texture and must map to v near 1. Getting this
// backwards does not fail; it silently shows the wrong card, which is the kind of
// bug that gets blamed on the allocator.
function take(p) {
  let i
  if (p.free.length) i = p.free.pop()
  else if (p.next < PER_PAGE) i = p.next++
  else return null
  p.used++
  const col = i % COLS
  const row = Math.floor(i / COLS)
  const x = col * CARD_W
  const y = row * CARD_H
  return {
    page: p, index: i, x, y, w: CARD_W, h: CARD_H,
    material: p.material,
    uv: {
      u0: x / PAGE,
      u1: (x + CARD_W) / PAGE,
      v0: 1 - (y + CARD_H) / PAGE,
      v1: 1 - y / PAGE,
    },
  }
}

export function allocCard() {
  for (const p of pages) {
    const c = take(p)
    if (c) return c
  }
  return take(addPage())
}

export function freeCard(cell) {
  if (!cell?.page) return false
  // Wiped on release, not on reuse. A cell that keeps its old picture until
  // something overwrites it will show the previous document for exactly as long
  // as it takes somebody to notice, and "the wrong title on a far pane" is very
  // hard to trace back to an allocator.
  cell.page.ctx.fillStyle = '#03040a'
  cell.page.ctx.fillRect(cell.x, cell.y, cell.w, cell.h)
  cell.page.tex.needsUpdate = true
  cell.page.free.push(cell.index)
  cell.page.used--
  return true
}

// Draw into a cell. The callback gets a context already translated and clipped to
// the cell, so a painter cannot scribble into its neighbours -- which it otherwise
// would, since `paintCard` draws from (0,0) like every other painter.
export function drawCard(cell, fn) {
  const ctx = cell.page.ctx
  ctx.save()
  ctx.beginPath()
  ctx.rect(cell.x, cell.y, cell.w, cell.h)
  ctx.clip()
  ctx.translate(cell.x, cell.y)
  fn(ctx, cell.w, cell.h)
  ctx.restore()
  cell.page.tex.needsUpdate = true
}

// Bake an atlas rect into a plane's UVs. The geometry is per-pane; the material
// and texture are not, which is the whole point.
export function planeFor(THREE_, w, h, uv) {
  const g = new THREE_.PlaneGeometry(w, h)
  const a = g.attributes.uv
  for (let i = 0; i < a.count; i++) {
    a.setXY(i, uv.u0 + a.getX(i) * (uv.u1 - uv.u0), uv.v0 + a.getY(i) * (uv.v1 - uv.v0))
  }
  a.needsUpdate = true
  return g
}

export const atlasReport = () => ({
  pages: pages.length,
  perPage: PER_PAGE,
  used: pages.reduce((n, p) => n + p.used, 0),
  capacity: pages.length * PER_PAGE,
  // The number that matters for the claim in the header: one texture and one
  // material per PAGE, not per card.
  textures: pages.length,
  materials: pages.length,
  bytes: pages.length * PAGE * PAGE * 4,
})
