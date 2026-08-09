import { defineConfig } from 'vite'

// COOP/COEP are not optional. Greenfield web apps run in same-origin iframes
// and need SharedArrayBuffer, which the browser refuses to hand out on a page
// that is not cross-origin isolated. Without these headers the compositor comes
// up fine and the client silently never connects.
export default defineConfig({
  root: 'm0',
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
  },
  optimizeDeps: {
    // The compositor ships wasm + workers; letting esbuild pre-bundle it
    // rewrites those URLs and they 404 at runtime.
    exclude: ['@gfld/compositor', '@gfld/compositor-wasm'],
  },
})
