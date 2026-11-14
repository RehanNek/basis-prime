//! Everything one run read, as the verdict is computed from it. NEAR view results are kept as returned; exchange
//! answers are kept as the numbers taken from them. Its canonical JSON (struct fields in order, map keys sorted,
//! floats in shortest round-trip form) is hashed into the verdict's `in`, and `backtest verdict` recomputes the
//! verdict from it.
use crate::request::Request;
use crate::util::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// The format of this file. A change to it is a new program version anyway.
pub const INPUTS_V: u32 = 1;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Inputs {
    pub v: u32,
    pub request: Request,
    /// The final NEAR block that every view call read at. Its height is the verdict's `blk`.
    pub block: Block,
    pub near: NearReads,
    pub hl: HlReads,
    /// What the outside lenders answered (FUNDING.md 6.1). Empty, and left out of the canonical form, for an
    /// account whose config names no lender, so inputs read before Phase 6 replay unchanged.
    #[serde(default, skip_serializing_if = "LenderReads::is_empty")]
    pub lenders: LenderReads,
    /// The floor under P2's price band that this run's network gave (`Network::price_band_floor`, INTERFACES.md
    /// 42): 0.03 on testnet since 12 Nov. A plan's perp step is priced half the band from the reference, so the
    /// floor is part of what the verdict is computed from. 0, and left out of the canonical form, in a run from
    /// before it, whose plan then replays with the parameter file's band alone.
    #[serde(default, skip_serializing_if = "no_floor")]
    pub band_floor: f64,
    /// Exchange readings per coin, by Hyperliquid coin name.
    pub coins: BTreeMap<String, CoinReads>,
    /// The enclave's clock (unix ms) after the last price was read: "now" for ages and candle windows.
    pub now_ms: u64,
    /// Reads that failed and count as missing, in words.
    pub errors: Vec<String>,
    /// A read that failed and stops the run (no such account, no pool): the verdict is this refusal.
    pub fatal: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Block {
    pub height: u64,
    /// Nanoseconds, as a U64 string (INTERFACES.md 2).
    pub timestamp_ns: String,
    pub hash: String,
}

/// NEAR view results at `block`, as the contracts returned them; null where a call failed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NearReads {
    /// The account's `get_state` and `get_config`.
    pub state: Value,
    pub config: Value,
    /// `ft_balance_of(account)` per configured token id.
    pub balances: BTreeMap<String, Value>,
    /// The pool's `get_pool`, `get_params`, `get_borrower(account)` and `coin_statuses`.
    pub pool: Value,
    pub params: Value,
    pub borrower: Value,
    pub coin_statuses: Value,
    /// The drill's `get_ratio` (testnet): π for nBTC.
    pub drill: Value,
}

/// Hyperliquid reads.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HlReads {
    /// The account's Hyperliquid address (`get_state().hl.address`), if it has one.
    pub address: Option<String>,
    /// `clearinghouseState` and `frontendOpenOrders` for that address.
    pub state: Value,
    pub orders: Value,
    /// Whether `metaAndAssetCtxs` was read. If it was, a coin missing from `assets` is not listed there.
    pub meta_read: bool,
    /// Per coin needed: `{"meta": <universe entry>, "ctx": <asset context>, "tiers": <margin tiers> | null}`.
    pub assets: BTreeMap<String, Value>,
    /// When `metaAndAssetCtxs` came back (unix ms): the oracle price's time.
    pub at_ms: u64,
    /// `userAbstraction` for the address: `"default"`, `"disabled"`, `"unifiedAccount"`, ... It says where the USDC
    /// sits (research/hyperliquid.md). Null, and left out of the canonical form, in inputs read before Phase 3, which
    /// are read as standard accounts, so their verdicts replay unchanged.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub abstraction: Value,
    /// `spotClearinghouseState` for the address: a unified account's USDC. Null and left out like `abstraction`.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub spot: Value,
    /// `userNonFundingLedgerUpdates` for the address, read only while a `to_hl` transfer is pending, to see whether
    /// it arrived. Null and left out otherwise, so inputs read before Phase 4 replay unchanged.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub ledger: Value,
    /// The ledger read's `startTime` (unix ms); 0 and left out when it wasn't read.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub ledger_from_ms: u64,
    /// `userNonFundingLedgerUpdates` for the address, read **before** `state` and `spot` while the account has
    /// open sends (`get_state().hl.open_sends`, INTERFACES.md 50.2), to see which of them Hyperliquid shows as
    /// sent. Read first, so a transfer it shows is already out of the balances this run counts. Null and left out
    /// when it wasn't read, so inputs read before 14 Nov replay unchanged.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub sent_ledger: Value,
    /// That read's `startTime` (unix ms): one hour before the oldest open send. 0 and left out when it wasn't read.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub sent_from_ms: u64,
}

fn is_zero(x: &u64) -> bool {
    *x == 0
}

fn no_floor(x: &f64) -> bool {
    *x == 0.0
}

/// The lender reads: one entry per lender in the account's config.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LenderReads {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rhea: Option<RheaReads>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aave: Option<AaveReads>,
}

impl LenderReads {
    pub fn is_empty(&self) -> bool {
        self.rhea.is_none() && self.aave.is_none()
    }
}

/// Rhea's views at the run's block, as the contract returned them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RheaReads {
    /// The contract read: the config's `lenders.rhea.contract_id`.
    pub contract_id: String,
    /// `get_account(account)`: the position. Null when the account has never used Rhea.
    pub account: Value,
    /// `get_assets([USDC, each collateral token])`: ratios, rates and what is free.
    pub assets: Value,
    /// `get_token_pyth_info(token)` per token: its price setting, with a `default_price` if it has one.
    pub prices: BTreeMap<String, Value>,
}

/// Aave's answers from the chain's RPC: each call's returned hex, all read at one block when the chain gave its
/// block number first.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AaveReads {
    pub chain_id: u64,
    /// The account's Ethereum address (its Hyperliquid address). None: it has none yet, so only the market was read.
    pub address: Option<String>,
    /// The block every call was pinned to. None, and left out of the canonical form, when the calls were made at
    /// `latest`: a run from before the block was pinned, or one whose `eth_blockNumber` got no answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<u64>,
    /// By name: `account` (getUserAccountData), `posted:<token>` and `debt` (getUserReserveData for a collateral
    /// token and for USDC), `config:<token>` (getReserveConfigurationData), `reserve` (getReserveData for USDC),
    /// `free` (getVirtualUnderlyingBalance for USDC), `balance:<token>` (balanceOf at the address, USDC included),
    /// `price:<token>` (the oracle's getAssetPrice) and `nonce` (eth_getTransactionCount). Tokens are 0x addresses.
    pub calls: BTreeMap<String, String>,
}

/// One coin's exchange readings. Prices are in the exchange's units (USDT or USD per token); the engine's
/// Hyperliquid units (`kPEPE` = 1,000 PEPE) are applied when the verdict is computed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CoinReads {
    /// Best bid and ask per source (binance, okx, bybit, coinbase).
    pub tickers: BTreeMap<String, Ticker>,
    /// One-minute candles per source (binance, okx, bybit): `[open time ms, close]`, oldest first.
    pub minutes: BTreeMap<String, Vec<(u64, f64)>>,
    /// One-hour candles per source, the same way.
    pub hours: BTreeMap<String, Vec<(u64, f64)>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ticker {
    pub bid: f64,
    pub ask: f64,
    /// When the answer came back (unix ms).
    pub at_ms: u64,
}

impl Inputs {
    /// Empty inputs for `request`, filled in by the reads.
    pub fn new(request: Request) -> Inputs {
        Inputs {
            v: INPUTS_V,
            request,
            ..Inputs::default()
        }
    }

    /// The canonical JSON: the bytes `in` hashes, and what a snapshot returns.
    pub fn canonical(&self) -> String {
        // Serialising plain data with finite floats can't fail; the readers keep NaN and infinities out.
        serde_json::to_string(self).expect("inputs serialise")
    }

    /// The verdict's `in`: SHA-256 of the canonical JSON.
    pub fn hash(&self) -> String {
        sha256_hex(self.canonical().as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_canonical_form_survives_a_round_trip() {
        let mut i = Inputs::new(Request::default());
        i.block = Block {
            height: 276621922,
            timestamp_ns: "1794049207125982065".into(),
            hash: "abc".into(),
        };
        i.near.state = serde_json::json!({"z": 1, "a": [1, "2", null], "counter": 3});
        let mut c = CoinReads::default();
        c.tickers.insert(
            "okx".into(),
            Ticker {
                bid: 75982.7,
                ask: 75982.8,
                at_ms: 1,
            },
        );
        c.hours.insert(
            "binance".into(),
            vec![(1, 0.1 + 0.2), (2, 1e-7), (3, 123_456_789.123_456_78)],
        );
        i.coins.insert("BTC".into(), c);
        let s = i.canonical();
        let back: Inputs = serde_json::from_str(&s).unwrap();
        assert_eq!(back, i);
        assert_eq!(back.canonical(), s);
        assert!(s.contains(r#""state":{"a":[1,"2",null],"counter":3,"z":1}"#));
        // A pretty-printed copy has the same canonical form, so the same hash.
        let pretty = serde_json::to_string_pretty(&i).unwrap();
        let again: Inputs = serde_json::from_str(&pretty).unwrap();
        assert_eq!(again.hash(), i.hash());
    }

    #[test]
    fn the_band_floor_is_left_out_when_there_is_none_and_survives_a_round_trip() {
        let mut i = Inputs::new(Request::default());
        let before = i.canonical();
        assert!(!before.contains("band_floor"));
        // Inputs saved before the floor read back with none.
        assert_eq!(serde_json::from_str::<Inputs>(&before).unwrap().band_floor, 0.0);
        i.band_floor = 0.03;
        let s = i.canonical();
        assert!(s.contains(r#""band_floor":0.03,"coins":{}"#), "{s}");
        assert_eq!(serde_json::from_str::<Inputs>(&s).unwrap(), i);
        assert_ne!(i.hash(), Inputs::new(Request::default()).hash());
    }

    #[test]
    fn the_ledger_read_for_sent_transfers_is_left_out_when_not_read_and_survives_a_round_trip() {
        let mut i = Inputs::new(Request::default());
        let before = i.canonical();
        assert!(!before.contains("sent_ledger") && !before.contains("sent_from_ms"));
        // Inputs saved before the read have neither field, and read back as not read.
        let old: Inputs = serde_json::from_str(&before).unwrap();
        assert_eq!((old.hl.sent_ledger.clone(), old.hl.sent_from_ms), (Value::Null, 0));
        assert_eq!(old.hash(), i.hash());
        // A read that found nothing is kept as an empty list, with where it started.
        i.hl.sent_ledger = serde_json::json!([]);
        i.hl.sent_from_ms = 1_794_580_602_071;
        let s = i.canonical();
        assert!(s.contains(r#""sent_ledger":[],"sent_from_ms":1794580602071"#), "{s}");
        assert_eq!(serde_json::from_str::<Inputs>(&s).unwrap(), i);
        assert_ne!(i.hash(), old.hash());
    }

    #[test]
    fn lender_reads_are_left_out_when_empty_and_survive_a_round_trip() {
        let mut i = Inputs::new(Request::default());
        let before = i.canonical();
        assert!(!before.contains("lenders"));
        i.lenders.aave = Some(AaveReads {
            chain_id: 84532,
            address: Some("0xab".into()),
            block: None,
            calls: [("nonce".to_string(), "0x7".to_string())].into_iter().collect(),
        });
        let s = i.canonical();
        assert!(s.contains(r#""lenders":{"aave":{"chain_id":84532,"address":"0xab","calls":{"nonce":"0x7"}}}"#));
        let back: Inputs = serde_json::from_str(&s).unwrap();
        assert_eq!(back, i);
        // The block the calls were pinned to is kept when there is one, and round-trips.
        let mut pinned = i.clone();
        pinned.lenders.aave.as_mut().unwrap().block = Some(57_472_001);
        let s = pinned.canonical();
        assert!(s.contains(r#""address":"0xab","block":57472001,"calls""#));
        assert_eq!(serde_json::from_str::<Inputs>(&s).unwrap(), pinned);
        i.lenders.rhea = Some(RheaReads {
            contract_id: "rhea.pbf-ops.testnet".into(),
            account: Value::Null,
            assets: serde_json::json!([]),
            prices: BTreeMap::new(),
        });
        let s = i.canonical();
        let back: Inputs = serde_json::from_str(&s).unwrap();
        assert_eq!((back.canonical(), &back), (s, &i));
        // Inputs saved before Phase 6 have no such field and read as having no lender.
        let old: Inputs = serde_json::from_str(&before).unwrap();
        assert!(old.lenders.is_empty());
        assert_eq!(old.canonical(), before);
    }
}
