#!/usr/bin/env bash
# Start the compositor proxy the way it actually works on this machine.
#
# Everything below was previously prose in docs/spec/README.md §13.5 and §18.1,
# which meant `npm run proxy` did not reproduce the working configuration. The
# two things it was missing:
#
#   1. the render device. This laptop has two GPUs; gstgl cannot make an EGL
#      context on the NVIDIA one and GLib aborts, which surfaces as SIGTRAP.
#   2. the GST_GL_* triple. Without it gstgl picks a windowing system it cannot
#      have in a headless process.
#
# Overridable: RRABBIT_RENDER_DEVICE, RRABBIT_ENCODER, RRABBIT_PORT, GST_GL_*.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The addon has to be the one built against this machine's gstreamer, or the
# pipeline runs and silently emits nothing. See tools/check-addons.mjs.
node tools/check-addons.mjs

# Pick the AMD render node by PCI vendor id rather than by number. The numbering
# has been stable (it follows PCI order) but the failure mode of getting it
# wrong is a crash inside GLib, so name the choice.
resolve_render_device() {
  if [ -n "${RRABBIT_RENDER_DEVICE:-}" ]; then echo "$RRABBIT_RENDER_DEVICE"; return; fi
  for node in /sys/class/drm/renderD*; do
    vendor="$(cat "$node/device/vendor" 2>/dev/null || true)"
    [ "$vendor" = "0x1002" ] && { echo "/dev/dri/$(basename "$node")"; return; }
  done
  echo "!!! no AMD (0x1002) render node found." >&2
  echo "    gstgl cannot make an EGL context on the NVIDIA node -- GLib aborts (SIGTRAP)." >&2
  echo "    Set RRABBIT_RENDER_DEVICE=/dev/dri/renderDxxx to override." >&2
  exit 1
}

RENDER_DEVICE="$(resolve_render_device)"
PORT="${RRABBIT_PORT:-8912}"
ENCODER="${RRABBIT_ENCODER:-x264}"

export GST_GL_WINDOW="${GST_GL_WINDOW:-surfaceless}"
export GST_GL_PLATFORM="${GST_GL_PLATFORM:-egl}"
export GST_GL_API="${GST_GL_API:-gles2}"

echo "==> render device: $RENDER_DEVICE ($(cat "/sys/class/drm/$(basename "$RENDER_DEVICE")/device/uevent" 2>/dev/null | grep -m1 DRIVER= || echo 'driver unknown'))"
echo "==> gstgl:         $GST_GL_WINDOW/$GST_GL_PLATFORM/$GST_GL_API   encoder: $ENCODER"

exec node proxy/proxy-cli.js \
  --applications=./proxy/applications.json \
  --allow-origin="${RRABBIT_ALLOW_ORIGIN:-http://127.0.0.1:8911}" \
  --bind-ip=127.0.0.1 \
  --bind-port="$PORT" \
  --base-url="ws://127.0.0.1:$PORT" \
  --render-device="$RENDER_DEVICE" \
  --encoder="$ENCODER" \
  "$@"
