#!/usr/bin/env node
// Put the T&R guests' applications into compositor-proxy's menu.
//
// WHERE THE GPU IS, AND WHERE THE APPLICATION IS, ARE TWO DIFFERENT MACHINES.
//
// The obvious way to run T&R's programs on the road is to run compositor-proxy
// inside the guest. It cannot be done, and the reason is not a missing package:
// `tr4` has no `/dev/dri` at all. PARKVPS starts QEMU with `-nodefaults -display
// none` and no GPU device, and the two ways to give a guest one are both closed
// here -- virtio-gpu/virgl needs a DRM driver FreeBSD 15 does not ship, and VFIO
// passthrough needs root and an IOMMU, which breaks the no-root premise PARKVPS
// is built on. A guest compositor-proxy would encode h264 on the guest's CPU,
// which is the opposite of what was asked for.
//
// So the split is the other way round: THE APPLICATION RUNS IN THE GUEST, THE
// ENCODE RUNS ON THE HOST'S GPU. waypipe carries the Wayland connection between
// them -- it exists precisely because a Wayland socket cannot be forwarded by
// ssh alone (the protocol passes file descriptors, and SCM_RIGHTS does not
// survive a plain socket forward). The guest app talks to waypipe; waypipe talks
// to compositor-proxy on the host; compositor-proxy encodes on renderD128 and
// hands frames to the browser, which puts them on a sign on the road.
//
// This is BETTER than a guest GPU would have been, not a compromise: the encoder
// ends up on the same machine as the browser consuming it, so the pixels cross
// the VM boundary once as Wayland buffers instead of twice as video.
//
// WHY THIS IS A GENERATOR AND NOT A HAND-EDITED BLOCK. The ssh port is allocated
// by PARKVPS per instance and is only stable until an instance is recreated, so
// a port pasted into applications.json is a menu entry that silently opens
// nothing the first time a guest is rebuilt. Read it from the record instead.
//
//   node tools/tandr-apps.mjs            # rewrite the guest entries
//   node tools/tandr-apps.mjs --print    # show them without writing
//
// Entries are namespaced `/tandr-<instance>-<app>` and every generated key is
// replaced wholesale on each run, so an instance that has gone away takes its
// entries with it rather than leaving a menu row that cannot launch.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APPS = join(ROOT, 'proxy/applications.json')
// PARKVPS is a sibling checkout, not a dependency. Overridable because the two
// repos do not import each other and should not start now.
const PARKVPS = process.env.PARKVPS_ROOT ?? resolve(ROOT, '../PARKVPS')
const RUN = join(PARKVPS, 'var/run')
const KEY = join(PARKVPS, 'var/parkvps_ed25519')

// What each guest offers. Wayland-native only, on purpose: an X11 program would
// need XWayland running INSIDE the guest, which is a second display server to
// keep alive for no benefit -- `foot` speaks Wayland directly, so the buffer it
// hands waypipe is the buffer the host encodes.
const GUEST_APPS = [
  { id: 'foot', name: 'foot', exe: 'foot', note: 'Wayland terminal' },
]

// The guest's waypipe, wrapped so it has an XDG_RUNTIME_DIR. See
// tools/guest/waypipe-tandr for why this is needed at all -- in short, waypipe's
// server runs from a non-interactive ssh command and FreeBSD has no logind to
// create or export a runtime directory, so plain `waypipe` dies on
// `Environment variable XDG_RUNTIME_DIR not present` before it opens anything.
//
// Probed for below like any other binary: a guest without it is skipped and says
// so, rather than producing a menu row that fails the same way every time.
const REMOTE_BIN = '/usr/local/bin/waypipe-tandr'

// The ssh options PARKVPS itself uses (see vpsd/vps.py cmd_ssh). Copied rather
// than shelled out to, because compositor-proxy spawns this argv directly and
// there is no shell in between to expand anything.
//
// StrictHostKeyChecking=no and a null known_hosts are PARKVPS's own choice and
// its own stated reason: these guests are recreated constantly on a fixed set of
// ports, so a pinned host key is guaranteed to go stale and block the login.
//
// NOTE THE MISSING `ssh`. This is the OPTIONS ONLY, and it has two consumers
// that need it shaped differently: the probe below runs `ssh <opts> <script>`
// through execFile, and the menu entry runs `waypipe ssh <opts> <cmd>` where
// `ssh` is waypipe's own subcommand. The first cut of this had the word baked in
// and the probe ran `ssh ssh -p 2223 ...` -- which is ssh trying to reach a host
// called `ssh`, and it failed silently into "this guest has no waypipe" for a
// guest that plainly did.
const sshOpts = (port, user) => [
  '-p', String(port),
  '-i', KEY,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR',
  // Keeps a launched window from hanging around as a dead ssh if the guest goes
  // away underneath it.
  '-o', 'ServerAliveInterval=15',
  `${user}@127.0.0.1`,
]

function instances() {
  if (!existsSync(RUN)) return []
  const out = []
  for (const name of readdirSync(RUN)) {
    const p = join(RUN, name, 'instance.json')
    if (!existsSync(p)) continue
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8'))
      if (rec.name && rec.ssh_port && rec.user) out.push(rec)
    } catch {
      // A half-written record is a guest mid-create, not an error worth stopping
      // for -- the next run picks it up.
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

// WHAT THIS GUEST CAN ACTUALLY RUN, asked of the guest.
//
// Not every instance has the packages. `tr4` is the T&R desktop image and has
// waypipe and foot; `builder` is a stock FreeBSD cloud image and has neither --
// and the first version of this file cheerfully wrote menu entries for both. A
// row that opens nothing is the exact failure the ST&RT menu is built to refuse,
// and generating one here would smuggle it past that refusal: the menu can tell
// you the PROXY is down, it cannot know a guest is missing a binary.
//
// So the guest is asked. A guest that is off, unreachable, or mid-boot answers
// nothing and contributes nothing, which is the truthful answer for all three --
// and re-running the tool once it is up is the whole fix.
function guestHas(rec, names) {
  try {
    const out = execFileSync(
      'ssh',
      [...sshOpts(rec.ssh_port, rec.user), `for c in ${names.join(' ')}; do command -v $c >/dev/null && echo $c; done`],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

// Memoised: every call opens an ssh connection per guest, and the write path and
// the summary line below both want the answer. Two identical rounds of probing
// is not just slow, it prints every warning twice.
let cached = null
function generated() {
  if (cached) return cached
  const apps = {}
  for (const rec of instances()) {
    const have = guestHas(rec, ['waypipe', REMOTE_BIN, ...GUEST_APPS.map((a) => a.exe)])
    // waypipe is the server half over there. Without it nothing on this guest is
    // reachable at all, whatever else is installed.
    if (!have.has('waypipe')) {
      console.warn(`tandr-apps: ${rec.name} -- no waypipe in the guest, skipped`)
      continue
    }
    if (!have.has(REMOTE_BIN)) {
      console.warn(`tandr-apps: ${rec.name} -- no ${REMOTE_BIN}, skipped`)
      console.warn(`tandr-apps:   install it with: scp tools/guest/waypipe-tandr ... && sudo install -m 755`)
      continue
    }
    for (const app of GUEST_APPS) {
      if (!have.has(app.exe)) {
        console.warn(`tandr-apps: ${rec.name} -- no ${app.exe}, skipped`)
        continue
      }
      apps[`/tandr-${rec.name}-${app.id}`] = {
        name: `${app.name} · ${rec.name}`,
        // waypipe is the CLIENT half and runs here, on the machine with the GPU.
        // `waypipe ssh <ssh args> <dest> <cmd>` starts its own server half in the
        // guest over that same connection, so there is nothing to leave running
        // on the other side between launches.
        executable: 'waypipe',
        // `--remote-bin` before the `ssh` subcommand -- it is waypipe's own
        // option, not ssh's, and waypipe stops parsing its options at `ssh`.
        args: ['--remote-bin', REMOTE_BIN, 'ssh', ...sshOpts(rec.ssh_port, rec.user), app.exe],
        env: {},
        // NOTHING ELSE MAY GO IN HERE. compositor-proxy validates this file
        // against a schema with `additionalProperties: false` and REFUSES TO
        // START if it finds a field it does not know -- not a warning, a throw
        // before the socket is opened. A `_tandr` provenance object was added
        // here for the benefit of anyone reading the file and took the whole
        // proxy down with it. The instance is named in `name` instead, which is
        // the one field that is both allowed and already on screen.
      }
    }
  }
  cached = apps
  return apps
}

const current = existsSync(APPS) ? JSON.parse(readFileSync(APPS, 'utf8')) : {}
// Every previously generated key goes, then the current set is written. That is
// what makes a deleted instance disappear from the menu instead of leaving a row
// that opens nothing.
const kept = Object.fromEntries(
  Object.entries(current).filter(([k]) => !k.startsWith('/tandr-')),
)
const next = { ...kept, ...generated() }

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(generated(), null, 2))
} else {
  writeFileSync(APPS, JSON.stringify(next, null, 2) + '\n')
  const n = Object.keys(generated()).length
  const names = instances().map((r) => `${r.name}:${r.ssh_port}`).join(', ') || 'none'
  console.log(`tandr-apps: wrote ${n} guest entr${n === 1 ? 'y' : 'ies'} to proxy/applications.json`)
  console.log(`tandr-apps: instances -- ${names}`)
}
