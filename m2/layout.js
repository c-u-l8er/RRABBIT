// WHAT THE SHELL REMEMBERS ABOUT A WINDOW BETWEEN LIVES.
//
// A window is a running program, so nothing about one survives a reload: the
// clients die with the page and the launch plan opens fresh ones (shell.js). The
// graph survives, the tracks survive, and until now everything you had told the
// shell about a WINDOW did not -- so a resize was a decision you had to make again
// after every reload. Asked for, and a shape you chose is exactly the kind of thing
// a shell is supposed to hold on to.
//
// KEYED BY ADDRESS, AND THAT IS THE WHOLE CAVEAT. `home:1` is the shell's name for
// a window, not the application's, and a relaunched client carries no identity we
// could match on instead -- the five windows the default plan opens are the same
// program with the same title, so the title is not a key and neither is anything
// else the client tells us. The size therefore follows the ADDRESS: whatever stands
// at `home:1` next gets the size the last thing at `home:1` was given. Under the
// launch plan that is the same program in the same place, which is right; open
// something else there and it inherits a shape it never asked for, which is the
// honest price of having no better key. Say so rather than pretend it is identity.
//
// ONLY SIZES THE SHELL WAS ASKED FOR. A client that resizes itself is doing its own
// job, and storing that to impose it again later would be the shell arguing with a
// program about how big it wants to be. What is kept is the size a DRAG settled on
// -- and the size it actually reached, not the one that was asked for, because a
// client is free to clamp and the remembered shape has to be one that exists.

const STORE_KEY = 'rrabbit.layout.v1'

// A cap, so a long-lived profile cannot grow this without bound. Addresses are
// never reused within a workspace, so windows opened and closed all afternoon each
// leave an entry behind.
const MAX = 240

// `district:milepost` -> { w, h }
const sizes = new Map()

const addr = (district, milepost) =>
  district && Number.isInteger(milepost) ? `${district}:${milepost}` : null

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ sizes: [...sizes].map(([k, v]) => [k, v.w, v.h]) }))
  } catch {
    // A shell that cannot persist is still a working shell -- the same trade
    // workspaces.js and tracks.js make, and for the same private-mode reason.
  }
}

// A saved set is UNTRUSTED INPUT, written by an older build. Anything that is not
// a pair of sane pixel counts is dropped rather than restored: a bad value here
// does not read as a bad value, it reads as a window that came back the wrong
// shape, and there is nothing on screen to trace that back to.
function load() {
  let data = null
  try {
    if (new URLSearchParams(location.search).get('layout') === 'reset') localStorage.removeItem(STORE_KEY)
    else data = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
  } catch {
    data = null
  }
  if (!data || !Array.isArray(data.sizes)) return
  for (const row of data.sizes.slice(-MAX)) {
    if (!Array.isArray(row) || row.length !== 3) continue
    const [k, w, h] = row
    if (typeof k !== 'string' || !k.includes(':')) continue
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 16384 || h > 16384) continue
    sizes.set(k, { w, h })
  }
}

load()

export function sizeOf(district, milepost) {
  const k = addr(district, milepost)
  return k ? (sizes.get(k) ?? null) : null
}

// Returns whether anything changed, so a caller can tell "stored" from "already
// knew that" without comparing itself.
export function remember(district, milepost, w, h) {
  const k = addr(district, milepost)
  if (!k || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return false
  const had = sizes.get(k)
  if (had && had.w === w && had.h === h) return false
  // Re-inserted rather than updated in place, so the Map's own order is
  // least-recently-set first and the cap drops the oldest.
  sizes.delete(k)
  sizes.set(k, { w, h })
  while (sizes.size > MAX) sizes.delete(sizes.keys().next().value)
  save()
  return true
}

export function forget(district, milepost) {
  const k = addr(district, milepost)
  if (!k || !sizes.delete(k)) return false
  save()
  return true
}

export const report = () => Object.fromEntries([...sizes].map(([k, v]) => [k, [v.w, v.h]]))
