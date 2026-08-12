// Apply RRABBIT's fixes to the INSTALLED @gfld/compositor.
//
// `patches/*.patch` are the upstream-ready source diffs. This applies the same
// changes to the compiled dist that npm actually ships, because
// @gfld/compositor@1.0.0-rc1 has no released build with either fix.
//
// EXACT-STRING matches rather than line-numbered patches: if upstream changes
// one of these functions at all, we want a loud failure rather than a patch
// applied to the wrong place.
import { readFileSync, writeFileSync } from 'node:fs'

const PATCHES = [
  {
    name: 'xdg_popup mapping',
    file: 'node_modules/@gfld/compositor/dist/XdgPopup.js',
    why: 'Without this an xdg_popup never maps and no menu can ever be shown.',
    before: `        this.committed = true;
        surface.session.renderer.render();`,
    after: `        this.committed = true;
        // RRABBIT patch -- see patches/greenfield-xdgpopup-map.patch.
        // Without this an xdg_popup never maps and no menu can ever be shown.
        this.desktopSurface.commit();
        surface.session.renderer.render();`,
  },
  {
    // See patches/greenfield-webcodec-visible-size.patch and spec section 20.4.
    //
    // A decoded frame is labelled with its CODED size and filled with its
    // VISIBLE one. `VideoFrame.allocationSize()`/`copyTo()` default their rect
    // to the visible rect, so the buffer holds exactly that; `opaqueOutput`
    // then labels the same buffer `codedSize`. Measured on a real xterm:
    //
    //     coded   1024 x 770
    //     visible 1024 x 768   <- what copyTo actually wrote
    //
    // Downstream, convertYUVAArrayBufferInto slices the planes from the label:
    // lumaSize = 1024*770 = 788480, but only 786432 bytes of luma exist. So the
    // Y slice eats the first 2048 bytes of U, both chroma planes are read 2048
    // bytes (4 chroma rows) late, and V runs 3072 bytes off the end of the
    // buffer -- where `subarray` silently clamps and leaves the tail of the
    // chroma texture never written. Displaced chroma is the diagonal; never
    // written chroma is the flat cyan under it.
    //
    // Two rows of padding, and the whole picture is wrong.
    //
    // Fix the LABEL rather than the copy: say the size that was actually
    // written. It also happens to be the size worth showing -- the two extra
    // coded rows are padding, not picture -- and it keeps the plane maths
    // self-consistent, since that code slices chroma with `>> 1` and `>> 2`
    // and only agrees with itself on even dimensions.
    name: 'webcodec visible-size labelling',
    file: 'node_modules/@gfld/compositor/dist/remote/webcodec-buffer-decoder.js',
    why: 'Without this every decoded native frame has its chroma displaced and its tail unwritten.',
    before: `    opaqueOutput(buffer) {
        const width = buffer.codedWidth;
        const height = buffer.codedHeight;`,
    after: `    opaqueOutput(buffer) {
        // RRABBIT patch -- see patches/greenfield-webcodec-visible-size.patch.
        // copyTo() wrote the visible rect; label it with the visible rect.
        const width = buffer.visibleRect?.width ?? buffer.codedWidth;
        const height = buffer.visibleRect?.height ?? buffer.codedHeight;`,
  },
  {
    name: 'webcodec visible-size labelling (alpha)',
    file: 'node_modules/@gfld/compositor/dist/remote/webcodec-buffer-decoder.js',
    why: 'The alpha plane has the same label/content mismatch as the opaque one.',
    before: `    alphaOutput(buffer) {
        const width = buffer.codedWidth;
        const height = buffer.codedHeight;`,
    after: `    alphaOutput(buffer) {
        // RRABBIT patch -- same reason as opaqueOutput above.
        const width = buffer.visibleRect?.width ?? buffer.codedWidth;
        const height = buffer.visibleRect?.height ?? buffer.codedHeight;`,
  },
  {
    // The one that actually matters for I420, and the one I patched last.
    // opaqueOutput/alphaOutput record a codedSize, but the I420 branch of
    // onComplete does NOT use it -- it builds a fresh codedSize straight off
    // the VideoFrame, so labelling the other two sites changed nothing at all
    // for the path this stack actually takes. Fixing the label where the
    // buffer is built is the fix.
    name: 'webcodec visible-size labelling (I420 buffer)',
    file: 'node_modules/@gfld/compositor/dist/remote/webcodec-buffer-decoder.js',
    why: 'This is the site the I420 path reads; without it the other two labels are dead letters.',
    before: `                opaque: {
                    buffer: new Uint8Array(opaqueBuffer),
                    codedSize: {
                        width: opaqueVideoFrame.codedWidth,
                        height: opaqueVideoFrame.codedHeight,
                    },
                },`,
    after: `                opaque: {
                    buffer: new Uint8Array(opaqueBuffer),
                    // RRABBIT patch -- copyTo() above wrote the VISIBLE rect,
                    // so this must be the visible size. Labelling it coded
                    // (1024x770 for a 1024x768 picture) makes the consumer
                    // slice its chroma planes 2048 bytes late and run the V
                    // plane off the end of the buffer.
                    codedSize: {
                        width: opaqueVideoFrame.visibleRect?.width ?? opaqueVideoFrame.codedWidth,
                        height: opaqueVideoFrame.visibleRect?.height ?? opaqueVideoFrame.codedHeight,
                    },
                },`,
  },
  {
    name: 'webcodec visible-size labelling (I420 alpha buffer)',
    file: 'node_modules/@gfld/compositor/dist/remote/webcodec-buffer-decoder.js',
    why: 'Same site, alpha plane.',
    before: `                dualPlaneYUVABuffer.alpha = {
                    buffer: new Uint8Array(alphaBuffer),
                    codedSize: {
                        width: decodeResult.alpha.buffer.codedWidth,
                        height: decodeResult.alpha.buffer.codedHeight,
                    },
                };`,
    after: `                dualPlaneYUVABuffer.alpha = {
                    buffer: new Uint8Array(alphaBuffer),
                    // RRABBIT patch -- same reason as the opaque plane above.
                    codedSize: {
                        width: decodeResult.alpha.buffer.visibleRect?.width ?? decodeResult.alpha.buffer.codedWidth,
                        height: decodeResult.alpha.buffer.visibleRect?.height ?? decodeResult.alpha.buffer.codedHeight,
                    },
                };`,
  },
]

let applied = 0
let already = 0

for (const p of PATCHES) {
  let src
  try {
    src = readFileSync(p.file, 'utf8')
  } catch {
    console.log(`patch-compositor: ${p.file} not installed yet, skipping`)
    continue
  }

  // Per-patch, not per-file: two patches now live in the same file, and a
  // shared 'RRABBIT patch' marker would let the first one mask the second.
  if (src.includes(p.after)) {
    already++
    continue
  }
  if (!src.includes(p.before)) {
    console.error(`patch-compositor: ${p.name} -- the code does not look as expected.`)
    console.error(`  in ${p.file}`)
    console.error(`  ${p.why}`)
    console.error('  Upstream may have fixed this. Check before shipping the workaround.')
    process.exit(1)
  }
  writeFileSync(p.file, src.replace(p.before, p.after))
  console.log(`patch-compositor: ${p.name} applied`)
  applied++
}

if (applied === 0 && already > 0) console.log(`patch-compositor: already applied (${already})`)
