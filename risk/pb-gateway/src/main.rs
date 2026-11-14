//! pb-gateway's entry point on OutLayer: the request on stdin, the answer on stdout, and always exit 0, because
//! OutLayer counts a non-zero exit as a failed run; refusals are `{"ok":false,"code":..,"reason":..}`.
//!
//! Build (the published hash comes from exactly this, run in risk/):
//!   RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-gateway --target wasm32-wasip2 --release
//! The remap keeps the builder's home directory out of the panic paths that the binary embeds.
use std::io::{Read, Write};

/// The project manifest, in the wasm's `outlayer.manifest` custom section, so the wasm's hash covers it
/// (OutLayer's wasi-examples/CONNECTOR_MANIFEST.md):
/// - `author_secrets`: the keeper's secret row for this project, profile `gateway`, holding the generated
///   `PROTECTED_PB_AGENT_SEED`, goes into every run. Its access condition decides who may run the gateway at all.
/// - `callers`: no direct calls; contracts (client accounts asking for their agent) and HTTPS (the backend) only.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static MANIFEST: [u8; pb_gateway::MANIFEST_JSON.len()] = {
    // A custom section is the static's bytes, so copy the text into an array of its own length.
    let mut out = [0u8; pb_gateway::MANIFEST_JSON.len()];
    let mut i = 0;
    while i < out.len() {
        out[i] = pb_gateway::MANIFEST_JSON.as_bytes()[i];
        i += 1;
    }
    out
};

fn main() {
    let mut raw = String::new();
    let out = match std::io::stdin().read_to_string(&mut raw) {
        Ok(_) => run(&raw),
        Err(e) => pb_gateway::gateway::refusal_json(&pb_gateway::gateway::Refusal {
            code: "INPUT",
            reason: format!("cannot read stdin: {e}"),
        }),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

#[cfg(target_arch = "wasm32")]
mod host {
    //! OutLayer's storage and environment, and the WASI HTTP transport.
    use pb_gateway::gateway::Host;
    use pb_gateway::store::Store;
    use pb_read::wasi_net::WasiNet;

    pub struct OutLayerStore;

    fn err(e: outlayer::storage::StorageError) -> String {
        e.0
    }

    impl Store for OutLayerStore {
        fn get(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
            outlayer::storage::get(key).map_err(err)
        }
        fn set(&mut self, key: &str, value: &[u8]) -> Result<(), String> {
            outlayer::storage::set(key, value).map_err(err)
        }
        fn set_if_absent(&mut self, key: &str, value: &[u8]) -> Result<bool, String> {
            outlayer::storage::set_if_absent(key, value).map_err(err)
        }
        fn set_if_equals(
            &mut self,
            key: &str,
            expected: &[u8],
            value: &[u8],
        ) -> Result<(bool, Option<Vec<u8>>), String> {
            outlayer::storage::set_if_equals(key, expected, value).map_err(err)
        }
    }

    pub struct OutLayerHost {
        pub net: WasiNet,
        pub store: OutLayerStore,
    }

    impl Host for OutLayerHost {
        type N = WasiNet;
        type S = OutLayerStore;
        fn net(&mut self) -> &mut WasiNet {
            &mut self.net
        }
        fn store(&mut self) -> &mut OutLayerStore {
            &mut self.store
        }
        fn env(&self, name: &str) -> Option<String> {
            std::env::var(name).ok().filter(|v| !v.is_empty())
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn run(raw: &str) -> String {
    let mut host = host::OutLayerHost {
        net: pb_read::wasi_net::WasiNet::new("pb-gateway"),
        store: host::OutLayerStore,
    };
    pb_gateway::run(raw, &mut host)
}

#[cfg(not(target_arch = "wasm32"))]
fn run(_raw: &str) -> String {
    pb_gateway::gateway::refusal_json(&pb_gateway::gateway::Refusal {
        code: "INPUT",
        reason: "pb-gateway runs on OutLayer: build it for wasm32-wasip2; the tests run every mode natively".into(),
    })
}
