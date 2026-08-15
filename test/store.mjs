// PAPER STORE TESTS. Run: `node test/store.mjs` from RRABBIT/.
//
// IndexedDB does not exist under `node`, which is exactly why the store's logic --
// validation, chunking, the district index -- is in the store and not in the
// adapter. What runs here is everything the shell will run, against
// `memoryAdapter`; `idbAdapter` is the same interface with a browser behind it.

import { createStore, memoryAdapter, validRecord } from '../m2/paper/store.js'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
}

const rec = (id, district, over = {}) => ({
  id, district, side: 1, dash: 8, format: 'bend',
  doc: { blocks: [{ kind: 'paragraph', spans: [{ text: id }] }] },
  ...over,
})

// ---- 1. validation --------------------------------------------------------
{
  ok('a good record validates', validRecord(rec('a', 'home')))
  const bad = [
    [null, 'null'], [undefined, 'undefined'], [42, 'a number'], ['x', 'a string'],
    [{ ...rec('a', 'home'), id: '' }, 'empty id'],
    [{ ...rec('a', 'home'), id: 7 }, 'numeric id'],
    [{ ...rec('a', 'home'), district: '' }, 'empty district'],
    [{ ...rec('a', 'home'), side: 0 }, 'side 0'],
    [{ ...rec('a', 'home'), side: 2 }, 'side 2'],
    [{ ...rec('a', 'home'), dash: NaN }, 'NaN dash'],
    [{ ...rec('a', 'home'), dash: 'far' }, 'string dash'],
    [{ ...rec('a', 'home'), format: 'html' }, 'unknown format'],
    [{ ...rec('a', 'home'), doc: null }, 'null doc'],
    [{ ...rec('a', 'home'), doc: 'text' }, 'string doc'],
  ]
  for (const [r, why] of bad) ok(`rejects ${why}`, !validRecord(r))
  // Fractional dashes are legal -- the bench and the streamer both place at them.
  ok('accepts a fractional dash', validRecord(rec('a', 'home', { dash: 8.25 })))
  ok('accepts side -1', validRecord(rec('a', 'home', { side: -1 })))
  ok('accepts format rune', validRecord(rec('a', 'home', { format: 'rune' })))
}

// ---- 2. put reports written AND refused separately ------------------------
{
  const s = createStore(memoryAdapter())
  const r = await s.put([rec('a', 'home'), rec('b', 'home'), { id: 'junk' }, null])
  ok('written counted', r.written === 2, JSON.stringify(r))
  ok('refused counted', r.refused === 2, JSON.stringify(r))
  ok('only the good ones landed', (await s.count()) === 2)

  // A bulk write reporting one total would hide a corpus half of which was bad.
  ok('a single record works too', (await s.put(rec('c', 'home'))).written === 1)
  ok('count follows', (await s.count()) === 3)
}

// ---- 3. the chunk is the district, and only the district ------------------
{
  const s = createStore(memoryAdapter())
  await s.put([
    rec('a', 'home'), rec('b', 'home'), rec('c', 'build'),
    rec('d', 'build'), rec('e', 'watch'),
  ])
  const home = await s.chunk('home')
  ok('home chunk has 2', home.length === 2, `${home.length}`)
  ok('home chunk is only home', home.every((r) => r.district === 'home'))
  ok('build chunk has 2', (await s.chunk('build')).length === 2)
  ok('watch chunk has 1', (await s.chunk('watch')).length === 1)
  ok('an unknown district is empty, not an error', (await s.chunk('nowhere')).length === 0)
  ok('districts lists all three', (await s.districts()).sort().join(',') === 'build,home,watch')
}

// ---- 4. the district index survives a record MOVING districts -------------
{
  // The bug this catches: an overwrite that indexes the new district without
  // un-indexing the old one leaves the record in both chunks, so driving to
  // `home` materialises a pane that belongs on `build`.
  const s = createStore(memoryAdapter())
  await s.put(rec('a', 'home'))
  ok('starts in home', (await s.chunk('home')).length === 1)
  await s.put(rec('a', 'build'))
  ok('moved out of home', (await s.chunk('home')).length === 0, 'stale index entry')
  ok('moved into build', (await s.chunk('build')).length === 1)
  ok('still only one record', (await s.count()) === 1)
  ok('home is no longer listed', !(await s.districts()).includes('home'))
}

// ---- 5. remove, and clear -------------------------------------------------
{
  const s = createStore(memoryAdapter())
  await s.put([rec('a', 'home'), rec('b', 'home')])
  ok('remove reports true', (await s.remove('a')) === true)
  ok('remove is reflected in the chunk', (await s.chunk('home')).length === 1)
  ok('removing what is not there is false', (await s.remove('a')) === false)
  ok('get returns null for a missing id', (await s.get('a')) === null)
  ok('get returns the record', (await s.get('b'))?.id === 'b')
  await s.clear()
  ok('clear empties', (await s.count()) === 0)
  ok('clear empties the index too', (await s.districts()).length === 0)
}

// ---- 6. records are cleaned on the way in ---------------------------------
{
  const s = createStore(memoryAdapter())
  await s.put({ ...rec('a', 'home'), sneaky: 'a whole extra field', mesh: {} })
  const got = await s.get('a')
  ok('unknown fields are not stored', !('sneaky' in got) && !('mesh' in got), Object.keys(got).join(','))
  ok('the known fields survive', got.id === 'a' && got.district === 'home' && got.format === 'bend')
  ok('the document survives intact', got.doc.blocks[0].spans[0].text === 'a')
}

// ---- 7. storage is untrusted on the way OUT too ---------------------------
{
  // A record written by a build that is no longer running. Injected through the
  // adapter directly, which is the only way it could ever happen.
  const a = memoryAdapter()
  const s = createStore(a)
  await a.putMany([rec('good', 'home'), { id: 'bad', district: 'home', side: 9, dash: 1, format: 'bend', doc: {} }])
  ok('the adapter holds both', (await a.byDistrict('home')).length === 2)
  const chunk = await s.chunk('home')
  ok('the chunk drops the invalid one', chunk.length === 1, `${chunk.length}`)
  ok('and keeps the good one', chunk[0].id === 'good')
}

// ---- 8. it scales to the rung's number ------------------------------------
{
  const s = createStore(memoryAdapter())
  const N = 10000, D = 20
  const recs = Array.from({ length: N }, (_, i) => rec(`p${i}`, `d${i % D}`, { dash: 8 + (i % 500) * 0.25 }))
  const t0 = Date.now()
  const r = await s.put(recs)
  const putMs = Date.now() - t0

  ok('10k written', r.written === N, `${r.written}`)
  ok('10k counted', (await s.count()) === N)
  ok('10k put is not slow', putMs < 4000, `${putMs}ms`)

  const t1 = Date.now()
  const chunk = await s.chunk('d7')
  const chunkMs = Date.now() - t1
  ok('a chunk of 10k is 1/20th', chunk.length === N / D, `${chunk.length}`)
  ok('and only that district', chunk.every((x) => x.district === 'd7'))
  // The point of the index: pulling one district must not cost the whole store.
  ok('chunk lookup is fast', chunkMs < 200, `${chunkMs}ms`)
  ok('districts lists 20', (await s.districts()).length === D)
  console.log(`  (10k put ${putMs}ms, chunk of ${chunk.length} in ${chunkMs}ms)`)
}

// ---- 9. a store needs an adapter ------------------------------------------
{
  let threw = false
  try { createStore(null) } catch { threw = true }
  ok('createStore refuses a missing adapter', threw)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
