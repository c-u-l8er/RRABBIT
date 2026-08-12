// THE ROAD MAP -- the network seen from above, as a map rather than as a view.
//
// This replaces the old overview, which flew the camera up and back so you could
// see every road at once. That was a picture of the roads and it could not
// answer the questions you actually have from up there: which workspace connects
// to which, what is ON each one, and take me to that. A road you can see from
// 1150 units up is a grey strip with some flecks on it.
//
// So the overview is a MAP now: nodes, arrows, names, counts -- and it is
// clickable in two steps, which is what was asked for. Click a workspace to see
// its windows; click a window to leave the map and end up on the road beside it.
//
// WHY THIS IS DOM AND SVG AND NOT THREE.JS. Everything else in this shell is in
// the scene, deliberately, because it is furniture standing in a place. A map is
// not in the world -- it is the thing you hold up when you are trying to work
// out the world -- and it is made of text, boxes and arrows at legible sizes,
// which the DOM does natively and a 3D scene does through canvas textures on
// quads. The scene keeps rendering behind it, dimmed, so it is clear you are
// looking AT the network rather than having left it.
//
// It owns its own stylesheet and its own element's contents, so the network view
// is one file you could delete.

import { signs, state } from './world.js'
import * as ws from './workspaces.js'

// Filled by shell.js. The map never navigates -- it says what was picked and
// Travel does the flying, the same division the gates keep.
let go = { window: null, district: null }
export function attachMap(handlers) {
  go = { ...go, ...handlers }
}

let el = null
let open = false
let selected = null
let signature = ''
let poll = 0

const NODE_W = 172
const NODE_H = 56
const COL_GAP = 214
const ROW_GAP = 128
const PAD = 40

export const isOpen = () => open

// ------------------------------------------------------------------ layout
//
// Rows are BFS DEPTH FROM THE ROOT, which is what makes this read as a network
// and not as the row of parallel lanes the roads themselves are. Two workspaces
// on the same row are the same number of hops from home; an arrow that goes back
// UP a row is a loop, and seeing that at a glance is most of the reason to draw
// the graph at all.
//
// Anything the root cannot reach lands on its own row underneath. A node you
// cannot see is indistinguishable from a node that was never created, and this
// is the view whose whole job is to show you what exists.
function layout() {
  const all = ws.list()
  const rootId = ws.root()
  const depth = new Map()
  if (rootId && ws.has(rootId)) {
    depth.set(rootId, 0)
    const q = [rootId]
    while (q.length) {
      const id = q.shift()
      for (const e of ws.exitsOf(id)) {
        if (depth.has(e)) continue
        depth.set(e, depth.get(id) + 1)
        q.push(e)
      }
    }
  }
  let maxD = 0
  for (const d of depth.values()) maxD = Math.max(maxD, d)
  for (const n of all) if (!depth.has(n.id)) depth.set(n.id, maxD + 1)

  const rows = new Map()
  for (const n of all) {
    const d = depth.get(n.id)
    if (!rows.has(d)) rows.set(d, [])
    rows.get(d).push(n)
  }

  const widest = Math.max(...[...rows.values()].map((r) => r.length), 1)
  const width = PAD * 2 + widest * COL_GAP
  const at = new Map()
  for (const [d, row] of rows) {
    row.forEach((n, i) => {
      at.set(n.id, {
        x: width / 2 + (i - (row.length - 1) / 2) * COL_GAP,
        y: PAD + NODE_H / 2 + d * ROW_GAP,
        node: n,
      })
    })
  }
  const height = PAD * 2 + NODE_H + Math.max(0, rows.size - 1) * ROW_GAP
  return { at, width, height }
}

const windowsOf = (id) =>
  [...signs.values()].filter((s) => s.district === id).sort((a, b) => a.milepost - b.milepost)

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// ------------------------------------------------------------------ drawing

function edgePath(a, b, both) {
  // A mutual pair -- home -> build and build -> home -- would otherwise be two
  // arrows drawn exactly on top of each other, which reads as one undirected
  // line and loses the fact that exits are one-way. Bow each direction out to
  // its own side instead.
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // Stop at the box edge rather than the centre, so the arrowhead lands on the
  // node instead of inside it.
  const trim = NODE_H * 0.75
  const ax = a.x + (dx / len) * trim
  const ay = a.y + (dy / len) * trim
  const bx = b.x - (dx / len) * trim
  const by = b.y - (dy / len) * trim
  if (!both) return `M ${ax} ${ay} L ${bx} ${by}`
  const off = 26
  const mx = (ax + bx) / 2 - (dy / len) * off
  const my = (ay + by) / 2 + (dx / len) * off
  return `M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`
}

function draw() {
  const { at, width, height } = layout()
  const here = state.district

  let edges = ''
  for (const [id, p] of at) {
    for (const to of ws.exitsOf(id)) {
      const q = at.get(to)
      if (!q) continue
      const both = ws.exitsOf(to).includes(id)
      edges += `<path class="edge" d="${edgePath(p, q, both)}" marker-end="url(#arrow)" />`
    }
  }

  let nodes = ''
  for (const [id, p] of at) {
    const n = p.node
    const count = windowsOf(id).length
    const cls = ['node', id === here ? 'here' : '', id === selected ? 'sel' : '', n.open ? '' : 'shut']
      .filter(Boolean)
      .join(' ')
    nodes +=
      `<g class="${cls}" data-node="${esc(id)}">` +
      `<rect x="${p.x - NODE_W / 2}" y="${p.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="6"/>` +
      // The lane number, because the map is where you decide to press a key and
      // the key is a number you cannot otherwise see anywhere.
      `<text class="no" x="${p.x - NODE_W / 2 + 10}" y="${p.y - NODE_H / 2 + 17}">${n.pos}</text>` +
      `<text class="nm" x="${p.x}" y="${p.y - 4}">${esc(n.name)}</text>` +
      `<text class="ct" x="${p.x}" y="${p.y + 16}">${n.open ? `${count} window${count === 1 ? '' : 's'}` : 'closed'}</text>` +
      (id === here ? `<text class="you" x="${p.x}" y="${p.y - NODE_H / 2 - 8}">you are here</text>` : '') +
      '</g>'
  }

  const svg =
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4d5a72"/></marker></defs>' +
    edges +
    nodes +
    '</svg>'

  return `<div class="wrap"><div class="graph">${svg}</div>${panel()}</div>`
}

// THE DETAIL PANEL IS ALSO WHERE YOU EDIT.
//
// The map already had to know every workspace's name, number and exits in order
// to draw them, and a view that shows you a wrong name is one keystroke away
// from being a view that lets you fix it. Doing it here rather than on the
// gates keeps the road free of forms: out there you drive, in here you plan.
//
// Every control is a plain form element with a data attribute, and the one
// click handler at the bottom reads them. No framework, no state to keep in
// step with the graph -- the panel is redrawn from the graph after every change,
// so what you see is always what was actually stored.
function panel() {
  if (!selected || !ws.has(selected)) {
    return (
      '<aside class="detail"><h2>the network</h2>' +
      '<p class="hint">Every workspace, and every exit between them. Rows are hops from ' +
      `<b>${esc(ws.get(ws.root())?.name ?? 'the root')}</b>, so an arrow pointing back up a row is a loop.</p>` +
      '<p class="hint">Click a workspace to see what is on it, rename it, change its number, or rewire its exits. Click one of its windows to leave the map and come out on the road beside that window.</p>' +
      '<p class="keys">0 or Esc closes · type a number to jump to that lane</p></aside>'
    )
  }
  const n = ws.get(selected)
  const rows = windowsOf(selected)
  const list = rows.length
    ? rows
        .map((s) => {
          const size = s.size ? `${s.size.width}&times;${s.size.height}` : 'no buffer yet'
          const flat = state.flatDistrict === s.district && state.flatMilepost === s.milepost
          return (
            `<li><button data-win="${esc(s.district)}|${s.milepost}"${s.mesh ? '' : ' disabled'}>` +
            `<span class="addr">${esc(n.name)}:${s.milepost}</span>` +
            `<span class="meta">${s.side > 0 ? 'right' : 'left'} &middot; ${size}${flat ? ' &middot; you are in this one' : ''}</span>` +
            '</button></li>'
          )
        })
        .join('')
    : '<li class="empty">No windows on this road yet. Its enter gate opens them.</li>'

  const exits = ws.exitsOf(selected)
  const exitRows = exits.length
    ? exits
        .map(
          (e) =>
            `<li><span>${esc(ws.get(e).name)}</span>` +
            `<button class="mini" data-cut="${esc(selected)}|${esc(e)}" title="remove this exit">&times;</button></li>`,
        )
        .join('')
    : '<li class="empty">No exits. This road leads nowhere.</li>'

  // Only workspaces that are not already reachable from here, and not here.
  const candidates = ws
    .list()
    .filter((w) => w.id !== selected && !exits.includes(w.id))
    .map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`)
    .join('')

  // Who points AT this one. Rewiring is only half a job if you can see one
  // direction: an exit is one-way, so the way back is a different edge and it
  // lives on a different workspace's panel.
  const inbound = ws.list().filter((w) => w.id !== selected && ws.exitsOf(w.id).includes(selected))

  return (
    `<aside class="detail"><h2>${esc(n.name)}</h2>` +
    (n.open ? '' : '<p class="hint">This workspace is closed — its road is not laid.</p>') +
    '<div class="field"><label>name</label>' +
    `<input id="ws-name" value="${esc(n.name)}" maxlength="24" data-id="${esc(selected)}" />` +
    `<button class="mini" data-rename="${esc(selected)}">set</button></div>` +
    '<div class="field"><label>lane</label>' +
    `<input id="ws-pos" type="number" min="1" max="${ws.list().length}" value="${n.pos}" data-id="${esc(selected)}" />` +
    `<button class="mini" data-pos="${esc(selected)}">set</button>` +
    '<span class="note">swaps with whichever lane holds it</span></div>' +
    `<h3>exits <span class="note">from ${esc(n.name)}</span></h3>` +
    `<ul class="exits">${exitRows}</ul>` +
    (candidates
      ? '<div class="field"><select id="ws-add">' + candidates + '</select>' +
        `<button class="mini" data-add="${esc(selected)}">add exit</button></div>`
      : '') +
    (inbound.length
      ? `<p class="note">reached from: ${inbound.map((w) => esc(w.name)).join(', ')}</p>`
      : '<p class="note">nothing leads here</p>') +
    `<h3>windows</h3><ul class="wins">${list}</ul>` +
    (n.open && selected !== state.district
      ? `<button class="goto" data-goto="${esc(selected)}">drive to ${esc(n.name)}</button>`
      : '') +
    '</aside>'
  )
}

// A signature of everything the map DRAWS. Re-rendering on a timer keeps the
// counts live while you read it; re-rendering only when this changes is what
// stops that timer from fighting the mouse.
function sig() {
  return [
    state.district,
    selected,
    state.flatDistrict,
    state.flatMilepost,
    ws
      .list()
      .map((n) => `${n.id}:${n.pos}:${n.name}:${n.open}:${n.exits.join('>')}:${windowsOf(n.id).length}`)
      .join('|'),
  ].join('#')
}

function render(force = false) {
  const s = sig()
  if (!force && s === signature) return
  signature = s
  el.innerHTML = draw()
}

// ------------------------------------------------------------------ the view

const CSS = `
#map { position: fixed; inset: 0; z-index: 6; overflow: auto;
  background: rgba(3,4,10,.86); backdrop-filter: blur(2px);
  font: 12px/1.5 ui-monospace, monospace; color: #f3ead4; }
#map .wrap { display: flex; align-items: flex-start; gap: 24px; min-height: 100%; padding: 20px; box-sizing: border-box; }
#map .graph { flex: 1 1 auto; overflow: auto; }
#map svg { display: block; }
#map .edge { fill: none; stroke: #4d5a72; stroke-width: 2; }
#map .node rect { fill: #0b1220; stroke: #2de2e6; stroke-width: 2; cursor: pointer; }
#map .node:hover rect { fill: #142033; }
#map .node.here rect { stroke: #f2c14e; stroke-width: 3; }
#map .node.sel rect { fill: #1a2740; }
#map .node.shut rect { stroke: #4d5a72; stroke-dasharray: 5 4; }
#map .node text { text-anchor: middle; pointer-events: none; font: 14px ui-monospace, monospace; fill: #f3ead4; }
#map .node .nm { font-weight: 700; font-size: 16px; }
#map .node .ct { font-size: 12px; fill: #9fb0c8; }
#map .node.shut .ct { fill: #6b7689; }
#map .node .you { font-size: 11px; fill: #f2c14e; }
#map .node .no { text-anchor: start; font-size: 12px; font-weight: 700; fill: #6b7689; }
#map .node.here .no { fill: #f2c14e; }
#map .detail { flex: 0 0 320px; border: 1px solid #24304a; background: #070b14; padding: 14px 16px; box-sizing: border-box; }
#map .detail h2 { margin: 0 0 8px; font-size: 18px; color: #f2c14e; }
#map .detail .hint { margin: 0 0 10px; color: #9fb0c8; }
#map .detail .keys { margin: 14px 0 0; color: #6b7689; }
#map .wins { list-style: none; margin: 0; padding: 0; }
#map .wins li { margin: 0 0 6px; }
#map .wins li.empty { color: #6b7689; }
#map .wins button { display: block; width: 100%; text-align: left; cursor: pointer;
  background: #0b1220; border: 1px solid #24304a; color: #f3ead4; padding: 8px 10px;
  font: inherit; }
#map .wins button:hover:not(:disabled) { background: #16233a; border-color: #2de2e6; }
#map .wins button:disabled { opacity: .45; cursor: default; }
#map .wins .addr { display: block; font-weight: 700; }
#map .wins .meta { display: block; color: #9fb0c8; }
#map .field { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; flex-wrap: wrap; }
#map .field label { flex: 0 0 42px; color: #9fb0c8; }
#map .field input, #map .field select { flex: 1 1 60px; min-width: 0; background: #0b1220;
  border: 1px solid #24304a; color: #f3ead4; font: inherit; padding: 5px 7px; }
#map .field input:focus, #map .field select:focus { outline: none; border-color: #2de2e6; }
#map .mini { cursor: pointer; background: #16233a; border: 1px solid #24304a; color: #f3ead4;
  font: inherit; padding: 5px 9px; }
#map .mini:hover { border-color: #2de2e6; }
#map h3 { margin: 14px 0 6px; font-size: 13px; color: #9fb0c8; font-weight: 700; }
#map .note { color: #6b7689; margin: 0 0 8px; flex-basis: 100%; }
#map .exits { list-style: none; margin: 0 0 8px; padding: 0; }
#map .exits li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
#map .exits li span { flex: 1 1 auto; }
#map .exits li.empty { color: #6b7689; }
#map .goto { margin-top: 12px; width: 100%; cursor: pointer; background: #0b6b3a;
  border: 1px solid #fff; color: #fff; padding: 8px 10px; font: inherit; }
`

function install() {
  el = document.getElementById('map')
  if (!el || el.dataset.ready) return
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  el.dataset.ready = '1'

  el.addEventListener('click', (ev) => {
    const win = ev.target.closest('[data-win]')
    if (win) {
      const [district, mp] = win.dataset.win.split('|')
      closeMap()
      // Out of the map and onto the road beside that window. Travel does the
      // flying; the map only says which one.
      go.window?.(district, Number(mp))
      return
    }
    const goto = ev.target.closest('[data-goto]')
    if (goto) {
      closeMap()
      go.district?.(goto.dataset.goto)
      return
    }
    const rename = ev.target.closest('[data-rename]')
    if (rename) {
      ws.rename(rename.dataset.rename, el.querySelector('#ws-name')?.value)
      return render(true)
    }
    const pos = ev.target.closest('[data-pos]')
    if (pos) {
      ws.setPos(pos.dataset.pos, el.querySelector('#ws-pos')?.value)
      return render(true)
    }
    const cut = ev.target.closest('[data-cut]')
    if (cut) {
      const [from, to] = cut.dataset.cut.split('|')
      ws.disconnect(from, to)
      return render(true)
    }
    const add = ev.target.closest('[data-add]')
    if (add) {
      const to = el.querySelector('#ws-add')?.value
      if (to) ws.connect(add.dataset.add, to)
      return render(true)
    }
    const node = ev.target.closest('[data-node]')
    if (node) {
      selected = node.dataset.node
      render(true)
    }
  })

  // Enter commits the field it is typed in, because reaching for a button after
  // typing a name is the kind of small friction that makes a panel feel like a
  // form rather than a control.
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return
    const t = ev.target
    if (t.id === 'ws-name') ws.rename(t.dataset.id, t.value)
    else if (t.id === 'ws-pos') ws.setPos(t.dataset.id, t.value)
    else return
    ev.preventDefault()
    render(true)
  })
}

export function openMap() {
  install()
  if (!el) return false
  if (!selected || !ws.has(selected)) selected = state.district
  open = true
  state.mapOpen = true
  el.hidden = false
  render(true)
  clearInterval(poll)
  poll = setInterval(() => open && render(), 700)
  return true
}

export function closeMap() {
  if (!open) return false
  open = false
  state.mapOpen = false
  clearInterval(poll)
  poll = 0
  if (el) el.hidden = true
  return true
}

export const toggleMap = () => (open ? closeMap() : openMap())

// What the map is showing, without reading it off the screen.
export const mapReport = () => ({
  open,
  selected,
  nodes: ws.list().map((n) => ({ id: n.id, name: n.name, open: n.open, exits: [...n.exits], windows: windowsOf(n.id).length })),
  rendered: el && !el.hidden ? { nodes: el.querySelectorAll('[data-node]').length, windowButtons: el.querySelectorAll('[data-win]').length } : null,
})
