//! pb-risk's entry point on OutLayer: the request on stdin, the verdict on stdout, and always exit 0, because
//! OutLayer counts a non-zero exit as a failed run; refusals are `{"ok":false,"reason":...}`.
//!
//! Build (the published hash comes from exactly this, run in risk/):
//!   RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release
//! The remap keeps the builder's home directory out of the panic paths that the binary embeds.
use std::io::{Read, Write};

fn main() {
    let mut raw = String::new();
    let out = match std::io::stdin().read_to_string(&mut raw) {
        Ok(_) => run(&raw),
        Err(e) => pb_risk::refusal(&format!("cannot read stdin: {e}")),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

#[cfg(target_arch = "wasm32")]
fn run(raw: &str) -> String {
    // OutLayer says how it runs the program: `NEAR` for an on-chain request, `HTTPS` for its API
    // (research/outlayer.md). The Phase 5 modes answer over HTTPS only.
    let on_chain = std::env::var("OUTLAYER_EXECUTION_TYPE").is_ok_and(|t| t == "NEAR");
    pb_risk::run_for(
        raw,
        &mut pb_read::wasi_net::WasiNet::new("pb-risk"),
        on_chain,
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn run(_raw: &str) -> String {
    pb_risk::refusal(
        "pb-risk reads over WASI HTTP: build it for wasm32-wasip2 and run it on OutLayer; \
         `backtest verdict <inputs.json>` replays a run natively",
    )
}
