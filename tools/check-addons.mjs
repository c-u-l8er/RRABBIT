// Is the compositor-proxy native addon that is installed the one we built?
//
// The failure this guards against is silent by construction (docs/spec §18.1):
// an addon linked against a different gstreamer resolves every symbol, starts,
// negotiates caps, and then emits no frames and logs nothing. There is no
// runtime error to catch, so the check has to be an identity check made before
// anything runs.
//
//   node tools/check-addons.mjs           verify, exit 1 on mismatch
//   node tools/check-addons.mjs --warn    verify, never exit nonzero
//   node tools/check-addons.mjs --write   record the current files as correct
//
// Set RRABBIT_SKIP_ADDON_CHECK=1 to bypass entirely.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADDONS = join(ROOT, 'node_modules/@gfld/compositor-proxy/dist/addons')
const BACKUP = join(ROOT, 'node_modules/@gfld/compositor-proxy/dist/addons.prebuilt-backup')
const LOCK = join(ROOT, 'tools/addons.lock.json')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }

const FIX = 'run ./tools/build-addons.sh'

if (process.env.RRABBIT_SKIP_ADDON_CHECK === '1') process.exit(0)

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// Every file the build installs: the three node addons and the shared libs they
// dlopen through $ORIGIN/shared.
function installedFiles(dir) {
  if (!existsSync(dir)) return null
  const files = {}
  for (const f of readdirSync(dir)) if (f.endsWith('.node')) files[f] = sha(join(dir, f))
  const shared = join(dir, 'shared')
  if (existsSync(shared)) for (const f of readdirSync(shared)) files[`shared/${f}`] = sha(join(shared, f))
  return files
}

// A binary's .comment section names the compiler that produced it. Upstream's
// docker build leaves "GCC: (Ubuntu ...)"; a local build leaves this machine's.
// Only used to explain a mismatch in words -- never to decide one.
function compiler(path) {
  try {
    return execFileSync('readelf', ['-p', '.comment', path], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop()
      ?.replace(/^\[\s*\d+\]\s*/, '') ?? null
  } catch { return null }
}

function gstVersion() {
  try {
    return execFileSync('pkg-config', ['--modversion', 'gstreamer-1.0'], { encoding: 'utf8' }).trim()
  } catch { return null }
}

const current = installedFiles(ADDONS)
if (current === null) {
  console.error(`check-addons: ${ADDONS} does not exist -- npm install has not run`)
  process.exit(flag('--warn') ? 0 : 1)
}

if (flag('--write')) {
  const lock = {
    comment: 'Written by tools/build-addons.sh. Identifies the locally built addons; see docs/spec/README.md §18.1.',
    ref: value('--ref') ?? null,
    commit: value('--commit') ?? null,
    gstreamer: value('--gst') ?? gstVersion(),
    compiler: compiler(join(ADDONS, 'shared/libproxy-encoding.so')),
    files: current,
  }
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n')
  console.log(`check-addons: recorded ${Object.keys(current).length} files for gstreamer ${lock.gstreamer}`)
  process.exit(0)
}

if (!existsSync(LOCK)) {
  console.error('check-addons: no tools/addons.lock.json -- the addons have never been built here.')
  console.error(`  The npm prebuilts are linked against gstreamer 1.20 and emit no frames: ${FIX}`)
  process.exit(flag('--warn') ? 0 : 1)
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
const problems = []

const changed = Object.keys(lock.files).filter((f) => current[f] !== lock.files[f])
if (changed.length) {
  const backup = installedFiles(BACKUP) ?? {}
  const isPrebuilt = changed.some((f) => current[f] && current[f] === backup[f])
  problems.push(
    `${changed.length} addon file(s) are not the ones built here: ${changed.join(', ')}`,
    isPrebuilt
      ? '  These are the upstream npm prebuilts -- an npm install restored them.'
      : `  Installed compiler: ${compiler(join(ADDONS, 'shared/libproxy-encoding.so')) ?? 'unknown'}` +
        ` / recorded: ${lock.compiler ?? 'unknown'}`,
  )
}

const gst = gstVersion()
if (gst && lock.gstreamer && gst !== lock.gstreamer) {
  problems.push(
    `system gstreamer moved ${lock.gstreamer} -> ${gst} since the addons were built.`,
    '  The addon will still load and still resolve every symbol. That is not evidence it works.',
  )
}

if (problems.length) {
  console.error('check-addons: the installed addons do not match this machine.')
  for (const p of problems) console.error(`  ${p}`)
  console.error(`  Fix: ${FIX}`)
  process.exit(flag('--warn') ? 0 : 1)
}

console.log(`check-addons: ok -- built from ${lock.ref ?? '?'} against gstreamer ${lock.gstreamer}`)
