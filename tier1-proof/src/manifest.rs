//! **The published sign, owned by the coordinator.**
//!
//! ROAD_SHELL.md §5: an entrance sign is a declared accept-clause and renders
//! from the manifest, not from a running process — *"a road can be laid out
//! and sealed before any app is live."*
//!
//! An app fetching its own sign does not satisfy that. It reads as though it
//! does, because the file happens to sit in the same bundle, but the thing
//! doing the reading is the app's own page: nothing about it works for an app
//! that is not installed, not started, or not trusted to describe itself.
//! **Discovery is the host's.**
//!
//! Embedded here with `include_str!` because a harness has no package store.
//! The ownership is the part under test, not the filesystem: a real
//! coordinator reads an installed package and this function is where that
//! goes.

use serde_json::Value;

const PACKAGE_MANIFEST: &str = include_str!("../ui/app.json");

pub fn published() -> Result<Value, String> {
    let m: Value = serde_json::from_str(PACKAGE_MANIFEST)
        .map_err(|e| format!("MANIFEST_UNREADABLE: {e}"))?;
    // A sign with no primitives is not a sign, and rendering nothing would
    // look like an app that declared nothing rather than a broken package.
    let n = m.get("sign").and_then(|s| s.get("primitives")).and_then(|p| p.as_array())
        .map(|a| a.len()).unwrap_or(0);
    if n == 0 {
        return Err("MANIFEST_NO_SIGN: the package declares no sign primitives".into());
    }
    Ok(m)
}
