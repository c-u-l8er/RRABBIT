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
// THE REEL IS GEAR R, not a screen with a key of its own.
//
// It was bound to `t` for about an hour, which was wrong twice over: the cockpit
// already has a detent labelled REEL sitting next to PARK and CAMERA, and the
// gate refuses a gear whose scene does not exist. So the scene existing is the
// whole of what R was waiting for, and adding a letter beside it would have been
// a second way in with its own rules -- the thing map.js declines to do for the
// same reason one paragraph up from its `openMapAt`.
//
// `leave` is how the reel says it has closed itself, so the stick can come out
// of R. Without it Esc would hide the reel and leave the cockpit reporting a
// gear with nothing behind it.
let go = { track: null, leave: null, replay: null }
export function attachReel(handlers) {
  go = { ...go, ...handlers }
}

// The last replay this screen was told about, refusal or otherwise. Held here
// rather than read out of travel.js so the reel has exactly one thing it knows
// about replaying: what it was handed when it asked.
let lastRefusal = null

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
#reel .refusal { margin: 14px 0 0; max-width: 980px; border: 1px solid #6b3a2a;
  background: #1a0f0b; color: #ffb4ad; padding: 10px 12px; }
#reel .refusal b { color: #ff8a7a; }
#reel .refusal .code { color: #d08b3c; }
#reel .refusal .ok { color: #7fd08b; }
#reel .new { margin-top: 14px; }
#reel .new input { background: #0b1220; border: 1px solid #24304a; color: #cfe0f5;
  font: inherit; padding: 4px 8px; width: 6ch; }
`

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSPORT -- a replay you can walk rather than only watch.
//
// It is NOT part of the reel, and that is deliberate: the reel is the list you
// pick from and it gets out of the way when a replay starts, whereas the point
// of a transport is to be visible WHILE the thing it controls is running. Same
// element lifecycle as the mirrors rather than the map.
//
// A BAR, NOT A SCREEN. Every control here acts on a replay that is happening on
// the road behind it, so covering the road would hide the only evidence that
// any of the buttons did anything.
//
// WHAT IT SURVIVES. These controls read an ordered list of discrete steps and
// nothing else -- they never ask what a step MEANS. So when the op vocabulary
// lands and `go`/`in`/`land` are replaced, this bar keeps working unchanged.
// That is why it was worth building before the vocabulary rather than after.
const TRANSPORT_CSS = `
#transport { position: fixed; left: 50%; transform: translateX(-50%); top: 14px;
  z-index: 44; background: rgba(8,14,24,.95); border: 1px solid #24304a;
  color: #cfe0f5; font: 12px/1.5 ui-monospace, monospace; padding: 8px 12px;
  display: flex; gap: 14px; align-items: center; white-space: nowrap;
  box-shadow: 0 6px 24px rgba(0,0,0,.5); }
/* AND THIS LINE IS THE WHOLE BUG THAT COST FOUR ROUNDS.
   The display:flex above is an id-selector author rule, so it outranks the user
   agent's [hidden] { display: none } -- which means el.hidden = true set the
   attribute and changed nothing on screen. The bar was correctly told to hide 55
   times and stayed up every time, so a replay that HAD ended looked like one
   that would not stop, and the frozen counters on it read as evidence about the
   handlers rather than about the poll having been cleared.
   #reel never showed this because it sets no display of its own. Any element in
   this shell that sets display must restate [hidden].
   (No backticks in here: this comment lives inside a template literal, and the
   first draft of it closed the string four lines early.) */
#transport[hidden] { display: none; }
#transport .who { color: #2de2e6; font-weight: bold; }
#transport .pos { color: #f3ead4; }
#transport .op { color: #9fb0c8; }
#transport .clocks { color: #55637a; }
#transport .refused { color: #ffb4ad; }
#transport button { cursor: pointer; background: #101a2b; border: 1px solid #24304a;
  color: #cfe0f5; font: inherit; padding: 3px 10px; }
#transport button:hover { border-color: #2de2e6; color: #f3ead4; }
#transport button[disabled] { opacity: .3; cursor: default; }
#transport button[disabled]:hover { border-color: #24304a; color: #cfe0f5; }
`

let tEl = null
let tPoll = 0
let tSig = ''

// The verbs the bar needs. Same handler shape as the reel's, same reason: the
// transport says WHICH control was pressed and never how replaying works.
let tGo = { pause: null, resume: null, step: null, back: null, stop: null, state: null }
export function attachTransport(handlers) {
  tGo = { ...tGo, ...handlers }
}

// A step as one readable phrase. The op vocabulary will replace the kinds; this
// function is the one place that has to know their names, on purpose.
function phrase(s) {
  if (!s) return '—'
  if (s.k === 'go') return `drive to ${s.to}`
  if (s.k === 'land') return `land on ${s.to}`
  if (s.k === 'in') return `enter ${s.district}:${s.milepost}`
  if (s.k === 'out') return `leave ${s.district}:${s.milepost}`
  return s.k
}

const ms = (n) => (n == null ? '—' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`)

function transportInstall() {
  tEl = document.getElementById('transport')
  if (!tEl || tEl.dataset.ready) return
  const style = document.createElement('style')
  style.textContent = TRANSPORT_CSS
  document.head.appendChild(style)
  tEl.dataset.ready = '1'
  tEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button')
    if (!b) return
    if (b.dataset.act === 'pause') tGo.pause?.()
    else if (b.dataset.act === 'resume') tGo.resume?.()
    else if (b.dataset.act === 'step') tGo.step?.()
    else if (b.dataset.act === 'back') tGo.back?.()
    else if (b.dataset.act === 'stop') tGo.stop?.()
    transportRender(true)
  })
}

function transportRender(force = false) {
  if (!tEl) return
  const st = tGo.state?.()
  if (!st) {
    // A transport with nothing to transport hides itself rather than sitting
    // there greyed out -- the road is the thing worth looking at. It also stops
    // its own poll: a replay that ran to the end takes the bar down without
    // anyone calling `transportStop`, and a timer left spinning behind a hidden
    // element is the shape of leak this shell has an idle brake for.
    if (!tEl.hidden) { tEl.hidden = true; tSig = '' }
    clearInterval(tPoll)
    tPoll = 0
    return
  }
  // The counters are in the signature so pressing a key or a button repaints the
  // bar even when nothing else moved -- otherwise the one thing this instrument
  // exists to show would be the one thing the poll optimises away.
  const sig = `${st.id}/${st.i}/${st.paused}/${st.refusals.length}/${state.mode}`
  if (!force && sig === tSig) return
  tSig = sig
  tEl.hidden = false
  const t = tracks.get(st.id)
  const refused = st.refusals[st.refusals.length - 1]
  tEl.innerHTML =
    `<span class="who">${esc(tracks.labelOf(t))}</span>` +
    `<span class="pos">${st.i} / ${st.total}</span>` +
    // `end` reads as a position now rather than as an announcement, because the
    // replay parks there instead of leaving. `[X]` is the way out.
    `<span class="op">${esc(phrase(st.now))}${st.next ? `  →  ${esc(phrase(st.next))}` : '  ·  at the end'}</span>` +
    // Both clocks side by side. `was` is where this sat in the original drive,
    // `elapsed` is this replay's own wall time -- see replayState().
    `<span class="clocks">rec ${ms(st.now?.t)} · run ${ms(st.elapsed)}</span>` +
    (refused ? `<span class="refused">${esc(refused.code)}</span>` : '') +
    // THE INSTRUMENT. Temporary, and it says so. `esc` counts Escapes that
    // reached travel.js's capture listener / ones that took the replay branch;
    // `tap` counts clicks that reached this bar / landed on a button; `mode` is
    // the shell mode, because the pointer swallow only bites in `flat`.
    // ASCII, NOT MEDIA GLYPHS. `⏮ ⏸ ▶ ⏭ ⏹` all rendered as tofu on the target --
    // the image's font has no U+23Ex block -- so every button wore an empty box
    // it did not ask for. A control that is illegible on the machine it ships on
    // is not a control, and the shell is monospace everywhere else anyway.
    //
    // Back sits LEFT of play, where a transport puts it, so the row reads as a
    // transport rather than as a list of buttons that happen to include one.
    `<button data-act="back"${st.i > 0 ? '' : ' disabled'}>|&lt; back</button>` +
    (st.paused
      // Play is dead at the end -- there is nothing left to play, and a button
      // that visibly does nothing is how the last four rounds started.
      ? `<button data-act="resume"${st.next ? '' : ' disabled'}>&gt; play</button>`
      : `<button data-act="pause">|| pause</button>`) +
    `<button data-act="step"${st.next ? '' : ' disabled'}>&gt;| step</button>` +
    // Named "exit" rather than "stop": it was the only way out and did not read
    // as one. Esc does the same thing (travel.js), which is the real fix.
    // `[X]` alone. It read `[x] exit · esc`, which advertised a key that is the
    // most overloaded one in the shell -- Esc already leaves a window, shuts the
    // map and shuts the reel -- so the label was making a promise about a key
    // whose meaning depends on what else is open.
    `<button data-act="stop" title="stop the replay">[X]</button>`
}

export function transportStart() {
  transportInstall()
  clearInterval(tPoll)
  // 200ms rather than the reel's 700: this one is watched while it moves, and a
  // position counter that updates three times a second reads as broken.
  tPoll = setInterval(() => transportRender(), 200)
  transportRender(true)
}

export function transportStop() {
  clearInterval(tPoll)
  tPoll = 0
  if (tEl) tEl.hidden = true
  tSig = ''
}

export const transportReport = () => ({ shown: !!tEl && !tEl.hidden, state: tGo.state?.() ?? null })

// WHAT THE LIST LOOKS LIKE RIGHT NOW, so a 700ms poll does not rebuild the DOM
// over a name you are halfway through typing. Same trick and the same reason as
// the map's signature.
function sig() {
  return (
    tracks.activeIndex() +
    // The refusal is part of what is on screen, so it has to be part of the
    // signature or the poll would paint over a banner that had just appeared.
    '#' + (lastRefusal ? `${lastRefusal.id}:${lastRefusal.code ?? lastRefusal.refusals?.[0]?.code}` : '-') +
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
        // REPLAY IS THE VERB THE RECORDING EXISTS FOR. Disabled with nothing to
        // walk -- a button that refuses on press is worse than one that says it
        // cannot, the same call the delete button already makes.
        `<button data-replay="${t.id}"${r.steps.length ? '' : ' disabled'}>replay</button>` +
        // WALK is the same replay started paused, not a second mode. The
        // transport's step button does the advancing either way, so this is only
        // a question of whether the clock is running when it appears.
        `<button data-walk="${t.id}"${r.steps.length ? '' : ' disabled'}>walk</button>` +
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

// WHY THE LAST REPLAY DID NOT RUN, in the words the refusal itself used.
//
// The code is printed beside the sentence on purpose. The sentence is for the
// person; the code is the thing worth quoting in a report, and a screen that
// only showed prose would make every account of a refusal a paraphrase.
function refusalBlock() {
  if (!lastRefusal) return ''
  const r = lastRefusal
  const first = r.refusals?.[0]
  const code = r.code ?? first?.code ?? 'TRACK_REFUSED'
  const why = r.why ?? first?.why ?? 'refused'
  const at = first && first.i >= 0 ? ` at step ${first.i + 1} of ${r.plan?.steps ?? '?'}` : ''
  const more = r.refusals && r.refusals.length > 1 ? ` · ${r.refusals.length - 1} more step(s) also refuse` : ''
  return (
    `<p class="refusal"><b>track ${r.id} did not run</b> — <span class="code">${esc(code)}</span> ` +
    `${esc(why)}${at}${more}.<br>` +
    // The line that keeps this from reading as an error message.
    `<span class="ok">Refusing is the correct outcome.</span> The world moved since this was ` +
    `recorded, so the route no longer describes it. Nothing was driven.</p>`
  )
}

function render(force = false) {
  if (!el) return
  const s = sig()
  if (!force && s === signature) return
  signature = s
  const n = tracks.list().length
  el.innerHTML =
    `<h2>REEL</h2>` +
    `<p class="sub">${n} track${n === 1 ? '' : 's'} · up to ${tracks.MAX} · gear R · press a number to drive one, esc back to D</p>` +
    `<table><thead><tr>` +
    `<th>#</th><th>name</th><th>parked on</th><th>trail</th><th>recording</th><th></th>` +
    `</tr></thead><tbody>${rows()}</tbody></table>` +
    `<div class="new">make: <input id="reel-new" placeholder="1-${tracks.MAX}" maxlength="3"> <button data-make="1">make &amp; drive</button></div>` +
    refusalBlock() +
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
    if (b.dataset.replay || b.dataset.walk) {
      const id = Number(b.dataset.replay ?? b.dataset.walk)
      const paused = !!b.dataset.walk
      // A REFUSAL IS SHOWN HERE AND THE SCREEN STAYS UP. That asymmetry is the
      // point: a replay that started is something to watch, so the reel gets out
      // of the way; a replay that was refused is something to READ, and closing
      // over it would hide the only useful thing that happened.
      const out = go.replay?.(id, { paused })
      if (out && out.started) {
        closeReel()
      } else {
        lastRefusal = { id, ...(out ?? { why: 'no replayer wired' }) }
        render(true)
      }
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
  // A REFUSAL IS ABOUT ONE ATTEMPT, not about the screen. Carrying it across a
  // close would make an old failure look like a fresh one the next time the
  // reel came up, which is the same "a stale record read as current" fault the
  // trail/recording split exists to avoid one level down.
  lastRefusal = null
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
  // AFTER the flag is down, so a `leave` that shifts the gear cannot re-enter
  // this function and recurse: `setGear('D')` fires `onGear`, which calls
  // `closeReel` again, which now returns false at the guard above.
  go.leave?.()
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
