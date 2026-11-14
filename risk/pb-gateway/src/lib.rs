//! pb-gateway: the OutLayer program every Hyperliquid order passes through (PLAN.md 5.3, INTERFACES.md 9,
//! RISK_ENGINE.md 9). It holds no key of its own: each client account's agent key is derived from a seed generated
//! inside OutLayer, and an order is signed only after the owner's NEP-413 signature and the pre-trade checks pass.
//!
//! - [`gateway`]: the six modes (Phase 3's four, and Phase 4's `deleverage` and `cancel_risky`), written against a
//!   [`gateway::Host`] (transport, storage, environment, reads), so every mode runs natively in tests;
//! - [`hlsign`]: Hyperliquid L1 actions and their signatures;
//! - [`keys`]: the HKDF agent keys;
//! - [`nep413`]: the owner's signed message;
//! - [`msg`]: the message formats and Hyperliquid's rounding rules;
//! - [`store`]: the P0 lock, the nonce store and the order ledger in OutLayer storage.
pub mod gateway;
pub mod hlsign;
pub mod keys;
pub mod msg;
pub mod nep413;
pub mod store;

pub use gateway::run;

/// The project manifest the binary embeds in its `outlayer.manifest` section. `author_secrets` names the keeper's
/// secret row (profile `gateway`) that holds the seed; `callers` refuses direct calls, leaving contracts (client
/// accounts) and HTTPS (the backend).
pub const MANIFEST_JSON: &str = r#"{"author_secrets":{"owner":"pbf-keeper.testnet","profile":"gateway"},"callers":{"direct":"deny"}}"#;

#[cfg(test)]
mod tests;
