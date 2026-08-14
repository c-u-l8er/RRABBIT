#!/bin/sh
# Build @gfld/compositor-proxy's native addons ON FreeBSD.
#
# The sibling of tools/build-addons.sh, which is Linux-only because Greenfield
# is. Run this on a FreeBSD machine with a full base system -- the T&R BUILDER
# guest, not the image: the image is pkgbase and minimal, has no compiler, and
# has no base development files either (`cannot open crt1.o`). That is correct
# and deliberate. The binaries built here are what the image ships, exactly as
# `ic32` already does.
#
#   ./tools/build-addons-freebsd.sh            # build into $SRC/dist/addons
#   OUT=/somewhere ./tools/build-addons-freebsd.sh   # and copy them out
#
# THREE THINGS MAKE IT BUILD, and every one of them was a separate stop:
#
#  1. libepoll-shim. Greenfield VENDORS libwayland-server rather than linking
#     the system one, and that copy is Linux-only in exactly four places --
#     epoll, eventfd, timerfd, signalfd. libepoll-shim implements all four over
#     kqueue; it is how wlroots and sway build here, so this is the trodden path
#     and not something invented for us.
#
#  2. -DHAVE_SYS_UCRED_H=1 -DHAVE_XUCRED_CR_PID=1. `wayland-os.c` ALREADY has a
#     `#if defined(__FreeBSD__)` branch using `struct xucred` -- upstream ported
#     this and then guarded the include behind a feature macro their CMake never
#     defines, because their build only ever ran on Linux. FreeBSD 15's
#     <sys/ucred.h> has both `xucred` and `cr_pid`, checked before defining.
#
#  3. -I/usr/local/include. Base `cc` does not search the ports include path, so
#     `EGL/egl.h` is missing even with mesa installed. Nothing to do with
#     Greenfield; it is the oldest FreeBSD build wart there is.
#
# Packages (two names are traps -- the obvious ones do not exist):
#   gstreamer1 gstreamer1-plugins gstreamer1-plugins-gl gstreamer1-plugins-x264
#   graphene mesa-libs mesa-dri libdrm libffi glib libepoll-shim
#   cmake ninja pkgconf git node24
#
#   * `gstreamer1-plugins`, NOT `gstreamer1-plugins-base`.
#   * `gstreamer-gl-1.0` is its OWN port, `gstreamer1-plugins-gl`, and the addon
#     cannot be built without it.
set -eu

# The same pin as tools/build-addons.sh, and for the same reason: the `1.0.0-rc1`
# TAG produces addons that load, log nothing and deliver zero surfaces. Keep the
# two files on the same commit or the platforms diverge silently.
REF=${GREENFIELD_REF:-6c578f4db7ec027eb1d8a5f7ec6e09f7646dbb57}
SRC=${RRABBIT_BUILD_DIR:-$HOME/.cache/rrabbit}/greenfield
UPSTREAM=https://github.com/udevbe/greenfield

[ "$(uname -s)" = "FreeBSD" ] || { echo "!!! this is the FreeBSD build; use tools/build-addons.sh" >&2; exit 1; }

missing=
for t in cmake ninja pkg-config git cc; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
[ -n "$missing" ] && { echo "!!! missing:$missing" >&2; exit 1; }

for m in glib-2.0 gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 \
         gstreamer-gl-1.0 gstreamer-allocators-1.0 graphene-1.0 egl \
         opengl libffi gbm libdrm; do
    pkg-config --exists "$m" || missing="$missing $m"
done
[ -n "$missing" ] && {
    echo "!!! missing pkg-config modules:$missing" >&2
    echo "    gstreamer-gl-1.0 comes from gstreamer1-plugins-gl, which is a separate port" >&2
    exit 1
}

SHIM_CFLAGS=$(pkg-config --cflags epoll-shim 2>/dev/null || echo "-I/usr/local/include/libepoll-shim")
SHIM_LIBS=$(pkg-config --libs epoll-shim 2>/dev/null || echo "-L/usr/local/lib -lepoll-shim")

echo "==> gstreamer $(pkg-config --modversion gstreamer-1.0) / gl $(pkg-config --modversion gstreamer-gl-1.0)"
echo "==> shim      $SHIM_CFLAGS $SHIM_LIBS"
echo "==> ref       $REF"

mkdir -p "$(dirname "$SRC")"
if [ ! -d "$SRC/.git" ]; then
    git init --quiet "$SRC"
    git -C "$SRC" remote add origin "$UPSTREAM"
fi
git -C "$SRC" fetch --quiet --depth 1 origin "$REF"
git -C "$SRC" checkout --quiet --force FETCH_HEAD

# Same rule as the Linux script: a patch that does not apply is a hard stop.
for p in "$(cd "$(dirname "$0")/.." && pwd)"/patches/greenfield-*.diff; do
    [ -e "$p" ] || continue
    if git -C "$SRC" apply --check "$p" 2>/dev/null; then
        git -C "$SRC" apply "$p"
        echo "==> applied $(basename "$p")"
    elif git -C "$SRC" apply --reverse --check "$p" 2>/dev/null; then
        echo "==> already applied $(basename "$p")"
    else
        echo "!!! patch does not apply: $(basename "$p") -- read the note beside it" >&2
        exit 1
    fi
done

PROXY_SRC=$SRC/packages/compositor-proxy
rm -rf "$PROXY_SRC/build"
cmake -G Ninja -B "$PROXY_SRC/build" -S "$PROXY_SRC" \
      -DCMAKE_C_FLAGS="$SHIM_CFLAGS -I/usr/local/include -DHAVE_SYS_UCRED_H=1 -DHAVE_XUCRED_CR_PID=1" \
      -DCMAKE_SHARED_LINKER_FLAGS="$SHIM_LIBS" \
      -DCMAKE_EXE_LINKER_FLAGS="$SHIM_LIBS" \
      -DCMAKE_MODULE_LINKER_FLAGS="$SHIM_LIBS" >/dev/null
ninja -C "$PROXY_SRC/build" install >/dev/null

echo "==> built $(ls "$PROXY_SRC"/dist/addons/*.node | wc -l | tr -d ' ') addons, $(ls "$PROXY_SRC"/dist/addons/shared | wc -l | tr -d ' ') shared libs"

# LINKS IS NOT MATCHES -- §18.1's whole lesson. Say which gstreamer these are
# against, so a later mismatch is a sentence rather than a silent black window.
echo "==> against gstreamer $(pkg-config --modversion gstreamer-1.0)"
ldd "$PROXY_SRC"/dist/addons/shared/libproxy-encoding.so | grep -i "not found" && {
    echo "!!! unresolved libraries above" >&2; exit 1; }

if [ -n "${OUT:-}" ]; then
    mkdir -p "$OUT"
    cp -R "$PROXY_SRC"/dist/addons/. "$OUT/"
    echo "==> copied to $OUT"
fi
