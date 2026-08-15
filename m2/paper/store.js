// WHERE THE DOCUMENTS LIVE WHEN THEY ARE NOT ON A ROAD.
//
// Rungs 1-4 kept every document in memory as a JS object, which is correct up to a
// few hundred and wrong at the number this whole idea exists for. The arithmetic
// from docs/PAPER_ROADS.md §3: a `.bend` file is 1,067 bytes on average, so a
// million of them is about a gigabyte. That is storable -- and it is two orders of
// magnitude past `localStorage` (5-10 MB), which is the mechanism `tracks.js`,
// `layout.js` and `workspaces.js` all use. So this is the first thing in the shell
// that could not use the shell's existing persistence, and IndexedDB is the reason
// the rung exists.
//
// TWO ADAPTERS, AND THE LOGIC IS IN NEITHER. IndexedDB does not exist under `node`,
// so a store written directly against it is a store that can only be tested through
// the FreeBSD deploy loop. The chunking, the record validation and the district
// query are pure and live here; `memoryAdapter` runs them under `node` and
// `idbAdapter` runs them in the shell. This is the same split `measure` injection
// made in bend-layout.js, and for the same reason.
//
// A DISTRICT IS THE CHUNK. Not an arbitrary spatial grid -- the workspace graph
// already partitions the world, you are always standing in exactly one district,
// and its exits are its neighbours. `byDistrict` is therefore the entire streaming
// query, and it is an index lookup rather than a scan.

const REC_KEYS = ['id', 'district', 'side', 'dash', 'format', 'doc']

// A record from storage is UNTRUSTED INPUT written by an older build -- the same
// stance `layout.js` and `tracks.js` take about their saved sets. A malformed one
// is dropped rather than restored, because a bad value here does not read as a bad
// value; it reads as a document that came back in the wrong place, or as a pane
// that never appeared, and neither traces back to here.
export function validRecord(r) {
  if (!r || typeof r !== 'object') return false
  if (typeof r.id !== 'string' || !r.id) return false
  if (typeof r.district !== 'string' || !r.district) return false
  if (r.side !== 1 && r.side !== -1) return false
  if (!Number.isFinite(r.dash)) return false
  if (r.format !== 'bend' && r.format !== 'rune') return false
  if (!r.doc || typeof r.doc !== 'object') return false
  return true
}

const clean = (r) => Object.fromEntries(REC_KEYS.map((k) => [k, r[k]]))

// ---- the in-memory adapter (tests, and any host without IndexedDB) ----------

export function memoryAdapter() {
  const rows = new Map()
  // A district -> Set(id) index, maintained on write. Without it `byDistrict` is a
  // scan of everything, which is exactly the cost the chunking exists to avoid --
  // and a scan would still LOOK correct in a test with twenty records.
  const byDist = new Map()

  const index = (r) => {
    let s = byDist.get(r.district)
    if (!s) byDist.set(r.district, (s = new Set()))
    s.add(r.id)
  }
  const unindex = (r) => {
    const s = byDist.get(r.district)
    if (!s) return
    s.delete(r.id)
    if (!s.size) byDist.delete(r.district)
  }

  return {
    kind: 'memory',
    async putMany(recs) {
      for (const r of recs) {
        const had = rows.get(r.id)
        if (had) unindex(had)
        rows.set(r.id, r)
        index(r)
      }
      return recs.length
    },
    async get(id) {
      return rows.get(id) ?? null
    },
    async byDistrict(district) {
      const s = byDist.get(district)
      return s ? [...s].map((id) => rows.get(id)).filter(Boolean) : []
    },
    async remove(id) {
      const had = rows.get(id)
      if (!had) return false
      unindex(had)
      rows.delete(id)
      return true
    },
    async count() {
      return rows.size
    },
    async districts() {
      return [...byDist.keys()]
    },
    async clear() {
      rows.clear()
      byDist.clear()
    },
  }
}

// ---- the IndexedDB adapter --------------------------------------------------

const DB_NAME = 'rrabbit.paper'
const DB_VERSION = 1
const STORE = 'papers'

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result)
  req.onerror = () => rej(req.error)
})

export async function idbAdapter(name = DB_NAME) {
  if (typeof indexedDB === 'undefined') throw new Error('PAPER_NO_IDB')
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open(name, DB_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) {
        const os = d.createObjectStore(STORE, { keyPath: 'id' })
        // The index IS the chunking. Without it, entering a district is a scan of
        // every document in the store.
        os.createIndex('district', 'district', { unique: false })
      }
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })

  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE)

  return {
    kind: 'idb',
    async putMany(recs) {
      // ONE transaction for the whole batch. Ten thousand single-record
      // transactions is ten thousand commits, and that is the difference between
      // seeding a corpus in a second and in a minute.
      await new Promise((res, rej) => {
        const t = db.transaction(STORE, 'readwrite')
        const os = t.objectStore(STORE)
        for (const r of recs) os.put(r)
        t.oncomplete = () => res()
        t.onerror = () => rej(t.error)
        t.onabort = () => rej(t.error)
      })
      return recs.length
    },
    get: (id) => wrap(tx('readonly').get(id)).then((v) => v ?? null),
    byDistrict: (district) => wrap(tx('readonly').index('district').getAll(district)),
    remove: (id) => wrap(tx('readwrite').delete(id)).then(() => true),
    count: () => wrap(tx('readonly').count()),
    async districts() {
      // Distinct index keys, walked with a nextunique cursor rather than by
      // reading every record and de-duplicating in JS.
      const out = []
      await new Promise((res, rej) => {
        const req = tx('readonly').index('district').openKeyCursor(null, 'nextunique')
        req.onsuccess = () => {
          const c = req.result
          if (!c) return res()
          out.push(c.key)
          c.continue()
        }
        req.onerror = () => rej(req.error)
      })
      return out
    },
    clear: () => wrap(tx('readwrite').clear()).then(() => undefined),
  }
}

// ---- the store ---------------------------------------------------------------

export function createStore(adapter) {
  if (!adapter) throw new TypeError('createStore needs an adapter')
  return {
    kind: adapter.kind,

    // Returns what was WRITTEN and what was REFUSED, separately. A bulk write that
    // reported only a total would hide a corpus half of which was malformed.
    async put(recs) {
      const list = (Array.isArray(recs) ? recs : [recs])
      const good = [], bad = []
      for (const r of list) (validRecord(r) ? good : bad).push(r)
      if (good.length) await adapter.putMany(good.map(clean))
      return { written: good.length, refused: bad.length }
    },

    get: (id) => adapter.get(id),
    remove: (id) => adapter.remove(id),
    count: () => adapter.count(),
    districts: () => adapter.districts(),
    clear: () => adapter.clear(),

    // THE STREAMING QUERY. Everything a district needs, and nothing from any other
    // district. Records that fail validation on the way OUT are dropped too --
    // storage can be written by a build that is no longer running.
    async chunk(district) {
      const rows = await adapter.byDistrict(district)
      return rows.filter(validRecord)
    },
  }
}

// Open the best store this host can provide. Falls back rather than throwing,
// because a shell that cannot persist is still a working shell -- the trade
// `layout.js` and `workspaces.js` already make, and here it means a session in a
// private window shows panes that simply do not survive a reload.
export async function openStore() {
  try {
    return { store: createStore(await idbAdapter()), fallback: null }
  } catch (e) {
    return { store: createStore(memoryAdapter()), fallback: String(e?.message ?? e) }
  }
}
