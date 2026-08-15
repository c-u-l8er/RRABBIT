// THE REEL -- every track at once, and the only place one can be thrown away.
//
// The map answers "where can I go". The reel answers "what am I working on",
// which is a different question about a different set: the map is drawn from the
// road graph and the reel is drawn from the tracks. They were the same list back
// when a number meant a road, and separating them is most of the point of tracks
// existing at all.
//
// WHY IT IS NOT A PAGE OF THE MAP. Two tracks parked on one road are one node on
// the map and two rows here, and there is no way to draw the second fact on a
// graph of roads without lying about the first. The map already carries `1 3` on
// a node to say who is standing there; that is a hint, and this is the list.
//
// WHAT A ROW SAYS, and why each field is on it:
//
//   number     what you press to get there
//   name       what you called it, if anything
//   parked     the road it is standing on -- or "nowhere" for a fresh one
//   trail      how many steps `back` can still walk
//   recording  how many steps were LOGGED, which is a different number and is
//              meant to look different: the trail is truncated by `back` and the
//              recording is not, so a track you have reversed out of shows a
//              short trail beside a long recording. That gap is the honest
//              picture of what happened and it is why both are shown.
//
// A RECORDING THAT LOST ITS FRONT SAYS SO. `recCut` is printed as `+N before`
// rather than folded into the total, because a tail that presents as a whole
// drive is the one way this list can mislead someone about what can be replayed.

import { state, hooks } from './world.js'
import * as ws from './workspaces.js'
import * as tracks from './tracks.js'

// Same shape as map.js: the shell hands the reel the verbs it does not own.
// Driving belongs to travel.js and always has -- the reel decides WHICH track,
// never how to get there.
let go = { track: null }
export function attachReel(handlers) {
  go = { ...go, ...handlers }
}

let el = null
let open = false
let poll = 0
let signature = ''

const CSS = `
#reel { position: fixed; inset: 0; z-index: 40; background: rgba(6,10,18,.94);
  color: #cfe0f5; font: 13px/1.5 ui-monospace, monospace; overflow: auto; padding: 28px; }
#reel h2 { margin: 0 0 4px; font-size: 15px; color: #f3ead4; letter-spacing: .12em; }
#reel .sub { margin: 0 0 18px; color: #6c7f9b; }
#reel table { border-collapse: collapse; width: 100%; max-width: 980px; }
#reel th { text-align: left; font-weight: normal; color: #6c7f9b; border-bottom: 1px solid #24304a;
  padding: 6px 10px; white-space: nowrap; }
#reel td { padding: 6px 10px; border-bottom: 1px solid #16202f; vertical-align: middle; }
#reel tr.on td { background: #0e1c2c; }
#reel .num { color: #2de2e6; font-weight: bold; width: 4ch; }
#reel tr.on .num { color: #f3ead4; }
#reel .nowhere { color: #55637a; }
#reel .cut { color: #d08b3c; }
#reel input.nm { background: #0b1220; border: 1px solid #24304a; color: #cfe0f5;
  font: inherit; padding: 3px 6px; width: 18ch; }
#reel input.nm:focus { outline: none; border-color: #2de2e6; }
#reel button { cursor: pointer; background: #101a2b; border: 1px solid #24304a;
  color: #9fb0c8; font: inherit; padding: 3px 9px; margin-left: 6px; }
#reel button:hover { border-color: #2de2e6; color: #f3ead4; }
#reel button.danger:hover { border-color: #e2554a; color: #ffb4ad; }
#reel button[disabled] { opacity: .3; cursor: default; }
#reel button[disabled]:hover { border-color: #24304a; color: #9fb0c8; }
#reel .foot { margin-top: 18px; color: #55637a; max-width: 980px; }
#reel .new { margin-top: 14px; }
#reel .new input { background: #0b1220; border: 1px solid #24304a; color: #cfe0f5;
  font: inherit; padding: 4px 8px; width: 6ch; }
`

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// WHAT THE LIST LOOKS LIKE RIGHT NOW, so a 700ms poll does not rebuild the DOM
// over a name you are halfway through typing. Same trick and the same reason as
// the map's signature.
function sig() {
  return (
    tracks.activeIndex() +
    '#' +
    tracks
      .list()
      .map((t) => {
        const r = tracks.recordingOf(t.id)
        return `${t.id}:${t.name}@${t.at}/${t.history.length}/${r.steps.length}/${r.cut}`
      })
      .join(',')
  )
}

function rows() {
  const activeId = tracks.activeIndex()
  const only = tracks.list().length <= 1
  return tracks
    .list()
    .map((t) => {
      const here = t.id === activeId
      const r = tracks.recordingOf(t.id)
      const where = t.at ? (ws.get(t.at)?.name ?? t.at) : null
      return (
        `<tr class="${here ? 'on' : ''}" data-id="${t.id}">` +
        `<td class="num">${t.id}</td>` +
        `<td><input class="nm" data-name="${t.id}" value="${esc(t.name)}" placeholder="—" maxlength="20"></td>` +
        `<td>${where ? esc(where) : '<span class="nowhere">nowhere yet</span>'}</td>` +
        `<td>${t.history.length}</td>` +
        // The cut is printed BESIDE the count and never added to it. `12 +40
        // before` is a recording of twelve steps that knows it is missing forty,
        // which is a different object from a recording of fifty-two.
        `<td>${r.steps.length}${r.cut ? ` <span class="cut">+${r.cut} before</span>` : ''}</td>` +
        `<td style="text-align:right">` +
        `<button data-goto="${t.id}"${here ? ' disabled' : ''}>${here ? 'here' : 'drive'}</button>` +
        `<button data-clear="${t.id}"${r.steps.length || r.cut ? '' : ' disabled'}>clear rec</button>` +
        // DELETING THE LAST TRACK IS REFUSED BY tracks.js, so the button is
        // disabled rather than present-and-failing. A control that does nothing
        // when pressed is worse than one that says it cannot.
        `<button class="danger" data-del="${t.id}"${only ? ' disabled' : ''}>delete</button>` +
        `</td></tr>`
      )
    })
    .join('')
}

function render(force = false) {
  if (!el) return
  const s = sig()
  if (!force && s === signature) return
  signature = s
  const n = tracks.list().length
  el.innerHTML =
    `<h2>REEL</h2>` +
    `<p class="sub">${n} track${n === 1 ? '' : 's'} · up to ${tracks.MAX} · press a number to drive one, 0 for the map, esc to close</p>` +
    `<table><thead><tr>` +
    `<th>#</th><th>name</th><th>parked on</th><th>trail</th><th>recording</th><th></th>` +
    `</tr></thead><tbody>${rows()}</tbody></table>` +
    `<div class="new">make: <input id="reel-new" placeholder="1-${tracks.MAX}" maxlength="3"> <button data-make="1">make &amp; drive</button></div>` +
    // The one thing about this screen a reader cannot deduce from the numbers.
    `<p class="foot">The trail is what <b>back</b> can still walk and it shrinks when you use it. ` +
    `The recording is what happened and it does not. A short trail beside a long recording means you reversed out of somewhere.</p>`
}

function install() {
  el = document.getElementById('reel')
  if (!el || el.dataset.ready) return
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  el.dataset.ready = '1'

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button')
    if (!b) return
    if (b.dataset.goto) {
      const id = Number(b.dataset.goto)
      closeReel()
      go.track?.(id)
      return
    }
    if (b.dataset.clear) {
      tracks.clearRecording(Number(b.dataset.clear))
      render(true)
      return
    }
    if (b.dataset.del) {
      tracks.remove(Number(b.dataset.del))
      render(true)
      return
    }
    if (b.dataset.make) {
      const box = el.querySelector('#reel-new')
      const id = Number(box?.value)
      // Out of range is left on screen rather than silently ignored -- typing
      // 1000 and having nothing happen reads as a broken button.
      if (!Number.isInteger(id) || id < 1 || id > tracks.MAX) {
        box?.focus()
        return
      }
      closeReel()
      go.track?.(id)
    }
  })

  // Renaming is live rather than on a commit key, matching the map's own name
  // field, and `render` will not stomp it because the signature includes names.
  el.addEventListener('input', (ev) => {
    const f = ev.target.closest('input.nm')
    if (f) tracks.rename(Number(f.dataset.name), f.value)
  })
}

export function openReel() {
  install()
  if (!el) return false
  open = true
  state.reelOpen = true
  el.hidden = false
  // TAKE THE KEYBOARD, for exactly the map's reason: the reel can be opened
  // while standing in a window, and the name fields would otherwise type into
  // the application behind it as well.
  hooks.shellKeyboard?.(true)
  render(true)
  clearInterval(poll)
  poll = setInterval(() => open && render(), 700)
  return true
}

export function closeReel() {
  if (!open) return false
  open = false
  state.reelOpen = false
  clearInterval(poll)
  poll = 0
  if (el) el.hidden = true
  hooks.shellKeyboard?.(false)
  return true
}

export const isOpen = () => open
export const toggleReel = () => (open ? closeReel() : openReel())

export const reelReport = () => ({
  open,
  count: tracks.list().length,
  max: tracks.MAX,
  rows: tracks.list().map((t) => {
    const r = tracks.recordingOf(t.id)
    return { id: t.id, name: t.name || null, at: t.at, trail: t.history.length, rec: r.steps.length, cut: r.cut }
  }),
})
