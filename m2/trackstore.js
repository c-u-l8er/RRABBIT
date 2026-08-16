// WHERE A PUBLISHED TRACK LIVES SO SOMEBODY ELSE CAN GET IT.
//
// `publish.js` makes a bundle whose id is the hash of its own bytes. This is the
// other half: putting those bytes somewhere, and fetching them back on a machine
// that has never seen them.
//
// THE STORE IS NEVER TRUSTED. Not the network, not the host, not our own bucket.
// Every read re-derives the hash from the bytes that actually arrived and refuses
// if it does not match the id that was asked for. That is not defensive
// programming, it is the whole point of content addressing -- a store you have to
// trust is a filename lookup wearing a hash. `TRVM/forge/wrl_store.py` already
// takes exactly this stance (`_get_bytes` re-hashes every read, `WRL_STORE_CORRUPT`
// on mismatch) and studbook §5 lists it as shipped substrate. Same discipline, one
// layer up.
//
// A consequence worth stating because it is the useful one: **it does not matter
// who hosts this.** R2, a static file server, a USB stick, somebody's homepage. A
// corrupted or substituted bundle is caught by the reader, so the store needs no
// integrity guarantees of its own and the hosting decision is free.
//
// TWO ADAPTERS, LOGIC IN NEITHER -- the split `m2/paper/store.js` already makes,
// and for the same reason it made it: `fetch` against a real host cannot run in
// the test runner, so the verification lives here and the transport is injected.
// `memoryAdapter` runs under node, `httpAdapter` runs anywhere with `fetch`.
//
// PUBLIC TRACKS ONLY. CONFIDENTIALITY.md class A -- no credential, no encryption,
// nothing to authorise. A public read needs no Worker in front of it, which is why
// this rung ships before the credential-minting one.

import { open as openBundle, PREFIX } from './publish.js'

export const REFUSE = {
  MISSING: 'TRACK_STORE_MISSING',
  CORRUPT: 'TRACK_STORE_CORRUPT',
  REFUSED: 'TRACK_STORE_REFUSED',
  BAD_ID: 'TRACK_STORE_BAD_ID',
}

const bad = (why, detail = null) => ({ ok: false, why, detail })

// An id is `track-` + 64 hex and nothing else. Checked before it reaches an
// adapter, because an id is about to become a URL path or a filesystem key and
// "validate before you interpolate" is cheaper than trusting every caller.
const wellFormed = (id) => typeof id === 'string' && new RegExp(`^${PREFIX}[0-9a-f]{64}$`).test(id)

// ---- adapters: bytes in, bytes out, no opinions --------------------------------

export function memoryAdapter(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    async put(key, bytes) { map.set(key, bytes); return { ok: true } },
    async get(key) {
      if (!map.has(key)) return { ok: false, status: 404 }
      return { ok: true, bytes: map.get(key) }
    },
    async has(key) { return map.has(key) },
    list: () => [...map.keys()],
    // Test-only, and named so it reads as one: lets a test make the store LIE,
    // which is the only way to prove the reader catches it.
    _poison(key, bytes) { map.set(key, bytes) },
  }
}

// Any HTTP host. R2 with public read, a static server, GitHub raw -- the reader
// does not care, per the note at the top.
export function httpAdapter({ base, fetch: f = globalThis.fetch, headers = {} } = {}) {
  if (!base) throw new Error('httpAdapter needs a base url')
  const url = (key) => `${base.replace(/\/$/, '')}/${key}`
  return {
    async put(key, bytes) {
      const res = await f(url(key), { method: 'PUT', body: bytes, headers })
      return res.ok ? { ok: true } : { ok: false, status: res.status }
    },
    async get(key) {
      const res = await f(url(key), { headers })
      if (!res.ok) return { ok: false, status: res.status }
      return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) }
    },
    async has(key) {
      const res = await f(url(key), { method: 'HEAD', headers })
      return res.ok
    },
    url,
  }
}

// ---- the store: verification, and nothing else ---------------------------------

export function createStore(adapter) {
  return {
    // Takes what `seal()` returned, so the id and the bytes cannot drift apart on
    // the way in -- a `put(id, bytes)` signature would let a caller file bytes
    // under the wrong name, and then the store's own key would be a lie.
    async put(sealed) {
      if (!sealed?.ok || !wellFormed(sealed.id) || !(sealed.bytes instanceof Uint8Array)) {
        return bad(REFUSE.BAD_ID, 'not a sealed bundle')
      }
      const r = await adapter.put(sealed.id, sealed.bytes)
      if (!r.ok) return bad(REFUSE.REFUSED, String(r.status ?? 'put failed'))
      return { ok: true, id: sealed.id }
    },

    // THE INTERESTING HALF. Fetch, then re-derive, then refuse if they disagree.
    //
    // `openBundle(bytes, id)` is what does the re-derivation -- it re-canonicalises
    // what it parsed and hashes THAT, so reformatting survives and any change to
    // meaning does not. A store that returns different bytes than were filed is
    // caught here and named CORRUPT rather than being handed to a replay.
    async get(id) {
      if (!wellFormed(id)) return bad(REFUSE.BAD_ID, String(id))

      const r = await adapter.get(id)
      if (!r.ok) {
        return r.status === 404 ? bad(REFUSE.MISSING, id) : bad(REFUSE.REFUSED, String(r.status))
      }

      const opened = await openBundle(r.bytes, id)
      if (!opened.ok) {
        // A bundle that does not match the id we asked for is a STORE fault, not a
        // malformed-bundle fault, and the distinction matters: one means the host
        // gave you the wrong thing, the other means the sender sealed it wrong.
        // Attribution kept in separate channels -- the same rule WRLM's D' laws
        // state for host faults versus model failures.
        return bad(REFUSE.CORRUPT, opened.why)
      }
      return { ok: true, id, bundle: opened.bundle }
    },

    async has(id) {
      return wellFormed(id) ? adapter.has(id) : false
    },
  }
}
