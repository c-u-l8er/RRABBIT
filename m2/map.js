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

import { signs, state, titles, renames, hooks, windowZ, dashZ, dashCount, exitZOf, slotAt, slotFree, nextFreeSlot, SLOT_FIRST, SLOT_GAP } from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'

// Filled by shell.js. The map never navigates -- it says what was picked and
// Travel does the flying, the same division the gates keep. `move` is the same
// division applied to the windows: the map is where you decide a window belongs
// somewhere else, and RRABBIT -- the one who IS the windows -- is the only thing
// that moves one.
let go = { window: null, enter: null, district: null, exit: null, dash: null, move: null, close: null, track: null, rename: null }
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

// ------------------------------------------------------------------ the view
//
// THE MAP IS NOW A CAMERA OVER THE GRAPH, not a picture of it in a scrolling
// box. A network of a dozen workspaces fits on a screen and a network of a
// hundred does not, and the answer to that is not a scrollbar -- you cannot
// judge whether an arrow is a loop while the other end of it is off the edge.
//
// `view` is the world rectangle the SVG shows: `x, y` is its top-left corner in
// graph coordinates and `k` is how many screen pixels one graph unit takes. It
// is written straight onto the svg's viewBox, so panning and zooming NEVER
// re-render -- the markup is untouched and one attribute changes, which is why
// a drag stays smooth over a graph the poll is also redrawing.
const K_MIN = 0.12
const K_MAX = 3
const clampK = (k) => Math.min(K_MAX, Math.max(K_MIN, k))

let view = { x: 0, y: 0, k: 1 }
// The size of the hole we are looking through, measured rather than assumed:
// the panel beside it is a fixed width but the window is not.
let port = { w: 900, h: 600 }
// Where each node was drawn, and how big the whole drawing is. Kept from the
// last layout so that "centre on this one" and "fit all of it" do not have to
// re-run the layout to find out where anything is.
let spots = new Map()
let bounds = { width: 900, height: 600 }
let fitted = false

// The window being dragged onto a workspace, and the workspace under it. Held
// here rather than in dataTransfer because getData() is deliberately blank
// during dragover -- the only moment when we need to know whether this drop
// would be legal.
let dragging = null
let dropOn = null

// The track whose page is open, if any. A third thing the panel can be about,
// alongside a workspace and a window -- and the only one of the three that is
// not somewhere in the graph, which is why it gets its own variable rather than
// another value of `selected`.
let track = null

// The window the map was opened ABOUT, if it was opened from a name board
// rather than from the keyboard. Cleared when the map closes, because it is a
// fact about how you got here and not about the graph.
let focus = null

// The dash whose page is open, as `{ district, at }`. A fifth thing the panel can
// be about, and the only one that is not an object in the graph at all -- it is a
// PLACE ON A ROAD, which is exactly what makes it the right address for a ramp.
let ramp = null
// Which network the ramp picker is currently listing workspaces from. Held
// separately from the ramp because it is a question you are part-way through
// answering, not a fact about anything.
let rampNet = null
// The networks page. A boolean rather than a value of `selected`, because it is
// about ALL of them and there is nothing for it to be selected on.
let netPage = false

// WHICH CLOSE HAS BEEN ASKED FOR BUT NOT ANSWERED, as `district|milepost`.
//
// Closing is the one control in here that cannot be undone -- a road can be
// re-entered, a window moved back, a ramp rebuilt, but a client that has exited is
// gone with whatever was in it. It was a single click, and on the row it was a
// single click on a small `×` sitting between two arrows you press all the time.
//
// A question you are part-way through answering rather than a fact about anything,
// so it lives beside `ramp` and `rampNet` and is cleared the same way.
let confirmShut = null

// The control, in whichever of its two states it is in. One function for both
// places it appears -- the row's `×` and the window page's full-width button --
// because two copies of a two-state control is how one of them ends up able to
// close without asking.
//
// `wide` is the page's version. Same three data attributes, same order, different
// words: on a row there is no space for a sentence and the row itself says which
// window; on the page there is nothing else the question could be about.
function shutPrompt(addr, live, wide = false) {
  if (confirmShut !== addr) {
    return wide
      ? `<button class="danger" data-shut="${addr}">ask it to close</button>`
      : `<button class="mini shut" data-shut="${addr}"${live ? '' : ' disabled'} title="ask this window to close">&times;</button>`
  }
  // THE CANCEL IS FIRST AND THE CLOSE IS SECOND, deliberately. The pointer is
  // already where the control was, and putting the irreversible half under it is
  // how a double-click closes a window nobody meant to close.
  return wide
    ? '<div class="shutting"><span class="note">Close it? The client exits and anything unsaved in it goes with it.</span>' +
        `<button class="mini" data-shutno="1">keep it</button>` +
        `<button class="danger" data-shutyes="${addr}">close it</button></div>`
    : `<button class="mini" data-shutno="1" title="leave it open">keep</button>` +
        `<button class="mini shut" data-shutyes="${addr}" title="close it for real">close</button>`
}

// Everything the panel can be about, cleared together. Five mutually exclusive
// pages reached from six places is exactly the shape that grows a bug where two
// of them are open at once and the last one written wins.
function onlyPage(which) {
  track = which === 'track' ? track : null
  focus = which === 'window' ? focus : null
  ramp = which === 'ramp' ? ramp : null
  netPage = which === 'networks'
  // Leaving the page the question was asked on is an answer of "no". A prompt that
  // survived a navigation would be waiting on a window you are no longer looking at,
  // and the next thing you pressed would be answering it.
  confirmShut = null
}

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
  spots = at
  bounds = { width, height }
  return { at, width, height }
}

// IN THE ORDER YOU DRIVE PAST THEM, which is what the list is a list of. It was
// milepost order, and a milepost stopped being a position the moment the two
// sides of the road got their own spacing -- so the list said 1, 2, 3 while the
// road said 1, 3, 2. Sorting by the z the placement arithmetic actually produces
// means the panel cannot disagree with the road about what is where.
const signAt = (district, milepost) =>
  [...signs.values()].find((s) => s.district === district && s.milepost === milepost) ?? null

const standingIn = (s) =>
  state.mode === 'flat' && state.flatDistrict === s.district && state.flatMilepost === s.milepost

const windowsOf = (id) =>
  [...signs.values()]
    .filter((s) => s.district === id)
    .sort((a, b) => (a.dash ?? 0) - (b.dash ?? 0) || a.side - b.side)

// Is anything standing further down this road than it needs to be? True exactly
// when some side's ordinals are not 0, 1, 2, ... -- which is the one thing the
// tidy fixes, so it is the one thing that should offer it.
// Is anything standing further down this road than it needs to be? Answered by the
// tidy itself, run and undone (rrabbit tidyPreview) -- because on the shared grid a
// ramp part-way down a road leaves holes that no tidy can close, and any rule of the
// form "are the dashes a uniform run?" would answer yes-there-are-gaps forever.
const roadHasGaps = (id) => go.move?.preview?.(id) > 0

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

  // WHERE YOU CAN GO FROM WHAT YOU HAVE SELECTED. The exits of the selected
  // workspace, lit -- on the nodes and on the edges that lead to them -- because
  // "which of these can I reach from here" is the question a graph is drawn to
  // answer and it was previously answered only by tracing arrows by eye.
  //
  // Exits only. A ramp reaches a workspace too, and usually one in another network
  // that is not on this drawing at all; the panel lists those, and lighting the
  // occasional same-network ramp target here would make the highlight mean two
  // different journeys.
  const reach = new Set(selected ? ws.exitsOf(selected) : [])

  let edges = ''
  for (const [id, p] of at) {
    for (const to of ws.exitsOf(id)) {
      const q = at.get(to)
      if (!q) continue
      const both = ws.exitsOf(to).includes(id)
      const lit = id === selected && reach.has(to)
      edges += `<path class="edge${lit ? ' lit' : ''}" d="${edgePath(p, q, both)}" marker-end="url(#${lit ? 'arrowlit' : 'arrow'})" />`
    }
  }

  let nodes = ''
  for (const [id, p] of at) {
    const n = p.node
    const count = windowsOf(id).length
    const parked = tracks.on(id)
    // `reach` is what you can go to; `open` is whether going there is possible.
    // A closed workspace that is reachable is still drawn lit, because the exit
    // genuinely exists -- it just cannot be taken, and the node already says
    // "closed" in its own words.
    const canGo = reach.has(id) && n.open
    const cls = [
      'node',
      id === here ? 'here' : '',
      id === selected ? 'sel' : '',
      reach.has(id) ? 'reach' : '',
      canGo ? 'go' : '',
      n.open ? '' : 'shut',
    ]
      .filter(Boolean)
      .join(' ')
    nodes +=
      `<g class="${cls}" data-node="${esc(id)}">` +
      `<rect x="${p.x - NODE_W / 2}" y="${p.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="6"/>` +
      // Where this road sits in the row, left to right. It used to double as the
      // key you pressed to get here; the number keys are tracks now, so this is
      // only the layout -- and it is still the only place the layout is visible.
      `<text class="no" x="${p.x - NODE_W / 2 + 10}" y="${p.y - NODE_H / 2 + 17}">${n.pos}</text>` +
      `<text class="nm" x="${p.x}" y="${p.y - 4}">${esc(n.name)}</text>` +
      `<text class="ct" x="${p.x}" y="${p.y + 16}">${n.open ? `${count} window${count === 1 ? '' : 's'}` : 'closed'}</text>` +
      (id === here ? `<text class="you" x="${p.x}" y="${p.y - NODE_H / 2 - 8}">you are here</text>` : '') +
      // WHICH TRACKS ARE PARKED HERE. Two numbers on one box is the thing a lane
      // key could never show, and it is the whole reason tracks exist -- so it
      // is on the box rather than in a panel.
      (parked.length
        ? `<text class="trk" x="${p.x + NODE_W / 2 - 8}" y="${p.y - NODE_H / 2 + 17}">${parked.join(' ')}</text>`
        : '') +
      // The lit ones say what clicking them does, on themselves. A node that
      // behaves differently from its neighbour because of something selected
      // elsewhere on the screen has to carry that difference where the pointer is.
      (canGo ? `<text class="gox" x="${p.x}" y="${p.y + NODE_H / 2 + 14}">go &rarr;</text>` : '') +
      '</g>'
  }

  // No width/height and no fixed viewBox: the svg fills its box and applyView()
  // writes the viewBox from `view` immediately after this markup is installed.
  // Putting the viewBox in here instead would mean every pan re-rendered the
  // graph, and a re-render during a drag is what makes a map feel like it is
  // fighting you.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
    '<defs>' +
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4d5a72"/></marker>' +
    // A second marker rather than a CSS rule: `fill` on a marker is read from the
    // marker's own element, not inherited from the path that references it, so a
    // lit edge with the plain arrowhead would fade to grey at the point.
    '<marker id="arrowlit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#2de2e6"/></marker>' +
    '</defs>' +
    edges +
    nodes +
    '</svg>'

  // THE TRACK BAR, across the top of the graph.
  //
  // Ten chips, always visible, because the whole point of ten parallel trails is
  // seeing at a glance which one you are on and where the others are parked --
  // and that is not something a panel you have to navigate to can tell you.
  // Clicking one IS pressing its number: you switch to it, and its page opens.
  const bar =
    '<div class="tracks">' +
    tracks
      .list()
      .map((t) => {
        const here = t.id === tracks.activeIndex()
        const where = t.at ? (ws.get(t.at)?.name ?? t.at) : 'unused'
        return (
          `<button class="chip${here ? ' on' : ''}${track === t.id ? ' sel' : ''}" data-track="${t.id}" title="${esc(where)}">` +
          `<span class="no">${t.id}</span>` +
          `<span class="nm">${esc(t.name || where)}</span>` +
          '</button>'
        )
      })
      .join('') +
    '</div>'

  // THE NETWORK BAR, above the tracks.
  //
  // Same shape as the track chips and for the same reason: which network you are
  // in is a fact you need at a glance rather than one you navigate to, and the
  // difference between "this workspace does not exist" and "this workspace is in
  // the other network" is the single most confusing thing multi-tenancy can do to
  // someone. It is the topmost row because it is the outermost thing: a track is
  // inside a network, and the graph below is one network's graph.
  const nets =
    '<div class="nets"><span class="lbl">network</span>' +
    ws
      .tenantList()
      .map((t) => {
        const on = t.id === ws.activeTenantId()
        return (
          `<button class="chip${on ? ' on' : ''}" data-net="${esc(t.id)}" title="${esc(t.name)}">` +
          `<span class="nm">${esc(t.name)}</span></button>`
        )
      })
      .join('') +
    '<button class="chip add" data-netpage="1" title="add, rename or remove a network">networks&hellip;</button>' +
    '</div>'

  const zoomers =
    '<div class="zoomers">' +
    '<button data-zoom="out" title="zoom out">&minus;</button>' +
    '<span class="pct">100%</span>' +
    '<button data-zoom="in" title="zoom in">+</button>' +
    '<button data-zoom="fit" title="fit the whole network">fit</button>' +
    '<button data-zoom="here" title="centre on the workspace you are on">you</button>' +
    '</div>'

  return `<div class="wrap"><div class="graph">${nets}${bar}${svg}${zoomers}</div>${panel()}</div>`
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
// What a window is called: yours over the client's. Three readers agree on it
// because they all come through here (rrabbit's nameOf is the same rule for the
// board, and the two must not drift).
const keyOfSign = (s) => s?.mesh?.userData?.signKey ?? ''
const myName = (s) => renames.get(keyOfSign(s)) ?? ''
const clientName = (s) => titles.get(keyOfSign(s)) || 'untitled window'
const titleOf = (s) => myName(s) || clientName(s)
// SHOWN in brackets, HELD without them -- rrabbit's labelOf says why, and this is
// the same rule so the board over the window and the list in here cannot drift.
// The rename box binds to `myName`, never to this, or the brackets would be typed
// back into the name.
const labelOf = (s) => `(${titleOf(s)})`

// THE PANEL IS TWO PANELS, and which one you get is which thing you last
// pointed at: a workspace, or a window.
//
// It was one, with a window list inside it, and a window's controls crammed onto
// its row. That is fine for three windows and it is a paragraph of buttons for
// ten -- and it had nowhere to say anything ABOUT a window, which is what the
// name board over a window promises when you click it. So a window gets a page
// of its own, reached the same three ways: click its row, click its board, or
// press 0 while standing in it.
function panel() {
  if (netPage) return networksPanel()
  if (ramp) return rampPanel()
  if (track) return trackPanel()
  if (focus && signAt(focus.district, focus.milepost)) return windowPanel()
  if (!selected || !ws.has(selected)) {
    return (
      `<aside class="detail"><h2>${esc(ws.activeTenantName())}</h2>` +
      '<p class="hint">Every workspace in this network, and every exit between them. Rows are hops from ' +
      `<b>${esc(ws.get(ws.root())?.name ?? 'the root')}</b>, so an arrow pointing back up a row is a loop.</p>` +
      '<p class="hint">Click a workspace to see what is on it, rename it, change its number, or rewire its exits. Click one of its windows to leave the map and come out on the road beside that window.</p>' +
      '<p class="keys">drag to pan · wheel to zoom · 0 or Esc closes &middot; 1&ndash;9 switch tracks (1 then 0 for ten)</p></aside>'
    )
  }
  const n = ws.get(selected)
  const rows = windowsOf(selected)

  // Somewhere else to send a window. Only OPEN workspaces: syncRoads lays a road
  // for each open one, so a window moved onto a closed workspace would stand in
  // the air over nothing. The refusal is enforced in moveWindowTo -- this just
  // does not offer it, because an option that always fails is worse than no
  // option.
  const elsewhere = ws.list().filter((w) => w.id !== selected && w.open)

  const list = rows.length
    ? rows
        .map((s) => {
          const size = s.size ? `${s.size.width}&times;${s.size.height}` : 'no buffer yet'
          const flat = standingIn(s)
          const i = rows.indexOf(s)
          const addr = `${esc(s.district)}|${s.milepost}`
          const live = !!s.mesh
          const isFocus = focus && focus.district === s.district && focus.milepost === s.milepost
          // THE WHOLE ROW IS THE DRAG HANDLE, and it is a div rather than a
          // button so that it can be.
          //
          // It was a button with a small grip beside it, and the grip was there
          // because a browser will not start a drag from a <button>. Reported as
          // windows not being draggable at all -- which is what a drag handle
          // nobody grabs amounts to. You aim at the row, so the row has to be
          // the thing that moves; the grip stays as the mark that says so.
          //
          // It is also a drop TARGET, which is the other half of the report:
          // dropping one row on another is how you say where in the list it
          // goes, and until now the only reordering was two arrow buttons.
          return (
            `<li class="${isFocus ? 'focus' : ''}"${live ? ` data-drag="${addr}"` : ''} data-onto="${addr}">` +
            `<div class="row"><span class="grip">&#8942;&#8942;</span>` +
            `<span class="pick" data-win="${addr}">` +
            `<span class="addr">${esc(labelOf(s))}</span>` +
            `<span class="meta">${esc(n.name)}:${s.milepost} &middot; ${s.side > 0 ? 'right' : 'left'} &middot; ${size}${flat ? ' &middot; you are in this one' : ''}</span>` +
            '</span></div>' +
            '<div class="moves">' +
            `<button class="mini" data-along="${addr}|-1"${live && i > 0 ? '' : ' disabled'} title="one place nearer the entrance">&#9650;</button>` +
            `<button class="mini" data-along="${addr}|1"${live && i < rows.length - 1 ? '' : ' disabled'} title="one place further down the road">&#9660;</button>` +
            `<button class="mini" data-flip="${addr}"${live ? '' : ' disabled'} title="cross to the other side of the road">&#8644; ${s.side > 0 ? 'left' : 'right'}</button>` +
            // The same request the `X--` control on the window makes, from the
            // panel that lists every window -- because closing the fourth one
            // down a road should not require flying into it first.
            //
            // AND IT ASKS FIRST. The `×` is the smallest control on the row and it
            // sits between two arrows you press repeatedly to shuffle a window
            // along; the two things either side of it are undoable and it is not.
            // In place rather than as a dialog: the answer belongs on the row the
            // question was asked about, or you have to look away from it to answer.
            shutPrompt(addr, live) +
            (elsewhere.length
              ? `<select data-dest="${addr}"${live ? '' : ' disabled'}><option value="">move to&hellip;</option>` +
                elsewhere.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('') +
                '</select>'
              : '') +
            '</div></li>'
          )
        })
        .join('')
    : '<li class="empty">No windows on this road yet. Its enter gate opens them.</li>'

  const exits = ws.exitsOf(selected)
  // The order here IS the order of the lanes on the exit gate, left to right,
  // so the arrows are not a tidying-up affordance -- they are how you decide
  // which way you reach for without looking.
  // A LANE IS NAMEABLE HERE, because the gate is where you read the name and this
  // is where everything about a road is edited. The row shows the connection as the
  // gate shows it -- `{name} --to-->` -- so what you are typing and what you will
  // see standing at the end of the road are the same string in the same notation.
  //
  // The box holds only what you typed (`exitOwnName`), never the destination's name
  // filled in on your behalf: a placeholder that is also a value is a box you cannot
  // tell "unnamed" from "named the same as the target" in, and clearing it would
  // then be indistinguishable from typing that name.
  const exitRows = exits.length
    ? exits
        .map(
          (e, i) =>
            `<li><span class="ord">${i + 1}</span>` +
            `<span class="conn"><b>{${esc(ws.exitName(selected, e))}}</b> <span class="to">--${esc(ws.get(e).name)}--&gt;</span></span>` +
            `<button class="mini" data-move="${esc(selected)}|${esc(e)}|-1"${i === 0 ? ' disabled' : ''} title="move left on the gate">&#9650;</button>` +
            `<button class="mini" data-move="${esc(selected)}|${esc(e)}|1"${i === exits.length - 1 ? ' disabled' : ''} title="move right on the gate">&#9660;</button>` +
            `<button class="mini" data-cut="${esc(selected)}|${esc(e)}" title="remove this exit">&times;</button>` +
            `<span class="naming"><input class="exit-name" data-for="${esc(selected)}|${esc(e)}" value="${esc(ws.exitOwnName(selected, e))}" maxlength="24" placeholder="${esc(ws.get(e).name)}" />` +
            `<button class="mini" data-exitname="${esc(selected)}|${esc(e)}">name it</button></span></li>`,
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

  // THE RAMPS OFF THIS ROAD. Listed here rather than only out on the tarmac,
  // because a marker 4000 units down a road you have to drive to is not an
  // inventory -- and the one thing you cannot see from the road is that the ramp
  // you built lands in a network you are not looking at.
  const myRamps = ws.rampsOf(selected)
  const rampRows = myRamps.length
    ? myRamps
        .map((r) => {
          const to = ws.get(r.to)
          const net = ws.tenant(ws.tenantOf(r.to))
          const crosses = ws.tenantOf(r.to) !== ws.tenantOf(selected)
          return (
            `<li><span class="ord">${r.at}</span>` +
            `<span>${r.side > 0 ? '&rsaquo;' : '&lsaquo;'} ${esc(to?.name ?? r.to)}${crosses ? ` <b class="net">${esc(net?.name ?? '?')}</b>` : ''}</span>` +
            `<button class="mini" data-ramppage="${esc(selected)}|${r.at}" title="what this ramp is and where it goes">edit</button>` +
            `<button class="mini" data-cutramp="${esc(selected)}|${r.at}" title="remove this ramp">&times;</button></li>`
          )
        })
        .join('')
    : '<li class="empty">No ramps. Click a yellow dash out on the road, or build one here.</li>'
  const freeDash = firstFreeDash(selected)

  return (
    `<aside class="detail"><h2>${esc(n.name)}</h2>` +
    (n.open ? '' : '<p class="hint">This workspace is closed — its road is not laid.</p>') +
    (reachHint(selected) ?? '') +
    '<div class="field"><label>name</label>' +
    `<input id="ws-name" value="${esc(n.name)}" maxlength="24" data-id="${esc(selected)}" />` +
    `<button class="mini" data-rename="${esc(selected)}">set</button></div>` +
    '<div class="field"><label>lane</label>' +
    `<input id="ws-pos" type="number" min="1" max="${ws.list().length}" value="${n.pos}" data-id="${esc(selected)}" />` +
    `<button class="mini" data-pos="${esc(selected)}">set</button>` +
    // IT IS NO LONGER A KEYBOARD SHORTCUT, and the note said it was. The number
    // keys are tracks now; this is only where the road sits in the row, left to
    // right, which is still worth being able to change and is a different claim.
    '<span class="note">where this road sits, left to right &middot; swaps with whoever holds the number</span></div>' +
    `<h3>exits <span class="note">from ${esc(n.name)} &middot; in gate order</span></h3>` +
    `<ul class="exits">${exitRows}</ul>` +
    (candidates
      ? '<div class="field"><select id="ws-add">' + candidates + '</select>' +
        `<button class="mini" data-add="${esc(selected)}">add exit</button></div>`
      : '') +
    (inbound.length
      ? `<p class="note">reached from: ${inbound.map((w) => esc(w.name)).join(', ')}</p>`
      : '<p class="note">nothing leads here</p>') +
    '<h3>ramps <span class="note">off this road &middot; by dash</span></h3>' +
    `<ul class="exits ramps">${rampRows}</ul>` +
    `<button class="tidy" data-ramppage="${esc(selected)}|${freeDash}">build a ramp at dash ${freeDash}</button>` +
    '<h3>windows <span class="note">in road order &middot; nearest the entrance first</span></h3>' +
    `<ul class="wins">${list}</ul>` +
    // Only offered when there is something to close up. A button that reports
    // "nothing to do" is a button you press to find out, and this panel already
    // knows the answer.
    (roadHasGaps(selected)
      ? `<button class="tidy" data-tidy="${esc(selected)}">close up the gaps on this road</button>`
      : '') +
    (n.open && selected !== state.district
      ? `<button class="goto" data-goto="${esc(selected)}">drive to ${esc(n.name)}</button>`
      : '') +
    '</aside>'
  )
}

// A sentence about where the selection can go, in the panel, saying what the
// lighting on the graph means. The highlight is the fast answer and this is the
// one you can read -- and without it, a node lighting up because of a selection
// elsewhere is a colour change nobody has been told the rule for.
function reachHint(id) {
  const outs = ws.exitsOf(id)
  if (!outs.length) return null
  const open = outs.filter((e) => ws.get(e)?.open)
  const names = open.map((e) => esc(ws.get(e).name)).join(', ')
  if (!open.length) return `<p class="hint lit">Everything this road leads to is closed.</p>`
  return (
    `<p class="hint lit">Lit on the map: <b>${names}</b>. ` +
    'Click one and you drive there — the map stays open, so you can walk the network hop by hop.</p>'
  )
}

// The lowest dash on a road with no ramp on it AND no window in the way, so
// "build one" has somewhere to start rather than making you pick a number and then
// find out. Dash 0 is under your front bumper at the head of the road, so it starts
// a little way in.
//
// It gives up and returns a blocked slot rather than nothing: the page it opens
// says the slot is blocked and offers the alternative, which is a better answer
// than a button that has quietly stopped working.
function firstFreeDash(id, side = 1) {
  const taken = new Set(ws.rampsOf(id).map((r) => r.at))
  const total = dashCount(id)
  for (let i = 3; i < total; i++) if (!taken.has(i) && slotFree(id, side, i, 'ramp')) return i
  let i = 3
  while (taken.has(i)) i++
  return i
}

// Outward from where they asked, so the suggestion is the nearest change to what
// they wanted rather than the first slot on the road. Null when the whole road is
// blocked -- which is a real state on a road with windows down both sides, and the
// panel says so instead of offering a dash that is no better.
function nearestClearDash(id, at, total, side = 1) {
  const taken = new Set(ws.rampsOf(id).map((r) => r.at))
  const ok = (i) => i >= 0 && i < total && !taken.has(i) && slotFree(id, side, i, 'ramp')
  for (let step = 1; step < total; step++) {
    if (ok(at + step)) return at + step
    if (ok(at - step)) return at - step
  }
  return null
}

// -------------------------------------------------------------- the networks
//
// One page for all of them, because every question here is comparative: which
// one am I in, which others are there, is this one worth keeping. A per-network
// page would be four facts on five screens.
function networksPanel() {
  const rows = ws
    .tenantList()
    .map((t) => {
      const on = t.id === ws.activeTenantId()
      const roads = ws.report().tenants.find((x) => x.id === t.id)?.roads ?? 0
      const entry = ws.tenantEntry(t.id)
      return (
        `<li${on ? ' class="on"' : ''}>` +
        `<div class="row"><span class="pick" data-net="${esc(t.id)}">` +
        `<span class="addr">${esc(t.name)}${on ? ' &middot; you are here' : ''}</span>` +
        `<span class="meta">${roads} road${roads === 1 ? '' : 's'}${entry ? '' : ' &middot; nothing open'}</span>` +
        '</span></div>' +
        '<div class="moves">' +
        `<input class="rn" id="net-name-${esc(t.id)}" value="${esc(t.name)}" maxlength="24" data-id="${esc(t.id)}" />` +
        `<button class="mini" data-netname="${esc(t.id)}">rename</button>` +
        // The last network cannot go: there would be no active one and no layout
        // to lay. Refusing by not offering, rather than by failing on the click.
        (ws.tenantList().length > 1
          ? `<button class="mini shut" data-netcut="${esc(t.id)}" title="remove this network and all of its roads">&times;</button>`
          : '') +
        '</div></li>'
      )
    })
    .join('')

  return (
    '<aside class="detail">' +
    '<button class="back" data-unnet="1">&larr; the map</button>' +
    '<h2>networks</h2>' +
    // WHAT A NETWORK IS, said plainly, because this is the one concept in the
    // shell you cannot work out by looking at it: the other network's roads are
    // not drawn anywhere on this screen, by design.
    '<p class="hint">A network is a whole road layout of its own: its own workspaces, its own lane order, its own root. ' +
    'Only one is laid at a time — switching swaps every road in the world.</p>' +
    '<p class="hint">Windows on another network&rsquo;s roads stay open and stay where you left them. They are hidden while that network is not laid, because there is no road under them; switching back puts them straight back.</p>' +
    `<ul class="wins nets-list">${rows}</ul>` +
    '<div class="field"><label>new</label>' +
    '<input id="net-new" maxlength="24" placeholder="name it" />' +
    '<button class="mini" data-netadd="1">add network</button>' +
    '<span class="note">a new network starts with one road called home, because a network with no road is one you cannot visit</span></div>' +
    '<p class="note">To link the two, build a ramp: pick a workspace, then a dash on its road.</p>' +
    '</aside>'
  )
}

// ------------------------------------------------------------- one dash's page
//
// A dash is a place on a road, and this is everything you can do to a place: see
// where it is, say where it goes, take it, remove it.
//
// THE PICKER IS TWO STEPS -- network, then workspace -- and that is not a UI
// preference, it is the fact the board out on the road has to state as well: a
// workspace called `home` in another network is not identified by its name. One
// flat list of every workspace in every network would have four entries called
// home in it.
function rampPanel() {
  const road = ws.get(ramp.district)
  if (!road) return ''
  const existing = ws.rampAt(ramp.district, ramp.at)
  const total = dashCount(ramp.district)
  // Which side the page is about: the ramp's own if there is one, else whatever was
  // last picked here, else right. Held on `ramp` rather than in its own variable so
  // that opening a different dash starts the question again.
  const side = existing ? (existing.side > 0 ? 1 : -1) : (ramp.side ?? 1)
  // A slot that already carries this ramp is not "blocked by a window" -- the ramp
  // is why the window is not there.
  const blocked = !existing && !slotFree(ramp.district, side, ramp.at, 'ramp')
  const clear = blocked ? nearestClearDash(ramp.district, ramp.at, total, side) : null
  const past = dashZ(ramp.at) < exitZOf(ramp.district)
  const net = rampNet && ws.tenant(rampNet) ? rampNet : (existing ? ws.tenantOf(existing.to) : defaultRampNet())
  const inNet = ws.everyTenantsNodes().find((g) => g.tenant.id === net)?.nodes ?? []
  const targets = inNet.filter((n) => n.id !== ramp.district)

  return (
    '<aside class="detail">' +
    `<button class="back" data-back="${esc(ramp.district)}">&larr; ${esc(road.name)}</button>` +
    `<h2>dash ${ramp.at}</h2>` +
    `<dl class="facts">` +
    `<dt>road</dt><dd>${esc(road.name)} &middot; ${esc(ws.activeTenantName())}</dd>` +
    `<dt>where</dt><dd>${ramp.at + 1} of ${total} down the road &middot; z ${Math.round(dashZ(ramp.at))}</dd>` +
    // WHAT IS ON THIS MARKER, both sides at once. The dash is one thing on the
    // centre line and each side of the road is a separate place, so a page about a
    // dash has to answer for both -- otherwise "nothing here" means "nothing on the
    // side I happen to be asking about", which is how you build a window into the
    // side of a ramp.
    `<dt>left</dt><dd>${sideSummary(ramp.district, -1, ramp.at)}</dd>` +
    `<dt>right</dt><dd>${sideSummary(ramp.district, 1, ramp.at)}</dd>` +
    '</dl>' +
    // THE DASH BOX IS THE RAMP'S ADDRESS, so setting it MOVES THE RAMP.
    //
    // It only re-pointed the page, and was reported as doing nothing -- which is
    // exactly what "the heading changed and my ramp is still where it was" looks
    // like. On a slot that carries nothing there is nothing to move and it is still
    // only a way of looking at another slot, so the button says which of the two it
    // is about to do.
    '<div class="field"><label>dash</label>' +
    `<input id="ramp-at" type="number" min="0" max="${Math.max(0, total - 1)}" value="${ramp.at}" />` +
    `<button class="mini" data-rampat="1">${existing ? 'move the ramp there' : 'open that dash'}</button>` +
    `<button class="mini" data-drivedash="${esc(ramp.district)}|${ramp.at}">drive to dash ${ramp.at}</button>` +
    (existing ? '<span class="note">the ramp goes with it &middot; a dash that already carries one is refused</span>' : '') +
    '</div>' +
    // WHICH WAY IT LEAVES. Two buttons rather than a select, because it is a
    // two-state fact and the current state should be readable without opening
    // anything -- the same argument the window's "cross to the left" control wins.
    '<div class="field"><label>side</label>' +
    `<button class="mini${side < 0 ? ' on' : ''}" data-rampside="${esc(ramp.district)}|${ramp.at}|-1">&lsaquo; left</button>` +
    `<button class="mini${side > 0 ? ' on' : ''}" data-rampside="${esc(ramp.district)}|${ramp.at}|1">right &rsaquo;</button>` +
    (existing
      ? ''
      : '<span class="note">which side of the road this one will peel off</span>') +
    '</div>' +
    // WHETHER A WINDOW IS ALREADY IN THE WAY. A ramp sweeps out through the stretch
    // of verge a right-hand window stands in, so a slot can be free of ramps and
    // still be a bad place to build one -- and the only part of a ramp you read
    // from the road is its mouth.
    (blocked
      ? `<p class="hint warn">A window stands where a ${side < 0 ? 'left' : 'right'}-hand ramp would leave the road here. ` +
        (clear === null
          ? 'Every dash on this road is blocked — move or close a window first.'
          : `Dash <b>${clear}</b> is the nearest one that is clear.`) +
        (clear === null ? '' : ` <button class="mini" data-ramppage="${esc(ramp.district)}|${clear}">use dash ${clear}</button>`) +
        '</p>'
      : '') +
    (past ? '<p class="hint warn">This dash is past the exit gate, so the road stops short of it. Building a ramp here moves the gate out to meet it.</p>' : '') +

    '<h3>where it goes</h3>' +
    '<div class="field"><label>network</label>' +
    `<select id="ramp-net" data-rampnet="1">${ws
      .tenantList()
      .map(
        (t) =>
          `<option value="${esc(t.id)}"${t.id === net ? ' selected' : ''}>${esc(t.name)}${t.id === ws.activeTenantId() ? ' (this one)' : ''}</option>`,
      )
      .join('')}</select></div>` +
    '<div class="field"><label>road</label>' +
    (targets.length
      ? `<select id="ramp-to">${targets
          .map(
            (n) =>
              `<option value="${esc(n.id)}"${existing?.to === n.id ? ' selected' : ''}>${esc(n.name)}${n.open ? '' : ' (closed)'}</option>`,
          )
          .join('')}</select>`
      : '<span class="note">This network has nowhere else to land.</span>') +
    '</div>' +
    (targets.length
      ? `<button class="goto" data-buildramp="${esc(ramp.district)}|${ramp.at}|${side}">${existing ? 'point this ramp there' : 'build the ramp'}</button>`
      : '') +
    (existing
      ? `<button class="goto take" data-takeramp="${esc(existing.to)}">take it &mdash; drive to ${esc(ws.get(existing.to)?.name ?? existing.to)}</button>` +
        `<button class="danger" data-cutramp="${esc(ramp.district)}|${ramp.at}">remove this ramp</button>`
      : '') +
    '<p class="note">A ramp peels off the road at its dash and carries a board naming the network it lands in. Clicking that board out on the road drives you there.</p>' +

    // ---- the other thing a marker can hold -------------------------------
    //
    // A WINDOW AND A RAMP ARE PLACED THE SAME WAY NOW, so the page that places one
    // places the other. This is the whole point of putting windows on the dash grid:
    // before, "open a window" was a button on a gate that put it wherever the counter
    // had got to, and "build a ramp" was a dash you pointed at. Two ways of saying
    // where, for two things standing on one road.
    '<h3>a window here</h3>' +
    // ONLY ON THE ROAD YOU ARE STANDING ON, and the button is withheld rather than
    // made to fail. `spawnWindow` puts a window on `state.district` -- that is where
    // the compositor is pointed and there is deliberately no second placement rule --
    // so offering it from a page about another road asks about dash 14 over there and
    // opens a window at dash 14 over HERE. Measured exactly that: the page said
    // `build`, the window arrived on `home`.
    (ramp.district !== state.district
      ? `<p class="note">This is another road. A window opens onto the one you are standing on, so drive to <b>${esc(road.name)}</b> first &mdash; the button above will do it.</p>`
      : [-1, 1]
      .map((sd) => {
        const dash = ramp.at
        const here = slotAt(ramp.district, sd, dash)
        const free = slotFree(ramp.district, sd, dash, 'window')
        const name = sd < 0 ? '&lsaquo; left' : 'right &rsaquo;'
        if (here?.kind === 'window') {
          return (
            `<p class="note">${name}: <b>window ${here.milepost}</b> stands here. ` +
            `<button class="mini" data-enterwin="${esc(ramp.district)}|${here.milepost}">open its page</button></p>`
          )
        }
        if (!free) {
          return dash < SLOT_FIRST
            ? `<p class="note">${name}: dash ${SLOT_FIRST} is the first a window may stand on &mdash; the road keeps a clear run past the entrance.</p>`
            : `<p class="note">${name}: no room &mdash; something is standing within ${SLOT_GAP} dashes, or a ramp sweeps through here.</p>`
        }
        return `<button class="goto open" data-openwin="${esc(ramp.district)}|${ramp.at}|${sd}">open a window on the ${sd < 0 ? 'left' : 'right'}</button>`
      })
          .join('')) +
    '</aside>'
  )
}

// One line saying what occupies a dash on one side, for the page's facts list.
function sideSummary(district, side, dash) {
  const here = slotAt(district, side, dash)
  if (here?.kind === 'ramp') {
    const to = ws.get(here.to)
    return `a ramp to <b>${esc(to?.name ?? here.to)}</b> in ${esc(ws.tenant(ws.tenantOf(here.to))?.name ?? '?')}`
  }
  if (here?.kind === 'window') return `<b>window ${here.milepost}</b>`
  if (slotFree(district, side, dash, 'window')) return 'free'
  // Two different refusals, and telling them apart is the difference between "move
  // something" and "you cannot put a window this close to the gate at all".
  return dash < SLOT_FIRST ? 'too near the entrance for a window' : 'crowded'
}

// The network the picker opens on: the first one that is NOT the one you are in,
// because crossing is the thing a ramp is for and the same-network case is the
// one you can already do with an exit. Falls back to the current one when there
// is only one network -- a ramp within a network is legal and is a shortcut past
// the exit gate.
function defaultRampNet() {
  const other = ws.tenantList().find((t) => t.id !== ws.activeTenantId())
  return (other ?? ws.tenantList()[0])?.id ?? null
}

// ----------------------------------------------------------- one track's page
//
// A track has exactly three facts about it -- what it is called, where it is
// parked, and where it has been -- and the third is the one that could not be
// seen at all before. The trail is drawn newest first, because the question you
// have about a trail is almost always "and before that?".
function trackPanel() {
  const t = tracks.get(track)
  if (!t) return ''
  const here = t.id === tracks.activeIndex()
  const at = t.at ? ws.get(t.at) : null
  const trail = [...t.history].reverse()
  return (
    '<aside class="detail">' +
    '<button class="back" data-untrack="1">&larr; the network</button>' +
    `<h2>track ${t.id}${t.name ? ` &middot; ${esc(t.name)}` : ''}</h2>` +
    (here ? '<p class="here">This is the track you are on.</p>' : '') +
    // NAMING IS THE ASK, and this is the only place it happens. The chips are
    // twelve characters wide and a text box in one would be a text box you
    // cannot read what you typed into.
    '<div class="field"><label>name</label>' +
    `<input id="tr-name" value="${esc(t.name)}" maxlength="20" placeholder="unnamed" data-id="${t.id}" />` +
    `<button class="mini" data-trackname="${t.id}">set</button></div>` +
    '<dl class="facts">' +
    `<dt>parked</dt><dd>${at ? esc(at.name) : 'nowhere yet &mdash; starts at the root'}</dd>` +
    `<dt>trail</dt><dd>${t.history.length} step${t.history.length === 1 ? '' : 's'}</dd>` +
    '</dl>' +
    (trail.length
      ? '<h3>where it has been <span class="note">newest first</span></h3><ol class="trail">' +
        trail.map((id) => `<li>${esc(ws.get(id)?.name ?? id)}</li>`).join('') +
        '</ol>'
      : '<p class="note">Nothing behind it yet. Drive somewhere and this fills up.</p>') +
    (here
      ? '<p class="note">Press its number, or any other, to switch tracks.</p>'
      : `<button class="goto" data-track="${t.id}">switch to it</button>`) +
    '</aside>'
  )
}

// ------------------------------------------------------- one window's page
//
// Everything the shell knows about one window and everything it can do to it,
// in the order you would ask: what is it, where is it, put it somewhere else,
// take me to it, close it.
//
// It is deliberately NOT a floating thing over the graph. The graph is still
// there beside it and still says where this window's road sits in the network,
// which is most of the context for deciding to move it.
function windowPanel() {
  const s = signAt(focus.district, focus.milepost)
  const home = ws.get(s.district)
  const addr = `${esc(s.district)}|${s.milepost}`
  // MODE FIRST. `flatDistrict`/`flatMilepost` are only cleared by release(), and
  // driving to another workspace does not release -- so the address outlives the
  // state it describes, and a panel that trusted it alone claimed you were
  // standing in a window you had driven away from. syncHandles has always tested
  // the mode; this is the same test in the other place that reads the pair.
  const inIt = standingIn(s)
  const side = s.side > 0 ? 'right' : 'left'
  // THE WHOLE ROAD, not this window's side of it -- see nudgeWindowAlong. The
  // panel's arrows must be enabled by the same rule the move refuses on, or they
  // are grey when it would work and live when it would not.
  const road = windowsOf(s.district)
  const i = road.indexOf(s)
  const mine = windowsOf(s.district).filter((x) => x.side === s.side)
  const onSide = mine.indexOf(s)
  const elsewhere = ws.list().filter((w) => w.id !== s.district && w.open)

  return (
    '<aside class="detail">' +
    `<button class="back" data-back="${esc(s.district)}">&larr; ${esc(home?.name ?? s.district)}</button>` +
    `<h2>${esc(labelOf(s))}</h2>` +
    (inIt ? '<p class="here">You are standing in this window. Closing the map puts you back in it.</p>' : '') +
    // NAME IT YOURSELF. A client names its own window and often names it badly,
    // or names five of them the same thing. Empty falls back to whatever the
    // client is calling itself, so clearing the box is how you undo it rather
    // than a second control.
    '<div class="field"><label>name</label>' +
    `<input id="win-name" value="${esc(myName(s))}" maxlength="40" placeholder="${esc(clientName(s))}" data-id="${addr}" />` +
    `<button class="mini" data-winname="${addr}">set</button>` +
    '<span class="note">yours, over whatever the client calls it &middot; empty to use the client&rsquo;s</span></div>' +
    '<dl class="facts">' +
    `<dt>address</dt><dd>${esc(home?.name ?? s.district)}:${s.milepost}</dd>` +
    `<dt>road</dt><dd>${esc(home?.name ?? s.district)} &middot; lane ${home?.pos ?? '?'}</dd>` +
    `<dt>place</dt><dd>${i + 1} of ${road.length} along the road &middot; ${side} side, ${onSide + 1} of ${mine.length}</dd>` +
    `<dt>size</dt><dd>${s.size ? `${s.size.width}&times;${s.size.height}` : 'no buffer yet'}</dd>` +
    '</dl>' +

    '<h3>where it stands</h3>' +
    '<div class="moves">' +
    `<button class="mini" data-along="${addr}|-1"${i > 0 ? '' : ' disabled'} title="one place nearer the entrance">&#9650; nearer</button>` +
    `<button class="mini" data-along="${addr}|1"${i < road.length - 1 ? '' : ' disabled'} title="one place further down the road">&#9660; further</button>` +
    `<button class="mini" data-flip="${addr}">&#8644; cross to the ${s.side > 0 ? 'left' : 'right'}</button>` +
    '</div>' +
    (elsewhere.length
      ? '<div class="field"><select data-dest="' + addr + '"><option value="">move to another road&hellip;</option>' +
        elsewhere.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('') +
        '</select></div>'
      : '<p class="note">There is nowhere else open to move it to.</p>') +
    '<p class="note">Or drag its row, or this window, onto a workspace on the map.</p>' +

    // THE PAIR IS "BACK INTO IT" AND "OPEN ITS PAGE", and both end up in the
    // window. This one said "drive to it" and put you on the tarmac outside with
    // the thing you had just been reading about still shut -- asked for twice now,
    // once here and once on the dash page, so it is the same control with the same
    // words as that one rather than a second vocabulary for one act.
    //
    // WHAT THIS COSTS, PLAINLY: the road view of a chosen window -- standing back
    // far enough to see it among its neighbours, which `goWindow` computes from the
    // sign's own geometry -- is no longer reachable from the map at all. This was
    // its last button. `goWindow` itself is untouched and still live: moving a
    // window while you are driving its road follows it (shell.js), which is the
    // case it was written for. The `[data-win]` branch below is what it was wired
    // to from here, and nothing in here now emits one outside the `.wins` rows --
    // where the earlier branch claims it first. Left standing rather than deleted
    // because `go.window` is part of the handler contract shell.js fills in.
    '<h3>and what to do with it</h3>' +
    (inIt
      ? '<button class="goto" data-shutmap="1">back into it</button>'
      : `<button class="goto" data-enterwin="${addr}">open its page</button>`) +
    shutPrompt(addr, true, true) +
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
    state.mode === 'flat' ? `${state.flatDistrict}:${state.flatMilepost}` : '',
    focus ? `${focus.district}:${focus.milepost}` : '',
    // WHICH PAGE IS OPEN, and which network. The graph below can be identical
    // across a network switch (two networks with three roads each), and every
    // page except the workspace one is invisible to a signature built out of the
    // graph -- so without these the poll would put the old page back over the new
    // one on its next tick.
    `${ws.activeTenantId()}#${netPage ? 'nets' : ''}#${ramp ? `${ramp.district}:${ramp.at}:${ramp.side ?? ''}` : ''}#${rampNet ?? ''}`,
    // The unanswered close, for the same reason as the pages above it: the graph
    // does not move when a question is asked, so a signature that could not see it
    // would let the 700ms poll put the plain `×` back over the prompt -- and the
    // click that was about to answer would land on "ask" again.
    confirmShut ?? '',
    ws.tenantList().map((t) => `${t.id}=${t.name}`).join(','),
    // A rename changes nothing about the graph, so without this the panel that
    // renamed it goes on showing the old name until something else moves.
    [...renames.entries()].map(([k, v]) => `${k}=${v}`).join(','),
    ws
      .list()
      .map(
        (n) =>
          `${n.id}:${n.pos}:${n.name}:${n.open}:${n.exits.map((e) => `${e}=${ws.exitName(n.id, e)}`).join('>')}:${windowsOf(n.id).length}` +
          // Ramps are drawn in the panel and counted on the page, and building one
          // changes nothing else about the graph -- so a signature that could not
          // see them left the list you had just added to unchanged.
          `:${ws.rampsOf(n.id).map((r) => `${r.at}${r.side > 0 ? 'r' : 'l'}>${r.to}`).join('+')}`,
      )
      .join('|'),
    // WHERE the windows are, not just how many. A window crossing the road or
    // swapping with its neighbour changes nothing the old signature could see,
    // so the panel would go on showing the arrangement from before the move --
    // and a control whose own display does not react is a control you press
    // twice.
    windowsOf(selected)
      .map((s) => `${s.milepost}${s.side > 0 ? 'r' : 'l'}${s.dash}`)
      .join(','),
    // The bar is drawn from the tracks, so it goes stale unless the signature
    // can see them change -- and they change from the KEYBOARD, which the map
    // never hears about.
    `${track}#${tracks.activeIndex()}#` +
      tracks.list().map((t) => `${t.name}@${t.at}:${t.history.length}`).join(','),
  ].join('#')
}

function render(force = false) {
  const s = sig()
  if (!force && s === signature) return
  signature = s
  el.innerHTML = draw()
  applyView()
}

// The one place the view reaches the screen. Called after every render and
// after every pan and zoom -- and it is the whole of a pan and a zoom, which is
// the point: one attribute, no layout, no markup.
function applyView() {
  const box = el?.querySelector('.graph')
  const svg = box?.querySelector('svg')
  if (!box || !svg) return
  port = { w: box.clientWidth || port.w, h: box.clientHeight || port.h }
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${port.w / view.k} ${port.h / view.k}`)
  const pct = box.querySelector('.pct')
  if (pct) pct.textContent = `${Math.round(view.k * 100)}%`
}

// THE WHOLE NETWORK, with a margin, however big it has got. The clamp is what
// makes this honest at scale: past a few dozen workspaces the fit is smaller
// than K_MIN and this shows you the top-left of the network rather than a
// smear -- which is a real answer, and panning is the other half of it.
function fitView() {
  const k = clampK(Math.min(port.w / (bounds.width + 40), port.h / (bounds.height + 40)))
  view = {
    k,
    x: bounds.width / 2 - port.w / (2 * k),
    y: bounds.height / 2 - port.h / (2 * k),
  }
}

// Put one node in the middle WITHOUT changing how far in you are. Zoom is a
// decision about how much you want to see and it survives being taken somewhere;
// only fit is allowed to overrule it.
function centreOn(id) {
  const p = spots.get(id)
  if (!p) return fitView()
  view.x = p.x - port.w / (2 * view.k)
  view.y = p.y - port.h / (2 * view.k)
}

function zoomBy(factor, px = port.w / 2, py = port.h / 2) {
  // Zoom about a POINT: the graph coordinate under the pointer has to still be
  // under the pointer afterwards, or zooming in on the thing you are looking at
  // walks it off the screen and you pan it back every time.
  const k = clampK(view.k * factor)
  if (k === view.k) return
  const wx = view.x + px / view.k
  const wy = view.y + py / view.k
  view = { k, x: wx - px / k, y: wy - py / k }
  applyView()
}

// ------------------------------------------------------------------ the view

const CSS = `
#map { position: fixed; inset: 0; z-index: 6; overflow: hidden;
  background: rgba(3,4,10,.86); backdrop-filter: blur(2px);
  font: 12px/1.5 ui-monospace, monospace; color: #f3ead4; }
#map .wrap { display: flex; align-items: stretch; gap: 24px; height: 100%; padding: 20px; box-sizing: border-box; }
/* The graph is a WINDOW ONTO the network now, so it clips and never scrolls:
   the viewBox is the scroll position and a scrollbar as well would be two
   controls arguing over one thing. min-width:0 because a flex item defaults to
   min-content and the svg would otherwise refuse to shrink. */
#map .graph { flex: 1 1 auto; position: relative; overflow: hidden; min-width: 0;
  border: 1px solid #16233a; background: rgba(7,11,20,.5); }
#map svg { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
#map .graph.panning svg { cursor: grabbing; }
/* THE TRACK BAR sits INSIDE the graph box, over the top of it, for the same
   reason the zoom controls sit over the bottom: the graph is the thing that
   should get the space, and both of these are one row of chrome each. */
#map .tracks { position: absolute; left: 8px; right: 8px; top: 40px; z-index: 2;
  display: flex; gap: 4px; flex-wrap: wrap; }
/* THE NETWORK BAR sits above the tracks because it is the outer thing: a track is
   inside a network, and the graph below is one network's graph. */
#map .nets { position: absolute; left: 8px; right: 8px; top: 8px; z-index: 2;
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
#map .nets .lbl { color: #6b7689; padding-right: 2px; }
#map .nets .chip { cursor: pointer; background: rgba(11,18,32,.9); border: 1px solid #24304a;
  color: #6b7689; font: inherit; padding: 3px 8px; max-width: 180px; }
#map .nets .chip:hover { border-color: #2de2e6; color: #f3ead4; }
#map .nets .chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The one you are IN is amber, the same as the active track and "you are here" --
   one idea of "this is where you are" and one colour for it. */
#map .nets .chip.on { border-color: #f2c14e; color: #f2c14e; }
#map .nets .chip.add { color: #9fb0c8; }
#map .nets-list li.on .addr { color: #f2c14e; }
#map .nets-list .rn { flex: 1 1 60px; min-width: 0; background: #0b1220; border: 1px solid #24304a;
  color: #f3ead4; font: inherit; padding: 3px 5px; }
#map .tracks .chip { cursor: pointer; display: flex; align-items: baseline; gap: 5px;
  background: rgba(11,18,32,.9); border: 1px solid #24304a; color: #6b7689;
  font: inherit; padding: 3px 8px; max-width: 150px; }
#map .tracks .chip:hover { border-color: #2de2e6; color: #f3ead4; }
#map .tracks .chip .no { font-weight: 700; }
#map .tracks .chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The one you are ON is amber, the same colour "you are here" uses on a node --
   there is one idea of "this is where you are" in this map and it should not be
   two colours. The sel class is only which page is open -- a weaker thing.
   (No backticks in here: this whole stylesheet is a template literal.) */
#map .tracks .chip.on { border-color: #f2c14e; color: #f2c14e; }
#map .tracks .chip.sel { background: #1a2740; color: #f3ead4; }
#map .node .trk { text-anchor: end; font-size: 12px; font-weight: 700; fill: #f2c14e; }
#map .trail { margin: 0 0 10px; padding-left: 22px; color: #9fb0c8; }
#map .trail li { padding: 1px 0; }
#map .zoomers { position: absolute; left: 8px; bottom: 8px; display: flex; align-items: center; gap: 4px; }
#map .zoomers button { cursor: pointer; background: rgba(11,18,32,.9); border: 1px solid #24304a;
  color: #f3ead4; font: inherit; padding: 3px 9px; }
#map .zoomers button:hover { border-color: #2de2e6; }
#map .zoomers .pct { color: #6b7689; min-width: 42px; text-align: center; }
#map .edge { fill: none; stroke: #4d5a72; stroke-width: 2; }
/* WHERE THE SELECTION CAN GO. The edge and the node it lands on are lit together:
   an arrow is only worth lighting if you can see which box it arrives in. */
#map .edge.lit { stroke: #2de2e6; stroke-width: 3.5; }
#map .node rect { fill: #0b1220; stroke: #2de2e6; stroke-width: 2; cursor: pointer; }
#map .node:hover rect { fill: #142033; }
#map .node.here rect { stroke: #f2c14e; stroke-width: 3; }
#map .node.sel rect { fill: #1a2740; }
/* A reachable one is filled rather than outlined, because the outline is already
   carrying "you are here" and "closed" and a third meaning on the same stroke is
   three things nobody can tell apart. */
#map .node.reach rect { fill: #10283a; stroke-width: 3; }
#map .node.go rect { fill: #123647; }
#map .node.go:hover rect { fill: #1a4f66; stroke: #7ef2f5; }
#map .node .gox { font-size: 11px; font-weight: 700; fill: #2de2e6; }
#map .detail .hint.lit { color: #cfe6ea; border-left: 2px solid #2de2e6; padding-left: 8px; }
/* A warning, not an error: the thing you asked for is possible and is a bad idea,
   and the panel says which slot is better rather than refusing. */
#map .detail .hint.warn { color: #f2c14e; border-left: 2px solid #f2c14e; padding-left: 8px; }
#map .detail .hint.warn b { color: #f3ead4; }
#map .detail .hint.warn .mini { margin-left: 4px; }
#map .detail .hint.lit b { color: #2de2e6; }
#map .exits.ramps .net { color: #2de2e6; font-weight: 700; }
#map .exits .mini.shut, #map .nets-list .mini.shut { color: #ff6b6b; }
#map .detail .goto.take { background: #0b4a6b; }
/* Opening a window is not travelling, so it is not the green "go" -- it is the
   blue the enter gate already uses for the two controls that do exactly this. */
#map .detail .goto.open { background: #12386e; margin-top: 6px; }
#map .node.shut rect { stroke: #4d5a72; stroke-dasharray: 5 4; }
#map .node text { text-anchor: middle; pointer-events: none; font: 14px ui-monospace, monospace; fill: #f3ead4; }
#map .node .nm { font-weight: 700; font-size: 16px; }
#map .node .ct { font-size: 12px; fill: #9fb0c8; }
#map .node.shut .ct { fill: #6b7689; }
#map .node .you { font-size: 11px; fill: #f2c14e; }
#map .node .no { text-anchor: start; font-size: 12px; font-weight: 700; fill: #6b7689; }
#map .node.here .no { fill: #f2c14e; }
#map .node.drop rect { stroke: #7ef29a; stroke-width: 4; fill: #10301f; }
#map .node.nodrop rect { stroke: #b04a4a; stroke-dasharray: 4 4; }
/* The panel scrolls itself now that the page does not: a workspace with a dozen
   windows on it makes a taller list than the screen, and the graph beside it
   must not be pushed off the bottom to make room. */
#map .detail { flex: 0 0 360px; border: 1px solid #24304a; background: #070b14; padding: 14px 16px;
  box-sizing: border-box; overflow: auto; }
#map .detail h2 { margin: 0 0 8px; font-size: 18px; color: #f2c14e; }
#map .detail .hint { margin: 0 0 10px; color: #9fb0c8; }
#map .detail .keys { margin: 14px 0 0; color: #6b7689; }
#map .wins { list-style: none; margin: 0; padding: 0; }
#map .wins li { margin: 0 0 10px; }
#map .wins li.empty { color: #6b7689; }
#map .wins li { cursor: grab; user-select: none; touch-action: none; }
#map .wins li.lifting { cursor: grabbing; opacity: .55; }
#map .wins li.drop { outline: 2px solid #7ef29a; outline-offset: 3px; }
#map .wins li.nodrop { outline: 1px dashed #b04a4a; outline-offset: 3px; }
#map .wins .pick { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: center;
  cursor: pointer; background: #0b1220; border: 1px solid #24304a; color: #f3ead4;
  padding: 8px 10px; }
#map .wins .pick:hover { background: #16233a; border-color: #2de2e6; }
#map .detail .back { cursor: pointer; background: none; border: 0; color: #9fb0c8;
  font: inherit; padding: 0 0 6px; }
#map .detail .back:hover { color: #2de2e6; }
#map .detail .here { margin: 0 0 10px; color: #f2c14e; }
#map .facts { display: grid; grid-template-columns: 72px 1fr; gap: 2px 8px; margin: 0 0 6px; }
#map .facts dt { color: #6b7689; }
#map .facts dd { margin: 0; }
#map .detail .danger { margin-top: 6px; width: 100%; cursor: pointer; background: #2a1418;
  border: 1px solid #ff6b6b; color: #ff6b6b; padding: 8px 10px; font: inherit; }
#map .detail .danger:hover { background: #3a1a20; }
/* The prompt that stands where the close button was. Boxed in the same red as the
   button it replaced, so it reads as that control having changed its mind rather
   than as a new thing that has appeared somewhere. */
#map .detail .shutting { margin-top: 6px; border: 1px solid #ff6b6b; background: #1a0f13;
  padding: 8px 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#map .detail .shutting .note { flex: 1 1 100%; margin: 0; color: #e6a0a0; }
#map .detail .shutting .mini { flex: 1 1 0; }
#map .detail .shutting .danger { margin-top: 0; flex: 1 1 0; width: auto; padding: 4px 8px; }
#map .wins li.focus { outline: 1px solid #f2c14e; outline-offset: 4px; }
#map .wins li.focus .addr { color: #f2c14e; }
#map .wins .row { display: flex; align-items: stretch; }
#map .wins .grip { flex: 0 0 auto; display: flex; align-items: center; cursor: grab;
  padding: 0 6px; color: #6b7689; border: 1px solid #24304a; border-right: 0;
  background: #0b1220; letter-spacing: -2px; }
#map .wins .grip:hover { color: #2de2e6; border-color: #2de2e6; }
#map .wins .grip:active { cursor: grabbing; }
#map .wins .row button { display: block; flex: 1 1 auto; text-align: left; cursor: pointer;
  background: #0b1220; border: 1px solid #24304a; color: #f3ead4; padding: 8px 10px;
  font: inherit; }
#map .wins .row button:hover:not(:disabled) { background: #16233a; border-color: #2de2e6; }
#map .wins button:disabled { opacity: .45; cursor: default; }
#map .wins .addr { display: block; font-weight: 700; }
#map .wins .meta { display: block; color: #9fb0c8; }
#map .wins .moves { display: flex; gap: 4px; margin-top: 3px; }
#map .wins .moves .mini { padding: 3px 7px; }
#map .wins .moves .shut { color: #ff6b6b; }
#map .wins .moves .shut:hover:not(:disabled) { border-color: #ff6b6b; background: #2a1418; }
#map .wins .moves .mini:disabled { opacity: .3; cursor: default; border-color: #24304a; }
#map .wins .moves select { flex: 1 1 auto; min-width: 0; background: #0b1220;
  border: 1px solid #24304a; color: #f3ead4; font: inherit; padding: 3px 5px; }
#map .wins .moves select:disabled { opacity: .3; }
#map .field { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; flex-wrap: wrap; }
#map .field label { flex: 0 0 42px; color: #9fb0c8; }
#map .field input, #map .field select { flex: 1 1 60px; min-width: 0; background: #0b1220;
  border: 1px solid #24304a; color: #f3ead4; font: inherit; padding: 5px 7px; }
#map .field input:focus, #map .field select:focus { outline: none; border-color: #2de2e6; }
#map .mini { cursor: pointer; background: #16233a; border: 1px solid #24304a; color: #f3ead4;
  font: inherit; padding: 5px 9px; }
#map .mini:hover { border-color: #2de2e6; }
/* The side a ramp leaves by is a two-state fact, so the two buttons show which
   state it is in rather than making you read it somewhere else. */
#map .mini.on { background: #123647; border-color: #2de2e6; color: #2de2e6; }
#map h3 { margin: 14px 0 6px; font-size: 13px; color: #9fb0c8; font-weight: 700; }
#map .note { color: #6b7689; margin: 0 0 8px; flex-basis: 100%; }
#map .exits { list-style: none; margin: 0 0 8px; padding: 0; }
#map .exits li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
#map .exits li span { flex: 1 1 auto; }
#map .exits .ord { flex: 0 0 16px; color: #6b7689; }
#map .exits .mini { padding: 3px 7px; }
#map .exits .mini:disabled { opacity: .3; cursor: default; border-color: #24304a; }
#map .exits li.empty { color: #6b7689; }
/* The row wraps: the connection and its three buttons on one line, the name box on
   the next. Wrapping rather than shrinking, because a name box narrow enough to sit
   beside four other controls is one you cannot read what you typed in. */
#map .exits li { flex-wrap: wrap; }
#map .exits .conn { flex: 1 1 auto; min-width: 0; }
#map .exits .conn b { color: #e8edf6; font-weight: 700; }
#map .exits .conn .to { color: #f2c14e; }
#map .exits .naming { flex: 1 1 100%; display: flex; gap: 6px; padding-left: 24px; }
#map .exits .naming input { flex: 1 1 auto; min-width: 0; background: #0b1220;
  border: 1px solid #24304a; color: #cfe3ff; font: inherit; padding: 3px 6px; }
#map .exits .naming input::placeholder { color: #4d5a72; }
#map .tidy { margin-top: 4px; width: 100%; cursor: pointer; background: #16233a;
  border: 1px solid #24304a; color: #9fb0c8; padding: 6px 10px; font: inherit; }
#map .tidy:hover { border-color: #2de2e6; color: #f3ead4; }
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

  installViewInput()
  installDragInput()

  el.addEventListener('click', (ev) => {
    // A PAN ENDS IN A CLICK, and it must not also be a selection. The pointer
    // came down on a node, moved 200 units with the network under it, and came
    // up somewhere else -- the browser still calls that a click on whatever is
    // under it at the end. Only a drag that actually moved swallows one.
    if (swallowClick) {
      swallowClick = false
      return
    }
    const zoom = ev.target.closest('[data-zoom]')
    if (zoom) {
      const what = zoom.dataset.zoom
      if (what === 'in') zoomBy(1.3)
      else if (what === 'out') zoomBy(1 / 1.3)
      else if (what === 'fit') fitView(), applyView()
      else if (what === 'here') centreOn(state.district), applyView()
      return
    }
    const along = ev.target.closest('[data-along]')
    if (along) {
      const [district, mp, d] = along.dataset.along.split('|')
      go.move?.along?.(district, Number(mp), Number(d))
      return render(true)
    }
    // ASK, ANSWER, ANSWER. Three attributes rather than one that toggles, so a
    // stray click can only ever move this one step in one direction: `data-shut`
    // raises the question, and nothing but `data-shutyes` closes anything.
    const shut = ev.target.closest('[data-shut]')
    if (shut) {
      confirmShut = shut.dataset.shut
      return render(true)
    }
    if (ev.target.closest('[data-shutno]')) {
      confirmShut = null
      return render(true)
    }
    const shutYes = ev.target.closest('[data-shutyes]')
    if (shutYes) {
      const [district, mp] = shutYes.dataset.shutyes.split('|')
      confirmShut = null
      go.close?.(district, Number(mp))
      // Re-render so the prompt goes, but NOT because the window went: it has been
      // ASKED, not closed. It leaves the list when its surface actually goes, which
      // the 700ms poll picks up -- a row that vanished on the click would be
      // claiming the client agreed.
      return render(true)
    }
    // Naming a lane. The box is found by walking UP TO THE ROW and back down,
    // never by id or by matching its address: there is one of these per exit, so a
    // `#exit-name` would match the first row and rename the wrong edge -- and an
    // attribute selector built from the address needs escaping, which is how this
    // first shipped and how it first broke. (`CSS.escape` does not exist in every
    // browser this shell runs in, and a click handler that throws stops handling
    // everything after it in the same listener.) The row is the relationship the
    // markup already encodes; asking it is both shorter and unbreakable.
    const exitname = ev.target.closest('[data-exitname]')
    if (exitname) {
      const [from, to] = exitname.dataset.exitname.split('|')
      const box = exitname.closest('li')?.querySelector('.exit-name')
      ws.nameExit(from, to, box?.value ?? '')
      return render(true)
    }
    const tidy = ev.target.closest('[data-tidy]')
    if (tidy) {
      go.move?.tidy?.(tidy.dataset.tidy)
      return render(true)
    }
    const flip = ev.target.closest('[data-flip]')
    if (flip) {
      const [district, mp] = flip.dataset.flip.split('|')
      go.move?.side?.(district, Number(mp))
      return render(true)
    }
    // ---- the networks ----------------------------------------------------
    //
    // Before the track chips, because both are chips in a bar at the top and both
    // are matched with closest() -- and `[data-net]` on a workspace row inside the
    // networks page would otherwise fall through to whichever matched first.
    const net = ev.target.closest('[data-net]')
    if (net) {
      const to = net.dataset.net
      const entry = ws.tenantEntry(to)
      // SWITCHING IS DRIVING SOMEWHERE. It goes through the same journey every
      // other arrival takes -- so the track records it, the network remembers the
      // road, and the flattened window is let go of. A network with nothing open
      // is refused rather than half-entered: selecting it would leave the camera
      // over a gap.
      if (entry) {
        go.exit?.(entry)
        selected = entry
        onlyPage(null)
        render(true)
        centreOn(selected)
        applyView()
      } else {
        // Nothing open there, so nowhere to arrive -- but the page you would fix
        // that on is the networks page, so say so by going to it.
        netPage = true
        render(true)
      }
      return
    }
    if (ev.target.closest('[data-netpage]')) {
      onlyPage('networks')
      return render(true)
    }
    if (ev.target.closest('[data-unnet]')) {
      netPage = false
      selected = ws.has(selected) ? selected : state.district
      return render(true)
    }
    const netname = ev.target.closest('[data-netname]')
    if (netname) {
      ws.renameTenant(netname.dataset.netname, el.querySelector(`#net-name-${netname.dataset.netname}`)?.value)
      return render(true)
    }
    if (ev.target.closest('[data-netadd]')) {
      const made = ws.addTenant(el.querySelector('#net-new')?.value)
      state.lastNetworkAdd = made ? { id: made.id, name: made.name } : null
      return render(true)
    }
    const netcut = ev.target.closest('[data-netcut]')
    if (netcut) {
      const doomed = netcut.dataset.netcut
      // REMOVING THE ONE YOU ARE STANDING IN MEANS LEAVING FIRST. removeTenant
      // picks a survivor and makes it active, but nothing has driven there -- the
      // camera would be parked on a road that no longer exists. So drive, then
      // remove, in that order.
      if (doomed === ws.activeTenantId()) {
        const survivor = ws.tenantList().find((t) => t.id !== doomed)
        const entry = survivor ? ws.tenantEntry(survivor.id) : null
        if (!entry) return
        go.exit?.(entry)
        selected = entry
      }
      ws.removeTenant(doomed)
      tracks.prune()
      return render(true)
    }

    // ---- the ramps -------------------------------------------------------
    const ramppage = ev.target.closest('[data-ramppage]')
    if (ramppage) {
      const [district, at] = ramppage.dataset.ramppage.split('|')
      onlyPage('ramp')
      ramp = { district, at: Number(at) }
      rampNet = null
      return render(true)
    }
    const cutramp = ev.target.closest('[data-cutramp]')
    if (cutramp) {
      const [district, at] = cutramp.dataset.cutramp.split('|')
      ws.cutRamp(district, Number(at))
      // Stay on the dash's page rather than jumping back: the slot still exists
      // and building a different ramp on it is the likely next move.
      return render(true)
    }
    const buildramp = ev.target.closest('[data-buildramp]')
    if (buildramp) {
      const [district, at, s] = buildramp.dataset.buildramp.split('|')
      const to = el.querySelector('#ramp-to')?.value
      state.lastRampBuild = {
        district,
        at: Number(at),
        to,
        side: Number(s),
        ok: !!to && ws.addRamp(district, Number(at), to, Number(s)),
      }
      return render(true)
    }
    if (ev.target.closest('[data-rampat]')) {
      const want = Number(el.querySelector('#ramp-at')?.value)
      if (!Number.isInteger(want) || want < 0 || !ramp) return render(true)
      // THE DASH NUMBER IS THE RAMP'S ADDRESS, so this moves the ramp and the page
      // follows it. On an empty slot there is nothing to move and it is only a way
      // of looking somewhere else.
      const carries = ws.rampAt(ramp.district, ramp.at)
      const moved = carries ? ws.moveRamp(ramp.district, ramp.at, want) : true
      state.lastRampMove = carries ? { from: ramp.at, to: want, ok: moved } : null
      // A refused move leaves the page where the ramp still is, so the refusal is
      // visible as the number snapping back rather than as a silent no.
      if (moved) ramp = { ...ramp, at: want }
      return render(true)
    }
    const rampside = ev.target.closest('[data-rampside]')
    if (rampside) {
      const [district, at, s] = rampside.dataset.rampside.split('|')
      // On a built ramp this flips it; on an empty slot it is only the answer to
      // "which way would it go", remembered on the page until you build.
      if (ws.rampAt(district, Number(at))) ws.setRampSide(district, Number(at), Number(s))
      else if (ramp) ramp = { ...ramp, side: Number(s) }
      return render(true)
    }
    const openwin = ev.target.closest('[data-openwin]')
    if (openwin) {
      const [district, at, sd] = openwin.dataset.openwin.split('|')
      // OUT OF THE MAP FIRST. A window opens onto the road you are standing on --
      // that is where the compositor puts it and there is no second placement rule --
      // so this leaves the map the way "drive to it" does, and the window appears in
      // front of you rather than behind a panel.
      closeMap()
      state.lastOpenAt = { district, dash: Number(at), side: Number(sd) }
      hooks.spawnWindow?.(Number(sd), Number(at))
      return
    }
    const drivedash = ev.target.closest('[data-drivedash]')
    if (drivedash) {
      const [district, at] = drivedash.dataset.drivedash.split('|')
      // OUT OF THE MAP AND ONTO THE ROAD. Unlike walking the graph, the whole point
      // of asking for a dash is to LOOK at it -- so this one shuts the map, which is
      // the same division "drive to it" on a window's page already keeps.
      closeMap()
      go.dash?.(district, Number(at))
      return
    }
    const takeramp = ev.target.closest('[data-takeramp]')
    if (takeramp) {
      // Same journey the board out on the road makes, and the map stays open for
      // the same reason a lit node does: you may want the next hop.
      go.exit?.(takeramp.dataset.takeramp)
      selected = takeramp.dataset.takeramp
      onlyPage(null)
      render(true)
      centreOn(selected)
      applyView()
      return
    }

    const chip = ev.target.closest('[data-track]')
    if (chip) {
      // Clicking a chip IS pressing its number: you switch, and its page opens.
      // Travel does the driving, the same division everything else here keeps.
      const n = Number(chip.dataset.track)
      go.track?.(n)
      onlyPage('track')
      track = n
      selected = null
      return render(true)
    }
    if (ev.target.closest('[data-untrack]')) {
      onlyPage(null)
      selected = state.district
      return render(true)
    }
    const winname = ev.target.closest('[data-winname]')
    if (winname) {
      const [district, mp] = winname.dataset.winname.split('|')
      go.rename?.(district, Number(mp), el.querySelector('#win-name')?.value)
      return render(true)
    }
    const trackname = ev.target.closest('[data-trackname]')
    if (trackname) {
      tracks.rename(Number(trackname.dataset.trackname), el.querySelector('#tr-name')?.value)
      return render(true)
    }
    const back = ev.target.closest('[data-back]')
    if (back) {
      onlyPage(null)
      selected = back.dataset.back
      return render(true)
    }
    if (ev.target.closest('[data-shutmap]')) return void closeMap()
    // CLICKING A ROW OPENS ITS PAGE; the page has the button that drives there.
    //
    // It used to fly you straight out of the map, which is one click fewer and
    // is the wrong one click: a window's row is the only way to reach anything
    // about that window, so choosing it had to mean leaving. Now `.pick` selects
    // and `.goto` goes, exactly as a workspace box and its "drive to" already do.
    const pick = ev.target.closest('.wins [data-win]')
    if (pick) {
      const [district, mp] = pick.dataset.win.split('|')
      focus = { district, milepost: Number(mp) }
      return render(true)
    }
    // "OPEN ITS PAGE" MEANS THE PAGE THE WINDOW IS SHOWING, not the road outside it.
    //
    // This button carried `data-win`, which is the map's "drive to it" -- so the one
    // control that says OPEN parked you on the tarmac beside the window with the
    // thing it named still shut. Reported. `goWindow` is deliberately the road view
    // and travel.js says why; that stays the answer for a window row's own "drive to
    // it", where seeing it stand among its neighbours is the point. Here the noun is
    // the page, so this one flattens into it.
    const enter = ev.target.closest('[data-enterwin]')
    if (enter) {
      const [district, mp] = enter.dataset.enterwin.split('|')
      closeMap()
      go.enter?.(district, Number(mp))
      return
    }
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
    const move = ev.target.closest('[data-move]')
    if (move) {
      const [from, to, d] = move.dataset.move.split('|')
      ws.moveExit(from, to, Number(d))
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
      const id = node.dataset.node
      // CLICKING A LIT NEIGHBOUR IS TAKING THAT EXIT.
      //
      // One click does two different things and the difference is legible before
      // you click: a node the selection can reach is drawn lit and says "go" under
      // it, and every other node is a plain selection. That is the rule the
      // highlight exists to state -- a highlight that only meant "look at this"
      // would be decoration on the one view whose whole job is answering "where
      // can I get to from here".
      //
      // Arriving RE-SELECTS the destination, so its own exits light and the next
      // hop is another single click. The map stays open; the trail behind you is
      // the active track's history, so `back` on the gate walks it.
      const walkable = selected && id !== selected && ws.exitsOf(selected).includes(id) && ws.get(id)?.open
      if (walkable) {
        go.exit?.(id)
        selected = id
        onlyPage(null)
        render(true)
        // Follow the rider. Without this a chain of hops walks off the edge of the
        // view and the thing you are steering is somewhere you cannot see.
        centreOn(id)
        applyView()
        return
      }
      onlyPage(null)
      selected = id
      render(true)
    }
  })

  // "move to..." acts on CHANGE rather than waiting for a button beside it.
  // Everything else in this panel is a two-step because the value is free text
  // and you have to say when you are finished typing it; picking a workspace
  // from a list of workspaces is already the whole statement.
  el.addEventListener('change', (ev) => {
    // Choosing a network in the ramp picker only reloads the list of roads under
    // it -- it commits nothing. Two selects and one button, because picking the
    // network is half a statement and building on half a statement is how you get
    // a ramp to whatever happened to be first in the list.
    if (ev.target.closest('[data-rampnet]')) {
      rampNet = ev.target.value
      return render(true)
    }
    const dest = ev.target.closest('[data-dest]')
    if (!dest || !ev.target.value) return
    const [district, mp] = dest.dataset.dest.split('|')
    go.move?.to?.(district, Number(mp), ev.target.value)
    render(true)
  })

  // Enter commits the field it is typed in, because reaching for a button after
  // typing a name is the kind of small friction that makes a panel feel like a
  // form rather than a control.
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return
    const t = ev.target
    if (t.id === 'win-name') {
      const [district, mp] = t.dataset.id.split('|')
      go.rename?.(district, Number(mp), t.value)
    } else if (t.id === 'ws-name') ws.rename(t.dataset.id, t.value)
    else if (t.id === 'tr-name') tracks.rename(Number(t.dataset.id), t.value)
    else if (t.id === 'ws-pos') ws.setPos(t.dataset.id, t.value)
    else if (t.id === 'net-new') ws.addTenant(t.value)
    else if (t.id?.startsWith('net-name-')) ws.renameTenant(t.dataset.id, t.value)
    else if (t.id === 'ramp-at') {
      // The same act as the button beside it, because they are the same field --
      // and `set` moves the ramp now, so an Enter that only re-pointed the page
      // would be the two of them disagreeing about what the box means.
      const want = Number(t.value)
      if (!Number.isInteger(want) || want < 0 || !ramp) return
      const carries = ws.rampAt(ramp.district, ramp.at)
      if (!carries || ws.moveRamp(ramp.district, ramp.at, want)) ramp = { ...ramp, at: want }
    } else return
    ev.preventDefault()
    render(true)
  })
}

// ------------------------------------------------------------ pan and zoom

let panning = null
let swallowClick = false

function installViewInput() {
  // Delegated onto #map, which outlives every render. The graph box and the svg
  // inside it are replaced wholesale on each one, so a listener on either would
  // survive exactly until the first redraw and then be silently gone.
  el.addEventListener(
    'wheel',
    (ev) => {
      const box = ev.target.closest?.('.graph')
      if (!box) return
      // Travel's driving wheel already stands aside while the map is open. This
      // one refuses the page's scroll as well, because the map no longer has
      // anything to scroll -- the wheel means zoom in here and nothing else.
      ev.preventDefault()
      const r = box.getBoundingClientRect()
      zoomBy(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top)
    },
    { passive: false },
  )

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    const box = ev.target.closest?.('.graph')
    if (!box || ev.target.closest('.zoomers')) return
    panning = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false }
  })

  // CAPTURE WHEN THE PAN STARTS, NOT WHEN THE BUTTON GOES DOWN. This cost every
  // click inside the graph box and the failure was invisible from the code.
  //
  // Capturing on pointerdown made `#map` the pointer capture target for the whole
  // press -- and Chrome then retargets not just pointermove and pointerup but the
  // CLICK as well, to the capture element. So every click over the graph arrived
  // at the `#map` div with `ev.target.closest('[data-node]')` finding nothing, and
  // selecting a workspace, switching a track from its chip and switching networks
  // were all silently dead. Measured: pointerdown on a node's rect, pointerup and
  // click on the div. `.zoomers` was excluded from panning for unrelated reasons
  // and is the only reason the zoom buttons still worked, which is what made this
  // look like a problem with the nodes rather than with the whole box.
  //
  // A press that never moves needs no capture at all -- it is a click, and it is
  // over in the same place it began. Capture exists so a pan that leaves the box
  // keeps its pointermoves and its pointerup, and that is exactly as true taken
  // out one gesture later. Best effort on purpose: an uncapturable pointer gives a
  // pan that stops at the edge of the window, which is far better than a pan that
  // throws out of its own handler.
  el.addEventListener('pointermove', (ev) => {
    if (!panning || ev.pointerId !== panning.id) return
    const dx = ev.clientX - panning.x
    const dy = ev.clientY - panning.y
    // A FEW PIXELS OF SLACK before it is a pan. A mouse moves one or two pixels
    // between press and release on an ordinary click, and without this every
    // click on a node would be a one-pixel pan that then ate its own click.
    if (!panning.moved && Math.hypot(dx, dy) < 4) return
    if (!panning.moved) {
      panning.moved = true
      try {
        el.setPointerCapture(ev.pointerId)
      } catch {
        /* uncapturable pointer -- pan within the window only */
      }
      // And the grabbing cursor with it, which is more honest anyway: it now says
      // "you are panning" rather than "you have the button down".
      el.querySelector('.graph')?.classList.add('panning')
    }
    view.x = panning.vx - dx / view.k
    view.y = panning.vy - dy / view.k
    applyView()
  })

  // ONLY A POINTERUP ARMS THE SWALLOW. A pointerup is followed by a click and
  // that click is the one being swallowed; a pointercancel is not followed by
  // anything, so arming it there leaves the flag set and the next real click --
  // minutes later, on something else entirely -- is the one that gets eaten.
  const endPan = (ev, up) => {
    if (!panning || (ev.pointerId !== undefined && ev.pointerId !== panning.id)) return
    if (up) swallowClick = panning.moved
    panning = null
    el.querySelector('.graph')?.classList.remove('panning')
  }
  el.addEventListener('pointerup', (ev) => endPan(ev, true))
  el.addEventListener('pointercancel', (ev) => endPan(ev, false))

  // The viewBox is in screen pixels on one axis and graph units on the other, so
  // it is only correct for the size the box was when it was written. Resize the
  // shell and it has to be written again.
  window.addEventListener('resize', () => open && applyView())
}

// -------------------------------------------- dragging a window onto a node
//
// The buttons under each window can already do this and they are the reliable
// path -- they work from the keyboard, they say what they will do, and they do
// not depend on the drag implementation. This is the direct one: the thing you
// are moving is a row in a list and the place you are moving it to is a box on a
// map, and dragging one onto the other is what that means.
function installDragInput() {
  // POINTER EVENTS, NOT HTML5 DRAG-AND-DROP.
  //
  // It was `draggable="true"` and a dataTransfer, which is the standard answer
  // and is the wrong one here. Reported plainly: windows were not draggable.
  // Two separate reasons, and each on its own is fatal --
  //
  //   1. the drag handle was a small grip beside the row, because a browser will
  //      not begin a native drag from a <button> and the row was one. You aim at
  //      the row, so nothing happened.
  //   2. native dnd is the one input path that behaves differently in every
  //      browser and cannot be driven from a test harness at all, so "it works"
  //      could not be measured -- and what could not be measured turned out not
  //      to be true.
  //
  // The pan two functions up is pointerdown/move/up and it works everywhere and
  // is testable. So is this, now, and it is the same shape: a few pixels of
  // slack before it counts, capture so the drag survives leaving the panel, and
  // the click it ends with is swallowed.
  const SLACK = 5
  let armed = null

  const unpaint = () => {
    dropOn?.classList.remove('drop', 'nodrop')
    dropOn = null
  }

  // What is under the pointer, and whether dropping there would do anything.
  //
  // `elementFromPoint` rather than `ev.target`, because the pointer is CAPTURED
  // for the whole drag -- every move reports the row you started on, so asking
  // the event where you are would answer "still here" all the way across.
  //
  // A ROW WINS OVER A WORKSPACE BOX when both are under the pointer. They mean
  // different things -- "go to this place in the list" and "go to that road" --
  // and the row is the more specific of the two.
  const targetAt = (x, y) => {
    if (!dragging) return null
    const under = document.elementFromPoint(x, y)
    if (!under) return null
    const li = under.closest?.('.wins li[data-onto]')
    if (li) {
      const [district, mp] = li.dataset.onto.split('|')
      return {
        g: li,
        kind: 'row',
        id: district,
        milepost: Number(mp),
        ok: district === dragging.district && Number(mp) !== dragging.milepost,
      }
    }
    const g = under.closest?.('[data-node]')
    if (!g) return null
    const id = g.dataset.node
    return { g, kind: 'node', id, ok: id !== dragging.district && !!ws.get(id)?.open }
  }

  const paint = (t) => {
    if (!t) return unpaint()
    if (t.g === dropOn) return
    unpaint()
    dropOn = t.g
    t.g.classList.add(t.ok ? 'drop' : 'nodrop')
  }

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    const li = ev.target.closest?.('.wins li[data-drag]')
    // Not from the controls under the row. A button you press and slide off is a
    // button you changed your mind about, not the start of a drag.
    if (!li || ev.target.closest('button, select')) return
    armed = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, addr: li.dataset.drag, li }
  })

  el.addEventListener('pointermove', (ev) => {
    if (!armed || ev.pointerId !== armed.id) return
    if (!dragging) {
      if (Math.hypot(ev.clientX - armed.x, ev.clientY - armed.y) < SLACK) return
      const [district, mp] = armed.addr.split('|')
      dragging = { district, milepost: Number(mp) }
      armed.li.classList.add('lifting')
      try {
        el.setPointerCapture(ev.pointerId)
      } catch {
        /* uncapturable pointer -- the drag still works inside the panel */
      }
    }
    paint(targetAt(ev.clientX, ev.clientY))
  })

  const finish = (ev, up) => {
    if (!armed || (ev.pointerId !== undefined && ev.pointerId !== armed.id)) return
    const t = up && dragging ? targetAt(ev.clientX, ev.clientY) : null
    armed.li.classList.remove('lifting')
    unpaint()
    // A drag that moved ends in a click on whatever it finished over, and that
    // click must not also select something. Same rule as the pan, including the
    // part about a cancel not arming it.
    if (dragging && up) swallowClick = true
    armed = null
    if (!dragging) return
    const from = dragging
    dragging = null
    if (!t?.ok) return render(true)
    if (t.kind === 'row') {
      go.move?.onto?.(from.district, from.milepost, t.milepost)
    } else {
      const moved = go.move?.to?.(from.district, from.milepost, t.id)
      // Follow the window. You dropped it over there because that is where you
      // want it, and the panel you are looking at is about to stop mentioning it.
      selected = t.id
      // A move to another road takes a FRESH MILEPOST, so a focus still holding
      // the old address points at nothing. The move reports the new one.
      if (focus && moved) focus = { district: moved.district, milepost: moved.milepost }
    }
    render(true)
  }
  el.addEventListener('pointerup', (ev) => finish(ev, true))
  el.addEventListener('pointercancel', (ev) => finish(ev, false))
}

export function openMap() {
  install()
  if (!el) return false
  selected = ws.has(state.district) ? state.district : (ws.has(selected) ? selected : ws.root())
  open = true
  state.mapOpen = true
  el.hidden = false
  // TAKE THE KEYBOARD. The map can be open while you are standing in a window,
  // and Greenfield's key listeners are on the canvas -- so without this, typing
  // a workspace name types it into the application behind the map as well.
  hooks.shellKeyboard?.(true)
  render(true)
  // Fitting only the FIRST time. After that the map opens where you left it,
  // which is the same argument the per-window zoom memory makes: a view you
  // chose is undone by leaving and coming back, or it was never yours.
  if (!fitted) {
    fitted = true
    fitView()
  }
  centreOn(selected)
  applyView()
  clearInterval(poll)
  poll = setInterval(() => open && render(), 700)
  return true
}

export function closeMap() {
  if (!open) return false
  // Every page is a fact about how you got here, not about the graph, so none of
  // them survives the map being shut. `selected` does -- it is where you were
  // looking, and openMap re-derives it from where you are standing anyway.
  focus = null
  ramp = null
  rampNet = null
  netPage = false
  open = false
  state.mapOpen = false
  clearInterval(poll)
  poll = 0
  if (el) el.hidden = true
  // And give it back, which is what puts you straight back to work when the map
  // was opened from inside a window.
  hooks.shellKeyboard?.(false)
  return true
}

export const toggleMap = () => (open ? closeMap() : openMap())

// THE MAP, OPENED ABOUT ONE WINDOW. This is what the name board over a window
// does: everything you can do to a window lives in this panel, so the board does
// not need a menu of its own -- it needs to bring you here pointed at the right
// row.
//
// It is `openMap` plus a highlight, deliberately, rather than a second way in
// with its own rules. The workspace it selects is the one that window is on, so
// pressing 0 afterwards and clicking the same board land you in the same place.
export function openMapAt(district, milepost) {
  focus = ws.has(district) ? { district, milepost } : null
  if (!openMap()) return false
  if (focus) {
    selected = focus.district
    render(true)
    centreOn(selected)
    applyView()
    // Into view rather than to the top: a road with a dozen windows on it makes
    // a list longer than the panel, and the row this was opened for can easily
    // be off the bottom of it.
    el.querySelector('.wins li.focus')?.scrollIntoView({ block: 'nearest' })
  }
  return true
}

// THE MAP, OPENED ABOUT ONE DASH. What clicking a yellow marker out on the road
// does.
//
// Same construction as openMapAt and for the same reason: one way in with one set
// of rules, plus an argument saying what it is about. The workspace it selects is
// the road the dash is on, so pressing 0 afterwards shows you the same thing with
// the ramp list on it.
export function openMapAtDash(district, at) {
  if (!ws.has(district) || !Number.isInteger(at)) return false
  if (!openMap()) return false
  onlyPage('ramp')
  ramp = { district, at }
  rampNet = null
  selected = district
  render(true)
  centreOn(district)
  applyView()
  return true
}

// What the map is showing, without reading it off the screen.
//
// `viewBox` is read back OFF THE ELEMENT rather than recomputed from `view`,
// because the whole claim being made about pan and zoom is that the attribute
// follows the state -- and a report that recomputes it would agree with itself
// no matter what the svg said.
export const mapReport = () => ({
  open,
  selected,
  here: state.district,
  selectedIsHere: selected === state.district,
  view: { ...view, port: { ...port } },
  viewBox: el?.querySelector('svg')?.getAttribute('viewBox') ?? null,
  nodes: ws.list().map((n) => ({
    id: n.id,
    name: n.name,
    open: n.open,
    exits: [...n.exits],
    windows: windowsOf(n.id).map((s) => ({
      milepost: s.milepost,
      side: s.side > 0 ? 'right' : 'left',
      dash: s.dash,
      z: s.mesh ? Math.round(s.mesh.position.z) : null,
      x: s.mesh ? Math.round(s.mesh.position.x) : null,
    })),
  })),
  network: { active: ws.activeTenantId(), name: ws.activeTenantName(), all: ws.tenantList().map((t) => t.name) },
  page: netPage ? 'networks' : ramp ? 'ramp' : track ? 'track' : focus ? 'window' : selected ? 'workspace' : 'network',
  ramp: ramp ? { ...ramp, z: Math.round(dashZ(ramp.at)), carries: ws.rampAt(ramp.district, ramp.at) } : null,
  // WHAT IS LIT, off the DOM rather than recomputed. `reachIsExitsOfSelected` is
  // the claim worth making -- that the highlight is the graph and not a second
  // idea of reachability that could drift from it -- and it can only be made by
  // comparing what was rendered against what the graph says.
  lit: el && !el.hidden ? [...el.querySelectorAll('.node.reach')].map((g) => g.dataset.node) : null,
  walkable: el && !el.hidden ? [...el.querySelectorAll('.node.go')].map((g) => g.dataset.node) : null,
  litEdges: el && !el.hidden ? el.querySelectorAll('.edge.lit').length : null,
  reachIsExitsOfSelected:
    el && !el.hidden && selected
      ? (() => {
          const drawn = new Set([...el.querySelectorAll('.node.reach')].map((g) => g.dataset.node))
          const want = new Set(ws.exitsOf(selected).filter((e) => ws.has(e)))
          return drawn.size === want.size && [...want].every((e) => drawn.has(e))
        })()
      : null,
  rendered: el && !el.hidden ? { nodes: el.querySelectorAll('[data-node]').length, windowButtons: el.querySelectorAll('[data-win]').length } : null,
})
