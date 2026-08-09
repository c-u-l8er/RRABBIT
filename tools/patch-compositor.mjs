// Apply the xdg_popup mapping fix to the INSTALLED @gfld/compositor.
//
// `patches/greenfield-xdgpopup-map.patch` is the upstream-ready source diff.
// This applies the same change to the compiled dist that npm actually ships,
// because @gfld/compositor@1.0.0-rc1 has no released build with the fix.
//
// An exact-string match rather than a line-numbered patch: if upstream changes
// this function at all, we want a loud failure rather than a patch that applies
// to the wrong place.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'node_modules/@gfld/compositor/dist/XdgPopup.js'

const BEFORE = `        this.committed = true;
        surface.session.renderer.render();`

const AFTER = `        this.committed = true;
        // RRABBIT patch -- see patches/greenfield-xdgpopup-map.patch.
        // Without this an xdg_popup never maps and no menu can ever be shown.
        this.desktopSurface.commit();
        surface.session.renderer.render();`

let src
try {
  src = readFileSync(FILE, 'utf8')
} catch {
  console.log('patch-compositor: @gfld/compositor not installed yet, skipping')
  process.exit(0)
}

if (src.includes('RRABBIT patch')) {
  console.log('patch-compositor: already applied')
  process.exit(0)
}
if (!src.includes(BEFORE)) {
  console.error('patch-compositor: XdgPopup.onCommit does not look as expected.')
  console.error('  Upstream may have fixed this. Check before shipping the runtime workaround.')
  process.exit(1)
}
writeFileSync(FILE, src.replace(BEFORE, AFTER))
console.log('patch-compositor: xdg_popup mapping fix applied')
