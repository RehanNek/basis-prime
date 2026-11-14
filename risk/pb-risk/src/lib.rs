//! pb-risk: the OutLayer program that reads every input itself and returns the verdict (PLAN.md 5.6,
//! INTERFACES.md 6 and 10, RISK_ENGINE.md Appendix A).
//!
//! A run is two steps:
//! 1. **Read** (`pb_read::read`): the NEAR views at one final block, the Hyperliquid account and market, and the
//!    exchanges' prices, into [`Inputs`]. This is the only part that talks to the world. The reading code is shared
//!    with pb-gateway, so both programs see the book the same way.
//! 2. **Decide** ([`verdict`]): a pure function from the inputs to the verdict, built on `risk-core`. Its plan
//!    ([`plan`]) is the engine's steps written as INTERFACES.md 13's step objects.
//!
//! Because step 2 is pure and deterministic (no clock, no I/O, and `libm` for the one transcendental function),
//! `backtest verdict <inputs.json>` recomputes a run's verdict natively, to the byte. A preview run with
//! `"snapshot": true` returns `{"verdict": ..., "inputs": ...}` for exactly that.
pub mod bands;
pub mod credit;
pub mod lenders;
pub mod plan;
pub mod stress;
pub mod verdict;

// The reading modules moved to pb-read; these keep their old paths working.
pub use pb_read::{book, hl, inputs, market, near, read, request, steps, util};

pub use inputs::Inputs;
pub use request::{Intent, Mode, Request};
pub use verdict::{compute, compute_book, output, refusal, Verdict};

/// The modes that run over OutLayer's HTTPS API only (INTERFACES.md 18 and 19): an on-chain `request_check` can
/// never run them.
pub const HTTPS_ONLY: [&str; 2] = ["credit_check", "book"];

/// The request's `mode`, if it is JSON with one.
pub fn mode_of(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("mode")?.as_str().map(str::to_string)
}

/// [`run`], told whether OutLayer runs it on chain (`OUTLAYER_EXECUTION_TYPE` is `NEAR`): then the HTTPS-only modes
/// are refused.
pub fn run_for(raw: &str, net: &mut impl read::Net, on_chain: bool) -> String {
    match mode_of(raw) {
        Some(m) if on_chain && HTTPS_ONLY.contains(&m.as_str()) => {
            refusal(&format!("mode {m} runs over OutLayer's HTTPS API only"))
        }
        _ => run(raw, net),
    }
}

/// One run: the request on stdin to what goes on stdout. `net` does the reads. Errors are
/// `{"ok":false,"reason":...}`; with `"snapshot": true` the answer is `{"verdict": ..., "inputs": ...}`.
/// `credit_check` (INTERFACES.md 18) and `book` (19) have their own requests and answers; `check` and `preview`
/// are as before.
pub fn run(raw: &str, net: &mut impl read::Net) -> String {
    match mode_of(raw).as_deref() {
        Some("credit_check") => return credit::run(raw, net),
        Some("book") => return stress::run(raw, net),
        Some("check" | "preview") | None => {}
        Some(other) => {
            return refusal(&format!(
                "unknown mode {other:?}: use check, preview, credit_check or book"
            ))
        }
    }
    let parsed = match request::parse(raw) {
        Ok(p) => p,
        Err(reason) => return refusal(&reason),
    };
    let inputs = read::read_all(net, &parsed.request);
    let verdict = output(&inputs);
    if parsed.snapshot {
        format!(r#"{{"verdict":{verdict},"inputs":{}}}"#, inputs.canonical())
    } else {
        verdict
    }
}
