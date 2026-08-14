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
