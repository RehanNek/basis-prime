//! pb-read: the reads pb-risk and pb-gateway share, and the book they build from them (INTERFACES.md 6, 9 and 10).
//!
//! - [`read`]: the NEAR views at one final block, the Hyperliquid account and market, and the exchanges' prices, into
//!   [`Inputs`]. Written against the [`read::Net`] trait, so tests replay canned answers natively.
//! - [`near`], [`hl`], [`market`]: what each answer says, one parser per view.
//! - [`book`]: the engine's account and market from the inputs, with the client's rating and tier, and the money
//!   the account has in transit.
//! - [`lenders`]: what the account has at the outside lenders (FUNDING.md 6), as the book counts it.
//! - [`evm`]: the Ethereum chains and calls the Aave reads use, and the decoder for their hex answers.
//! - [`steps`]: the verdict's plan steps (INTERFACES.md 13), as pb-risk writes them and the gateway places them.
//! - [`credit`]: the credit check's request and reads (INTERFACES.md 18): mainnet, read only.
//! - [`stress`]: the book stress test's reads (INTERFACES.md 19): every account with a loan, prices read once.
//! - `wasi_net` (wasm32 only): HTTPS over WASI HTTP, the transport both programs use on OutLayer.
pub mod book;
pub mod credit;
pub mod evm;
pub mod hl;
pub mod inputs;
pub mod lenders;
pub mod market;
pub mod near;
pub mod read;
pub mod request;
pub mod steps;
pub mod stress;
pub mod util;
#[cfg(target_arch = "wasm32")]
pub mod wasi_net;

pub use inputs::Inputs;
