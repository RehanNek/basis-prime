//! What the gateway keeps in OutLayer storage (INTERFACES.md 9). Storage is per project and per caller; every order
//! comes over HTTPS from our backend, so the runs share one space (research/day1.md, check 9).
//!
//! - `lock:<A>`: one order at a time per account (P0). Taken with `set_if_absent` the first time and with
//!   `set_if_equals` from `"free"` after that; released with `set_if_equals` back to `"free"`. A lock older than
//!   60 s may be taken over, since a run lasts at most 20 s.
//! - `nonce:<base64>`: each signed message once, set with `set_if_absent`.
//! - `recent:<A>`: the gateway's own orders of the last minute. Those of the last 10 s that Hyperliquid doesn't show
//!   yet count as filled; all of them count toward the limit of 60 a minute (P10).
//! - `step:<A>:<pid>:<i>`: a plan step the `deleverage` mode ran, so it runs once (`gateway::StepRecord`).
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// OutLayer's storage, as the gateway uses it. Values are bytes; `set_if_equals` answers whether it swapped and,
/// if not, what is there (None if the key is missing).
pub trait Store {
    fn get(&mut self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&mut self, key: &str, value: &[u8]) -> Result<(), String>;
    fn set_if_absent(&mut self, key: &str, value: &[u8]) -> Result<bool, String>;
    fn set_if_equals(
        &mut self,
        key: &str,
        expected: &[u8],
        value: &[u8],
    ) -> Result<(bool, Option<Vec<u8>>), String>;
}

/// An in-memory store, for tests and for runs without OutLayer.
#[derive(Clone, Debug, Default)]
pub struct MemStore {
    pub map: BTreeMap<String, Vec<u8>>,
}

impl Store for MemStore {
    fn get(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.map.get(key).cloned())
    }

    fn set(&mut self, key: &str, value: &[u8]) -> Result<(), String> {
        self.map.insert(key.to_string(), value.to_vec());
        Ok(())
    }

    fn set_if_absent(&mut self, key: &str, value: &[u8]) -> Result<bool, String> {
        if self.map.contains_key(key) {
            return Ok(false);
        }
        self.map.insert(key.to_string(), value.to_vec());
        Ok(true)
    }

    fn set_if_equals(
        &mut self,
        key: &str,
        expected: &[u8],
        value: &[u8],
    ) -> Result<(bool, Option<Vec<u8>>), String> {
        match self.map.get(key) {
            None => Ok((false, None)),
            Some(v) if v.as_slice() == expected => {
                self.map.insert(key.to_string(), value.to_vec());
                Ok((true, None))
            }
            Some(v) => Ok((false, Some(v.clone()))),
        }
    }
}

pub const FREE: &[u8] = b"free";

/// A lock older than this may be taken over.
pub const LOCK_STALE_MS: u64 = 60_000;

/// A held lock: who holds it and since when (unix ms), stored as `"<holder> <ms>"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub value: Vec<u8>,
}

pub fn lock_key(account: &str) -> String {
    format!("lock:{account}")
}

fn holder_value(holder: &str, now_ms: u64) -> Vec<u8> {
    format!("{holder} {now_ms}").into_bytes()
}

/// The time a lock value was taken, if it has one.
fn taken_at(value: &[u8]) -> Option<u64> {
    std::str::from_utf8(value)
        .ok()?
        .rsplit_once(' ')?
        .1
        .parse()
        .ok()
}

/// Why the lock could not be taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LockError {
    /// Another run holds it, taken this many ms ago.
    Busy {
        age_ms: u64,
    },
    Storage(String),
}

/// Takes `lock:<account>` for `holder` (the call id), at once or not at all.
pub fn take_lock(
    store: &mut impl Store,
    account: &str,
    holder: &str,
    now_ms: u64,
) -> Result<Held, LockError> {
    let key = lock_key(account);
    let mine = holder_value(holder, now_ms);
    if store
        .set_if_absent(&key, &mine)
        .map_err(LockError::Storage)?
    {
        return Ok(Held { value: mine });
    }
    let (won, current) = store
        .set_if_equals(&key, FREE, &mine)
        .map_err(LockError::Storage)?;
    if won {
        return Ok(Held { value: mine });
    }
    let Some(current) = current else {
        // Deleted between the two calls: try once more from absent.
        return if store
            .set_if_absent(&key, &mine)
            .map_err(LockError::Storage)?
        {
            Ok(Held { value: mine })
        } else {
            Err(LockError::Busy { age_ms: 0 })
        };
    };
    // A held lock with no readable time is treated as old, so a damaged value can't block an account forever.
    let age_ms = taken_at(&current).map_or(u64::MAX, |at| now_ms.saturating_sub(at));
    if age_ms > LOCK_STALE_MS {
        let (won, _) = store
            .set_if_equals(&key, &current, &mine)
            .map_err(LockError::Storage)?;
        if won {
            return Ok(Held { value: mine });
        }
    }
    Err(LockError::Busy {
        age_ms: age_ms.min(LOCK_STALE_MS),
    })
}

/// Releases a lock this run holds. Answers false if the lock was no longer ours (taken over as stale).
pub fn release_lock(store: &mut impl Store, account: &str, held: &Held) -> Result<bool, String> {
    let (released, _) = store.set_if_equals(&lock_key(account), &held.value, FREE)?;
    Ok(released)
}

/// Marks a signed message's nonce used. False if it was used before.
pub fn use_nonce(store: &mut impl Store, nonce_b64: &str, now_ms: u64) -> Result<bool, String> {
    store.set_if_absent(&format!("nonce:{nonce_b64}"), now_ms.to_string().as_bytes())
}

/// Orders count as possibly filled for this long after they were sent, until Hyperliquid shows them.
pub const RECENT_FILL_MS: u64 = 10_000;
/// The window of P10's order rate.
pub const RATE_WINDOW_MS: u64 = 60_000;
/// At most this many orders in the window.
pub const MAX_ORDERS_PER_MINUTE: usize = 60;

/// One order the gateway sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    /// When it was sent (unix ms), also its Hyperliquid nonce.
    pub at_ms: u64,
    pub coin: String,
    /// Signed size in coin units: + buy, − sell. For a fill, what filled.
    pub size: f64,
    pub limit_px: f64,
    pub cloid: String,
    #[serde(default)]
    pub oid: Option<u64>,
    /// "filled", "partial", "resting", or "unknown" when Hyperliquid didn't answer.
    pub status: String,
    pub reduce_only: bool,
}

/// `recent:<A>`: the account's orders of the last minute, and the last Hyperliquid nonce its agent used.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ledger {
    #[serde(default)]
    pub sent: Vec<Sent>,
    #[serde(default)]
    pub last_nonce: u64,
}

pub fn recent_key(account: &str) -> String {
    format!("recent:{account}")
}

impl Ledger {
    /// The ledger as stored, or empty. A record that doesn't parse is dropped: it only ever adds caution.
    pub fn load(store: &mut impl Store, account: &str) -> Result<Ledger, String> {
        Ok(store
            .get(&recent_key(account))?
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default())
    }

    pub fn save(&self, store: &mut impl Store, account: &str) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        store.set(&recent_key(account), &bytes)
    }

    /// Keeps only the last minute.
    pub fn prune(&mut self, now_ms: u64) {
        self.sent
            .retain(|s| now_ms.saturating_sub(s.at_ms) < RATE_WINDOW_MS);
    }

    /// Orders sent in the last minute (P10).
    pub fn in_last_minute(&self, now_ms: u64) -> usize {
        self.sent
            .iter()
            .filter(|s| now_ms.saturating_sub(s.at_ms) < RATE_WINDOW_MS)
            .count()
    }

    /// The next Hyperliquid nonce: now, but always above the last one used.
    pub fn next_nonce(&self, now_ms: u64) -> u64 {
        now_ms.max(self.last_nonce + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_lets_one_run_in_at_a_time() {
        let mut s = MemStore::default();
        let a = "alice.pbf.testnet";
        // The first time: set_if_absent.
        let first = take_lock(&mut s, a, "call-1", 1_000).unwrap();
        assert_eq!(s.map["lock:alice.pbf.testnet"], b"call-1 1000");
        // A second run can't take it, and is told at once.
        assert_eq!(
            take_lock(&mut s, a, "call-2", 1_500),
            Err(LockError::Busy { age_ms: 500 })
        );
        // Another account's lock is separate.
        assert!(take_lock(&mut s, "bob.pbf.testnet", "call-3", 1_500).is_ok());
        // A loser can't release it; the winner can.
        let fake = Held {
            value: b"call-2 1500".to_vec(),
        };
        assert_eq!(release_lock(&mut s, a, &fake), Ok(false));
        assert_eq!(release_lock(&mut s, a, &first), Ok(true));
        assert_eq!(s.map["lock:alice.pbf.testnet"], FREE);
        // After that: set_if_equals from "free".
        let again = take_lock(&mut s, a, "call-4", 2_000).unwrap();
        assert_eq!(again.value, b"call-4 2000");
        assert!(matches!(
            take_lock(&mut s, a, "call-5", 2_100),
            Err(LockError::Busy { .. })
        ));
        assert_eq!(release_lock(&mut s, a, &again), Ok(true));
    }

    #[test]
    fn a_stale_lock_is_taken_over_and_its_holder_cant_release_it() {
        let mut s = MemStore::default();
        let a = "alice.pbf.testnet";
        let crashed = take_lock(&mut s, a, "call-1", 1_000).unwrap();
        // 60 s is not yet stale; just over is.
        assert!(take_lock(&mut s, a, "call-2", 61_000).is_err());
        let taker = take_lock(&mut s, a, "call-3", 61_001).unwrap();
        assert_eq!(release_lock(&mut s, a, &crashed), Ok(false));
        assert_eq!(release_lock(&mut s, a, &taker), Ok(true));
        // A damaged value counts as stale.
        s.set("lock:x.pbf.testnet", b"garbage").unwrap();
        assert!(take_lock(&mut s, "x.pbf.testnet", "call-6", 5).is_ok());
    }

    /// A store whose every call fails.
    struct Broken;

    impl Store for Broken {
        fn get(&mut self, _: &str) -> Result<Option<Vec<u8>>, String> {
            Err("down".into())
        }
        fn set(&mut self, _: &str, _: &[u8]) -> Result<(), String> {
            Err("down".into())
        }
        fn set_if_absent(&mut self, _: &str, _: &[u8]) -> Result<bool, String> {
            Err("down".into())
        }
        fn set_if_equals(
            &mut self,
            _: &str,
            _: &[u8],
            _: &[u8],
        ) -> Result<(bool, Option<Vec<u8>>), String> {
            Err("down".into())
        }
    }

    #[test]
    fn storage_failures_are_reported_not_taken_as_a_lock() {
        assert_eq!(
            take_lock(&mut Broken, "a.pbf.testnet", "c", 1),
            Err(LockError::Storage("down".into()))
        );
        assert!(use_nonce(&mut Broken, "n", 1).is_err());
    }

    #[test]
    fn nonces_are_used_once() {
        let mut s = MemStore::default();
        assert_eq!(use_nonce(&mut s, "AAAA", 1), Ok(true));
        assert_eq!(use_nonce(&mut s, "AAAA", 2), Ok(false));
        assert_eq!(use_nonce(&mut s, "AAAB", 2), Ok(true));
    }

    #[test]
    fn the_ledger_keeps_a_minute_and_counts_it() {
        let mut s = MemStore::default();
        let a = "alice.pbf.testnet";
        let mut l = Ledger::load(&mut s, a).unwrap();
        assert_eq!(l, Ledger::default());
        for i in 0..3 {
            l.sent.push(Sent {
                at_ms: 1_000 + i * 30_000,
                coin: "BTC".into(),
                size: -0.1,
                limit_px: 74_500.0,
                cloid: format!("0x{i:032x}"),
                oid: None,
                status: "resting".into(),
                reduce_only: false,
            });
        }
        l.last_nonce = 61_000;
        l.save(&mut s, a).unwrap();
        let mut back = Ledger::load(&mut s, a).unwrap();
        assert_eq!(back, l);
        assert_eq!(back.in_last_minute(61_500), 2);
        back.prune(61_500);
        assert_eq!(back.sent.len(), 2);
        // Nonces only go up, even if the clock goes back.
        assert_eq!(back.next_nonce(50_000), 61_001);
        assert_eq!(back.next_nonce(70_000), 70_000);
        // A damaged record reads as empty.
        s.set(&recent_key(a), b"{not json").unwrap();
        assert_eq!(Ledger::load(&mut s, a).unwrap(), Ledger::default());
    }
}
