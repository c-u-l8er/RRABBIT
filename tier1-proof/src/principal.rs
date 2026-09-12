//! The principal — `docs/ROAD_SHELL.md` §6.2, ruled by Travis 2026-09-10.
//!
//! > The principal is a host-owned identity for a specific pane binding, with
//! > explicitly assigned grants. The host derives it from the actual invoking
//! > webview and its current binding generation. The page cannot supply or
//! > override either identity or grants.
//!
//! Everything in this file is host-side and there is **no command that mints a
//! binding**. A binding comes into existence only where the host itself
//! creates a webview (`bind`), and dies where the host destroys or replaces
//! one (`revoke`). That is what makes the identity underivable from the page:
//! there is no argument a page could pass to obtain one.
//!
//! `by` DOES NOT APPEAR IN THIS FILE. It is a log annotation carried on the
//! op record and it never reaches a decision here — §6.2 consequence 1. The
//! grep that proves it is in `tools/proof-battery.mjs`.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long without a beat before a pane reads `unresponsive`.
///
/// **`unresponsive` is not `gone`.** §10.1: sleep, throttling and a busy main
/// thread all resemble death, so a timeout may only ever produce the softer
/// word. `gone` is returned by `liveness` on a POSITIVE fact — the webview is
/// absent from the runtime, or its binding was revoked — never by this clock.
const BEAT_TIMEOUT: Duration = Duration::from_millis(1_500);

/// The grant table. **Host-side, explicit, and not derived from anything the
/// page controls.**
///
/// A label is used here to look up which surface the HOST is binding, at the
/// moment the HOST creates it. That is not a label conferring authority
/// (§6.2 consequence 2) — a page cannot cause a binding to exist, so it
/// cannot claim a label to obtain one.
///
/// `cockpit` is listed WITHOUT a webview existing in this harness on purpose:
/// it makes the refusal in `privileged_intent` read *"the road does not hold
/// `intent`"* rather than *"nobody holds `intent`"*, which are different
/// facts and only the first one is the boundary under test.
fn grants_for(surface: &str) -> BTreeSet<String> {
    let v: &[&str] = match surface {
        "main" => &["place", "promote", "demote", "status", "manifest", "fullscreen"],
        // A pane's grants do NOT come from here: they come from its package's
        // declared manifest, through `bind_pane`. This arm exists so that a
        // pane label bound by the plain `bind` path — which no production
        // caller uses — is powerless rather than accidentally privileged.
        s if s.starts_with("pane-") => &[],
        "cockpit" => &["intent"],
        _ => &[],
    };
    v.iter().map(|s| (*s).to_string()).collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Principal {
    pub binding: u64,
    pub surface: String,
    pub generation: u64,
    pub grants: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
}

impl Refusal {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

#[derive(Debug)]
struct Binding {
    id: u64,
    generation: u64,
    grants: BTreeSet<String>,
    last_beat: Option<Instant>,
    revoked: bool,
}

#[derive(Default)]
struct Inner {
    by_surface: HashMap<String, Binding>,
    next_id: u64,
    next_generation: u64,
    /// Refusals, newest last, so the road can display what the host refused
    /// and the battery can assert on it. A refusal the page never sees is a
    /// refusal nobody can test.
    refusals: Vec<(String, Refusal)>,
}

#[derive(Default)]
pub struct Bindings(Mutex<Inner>);

impl Bindings {
    /// Host-only. Called where the host creates a webview, never from a
    /// command. Replacing a binding **revokes the old generation implicitly**
    /// by advancing to a new one — §6.2 consequence 4.
    pub fn bind(&self, surface: &str) -> Principal {
        let grants: Vec<&str> = grants_for(surface).iter().map(|s| s.as_str()).collect::<Vec<_>>()
            .into_iter()
            .map(|s| Box::leak(s.to_string().into_boxed_str()) as &'static str)
            .collect();
        self.bind_with(surface, &grants)
    }

    /// **Grants are supplied by the host at bind time, from whatever the host
    /// knows about this surface** — for a pane that is its PACKAGE's declared
    /// manifest (`packages::grants_for`), so a terminal app that produces
    /// nothing is never granted `offer`. The request has no say either way.
    pub fn bind_with(&self, surface: &str, grants: &[&str]) -> Principal {
        let grants: BTreeSet<String> = grants.iter().map(|s| (*s).to_string()).collect();
        let mut g = self.0.lock().unwrap();
        g.next_id += 1;
        g.next_generation += 1;
        let (id, generation) = (g.next_id, g.next_generation);
        g.by_surface.insert(
            surface.to_string(),
            Binding { id, generation, grants: grants.clone(), last_beat: None, revoked: false },
        );
        Principal {
            binding: id,
            surface: surface.to_string(),
            generation,
            grants: grants.into_iter().collect(),
        }
    }

    /// Host-only. A revoked binding authorizes nothing, and its generation can
    /// never be reached again because generations only ever advance.
    pub fn revoke(&self, surface: &str) {
        let mut g = self.0.lock().unwrap();
        if let Some(b) = g.by_surface.get_mut(surface) {
            b.revoked = true;
            b.last_beat = None;
        }
    }

    /// Who is calling, with no grant required — the bootstrap `whoami` uses
    /// it. Takes the injected webview for the same reason `authorize` does:
    /// there must be no string a caller could substitute.
    pub fn resolve(&self, webview: &tauri::Webview) -> Option<Principal> {
        self.resolve_label(webview.label())
    }

    /// The label form is **private**, and that is the whole arrangement: the
    /// public surface takes a `Webview` so no caller can substitute a string,
    /// while the invariants stay unit-testable without a renderer. The tests
    /// at the bottom of this file are the only other caller.
    fn resolve_label(&self, label: &str) -> Option<Principal> {
        let g = self.0.lock().unwrap();
        g.by_surface.get(label).filter(|b| !b.revoked).map(|b| Principal {
            binding: b.id,
            surface: label.to_string(),
            generation: b.generation,
            grants: b.grants.iter().cloned().collect(),
        })
    }

    /// **The pane label IS the instance.** `pane-<generation>`, and
    /// generations only ever advance, so a label is never reused.
    ///
    /// Without this, `whoami` is a hole in generation invalidation: it takes
    /// no echoed generation — it is what a caller uses to LEARN one — so an
    /// instance that outlived its `close()` could call it, resolve the label
    /// `pane` to whatever binding currently holds that name, and come back
    /// carrying the SUCCESSOR's generation. It would stop being old. With the
    /// generation in the label, an old instance resolves its OWN revoked
    /// binding and is refused; there is no argument it could pass to reach
    /// the successor's, because it passes no argument at all.
    pub fn bind_pane(&self, grants: &[&str]) -> Principal {
        let label = {
            let g = self.0.lock().unwrap();
            format!("pane-{}", g.next_generation + 1)
        };
        self.bind_with(&label, grants)
    }

    /// Every pane instance this registry has ever bound and not revoked.
    /// `promote` refuses while any is live: the live budget is N = 1, and a
    /// surviving predecessor is exactly the condition `bind_pane` defends
    /// against.
    pub fn live_panes(&self) -> Vec<String> {
        let g = self.0.lock().unwrap();
        g.by_surface
            .iter()
            .filter(|(l, b)| l.starts_with("pane-") && !b.revoked)
            .map(|(l, _)| l.clone())
            .collect()
    }

    pub fn generation_of(&self, surface: &str) -> Option<u64> {
        let g = self.0.lock().unwrap();
        g.by_surface.get(surface).filter(|b| !b.revoked).map(|b| b.generation)
    }

    /// **The check. Before any side effect, every time.**
    ///
    /// **It takes the INJECTED `Webview`, not a label.** A `&str` parameter
    /// here would be a check you can satisfy by building its argument: any
    /// caller — including a careless one inside this crate — could pass a
    /// string the page chose. Taking the webview makes the surface
    /// underivable from the request, in the type system rather than by
    /// review. §6.2: a label identifies a surface and confers nothing.
    ///
    /// `echoed_generation` is the ONLY thing the request supplies, and it is
    /// never an identity: it is compared against the registry and can
    /// therefore only ever cause a REFUSAL, never an elevation. It is
    /// load-bearing anyway, because it is what makes a recorded op detectable
    /// as stale (§6.2 #5).
    ///
    /// Order is deliberate: existence, then revocation, then generation, then
    /// the grant. A stale generation from a revoked binding must report
    /// revocation rather than staleness — the caller is not merely late, its
    /// authority is gone.
    pub fn authorize(
        &self,
        webview: &tauri::Webview,
        echoed_generation: u64,
        grant: &str,
    ) -> Result<Principal, Refusal> {
        self.authorize_label(webview.label(), echoed_generation, grant)
    }

    fn authorize_label(
        &self,
        surface: &str,
        generation: u64,
        grant: &str,
    ) -> Result<Principal, Refusal> {
        let mut g = self.0.lock().unwrap();
        let refuse = |g: &mut Inner, r: Refusal| -> Result<Principal, Refusal> {
            g.refusals.push((surface.to_string(), r.clone()));
            if g.refusals.len() > 32 {
                g.refusals.remove(0);
            }
            Err(r)
        };

        let Some(b) = g.by_surface.get(surface) else {
            return refuse(
                &mut g,
                Refusal::new("PRINCIPAL_NO_BINDING", format!("no binding for surface {surface:?}")),
            );
        };
        let (id, gen_now, revoked, holds) =
            (b.id, b.generation, b.revoked, b.grants.contains(grant));
        let grants: Vec<String> = b.grants.iter().cloned().collect();

        if revoked {
            return refuse(
                &mut g,
                Refusal::new(
                    "PRINCIPAL_REVOKED",
                    format!("binding {id} for {surface:?} was revoked; generation {gen_now}"),
                ),
            );
        }
        if generation != gen_now {
            return refuse(
                &mut g,
                Refusal::new(
                    "PRINCIPAL_STALE_GENERATION",
                    format!("request carried generation {generation}, binding is at {gen_now}"),
                ),
            );
        }
        if !holds {
            return refuse(
                &mut g,
                Refusal::new(
                    "PRINCIPAL_GRANT_NOT_HELD",
                    format!("{surface:?} holds {grants:?}, which does not include {grant:?}"),
                ),
            );
        }
        Ok(Principal { binding: id, surface: surface.to_string(), generation: gen_now, grants })
    }

    pub fn beat(&self, surface: &str) {
        let mut g = self.0.lock().unwrap();
        if let Some(b) = g.by_surface.get_mut(surface) {
            if !b.revoked {
                b.last_beat = Some(Instant::now());
            }
        }
    }

    /// `present` is the POSITIVE FACT the caller measured — whether the
    /// runtime still has the webview. Only that, or revocation, produces
    /// `gone`. The clock can only ever produce `unresponsive`.
    pub fn liveness(&self, surface: &str, present: bool) -> &'static str {
        let g = self.0.lock().unwrap();
        match g.by_surface.get(surface) {
            None => "gone",
            Some(b) if b.revoked || !present => "gone",
            Some(b) => match b.last_beat {
                None => "unknown",
                Some(t) if t.elapsed() > BEAT_TIMEOUT => "unresponsive",
                Some(_) => "live",
            },
        }
    }

    /// Everything the host holds. Deliberately dumped whole so the battery can
    /// assert what is NOT in it — assertion 5 requires the app's state to
    /// survive without the shell holding a copy.
    pub fn dump(&self) -> serde_json::Value {
        let g = self.0.lock().unwrap();
        let bindings: Vec<serde_json::Value> = g
            .by_surface
            .iter()
            .map(|(surface, b)| {
                serde_json::json!({
                    "surface": surface,
                    "binding": b.id,
                    "generation": b.generation,
                    "grants": b.grants.iter().cloned().collect::<Vec<_>>(),
                    "revoked": b.revoked,
                    "has_beat": b.last_beat.is_some(),
                })
            })
            .collect();
        serde_json::json!({ "bindings": bindings })
    }

    pub fn last_refusal(&self) -> Option<serde_json::Value> {
        let g = self.0.lock().unwrap();
        g.refusals.last().map(|(surface, r)| {
            serde_json::json!({ "surface": surface, "code": r.code, "detail": r.detail })
        })
    }

    pub fn refusal_count(&self) -> usize {
        self.0.lock().unwrap().refusals.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The `whoami` revocation invariant, tested where it lives.**
    ///
    /// A renderer that outlives its `close()` cannot be summoned on demand —
    /// §10.1 says the host cannot even detect one — so the live battery can
    /// only assert this structurally. The registry owns the invariant, so the
    /// registry is where it is exercised deterministically.
    #[test]
    fn an_old_instance_cannot_learn_its_successors_identity() {
        let b = Bindings::default();
        let first = b.bind_pane(&["beat", "hello"]);
        assert_eq!(first.surface, "pane-1");

        // The pane is replaced: revoked, then a new instance bound.
        b.revoke(&first.surface);
        let second = b.bind_pane(&["beat", "hello"]);
        assert_eq!(second.surface, "pane-2", "a pane label is never reused");
        assert!(second.generation > first.generation);

        // `whoami` from the OLD instance. It passes no argument at all, so
        // the only thing that can save us is the label being the instance.
        assert!(
            b.resolve_label(&first.surface).is_none(),
            "a revoked instance resolved a principal — it can now learn a live generation"
        );

        // And it cannot reach the successor's binding by any means available
        // to it: it has no argument to aim, and its own label is dead.
        for grant in ["beat", "hello"] {
            let refusal = b
                .authorize_label(&first.surface, first.generation, grant)
                .expect_err("a revoked instance was authorized");
            assert_eq!(refusal.code, "PRINCIPAL_REVOKED");
            let refusal = b
                .authorize_label(&first.surface, second.generation, grant)
                .expect_err("a revoked instance was authorized with the successor's generation");
            assert_eq!(
                refusal.code, "PRINCIPAL_REVOKED",
                "revocation must outrank staleness: the caller is not late, its authority is gone"
            );
        }

        // The successor is unaffected.
        assert!(b.resolve_label(&second.surface).is_some());
        assert!(b.authorize_label(&second.surface, second.generation, "beat").is_ok());
    }

    /// The same hole, with the label made reusable — the shape this defends
    /// against, asserted so that the defence is not merely asserted.
    /// The same hole with a REUSED label, so the defence is demonstrated and
    /// not merely asserted. `main` is used because it carries grants under
    /// this table — the point is about the label being reusable, and any
    /// reusable label leaks the same way.
    #[test]
    fn a_reused_label_would_hand_over_the_successors_generation() {
        let b = Bindings::default();
        let first = b.bind("main");
        b.revoke("main");
        let second = b.bind("main"); // rebound under the SAME name
        assert_ne!(first.generation, second.generation);

        let leaked = b.resolve_label("main").expect("the reused label still resolves");
        assert_eq!(
            leaked.generation, second.generation,
            "THE HOLE: an old instance calling whoami learns the SUCCESSOR's generation"
        );
        assert!(
            b.authorize_label("main", leaked.generation, "place").is_ok(),
            "and having learned it, the old instance acts with it"
        );
    }

    #[test]
    fn a_grant_is_never_taken_from_the_request() {
        let b = Bindings::default();
        let road = b.bind("main");
        assert!(road.grants.contains(&"place".to_string()));
        assert!(!road.grants.contains(&"intent".to_string()), "the road never holds intent");
        let pane = b.bind_pane(&["beat", "hello"]);
        assert!(!pane.grants.contains(&"place".to_string()), "a pane cannot place itself");
        // A terminal package declares no `produces`, so it is never granted
        // `offer` — the grant is derived from the declaration, not the role.
        let terminal = b.bind_pane(&["beat", "hello"]);
        assert!(!terminal.grants.contains(&"offer".to_string()));
        let producer = b.bind_pane(&["beat", "hello", "offer"]);
        assert!(producer.grants.contains(&"offer".to_string()));
    }

    #[test]
    fn live_panes_sees_exactly_the_unrevoked_instances() {
        let b = Bindings::default();
        let a = b.bind_pane(&["beat"]);
        assert_eq!(b.live_panes(), vec![a.surface.clone()]);
        b.revoke(&a.surface);
        assert!(b.live_panes().is_empty());
        let c = b.bind_pane(&["beat"]);
        assert_eq!(b.live_panes(), vec![c.surface]);
    }
}
