// The tube rack -- the machine, as seven gauges.
//
// RAVIO's rack showed seven LANE RATINGS. RRABBIT's shows CPU, RAM, swap, disk,
// net, temp and load. The rating shape is identical (`{value, n, why, bar}`),
// which is the whole reason this is a new source rather than new geometry.
//
// Two rules carried over from RAVIO, and both are load-bearing:
//
//   1. A tube over its redline MUST NAME WHAT IS DOING IT (invariant 1). The
//      bridge supplies `why` -- "largest: firefox at 1055 MB", "hottest:
//      k10temp" -- and the rack is required to surface it. A gauge that reports
//      0.97 and declines to say what is at 0.97 is an ornament.
//
//   2. A gauge with nothing to report shows NOTHING, not zero. `value: null`
//      means the bridge could not measure it (no sensor, no interval yet), and
//      drawing that as an empty tube would claim the machine is idle. Unknown
//      and zero are different states and the rack must not collapse them --
//      the same distinction RAVIO's milepost tape needed between "quiet" and
//      "not held".
//
// WHAT CHANGED, AND WHY THIS FILE NO LONGER IMPORTS THREE.
//
// The rack used to be seven THREE.CylinderGeometry tubes in a Group parented to
// the CAMERA. That is a floating instrument: it hangs in front of your eyes with
// nothing under it, it takes perspective and fog from a scene it is not part of,
// and its labels are CanvasTextures redrawn through a 256px plane. It was a rack
// in mid-air where RAVIO has a rack seated in a dashboard.
//
// So the geometry is gone and only the MODEL is left. `dash.js` draws the same
// seven readings with RAVIO's own `tube()` primitive, on the 2D cockpit canvas,
// in the rack's original design-space footprint. This module keeps exactly the
// part that was never about rendering: what the bridge said, and which tubes are
// over their line.
//
// The interface shell.js uses (`apply`, `overRedline`, `tubes`) is unchanged --
// `createRack()` simply no longer takes a camera, because there is nothing to
// parent.

export const ORDER = ['cpu', 'ram', 'swap', 'disk', 'net', 'temp', 'load']

export function createRack() {
  const tubes = {}
  for (const name of ORDER) tubes[name] = { data: null }

  return {
    tubes,
    order: ORDER,

    apply(payload) {
      for (const name of ORDER) {
        // `?? null`, not `|| null`: the whole point of this model is that a
        // reading the bridge did not send and a reading of zero are different
        // states, and the coercion that collapses them is the bug §14.1 names.
        tubes[name].data = payload?.tubes?.[name] ?? null
      }
    },

    // Invariant 1 in one function: everything currently over its redline, with
    // the reason the bridge gave. If this returns rows, the rack owes the
    // viewer an explanation and the DOM strip prints it.
    overRedline() {
      const out = []
      for (const name of ORDER) {
        const d = tubes[name].data
        if (!d || d.value === null || d.bar === null || d.bar === undefined) continue
        if (d.value > d.bar) out.push({ name, value: d.value, bar: d.bar, n: d.n, why: d.why })
      }
      return out
    },
  }
}

// The number printed above a tube. `temp` and `load` are not percentages and
// never were -- 0.62 of a redline is not "62 degrees" -- so both print the
// bridge's own `n` and everything else prints its fraction.
export function formatValue(name, d) {
  if (!d || d.value === null || d.value === undefined) return '?'
  if (name === 'temp' || name === 'load') return String(d.n ?? '?')
  return `${Math.round(d.value * 100)}%`
}
