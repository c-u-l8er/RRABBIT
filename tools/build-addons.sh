#!/usr/bin/env bash
# Rebuild @gfld/compositor-proxy's native addons against THIS machine's gstreamer.
#
# Why this exists: the addons npm ships are built by Greenfield's own docker
# script (`docker/compositor-proxy-cli-build.sh`), which compiles gstreamer from
# source at branch 1.20. This machine has 1.28. The mismatch does not fail --
# `ldd` resolves every symbol -- the h264 pipeline simply connects, negotiates,
# logs nothing and emits no frames. See docs/spec/README.md §18.1.
#
# So: build from source, install over the prebuilts, and record a hash manifest
# so tools/check-addons.mjs can tell afterwards which one is actually in place.
#
#   ./tools/build-addons.sh          # build + install + record
#   ./tools/build-addons.sh --clean  # discard the build tree first
#
# Env:
#   GREENFIELD_REF   git ref to build (default: GREENFIELD_COMMIT below)
#   RRABBIT_BUILD_DIR  where the source tree lives
#                      (default ~/.cache/rrabbit -- deliberately NOT /tmp,
#                      which is a tmpfs here and loses the tree on reboot)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${RRABBIT_BUILD_DIR:-$HOME/.cache/rrabbit}"
SRC="$BUILD_DIR/greenfield"
PKG="$REPO_ROOT/node_modules/@gfld/compositor-proxy"
UPSTREAM="https://github.com/udevbe/greenfield"

# The commit npm's @gfld/compositor-proxy@1.0.0-rc1 was actually published from.
#
# It is NOT the `1.0.0-rc1` git tag, and this is not a detail. Building the tag
# produces addons that load, log nothing, and deliver ZERO surfaces to the
# browser -- the app launches, XWayland starts, the channel opens, and no window
# ever appears. Measured both ways: tag -> surfaces 0; this commit -> surfaces 1,
# signs 1, adopted 1. Same failure shape as §18.1: no error, just nothing.
#
# Pinned rather than tracking `master`, because "whatever master is today" is
# not a thing a rebuild can reproduce.
GREENFIELD_COMMIT="6c578f4db7ec027eb1d8a5f7ec6e09f7646dbb57"

if [ ! -d "$PKG" ]; then
  echo "!!! @gfld/compositor-proxy is not installed -- run npm install first" >&2
  exit 1
fi

INSTALLED_VERSION="$(node -p "require('$PKG/package.json').version")"
REF="${GREENFIELD_REF:-$GREENFIELD_COMMIT}"

echo "==> installed @gfld/compositor-proxy: $INSTALLED_VERSION"
echo "==> building greenfield ref:          $REF"

# ---------------------------------------------------------------- preflight --
missing=""
for tool in cmake ninja pkg-config git; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
[ -n "$missing" ] && { echo "!!! missing build tools:$missing" >&2; exit 1; }

# The CMakeLists asks for >=1.18 of each of these, plus graphene/egl/opengl/
# libffi/gbm/libdrm. Name them here so a missing one is a sentence, not 40
# lines of cmake.
for mod in glib-2.0 gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 \
           gstreamer-gl-1.0 gstreamer-allocators-1.0 graphene-1.0 egl \
           opengl libffi gbm libdrm; do
  pkg-config --exists "$mod" || missing="$missing $mod"
done
[ -n "$missing" ] && {
  echo "!!! missing pkg-config modules:$missing" >&2
  echo "    on Arch these come from: gstreamer gst-plugins-base-libs graphene mesa libffi libdrm" >&2
  exit 1
}

GST_VERSION="$(pkg-config --modversion gstreamer-1.0)"
echo "==> system gstreamer:                 $GST_VERSION"

# ------------------------------------------------------------------- source --
if [ "${1:-}" = "--clean" ]; then
  echo "==> discarding $SRC"
  rm -rf "$SRC"
fi

mkdir -p "$BUILD_DIR"
if [ ! -d "$SRC/.git" ]; then
  echo "==> initialising $SRC"
  git init --quiet "$SRC"
  git -C "$SRC" remote add origin "$UPSTREAM"
fi
# fetch by ref OR by raw sha -- the default is a commit, and `clone --branch`
# cannot take one.
echo "==> fetching $REF"
git -C "$SRC" fetch --quiet --depth 1 origin "$REF"
git -C "$SRC" checkout --quiet --force FETCH_HEAD
echo "==> source commit: $(git -C "$SRC" rev-parse HEAD)"

# -------------------------------------------------------------------- build --
PROXY_SRC="$SRC/packages/compositor-proxy"
[ -f "$PROXY_SRC/CMakeLists.txt" ] || {
  echo "!!! $PROXY_SRC/CMakeLists.txt not found -- upstream layout changed" >&2
  exit 1
}

# `install` here writes into the source package's own dist/addons; there is no
# system prefix involved, so this needs no privileges and touches nothing else.
cmake -G Ninja -B "$PROXY_SRC/build" -S "$PROXY_SRC" >/dev/null
ninja -C "$PROXY_SRC/build" install >/dev/null
echo "==> built $(ls "$PROXY_SRC"/dist/addons/*.node | wc -l) addons + $(ls "$PROXY_SRC"/dist/addons/shared | wc -l) shared libs"

# ------------------------------------------------------------------ install --
# Keep the prebuilts. They are the only copy -- npm's cache would hand back the
# same tarball, but having them adjacent makes the difference inspectable.
if [ ! -d "$PKG/dist/addons.prebuilt-backup" ]; then
  echo "==> backing up prebuilt addons -> dist/addons.prebuilt-backup"
  cp -R "$PKG/dist/addons" "$PKG/dist/addons.prebuilt-backup"
fi

# Replace rather than overlay, so the installed set is exactly what was built.
# Overlaying leaves behind anything an earlier build produced and a later one
# did not -- which then gets recorded in addons.lock.json as if it belonged.
rm -rf "$PKG/dist/addons"
cp -a "$PROXY_SRC/dist/addons" "$PKG/dist/addons"
echo "==> installed into $PKG/dist/addons"

# ----------------------------------------------------------------- manifest --
node "$REPO_ROOT/tools/check-addons.mjs" --write --gst "$GST_VERSION" \
     --ref "$REF" --commit "$(git -C "$SRC" rev-parse HEAD)"
node "$REPO_ROOT/tools/check-addons.mjs"
