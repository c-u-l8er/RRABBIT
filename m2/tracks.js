// TRACKS -- ten trails through the network, running at the same time.
//
// The number keys used to be lane keys: `2` meant "the second road", and that is
// all it meant. It was a shortcut to a place, and the shell had exactly one idea
// of where you had been -- one history, shared by everything, so going back was
// going back from whatever you happened to have done last.
//
// A track is the other thing a number can be: not a place, but a THREAD OF WORK.
// Ten of them, each with its own current road and its own trail behind it. Two
// tracks can sit on the same road -- that is the point, and it is what a lane key
// could never express -- and pressing `back` on each of them goes somewhere
// different, because each remembers a different way of having arrived.
//
//   1  reading      home -> build -> home
//   2  the deploy   watch
//   3  reading      home            (same road as 1, nothing behind it)
//
// TEN, AND THE TENTH IS TYPED `1` `0`. Zero on its own is the map and always
// has been -- the digit buffer commits as soon as the number cannot grow, so a
// leading zero is never part of a track number while the zero in "10" always is.
// That rule already existed for lane numbers; this is what it was waiting for.

import * as ws from './workspaces.js'

export const COUNT = 10

const STORE_KEY = 'rrabbit.tracks.v1'

// A track is `{ id, name, at, history }`:
//
//   at       the road it is parked on, or null if it has never been anywhere
//   history  where it has been, oldest first, capped -- a trail to retrace and
//            not a log
//   roads    how far along each road this track had driven: { [wsId]: z }
//
// `roads` WAS ONE SHARED MAP IN travel.js, keyed by workspace. The argument for
// that was that where you are on a road is a fact about the road -- one copy
// rather than ten that can disagree. It is the wrong argument once tracks exist:
// two tracks parked on `home` are two different pieces of work that happen to be
// on the same road, and having one of them scroll the other's view is exactly
// the complaint per-workspace memory was introduced to fix, one level up.
// Asked for per track, and per track is right.
const HISTORY_MAX = 32

const tracks = []
let activeId = 1

function blank(id) {
  return { id, name: '', at: null, history: [], roads: {} }
}

function save() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        active: activeId,
        tracks: tracks.map((t) => ({
          id: t.id,
          name: t.name,
          at: t.at,
          history: [...t.history],
          roads: t.roads,
        })),
      }),
    )
  } catch {
    // A shell that cannot persist is still a working shell -- same trade
    // workspaces.js makes, and for the same private-mode reason.
  }
}

// A saved set is UNTRUSTED INPUT: it was written by an older build, and the
// workspaces it names may have been deleted since. Anything that no longer
// exists is dropped rather than left to become a track that goes nowhere.
function load() {
  for (let i = 1; i <= COUNT; i++) tracks.push(blank(i))
  let data = null
  try {
    if (new URLSearchParams(location.search).get('tracks') === 'reset') localStorage.removeItem(STORE_KEY)
    else data = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
  } catch {
    data = null
  }
  if (!data || !Array.isArray(data.tracks)) return
  for (const raw of data.tracks) {
    const t = tracks[Number(raw?.id) - 1]
    if (!t) continue
    t.name = typeof raw.name === 'string' ? raw.name.slice(0, 20) : ''
    t.at = ws.has(raw.at) ? raw.at : null
    t.history = Array.isArray(raw.history) ? raw.history.filter((id) => ws.has(id)).slice(-HISTORY_MAX) : []
    t.roads = {}
    if (raw.roads && typeof raw.roads === 'object') {
      for (const [id, z] of Object.entries(raw.roads)) {
        // A saved position for a road that is gone, or a value that is not a
        // number, is dropped rather than restored -- it would clamp to something
        // arbitrary on arrival and read as the shell losing your place.
        if (ws.has(id) && Number.isFinite(z)) t.roads[id] = z
      }
    }
  }
  if (Number.isInteger(data.active) && data.active >= 1 && data.active <= COUNT) activeId = data.active
}

load()

export const list = () => tracks
export const get = (id) => tracks[Number(id) - 1] ?? null
export const active = () => tracks[activeId - 1]
export const activeIndex = () => activeId

// Every track parked on a road, so the map can say `1 3` on a node. Answering
// this from the tracks rather than storing it on the workspace means it cannot
// drift: a workspace does not know or care who is standing on it.
export const on = (workspaceId) => tracks.filter((t) => t.at === workspaceId).map((t) => t.id)

export function rename(id, name) {
  const t = get(id)
  const clean = String(name ?? '').trim().slice(0, 20)
  if (!t || clean === t.name) return false
  t.name = clean
  save()
  return true
}

// The label a track goes by: its name if it has one, else just its number.
export const labelOf = (t) => (t?.name ? `${t.id} ${t.name}` : String(t?.id ?? '?'))

// WHERE SELECTING THIS TRACK SHOULD TAKE YOU.
//
// A TRACK THAT HAS NEVER BEEN ANYWHERE STARTS ON THE ROAD OF THE SAME NUMBER.
// Track 3 begins on the third road, if there is a third road.
//
// It started every unused track at the ROOT, on the argument that a repeatable
// origin beats one that depends on where you happened to be standing. The
// argument was right and the choice was wrong, because on a fresh shell it makes
// every unused track the same place: press 2, press 3, press 7, and you are on
// `home` every time. Reported as the numbers not working -- and from outside
// that is indistinguishable from a dead key, because the only thing that changed
// was a variable.
//
// Starting on road N is repeatable too, and it does something. It also means the
// number keys behave exactly like the lane keys they replaced right up until you
// move a track somewhere -- so nothing anyone had learned stops working, and the
// ten trails are what you get on top of it.
//
// Past the last road it falls back to the root: ten tracks and three roads is an
// ordinary state, and seven of them have to start somewhere.
//
// A track parked on a workspace that has since been CLOSED falls back the same
// way. Its road is not laid, so going there would put you in the air.
export function select(id) {
  const t = get(id)
  if (!t) return null
  activeId = t.id
  const parked = ws.get(t.at)
  const nth = ws.at(t.id - 1)
  const to = parked?.open ? t.at : nth?.open ? nth.id : ws.root()
  t.at = to
  save()
  return to
}

// HOW FAR ALONG A ROAD THIS TRACK HAD DRIVEN.
//
// Written on every wheel notch, so it does NOT save on every call -- one
// localStorage write per scroll notch is the kind of thing that makes a shell
// feel heavy for no reason anyone can see. It is coalesced onto a short timer
// instead, and the moments that actually matter (switching track, changing road)
// save on their own account anyway.
let parkTimer = 0
export function parkRoad(workspaceId, z) {
  const t = active()
  if (!t || !Number.isFinite(z)) return false
  if (t.roads[workspaceId] === z) return false
  t.roads[workspaceId] = z
  clearTimeout(parkTimer)
  parkTimer = setTimeout(save, 1000)
  return true
}

export const roadOf = (workspaceId) => active()?.roads?.[workspaceId]

// A JOURNEY on the active track. Only actual changes of road count -- arriving
// where you already are is not somewhere you have been -- and the trail is
// capped rather than grown forever.
export function arrive(workspaceId, { record = true } = {}) {
  const t = active()
  if (!t || !ws.has(workspaceId)) return false
  const moved = t.at !== workspaceId
  if (moved && record && t.at) {
    t.history.push(t.at)
    if (t.history.length > HISTORY_MAX) t.history.shift()
  }
  t.at = workspaceId
  save()
  return moved
}

// The most recent place on this track's trail that is somewhere else and still
// open. It POPS rather than pushes when taken (see back), or back would be a
// place you could go forward to and the control would oscillate between two
// roads.
export function backTarget() {
  const t = active()
  if (!t) return null
  for (let i = t.history.length - 1; i >= 0; i--) {
    const id = t.history[i]
    if (id !== t.at && ws.get(id)?.open) return id
  }
  return null
}

// Take the trail back one step: everything from that entry onward is dropped, so
// repeated backs walk the trail rather than bouncing off its end.
export function back() {
  const t = active()
  const id = backTarget()
  if (!id) return null
  t.history.length = t.history.lastIndexOf(id)
  save()
  return id
}

// A track that has wandered onto a workspace that no longer exists, or has one
// in its trail, is repaired here rather than at every reader. Called after the
// graph changes.
export function prune() {
  let changed = false
  for (const t of tracks) {
    if (t.at && !ws.has(t.at)) {
      t.at = null
      changed = true
    }
    for (const id of Object.keys(t.roads)) {
      if (!ws.has(id)) {
        delete t.roads[id]
        changed = true
      }
    }
    // AND COLLAPSE WHAT THE FILTER LEFT TOUCHING. Dropping the dead entry out of
    // `home, watch, gone, watch` leaves `watch` next to `watch` -- a trail that
    // reads as standing still twice, and one whose steps are no longer journeys.
    // It became easy to produce when a whole NETWORK could be removed: every road
    // in it leaves the trail at once, so the survivors either side meet.
    const kept = t.history.filter((id) => ws.has(id)).filter((id, i, all) => id !== all[i - 1])
    if (kept.length !== t.history.length) {
      t.history = kept
      changed = true
    }
  }
  if (changed) save()
  return changed
}

export function reset() {
  tracks.length = 0
  for (let i = 1; i <= COUNT; i++) tracks.push(blank(i))
  activeId = 1
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* nothing to remove */
  }
  return tracks
}

export const report = () => ({
  active: activeId,
  tracks: tracks.map((t) => ({
    id: t.id,
    name: t.name,
    at: t.at,
    history: [...t.history],
    roads: Object.fromEntries(Object.entries(t.roads).map(([k, v]) => [k, Math.round(v)])),
  })),
})
