// PUBLISHING'S TESTS. Run: `node test/publish.mjs` from RRABBIT/.
//
// The claim the whole module rests on is one sentence -- "the address is the hash
// of the bundle, and the guard is inside the bundle" -- and §3 is where it is
// actually falsifiable: every tamper that matters is attempted and each one has to
// change the id or be refused by name.
//
// PUBLIC TRACKS ONLY (CONFIDENTIALITY.md class A, ruled 2026-08-15). Nothing here
// encrypts anything, and a test that expected it to would be testing the wrong
// rung.

import { seal, open, check, canonical, requirementsOf, PREFIX, PLANNABLE, REFUSE, BUNDLE_KIND } from '../m2/publish.js'
import { TABLE } from '../m2/ops.js'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

// A recorded drive in the shape tracks.js actually persists: `rec` entries are
// { t, k, ...data } with `t` relative to the track's first step.
const track = () => ({
  id: 3,
  name: 'the deploy',
  recCut: 0,
  rec: [
    { t: 0, k: 'drive', road: 'home' },
    { t: 120, k: 'park', road: 'home', z: 37.5 },
    { t: 400, k: 'read', district: 'home', side: 'left', dash: 1 },
    { t: 900, k: 'unread' },              // plan:false -- must not survive
    { t: 1200, k: 'drive', road: 'build' },
  ],
})

console.log('\n1. sealing')
{
  const r = await seal(track(), { engine: 'test' })
  ok('seals', r.ok, r.why)
  ok('id carries the provisional prefix', r.id?.startsWith(PREFIX))
  ok('id is prefix + 64 hex', /^track-[0-9a-f]{64}$/.test(r.id ?? ''), r.id)
  ok('kind is stamped', r.bundle.kind === BUNDLE_KIND)
  ok('unplannable steps are dropped', r.bundle.steps.every((s) => s.op !== 'unread'))
  ok('four steps survive', r.bundle.steps.length === 4, String(r.bundle.steps?.length))
  ok('recCut is carried, not dropped', r.bundle.provenance.truncated === 0)
  ok('span is measured, not wall-clock', r.bundle.provenance.spanMs === 1200)

  const empty = await seal({ rec: [{ t: 0, k: 'unread' }] })
  ok('a track with no replayable step is refused', empty.why === REFUSE.EMPTY)
  const nope = await seal(null)
  ok('a non-track is refused by name', nope.why === REFUSE.MALFORMED)
}

console.log('\n2. the address is deterministic')
{
  const a = await seal(track(), { engine: 'test' })
  const b = await seal(track(), { engine: 'test' })
  ok('same drive, same id', a.id === b.id)

  // Key order must not be part of identity, or two honest senders disagree.
  const reordered = { z: 1, a: 2, m: [{ y: 1, x: 2 }] }
  const same = { m: [{ x: 2, y: 1 }], a: 2, z: 1 }
  ok('canonical is key-order independent', canonical(reordered) === canonical(same))
  ok('canonical drops undefined like JSON.stringify does',
    canonical({ a: 1, b: undefined }) === '{"a":1}', canonical({ a: 1, b: undefined }))

  const other = await seal({ ...track(), name: 'renamed' }, { engine: 'test' })
  ok('renaming the track DOES change the id (name is inside the seal)', other.id !== a.id)
}

console.log('\n3. tamper -- the claim, made falsifiable')
{
  const sealed = await seal(track(), { engine: 'test' })

  // The attack the design exists to stop: a stranger widens what the track will
  // accept by emptying its guard, hoping it runs somewhere it should not.
  const weakened = structuredClone(sealed.bundle)
  weakened.requires.roads = []
  const w = await open(new TextEncoder().encode(canonical(weakened)), sealed.id)
  ok('emptying `requires` is caught', !w.ok, JSON.stringify(w))
  ok('...by id mismatch, when you know the address', w.why === REFUSE.ID_MISMATCH, w.why)

  // DEFENCE IN DEPTH, and the more interesting path. Fetching by address means you
  // always have an expected id -- but a bundle handed over some other way does not,
  // and then the id check cannot help. The derived-vs-stated comparison is what
  // holds in that case, and it must hold ON ITS OWN.
  const noExpect = await open(new TextEncoder().encode(canonical(weakened)))
  ok('...and STILL caught with no expected id at all', !noExpect.ok, JSON.stringify(noExpect))
  ok('...because requires must match the steps it claims to guard',
    noExpect.why === REFUSE.MALFORMED && noExpect.detail === 'requires does not match steps',
    `${noExpect.why} / ${noExpect.detail}`)

  // Adding a step nobody sealed.
  const injected = structuredClone(sealed.bundle)
  injected.steps.push({ t: 9999, op: 'drive', road: 'somewhere-else' })
  const i = await open(new TextEncoder().encode(canonical(injected)), sealed.id)
  ok('injecting a step is caught', !i.ok && i.why === REFUSE.ID_MISMATCH)

  // Rewriting a step in place, keeping the count the same.
  const swapped = structuredClone(sealed.bundle)
  swapped.steps[0].road = 'elsewhere'
  const s = await open(new TextEncoder().encode(canonical(swapped)), sealed.id)
  ok('rewriting a step is caught', !s.ok && s.why === REFUSE.ID_MISMATCH)

  // Whitespace and key order are NOT tampering -- the same meaning must open.
  const padded = JSON.stringify(sealed.bundle, null, 4)
  const p = await open(padded, sealed.id)
  ok('reformatting is not tampering', p.ok, p.why)
  ok('...and re-derives the same id', p.id === sealed.id)

  const wrongId = await open(sealed.bytes, 'track-' + '0'.repeat(64))
  ok('a mismatched expected id is refused', !wrongId.ok && wrongId.why === REFUSE.ID_MISMATCH)
  ok('opening without an expected id still derives one', (await open(sealed.bytes)).id === sealed.id)
}

console.log('\n4. roads before anything moves')
{
  const sealed = await seal(track(), { engine: 'test' })
  const { bundle } = await open(sealed.bytes, sealed.id)

  ok('requires names both roads driven', JSON.stringify(bundle.requires.roads) === '["build","home"]',
    JSON.stringify(bundle.requires.roads))
  ok('a pane`s district counts as a road it needs', bundle.requires.roads.includes('home'))

  const all = new Set(['home', 'build'])
  ok('runs where every road exists', check(bundle, { hasRoad: (r) => all.has(r) }).ok)

  const gone = new Set(['home'])
  const g = check(bundle, { hasRoad: (r) => gone.has(r) })
  ok('refuses when a road is gone', !g.ok && g.why === REFUSE.ROAD_GONE)
  ok('...and NAMES the road, rather than saying no', g.detail === 'build', g.detail)

  const u = check(bundle, { hasRoad: () => true, knownOps: ['drive'] })
  ok('refuses an op this build does not have', !u.ok && u.why === REFUSE.OP_UNKNOWN)
  ok('...and names it', typeof u.detail === 'string' && u.detail.length > 0, u.detail)
}

console.log('\n5. the duplicated op list cannot rot')
{
  // publish.js keeps PLANNABLE as data so it stays dependency-free. That is only
  // safe if it is checked against the real table, which is what this is for.
  const fromTable = Object.entries(TABLE).filter(([, t]) => t.plan).map(([k]) => k).sort()
  ok('PLANNABLE matches ops.js TABLE exactly',
    JSON.stringify([...PLANNABLE].sort()) === JSON.stringify(fromTable),
    `${JSON.stringify([...PLANNABLE].sort())} vs ${JSON.stringify(fromTable)}`)

  ok('requirementsOf is derived, not declared',
    JSON.stringify(requirementsOf([{ op: 'drive', road: 'a' }, { op: 'park', road: 'b', z: 1 }]))
      === JSON.stringify({ roads: ['a', 'b'], ops: ['drive', 'park'] }))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
