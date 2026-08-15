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
// UP TO 999, AND THEY STACK UP AS YOU MAKE THEM. Zero on its own is the map and
// always has been -- the digit buffer commits as soon as the number cannot grow,
// so a leading zero is never part of a track number while the zero in "10" always
// is. That rule already existed for lane numbers; this is what it was waiting for.
//
// THE BOUND ON "CANNOT GROW" IS THE POPULATION, NOT THE CEILING. It was ten, so
// one pause covered the only ambiguity there was: a lone `1` might still become
// `10`. At 999 the ambiguity is two digits deep, and reading the ceiling would
// make EVERY single-digit switch wait out the gap -- worst for the low numbers,
// which are the ones anybody actually presses. So `canGrow` asks which tracks
// EXIST: with nine or fewer of them nothing can grow, every switch commits on the
// keystroke, and the timer never runs. The gap comes back only once a longer
// number is genuinely reachable. Bigger is faster, which is the opposite of what
// porting the fixed bound would have got.
//
// SPARSE, so track 300 costs one entry and not three hundred. A number that has
// never been used is not a track that is empty -- it is a track that is not
// there, which is what lets the reel show a list worth reading.

import * as ws from './workspaces.js'

// The ceiling. `canGrow` is what the digit buffer actually consults; this only
// says which numbers are legal at all.
export const MAX = 999

// v2: sparse (a map, not ten slots) and each track carries an append-only
// recording beside its trail. v1 sets load as an older build's -- `load` already
// treats every saved set that way, so there is nothing special to do about them.
const STORE_KEY = 'rrabbit.tracks.v2'

// THE TRAIL IS NOT THE RECORDING, AND ONE ARRAY CANNOT BE BOTH.
//
// `history` is capped, dedupes neighbours, and `back` TRUNCATES it -- everything
// from the entry taken onward is dropped, or back would oscillate. Those are the
// right behaviours for retracing and they are all lossy, which is exactly what a
// recording must not be. So driving appends to `rec` as well, and `rec` is only
// ever appended to. The comment on `history` already said it was "a trail to
// retrace and not a log"; this is the log.
//
// Capped too -- localStorage is a few megabytes and a shell that will not start
// because a track drove too far is not a shell. But the loss is RECORDED rather
// than silent: `recCut` counts what fell off the front, so a replay knows it is
// looking at a tail and can refuse to claim it is the whole drive.
const REC_MAX = 4096

// A track is `{ id, name, at, history }`:
//
//   at       the road it is parked on, or null if it has never been anywhere
//   history  where it has been, oldest first, capped -- a trail to retrace and
//            not a log
//   roads    how far along each road this track had driven: { [wsId]: z }
//   in       the window it was standing IN, `{district, milepost}` or null
//
// `in` IS THE SAME ARGUMENT AS `roads`, ONE STEP FURTHER IN. Where you are on a
// road is part of what a track is; being inside a window is more of that, not less
// -- it is the state you are most likely to be in when a number key gets pressed,
// because being in a window is what working looks like. Leaving a track dropped you
// out onto the road and coming back left you there, so a switch out and straight
// back was not a round trip. Reported.
//
// `roads` WAS ONE SHARED MAP IN travel.js, keyed by workspace. The argument for
// that was that where you are on a road is a fact about the road -- one copy
// rather than ten that can disagree. It is the wrong argument once tracks exist:
// two tracks parked on `home` are two different pieces of work that happen to be
// on the same road, and having one of them scroll the other's view is exactly
// the complaint per-workspace memory was introduced to fix, one level up.
// Asked for per track, and per track is right.
const HISTORY_MAX = 32

// Keyed by id, insertion-ordered by creation. `list()` sorts, so the reel can
// show them by number while the map keeps whatever order it asks for.
const tracks = new Map()
let activeId = 1

function blank(id) {
  return { id, name: '', at: null, history: [], roads: {}, in: null, rec: [], recCut: 0 }
}

// APPEND TO THE RECORDING. Never anywhere else -- `history` has its own writer
// and the two are deliberately not kept in step, because `back` edits one of them
// and must not edit the other.
//
// `t` is milliseconds since this track's first recorded step, not wall-clock: a
// recording is about a drive, and the hour it happened in is not part of the
// route. It also keeps the number small enough to store a few thousand of them.
function rec(t, kind, data) {
  if (!t) return
  if (!t.rec.length) t.recEpoch = Date.now()
  t.rec.push({ t: Date.now() - (t.recEpoch ?? Date.now()), k: kind, ...data })
  if (t.rec.length > REC_MAX) {
    t.rec.shift()
    t.recCut++
  }
}

function save() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        active: activeId,
        tracks: [...tracks.values()].map((t) => ({
          id: t.id,
          name: t.name,
          at: t.at,
          history: [...t.history],
          roads: t.roads,
          rec: t.rec,
          recCut: t.recCut,
          // Saved even though a window never survives a reload -- there is no
          // window store, and the clients are relaunched rather than restored. It
          // costs two fields, it is dropped on load when the window is not there
          // (see below), and if session restore is ever built this is already the
          // half of it that says which track was in what.
          in: t.in,
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
  let data = null
  try {
    if (new URLSearchParams(location.search).get('tracks') === 'reset') localStorage.removeItem(STORE_KEY)
    else data = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
  } catch {
    data = null
  }
  // A FRESH SHELL HAS ONE TRACK, NOT NONE. Zero tracks means the first number
  // pressed has nothing to be relative to and the reel opens empty, which reads
  // as broken rather than new.
  if (!data || !Array.isArray(data.tracks)) {
    tracks.set(1, blank(1))
    return
  }
  for (const raw of data.tracks) {
    const id = Number(raw?.id)
    // An id from an older or hand-edited store is untrusted like everything else
    // here: out of range or not a whole number and the track is not created.
    if (!Number.isInteger(id) || id < 1 || id > MAX) continue
    const t = blank(id)
    tracks.set(id, t)
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
    // The road has to still exist for the address to mean anything. Whether the
    // WINDOW is still there is not decidable here -- surfaces arrive after this
    // module loads -- so that half is checked at the moment of arrival, which is
    // the only moment it can be answered honestly.
    t.in =
      raw.in && ws.has(raw.in.district) && Number.isInteger(raw.in.milepost)
        ? { district: raw.in.district, milepost: raw.in.milepost }
        : null
    // The recording is replayed, so a malformed step is worse than a missing
    // one: anything without a whole `t` and a `k` is dropped here rather than
    // handed to a replayer that would have to guess what it meant.
    t.rec = Array.isArray(raw.rec)
      ? raw.rec.filter((s) => s && Number.isFinite(s.t) && typeof s.k === 'string').slice(-REC_MAX)
      : []
    // Carried forward AND added to: entries this load dropped are as gone as the
    // ones the cap dropped when they were written.
    t.recCut =
      (Number.isInteger(raw.recCut) && raw.recCut >= 0 ? raw.recCut : 0) +
      Math.max(0, (Array.isArray(raw.rec) ? raw.rec.length : 0) - t.rec.length)
  }
  if (!tracks.size) tracks.set(1, blank(1))
  activeId = tracks.has(data.active) ? data.active : [...tracks.keys()].sort((a, b) => a - b)[0]
}

load()

// Sorted by number. The map's cache key reads this, so a stable order is not
// cosmetic -- an unstable one would rebuild the map on every frame.
export const list = () => [...tracks.values()].sort((a, b) => a.id - b.id)
export const get = (id) => tracks.get(Number(id)) ?? null
export const active = () => tracks.get(activeId) ?? null
export const activeIndex = () => activeId
export const count = () => tracks.size

// CREATE ON DEMAND -- this is what "they stack up as you input them" means. A
// number that is legal but unused becomes a track the moment it is asked for,
// and until then it is not in the list and not in the reel.
export function ensure(id) {
  const n = Number(id)
  if (!Number.isInteger(n) || n < 1 || n > MAX) return null
  let t = tracks.get(n)
  if (!t) {
    t = blank(n)
    tracks.set(n, t)
    save()
  }
  return t
}

// CAN THIS PREFIX STILL GROW INTO A TRACK THAT EXISTS?
//
// The whole reason the digit gap can usually be skipped. Two ways to answer no,
// and both have to hold or the grammar breaks:
//
//   - another digit would put it past the ceiling, so there is nothing to wait
//     for at any population;
//   - no track that EXISTS has this as a proper prefix, so waiting could only
//     ever produce a number nobody has made yet.
//
// It asks about existing tracks on purpose. Typing an unused number still makes
// one -- it just does not have to wait first, because there was nothing longer to
// be confused with.
export function canGrow(prefix) {
  const s = String(prefix ?? '')
  if (!s || Number(s) * 10 > MAX) return false
  for (const id of tracks.keys()) {
    const k = String(id)
    if (k.length > s.length && k.startsWith(s)) return true
  }
  return false
}

// DELETING THE LAST ONE IS REFUSED. The shell has no state for "no track" -- the
// gantry reads a label, the map draws a marker -- and inventing one to serve a
// button that empties a list is a worse trade than the button not working.
export function remove(id) {
  const n = Number(id)
  if (!tracks.has(n) || tracks.size <= 1) return false
  tracks.delete(n)
  if (activeId === n) activeId = [...tracks.keys()].sort((a, b) => a - b)[0]
  save()
  return true
}

// Every track parked on a road, so the map can say `1 3` on a node. Answering
// this from the tracks rather than storing it on the workspace means it cannot
// drift: a workspace does not know or care who is standing on it.
export const on = (workspaceId) =>
  [...tracks.values()].filter((t) => t.at === workspaceId).map((t) => t.id).sort((a, b) => a - b)

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
  // `ensure` rather than `get`: selecting a number that has never been used is
  // how a track gets made, so this is the create path as well as the switch one.
  const t = ensure(id)
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

// AND WHICH WINDOW IT WAS STANDING IN, if any.
//
// Saved on the ACTIVE track, which is why the caller has to write it before
// `select` flips which track that is -- the same ordering `parkRoad` needs and the
// same mistake it already documents. Saved immediately rather than on a timer:
// unlike a wheel notch this happens once per switch, and it is the fact the switch
// exists to preserve.
export function parkFlat(where) {
  const t = active()
  if (!t) return false
  const next =
    where && ws.has(where.district) && Number.isInteger(where.milepost)
      ? { district: where.district, milepost: where.milepost }
      : null
  const same = (a, b) => (!a && !b) || (!!a && !!b && a.district === b.district && a.milepost === b.milepost)
  if (same(t.in, next)) return false
  // Going INTO a window and coming back OUT are different events, and a
  // recording that collapsed them to "the window changed" could not say which
  // way. `out` carries where it left FROM, because by the time it is replayed
  // `t.in` is already the next thing.
  if (next) rec(t, 'in', { district: next.district, milepost: next.milepost })
  else if (t.in) rec(t, 'out', { district: t.in.district, milepost: t.in.milepost })
  t.in = next
  save()
  return true
}

// Where the track you are ARRIVING on was standing. Not `active()` in disguise --
// both callers read it right after `select`, so the active track is already the
// incoming one; this is written the long way so a future caller cannot be surprised
// by which track it answers about.
export const flatOf = (id) => get(id)?.in ?? null

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
  // RECORDED EVEN WHEN THE TRAIL IS NOT. `record:false` means "this arrival is a
  // restore, do not put it on the trail" -- switching to a track lands you where
  // it was standing and that is not somewhere you drove. It is still something
  // that HAPPENED, and a log that omits it cannot be replayed: the next step
  // would start from a road the replayer was never told it was on. So the trail
  // takes the flag and the recording does not.
  if (moved) rec(t, record ? 'go' : 'land', { to: workspaceId, from: t.at ?? null })
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
  for (const t of tracks.values()) {
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
  tracks.clear()
  tracks.set(1, blank(1))
  activeId = 1
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* nothing to remove */
  }
  return tracks
}

// THE RECORDING IS NOT PRUNED, and that is the point rather than an omission.
// `at`, `roads` and `history` are all claims about where you can go NOW, so a
// dead road has to come out of them or they send you nowhere. `rec` is a claim
// about what happened, and it stays true after the road is gone. Editing it to
// match the present is how a log becomes a story.

export const report = () => ({
  active: activeId,
  count: tracks.size,
  tracks: list().map((t) => ({
    id: t.id,
    name: t.name,
    at: t.at,
    history: [...t.history],
    // Length and loss, not the steps -- `report` is read in a console and a few
    // thousand entries would bury everything else. `__rec(id)` prints the steps.
    rec: t.rec.length,
    recCut: t.recCut,
    roads: Object.fromEntries(Object.entries(t.roads).map(([k, v]) => [k, Math.round(v)])),
    // The address only. Whether the shell actually got you back inside it is a
    // question about `state.mode`, not about this record, and the two are reported
    // separately on purpose -- a track that remembers a window it could not return
    // to should read as exactly that.
    in: t.in ? `${t.in.district}:${t.in.milepost}` : null,
  })),
})

// THE RECORDING ITSELF. A copy, because a caller that could splice this would be
// editing a log, and `recCut` beside it because a tail that does not say it is a
// tail is the one way this record can lie.
export const recordingOf = (id) => {
  const t = get(id)
  return t ? { steps: t.rec.map((s) => ({ ...s })), cut: t.recCut, whole: t.recCut === 0 } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLAY: A TRACK CHECKS, A MACRO REPEATS.
//
// This is the whole difference and it is worth stating before any of the code.
// A macro replays a fixed sequence and does whatever that sequence now lands on
// -- which on a world that has moved is a confident wrong action. A track
// declares what it ASSUMED and refuses when the assumption is gone.
//
// So REFUSAL IS A CORRECT OUTCOME here, not a failure path. A replay that stops
// and names the road that disappeared has done its job. One that quietly drives
// somewhere else has not, however far it got.
//
// TWO PHASES, AND THE SPLIT IS FORCED RATHER THAN CHOSEN:
//
//   precheck   roads, answerable now, before anything moves. A recording whose
//              third step names a deleted road should never take the first.
//   at arrival windows, which are NOT answerable now -- surfaces arrive after
//              this module loads. `load` already makes exactly this split for
//              `in`, for exactly this reason, and says so.
//
// The second phase is also the honest answer to the check/use race: the world
// can move BETWEEN the precheck and the step, so every step is re-checked
// immediately before it runs. That narrows the window; it does not close it, and
// nothing here should claim otherwise.
//
// NO SILENT REPAIR. A step whose road is gone is refused by name. It is never
// mapped onto a nearby road, the root, or the next entry -- the same law D′
// states for the edit algebra, and for the same reason: a replay that fixed
// itself would be a different drive wearing the original's identity.

export const REFUSE = {
  EMPTY: 'TRACK_EMPTY',
  ROAD_GONE: 'TRACK_ROAD_GONE',
  ROAD_CLOSED: 'TRACK_ROAD_CLOSED',
  WINDOW_GONE: 'TRACK_WINDOW_GONE',
  BUSY: 'TRACK_BUSY',
}

// What one step assumes, answered as far as it can be answered WITHOUT having
// arrived. `null` means nothing here refuses it; it does not mean the step will
// succeed, and the caller re-asks at arrival.
export function checkStep(s) {
  if (!s) return { code: REFUSE.EMPTY, why: 'no step' }
  if (s.k === 'go' || s.k === 'land') {
    if (!ws.has(s.to)) return { code: REFUSE.ROAD_GONE, why: `road ${s.to} is gone`, road: s.to }
    if (!ws.get(s.to)?.open) return { code: REFUSE.ROAD_CLOSED, why: `road ${s.to} is closed`, road: s.to }
    return null
  }
  if (s.k === 'in') {
    // The district half IS answerable now; the window on it is not.
    if (!ws.has(s.district)) return { code: REFUSE.ROAD_GONE, why: `road ${s.district} is gone`, road: s.district }
    return null
  }
  return null
}

// THE WHOLE RECORDING, BEFORE ANYTHING MOVES.
//
// `deferred` is reported rather than folded into `ok`, because "nothing refuses
// this yet" and "this is checked" are different claims and collapsing them is
// how a precheck starts overpromising. A plan with 9 deferred window steps is
// 9 questions that have not been asked.
export function precheck(id) {
  const t = get(id)
  if (!t) return { ok: false, steps: 0, deferred: 0, refusals: [{ i: -1, code: REFUSE.EMPTY, why: 'no such track' }] }
  if (!t.rec.length) return { ok: false, steps: 0, deferred: 0, refusals: [{ i: -1, code: REFUSE.EMPTY, why: 'nothing recorded' }] }
  const refusals = []
  let deferred = 0
  t.rec.forEach((s, i) => {
    if (s.k === 'in' || s.k === 'out') deferred++
    const bad = checkStep(s)
    if (bad) refusals.push({ i, ...bad, step: { ...s } })
  })
  return {
    ok: refusals.length === 0,
    steps: t.rec.length,
    deferred,
    refusals,
    // Stated on the plan itself so a caller cannot read `ok` as "this will work".
    note: 'roads are checked; windows are answered at arrival',
    cut: t.recCut,
    whole: t.recCut === 0,
  }
}

// The steps a replayer should walk. A copy, and `out` is dropped: leaving a
// window is a thing that HAPPENED and worth recording, but replaying it is a
// no-op the driver already does on its way to the next road.
export function replaySteps(id) {
  const t = get(id)
  return t ? t.rec.filter((s) => s.k !== 'out').map((s) => ({ ...s })) : []
}

// Dropping just the recording, which is not the same act as deleting the track.
// The reel needs both: a drive worth forgetting is not a piece of work worth
// forgetting, and conflating them would make clearing a mistake cost the trail
// and the name as well.
export function clearRecording(id) {
  const t = get(id)
  if (!t || (!t.rec.length && !t.recCut)) return false
  t.rec = []
  t.recCut = 0
  delete t.recEpoch
  save()
  return true
}
