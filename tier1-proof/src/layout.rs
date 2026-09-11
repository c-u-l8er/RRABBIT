//! **The read pose on screen.** ROAD_SHELL.md §10.6.
//!
//! MEASURED ON LINUX before this file existed (`tools/geometry-probe.mjs`,
//! WebKitGTK, dpr 2):
//!
//! ```text
//!   requested read rect        522 x 262 at (315, 93)
//!   road BEFORE promote       1000 x 653
//!   pane  AFTER promote       1000 x 653   <- the requested rect ignored
//!   road  AFTER promote       1000 x   1   <- the road stopped having a surface
//! ```
//!
//! Tauri packs a window's webviews into a vertical `GtkBox`, so `add_child`
//! does not put the child anywhere in particular — it gives it a box cell, and
//! the parent gets what is left. `set_position`/`set_size` on the child do not
//! reach into that layout.
//!
//! The repair, ported from `super/cockpit/src/preview.rs`: move the ROAD into
//! a `GtkOverlay` once, then add every pane as an overlay child positioned by
//! margins. The road keeps its own surface at full size; the pane floats over
//! it at the requested rect. **The IPC label is untouched**, which matters —
//! the capability and the binding are both keyed on it, and a re-parent that
//! renamed the widget would silently move the pane outside its own grant.
//!
//! On every other platform a child webview is an ordinary subview and the
//! plain setters are the whole implementation. That divergence is exactly the
//! §11 hypothesis, and `tools/geometry-probe.mjs` is what settles it there.

use crate::Rect;

// The read pose, in GTK units, for the overlay's position callback.
//
// **Margins cannot carry the position.** The first version returned
// `(margin_start, margin_top, size_request)` from `get-child-position`, and
// GTK then applied the widget's margins INSIDE that allocation — so the pane
// came out at `size_request - margin` in each axis. Measured exactly:
// requested 522x262 at (315, 93), got **207x169**, and 522-315 = 207,
// 262-93 = 169. The subtraction is the whole defect and the numbers name it.
//
// So the position lives in the returned rectangle and the margins are zero.
// A thread-local is the right shape rather than a shortcut: `place` and the
// callback both run on the GTK main thread, and the live budget is N = 1
// (ROAD_SHELL.md §4.1), so there is exactly one read pose to hold.
#[cfg(target_os = "linux")]
thread_local! {
    static READ_POSE: std::cell::Cell<(i32, i32, i32, i32)> =
        const { std::cell::Cell::new((0, 0, 1, 1)) };
}

#[cfg(target_os = "linux")]
pub fn place(view: &tauri::Webview, r: &Rect) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let (x, y, width, height) = (
        r.x.round() as i32,
        r.y.round() as i32,
        r.width.round() as i32,
        r.height.round() as i32,
    );
    view.with_webview(move |platform| {
        use gtk::prelude::*;
        let result = (|| {
            let widget: gtk::Widget = platform.inner().clone().upcast();
            let parent = widget.parent().ok_or("the pane has no native parent")?;
            if let Ok(container) = parent.clone().downcast::<gtk::Box>() {
                let overlay = if let Some(existing) = container
                    .children()
                    .into_iter()
                    .find(|w| w.widget_name() == "tier1-road-overlay")
                {
                    existing
                        .downcast::<gtk::Overlay>()
                        .map_err(|_| "the road overlay is unavailable")?
                } else {
                    // The road is the OTHER WebKitWebView in the box. Found by
                    // type rather than by index: the box's ordering is tauri's
                    // to change and an index would break silently.
                    let road = container
                        .children()
                        .into_iter()
                        .find(|w| w != &widget && w.type_().name() == "WebKitWebView")
                        .ok_or("the road widget is unavailable")?;
                    let overlay = gtk::Overlay::new();
                    overlay.set_widget_name("tier1-road-overlay");
                    // **The overlay is TOLD the rect; it is not asked to infer
                    // one.** `set_size_request` is a MINIMUM and a
                    // WebKitWebView's natural size exceeds it, so alignment
                    // plus margins gave a pane running from its margin to the
                    // far edge — measured twice: requested 522x262 at
                    // (315, 93), allocated 685x560 = (1000-315) by (653-93),
                    // and turning `hexpand`/`vexpand` off did not change it.
                    // `get-child-position` is the only place in GTK3 that
                    // states an overlay child's allocation outright, so the
                    // read pose is expressed there, read back off the margins
                    // and size request the caller set.
                    overlay.connect_get_child_position(|_, _widget| {
                        let (x, y, w, h) = READ_POSE.with(|p| p.get());
                        Some(gtk::Allocation::new(x, y, w.max(1), h.max(1)))
                    });
                    overlay.set_hexpand(true);
                    overlay.set_vexpand(true);
                    container.remove(&road);
                    overlay.add(&road);
                    container.pack_start(&overlay, true, true, 0);
                    // The road is the overlay's CHILD, so it fills the overlay
                    // and stops competing with the pane for a box cell. The
                    // 1x1 request is a floor, not a size — `hexpand`/`vexpand`
                    // on the overlay is what actually gives it the window.
                    road.set_size_request(1, 1);
                    road.show();
                    overlay.show_all();
                    // **Ask for the layout explicitly.** Packing a new child
                    // into a realized box did NOT produce a size-allocate on
                    // its own here: measured, the overlay sat at GTK's
                    // never-allocated sentinel (-1,-1,1,1) inside a box that
                    // was 1000x653, for as long as anything waited. The
                    // container is what has to re-run, not the pane.
                    container.queue_resize();
                    overlay.queue_resize();
                    overlay
                };
                // Geometry BEFORE attachment: `get-child-position` runs during
                // `add_overlay`, and a request set afterwards is a second
                // allocation that may or may not come.
                READ_POSE.with(|p| p.set((x, y, width, height)));
                widget.set_hexpand(false);
                widget.set_vexpand(false);
                widget.set_halign(gtk::Align::Start);
                widget.set_valign(gtk::Align::Start);
                widget.set_size_request(width, height);
                container.remove(&widget);
                overlay.add_overlay(&widget);
                // `false` = the pane RECEIVES input. A pass-through overlay
                // would render the pane and send its clicks to the road
                // underneath, which is assertion 3 failing in the one way a
                // screenshot could never show.
                overlay.set_overlay_pass_through(&widget, false);
            } else if parent.downcast::<gtk::Overlay>().is_err() {
                return Err("the pane's container is unsupported");
            }
            READ_POSE.with(|p| p.set((x, y, width, height)));
            widget.set_size_request(width, height);
            // **CONTAINED, NOT HIDDEN.** A `gtk::Widget` that has never been
            // shown is not laid out at all, so hiding it would mean waiting
            // for an allocation that can never arrive. Opacity 0 plus
            // insensitive is laid out, invisible, and takes no input — which
            // is the actual requirement. `reveal` is the only thing that
            // undoes either, and it does both at once.
            widget.set_opacity(0.0);
            widget.set_sensitive(false);
            widget.show();
            widget.queue_resize();
            if let Some(p) = widget.parent() {
                p.queue_resize();
            }
            Ok(())
        })()
        .map_err(str::to_owned);
        let _ = send.send(result);
    })
    .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "the read pose layout did not finish".to_owned())?
}

#[cfg(not(target_os = "linux"))]
pub fn place(view: &tauri::Webview, r: &Rect) -> Result<(), String> {
    view.set_position(tauri::LogicalPosition::new(r.x, r.y))
        .map_err(|e| e.to_string())?;
    view.set_size(tauri::LogicalSize::new(r.width, r.height))
        .map_err(|e| e.to_string())
}

/// Make the pane visible and interactive, in one step, once its allocation is
/// the read pose. **The only place either is undone.**
///
/// Measured before this existed: the pane was created box-packed at full
/// window size and stayed that way for ~2.8 s before GTK re-allocated it. The
/// eventual geometry was right and the containment was not — an untrusted
/// pane covered the whole road, and took input over all of it, for most of
/// three seconds. ROAD_SHELL.md §10.6.3.
#[cfg(target_os = "linux")]
pub fn reveal(view: &tauri::Webview) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| {
        use gtk::prelude::*;
        let w: gtk::Widget = platform.inner().clone().upcast();
        w.set_opacity(1.0);
        w.set_sensitive(true);
        let _ = send.send(());
    })
    .map_err(|e| e.to_string())?;
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "the pane could not be revealed".to_owned())
}

#[cfg(not(target_os = "linux"))]
pub fn reveal(view: &tauri::Webview) -> Result<(), String> {
    view.show().map_err(|e| e.to_string())
}

/// What the platform ACTUALLY gave the pane. An instrument, not a control.
///
/// Two rounds of the read-pose defect were spent inferring the allocation from
/// the page's `innerWidth`, which is the wrong side of the boundary and is
/// scaled. `PAPER_ROADS.md` DOCTRINE, again: a fact that is recorded but not
/// readable is not an instrument.
#[cfg(target_os = "linux")]
pub fn allocation(view: &tauri::Webview) -> serde_json::Value {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let _ = view.with_webview(move |platform| {
        use gtk::prelude::*;
        let w: gtk::Widget = platform.inner().clone().upcast();
        let a = w.allocation();
        let (rw, rh) = w.size_request();
        // The chain from the pane up to the toplevel, with each step's type,
        // allocation and child count. Two rounds were spent reasoning about a
        // hierarchy nobody had looked at.
        let mut chain = vec![];
        let mut node = Some(w.clone());
        while let Some(n) = node {
            let a = n.allocation();
            let kids = n.clone().downcast::<gtk::Container>().ok().map(|c| c.children().len());
            chain.push(serde_json::json!({
                "type": n.type_().name().to_string(),
                "w": a.width(), "h": a.height(), "x": a.x(), "y": a.y(),
                "children": kids,
                "hexpand": n.hexpands(), "vexpand": n.vexpands(),
                "name": n.widget_name().to_string(),
            }));
            node = n.parent();
        }
        let parent_alloc = serde_json::Value::Array(chain);
        let _ = send.send(serde_json::json!({
            "alloc": { "x": a.x(), "y": a.y(), "w": a.width(), "h": a.height() },
            "size_request": { "w": rw, "h": rh },
            "margins": { "start": w.margin_start(), "top": w.margin_top() },
            "scale_factor": w.scale_factor(),
            // Containment is a function of BOTH, and a sample that reports
            // only geometry cannot answer "was it ever visible outside its
            // rectangle?" — which is the question §10.6.3 exists for.
            "opacity": w.opacity(),
            "sensitive": w.is_sensitive(),
            "visible": w.is_visible() && w.opacity() > 0.0,
            "allocated": { "w": w.allocated_width(), "h": w.allocated_height() },
            "realized": w.is_realized(),
            "mapped": w.is_mapped(),
            "parent": parent_alloc,
        }));
    });
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or(serde_json::json!(null))
}

#[cfg(not(target_os = "linux"))]
pub fn allocation(_view: &tauri::Webview) -> serde_json::Value {
    serde_json::json!(null)
}
