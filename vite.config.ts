import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// THE MENU'S PROGRAM LIST SHIPS WITH THE SHELL.
//
// `proxy/applications.json` is the file compositor-proxy is actually started
// with, and vite serves it in dev because it is on disk under the repo root. It
// was NOT in the build, so every built shell -- including the one in the T&R
// image -- fell back to `NATIVE_MIRROR`, a hand-copied constant in shell.js.
//
// A mirror drifts, and this one had: it listed the five host programs and not
// `foot · tr4`, which is the one native entry that demonstrably opens a window.
// So the built menu offered exactly the applications that do not work and hid
// the one that does. Copying the real file removes the second list rather than
// asking someone to remember to update it.
//
// BUT IT MUST NOT BE THE DEVELOPER'S FILE, and for a while it was.
// `proxy/applications.json` is whatever the person at this keyboard happens to
// be launching -- `gnome-text-editor`, `glxgears`, and a `foot · tr4` entry
// carrying the absolute path of an ssh key in their home directory. Baking that
// into a build meant the T&R image advertised a stranger's applications and
// shipped a path to their key. The image ships `applications.image.json`, a
// committed list of programs that exist ON THE TARGET; `RRABBIT_APPLICATIONS`
// overrides it for a build you intend to run here.
const APPLICATIONS = process.env.RRABBIT_APPLICATIONS ?? 'proxy/applications.image.json'

function shipApplications() {
  return {
    name: 'rrabbit-ship-applications',
    generateBundle() {
      // Parsed, not streamed: a malformed file should fail the BUILD, not ship
      // a menu that throws when it is opened on the target.
      const source = JSON.stringify(JSON.parse(readFileSync(APPLICATIONS, 'utf8')), null, 2)

      // A home directory in a shipped program list is always a mistake: nothing
      // under /home exists on the target, so the entry cannot work there, and
      // the path itself says who built it. Loud, because the failure it prevents
      // is silent -- a menu row that refuses on someone else's machine.
      const leaked = source.match(/"[^"]*\/(home|Users)\/[^"]*"/g)
      if (leaked) {
        throw new Error(
          `${APPLICATIONS} ships a path from the builder's home directory: ${leaked.join(', ')}\n` +
            'That program cannot exist on the target. Use proxy/applications.image.json, ' +
            'or set RRABBIT_APPLICATIONS if this build is only ever going to run here.',
        )
      }

      this.emitFile({ type: 'asset', fileName: 'proxy/applications.json', source })
    },
  }
}

// COOP/COEP are not optional. Greenfield web apps run in same-origin iframes
// and need SharedArrayBuffer, which the browser refuses to hand out on a page
// that is not cross-origin isolated. Without these headers the compositor comes
// up fine and the client silently never connects.
export default defineConfig({
  plugins: [shipApplications()],
  // Repo root, so /m0/ and /m1/ are both served and share /clients/.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8911,
    strictPort: true,
    cors: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // The tubes, same-origin in dev too. On the target bridge.py serves the
    // bundle and /api from one port; without this proxy dev would be the only
    // place the shell talks to a different origin, and "works in dev" would
    // stop meaning "works on the target" for exactly this path.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8913', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // m2 is the living shell; the clients ship with it because a shell with
      // nothing to launch is not testable on the target.
      input: {
        shell: 'm2/index.html',
        'simple-shm': 'clients/simple-shm/app.html',
        'menu-shm': 'clients/menu-shm/app.html',
      },
    },
  },
  optimizeDeps: {
    // The compositor ships wasm + workers; letting esbuild pre-bundle it
    // rewrites those URLs and they 404 at runtime.
    exclude: ['@gfld/compositor', '@gfld/compositor-wasm'],
  },
})
