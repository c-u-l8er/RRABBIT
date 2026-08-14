# What the image offers, and the two things that had to be fixed to offer it

`applications.image.json` is the program list a **built** shell ships — see
`vite.config.ts`. `applications.json` beside it is the developer's runtime list
and must never be shipped: it names programs that exist on a workstation, and one
entry carries an absolute path to an ssh key in a home directory. The build fails
on a `/home/` path for exactly that reason.

JSON has no comments, so the reasoning lives here.

| row | executable | needs |
|---|---|---|
| Terminal | `foot` | nothing — Wayland-native, in the base image |
| Notes | `mousepad` | `mousepad` (2.2 MiB, GTK3) **and the MIME cache** |
| Firefox | `firefox` | already in the image **and the MIME cache** |
| XTerm | `xterm` | the `xwayland` package |

All four verified: `201`, process alive, `New Wayland client`, zero aborts.

## XTerm needed Xwayland, and the error looks like a typo

```
exec of 'XWayland :1 -ac -rootless -listen 8 -displayfd 112 -wm 10 ' failed:
No such file or directory
```

That capital `W` is greenfield's *error string*; `westfield-xwayland.c` correctly
`execlp`s `Xwayland`. The binary was simply absent — `xorg-minimal` does not pull
it in. Added to `tandr-desktop.conf`.

## Every GTK app aborted, and it was one missing cache file

`mousepad` died with SIGABRT and `firefox` with SIGSEGV, both inside 200 ms:

```
Gtk:ERROR:../gtk/gtkiconhelper.c:495: assertion failed (error == NULL):
Failed to load .../image-missing.svg: Unrecognized image file format
Bail out!
```

It presents as a **broken gdk-pixbuf**, and convincingly. All of this was true
and all of it was a red herring:

- a valid 409-byte PNG failed too, so it was never about SVG;
- `truss` showed the library open `loaders.cache` and then **dlopen no loader at
  all**, and never even open the image file;
- the library exports **zero** builtin loader symbols;
- `GDK_PIXBUF_MODULE_FILE` was ignored — same error for a valid cache, a minimal
  cache and a nonexistent path;
- `gtk3-demo` aborted identically on a plain X session, so it was the image and
  not the road;
- `gdk-pixbuf2-2.44.1` was the only version in the repo, already current, and a
  forced reinstall changed nothing.

**The cause was `/usr/local/share/mime/mime.cache` not existing.**
`update-mime-database` had never run, so GTK's own warning — "pixbuf loaders **or
the mime database** could not be found" — was accurate on its second clause while
every measurement pointed at the first. One command fixed it:

```
update-mime-database /usr/local/share/mime
```

The image build had this bug already documented one cache over: `build-image.sh`
builds a fontconfig cache on first boot because *"pkg's post-install scripts do
not reliably build a fontconfig cache when installing into a staged root with
`pkg -r`"*. Same mechanism, and the note treated it purely as a speed problem.
The firstboot service now builds the MIME database, the pixbuf loader cache and
the icon caches as well.

Retest — no compositor required, and it fails loudly when it is wrong:

```
gdk-pixbuf-thumbnailer /usr/local/share/icons/Adwaita/16x16/devices/audio-headphones.png /tmp/t.png
```

## Why a broken row is worse than a missing one

The shell sets `proxyUp = false` on the **first** failed launch and then refuses
every other row. One aborting entry takes the working ones down with it — which
is why "Notes doesn't work" presented as *nothing* working.
