//! Every command is declared to the ACL here.
//!
//! `AppManifest::commands` autogenerates `allow-$command` / `deny-$command`,
//! which is what makes a command grantable and therefore withholdable. A
//! command in `invoke_handler` but absent here is OUTSIDE the ACL and fails
//! OPEN — the defect `super/cockpit/build.rs` exists to record.
//!
//! NOTE FOR THIS HARNESS: `privileged_intent` is deliberately GRANTED to the
//! road at the ACL layer (`capabilities/road.json`). That is not an oversight.
//! The ACL layer is already proven by the cockpit battery; what is under test
//! here is the SEAM check of ROAD_SHELL.md §6.2 — so the road must be able to
//! `invoke` the command and be refused by the host's principal check rather
//! than bounced one layer earlier.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "road_place",
            "road_promote",
            "road_demote",
            "road_status",
            "road_manifest",
            "whoami",
            "privileged_intent",
            "pane_beat",
            "pane_hello",
        ]),
    ))
    .expect("failed to run tauri-build");
}
