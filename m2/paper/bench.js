// DOES FRAME TIME STAY FLAT IN N? The instrument that answers rung 4.
//
// WHY THIS EXISTS AT ALL. The first attempt at this number was reading the dash's
// FRAME gauge off a screenshot of the guest: 17.1 ms with no panes, 51.2 with five.
// That looked like a finding. Three more samples gave 67.7 / 34.3 / 67.4 -- the
// spread was the IDLE BRAKE engaging between samples, not pane cost. A photograph
// of a dial samples the brake as much as the scene.
//
// So the instrument has to do three things the photograph could not:
//
//   1. SWEEP N rather than compare two numbers. "Flat in N" is a claim about a
//      curve; two points cannot distinguish flat from linear.
//   2. REPORT THE CONFOUND rather than assume it away. Every step records
//      `__fed().hz` -- 0 means uncapped -- and any step where the brake was
//      capping is marked `tainted` and excluded from the verdict. The brake only
//      engages after 60 s of quiet, so a bench that finishes inside that window
//      never meets it; recording hz is what turns "never meets it" from an
//      assumption into a measurement.
//   3. DRAW ITS OWN RESULT. The guest has no console. An overlay the page renders
//      makes a screenshot a valid instrument again, because what is photographed
//      is a number the page computed rather than a needle being interpreted.
//
// WHAT IT MEASURES. rAF intervals. Every rAF in the page is driven by the same
// display cadence the shell renders on, so the interval between our callbacks IS
// the achieved frame time including the shell's work. It is not a profiler and
// cannot say WHERE the time went -- only whether it grows with N.

import { placePaper, clearPapers, syncPaper, paperReport } from '../paper.js'
import { floorsOf } from './rune-layout.js'
import { state } from '../world.js'

const STEPS = [0, 25, 50, 100, 200, 400]
const SAMPLE_FRAMES = 50
const WARMUP_FRAMES = 12

const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (a, q) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

const raf = () => new Promise((r) => requestAnimationFrame(r))

// Collect `n` frame intervals, discarding a warmup run. The warmup matters: the
// frame right after placing 200 panes includes their first layout, and folding a
// one-off allocation cost into a steady-state number is how a flat curve is made
// to look linear.
async function sampleFrames(n = SAMPLE_FRAMES) {
  for (let i = 0; i < WARMUP_FRAMES; i++) await raf()
  const dts = []
  let prev = await raf()
  for (let i = 0; i < n; i++) {
    const t = await raf()
    dts.push(t - prev)
    prev = t
  }
  return dts
}

export async function runBench({ steps = STEPS, district = state.district } = {}) {
  const { BEND, FORT } = await import('./samples.js')
  const docs = [
    ...BEND.map((d) => ({ doc: d, format: 'bend' })),
    ...floorsOf(FORT).map((f) => ({ doc: f, format: 'rune' })),
  ]

  clearPapers()
  const rows = []
  const t0 = performance.now()
  let placed = 0

  for (const target of steps) {
    // Panes go down BOTH sides at quarter-dash spacing, so 400 of them still sit
    // inside the distance the tiers keep drawn. Placed unslotted -- the bench is
    // measuring what N panes cost to draw, and the road's spacing rule caps a
    // real road at about 23 a side, which would cap the sweep long before the
    // question is answered.
    while (placed < target) {
      const d = docs[placed % docs.length]
      const r = placePaper(d.doc, {
        district,
        side: placed % 2 ? 1 : -1,
        dash: 8 + Math.floor(placed / 2) * 0.25,
        format: d.format,
        unslotted: true,
      })
      if (!r.ok) { rows.push({ n: target, error: r.why }); break }
      placed++
    }
    syncPaper()

    const dts = await sampleFrames()
    // Read AFTER the sample, so it describes the window that was measured.
    const fed = typeof window !== 'undefined' && window.__fed ? window.__fed() : null
    const rep = paperReport()
    rows.push({
      n: placed,
      med: +median(dts).toFixed(2),
      p95: +pct(dts, 0.95).toFixed(2),
      min: +Math.min(...dts).toFixed(2),
      tiers: rep.byTier,
      canvases: rep.paintCanvases,
      atlasPages: rep.atlas.pages,
      atlasUsed: rep.atlas.used,
      hz: fed?.hz ?? null,
      quietMs: fed?.quietMs ?? null,
      // hz 0 means the brake was not capping. Anything else and this row is not
      // evidence about panes.
      tainted: !!(fed && fed.hz !== 0),
    })
  }

  const good = rows.filter((r) => !r.tainted && r.med != null)
  const base = good.find((r) => r.n === 0) ?? good[0] ?? null
  const top = good.length ? good[good.length - 1] : null

  // THE MEDIAN IS THE WRONG ESTIMATOR HERE, and the first run of this bench proved
  // it: medians came back 67.5 / 51.5 / 50.7 / 118.3 / 118.6 / 102.4 -- N=25 FASTER
  // than N=0, and non-monotonic throughout. A cost curve cannot go down when you
  // add work, so what that sequence measures is the scene's noise floor (live
  // clients decoding, software rasterisation in the guest) and not panes.
  //
  // FRAME-TIME NOISE IS ONE-SIDED. Nothing makes a frame finish sooner than the
  // work in it allows; stalls only ever make frames longer. So the MINIMUM over a
  // sample is the robust estimator: it is the closest thing to "what this frame
  // costs when nothing else interferes", and contamination can only push the
  // other samples up and away from it.
  //
  // Its resolution is one vsync. A best case pinned at ~16.6 ms cannot resolve a
  // cost below that, so a flat minimum is not "panes are free" -- it is the bound
  // "N panes add less than the frame's remaining headroom", which is the honest
  // and still useful claim.
  const monotonic = good.every((r, i) => i === 0 || r.med >= good[i - 1].med)
  const verdict = {
    estimator: 'min',
    baselineMinMs: base?.min ?? null,
    topN: top?.n ?? null,
    topMinMs: top?.min ?? null,
    // The bound: total added best-case cost across the whole sweep.
    minDeltaMs: base && top ? +(top.min - base.min).toFixed(2) : null,
    usPerPaneBestCase: base && top && top.n ? +(((top.min - base.min) / top.n) * 1000).toFixed(2) : null,
    flat: base && top ? top.min - base.min < 2 : null,
    // Reported so nobody quotes the median as a per-pane cost the way the first
    // version of this file did.
    medianMonotonic: monotonic,
    medianNoiseDominated: !monotonic,
    baselineMedMs: base?.med ?? null,
    topMedMs: top?.med ?? null,
    taintedRows: rows.filter((r) => r.tainted).length,
    tookMs: Math.round(performance.now() - t0),
  }

  const out = { rows, verdict, at: new Date().toISOString() }
  state.paperBench = out
  draw(out)
  return out
}

// THE OVERLAY. The guest has no console, so the result has to be on the glass.
function draw(out) {
  if (typeof document === 'undefined') return
  let el = document.getElementById('paper-bench')
  if (!el) {
    el = document.createElement('div')
    el.id = 'paper-bench'
    el.style.cssText = [
      'position:fixed', 'left:16px', 'top:16px', 'z-index:60',
      'background:rgba(3,4,10,.94)', 'border:1px solid #2de2e6', 'border-radius:6px',
      'padding:12px 14px', 'color:#d7dbe8',
      'font:12px ui-monospace,"DejaVu Sans Mono",monospace', 'white-space:pre',
      // The bar must never eat a click meant for the road behind it.
      'pointer-events:none',
    ].join(';')
    document.body.appendChild(el)
  }
  const v = out.verdict
  const head = '   N |  med ms |  p95 ms |  min ms | hz | paint/card/hid | cvs | atlas'
  const body = out.rows.map((r) => {
    if (r.error) return `${String(r.n).padStart(4)} | ${r.error}`
    const t = r.tiers ?? {}
    const mix = `${t.paint ?? 0}/${t.card ?? 0}/${t.hidden ?? 0}`
    return `${String(r.n).padStart(4)} | ${String(r.med).padStart(7)} | ${String(r.p95).padStart(7)} |` +
      ` ${String(r.min).padStart(7)} | ${String(r.hz ?? '?').padStart(2)} | ${mix.padStart(14)} |` +
      ` ${String(r.canvases).padStart(3)} | ${r.atlasPages}p ${r.atlasUsed}` + (r.tainted ? '  TAINTED' : '')
  }).join('\n')
  el.textContent =
    `PAPER BENCH — does frame time stay flat in N?\n${head}\n${body}\n\n` +
    `BEST CASE (min, robust — frame noise is one-sided):  ` +
    `${v.baselineMinMs} ms at N=0  ->  ${v.topMinMs} ms at N=${v.topN}   ` +
    `delta ${v.minDeltaMs} ms  =  ${v.usPerPaneBestCase} us/pane\n` +
    `verdict: ${v.flat ? 'FLAT in N — 400 panes cost less than one frame of headroom' : 'NOT FLAT — best case grew'}\n` +
    `median: ${v.baselineMedMs} -> ${v.topMedMs} ms, ` +
    `${v.medianNoiseDominated ? 'NON-MONOTONIC = noise-dominated, do not quote as per-pane cost' : 'monotonic'}\n` +
    `tainted rows: ${v.taintedRows} (hz != 0 means the idle brake was capping)   took ${v.tookMs} ms`
}
