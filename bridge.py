#!/usr/bin/env python3
"""RRABBIT bridge -- the machine, as seven gauges.

RAVIO's tube rack showed seven lane ratings, each shaped
``{value, n, why, bar}``: a 0..1 needle, the raw number, prose explaining it,
and the redline. RRABBIT keeps that shape exactly, which is why the rack needs
no new geometry -- only a new source. See spec section 3.1.

``why`` IS NOT DECORATION. Invariant 1 says the road may never move for a reason
the viewer cannot read off a sign, so a tube in the red has to name the thing
doing it: the process, the interface, the filesystem, the sensor. A gauge that
reports 0.97 and declines to say what is at 0.97 is the thing RAVIO's deleted
idle-sway term was a comment about.

Two readers. Linux is what this is developed on; FreeBSD is what T&R actually
runs. The FreeBSD reader was written from the documented sysctl names and went
unrun until 2026-08-09, when it was finally exercised on a booted T&R image --
see FreeBSDReader's docstring for what that settled and what it did not.

stdlib only, on purpose: this ships inside a distro image.
"""

from __future__ import annotations

import json
import mimetypes
import os
import platform
import posixpath
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8913

# The built shell. Serving it from here means the target needs PYTHON ONLY at
# runtime -- no node, no vite. `npx vite build` produces this; the distro ships
# the output, not the toolchain.
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

# NOT OPTIONAL. Greenfield web clients run in same-origin iframes and need
# SharedArrayBuffer, which the browser withholds unless the page is
# cross-origin isolated. Without these two headers the shell loads, the
# compositor starts, and no client can ever connect -- a failure that looks
# like the clients being broken.
# Reports posted by a running shell (see /api/report).
REPORTS = []

ISOLATION_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}

# The seven, in rack order.
TUBES = ("cpu", "ram", "swap", "disk", "net", "temp", "load")

# Redlines. `None` means the gauge has no meaningful ceiling (see NET).
BARS = {
    "cpu": 1.0,
    "ram": 0.9,
    # Swapping at all is a fault, not a level -- so the redline sits low
    # deliberately. A machine that swaps steadily is already in trouble.
    "swap": 0.25,
    "disk": 0.9,
    "net": None,
    "temp": 0.85,
    "load": 1.0,
}


def rating(value, n, why, bar):
    """The RAVIO rating shape, unchanged."""
    if value is None:
        return {"value": None, "n": None, "why": why, "bar": bar}
    return {"value": max(0.0, min(1.0, float(value))), "n": n, "why": why, "bar": bar}


# --------------------------------------------------------------------- linux


class LinuxReader:
    name = "linux"

    def __init__(self):
        self._cpu_prev = None
        self._proc_prev = {}
        self._net_prev = None
        self._net_peak = None

    # -- helpers

    def _ncpu(self):
        return os.cpu_count() or 1

    def _meminfo(self):
        out = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, rest = line.partition(":")
                out[k] = int(rest.split()[0]) * 1024  # kB -> bytes
        return out

    def _top_process(self, key):
        """Return (name, metric) for the heaviest process.

        key='cpu' uses a DELTA of utime+stime since the last call, because a
        process's total CPU time only says what it has ever done -- a long-lived
        idle daemon would win every time and the `why` would be a lie.
        """
        best = (None, 0)
        now = {}
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                if key == "cpu":
                    with open(f"/proc/{pid}/stat") as f:
                        parts = f.read().rsplit(") ", 1)[-1].split()
                    # after the comm field: state is [0], utime [11], stime [12]
                    ticks = int(parts[11]) + int(parts[12])
                    now[pid] = ticks
                    prev = self._proc_prev.get(pid)
                    metric = ticks - prev if prev is not None else 0
                else:
                    with open(f"/proc/{pid}/statm") as f:
                        metric = int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
                if metric > best[1]:
                    with open(f"/proc/{pid}/comm") as f:
                        best = (f.read().strip(), metric)
            except (OSError, ValueError, IndexError):
                continue
        if key == "cpu":
            self._proc_prev = now
        return best

    # -- the seven

    def cpu(self):
        with open("/proc/stat") as f:
            parts = [int(x) for x in f.readline().split()[1:]]
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        total = sum(parts)
        prev = self._cpu_prev
        self._cpu_prev = (idle, total)
        if prev is None:
            return rating(None, None, "first sample -- no interval to divide by", BARS["cpu"])
        d_idle, d_total = idle - prev[0], total - prev[1]
        if d_total <= 0:
            return rating(None, None, "no time passed between samples", BARS["cpu"])
        busy = 1.0 - (d_idle / d_total)
        who, ticks = self._top_process("cpu")
        why = f"busiest: {who}" if who else "no process stood out"
        return rating(busy, round(busy * 100, 1), why, BARS["cpu"])

    def ram(self):
        m = self._meminfo()
        total, avail = m["MemTotal"], m.get("MemAvailable", m["MemFree"])
        used = total - avail
        who, rss = self._top_process("rss")
        why = f"largest: {who} at {rss // (1 << 20)} MB" if who else "no process stood out"
        return rating(used / total, f"{used // (1 << 20)} MB of {total // (1 << 20)}", why, BARS["ram"])

    def swap(self):
        m = self._meminfo()
        total = m.get("SwapTotal", 0)
        if total == 0:
            return rating(0.0, "no swap configured", "nothing to swap to", BARS["swap"])
        used = total - m.get("SwapFree", 0)
        return rating(
            used / total,
            f"{used // (1 << 20)} MB of {total // (1 << 20)}",
            "swapping is a fault, not a level" if used else "not swapping",
            BARS["swap"],
        )

    def disk(self):
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        used = total - free
        return rating(
            used / total,
            f"{used // (1 << 30)} GB of {total // (1 << 30)}",
            f"/ -- {free // (1 << 30)} GB free",
            BARS["disk"],
        )

    def net(self):
        now = time.monotonic()
        counts = {}
        with open("/proc/net/dev") as f:
            for line in f.read().splitlines()[2:]:
                iface, _, rest = line.partition(":")
                cols = rest.split()
                counts[iface.strip()] = int(cols[0]) + int(cols[8])
        prev = self._net_prev
        self._net_prev = (now, counts)
        if prev is None:
            return rating(None, None, "first sample -- no interval to divide by", BARS["net"])
        dt = now - prev[0]
        if dt <= 0:
            return rating(None, None, "no time passed between samples", BARS["net"])
        busiest, rate = None, 0.0
        for iface, total in counts.items():
            if iface == "lo":
                continue
            r = (total - prev[1].get(iface, total)) / dt
            if r > rate:
                busiest, rate = iface, r
        # There is no true ceiling for a NIC we did not interrogate, so the
        # needle is scaled against the busiest second ever OBSERVED.
        #
        # SCALE AGAINST THE PRIOR PEAK, NEVER ONE THAT INCLUDES THIS SAMPLE.
        # Folding the current rate in first makes every new maximum read exactly
        # 100%, so the very first byte transferred pinned the gauge -- measured:
        # `value 1.0` at `0.00 MB/s`. A gauge whose first reading is always full
        # is not a gauge. Until a second sample has something to be compared
        # against, the honest answer is "unknown", the same as the first-sample
        # case above.
        prior_peak = self._net_peak
        self._net_peak = rate if prior_peak is None else max(prior_peak, rate)
        if prior_peak is None:
            return rating(None, f"{rate / 1e6:.2f} MB/s", f"{busiest} -- no busier second seen yet", BARS["net"])
        return rating(
            rate / prior_peak if prior_peak > 0 else 0.0,
            f"{rate / 1e6:.2f} MB/s",
            f"{busiest} -- scaled against the busiest {prior_peak / 1e6:.2f} MB/s seen",
            BARS["net"],
        )

    def temp(self):
        best = None
        base = "/sys/class/hwmon"
        if os.path.isdir(base):
            for hw in os.listdir(base):
                d = os.path.join(base, hw)
                try:
                    label = open(os.path.join(d, "name")).read().strip()
                except OSError:
                    continue
                for entry in sorted(os.listdir(d)):
                    if not (entry.startswith("temp") and entry.endswith("_input")):
                        continue
                    try:
                        c = int(open(os.path.join(d, entry)).read()) / 1000.0
                    except (OSError, ValueError):
                        continue
                    crit = None
                    for suffix in ("_crit", "_max"):
                        p = os.path.join(d, entry.replace("_input", suffix))
                        try:
                            crit = int(open(p).read()) / 1000.0
                            break
                        except (OSError, ValueError):
                            pass
                    if best is None or c > best[1]:
                        best = (label, c, crit)
        if best is None:
            return rating(None, None, "no temperature sensor found", BARS["temp"])
        label, c, crit = best
        ceiling = crit or 100.0
        note = "" if crit else " (no critical point published -- assuming 100)"
        return rating(c / ceiling, f"{c:.1f} C", f"hottest: {label}{note}", BARS["temp"])

    def load(self):
        one, five, fifteen = os.getloadavg()
        n = self._ncpu()
        return rating(one / n, round(one, 2), f"{one:.2f} / {five:.2f} / {fifteen:.2f} over {n} cpus", BARS["load"])


# ------------------------------------------------------------------- freebsd


class FreeBSDReader:
    """Run for the first time on 2026-08-09, on a booted T&R desktop image.

    Six of seven tubes read real values there: cpu (kern.cp_time), ram, swap,
    disk, load, and net after the fix below. `net` did NOT survive first
    contact -- it raised TypeError on a None peak and the rack reported
    'reader failed', which is the failure mode working as designed rather than
    a number being invented.

    Still unverified, and not claimable from that run:
      * temp -- dev.cpu.0.temperature does not exist in a VM (no coretemp /
        amdtemp), so the branch that parses it has still never executed. What
        was verified is that its ABSENCE is reported honestly.
      * every reading came from a guest with one virtio interface and no swap;
        the swap and multi-NIC paths are still only as good as the docs.
    """

    name = "freebsd"

    def __init__(self):
        self._cpu_prev = None
        self._net_prev = None
        self._net_peak = None

    def _sysctl(self, name):
        try:
            out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=3)
            return out.stdout.strip() if out.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    def _ncpu(self):
        v = self._sysctl("hw.ncpu")
        return int(v) if v else (os.cpu_count() or 1)

    def cpu(self):
        raw = self._sysctl("kern.cp_time")
        if not raw:
            return rating(None, None, "kern.cp_time unavailable", BARS["cpu"])
        # user, nice, system, interrupt, idle
        parts = [int(x) for x in raw.split()]
        idle, total = parts[4], sum(parts)
        prev = self._cpu_prev
        self._cpu_prev = (idle, total)
        if prev is None:
            return rating(None, None, "first sample -- no interval to divide by", BARS["cpu"])
        d_idle, d_total = idle - prev[0], total - prev[1]
        if d_total <= 0:
            return rating(None, None, "no time passed between samples", BARS["cpu"])
        busy = 1.0 - d_idle / d_total
        return rating(busy, round(busy * 100, 1), "kern.cp_time", BARS["cpu"])

    def ram(self):
        page = int(self._sysctl("hw.pagesize") or 4096)
        total_pages = self._sysctl("vm.stats.vm.v_page_count")
        free_pages = self._sysctl("vm.stats.vm.v_free_count")
        inactive = self._sysctl("vm.stats.vm.v_inactive_count")
        if not total_pages:
            return rating(None, None, "vm.stats.vm unavailable", BARS["ram"])
        total = int(total_pages) * page
        avail = (int(free_pages or 0) + int(inactive or 0)) * page
        used = total - avail
        return rating(
            used / total,
            f"{used // (1 << 20)} MB of {total // (1 << 20)}",
            "free + inactive counted as available",
            BARS["ram"],
        )

    def swap(self):
        if not shutil.which("swapctl"):
            return rating(None, None, "swapctl not present", BARS["swap"])
        try:
            out = subprocess.run(["swapctl", "-sk"], capture_output=True, text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            return rating(None, None, "swapctl failed", BARS["swap"])
        parts = out.stdout.split()
        if len(parts) < 3:
            return rating(0.0, "no swap configured", "nothing to swap to", BARS["swap"])
        total, used = int(parts[1]) * 1024, int(parts[2]) * 1024
        if total == 0:
            return rating(0.0, "no swap configured", "nothing to swap to", BARS["swap"])
        return rating(
            used / total,
            f"{used // (1 << 20)} MB of {total // (1 << 20)}",
            "swapping is a fault, not a level" if used else "not swapping",
            BARS["swap"],
        )

    disk = LinuxReader.disk  # statvfs is POSIX; identical on both

    def net(self):
        now = time.monotonic()
        try:
            out = subprocess.run(["netstat", "-ibn"], capture_output=True, text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            return rating(None, None, "netstat unavailable", BARS["net"])
        counts = {}
        for line in out.stdout.splitlines()[1:]:
            c = line.split()
            if len(c) < 11 or c[0] == "lo0":
                continue
            try:
                counts[c[0]] = max(counts.get(c[0], 0), int(c[7]) + int(c[10]))
            except (ValueError, IndexError):
                continue
        prev = self._net_prev
        self._net_prev = (now, counts)
        if prev is None:
            return rating(None, None, "first sample -- no interval to divide by", BARS["net"])
        dt = now - prev[0]
        if dt <= 0:
            return rating(None, None, "no time passed between samples", BARS["net"])
        busiest, rate = None, 0.0
        for iface, total in counts.items():
            r = (total - prev[1].get(iface, total)) / dt
            if r > rate:
                busiest, rate = iface, r
        # Same prior-peak protocol as LinuxReader.net, and for the same measured
        # reason -- see the long note there. Written from the sysctl docs, this
        # reader had `max(self._net_peak, rate)` against a `_net_peak` that
        # starts at None, so the FIRST time it was ever run it raised
        # TypeError: '>' not supported between instances of 'float' and
        # 'NoneType', and the rack showed 'reader failed'. Patching only the
        # crash would have re-introduced the bug the Linux note describes:
        # folding this sample into the peak pins the gauge at 100% forever
        # after the first byte.
        prior_peak = self._net_peak
        self._net_peak = rate if prior_peak is None else max(prior_peak, rate)
        if prior_peak is None:
            return rating(None, f"{rate / 1e6:.2f} MB/s", f"{busiest} -- no busier second seen yet", BARS["net"])
        return rating(
            rate / prior_peak if prior_peak > 0 else None,
            f"{rate / 1e6:.2f} MB/s",
            f"{busiest} -- scaled against the busiest {prior_peak / 1e6:.2f} MB/s seen",
            BARS["net"],
        )

    def temp(self):
        raw = self._sysctl("dev.cpu.0.temperature")
        if not raw:
            return rating(None, None, "dev.cpu.0.temperature unavailable (coretemp/amdtemp not loaded?)", BARS["temp"])
        c = float(raw.rstrip("C"))
        return rating(c / 100.0, f"{c:.1f} C", "dev.cpu.0 (no critical point published -- assuming 100)", BARS["temp"])

    def load(self):
        one, five, fifteen = os.getloadavg()
        n = self._ncpu()
        return rating(one / n, round(one, 2), f"{one:.2f} / {five:.2f} / {fifteen:.2f} over {n} cpus", BARS["load"])


READER = FreeBSDReader() if platform.system() == "FreeBSD" else LinuxReader()


def read_all():
    out = {}
    for name in TUBES:
        try:
            out[name] = getattr(READER, name)()
        except Exception as e:  # a broken gauge must not take the rack down
            out[name] = rating(None, None, f"reader failed: {e}", BARS[name])
    return {"reader": READER.name, "at": time.time(), "tubes": out}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in ISOLATION_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _resolve(self, url_path):
        """Map a URL to a file under DIST, refusing anything outside it."""
        path = posixpath.normpath(url_path.split("?")[0].split("#")[0])
        parts = [p for p in path.split("/") if p and p not in (".", "..")]
        target = os.path.join(DIST, *parts)
        # normpath above drops "..", but resolve and re-check anyway: a path
        # that escapes the root is the one bug in a static server that matters.
        target = os.path.realpath(target)
        if not target.startswith(os.path.realpath(DIST)):
            return None
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        return target if os.path.isfile(target) else None

    def do_GET(self):
        route = self.path.split("?")[0]

        if route == "/api/tubes":
            body = json.dumps(read_all()).encode()
            # Still permissive: during development the shell is served by vite
            # on another port and polls this one.
            self._send(200, body, "application/json", {"Access-Control-Allow-Origin": "*"})
            return

        if not os.path.isdir(DIST):
            self._send(
                503,
                b"RRABBIT shell not built. Run: npx vite build\n",
                "text/plain; charset=utf-8",
            )
            return

        # The session opens "/", and the shell lives at /m2/.
        if route == "/":
            self.send_response(302)
            self.send_header("Location", "/m2/")
            self.end_headers()
            return

        target = self._resolve(route)
        if target is None:
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        ctype, _ = mimetypes.guess_type(target)
        with open(target, "rb") as f:
            self._send(200, f.read(), ctype or "application/octet-stream")

    def do_POST(self):
        # A report endpoint, so a HEADLESS browser can say what it managed to
        # do. Firefox has no way to hand back `window.__m1()`, and "the
        # screenshot looked fine" is not a measurement.
        if self.path.split("?")[0] != "/api/report":
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, OSError) as e:
            payload = {"parse_error": str(e)}
        REPORTS.append(payload)
        print("REPORT " + json.dumps(payload), flush=True)
        self._send(200, b"{}", "application/json", {"Access-Control-Allow-Origin": "*"})

    do_HEAD = do_GET

    def log_message(self, *_):
        pass  # a gauge polled every 2s must not write a line every 2s


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"rrabbit bridge: {READER.name} reader on 127.0.0.1:{port}", flush=True)
    print(f"  shell: {'serving ' + DIST if os.path.isdir(DIST) else 'NOT BUILT (npx vite build)'}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
