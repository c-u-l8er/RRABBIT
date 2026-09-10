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
        "main" => &["place", "promote", "demote", "status", "manifest"],
        "pane" => &["beat", "hello"],
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
        let mut g = self.0.lock().unwrap();
        g.next_id += 1;
        g.next_generation += 1;
        let (id, generation) = (g.next_id, g.next_generation);
        let grants = grants_for(surface);
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
        let g = self.0.lock().unwrap();
        g.by_surface.get(webview.label()).filter(|b| !b.revoked).map(|b| Principal {
            binding: b.id,
            surface: webview.label().to_string(),
            generation: b.generation,
            grants: b.grants.iter().cloned().collect(),
        })
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
        let surface = webview.label();
        let generation = echoed_generation;
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
