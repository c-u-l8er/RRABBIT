// menu-shm -- a Wayland client that exists to open a REAL xdg_popup.
//
// Spec §7 named popups as the thing with no known answer: "a popup is placed
// relative to a rectangle on its parent surface, and on a receding, curved
// billboard there is no such rectangle." Nothing in this project had ever
// produced one -- simple-shm draws a toplevel and stops, and every native app
// is blocked behind §13 -- so the problem could not even be looked at.
//
// This client draws a toplevel with a visible "menu bar" strip, then opens an
// xdg_popup anchored to that strip, with a real XdgPositioner. It reopens the
// popup on a timer so the compositor side can be watched through map/unmap
// rather than a single lucky frame.
//
// Written from scratch rather than forked from simple-shm: this needs to be
// obvious, not general.

import {
  connect,
  Display as WlDisplay,
  WlBufferProxy,
  WlCompositorProtocolName,
  WlCompositorProxy,
  WlRegistryEvents,
  WlRegistryProxy,
  WlShmFormat,
  WlShmProtocolName,
  WlShmProxy,
  WlSurfaceProxy,
  XdgPopupProxy,
  XdgPositionerProxy,
  XdgSurfaceProxy,
  XdgToplevelProxy,
  XdgWmBaseProxy,
  XdgWmBaseProtocolName,
} from '@gfld/client-protocol'

const W = 250
const H = 250
// The strip the popup is anchored to, in surface coordinates. The compositor
// gets these numbers through the positioner, so they are the ground truth the
// shell has to honour.
const BAR = { x: 12, y: 12, width: 120, height: 26 }
const POPUP_W = 130
const POPUP_H = 96

let display: WlDisplay
let compositor: WlCompositorProxy
let shm: WlShmProxy
let wmBase: XdgWmBaseProxy

function paint(rgba: Uint8Array, w: number, h: number, fill: (x: number, y: number) => number[]) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b] = fill(x, y)
      rgba[i] = b // xrgb8888 little-endian: B,G,R,X
      rgba[i + 1] = g
      rgba[i + 2] = r
      rgba[i + 3] = 255
    }
  }
}

function makeBuffer(w: number, h: number, fill: (x: number, y: number) => number[]): WlBufferProxy {
  const stride = w * 4
  const size = stride * h
  const data = new Uint8Array(new SharedArrayBuffer(size))
  paint(data, w, h, fill)
  const pool = shm.createPool(data, size)
  const buffer = pool.createBuffer(0, w, h, stride, WlShmFormat._xrgb8888)
  pool.destroy()
  return buffer
}

// --- the toplevel

let surface: WlSurfaceProxy
let xdgSurface: XdgSurfaceProxy
let toplevel: XdgToplevelProxy
let mapped = false

function drawToplevel() {
  const buf = makeBuffer(W, H, (x, y) => {
    const inBar = x >= BAR.x && x < BAR.x + BAR.width && y >= BAR.y && y < BAR.y + BAR.height
    if (inBar) return [242, 193, 78] // the amber strip the popup hangs off
    // A recognisable, VERTICALLY ASYMMETRIC field, so "which way up" is
    // answerable by looking -- simple-shm's concentric circles were not
    // (spec §11.2).
    return y < H / 2 ? [45, 226, 230] : [26, 31, 44]
  })
  surface.attach(buf, 0, 0)
  surface.damage(0, 0, W, H)
  surface.commit()
}

// --- the popup

let popupSurface: WlSurfaceProxy | undefined
let popupXdg: XdgSurfaceProxy | undefined
let popup: XdgPopupProxy | undefined

function openPopup() {
  if (popup) return
  const positioner: XdgPositionerProxy = wmBase.createPositioner()
  positioner.setSize(POPUP_W, POPUP_H)
  positioner.setAnchorRect(BAR.x, BAR.y, BAR.width, BAR.height)
  // anchor = bottom (8), gravity = bottom_right (8-ish per protocol enum); the
  // exact constants matter less than that the compositor computes a position
  // for us -- the shell must not be inventing one.
  positioner.setAnchor(8)
  positioner.setGravity(8)

  popupSurface = compositor.createSurface()
  popupXdg = wmBase.getXdgSurface(popupSurface)
  popupXdg.listener = {
    configure: (serial: number) => {
      ;(window as any).__menuState = 'popup-configured'
      popupXdg!.ackConfigure(serial)
      const buf = makeBuffer(POPUP_W, POPUP_H, (x, y) => {
        if (x < 2 || y < 2 || x >= POPUP_W - 2 || y >= POPUP_H - 2) return [255, 90, 60] // border
        const row = Math.floor((y - 2) / 30)
        return row % 2 === 0 ? [243, 234, 212] : [200, 134, 42]
      })
      popupSurface!.attach(buf, 0, 0)
      popupSurface!.damage(0, 0, POPUP_W, POPUP_H)
      popupSurface!.commit()
      ;(window as any).__menuState = 'popup-drawn'
    },
  }

  popup = popupXdg.getPopup(xdgSurface, positioner)
  popup.listener = {
    configure: () => {
      /* position comes from the positioner; nothing to do */
    },
    popupDone: () => closePopup(),
    repositioned: () => {
      /* noop */
    },
  } as any
  // No grab: a grabbed popup is dismissed by the compositor on any outside
  // click, which would make it impossible to photograph. This is a popup that
  // stays until we close it.
  popupSurface.commit()
  positioner.destroy()
  ;(window as any).__menuState = 'popup-open'
}

function closePopup() {
  popup?.destroy()
  popupXdg?.destroy()
  popupSurface?.destroy()
  popup = undefined
  popupXdg = undefined
  popupSurface = undefined
  ;(window as any).__menuState = 'popup-closed'
}

// Exposed so a test can drive the popup deterministically rather than waiting
// for a timer to line up with a screenshot.
;(window as any).__openMenu = () => openPopup()
;(window as any).__closeMenu = () => closePopup()

async function main() {
  display = await connect()
  const registry: WlRegistryProxy = display.getRegistry()
  const globals: WlRegistryEvents = {
    global(name: number, interface_: string, version: number) {
      if (interface_ === WlCompositorProtocolName) {
        compositor = registry.bind(name, WlCompositorProtocolName, WlCompositorProxy, 1)
      } else if (interface_ === WlShmProtocolName) {
        shm = registry.bind(name, WlShmProtocolName, WlShmProxy, 1)
        shm.listener = { format: () => {} }
      } else if (interface_ === XdgWmBaseProtocolName) {
        wmBase = registry.bind(name, XdgWmBaseProtocolName, XdgWmBaseProxy, 1)
        wmBase.listener = { ping: (serial: number) => wmBase.pong(serial) }
      }
    },
    globalRemove() {},
  }
  registry.listener = globals
  await display.roundtrip()

  surface = compositor.createSurface()
  xdgSurface = wmBase.getXdgSurface(surface)
  xdgSurface.listener = {
    configure: (serial: number) => {
      xdgSurface.ackConfigure(serial)
      drawToplevel()
      if (!mapped) {
        mapped = true
        ;(window as any).__menuState = 'mapped'
        // Open once on its own so a plain load shows the case, then leave it
        // to __openMenu/__closeMenu.
        setTimeout(() => openPopup(), 1500)
      }
    },
  }
  toplevel = xdgSurface.getToplevel()
  toplevel.listener = { configure: () => {}, close: () => {} } as any
  toplevel.setTitle('menu-shm')
  toplevel.setAppId('rrabbit.menu-shm')
  surface.commit()
  ;(window as any).__menuState = 'started'
}

main()
