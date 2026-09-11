//! **The package store, owned by the coordinator.** ROAD_SHELL.md §5.
//!
//! Two packages, because one cannot demonstrate a handoff and the composition
//! rules only bite across an app boundary: routing by DECLARED acceptance,
//! eviction under `N = 1`, state surviving that eviction, and an authority
//! that does not leak from one app to the next.
//!
//! **The catalogue is readable with zero live panes**, which is the whole
//! claim of §5: a road can be laid out, and its arrangement sealed, before any
//! app has started. Nothing here starts anything.
//!
//! Embedded with `include_str!` because a harness has no package store on
//! disk. The ownership is what is under test, not the filesystem.

use serde::Deserialize;
use serde_json::Value;

const SOURCES: &[(&str, &str)] = &[
    ("notes", include_str!("../ui/packages/notes.json")),
    ("digest", include_str!("../ui/packages/digest.json")),
];

#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    pub id: String,
    pub entry: String,
    pub accepts: Vec<String>,
    /// `None` is a package that produces nothing — and that is not decoration:
    /// `grants_for` reads it, so a terminal app is not granted `offer` and
    /// cannot hand anything on. **The grant is derived from the declaration.**
    pub produces: Option<String>,
    pub sign: Value,
}

pub fn catalogue() -> Result<Vec<Package>, String> {
    SOURCES
        .iter()
        .map(|(id, src)| {
            let p: Package =
                serde_json::from_str(src).map_err(|e| format!("MANIFEST_UNREADABLE: {id}: {e}"))?;
            if p.id != *id {
                return Err(format!("MANIFEST_ID_MISMATCH: {id} declares {:?}", p.id));
            }
            let n = p.sign.get("primitives").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            if n == 0 {
                return Err(format!("MANIFEST_NO_SIGN: {id} declares no sign primitives"));
            }
            Ok(p)
        })
        .collect()
}

pub fn get(id: &str) -> Result<Package, String> {
    catalogue()?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("NO_SUCH_PACKAGE: {id:?} is not in the catalogue"))
}

/// **Routing is the coordinator's, and it reads DECLARED acceptance.**
///
/// Not reported availability — that has an expiry and belongs to a running
/// app (§5.1) — and not the app's own opinion. A kind nothing accepts is
/// refused by name rather than silently dropped, because "no route" and
/// "routed and lost" must not look the same.
pub fn route(kind: &str) -> Result<Package, String> {
    catalogue()?
        .into_iter()
        .find(|p| p.accepts.iter().any(|a| a == kind))
        .ok_or_else(|| format!("NO_ROUTE: no package in the catalogue accepts {kind:?}"))
}

/// What a package's pane may do, derived from what the package DECLARES.
///
/// `offer` only where the manifest names something produced. A terminal app
/// asking to hand work on is refused by the same check that refuses the road
/// an `intent` — one principal, one grant table, no special case.
pub fn grants_for(p: &Package) -> Vec<&'static str> {
    let mut v = vec!["beat", "hello"];
    if p.produces.is_some() {
        v.push("offer");
    }
    v
}
