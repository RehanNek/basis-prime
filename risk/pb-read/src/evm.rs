//! Ethereum reads for Aave (FUNDING.md 6.1; INTERFACES.md 24 and 27): the chains the program can read, the calls
//! it makes, and a small decoder for the hex words they answer with.
//!
//! Every call here is a view (`eth_call`) or `eth_getTransactionCount`: nothing is signed or sent. The selectors are
//! the first four bytes of keccak-256 of each signature; `tests/lenders.rs` recomputes them. The signatures are
//! Aave's (`IPool.sol`, `IPoolDataProvider.sol` and `IPriceOracleGetter.sol` in `aave-dao/aave-v3-origin`) and
//! ERC-20's `balanceOf`.
use serde_json::{json, Value};

/// One chain the program can read Aave on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chain {
    pub chain_id: u64,
    pub rpc: &'static str,
    /// Aave's protocol data provider and price oracle on that chain (lower case).
    pub data_provider: &'static str,
    pub oracle: &'static str,
}

/// Base Sepolia (INTERFACES.md 24; research/aave.md has the sources). The pool and the tokens come from the
/// account's config.
pub const CHAINS: [Chain; 1] = [Chain {
    chain_id: 84532,
    rpc: "https://sepolia.base.org",
    data_provider: "0xbc9f5b7e248451cdd7ca54e717a2bfe1f32b566b",
    oracle: "0x943b0de18d4abf4ef02a85912f8fc07684c141df",
}];

/// The chain with this id, if the program can read it.
pub fn chain(chain_id: u64) -> Option<&'static Chain> {
    CHAINS.iter().find(|c| c.chain_id == chain_id)
}

/// `getUserAccountData(address)` on the Pool.
pub const GET_USER_ACCOUNT_DATA: &str = "bf92857c";
/// `getUserReserveData(address,address)` on the data provider: (asset, user).
pub const GET_USER_RESERVE_DATA: &str = "28dd2d01";
/// `getReserveConfigurationData(address)` on the data provider.
pub const GET_RESERVE_CONFIGURATION_DATA: &str = "3e150141";
/// `getReserveData(address)` on the data provider.
pub const GET_RESERVE_DATA: &str = "35ea6a75";
/// `getVirtualUnderlyingBalance(address)` on the data provider: what the reserve has free to lend.
pub const GET_VIRTUAL_UNDERLYING_BALANCE: &str = "6fb07f96";
/// `balanceOf(address)` on an ERC-20 token.
pub const BALANCE_OF: &str = "70a08231";
/// `getAssetPrice(address)` on Aave's oracle: USD with 8 decimals.
pub const GET_ASSET_PRICE: &str = "b3596f07";

/// `getReserveCaps(address)` on the data provider: the reserve's borrow cap and supply cap, in whole tokens.
pub const GET_RESERVE_CAPS: &str = "46fbe558";
/// `getATokenTotalSupply(address)` on the data provider: what is supplied to the reserve, in the token's units.
pub const GET_ATOKEN_TOTAL_SUPPLY: &str = "51460e25";

/// Each selector with its signature, for the test that recomputes them.
pub const SELECTORS: [(&str, &str); 9] = [
    (GET_USER_ACCOUNT_DATA, "getUserAccountData(address)"),
    (GET_USER_RESERVE_DATA, "getUserReserveData(address,address)"),
    (
        GET_RESERVE_CONFIGURATION_DATA,
        "getReserveConfigurationData(address)",
    ),
    (GET_RESERVE_DATA, "getReserveData(address)"),
    (
        GET_VIRTUAL_UNDERLYING_BALANCE,
        "getVirtualUnderlyingBalance(address)",
    ),
    (BALANCE_OF, "balanceOf(address)"),
    (GET_ASSET_PRICE, "getAssetPrice(address)"),
    (GET_RESERVE_CAPS, "getReserveCaps(address)"),
    (GET_ATOKEN_TOTAL_SUPPLY, "getATokenTotalSupply(address)"),
];

/// The oracle's prices and `getUserAccountData`'s sums are USD with 8 decimals.
pub const BASE_DECIMALS: u32 = 8;
/// Aave's rates are yearly, in ray: 1e27 is 100%.
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
/// Aave's health factor is scaled by 1e18.
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// `0x` and 40 hex digits, in lower case; None for anything else.
pub fn address(a: &str) -> Option<String> {
    crate::near::is_evm_address(a).then(|| a.to_ascii_lowercase())
}

/// Call data: the selector, then each address as a 32-byte word.
pub fn call_data(selector: &str, addresses: &[&str]) -> String {
    let mut out = format!("0x{selector}");
    for a in addresses {
        let digits = a.strip_prefix("0x").unwrap_or(a).to_ascii_lowercase();
        out.push_str(&format!("{digits:0>64}"));
    }
    out
}

/// The JSON-RPC request of an `eth_call` of `data` on `to`, at `block`: the tag `latest`, or a block number as
/// [`block_tag`] writes it. `id` tells the answers of one batch apart.
pub fn eth_call_at(to: &str, data: &str, block: &str, id: u64) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "eth_call", "params": [{"to": to, "data": data}, block]})
}

/// The JSON-RPC request of `eth_getTransactionCount` at `block`: how many of the address's transactions the chain
/// had mined by then, which is the nonce its next one must carry.
pub fn eth_nonce_at(address: &str, block: &str, id: u64) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "eth_getTransactionCount", "params": [address, block]})
}

/// The JSON-RPC body of an `eth_call` of `data` on `to`, at the latest block.
pub fn eth_call(to: &str, data: &str) -> String {
    eth_call_at(to, data, "latest", 1).to_string()
}

/// The JSON-RPC body of `eth_getTransactionCount` at the latest block.
pub fn eth_nonce(address: &str) -> String {
    eth_nonce_at(address, "latest", 1).to_string()
}

/// The JSON-RPC body of `eth_blockNumber`: the chain's latest block, which every other call of a run is pinned to.
pub fn eth_block_number() -> String {
    json!({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).to_string()
}

/// A block number as a call's block parameter: `0x36d2a01`.
pub fn block_tag(number: u64) -> String {
    format!("0x{number:x}")
}

/// The answers of one JSON-RPC batch of `n` requests whose ids were 1 to `n`, in the requests' order: each one's
/// hex result, or `None` for one the node refused or left out. `None` for the whole when the answer isn't a list
/// of `n` entries: some endpoints refuse batches, and say so with a single object.
pub fn batch_results(reply: &Value, n: usize) -> Option<Vec<Option<String>>> {
    let list = reply.as_array().filter(|l| l.len() == n)?;
    Some(
        (1..=n as u64)
            .map(|id| {
                let mut with_id = list.iter().filter(|e| e.get("id").and_then(Value::as_u64) == Some(id));
                // An id answered twice is no answer.
                with_id.next().filter(|_| with_id.next().is_none()).and_then(|e| result_hex(e).ok())
            })
            .collect(),
    )
}

/// A JSON-RPC answer's `result`, which every call here returns as a hex string; else what went wrong.
pub fn result_hex(reply: &Value) -> Result<String, String> {
    if let Some(e) = reply.get("error") {
        let text = e.get("message").and_then(Value::as_str).map_or_else(|| e.to_string(), str::to_string);
        return Err(crate::util::clip(&text, 160));
    }
    match reply.get("result").and_then(Value::as_str) {
        Some(h) if h.starts_with("0x") && h[2..].bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(h.to_ascii_lowercase())
        }
        _ => Err("the answer has no hex result".into()),
    }
}

/// A returned value's 32-byte words, each as 64 hex digits. Refuses anything that isn't whole words.
pub fn words(hex: &str) -> Result<Vec<&str>, String> {
    let digits = hex.strip_prefix("0x").ok_or("a hex value must start with 0x")?;
    if digits.is_empty() || digits.len() % 64 != 0 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "a call returned {} hex digits, not whole 32-byte words",
            digits.len()
        ));
    }
    Ok((0..digits.len() / 64)
        .map(|i| &digits[64 * i..64 * (i + 1)])
        .collect())
}

/// A word as a `u128`; None when it is larger (Aave writes "no limit" as the largest uint256).
pub fn word_u128(word: &str) -> Option<u128> {
    if word.len() != 64 || word[..32].bytes().any(|b| b != b'0') {
        return None;
    }
    u128::from_str_radix(&word[32..], 16).ok()
}

/// A JSON-RPC quantity (`0x1a`) as a `u64`.
pub fn quantity(hex: &str) -> Option<u64> {
    let digits = hex.strip_prefix("0x")?;
    if digits.is_empty() || digits.len() > 16 {
        return None;
    }
    u64::from_str_radix(digits, 16).ok()
}

/// The words of `hex`, which must be at least `n`, as numbers. `what` names the call in the refusal.
fn numbers(hex: &str, n: usize, what: &str) -> Result<Vec<Option<u128>>, String> {
    let w = words(hex).map_err(|e| format!("Aave's {what}: {e}"))?;
    if w.len() < n {
        return Err(format!("Aave's {what} returned {} words, not {n}", w.len()));
    }
    Ok(w.into_iter().map(word_u128).collect())
}

fn need(x: Option<u128>, what: &str, field: &str) -> Result<u128, String> {
    x.ok_or_else(|| format!("Aave's {what} has a {field} too large to be real"))
}

/// `getUserAccountData`: the position as Aave counts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UserAccountData {
    /// All collateral and all debt, in USD with 8 decimals.
    pub collateral_base: u128,
    pub debt_base: u128,
    /// The position's liquidation threshold, in bp (0 with no collateral).
    pub liq_threshold_bp: u32,
    pub ltv_bp: u32,
    /// The health factor, scaled by 1e18. None with no debt (Aave answers the largest uint256).
    pub health_factor: Option<u128>,
}

pub fn user_account_data(hex: &str) -> Result<UserAccountData, String> {
    let what = "getUserAccountData";
    let w = numbers(hex, 6, what)?;
    let bp = |x: Option<u128>, field: &str| {
        need(x, what, field).and_then(|v| u32::try_from(v).map_err(|_| format!("Aave's {what} has no valid {field}")))
    };
    Ok(UserAccountData {
        collateral_base: need(w[0], what, "collateral")?,
        debt_base: need(w[1], what, "debt")?,
        liq_threshold_bp: bp(w[3], "liquidation threshold")?,
        ltv_bp: bp(w[4], "LTV")?,
        health_factor: w[5],
    })
}

impl UserAccountData {
    /// The health factor in bp (15000 is 1.5), capped at `u32::MAX`. None with no debt.
    pub fn hf_bp(&self) -> Option<u32> {
        if self.debt_base == 0 {
            return None;
        }
        let hf = self.health_factor?;
        Some(u32::try_from(hf / (WAD / 10_000)).unwrap_or(u32::MAX))
    }
}

/// `getUserReserveData(asset, user)`: what the user has posted of the asset and owes in it, in the asset's units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UserReserve {
    pub posted: u128,
    /// Stable and variable debt together, with interest.
    pub debt: u128,
    pub is_collateral: bool,
}

pub fn user_reserve(hex: &str) -> Result<UserReserve, String> {
    let what = "getUserReserveData";
    let w = numbers(hex, 9, what)?;
    Ok(UserReserve {
        posted: need(w[0], what, "balance")?,
        debt: need(w[1], what, "stable debt")?.saturating_add(need(w[2], what, "variable debt")?),
        is_collateral: w[8] == Some(1),
    })
}

/// `getReserveConfigurationData(asset)`, the parts the book uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReserveConfig {
    pub decimals: u32,
    pub ltv_bp: u32,
    pub liq_threshold_bp: u32,
    pub is_collateral: bool,
    pub active: bool,
    pub frozen: bool,
}

pub fn reserve_config(hex: &str) -> Result<ReserveConfig, String> {
    let what = "getReserveConfigurationData";
    let w = numbers(hex, 10, what)?;
    let small = |x: Option<u128>, field: &str| {
        need(x, what, field).and_then(|v| u32::try_from(v).map_err(|_| format!("Aave's {what} has no valid {field}")))
    };
    Ok(ReserveConfig {
        decimals: small(w[0], "decimals")?,
        ltv_bp: small(w[1], "LTV")?,
        liq_threshold_bp: small(w[2], "liquidation threshold")?,
        is_collateral: w[5] == Some(1),
        active: w[8] == Some(1),
        frozen: w[9] == Some(1),
    })
}

/// `getReserveData(asset)`: the reserve's yearly rates now, in bp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReserveRates {
    /// What depositors earn and what variable-rate borrowers pay.
    pub supply_bp: u32,
    pub borrow_bp: u32,
}

pub fn reserve_rates(hex: &str) -> Result<ReserveRates, String> {
    let what = "getReserveData";
    let w = numbers(hex, 12, what)?;
    Ok(ReserveRates {
        supply_bp: ray_to_bp(need(w[5], what, "deposit rate")?),
        borrow_bp: ray_to_bp(need(w[6], what, "borrow rate")?),
    })
}

/// How many more units of a token Aave's pool takes before its supply cap is reached, from `getReserveCaps` and
/// `getATokenTotalSupply`. `None`: the reserve has no cap (Aave writes that as 0). The cap is in whole tokens.
///
/// Aave's own check also counts what the reserve owes its treasury, which the supplied figure leaves out, so a
/// supply within a hair of the cap can still be refused there.
pub fn supply_room(caps: &str, supplied: &str, decimals: u32) -> Result<Option<u128>, String> {
    let what = "getReserveCaps";
    let cap = need(numbers(caps, 2, what)?[1], what, "supply cap")?;
    let supplied = single(supplied, "getATokenTotalSupply")?;
    if cap == 0 {
        return Ok(None);
    }
    let cap_units = cap.saturating_mul(10u128.saturating_pow(decimals));
    Ok(Some(cap_units.saturating_sub(supplied)))
}

/// A yearly rate in ray as bp, rounded to the nearest and capped at `u32::MAX`.
pub fn ray_to_bp(ray: u128) -> u32 {
    let per_bp = RAY / 10_000;
    u32::try_from(ray.saturating_add(per_bp / 2) / per_bp).unwrap_or(u32::MAX)
}

/// A call that returns one number (`balanceOf`, `getAssetPrice`, `getVirtualUnderlyingBalance`).
pub fn single(hex: &str, what: &str) -> Result<u128, String> {
    let w = numbers(hex, 1, what)?;
    need(w[0], what, "value")
}

/// `raw` units of a token with `decimals`, priced at `price_base` (USD with 8 decimals), in micro-USD, rounded down.
pub fn value_micro(raw: u128, decimals: u32, price_base: u128) -> u128 {
    // raw / 10^decimals tokens x price / 10^8 dollars x 10^6 micro.
    let scale = 10u128.saturating_pow(decimals.saturating_add(BASE_DECIMALS - 6));
    raw.saturating_mul(price_base) / scale.max(1)
}

/// `raw` units of a token with `decimals` as units with 6 decimals (micro), rounded down, or up with `up`.
pub fn to_micro(raw: u128, decimals: u32, up: bool) -> u128 {
    if decimals <= 6 {
        return raw.saturating_mul(10u128.pow(6 - decimals));
    }
    let d = 10u128.saturating_pow(decimals - 6);
    if up {
        raw.div_ceil(d)
    } else {
        raw / d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_words_decode() {
        let one = format!("0x{:064x}", 1u8);
        assert_eq!(words(&one).unwrap(), vec![&one[2..]]);
        assert_eq!(word_u128(&one[2..]), Some(1));
        let max = "f".repeat(64);
        assert_eq!(word_u128(&max), None);
        assert_eq!(word_u128(&format!("{:064x}", u128::MAX)), Some(u128::MAX));
        assert!(words("0x").unwrap_err().contains("whole 32-byte words"));
        assert!(words("0x12").unwrap_err().contains("whole 32-byte words"));
        assert!(words("12").unwrap_err().contains("0x"));
        assert_eq!(quantity("0x0"), Some(0));
        assert_eq!(quantity("0x1a"), Some(26));
        assert_eq!(quantity("0x"), None);
        assert_eq!(quantity("1a"), None);
    }

    #[test]
    fn call_data_pads_each_address_to_a_word() {
        assert_eq!(
            call_data(BALANCE_OF, &["0x54114591963CF60EF3aA63bEfD6eC263D98145a4"]),
            "0x70a0823100000000000000000000000054114591963cf60ef3aa63befd6ec263d98145a4"
        );
        assert_eq!(
            address("0x54114591963CF60EF3aA63bEfD6eC263D98145a4").as_deref(),
            Some("0x54114591963cf60ef3aa63befd6ec263d98145a4")
        );
        assert_eq!(address("0x5411"), None);
        assert_eq!(address("mnbtc.pbf-ops.testnet"), None);
    }

    #[test]
    fn rates_and_amounts_round_as_documented() {
        // 5.33% a year in ray.
        assert_eq!(ray_to_bp(53_300_000_000_000_000_000_000_000), 533);
        assert_eq!(ray_to_bp(RAY / 10_000 / 2), 1);
        assert_eq!(ray_to_bp(RAY / 10_000 / 2 - 1), 0);
        // 1.31 WBTC (8 decimals) at $73,889.19266048 is $96,794.84 and a bit.
        assert_eq!(value_micro(131_000_000, 8, 7_388_919_266_048), 96_794_842_385);
        assert_eq!(to_micro(1_999_999_999_999, 18, false), 1);
        assert_eq!(to_micro(1_000_000_000_001, 18, true), 2);
        assert_eq!(to_micro(5, 6, true), 5);
        assert_eq!(to_micro(5, 4, false), 500);
    }

    #[test]
    fn rpc_answers_give_their_hex_or_the_error() {
        assert_eq!(
            result_hex(&json!({"jsonrpc": "2.0", "id": 1, "result": "0x1A"})),
            Ok("0x1a".into())
        );
        let e = result_hex(&json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "execution reverted"}}));
        assert_eq!(e, Err("execution reverted".into()));
        assert!(result_hex(&json!({"result": 5})).is_err());
        assert_eq!(chain(84532).map(|c| c.rpc), Some("https://sepolia.base.org"));
        assert_eq!(chain(1), None);
    }

    #[test]
    fn a_batch_answers_in_the_requests_order_or_not_at_all() {
        // The requests at `latest` are what they always were; pinned to a block they name it.
        assert_eq!(
            eth_call("0xab", "0x70a08231"),
            r#"{"id":1,"jsonrpc":"2.0","method":"eth_call","params":[{"data":"0x70a08231","to":"0xab"},"latest"]}"#
        );
        assert_eq!(
            eth_nonce_at("0xab", &block_tag(57_472_001), 7).to_string(),
            r#"{"id":7,"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["0xab","0x36cf401"]}"#
        );
        // A node may answer a batch in any order: the ids put the answers back in the requests' order.
        let reply = json!([{"jsonrpc": "2.0", "id": 2, "result": "0x02"}, {"jsonrpc": "2.0", "id": 1, "result": "0x01"},
            {"jsonrpc": "2.0", "id": 3, "error": {"code": 3, "message": "execution reverted"}}]);
        assert_eq!(batch_results(&reply, 3), Some(vec![Some("0x01".into()), Some("0x02".into()), None]));
        // Anything but a list of the same length is no batch answer: a refusal, a short list, a list with an id
        // answered twice counts that call as unanswered.
        let refusal = json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "batch not supported"}});
        assert_eq!(batch_results(&refusal, 3), None);
        assert_eq!(batch_results(&json!([{"id": 1, "result": "0x01"}]), 3), None);
        let twice = json!([{"id": 1, "result": "0x01"}, {"id": 1, "result": "0x09"}]);
        assert_eq!(batch_results(&twice, 2), Some(vec![None, None]));
    }
}
