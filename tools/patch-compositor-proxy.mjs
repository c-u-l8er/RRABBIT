// Apply RRABBIT's fixes to an INSTALLED @gfld/compositor-proxy.
//
// The sibling of tools/patch-compositor.mjs, which patches the BROWSER-side
// @gfld/compositor in this repo's own node_modules. This one patches the
// PROXY-side package, which lives wherever the proxy was installed -- on the
// T&R image that is /usr/local/share/rrabbit/gfproxy, not here. So it takes the
// install root as an argument instead of assuming the cwd:
//
//   node tools/patch-compositor-proxy.mjs /usr/local/share/rrabbit/gfproxy
//
// Same rule as its sibling: EXACT-STRING matches, and a match that is not found
// is a HARD STOP. If upstream changes one of these functions we want a loud
// failure, not a patch applied to the wrong place.
//
// The source-level diffs these mirror are in patches/. Keep the two in step.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'

const PATCHES = [
  {
    // See patches/greenfield-freebsd-proc-pid.diff and spec section 29.8.
    //
    // A connecting client is matched to the app that launched it by walking up
    // its parent pids, read out of Linux's /proc/<pid>/status. FreeBSD has no
    // procfs mounted by default, so this threw ENOENT -- and it throws inside
    // the wl_display fd callback, which is a NATIVE callback. The exception had
    // nowhere to go: it stayed pending on the napi env and every later callback
    // failed with napi_pending_exception, so the compositor went deaf on the
    // first client to connect and logged nothing at all.
    //
    // ps(1) reports both fields and is POSIX. One fork per client connection.
    name: 'FreeBSD: parent pid and process name without /proc',
    file: 'node_modules/@gfld/compositor-proxy/dist/NativeWaylandCompositorSession.js',
    why: 'Without this the compositor goes permanently deaf on the first client to connect on any host with no Linux procfs.',
    before: `    findMatchingNativeAppContext(pid) {
        const nativeAppContext = this.session.findNativeAppContextByPid(pid);
        if (nativeAppContext) {
            return nativeAppContext;
        }
        for (const line of (0, node_fs_1.readFileSync)(\`/proc/\${pid}/status\`, 'ascii').split('\\n')) {
            if (line.startsWith('PPid')) {
                const ppid = Number.parseInt(line.split(':')[1].trim());
                if (ppid === 0) {
                    // no matches available
                    return undefined;
                }
                else {
                    return this.findMatchingNativeAppContext(ppid);
                }
            }
        }
    }
    getNameFromPid(pid) {
        for (const line of (0, node_fs_1.readFileSync)(\`/proc/\${pid}/status\`, 'ascii').split('\\n')) {
            if (line.startsWith('Name')) {
                return line.split(':')[1].trim();
            }
        }
    }`,
    after: `    findMatchingNativeAppContext(pid) {
        const nativeAppContext = this.session.findNativeAppContextByPid(pid);
        if (nativeAppContext) {
            return nativeAppContext;
        }
        // RRABBIT patch -- see patches/greenfield-freebsd-proc-pid.diff.
        const procInfo = readProcInfoRRABBIT(pid);
        if (procInfo === undefined || procInfo.ppid === 0 || procInfo.ppid === pid) {
            // no matches available
            return undefined;
        }
        return this.findMatchingNativeAppContext(procInfo.ppid);
    }
    getNameFromPid(pid) {
        // RRABBIT patch -- see patches/greenfield-freebsd-proc-pid.diff.
        return readProcInfoRRABBIT(pid)?.name;
    }`,
  },
  {
    name: 'FreeBSD: readProcInfo helper',
    file: 'node_modules/@gfld/compositor-proxy/dist/NativeWaylandCompositorSession.js',
    why: 'The helper the patch above calls.',
    before: `const node_fs_1 = require("node:fs");`,
    after: `const node_fs_1 = require("node:fs");
// RRABBIT patch -- see patches/greenfield-freebsd-proc-pid.diff.
const node_child_process_RRABBIT = require("node:child_process");
function readProcInfoRRABBIT(pid) {
    try {
        let ppid;
        let name;
        for (const line of (0, node_fs_1.readFileSync)(\`/proc/\${pid}/status\`, 'ascii').split('\\n')) {
            if (line.startsWith('PPid')) {
                ppid = Number.parseInt(line.split(':')[1].trim());
            }
            else if (line.startsWith('Name')) {
                name = line.split(':')[1].trim();
            }
        }
        if (ppid !== undefined) {
            return { ppid, name: name ?? 'unknown_app' };
        }
    }
    catch {
        // No Linux-shaped procfs. Fall through rather than throw: this runs in a
        // native callback where a throw is unrecoverable.
    }
    try {
        const out = node_child_process_RRABBIT.execFileSync('ps', ['-o', 'ppid=,comm=', '-p', \`\${pid}\`], { encoding: 'ascii', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const match = out.match(/^(\\d+)\\s+(.*)$/);
        if (match) {
            return { ppid: Number.parseInt(match[1]), name: match[2].trim() || 'unknown_app' };
        }
    }
    catch {
        // The process is already gone. Possible on Linux too, so this is not
        // only a port fix.
    }
    return undefined;
}`,
  },
  {
    // See patches/greenfield-frame-feedback-park.diff and runbook section 10.
    //
    // A native client's next paint is granted by the proxy's own clock, and
    // `commitNotify` first asks whether the browser is still alive by comparing
    // the last encoder-feedback message against a 1500 ms window. A surface that
    // fails that test has its frame callbacks put on `parkedFeedbackClockQueue`,
    // WHICH HAS NO TIMER -- the tick only ever walks `feedbackClockQueue`, so a
    // park lasts until the next feedback message arrives and not one moment
    // less.
    //
    // `clientFeedbackTimestamp` starts at 0, so EVERY SURFACE FAILS THE TEST ON
    // ITS FIRST COMMIT. Measured on this machine with one healthy window and a
    // proxy on loopback: `parked=1 ran=33 worstStaleMs=2031`. The browser was
    // never late; the clock had simply never been set. A menu is a new surface
    // every time it opens, which is why one paints and then sits still.
    name: 'Frame feedback: a surface is not stale before it has ever been heard from',
    file: 'node_modules/@gfld/compositor-proxy/dist/FrameFeedback.js',
    why: 'Without this every new surface has its first frame callbacks parked with nothing scheduled to release them, so a window paints once and waits up to a second for the browser\'s next once-per-second feedback message.',
    before: `    clientFeedbackTimestamp = 0;
    parkedFeedbackClockQueue = [];`,
    after: `    // RRABBIT patch -- see patches/greenfield-frame-feedback-park.diff.
    // Was 0, which reads as "last heard from at the epoch" and parks the first
    // commit of every surface before the browser has had any chance to report.
    clientFeedbackTimestamp = node_perf_hooks_1.performance.now();
    parkedFeedbackClockQueue = [];`,
  },
  {
    // The second half, and the one that bites on a slow machine rather than on
    // every surface. The browser sends feedback from `setInterval(..., 1000)`,
    // so a 1500 ms window is one and a half sending periods of margin. Any main
    // thread that slips half a second -- which a guest doing software H.264
    // decode of a full-screen window does routinely -- trips the test while the
    // browser is working perfectly, and pays a full parked second for it.
    //
    // 5000 still notices a browser that has genuinely gone away, within five
    // seconds, which is what the check is for. It does not remove the parking.
    name: 'Frame feedback: five missed messages is gone, one and a half is jitter',
    file: 'node_modules/@gfld/compositor-proxy/dist/FrameFeedback.js',
    why: 'A 1500 ms window against a 1000 ms sender parks a healthy client on ordinary main-thread jitter, and a park has no timer to release it.',
    before: `        const clockQueue = node_perf_hooks_1.performance.now() - this.clientFeedbackTimestamp > 1500 ? this.parkedFeedbackClockQueue : feedbackClockQueue;`,
    after: `        // RRABBIT patch -- 1500 -> 5000. See patches/greenfield-frame-feedback-park.diff.
        const clockQueue = node_perf_hooks_1.performance.now() - this.clientFeedbackTimestamp > 5000 ? this.parkedFeedbackClockQueue : feedbackClockQueue;`,
  },
]

let applied = 0
let already = 0

for (const p of PATCHES) {
  const path = join(root, p.file)
  let src
  try {
    src = readFileSync(path, 'utf8')
  } catch {
    console.error(`patch-compositor-proxy: ${path} not found.`)
    console.error('  Pass the compositor-proxy install root as the first argument.')
    process.exit(1)
  }

  if (src.includes(p.after)) {
    already++
    continue
  }
  if (!src.includes(p.before)) {
    console.error(`patch-compositor-proxy: ${p.name} -- the code does not look as expected.`)
    console.error(`  in ${path}`)
    console.error(`  ${p.why}`)
    console.error('  Upstream may have fixed this. Check before shipping the workaround.')
    process.exit(1)
  }
  writeFileSync(path, src.replace(p.before, p.after))
  console.log(`patch-compositor-proxy: ${p.name} applied`)
  applied++
}

if (applied === 0 && already > 0) console.log(`patch-compositor-proxy: already applied (${already})`)
