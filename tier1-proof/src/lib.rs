// Share the exact runtime exercised by the standalone harness.
#[path = "main.rs"]
mod runtime;
pub use runtime::{handler, install, shutdown, Rect, COMMANDS, ROAD_LABEL};
#[cfg(feature = "super-integration")]
pub use runtime::open;
