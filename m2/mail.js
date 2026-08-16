// THE MAILBOX ON THE VERGE -- the shell half of the driverside mailbox.
//
// `mail/box.js` is the world (pure, node-tested, no THREE and no DOM). This file
// is the road: a small box on a post that carries an unread badge, a panel you
// page through, and the six ops that are the only way either of them changes
// anything.
//
// WHY THE BOX STANDS BESIDE THE ROAD AND NOT IN IT, and it is not a layout
// preference. WRL's `Mailbox` is the only role with NO PORTS at all
// (`paper/wrl-core.js` PORTS: `Mailbox: { out: [], in: [] }`), and Core 0.2.1 §19.5
// freezes the consequence -- it cannot participate in `--`, and no other role may
// terminate a `~~`. A pane stands IN the road because a Relay takes a wire in and
// passes one out; a mailbox can only ever hang OFF a chain. The picture and the
// algebra agree, which is the reason to trust the picture.
//
// NOT IN THE SEALED ROAD ID, TODAY. The vendored spine is Core **0.1.2**, where
// Mailbox is in `UNWRITABLE_ROLE_IDS` -- "the parser refuses to read them and
// `formatCore` refuses to WRITE them". `WRL/wrl.js` upstream is byte-identical, so
// this is a version lag rather than local drift. `paper/wiring.js` is therefore
// UNTOUCHED and every road seals to exactly the id it sealed to before this
// feature existed (`test/wiring.mjs` still passes unchanged, which is the proof).
// `test/mail.mjs` §0 pins the refusal; when the spine is re-copied from an updated
// upstream, that test fails and the failure is the instruction to wire the
// doorbell in.
//
// Same posture `m2/publish.js` took with the provisional `track-` prefix: ship the
// thing, write down which identity question is open, do not quietly answer it.

import * as THREE from 'three'
import { canvasTexture, mailboxes, dashZ, slotFree, nextFreeSlot, state, hooks } from './world.js'
import * as ws from './workspaces.js'
import { register as registerOp, apply as applyOp } from './ops.js'
import * as M from './mail/box.js'

let scene = null

// ---- geometry ----------------------------------------------------------------

// The same verge line the panes stand on. Everything on a side of this road
// stands at one x; the slot algebra keeps them SLOT_GAP dashes apart in z, so
// sharing the line costs nothing and a second verge would read as two rows of
// furniture where there is one.
const STAND_X = 190
const ROAD_Y = -30
const POST_H = 62

// 96 x 48 against a 256 x 128 canvas. THE RATIO IS NOT FREE: the canvas must be
// power-of-two or WebGL1 refuses mipmaps (the gate board documents this at
// 1024x256), and any quad whose ratio differs from its canvas stretches the
// glyphs. Both numbers move together or neither moves.
const BOX_W = 96
const BOX_H = 48
const CANVAS_W = 256
const CANVAS_H = 128

// The angle every sign on this road stands at. `rrabbit.js` calls it SIGN_TURN and
// does not export it; `paper.js` spells the literal for its panes. Spelled here
// too rather than invented, because the one thing this must not be is a fourth
// occupant standing at its own angle.
const SIGN_TURN = 0.42

// Shared across every box, because N copies of one shape is N geometries for one
// shape -- the same argument paper.js makes for its post and frame.
let boxGeo = null
let postGeo = null
let postMat = null

function ensureShared() {
  if (boxGeo) return
  boxGeo = new THREE.PlaneGeometry(BOX_W, BOX_H)
  postGeo = new THREE.BoxGeometry(5, POST_H, 5)
  postMat = new THREE.MeshStandardMaterial({ color: 0x2a3142, roughness: 0.8 })
}

// ---- the store -----------------------------------------------------------------

let mail = M.emptyState()

// Loaded and saved like the tracks store, and BELIEVED EXACTLY AS MUCH -- `parse`
// re-validates every row and returns what it dropped, so a store a previous build
// or a parallel session wrote cannot crash a frame loop.
let lastDropped = []

export function loadMail(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(M.STORE_KEY)
    if (!raw) { mail = M.emptyState(); lastDropped = []; return { ok: true, fresh: true } }
    const { state: s, dropped } = M.parse(raw)
    mail = s
    lastDropped = dropped
    // Reported rather than swallowed: a store that silently loses half its rows
    // reads as a feature that forgot.
    if (dropped.length) console.warn(`[mail] dropped ${dropped.length} row(s) on load:`, dropped.join(', '))
    return { ok: true, dropped }
  } catch (e) {
    mail = M.emptyState()
    return { ok: false, why: String(e?.message ?? e) }
  }
}

export function saveMail(storage = globalThis.localStorage) {
  try { storage?.setItem(M.STORE_KEY, M.serialize(mail)); return true } catch { return false }
}

export const mailState = () => mail

// ---- attach / place ------------------------------------------------------------

export function attachMail(c) {
  scene = c.scene
  loadMail()
}

// Put a box on the road. `dash` null means "the first free slot", the same
// affordance `placePaper` offers and for the same reason: the caller usually
// wants A place, not a particular one.
export function placeBox({ district = state.district, side = 1, dash = null, agent, cap, policy } = {}) {
  const s = side > 0 ? 1 : -1
  let d = dash
  if (d == null) d = nextFreeSlot(district, s, 0, 'window')
  if (d == null) return { ok: false, why: 'MAIL_NO_SLOT' }
  if (!slotFree(district, s, d, 'window')) return { ok: false, why: 'MAIL_SLOT_TAKEN' }

  const r = M.openBox(mail, { district, side: s, dash: d, agent, cap, policy })
  if (!r.ok) return r
  // world.js's registry is what the slot algebra reads. Written here, in the same
  // call that created the box, so the two cannot get out of step.
  mailboxes.set(r.key, M.boxOf(mail, r.key))
  saveMail()
  return { ok: true, key: r.key, dash: d }
}

export function removeBox(key) {
  const b = mail.boxes[key]
  if (!b) return { ok: false, why: 'MAIL_NO_BOX' }
  if (readingKey === key) closeMail()
  dropMesh(key)
  mailboxes.delete(key)
  M.closeBox(mail, key)
  saveMail()
  return { ok: true }
}

// An agent posts. The one entry point an agent driver uses; everything else here
// is the human's side.
export function postTo(key, msg) {
  const r = M.post(mail, key, { ...msg, wall: Date.now() })
  if (r.ok || r.why === 'MAIL_BOX_FULL') { saveMail(); mark(key) }
  return r
}

// ---- meshes --------------------------------------------------------------------

const parts = new Map() // key -> { group, face, post, canvas, tex, mat, badgeKey }

function drawBadge(canvas, b) {
  const g = canvas.getContext('2d')
  const w = canvas.width, h = canvas.height
  const bd = M.badge(b)

  g.clearRect(0, 0, w, h)
  g.fillStyle = '#0b0e18'
  g.fillRect(0, 0, w, h)
  // A hairline in the road's amber so the box reads as furniture of this road
  // rather than a floating panel.
  g.strokeStyle = bd.waiting ? '#f2c14e' : '#2a3142'
  g.lineWidth = bd.waiting ? 6 : 3
  g.strokeRect(3, 3, w - 6, h - 6)

  g.fillStyle = '#8a97ab'
  g.font = '600 22px system-ui, sans-serif'
  g.textBaseline = 'top'
  g.fillText(b.agent.slice(0, 16), 16, 14)

  // THE NUMBER IS THE AFFORDANCE. Everything else on this face is context for it.
  g.font = '700 52px system-ui, sans-serif'
  g.fillStyle = bd.unread ? '#f2c14e' : '#3a4152'
  g.fillText(String(bd.unread), 16, 48)

  // `waiting` is drawn apart from `unread` because they are different demands:
  // fourteen things happened is not fourteen things to do.
  if (bd.waiting) {
    g.font = '600 20px system-ui, sans-serif'
    g.fillStyle = '#2de2e6'
    g.fillText(`${bd.waiting} waiting`, 96, 66)
  }
  // A parked agent must not read as a quiet one.
  if (bd.status === 'quiescent') {
    g.font = '600 18px system-ui, sans-serif'
    g.fillStyle = '#8a97ab'
    g.fillText('parked', 96, 92)
  }
}

// What the face is currently ASSERTING. Redraw only when this changes -- the same
// `boardKey` discipline the gate board uses, because a canvas repaint every frame
// on every box is a cost with no reader.
const badgeKeyOf = (b) => {
  const bd = M.badge(b)
  return `${b.agent}|${bd.unread}|${bd.waiting}|${bd.status}`
}

function buildMesh(b) {
  ensureShared()
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const tex = canvasTexture(THREE, canvas)
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  const face = new THREE.Mesh(boxGeo, mat)
  const post = new THREE.Mesh(postGeo, postMat)
  const group = new THREE.Group()
  group.add(face)
  group.add(post)

  // The click target is the FACE, and it carries its own key so a raycast hit
  // resolves without searching. Same shape as `paperKey`.
  face.userData.mailKey = b.key

  scene?.add(group)
  const part = { group, face, post, canvas, tex, mat, badgeKey: null }
  parts.set(b.key, part)
  return part
}

function dropMesh(key) {
  const p = parts.get(key)
  if (!p) return
  scene?.remove(p.group)
  p.tex?.dispose()
  p.mat?.dispose()
  parts.delete(key)
}

export function clearMail() {
  for (const k of [...parts.keys()]) dropMesh(k)
}

// Reconcile the scene with the store, once a frame. Same shape as `syncPaper` /
// `syncRamps`: the store is the truth and the meshes follow it, so nothing has to
// remember to move a box when the store changes.
export function syncMail() {
  const want = new Set()
  // THE SLOT REGISTRY IS RECONCILED HERE, not only when a box is placed.
  //
  // `placeBox` was the sole writer of `world.js`'s `mailboxes` map, so a box that
  // came back from the STORE on reload existed in every way except the one the
  // road cares about: `slotAt` returned null for its dash, `slotFree` said the
  // dash was empty, `lastMailZ` did not count it, and the map's dash page offered
  // to build a window on top of it. Found by the dash page failing to offer "open
  // it" for a box that was plainly standing there.
  //
  // Reconciled rather than written at load, for the reason the meshes are: the
  // store is the truth and everything else follows it once a frame, so there is
  // no second path that has to remember.
  for (const b of M.boxes(mail)) {
    const held = mailboxes.get(b.key)
    if (held !== b) mailboxes.set(b.key, b)
  }
  for (const k of [...mailboxes.keys()]) if (!mail.boxes[k]) mailboxes.delete(k)

  for (const b of M.boxes(mail)) {
    // A box on another network has no road under it. HIDDEN, not moved and not
    // deleted -- `laneX` answers 0 for a foreign workspace, which is not a
    // position but the absence of one, and stacking foreign furniture down the
    // middle of the active road is the fault `__tenants()` exists to catch.
    const here = b.district === state.district
    let p = parts.get(b.key)
    if (!p) p = buildMesh(b)
    want.add(b.key)

    p.group.visible = here
    if (!here) continue

    const x = ws.laneX(b.district) + b.side * STAND_X
    const z = dashZ(b.dash)
    p.face.position.set(x, ROAD_Y + POST_H + BOX_H / 2, z)
    p.post.position.set(x, ROAD_Y + POST_H / 2, z)
    // TURNED THE SAME 0.42 RAD EVERY OTHER SIGN ON THIS ROAD IS TURNED.
    //
    // The first build used -PI/2, i.e. square across the road -- which is what
    // "facing the road" sounds like and is nearly EDGE-ON to a driver coming down
    // it, because the driver is not beside the box, they are approaching it. Found
    // by driving to one and seeing nothing. `rrabbit.js SIGN_TURN` is 0.42 and
    // `paper.js` turns its panes by the same literal; a fourth occupant standing
    // at its own angle would read as furniture from a different road.
    p.face.rotation.y = -b.side * SIGN_TURN

    const k = badgeKeyOf(b)
    if (k !== p.badgeKey) { drawBadge(p.canvas, b); p.tex.needsUpdate = true; p.badgeKey = k }
  }
  for (const k of [...parts.keys()]) if (!want.has(k)) dropMesh(k)
}

// Force the face to redraw on the next sync. Called when the store changes under
// us -- an agent posting is not a frame event.
function mark(key) {
  const p = parts.get(key)
  if (p) p.badgeKey = null
}

// VISIBLE ONLY. three raycasts a mesh you hand it regardless of `visible`, so a
// hidden foreign box would take clicks through the road drawn over it. This
// filter and syncMail's `group.visible` assignment are two halves of one rule.
export function mailMeshes() {
  const out = []
  for (const p of parts.values()) if (p.group.visible) out.push(p.face)
  return out
}

export const mailAt = (hit) => {
  const key = hit?.object?.userData?.mailKey
  return key ? M.boxOf(mail, key) : null
}

// ---- the panel -----------------------------------------------------------------

let layer = null
let panel = null
let readingKey = null
let pageFrom = 0

function ensureLayer() {
  if (layer) return
  injectStyle()
  layer = document.createElement('div')
  layer.id = 'mail-layer'
  // POINTER-EVENTS NONE ON THE LAYER, AUTO ON THE PANEL. The `inset: 0` layer
  // covers the whole screen, so making IT clickable kills every click on the road
  // and the dashboard behind it. That exact bug shipped once already (`765a2c8`:
  // "every click on the dashboard was dead"), in a line whose own comment cited
  // the flat-mode `swallow` version of the same fault.
  layer.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:40;'
  document.body.appendChild(layer)
}

export function openMailPanel(b) {
  ensureLayer()
  readingKey = b.key
  pageFrom = 0
  render()
  return { ok: true, key: b.key }
}

export function closeMail() {
  readingKey = null
  if (panel) { panel.remove(); panel = null }
  return { ok: true }
}

export const isReadingMail = () => !!readingKey
export const readingMailKey = () => readingKey

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const KIND_TONE = { note: 'note', ask: 'ask', result: 'result', fault: 'fault' }

function render() {
  if (!readingKey) return
  const p = M.page(mail, readingKey, { from: pageFrom, size: 8 })
  if (!p.ok) { closeMail(); return }

  if (!panel) {
    panel = document.createElement('div')
    panel.className = 'mail-panel'
    layer.appendChild(panel)
    panel.addEventListener('click', onClick)
    panel.addEventListener('keydown', onKey)
  }

  const rows = p.rows.map((m) => `
    <li class="mail-row${m.seq > p.acked ? ' unread' : ''}">
      <span class="k k-${KIND_TONE[m.kind]}">${m.kind}</span>
      <span class="subj">${esc(m.subject)}</span>
      <span class="from">${esc(m.from)}</span>
      ${m.body ? `<div class="body">${esc(m.body)}</div>` : ''}
    </li>`).join('')

  panel.innerHTML = `
    <header>
      <span class="agent">${esc(p.agent)}</span>
      <span class="status s-${p.status}">${p.status}</span>
      <span class="counts">${p.unread} unread${p.waiting ? ` &middot; <b>${p.waiting} waiting</b>` : ''}</span>
      <button data-act="close" title="leave the box">[X]</button>
    </header>
    ${p.cut ? `<div class="cut">+${p.cut} before${p.lostUnread ? ` (${p.lostUnread} never read)` : ''}</div>` : ''}
    <ul class="mail-list">${rows || '<li class="empty">nothing here</li>'}</ul>
    <nav>
      <button data-act="newer"${p.from > 0 ? '' : ' disabled'}>&lt; newer</button>
      <span class="pos">${p.total ? `${p.from + 1}-${Math.min(p.from + p.size, p.total)} of ${p.total}` : '0'}</span>
      <button data-act="older"${p.more ? '' : ' disabled'}>older &gt;</button>
      <button data-act="ack"${p.unread ? '' : ' disabled'} title="mark everything read">ack all</button>
      <button data-act="${p.status === 'runnable' ? 'rest' : 'wake'}">${p.status === 'runnable' ? 'park' : 'wake'}</button>
    </nav>
    <form class="reply"><input name="text" placeholder="reply to ${esc(p.agent)}" autocomplete="off"><button data-act="reply">send</button></form>
  `
}

function onClick(ev) {
  const b = ev.target.closest('[data-act]')
  if (!b || !readingKey) return
  ev.preventDefault()
  const box = M.boxOf(mail, readingKey)
  const at = { district: box.district, side: box.side, dash: box.dash }

  switch (b.dataset.act) {
    case 'close': applyOp({ op: 'unmail' }, { by: 'pointer' }); return
    case 'newer': pageFrom = Math.max(0, pageFrom - 8); render(); return
    case 'older': pageFrom = pageFrom + 8; render(); return
    // ACK ALL means "up to the newest IN THIS BOX", not the top of the page and
    // not the global `mail.seq`. The page would leave the badge counting things
    // the panel cannot show you; the global counter would set a mark above any
    // message here, which `parse` then clamps on the next load -- so the value in
    // memory and the value on disk would differ for no reason anybody could see.
    case 'ack': {
      const top = box.msgs.length ? box.msgs[box.msgs.length - 1].seq : 0
      applyOp({ op: 'ack', ...at, seq: top }, { by: 'pointer' })
      return
    }
    case 'rest': applyOp({ op: 'rest', ...at }, { by: 'pointer' }); return
    case 'wake': applyOp({ op: 'wake', ...at }, { by: 'pointer' }); return
    case 'reply': {
      const input = panel.querySelector('input[name=text]')
      const text = input?.value?.trim()
      if (!text) return
      applyOp({ op: 'reply', ...at, text }, { by: 'pointer' })
      input.value = ''
      return
    }
  }
}

// A FIELD YOU ARE TYPING IN OWNS ITS KEYSTROKES. Without this, replying "0 windows
// left" shuts the map and flies you somewhere. The same guard the map's rename box
// needed.
//
// ESCAPE IS DELIBERATELY NOT HANDLED HERE ANY MORE. It was, and that was the fault
// travel.js's Escape ladder has written down twice already: three capture-phase
// branches in that listener can stop propagation before a listener on this panel
// is ever reached, so a key bound here is a key that works until something else
// opens. The ladder owns Escape; this owns the text field.
function onKey(ev) {
  if (ev.target.tagName === 'INPUT') {
    if (ev.key === 'Escape') return // let the ladder have it
    if (ev.key === 'Enter') { ev.preventDefault(); panel.querySelector('[data-act=reply]')?.click() }
    ev.stopPropagation()
  }
}

function injectStyle() {
  if (document.getElementById('mail-style')) return
  const s = document.createElement('style')
  s.id = 'mail-style'
  s.textContent = `
  /* CENTRED, BECAUSE IT IS A PLACE YOU FLEW TO. It was pinned top-right, which is
     where a notification goes -- and a notification is exactly what it read as
     while the cockpit was still up underneath it. The cockpit gets out of the way
     now (dash.js wantHidden, mode 'read'), so this occupies the frame the way a
     flattened window does.

     HONEST DIFFERENCE, recorded rather than papered over: a pane's read tier is a
     CSS3DObject standing at the pane's own position and angle, so driving past it
     and reading it are continuous. This is screen-space. The enter flight, the
     cockpit hiding, Escape and the exit flight are now identical; the panel's
     placement in the world is not. */
  .mail-panel { pointer-events: auto; position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%); width: 460px;
    max-height: min(72vh, 620px); overflow: auto; background: #0b0e18f2; color: #d7dde8;
    border: 1px solid #2a3142; border-radius: 6px; font: 13px/1.5 system-ui, sans-serif;
    box-shadow: 0 24px 80px #000a; }
  .mail-panel header { display: flex; gap: 8px; align-items: baseline; padding: 10px 12px;
    border-bottom: 1px solid #2a3142; }
  .mail-panel .agent { font-weight: 600; color: #f2c14e; }
  .mail-panel .status { font-size: 11px; color: #8a97ab; }
  .mail-panel .s-quiescent { color: #2de2e6; }
  .mail-panel .counts { margin-left: auto; font-size: 11px; color: #8a97ab; }
  .mail-panel header button { background: none; border: 0; color: #8a97ab; cursor: pointer; }
  .mail-panel .cut { padding: 6px 12px; font-size: 11px; color: #f2c14e; border-bottom: 1px solid #2a3142; }
  .mail-list { list-style: none; margin: 0; padding: 0; }
  .mail-row { padding: 8px 12px; border-bottom: 1px solid #171b28; }
  .mail-row.unread { border-left: 3px solid #f2c14e; }
  .mail-row .k { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin-right: 6px; }
  .k-note { color: #8a97ab; } .k-ask { color: #2de2e6; }
  .k-result { color: #9ad07a; } .k-fault { color: #e2685f; }
  .mail-row .from { float: right; font-size: 11px; color: #5b6577; }
  .mail-row .body { margin-top: 4px; color: #8a97ab; white-space: pre-wrap; }
  .mail-panel .empty { padding: 16px 12px; color: #5b6577; }
  .mail-panel nav { display: flex; gap: 6px; align-items: center; padding: 8px 12px;
    border-top: 1px solid #2a3142; }
  .mail-panel nav .pos { font-size: 11px; color: #5b6577; margin-right: auto; }
  .mail-panel button { background: #171b28; border: 1px solid #2a3142; color: #d7dde8;
    border-radius: 4px; padding: 3px 8px; cursor: pointer; font: inherit; font-size: 11px; }
  .mail-panel button:disabled { opacity: .35; cursor: default; }
  .mail-panel .reply { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #2a3142; }
  .mail-panel .reply input { flex: 1; background: #060810; border: 1px solid #2a3142;
    color: #d7dde8; border-radius: 4px; padding: 4px 6px; font: inherit; }
  `
  document.head.appendChild(s)
}

// ---- the ops ---------------------------------------------------------------------
//
// THE ONLY WAY A BOX IS OPENED, ACKED, REPLIED TO OR PARKED. Not one path for a
// click and another for a replay -- `apply()` is the single door, and an agent
// driving these ops reaches exactly the world a human's pointer does, which is the
// §9 claim the seam exists to test.
//
// Preconditions are TOTAL: a malformed argument evaluates false, never throws.
export function registerMailOps() {
  const boxAt = (op) => M.boxOf(mail, M.keyOf(op.district, op.side, op.dash))
  const here = (op) => {
    const b = boxAt(op)
    if (!b) return 'OP_NO_BOX'
    if (b.district !== state.district) return 'OP_BOX_NOT_HERE'
    return true
  }
  // Every mutating op ends the same way: persist, redraw the face, redraw the
  // panel if it is open. Written once so an op cannot forget one of the three --
  // a badge that did not follow its own store is the exact drift `unread`-as-a-
  // projection exists to prevent, and it would arrive back through this door.
  const settle = (key) => { saveMail(); mark(key); if (readingKey === key) render() }

  // ENTERING A MAILBOX IS ARRIVING AT IT. The camera flies in and the shell lands
  // in `read` mode, which is what hides the cockpit -- see travel.js `flyInto`.
  // The mesh is handed over rather than looked up, because `mail.js` owns the
  // parts map and travel.js must not learn about it.
  registerOp('mail', {
    pre: here,
    perform: (op) => {
      const b = boxAt(op)
      const part = parts.get(b.key)
      hooks.flyToMail?.(b, part?.face ?? null, BOX_H)
      return openMailPanel(b)
    },
  })

  // And leaving flies you back out, on exactly the terms `unread` does.
  registerOp('unmail', {
    pre: () => true,
    perform: () => {
      closeMail()
      const flew = hooks.releaseInside?.() ?? false
      return { ok: true, flew }
    },
  })

  registerOp('ack', {
    pre: (op) => (boxAt(op) ? (Number.isInteger(op.seq) ? true : 'OP_BAD_SEQ') : 'OP_NO_BOX'),
    perform: (op) => {
      const key = M.keyOf(op.district, op.side, op.dash)
      const r = M.ack(mail, key, op.seq, { by: 'driver', wall: Date.now() })
      settle(key)
      return r
    },
  })

  registerOp('reply', {
    pre: (op) => (boxAt(op) ? (typeof op.text === 'string' && op.text.length ? true : 'OP_EMPTY_REPLY') : 'OP_NO_BOX'),
    perform: (op) => {
      const key = M.keyOf(op.district, op.side, op.dash)
      const r = M.reply(mail, key, op.text, { by: 'driver', wall: Date.now() })
      settle(key)
      // The agent hears about it through a hook rather than an import, because
      // whatever runs agents does not exist yet and this module must not assume
      // its shape. Nothing is wired to this today and that is honest: the packet's
      // Q1 has to come back before an agent can be a principal at all.
      hooks.mailReply?.(M.boxOf(mail, key), r.fact)
      return r
    },
  })

  const status = (name, value) => registerOp(name, {
    pre: (op) => (boxAt(op) ? true : 'OP_NO_BOX'),
    perform: (op) => {
      const key = M.keyOf(op.district, op.side, op.dash)
      const r = M.setStatus(mail, key, value, { by: 'driver', wall: Date.now() })
      settle(key)
      hooks.mailStatus?.(M.boxOf(mail, key), value)
      return r
    },
  })
  status('rest', 'quiescent')
  status('wake', 'runnable')
}

// What Escape inside the panel calls, and what a click outside it should. A hook
// out rather than a direct import for the same reason `paperUnread` is one.
export const mailUnread = () => applyOp({ op: 'unmail' }, { by: 'pointer' })

// ---- the report --------------------------------------------------------------
//
// `window.__mail()`. READ OFF THE SCENE AND THE STORE SEPARATELY so the two can
// disagree in the report -- the mistake `__ramps()` records is deriving a claim
// from the one component known to update, and a badge count recomputed from the
// store would agree with the store by construction and prove nothing about what
// is painted on the box.
export const mailReport = () => ({
  boxes: M.boxes(mail).length,
  onThisRoad: M.boxesOn(mail, state.district).length,
  summary: M.roadSummary(mail, state.district),
  seq: mail.seq,
  droppedOnLoad: lastDropped,
  reading: readingKey,
  // The last thing the map's dash page tried to place, refusal and all. Reported
  // because "the button did nothing" and "the button was refused and said so"
  // are indistinguishable from outside, and the first is a bug.
  lastPlace: state.lastMailPlace ?? null,
  mode: state.mode,
  inside: state.inside,
  // What the STORE says each box should be advertising...
  wanted: M.boxes(mail).map((b) => ({ key: b.key, badge: badgeKeyOf(b) })),
  // ...and what each FACE was last painted with. A mismatch here is a badge
  // showing a number that is no longer true, which is the one failure of this
  // feature a user would not be able to tell from an agent being quiet.
  painted: [...parts.entries()].map(([key, p]) => ({ key, badge: p.badgeKey, visible: p.group.visible })),
  meshes: mailMeshes().length,
})
