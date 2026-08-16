// THE STORE'S TESTS, and §5 is the one that matters. Run: `node test/trackstore.mjs`.
//
// The store's whole claim is that it is NEVER TRUSTED -- every read re-derives the
// hash and refuses on mismatch. A test suite that only ever asks an honest store
// for things it really has proves nothing about that, so §3 makes the store lie in
// three different ways and §5 runs the actual demo end to end: machine A publishes,
// machine B fetches onto a world that has moved, and REFUSES BY NAME.
//
// That last one is the artifact PUBLISH_PATH.md §7 step 6 called the marketing
// asset. Having it as a test rather than a recording is strictly better -- a
// recording shows it happened once; this shows it still happens.

import { seal, check, canonical, REFUSE as B } from '../m2/publish.js'
import { createStore, memoryAdapter, httpAdapter, REFUSE as S } from '../m2/trackstore.js'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const drive = () => ({
  id: 3, name: 'the deploy', recCut: 0,
  rec: [
    { t: 0, k: 'drive', road: 'home' },
    { t: 120, k: 'park', road: 'home', z: 37.5 },
    { t: 400, k: 'read', district: 'home', side: 'left', dash: 1 },
    { t: 1200, k: 'drive', road: 'build' },
  ],
})

console.log('\n1. round trip')
{
  const store = createStore(memoryAdapter())
  const sealed = await seal(drive(), { engine: 'test' })
  const put = await store.put(sealed)
  ok('puts', put.ok, put.why)
  ok('filed under its own id', put.id === sealed.id)
  ok('has it', await store.has(sealed.id))

  const got = await store.get(sealed.id)
  ok('gets it back', got.ok, got.why)
  ok('same bundle', canonical(got.bundle) === canonical(sealed.bundle))
  ok('steps survived the trip', got.bundle.steps.length === 4)
}

console.log('\n2. things that are not there, and ids that are not ids')
{
  const store = createStore(memoryAdapter())
  const missing = await store.get('track-' + 'a'.repeat(64))
  ok('missing is MISSING, not corrupt', missing.why === S.MISSING, missing.why)

  for (const junk of ['', 'nope', 'track-xyz', 'track-' + 'A'.repeat(64), null, 'sem-' + 'a'.repeat(64)]) {
    const r = await store.get(junk)
    ok(`refuses a malformed id (${JSON.stringify(junk)?.slice(0, 20)})`, r.why === S.BAD_ID, r.why)
  }
  ok('has() says no to a malformed id', (await store.has('nope')) === false)

  const notSealed = await store.put({ ok: true, id: 'track-nope', bytes: new Uint8Array([1]) })
  ok('refuses to file something that is not a sealed bundle', notSealed.why === S.BAD_ID)
}

console.log('\n3. a store that LIES -- the claim, made falsifiable')
{
  const adapter = memoryAdapter()
  const store = createStore(adapter)
  const sealed = await seal(drive(), { engine: 'test' })
  await store.put(sealed)

  // (a) the host substitutes a DIFFERENT valid bundle under the same id.
  const other = await seal({ ...drive(), name: 'not the same drive' }, { engine: 'test' })
  adapter._poison(sealed.id, other.bytes)
  const swapped = await store.get(sealed.id)
  ok('a substituted bundle is caught', !swapped.ok, JSON.stringify(swapped).slice(0, 60))
  ok('...and named CORRUPT, a store fault', swapped.why === S.CORRUPT, swapped.why)
  ok('...carrying why the bundle failed', swapped.detail === B.ID_MISMATCH, swapped.detail)

  // (b) the host edits one byte of a step.
  const edited = structuredClone(sealed.bundle)
  edited.steps[0].road = 'somewhere-else'
  adapter._poison(sealed.id, new TextEncoder().encode(canonical(edited)))
  const tweaked = await store.get(sealed.id)
  ok('a single edited step is caught', !tweaked.ok && tweaked.why === S.CORRUPT)

  // (c) the host returns something that is not a bundle at all.
  adapter._poison(sealed.id, new TextEncoder().encode('{"kind":"nope"}'))
  const garbage = await store.get(sealed.id)
  ok('garbage is caught', !garbage.ok && garbage.why === S.CORRUPT, garbage.why)

  // ...and putting the real bytes back makes it good again, so the failures above
  // were about the CONTENT and not about the store having been poisoned once.
  adapter._poison(sealed.id, sealed.bytes)
  ok('restoring the real bytes restores the read', (await store.get(sealed.id)).ok)
}

console.log('\n4. the http adapter, against a stubbed transport')
{
  // No network. A fake `fetch` proves the adapter forms requests and handles
  // statuses; the verification it feeds is already covered by §3.
  const held = new Map()
  const fakeFetch = async (url, opts = {}) => {
    const key = url.split('/').pop()
    if (opts.method === 'PUT') { held.set(key, opts.body); return { ok: true, status: 200 } }
    if (opts.method === 'HEAD') return { ok: held.has(key), status: held.has(key) ? 200 : 404 }
    if (!held.has(key)) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => held.get(key).buffer ?? held.get(key) }
  }
  const store = createStore(httpAdapter({ base: 'https://tracks.example/', fetch: fakeFetch }))
  const sealed = await seal(drive(), { engine: 'test' })

  ok('puts over http', (await store.put(sealed)).ok)
  ok('has over http', await store.has(sealed.id))
  const got = await store.get(sealed.id)
  ok('gets over http, verified', got.ok, got.why)
  ok('missing over http is MISSING', (await store.get('track-' + 'b'.repeat(64))).why === S.MISSING)

  const denied = createStore(httpAdapter({
    base: 'https://tracks.example/',
    fetch: async () => ({ ok: false, status: 403 }),
  }))
  const d = await denied.get(sealed.id)
  ok('a 403 is REFUSED, not MISSING and not CORRUPT', d.why === S.REFUSED, d.why)
}

console.log('\n5. THE DEMO -- machine A publishes, machine B refuses by name')
{
  // Machine A: a world with two roads, and a drive across both.
  const machineA = new Set(['home', 'build'])
  const sealed = await seal(drive(), { engine: 'machine-a' })
  ok('A sealed a track naming both roads',
    JSON.stringify(sealed.bundle.requires.roads) === '["build","home"]')

  // The wire. Only bytes cross it -- machine B gets no object, no shared memory,
  // and no promise that the sender was honest.
  const shared = createStore(memoryAdapter())
  await shared.put(sealed)

  // Machine B: has never seen this track, and its world has MOVED -- `build` is
  // gone. This is the ordinary case, not the exotic one: worlds change.
  const machineB = new Set(['home'])
  const got = await shared.get(sealed.id)
  ok('B fetched and verified it', got.ok, got.why)

  const verdict = check(got.bundle, { hasRoad: (r) => machineB.has(r) })
  ok('B REFUSES to run it', !verdict.ok)
  ok('...by name, not by silence', verdict.why === B.ROAD_GONE, verdict.why)
  ok('...naming the road that is gone', verdict.detail === 'build', verdict.detail)

  // "Roads before anything moves" has to be checked, not asserted. `check` is
  // handed a `hasRoad` that RECORDS what it was asked, so the test can prove the
  // refusal happened during inspection and that the bundle came back untouched.
  const asked = []
  const before = canonical(got.bundle)
  check(got.bundle, { hasRoad: (r) => { asked.push(r); return machineB.has(r) } })
  ok('...having asked about the roads before moving', asked.length > 0, JSON.stringify(asked))
  ok('...and left the bundle unmodified', canonical(got.bundle) === before)

  // And the same track on a machine that DOES have both roads is accepted, so the
  // refusal above is a measurement and not a machine that always says no.
  const machineC = new Set(['home', 'build', 'watch'])
  ok('a third machine with both roads accepts it',
    check(got.bundle, { hasRoad: (r) => machineC.has(r) }).ok)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
