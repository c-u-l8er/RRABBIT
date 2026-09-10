//! **The Tier 1 road-shell proof.** `docs/ROAD_SHELL.md` §12 — one road, one
//! pane, one transition:
//!
//! ```text
//! published sign -> read pose -> LIVE pane -> leave read pose -> published sign
//!                                    |
//!                            state preserved
//!                        stale messages rejected
//! ```
//!
//! **What this harness is NOT.** It is not the road. There is no three.js
//! scene, no dashes on a curve, no LOD atlas — the road here is DOM, because
//! what is under test is the TRANSITION and the AUTHORITY BOUNDARY, not the
//! rendering. Saying so plainly is the point: a harness that also had to be
//! the road would prove neither thing first.
//!
//! **Why it is standalone rather than a branch of `super/cockpit`.** §13 #1 —
//! whether the road becomes `main` and demotes the cockpit — is unruled.
//! Re-rooting the cockpit to run this proof would answer it by accident, which
//! is the front-door inheritance §6 warns about.
//!
//! **The two seams (§6.2.1).** `apply(op)` in the road's page is the VOCABULARY
//! seam: closed table, validation, logging, refusal feedback. It enforces
//! nothing against its own page and this file does not pretend otherwise.
//! Every privileged effect is a command HERE, and the check runs before the
//! effect, on a principal the page cannot supply.

mod layout;
mod manifest;
mod principal;

use principal::Bindings;
use serde_json::{json, Value};
use tauri::{Manager, State};

/// The pane's label. A CONSTANT, not a parameter — no command in this file
/// takes a webview label from the page, so there is nothing to aim at another
/// surface. Same discipline as the cockpit's `TERMINAL_LABEL`.
const PANE: &str = "pane";
const PANE_PAGE: &str = "pane.html";

#[derive(serde::Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn refuse<T>(r: principal::Refusal) -> Result<T, String> {
    Err(r.to_string())
}

/* ── the road's own ops ──────────────────────────────────────────────────── */

/// Placement. The ALLOWED half of assertion 9 — this must succeed, or 9b
/// proves only that nothing works.
#[tauri::command]
fn road_place(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
    dash: u32,
    side: i32,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "place") {
        Err(r) => refuse(r),
        Ok(p) => Ok(json!({
            "placed": { "dash": dash, "side": side },
            "by_principal": p,
        })),
    }
}

/// Promote to the live tier: the child webview is created HERE, and the host
/// binds it in the same breath. The page never learns a secret and never
/// supplies one — it is told the new generation only so it can carry it back
/// for the staleness check.
#[tauri::command]
fn road_promote(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    bindings: State<Bindings>,
    generation: u64,
    rect: Rect,
) -> Result<Value, String> {
    let caller = match bindings.authorize(&webview, generation, "promote") {
        Err(r) => return refuse(r),
        Ok(p) => p,
    };
    if app.get_webview(PANE).is_some() {
        return Err("TIER_ALREADY_LIVE: the live budget is N = 1 (ROAD_SHELL.md §4.1)".into());
    }
    let window = app.get_window("main").ok_or("no road window")?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if ![rect.x, rect.y, rect.width, rect.height].iter().all(|n| n.is_finite())
        || rect.x < 0.
        || rect.y < 0.
        || rect.width < 40.
        || rect.height < 40.
        || rect.x + rect.width > size.width as f64 / scale + 1.
        || rect.y + rect.height > size.height as f64 / scale + 1.
    {
        return Err("BAD_READ_RECT: the read pose does not fit the window".into());
    }

    // BIND FIRST, then create. A webview that exists without a binding is a
    // surface with no principal, and for the width of that gap it could call
    // a command that would find no binding and refuse for the wrong reason.
    let pane = bindings.bind(PANE);
    let url = format!("{PANE_PAGE}?gen={}", pane.generation);
    let child = window
        .add_child(
            tauri::webview::WebviewBuilder::new(PANE, tauri::WebviewUrl::App(url.into()))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
            tauri::LogicalPosition::new(rect.x, rect.y),
            tauri::LogicalSize::new(rect.width, rect.height),
        )
        .map_err(|e| {
            bindings.revoke(PANE);
            e.to_string()
        })?;

    // **The read pose is not optional and not cosmetic.** Without this the
    // child takes the whole window and the ROAD collapses to one pixel —
    // measured, ROAD_SHELL.md §10.6. A promote that leaves the road with no
    // surface has not entered the read pose, so a layout failure UNDOES the
    // promote rather than being reported beside it.
    if let Err(e) = layout::place(&child, &rect) {
        bindings.revoke(PANE);
        let _ = child.close();
        return Err(format!("READ_POSE_FAILED: {e}"));
    }
    Ok(json!({
        "tier": "live", "pane": pane, "by_principal": caller,
        // What GTK ACTUALLY allocated, not what was asked for. Two rounds of
        // this defect were spent inferring the allocation from the page's
        // innerWidth; a fact the host can read and does not report is not an
        // instrument.
        "requested": { "x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height },
    }))
}

/// Demote. **Revocation happens whether or not the close succeeds** — a
/// binding whose surface may or may not still exist must not keep authorizing,
/// and §6.2 consequence 4 is about the binding, not about the pixels.
#[tauri::command]
fn road_demote(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    bindings: State<Bindings>,
    generation: u64,
) -> Result<Value, String> {
    let caller = match bindings.authorize(&webview, generation, "demote") {
        Err(r) => return refuse(r),
        Ok(p) => p,
    };
    bindings.revoke(PANE);
    let closed = match app.get_webview(PANE) {
        Some(w) => w.close().is_ok(),
        None => false,
    };
    Ok(json!({ "tier": "sign", "closed": closed, "by_principal": caller }))
}

#[tauri::command]
fn road_status(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    bindings: State<Bindings>,
    generation: u64,
) -> Result<Value, String> {
    if let Err(r) = bindings.authorize(&webview, generation, "status") {
        return refuse(r);
    }
    // The POSITIVE FACT. `liveness` may only say `gone` on this, never on a
    // clock — §10.1.
    let present = app.get_webview(PANE).is_some();
    Ok(json!({
        "tier": if present { "live" } else { "sign" },
        "present": present,
        "liveness": bindings.liveness(PANE, present),
        "pane_generation": bindings.generation_of(PANE),
        // The platform's own account of the read pose. Read HERE and not in
        // `promote`, where it reported 1x1 at (-1,-1) every time: the call is
        // synchronous and GTK had not re-allocated yet. An instrument that
        // always answers before the thing it measures is not an instrument.
        "read_pose": app.get_webview(PANE).map(|w| layout::allocation(&w)),
        "last_refusal": bindings.last_refusal(),
        "refusal_count": bindings.refusal_count(),
        // Everything the host holds, so the battery can assert what is absent.
        "host_state": bindings.dump(),
    }))
}

/// **The privileged op — assertion 9b.**
///
/// Reachable from the road at the ACL layer ON PURPOSE (`capabilities/road.json`
/// says why), so that what refuses it is the principal check and not tauri's
/// resolver. `by` is accepted, echoed into the answer, and **never read by
/// `authorize`** — it is a log annotation (§6.2 consequence 1). Claiming
/// `by: "cockpit"` changes the record and changes nothing else.
#[tauri::command]
fn privileged_intent(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
    by: Option<String>,
    payload: Option<String>,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "intent") {
        Err(r) => Err(format!("{r} (claimed by={:?}, which is not consulted)", by)),
        Ok(p) => Ok(json!({ "accepted": payload, "by_annotation": by, "by_principal": p })),
    }
}

/// **Manifest discovery belongs to the coordinator, not to the app.**
///
/// The road used to `fetch('app.json')` from its own page, and §5's claim is
/// that a sign is *"renderable before any app is live"* — an app fetching its
/// own sign does not satisfy that, it only happens to work because the file
/// sits in the same bundle. The host owns discovery: it holds the package's
/// manifest and hands it over, and no pane need ever have existed.
///
/// A real coordinator reads an installed package here. This harness embeds
/// one, which is the same ownership with a smaller filesystem.
#[tauri::command]
fn road_manifest(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "manifest") {
        Err(r) => refuse(r),
        Ok(_) => manifest::published(),
    }
}

/// **The bootstrap. The page asks who it is; it is never told in advance.**
///
/// The first version injected the road's generation with `Webview::eval` in
/// `setup`, and that RACES the page's own first script: the road issued its
/// opening op with `generation: undefined`, was refused, and never finished
/// loading — a blank surface with a working host behind it. Cost one confused
/// diagnosis.
///
/// Asking is also the better shape, and it falls out of §6.2 rather than
/// working around it: the host resolves identity from the injected webview on
/// every call regardless, so there was never anything for the page to be told.
/// **Pull, not push.**
///
/// It takes no generation — it is what a caller uses to learn one — and it
/// requires no grant beyond having a binding at all. A surface learns its OWN
/// principal and cannot name another: `webview` is injected, so there is no
/// argument to aim elsewhere.
#[tauri::command]
fn whoami(webview: tauri::Webview, bindings: State<Bindings>) -> Result<Value, String> {
    match bindings.resolve(&webview) {
        None => Err("PRINCIPAL_NO_BINDING: this surface has no binding".into()),
        Some(p) => Ok(json!({ "principal": p })),
    }
}

/* ── the pane's own ops ──────────────────────────────────────────────────── */

#[tauri::command]
fn pane_beat(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "beat") {
        Err(r) => refuse(r),
        Ok(p) => {
            bindings.beat(webview.label());
            Ok(json!({ "beat": true, "generation": p.generation }))
        }
    }
}

/// The pane asking the host who it is. It cannot assert an answer — the host
/// derives it — which is what makes the readout in the pane trustworthy.
#[tauri::command]
fn pane_hello(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "hello") {
        Err(r) => refuse(r),
        Ok(p) => Ok(json!({ "principal": p })),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Bindings::default())
        .invoke_handler(tauri::generate_handler![
            road_place,
            road_promote,
            road_demote,
            road_status,
            road_manifest,
            whoami,
            privileged_intent,
            pane_beat,
            pane_hello,
        ])
        .setup(|app| {
            // The road's binding is minted by the HOST at startup. There is no
            // command that could have produced it, and the page is not told:
            // it calls `whoami`. See that command for why pushing raced.
            app.state::<Bindings>().bind("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the tier1 proof failed to start");
}
