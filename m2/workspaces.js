// The workspace graph.
//
// A workspace used to be an index into `DISTRICTS = ['home','build','watch']`,
// and its road's position was arithmetic on that index: `(d - 1) * 2600`. That
// works exactly as long as workspaces are a fixed list. They are not: they are a
// tree that may loop back on itself, built at runtime from the signs on the
// road, and it survives a restart.
//
// So a workspace is a NODE:
//
//     { id, name, exits: [id], open }
//
// and `laneX` stops being arithmetic on an index and becomes a LAYOUT over the
// graph. That is the load-bearing change; the gantry, open/close and the window
// inventory all hang off it. Everything else in this file exists to make that
// one substitution safe.
//
// THE LAYOUT RESERVES A LANE FOR A CLOSED WORKSPACE. It would be tidier to lay
// out only the open ones, and it would be wrong: a sign's world position is
// computed once, when the window is adopted (invariant 6 -- placement is the
// address). If closing a workspace re-spaced its neighbours, every window
// already standing on those roads would be left at the old x with no road under
// it. A lane is allocated by ORDER IN THE GRAPH, not by openness.

// How far apart the roads are laid. Was DISTRICT_X in world.js.
export const LANE_X = 2600

// Bumping the version retires an incompatible saved graph rather than trying to
// migrate one, which is the right trade while the shape is still moving.
const STORE_KEY = 'rrabbit.workspaces.v1'

// The three that were hardcoded, now with the connectivity they always implied:
// a hub with two spokes, and each spoke's way back. The back-edges are what make
// this a graph rather than a tree -- `home -> build -> home` is a loop, and the
// layout, the ordering and the gantry all have to survive one.
const SEED = [
  { id: 'home', name: 'home', exits: ['build', 'watch'], open: true },
  { id: 'build', name: 'build', exits: ['home'], open: true },
  { id: 'watch', name: 'watch', exits: ['home'], open: true },
]

const nodes = new Map()
let rootId = null
let orderCache = null

// Every mutation goes through here, so there is exactly one place that can
// forget to invalidate the layout or to persist.
function touched() {
  orderCache = null
  save()
}

// ---------------------------------------------------------------- the store

function save() {
  try {
    const payload = {
      root: rootId,
      nodes: [...nodes.values()].map((n) => ({ id: n.id, name: n.name, exits: [...n.exits], open: n.open })),
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(payload))
  } catch {
    // A shell that cannot persist is still a working shell. Private-mode
    // localStorage throws on write, and that must not take the road down.
  }
}

// A saved graph is UNTRUSTED INPUT -- it was written by an older build of this
// file. Anything malformed falls back to the seed rather than half-loading, and
// an exit pointing at a workspace that no longer exists is dropped rather than
// left to become a lane that leads nowhere.
function parse(raw) {
  const data = JSON.parse(raw)
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) return null
  const clean = []
  for (const n of data.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) return null
    clean.push({
      id: n.id,
      name: typeof n.name === 'string' && n.name ? n.name : n.id,
      exits: Array.isArray(n.exits) ? n.exits.filter((e) => typeof e === 'string') : [],
      open: n.open !== false,
    })
  }
  const ids = new Set(clean.map((n) => n.id))
  for (const n of clean) n.exits = n.exits.filter((e) => ids.has(e) && e !== n.id)
  const root = ids.has(data.root) ? data.root : clean[0].id
  return { root, nodes: clean }
}

function install(list, root) {
  nodes.clear()
  for (const n of list) {
    nodes.set(n.id, {
      id: n.id,
      name: n.name ?? n.id,
      exits: [...(n.exits ?? [])],
      open: n.open !== false,
      // NOT persisted, and deliberately so: mileposts number the windows
      // standing on a road, and after a restart there are none. A counter
      // restored from disk would start the first window of the session at
      // milepost 7 with nothing at 1..6.
      next: 1,
      // How many windows stand on each SIDE of this road. The milepost is the
      // address; these decide position, and they advance independently so that
      // what the left side does cannot move the right side's next window.
      lanes: { l: 0, r: 0 },
    })
  }
  rootId = root ?? list[0]?.id ?? null
  orderCache = null
}

function boot() {
  // `?ws=reset` is the way back from a saved graph that a build has made
  // nonsense of. Without it the only recovery is devtools, on a machine whose
  // whole point is that it is running a shell instead of a browser.
  let raw = null
  try {
    if (new URLSearchParams(location.search).get('ws') === 'reset') localStorage.removeItem(STORE_KEY)
    else raw = localStorage.getItem(STORE_KEY)
  } catch {
    raw = null
  }
  let loaded = null
  try {
    if (raw) loaded = parse(raw)
  } catch {
    loaded = null
  }
  if (loaded) install(loaded.nodes, loaded.root)
  else install(SEED, SEED[0].id)
}

boot()

export function reset() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* nothing to remove */
  }
  install(SEED, SEED[0].id)
  return list()
}

// ----------------------------------------------------------------- the graph

export const get = (id) => nodes.get(id) ?? null
export const has = (id) => nodes.has(id)
export const root = () => rootId

// Layout order: breadth-first from the root, so a workspace sits next to the one
// it is reached from, then anything the root cannot reach appended in insertion
// order. An unreachable workspace still gets a lane -- a node you cannot see is
// indistinguishable from a node that failed to be created, and this is the code
// that would have to be trusted to tell you which.
function order() {
  if (orderCache) return orderCache
  const out = []
  const seen = new Set()
  const queue = rootId && nodes.has(rootId) ? [rootId] : []
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const n = nodes.get(id)
    out.push(n)
    // The `seen` check is what stops a back-edge (build -> home) from walking
    // the graph forever.
    for (const e of n.exits) if (nodes.has(e) && !seen.has(e)) queue.push(e)
  }
  for (const n of nodes.values()) if (!seen.has(n.id)) out.push(n)
  orderCache = out
  return out
}

export const list = () => order()
export const openList = () => order().filter((n) => n.open)
export const indexOf = (id) => order().findIndex((n) => n.id === id)
export const at = (i) => order()[i] ?? null

// The layout. For the seeded three this is byte-identical to the old
// `districtX(d) = (d - (DISTRICTS.length - 1) / 2) * DISTRICT_X`, which is the
// point: increment 1 changes the data model and nothing on screen.
//
// A tree layout can replace the body of this function without touching a single
// caller -- that is the whole reason placement was pulled out of the callers.
export function laneX(id) {
  const all = order()
  const i = all.findIndex((n) => n.id === id)
  if (i < 0) return 0
  return (i - (all.length - 1) / 2) * LANE_X
}

// How wide the whole world is, for the overview's framing. Was
// `DISTRICT_X * (DISTRICTS.length - 1)`, which assumed the lanes were evenly
// spaced by construction; asking the layout means it stays true when they are
// not.
export function span() {
  const all = order()
  if (all.length < 2) return 0
  const xs = all.map((n) => laneX(n.id))
  return Math.max(...xs) - Math.min(...xs)
}

// Mileposts are PER WORKSPACE -- each road numbers its own windows -- and the
// counter belongs to the node now rather than to an array indexed in parallel
// with one.
export function takeMilepost(id) {
  const n = nodes.get(id)
  if (!n) return 1
  return n.next++
}

// The next free slot on one side of a road. Paired with takeMilepost: one gives
// the window its name, this one gives it its place.
export function takeLane(id, side) {
  const n = nodes.get(id)
  if (!n) return 0
  const k = side > 0 ? 'r' : 'l'
  return n.lanes[k]++
}

export function add({ id, name, exits = [], open = true } = {}) {
  const key = id || `ws-${Math.random().toString(36).slice(2, 8)}`
  if (nodes.has(key)) return nodes.get(key)
  nodes.set(key, { id: key, name: name || key, exits: exits.filter((e) => nodes.has(e)), open, next: 1 })
  if (!rootId) rootId = key
  touched()
  return nodes.get(key)
}

// An exit is ONE-WAY. `home -> build` does not imply `build -> home`; the seed
// states both directions explicitly because both are wanted, not because the
// graph invents the return trip. A gantry lane is an exit, and a road you can
// drive down but not back up is a thing a road network is allowed to have.
export function connect(from, to) {
  const a = nodes.get(from)
  if (!a || !nodes.has(to) || from === to || a.exits.includes(to)) return false
  a.exits.push(to)
  touched()
  return true
}

export function disconnect(from, to) {
  const a = nodes.get(from)
  if (!a) return false
  const i = a.exits.indexOf(to)
  if (i < 0) return false
  a.exits.splice(i, 1)
  touched()
  return true
}

export function setOpen(id, open) {
  const n = nodes.get(id)
  if (!n || n.open === !!open) return false
  n.open = !!open
  touched()
  return true
}

export const exitsOf = (id) => (nodes.get(id)?.exits ?? []).filter((e) => nodes.has(e))
