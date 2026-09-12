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
mod packages;
mod principal;

use principal::Bindings;
use serde_json::{json, Value};
use tauri::{Manager, State};

/// **A pane's label is `pane-<generation>` and is never reused.** It is
/// derived by the host in `Bindings::bind_pane`; no command in this file
/// takes a webview label from the page, so there is nothing to aim at another
/// surface.
///
/// It is not a constant any more, and the reason is `whoami`. That command
/// takes no echoed generation — it is what a caller uses to LEARN one — so
/// under a reusable label an instance that outlived its `close()` could call
/// it, resolve the name to whichever binding now holds it, and come back
/// carrying the successor's generation. `principal.rs`'s
/// `a_reused_label_would_hand_over_the_successors_generation` demonstrates
/// exactly that, on a label that is still reusable.
/// How long the pane may stay contained before the read pose is abandoned.
const POSE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// **What the coordinator holds between apps.**
///
/// The task in flight, which package is live, and the LEDGER — the record of
/// what the coordinator has *accepted*. ROAD_SHELL.md §5.1: an app's own
/// report that it produced something is not a transfer; only the
/// coordinator's acceptance is, and only the ledger may be read as one.
#[derive(Default)]
pub struct Coordinator(std::sync::Mutex<CoordState>);

#[derive(Default)]
struct CoordState {
    task: Option<Value>,
    live_package: Option<String>,
    ledger: Vec<Value>,
}

impl Coordinator {
    fn begin(&self, package: &str, task: Option<Value>) {
        let mut g = self.0.lock().unwrap();
        g.live_package = Some(package.to_string());
        g.task = task;
    }
    fn end(&self) {
        let mut g = self.0.lock().unwrap();
        g.live_package = None;
        g.task = None;
    }
    fn live_package(&self) -> Option<String> {
        self.0.lock().unwrap().live_package.clone()
    }
    fn task(&self) -> Option<Value> {
        self.0.lock().unwrap().task.clone()
    }
    fn accept(&self, from: &str, kind: &str, payload: Value) -> Value {
        let mut g = self.0.lock().unwrap();
        let seq = g.ledger.len() as u64 + 1;
        let record = json!({ "seq": seq, "from": from, "kind": kind, "payload": payload });
        g.ledger.push(record.clone());
        record
    }
    fn ledger(&self) -> Vec<Value> {
        self.0.lock().unwrap().ledger.clone()
    }
}

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
/// **`async`, and that is load-bearing rather than stylistic.**
///
/// A synchronous `#[tauri::command]` runs on the MAIN THREAD. This command
/// waits for GTK to allocate the pane, and on the main thread that wait
/// blocks the very layout pass it is waiting for: measured, the overlay sat
/// at GTK's never-allocated sentinel `(-1,-1,1,1)` inside a box that was
/// already 1000x653, for the full five-second deadline, every time.
/// `queue_resize` on the container did not help and could not — nothing was
/// going to run it.
///
/// The symptom is maximally misleading: `place` and `allocation` both
/// SUCCEED, because `with_webview` executes inline when it is already on the
/// main thread. So every instrument answers, and the only thing that never
/// happens is the layout. `super/cockpit` reached the same conclusion from
/// the other side — its `browser_surface` is `async` too.
#[tauri::command]
async fn road_promote(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    bindings: State<'_, Bindings>,
    coordinator: State<'_, Coordinator>,
    generation: u64,
    rect: Rect,
    package: String,
    task: Option<Value>,
) -> Result<Value, String> {
    let caller = match bindings.authorize(&webview, generation, "promote") {
        Err(r) => return refuse(r),
        Ok(p) => p,
    };
    // N = 1, measured against the REGISTRY rather than one known label: a
    // predecessor that outlived its close is exactly the condition an
    // instance-scoped binding defends against, so it must also be the
    // condition that refuses a promote.
    let live = bindings.live_panes();
    if !live.is_empty() || live.iter().any(|l| app.get_webview(l).is_some()) {
        return Err(format!(
            "TIER_ALREADY_LIVE: the live budget is N = 1 and {live:?} still hold bindings              (ROAD_SHELL.md §4.1)"
        ));
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

    // BIND FIRST, then grant, then create. A webview that exists without a
    // binding is a surface with no principal, and for the width of that gap
    // it could call a command that would find no binding and refuse for the
    // wrong reason.
    // The package is named from the catalogue the HOST holds; an id that is
    // not in it is refused. What the page cannot name is the LABEL — that is
    // still derived, and `tools/check-acl.mjs` asserts no command takes one.
    let pkg = packages::get(&package)?;
    let pane = bindings.bind_pane(&packages::grants_for(&pkg));
    let label = pane.surface.clone();

    // **The capability is minted for THIS INSTANCE.** A static
    // `capabilities/pane.json` cannot be, because it names a fixed label and
    // the whole point is that the label is never reused. `add_capability` is
    // tauri's `dynamic-acl` (default-on); the grant is the same three
    // permissions the static file held, aimed at one instance that will never
    // exist again.
    let mut cap = tauri::ipc::CapabilityBuilder::new(format!("pane-instance-{}", pane.generation))
        .webview(label.clone())
        .permission("allow-pane-beat")
        .permission("allow-pane-hello")
        .permission("allow-whoami");
    // The ACL layer mirrors the grant table rather than being generous: a
    // package that declares no `produces` cannot even reach `pane_offer`.
    if pkg.produces.is_some() {
        cap = cap.permission("allow-pane-offer");
    }
    app.add_capability(cap)
    .map_err(|e| {
        bindings.revoke(&label);
        format!("PANE_CAPABILITY_FAILED: {e}")
    })?;

    // Publish the task before creating a page that immediately calls hello.
    // Waiting until reveal races bootstrap and can hand it a null task.
    coordinator.begin(&pkg.id, task);
    let url = format!("{}?gen={}&pkg={}", pkg.entry, pane.generation, pkg.id);
    let child = window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::App(url.into()))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
            tauri::LogicalPosition::new(rect.x, rect.y),
            tauri::LogicalSize::new(rect.width, rect.height),
        )
        .map_err(|e| {
            bindings.revoke(&label);
            coordinator.end();
            e.to_string()
        })?;

    let abandon = |e: String| -> String {
        bindings.revoke(&label);
        coordinator.end();
        // The type is named rather than left to never-type fallback, which
        // rustc now warns about: `close()` is best-effort here BECAUSE
        // revocation already happened and does not depend on it (§6.2 #4).
        let _: tauri::Result<()> = child.close();
        e
    };

    // **The read pose is not optional and not cosmetic.** Without this the
    // child takes the whole window and the ROAD collapses to one pixel —
    // measured, ROAD_SHELL.md §10.6. `place` leaves the pane laid out but at
    // opacity 0 and insensitive, so it is neither visible nor interactive
    // while it is the wrong size.
    if let Err(e) = layout::place(&child, &rect) {
        return Err(abandon(format!("READ_POSE_FAILED: {e}")));
    }

    // **Contained until correct, then revealed atomically.** Measured before
    // this loop existed: the pane was created box-packed at full window size
    // and stayed that way ~2.8 s — eventual geometry right, containment
    // wrong, an untrusted surface covering the road and taking input over all
    // of it. §10.6.3. A pose that never arrives ABANDONS the promote; it is
    // never shown late and never shown wrong.
    let started = std::time::Instant::now();
    let want = (rect.width.round() as i64, rect.height.round() as i64);
    loop {
        let a = layout::allocation(&child);
        let got = (
            a.pointer("/allocated/w").and_then(|v| v.as_i64()).unwrap_or(-1),
            a.pointer("/allocated/h").and_then(|v| v.as_i64()).unwrap_or(-1),
        );
        if (got.0 - want.0).abs() <= 2 && (got.1 - want.1).abs() <= 2 {
            break;
        }
        if started.elapsed() > POSE_DEADLINE {
            return Err(abandon(format!(
                "READ_POSE_NOT_REACHED: wanted {want:?}, last allocation {got:?} after {:?}; \
                 widget says {a}",
                started.elapsed()
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let pose_ms = started.elapsed().as_millis() as u64;
    if let Err(e) = layout::reveal(&child) {
        return Err(abandon(format!("READ_POSE_REVEAL_FAILED: {e}")));
    }

    Ok(json!({
        "pose_ms": pose_ms,
        "package": pkg.id,
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
    coordinator: State<Coordinator>,
    generation: u64,
) -> Result<Value, String> {
    let caller = match bindings.authorize(&webview, generation, "demote") {
        Err(r) => return refuse(r),
        Ok(p) => p,
    };
    // **Revoke first, destroy second, and revoke whether or not the close
    // succeeds.** §6.2 #4 is about the binding, not the pixels: a renderer
    // that outlives its close must already be powerless by the time it could
    // notice. The host cannot detect that renderer at all (§10.1), which is
    // why the ordering is the defence rather than the close.
    let mut closed = vec![];
    for label in bindings.live_panes() {
        bindings.revoke(&label);
        if let Some(w) = app.get_webview(&label) {
            closed.push(json!({ "label": label, "closed": w.close().is_ok() }));
        } else {
            closed.push(json!({ "label": label, "closed": false, "already_gone": true }));
        }
    }
    // EVICTION ends the coordinator's hold on the task as well as the pane's
    // binding. A task that outlived the app it was handed to would be a
    // handoff nobody is doing.
    coordinator.end();
    Ok(json!({ "tier": "sign", "closed": closed, "by_principal": caller }))
}

#[tauri::command]
fn road_status(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    bindings: State<Bindings>,
    coordinator: State<Coordinator>,
    generation: u64,
) -> Result<Value, String> {
    if let Err(r) = bindings.authorize(&webview, generation, "status") {
        return refuse(r);
    }
    // The POSITIVE FACT. `liveness` may only say `gone` on this, never on a
    // clock — §10.1.
    let pane_label = bindings.live_panes().into_iter().next();
    let pane_label2 = pane_label.clone();
    let pane_label3 = pane_label.clone();
    let pane_label4 = pane_label.clone();
    let present = pane_label.as_deref().is_some_and(|l| app.get_webview(l).is_some());
    Ok(json!({
        "tier": if present { "live" } else { "sign" },
        "present": present,
        "liveness": bindings.liveness(pane_label3.as_deref().unwrap_or("pane-none"), present),
        "pane_generation": pane_label4.as_deref().and_then(|l| bindings.generation_of(l)),
        // The platform's own account of the read pose. Read HERE and not in
        // `promote`, where it reported 1x1 at (-1,-1) every time: the call is
        // synchronous and GTK had not re-allocated yet. An instrument that
        // always answers before the thing it measures is not an instrument.
        "pane_label": pane_label,
        "live_package": coordinator.live_package(),
        "task": coordinator.task(),
        // THE ONLY THING THAT SAYS A HANDOFF HAPPENED. §5.1 — an app's report
        // that it produced something is not a transfer; the coordinator's
        // acceptance is, and it lives here.
        "ledger": coordinator.ledger(),
        "read_pose": pane_label2.and_then(|l| app.get_webview(&l)).map(|w| layout::allocation(&w)),
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
    if let Err(r) = bindings.authorize(&webview, generation, "manifest") {
        return refuse(r);
    }
    // THE WHOLE CATALOGUE, and nothing is started to produce it. §5: a road
    // can be laid out and sealed before any app is live, which is only true
    // if every sign on it is readable with zero panes in existence.
    let c = packages::catalogue()?;
    Ok(json!({
        "packages": c.iter().map(|p| json!({
            "id": p.id, "accepts": p.accepts, "produces": p.produces, "sign": p.sign,
        })).collect::<Vec<_>>(),
    }))
}

/// **Routing is the coordinator's and reads DECLARED acceptance** — not an
/// app's reported availability, which has an expiry (§5.1), and not the app's
/// own opinion. A kind nothing accepts is refused by name.
#[tauri::command]
fn road_route(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    generation: u64,
    kind: String,
) -> Result<Value, String> {
    if let Err(r) = bindings.authorize(&webview, generation, "manifest") {
        return refuse(r);
    }
    let p = packages::route(&kind)?;
    Ok(json!({ "kind": kind, "package": p.id, "produces": p.produces }))
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

/// **The pane offers a result; the COORDINATOR decides it was accepted.**
///
/// The pane's return value is an acceptance RECORD, not its own claim: what a
/// road may render as "transferred" is the ledger entry, and the ledger is
/// written here. §5.1, and §10.9 — an op that reports success at every layer
/// and produces nothing is the failure shape that takes longest to find.
///
/// The offered kind is checked against the package's DECLARED `produces`, so
/// an app cannot widen what it hands on past what its manifest says. And a
/// terminal package never reaches this command at all: it holds no `offer`
/// grant and its instance capability does not carry the permission.
#[tauri::command]
fn pane_offer(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    coordinator: State<Coordinator>,
    generation: u64,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    if let Err(r) = bindings.authorize(&webview, generation, "offer") {
        return refuse(r);
    }
    let id = coordinator.live_package().ok_or("NO_LIVE_PACKAGE: nothing is standing here")?;
    let pkg = packages::get(&id)?;
    match pkg.produces.as_deref() {
        Some(k) if k == kind => Ok(json!({ "accepted": coordinator.accept(&id, &kind, payload) })),
        Some(k) => Err(format!("OFFER_NOT_DECLARED: {id:?} produces {k:?}, offered {kind:?}")),
        None => Err(format!("OFFER_NOT_DECLARED: {id:?} declares no produces")),
    }
}

/// The pane asking the host who it is. It cannot assert an answer — the host
/// derives it — which is what makes the readout in the pane trustworthy.
#[tauri::command]
fn pane_hello(
    webview: tauri::Webview,
    bindings: State<Bindings>,
    coordinator: State<Coordinator>,
    generation: u64,
) -> Result<Value, String> {
    match bindings.authorize(&webview, generation, "hello") {
        Err(r) => refuse(r),
        // The task is HANDED to the pane by the host, not fetched by it: the
        // pane never names a task and cannot ask for another app's.
        Ok(p) => {
            let id = coordinator.live_package();
            let produces = id.as_deref().and_then(|i| packages::get(i).ok()).and_then(|k| k.produces);
            Ok(json!({ "principal": p, "package": id, "produces": produces,
                       "task": coordinator.task() }))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Bindings::default())
        .manage(Coordinator::default())
        .invoke_handler(tauri::generate_handler![
            road_place,
            road_promote,
            road_demote,
            road_status,
            road_manifest,
            road_route,
            whoami,
            privileged_intent,
            pane_beat,
            pane_hello,
            pane_offer,
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
