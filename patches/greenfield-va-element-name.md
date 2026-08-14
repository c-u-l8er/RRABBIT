# greenfield-va-element-name.diff

**`vaapih264enc` does not exist any more, so `--encoder=vaapih264` could never
build its pipeline.** Applied to the Greenfield *source* by
`tools/build-addons.sh`, not to `node_modules` — the string is compiled into
`libproxy-encoding.so`, so unlike the other two patches here there is nothing in
`node_modules` to rewrite after the fact.

## What it changes

Two identical lines in
`packages/compositor-proxy/native/encoding/src/gst_frame_encoder.c` — the opaque
and the alpha pipeline of the `vaapih264` encoder entry:

    - "vaapih264enc aud=1 ! "
    + "vah264enc aud=1 ! "

Nothing else. The rest of that pipeline is already correct for VA:

    appsrc ! glupload ! glcolorconvert ! glshader ! capsfilter ! glcolorconvert
      ! video/x-raw(memory:GLMemory),format=NV12 ! gldownload ! queue
      ! <h264 encoder> aud=1
      ! video/x-h264,profile=high,stream-format=byte-stream,alignment=au ! appsink

## Why

`vaapih264enc` belongs to **gstreamer-vaapi**, which upstream deprecated and Arch
has dropped from its repositories entirely — `pacman -Ss gstreamer-vaapi` returns
nothing. The replacement is the `va` plugin (`extra/gst-plugin-va`), whose H.264
encoder is named **`vah264enc`**. Same job, different element name, and the name
is the only thing that had to change.

Measured on this machine before touching the source:

    gst-inspect-1.0 | grep h264enc
      va:  vah264enc: VA-API H.264 Encoder in AMD Radeon 890M Graphics

    vainfo --display drm --device /dev/dri/renderD129
      VAProfileH264High : VAEntrypointEncSlice        <- hardware encode present

    gst-launch-1.0 videotestsrc num-buffers=60
      ! video/x-raw,format=NV12,width=640,height=480,framerate=30/1
      ! vah264enc aud=1
      ! video/x-h264,profile=high,stream-format=byte-stream,alignment=au
      ! fakesink                                      <- runs clean

`vah264enc` takes `aud` as a boolean property and produces the exact caps the
next element in the pipeline demands, so this is a drop-in and not an
approximation.

## Why VA and not NVENC

This laptop has both GPUs — `renderD128` is the RTX 4060, `renderD129` the AMD
890M that `tools/proxy.sh` selects by PCI vendor. NVENC cannot be reached: the
`nvh264` pipeline has **no `gldownload`** and feeds GLMemory straight into
`nvh264enc`, so the gstgl context must live on the NVIDIA GPU. It does not, and
neither `--render-device=/dev/dri/renderD128` nor forcing glvnd's NVIDIA EGL
vendor moves it — both were tried and both gave `nvidia-smi utilization.encoder`
of **0%** with a stream of `EGL_BAD_CONTEXT … eglCUDAInterOpFunction`.
`GST_GL_WINDOW=surfaceless` takes `EGL_DEFAULT_DISPLAY` and lands on the iGPU
regardless of either.

The VA pipeline does `gldownload` first, so it needs no GL interop at all and
works with gstgl exactly where it already runs.

## If this stops applying

`git apply` failing is the correct outcome — it means upstream moved that file
and the pipeline should be re-read rather than force-fitted. Regenerate with:

    cd ~/.cache/rrabbit/greenfield
    sed -i 's/"vaapih264enc aud=1 ! "/"vah264enc aud=1 ! "/g' \
      packages/compositor-proxy/native/encoding/src/gst_frame_encoder.c
    git diff > <repo>/patches/greenfield-va-element-name.diff
    git checkout -- .
