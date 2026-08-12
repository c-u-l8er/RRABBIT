// The workspace graph -- now several of them.
//
// A workspace used to be an index into `DISTRICTS = ['home','build','watch']`,
// and its road's position was arithmetic on that index: `(d - 1) * 2600`. That
// works exactly as long as workspaces are a fixed list. They are not: they are a
// tree that may loop back on itself, built at runtime from the signs on the
// road, and it survives a restart.
//
// So a workspace is a NODE:
//
//     { id, tenant, name, exits: [id], ramps: [{at, to, side}], open }
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
//
// ---- MANY NETWORKS ---------------------------------------------------------
//
// A TENANT IS A NETWORK: its own set of workspaces, its own root, its own lane
// numbering from 1. One is active; its roads are the roads that exist in the
// scene, and every layout question -- `list`, `laneX`, `span`, `at` -- is asked
// of it alone. Nothing else would do: `laneX` centres the whole set, so a lane
// number and an x position only mean anything relative to the other roads laid
// beside them, and two networks sharing that arithmetic would be one network
// with a label on it.
//
// BUT `get` AND `has` STAY GLOBAL, deliberately, and that asymmetry is the whole
// trick. A window's sign holds a workspace id; a track is parked on one; a ramp
// points at one. Every one of those references can outlive a network switch, and
// a reference that stops resolving is a reference that reads as deleted. So:
// LOOKUP is global, LAYOUT is per network. `inActive(id)` is how a caller that
// must not draw a foreign road asks.
//
// EXITS DO NOT CROSS NETWORKS. `connect` refuses it and `exitsOf` filters it
// out. An exit is a lane on the exit gate, it is numbered among its siblings,
// and the map lays its rows out by hops from the root -- all three are facts
// about one network, and a cross-network exit would be a lane whose destination
// has no lane number and no row. Crossing is what a RAMP is for: it is placed
// somewhere specific on the road rather than at the gate, and it says out loud
// which network it lands in. Two mechanisms because they are two different
// journeys, not one mechanism with a flag.

// How far apart the roads of ONE network are laid. Was DISTRICT_X in world.js.
export const LANE_X = 2600

// Bumping the version retires an incompatible saved graph rather than trying to
// migrate one, which is the right trade while the shape is still moving.
const STORE_KEY = 'rrabbit.tenants.v1'

// The single-network store this replaced. Read ONCE, on a machine that has one
// and no tenant store yet, and wrapped as the first network -- because the
// alternative is that shipping multi-tenancy silently deletes the network
// somebody has been building. Not written to and not removed: it is a fallback
// this build has stopped using, and leaving it costs a few hundred bytes.
const LEGACY_KEY = 'rrabbit.workspaces.v1'

// The three that were hardcoded, now with the connectivity they always implied:
// a hub with two spokes, and each spoke's way back. The back-edges are what make
// this a graph rather than a tree -- `home -> build -> home` is a loop, and the
// layout, the ordering and the gantry all have to survive one.
const SEED = [
  { id: 'home', name: 'home', exits: ['build', 'watch'], open: true },
  { id: 'build', name: 'build', exits: ['home'], open: true },
  { id: 'watch', name: 'watch', exits: ['home'], open: true },
]
const SEED_TENANT = { id: 'main', name: 'main' }

// id -> { id, tenant, name, exits, ramps, open, next, lanes, pos }
const nodes = new Map()
// id -> { id, name, root, last }
const tenants = new Map()
let activeTenant = null
let orderCache = null

// Every mutation goes through here, so there is exactly one place that can
// forget to invalidate the layout or to persist.
function touched() {
  orderCache = null
  save()
}

const rnd = () => Math.random().toString(36).slice(2, 8)

// ---------------------------------------------------------------- the store

function save() {
  try {
    const payload = {
      active: activeTenant,
      tenants: [...tenants.values()].map((t) => ({
        id: t.id,
        name: t.name,
        root: t.root,
        // Where you were last standing in this network. Switching back puts you
        // there rather than at the root -- the same argument per-road scroll
        // memory makes one level down: a position you chose, discarded by
        // something you did elsewhere, is a position you never really had.
        last: t.last,
        nodes: [...nodes.values()]
          .filter((n) => n.tenant === t.id)
          .map((n) => ({
            id: n.id,
            name: n.name,
            exits: [...n.exits],
            ramps: n.ramps.map((r) => ({ at: r.at, to: r.to, side: r.side })),
            open: n.open,
            pos: n.pos,
          })),
      })),
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(payload))
  } catch {
    // A shell that cannot persist is still a working shell. Private-mode
    // localStorage throws on write, and that must not take the road down.
  }
}

// One network's worth of nodes, cleaned. A saved graph is UNTRUSTED INPUT -- it
// was written by an older build of this file -- so anything malformed makes the
// whole load fail back to the seed rather than half-loading.
function parseNodes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const clean = []
  for (const n of raw) {
    if (!n || typeof n.id !== 'string' || !n.id) return null
    clean.push({
      id: n.id,
      name: typeof n.name === 'string' && n.name ? n.name : n.id,
      exits: Array.isArray(n.exits) ? n.exits.filter((e) => typeof e === 'string') : [],
      // A ramp's `at` is a dash slot on the road (world.js decides where that
      // is); `to` is any workspace in any network; `side` is which way it leaves.
      // Kept as a list rather than a map keyed by slot because the order is the
      // order they were built in and a list survives JSON without stringifying
      // its keys.
      //
      // `side` defaults to RIGHT, which is what every ramp saved before sides
      // existed was, so an older store loads as the thing it actually described.
      ramps: Array.isArray(n.ramps)
        ? n.ramps
            .filter((r) => r && Number.isInteger(r.at) && r.at >= 0 && typeof r.to === 'string')
            .map((r) => ({ at: r.at, to: r.to, side: r.side === -1 ? -1 : 1 }))
        : [],
      open: n.open !== false,
      pos: Number.isInteger(n.pos) ? n.pos : null,
    })
  }
  return clean
}

function parse(raw) {
  const data = JSON.parse(raw)
  if (!data || !Array.isArray(data.tenants) || data.tenants.length === 0) return null
  const out = []
  for (const t of data.tenants) {
    if (!t || typeof t.id !== 'string' || !t.id) return null
    const list = parseNodes(t.nodes)
    if (!list) return null
    out.push({
      id: t.id,
      name: typeof t.name === 'string' && t.name ? t.name : t.id,
      root: t.root,
      last: typeof t.last === 'string' ? t.last : null,
      nodes: list,
    })
  }
  const ids = new Set(out.map((t) => t.id))
  return { active: ids.has(data.active) ? data.active : out[0].id, tenants: out }
}

// The single-network store, read as one network. Same cleaning, one less level.
function parseLegacy(raw) {
  const data = JSON.parse(raw)
  if (!data) return null
  const list = parseNodes(data.nodes)
  if (!list) return null
  return {
    active: SEED_TENANT.id,
    tenants: [{ ...SEED_TENANT, root: data.root, last: null, nodes: list }],
  }
}

function install(loaded) {
  nodes.clear()
  tenants.clear()
  for (const t of loaded.tenants) {
    tenants.set(t.id, { id: t.id, name: t.name, root: null, last: null })
    for (const n of t.nodes) {
      nodes.set(n.id, {
        id: n.id,
        tenant: t.id,
        name: n.name ?? n.id,
        exits: [...(n.exits ?? [])],
        ramps: [...(n.ramps ?? [])],
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
        // WHICH LANE THIS IS -- the slot the road occupies from left to right
        // WITHIN ITS OWN NETWORK. It used to be derived: a breadth-first walk
        // from the root decided the order and therefore the numbering, which is
        // fine until someone wants lane 4 to be lane 2. A number you can assign
        // has to be stored.
        pos: Number.isInteger(n.pos) ? n.pos : null,
      })
    }
    const own = t.nodes.map((n) => n.id)
    tenants.get(t.id).root = own.includes(t.root) ? t.root : (own[0] ?? null)
    tenants.get(t.id).last = own.includes(t.last) ? t.last : null
  }
  // An exit pointing at a workspace that no longer exists is dropped rather than
  // left to become a lane that leads nowhere -- and so is one that points OUT of
  // its own network, which nothing in this build creates but an older store
  // could contain.
  for (const n of nodes.values()) {
    n.exits = n.exits.filter((e) => nodes.get(e)?.tenant === n.tenant && e !== n.id)
    n.ramps = dedupeRamps(
      n.ramps.filter((r) => nodes.has(r.to) && r.to !== n.id).map((r) => ({ ...r, side: r.side === -1 ? -1 : 1 })),
    )
  }
  activeTenant = tenants.has(loaded.active) ? loaded.active : [...tenants.keys()][0]
  for (const t of tenants.keys()) normalisePositions(t)
  orderCache = null
}

// One ramp per dash slot. Two ramps on one marker is one marker you cannot aim
// at, so the later one wins and the earlier is dropped -- decided here rather
// than at the three readers.
function dedupeRamps(list) {
  const seen = new Map()
  for (const r of list) seen.set(r.at, r)
  return [...seen.values()].sort((a, b) => a.at - b.at)
}

// Positions are 1..n WITHIN A NETWORK, unique and contiguous, ALWAYS. Anything
// without one (a seed, a graph saved before positions existed, a node whose
// number collided) takes the next free slot in insertion order. Doing this on
// every install means no other code has to cope with a hole or a duplicate.
function normalisePositions(tenant) {
  const all = [...nodes.values()].filter((n) => n.tenant === tenant)
  const taken = new Set()
  const settled = []
  for (const n of all) {
    if (Number.isInteger(n.pos) && n.pos >= 1 && n.pos <= all.length && !taken.has(n.pos)) {
      taken.add(n.pos)
      settled.push(n)
    }
  }
  let next = 1
  for (const n of all) {
    if (settled.includes(n)) continue
    while (taken.has(next)) next++
    n.pos = next
    taken.add(next)
  }
}

const seeded = () => ({
  active: SEED_TENANT.id,
  tenants: [{ ...SEED_TENANT, root: SEED[0].id, last: null, nodes: SEED }],
})

function boot() {
  // `?ws=reset` is the way back from a saved graph that a build has made
  // nonsense of. Without it the only recovery is devtools, on a machine whose
  // whole point is that it is running a shell instead of a browser.
  let raw = null
  let legacy = null
  try {
    if (new URLSearchParams(location.search).get('ws') === 'reset') localStorage.removeItem(STORE_KEY)
    else raw = localStorage.getItem(STORE_KEY)
    if (!raw) legacy = localStorage.getItem(LEGACY_KEY)
  } catch {
    raw = null
  }
  let loaded = null
  try {
    if (raw) loaded = parse(raw)
    else if (legacy) loaded = parseLegacy(legacy)
  } catch {
    loaded = null
  }
  install(loaded ?? seeded())
}

boot()

export function reset() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* nothing to remove */
  }
  install(seeded())
  return list()
}

// --------------------------------------------------------------- the networks

export const tenantList = () => [...tenants.values()]
export const tenant = (id) => tenants.get(id) ?? null
export const activeTenantId = () => activeTenant
export const activeTenantName = () => tenants.get(activeTenant)?.name ?? activeTenant
export const tenantOf = (wsId) => nodes.get(wsId)?.tenant ?? null

// Is this workspace one of the roads currently laid? The question every caller
// that is about to compute a POSITION has to ask, because `laneX` can only
// answer for the network it is laying out.
export const inActive = (wsId) => !!wsId && nodes.get(wsId)?.tenant === activeTenant

// Where switching to a network should put you: the road you were last on there,
// else its root. Returns null for a network with nothing open, which the caller
// has to treat as a refusal rather than as the root -- an empty network is a
// real state and flying into it would put you in the air.
export function tenantEntry(id) {
  const t = tenants.get(id)
  if (!t) return null
  const openHere = [...nodes.values()].filter((n) => n.tenant === id && n.open)
  if (!openHere.length) return null
  const last = nodes.get(t.last)
  if (last && last.tenant === id && last.open) return last.id
  const rt = nodes.get(t.root)
  if (rt && rt.open) return rt.id
  return openHere.sort((a, b) => a.pos - b.pos)[0].id
}

export function selectTenant(id) {
  if (!tenants.has(id) || id === activeTenant) return false
  activeTenant = id
  touched()
  return true
}

// Remembered on every arrival, by goDistrict, so it is the road you left rather
// than the last one you opened a panel about.
export function noteLast(wsId) {
  const n = nodes.get(wsId)
  if (!n) return false
  const t = tenants.get(n.tenant)
  if (!t || t.last === wsId) return false
  t.last = wsId
  save()
  return true
}

// A NEW NETWORK IS NOT EMPTY. An empty one has no root, no road and nowhere to
// arrive, so it would be a network you can create and cannot visit -- and the
// first thing anyone would do is make a road in it. It starts with one.
export function addTenant(name) {
  const id = `net-${rnd()}`
  const clean = String(name ?? '').trim().slice(0, 24) || `network ${tenants.size + 1}`
  tenants.set(id, { id, name: clean, root: null, last: null })
  const first = `ws-${rnd()}`
  nodes.set(first, {
    id: first,
    tenant: id,
    name: 'home',
    exits: [],
    ramps: [],
    open: true,
    next: 1,
    lanes: { l: 0, r: 0 },
    pos: 1,
  })
  tenants.get(id).root = first
  touched()
  return tenants.get(id)
}

export function renameTenant(id, name) {
  const t = tenants.get(id)
  const clean = String(name ?? '').trim().slice(0, 24)
  if (!t || !clean || clean === t.name) return false
  t.name = clean
  touched()
  return true
}

// REMOVING A NETWORK REMOVES ITS ROADS, and every ramp anywhere that pointed
// into it -- a ramp to a workspace that no longer exists is a marker on the road
// that does nothing when pressed. The last network cannot be removed: there
// would be no active one and no layout to lay.
//
// It does NOT ask about the windows standing on those roads. It cannot: this
// module does not know windows exist. The caller does, and the map is where the
// asking belongs.
export function removeTenant(id) {
  if (!tenants.has(id) || tenants.size < 2) return false
  for (const n of [...nodes.values()]) if (n.tenant === id) nodes.delete(n.id)
  tenants.delete(id)
  for (const n of nodes.values()) n.ramps = n.ramps.filter((r) => nodes.has(r.to))
  if (activeTenant === id) activeTenant = [...tenants.keys()][0]
  touched()
  return true
}

// ----------------------------------------------------------------- the graph

export const get = (id) => nodes.get(id) ?? null
export const has = (id) => nodes.has(id)
export const root = () => tenants.get(activeTenant)?.root ?? null

// Lane order is the ASSIGNED NUMBERS, low to high, within the ACTIVE network. It
// was a breadth-first walk from the root, which read nicely and made the
// numbering a consequence of the graph's shape -- so adding an exit could
// renumber roads you were not touching. The map still lays its ROWS out by
// breadth-first depth, because that is a fact about the graph; the lane a road
// occupies is a fact about your preference.
function order() {
  if (orderCache) return orderCache
  orderCache = [...nodes.values()]
    .filter((n) => n.tenant === activeTenant)
    .sort((a, b) => a.pos - b.pos)
  return orderCache
}

export const list = () => order()
export const openList = () => order().filter((n) => n.open)
export const indexOf = (id) => order().findIndex((n) => n.id === id)
export const at = (i) => order()[i] ?? null

// Every workspace in every network, for the pickers that offer a ramp somewhere
// to land. Grouped, because a flat list of forty names across five networks is
// a list you cannot read.
export const everyTenantsNodes = () =>
  tenantList().map((t) => ({
    tenant: t,
    nodes: [...nodes.values()].filter((n) => n.tenant === t.id).sort((a, b) => a.pos - b.pos),
  }))

// The layout, over the ACTIVE network. For the seeded three this is
// byte-identical to the old `districtX(d) = (d - (DISTRICTS.length - 1) / 2) *
// DISTRICT_X`, which is the point: the data model changes and nothing on screen
// does.
//
// It answers 0 for a workspace in another network, and that answer is NOT a
// position -- there is no position, because that road is not laid. Callers that
// place something ask `inActive` first (syncPlacement does); this returning a
// number rather than throwing is what keeps a stale reference from taking the
// frame loop down.
export function laneX(id) {
  const all = order()
  const i = all.findIndex((n) => n.id === id)
  if (i < 0) return 0
  return (i - (all.length - 1) / 2) * LANE_X
}

// How wide the active network is, for framing. Was `DISTRICT_X *
// (DISTRICTS.length - 1)`, which assumed the lanes were evenly spaced by
// construction; asking the layout means it stays true when they are not.
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

// Mark an ordinal as spoken for WITHOUT handing out the next one.
//
// takeLane always appends, which is right for a window that has just appeared:
// it joins the end of the queue. A window that MOVES picks its own slot -- the
// one opposite where it was, or the one it swapped into -- and the counter still
// has to hear about it, or the next new window on that side is laid down on top
// of it.
export function claimLane(id, side, lane) {
  const n = nodes.get(id)
  if (!n || !Number.isInteger(lane)) return false
  const k = side > 0 ? 'r' : 'l'
  n.lanes[k] = Math.max(n.lanes[k], lane + 1)
  return true
}

// Wind the counter BACK. The only caller is tidying a road, which has just
// closed up every gap on a side and knows exactly how many slots are now in
// use -- and a counter that only ever went up would keep handing out ordinals
// past the end of a road that had just been shortened, which is the very thing
// the tidy was for.
export function resetLane(id, side, used) {
  const n = nodes.get(id)
  if (!n || !Number.isInteger(used) || used < 0) return false
  n.lanes[side > 0 ? 'r' : 'l'] = used
  return true
}

// A workspace joins the ACTIVE network unless told otherwise, because every
// caller is something you did while standing in one.
export function add({ id, name, exits = [], open = true, tenant: t = activeTenant } = {}) {
  const key = id || `ws-${rnd()}`
  if (nodes.has(key)) return nodes.get(key)
  if (!tenants.has(t)) return null
  const siblings = [...nodes.values()].filter((n) => n.tenant === t).length
  nodes.set(key, {
    id: key,
    tenant: t,
    name: name || key,
    exits: exits.filter((e) => nodes.get(e)?.tenant === t),
    ramps: [],
    open,
    next: 1,
    lanes: { l: 0, r: 0 },
    // A new road takes the next lane along IN ITS OWN NETWORK. Never an existing
    // one -- adding a workspace must not renumber the ones already there.
    pos: siblings + 1,
  })
  const owner = tenants.get(t)
  if (!owner.root) owner.root = key
  touched()
  return nodes.get(key)
}

// An exit is ONE-WAY and WITHIN ONE NETWORK. `home -> build` does not imply
// `build -> home`; the seed states both directions explicitly because both are
// wanted, not because the graph invents the return trip. A gantry lane is an
// exit, and a road you can drive down but not back up is a thing a road network
// is allowed to have. A road that leaves the network is a RAMP -- see the header.
export function connect(from, to) {
  const a = nodes.get(from)
  const b = nodes.get(to)
  if (!a || !b || a.tenant !== b.tenant || from === to || a.exits.includes(to)) return false
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

export const exitsOf = (id) => {
  const n = nodes.get(id)
  if (!n) return []
  return n.exits.filter((e) => nodes.get(e)?.tenant === n.tenant)
}

// ------------------------------------------------------------------ the ramps
//
// A ramp hangs off a DASH on the centre line -- `at` is which dash -- and lands
// on any workspace in any network. Unlike an exit it is not numbered, not on the
// gate, and not part of the graph the map lays out: it is a place on a road, so
// it is addressed like a place.

export const rampsOf = (id) => {
  const n = nodes.get(id)
  if (!n) return []
  return n.ramps.filter((r) => nodes.has(r.to))
}

export const rampAt = (id, at) => rampsOf(id).find((r) => r.at === at) ?? null

// Every workspace a ramp from here can reach, which is what the map lights up
// alongside the exits. Deduped: two ramps to one workspace is legal (two places
// on the road to leave from) and it is still one destination.
export const rampTargets = (id) => [...new Set(rampsOf(id).map((r) => r.to))]

// BUILDING ONE REPLACES whatever was on that dash. The dash is the address, so
// asking for a ramp on an occupied marker is a change of destination and not an
// error -- refusing would mean removing before rebuilding, which is two gestures
// for one decision.
//
// ONE RAMP PER DASH, whichever side it leaves on. A left and a right ramp sharing
// a marker would be one marker you cannot aim at, and the marker is the address.
export function addRamp(from, at, to, side = 1) {
  const a = nodes.get(from)
  if (!a || !Number.isInteger(at) || at < 0 || !nodes.has(to) || to === from) return false
  a.ramps = dedupeRamps([...a.ramps.filter((r) => r.at !== at), { at, to, side: side === -1 ? -1 : 1 }])
  touched()
  return true
}

// MOVING ONE IS CHANGING ITS ADDRESS, and it is what the dash box on the ramp's
// page does. Refuses onto a dash that already carries a DIFFERENT ramp: `addRamp`
// replaces, which is right when you are deciding where a ramp goes and wrong when
// you are dragging one along a road -- there the thing you would destroy is not the
// thing you were looking at.
export function moveRamp(from, at, want) {
  const a = nodes.get(from)
  if (!a || !Number.isInteger(want) || want < 0) return false
  const r = a.ramps.find((x) => x.at === at)
  if (!r || want === at) return false
  if (a.ramps.some((x) => x.at === want)) return false
  r.at = want
  a.ramps = dedupeRamps(a.ramps)
  touched()
  return true
}

// Which way it leaves. Its own function rather than a rebuild through addRamp,
// because flipping a ramp keeps its destination and that is the whole point.
export function setRampSide(from, at, side) {
  const a = nodes.get(from)
  const r = a?.ramps.find((x) => x.at === at)
  const s = side === -1 ? -1 : 1
  if (!r || r.side === s) return false
  r.side = s
  touched()
  return true
}

export function cutRamp(from, at) {
  const a = nodes.get(from)
  if (!a) return false
  const before = a.ramps.length
  a.ramps = a.ramps.filter((r) => r.at !== at)
  if (a.ramps.length === before) return false
  touched()
  return true
}

// --------------------------------------------------------------- the editing

export function rename(id, name) {
  const n = nodes.get(id)
  const clean = String(name ?? '').trim().slice(0, 24)
  if (!n || !clean || clean === n.name) return false
  n.name = clean
  touched()
  return true
}

// EXIT ORDER IS THE PANEL ORDER. `exits` has always been an array and the exit
// gate lays its lanes out left to right in that order, so the sequence was
// already meaningful and simply had no way to be changed -- it was whatever
// order the edges happened to be added in. Moving one is a splice.
export function moveExit(from, to, delta) {
  const a = nodes.get(from)
  if (!a) return false
  const i = a.exits.indexOf(to)
  const j = i + Math.sign(delta)
  if (i < 0 || j < 0 || j >= a.exits.length) return false
  const [moved] = a.exits.splice(i, 1)
  a.exits.splice(j, 0, moved)
  touched()
  return true
}

// Assigning a number SWAPS with whoever holds it, within the same network.
//
// The alternative is to insert and shuffle everything after it along, which
// renumbers roads the person did not mention -- and a swap changes exactly two
// things and both of them are visible.
export function setPos(id, want) {
  const n = nodes.get(id)
  const p = Math.round(Number(want))
  if (!n || !Number.isInteger(p) || p < 1 || p === n.pos) return false
  const siblings = [...nodes.values()].filter((x) => x.tenant === n.tenant)
  if (p > siblings.length) return false
  const other = siblings.find((x) => x.pos === p)
  if (other) other.pos = n.pos
  n.pos = p
  touched()
  return true
}

// What the graph actually holds, without reading it off the screen. The proof
// hook for the network split: `laneMatchesOldArithmetic` recomputes the deleted
// single-network formula over the ACTIVE network and compares, rather than
// trusting a layout that merely looks right.
export const report = () => ({
  active: activeTenant,
  activeName: activeTenantName(),
  tenants: tenantList().map((t) => ({
    id: t.id,
    name: t.name,
    root: t.root,
    last: t.last,
    roads: [...nodes.values()].filter((n) => n.tenant === t.id).length,
  })),
  lanes: list().map((n, i, all) => ({
    id: n.id,
    name: n.name,
    pos: n.pos,
    open: n.open,
    x: laneX(n.id),
    laneMatchesOldArithmetic: laneX(n.id) === (i - (all.length - 1) / 2) * LANE_X,
    exits: exitsOf(n.id),
    ramps: rampsOf(n.id).map((r) => ({
      at: r.at,
      to: r.to,
      side: r.side > 0 ? 'right' : 'left',
      toName: nodes.get(r.to)?.name ?? null,
      toTenant: tenants.get(nodes.get(r.to)?.tenant)?.name ?? null,
      crossesNetwork: nodes.get(r.to)?.tenant !== n.tenant,
    })),
  })),
  foreign: [...nodes.values()].filter((n) => n.tenant !== activeTenant).map((n) => n.id),
})
