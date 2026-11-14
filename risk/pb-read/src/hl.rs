//! What the Hyperliquid reads say: the account (cash, positions, resting orders) and, per coin, its market
//! (oracle and mark prices, maximum leverage, live margin tiers, and whether version 0 can use it).
use crate::util::{f64_of, u64_of};
use risk_core::hl::Tier;
use risk_core::{Order, OrderedMap};
use serde_json::{json, Value};

/// The Hyperliquid side of the account, as the engine's `Account` holds it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HlAccount {
    /// Realised collateral: account value less open PnL.
    pub cash: f64,
    pub perps: OrderedMap<f64>,
    pub entry: OrderedMap<f64>,
    pub orders: Vec<Order>,
}

/// Where a Hyperliquid account keeps its USDC (research/hyperliquid.md, "Account modes").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Separate perp and spot balances: perp margin is `clearinghouseState`'s account value. `userAbstraction`
    /// answers `"disabled"` when chosen, and `"default"` for an account that never chose (measured 8 Nov).
    Standard,
    /// One USDC balance for spot and every cross position, in `spotClearinghouseState`. Its `total` moves with the
    /// open PnL, so it is the account value; `clearinghouseState` shows only the margin in use.
    Unified,
}

/// The mode from a `userAbstraction` answer. Null (inputs read before Phase 3) is read as standard. Portfolio margin
/// and the discontinued DEX abstraction lend and borrow across assets, which version 0 can't value.
pub fn mode(abstraction: &Value) -> Result<Mode, String> {
    match abstraction {
        Value::Null => Ok(Mode::Standard),
        Value::String(s) => match s.as_str() {
            "default" | "disabled" => Ok(Mode::Standard),
            "unifiedAccount" => Ok(Mode::Unified),
            other => Err(format!(
                "the Hyperliquid account is in mode {other:?}, which version 0 doesn't value (only standard and unified accounts)"
            )),
        },
        _ => Err("Hyperliquid's userAbstraction answer is not a string".into()),
    }
}

/// The USDC `total` of a `spotClearinghouseState` answer; 0 if it holds none.
pub fn spot_usdc(spot: &Value) -> Result<f64, String> {
    let balances = spot
        .get("balances")
        .and_then(Value::as_array)
        .ok_or("Hyperliquid's spotClearinghouseState has no balances")?;
    match balances
        .iter()
        .find(|b| b.get("coin").and_then(Value::as_str) == Some("USDC"))
    {
        None => Ok(0.0),
        Some(b) => b
            .get("total")
            .and_then(f64_of)
            .ok_or_else(|| "Hyperliquid's spot USDC balance has no total".to_string()),
    }
}

/// The account as one run read it, valued for its mode.
pub fn account_of(r: &crate::inputs::HlReads) -> Result<HlAccount, String> {
    if r.state.is_null() {
        return Ok(HlAccount::default());
    }
    let value = match mode(&r.abstraction)? {
        Mode::Standard => account_value(&r.state)?,
        Mode::Unified => spot_usdc(&r.spot)?,
    };
    account_valued(&r.state, &r.orders, value)
}

/// `clearinghouseState`'s account value: a standard account's perp margin.
fn account_value(state: &Value) -> Result<f64, String> {
    state
        .pointer("/marginSummary/accountValue")
        .and_then(f64_of)
        .ok_or_else(|| "Hyperliquid's clearinghouseState has no account value".to_string())
}

/// `clearinghouseState` and `frontendOpenOrders` of a standard account. Null for both means no Hyperliquid address.
pub fn account(state: &Value, orders: &Value) -> Result<HlAccount, String> {
    if state.is_null() {
        return Ok(HlAccount::default());
    }
    account_valued(state, orders, account_value(state)?)
}

/// Positions and resting orders from `state` and `orders`, with `value` as the account value.
fn account_valued(state: &Value, orders: &Value, value: f64) -> Result<HlAccount, String> {
    let mut out = HlAccount::default();
    let mut upnl = 0.0;
    for p in state
        .get("assetPositions")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let pos = p.get("position").unwrap_or(&Value::Null);
        let coin = pos.get("coin").and_then(Value::as_str);
        let (szi, entry, pnl) = (
            pos.get("szi").and_then(f64_of),
            pos.get("entryPx").and_then(f64_of),
            pos.get("unrealizedPnl").and_then(f64_of),
        );
        let (Some(coin), Some(szi), Some(entry), Some(pnl)) = (coin, szi, entry, pnl) else {
            return Err("a Hyperliquid position lacks its coin, size, entry or PnL".into());
        };
        if szi != 0.0 {
            out.perps.insert(coin, szi);
            out.entry.insert(coin, entry);
            upnl += pnl;
        }
    }
    out.cash = value - upnl;
    for o in orders.as_array().map_or(&[][..], Vec::as_slice) {
        let (coin, side, px, sz) = (
            o.get("coin").and_then(Value::as_str),
            o.get("side").and_then(Value::as_str),
            o.get("limitPx").and_then(f64_of),
            o.get("sz").and_then(f64_of),
        );
        if let (Some(coin), Some(side), Some(px), Some(sz)) = (coin, side, px, sz) {
            out.orders.push(Order {
                coin: coin.to_string(),
                size: if side == "B" { sz } else { -sz },
                limit_px: px,
                reduce_only: o
                    .get("reduceOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    Ok(out)
}

/// One resting order, with the id a cancel names (`frontendOpenOrders`).
#[derive(Clone, Debug, PartialEq)]
pub struct OpenOrder {
    pub coin: String,
    pub oid: u64,
    /// Signed size in coin units: + buy, − sell.
    pub size: f64,
    pub limit_px: f64,
    pub reduce_only: bool,
}

/// The resting orders of a `frontendOpenOrders` answer that carry everything a cancel needs, in its order. An entry
/// without a coin, side, price, size or oid is left out, as the book leaves it out.
pub fn open_orders(orders: &Value) -> Vec<OpenOrder> {
    orders
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|o| {
            let side = o.get("side").and_then(Value::as_str)?;
            let sz = o.get("sz").and_then(f64_of)?;
            Some(OpenOrder {
                coin: o.get("coin").and_then(Value::as_str)?.to_string(),
                oid: o.get("oid").and_then(u64_of)?,
                size: if side == "B" { sz } else { -sz },
                limit_px: o.get("limitPx").and_then(f64_of)?,
                reduce_only: o
                    .get("reduceOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// USDC credited to `address`, from a `userNonFundingLedgerUpdates` answer: `(time ms, USDC)` for each
/// `internalTransfer` (a `usdSend`, how the stand-in delivers) or USDC `send` (a `sendAsset`) whose destination is
/// the address. Both shapes were read on testnet on 8 Nov (research/hyperliquid.md, "The ledger"). Other entries
/// are left out.
pub fn credits(ledger: &Value, address: &str) -> Vec<(u64, f64)> {
    let mut out = Vec::new();
    for e in ledger.as_array().map_or(&[][..], Vec::as_slice) {
        let (Some(time), Some(d)) = (e.get("time").and_then(u64_of), e.get("delta")) else {
            continue;
        };
        let to_us = d
            .get("destination")
            .and_then(Value::as_str)
            .is_some_and(|x| x.eq_ignore_ascii_case(address));
        let usdc = match d.get("type").and_then(Value::as_str) {
            Some("internalTransfer") => d.get("usdc").and_then(f64_of),
            Some("send") if d.get("token").and_then(Value::as_str) == Some("USDC") => d
                .get("usdcValue")
                .or_else(|| d.get("amount"))
                .and_then(f64_of),
            _ => None,
        };
        if let (true, Some(x)) = (to_us, usdc.filter(|x| *x > 0.0)) {
            out.push((time, x));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    out
}

/// The nonces of `open` that a `userNonFundingLedgerUpdates` answer shows as sent by `address` (INTERFACES.md
/// 50.2), in `open`'s order, each once. An entry counts when all three hold:
/// - its `delta.type` is `"send"` (a `sendAsset`, which is what the account signs to move USDC out);
/// - its `delta.user`, the sender, is `address`, whatever the case of the letters;
/// - its `delta.nonce` is the open nonce, as the JSON number Hyperliquid writes.
///
/// Nothing else counts: not an `internalTransfer`, not a `send` to the address, not another user's. Hyperliquid
/// takes each nonce of a signer once (its docs, "Nonces and API wallets"), so a `send` from the address with the
/// nonce of a signature means that signature is spent. The shape was read on testnet on 13 and 14 Nov
/// (`tests/fixtures/testnet/hl_ledger_send.json`). A row of another shape finds no match, and the account's pause
/// then runs its full time.
pub fn sent(ledger: &Value, address: &str, open: &[u64]) -> Vec<u64> {
    let shown: Vec<u64> = ledger
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|e| {
            let d = e.get("delta")?;
            let ours = d.get("type").and_then(Value::as_str) == Some("send")
                && d.get("user")
                    .and_then(Value::as_str)
                    .is_some_and(|u| u.eq_ignore_ascii_case(address));
            d.get("nonce").and_then(Value::as_u64).filter(|_| ours)
        })
        .collect();
    let mut out = Vec::new();
    for n in open {
        if shown.contains(n) && !out.contains(n) {
            out.push(*n);
        }
    }
    out
}

/// One coin's Hyperliquid market.
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    pub oracle: Option<f64>,
    pub mark: Option<f64>,
    pub max_leverage: u32,
    /// The live margin tiers, sorted by lower bound (one tier at the maximum leverage if the table isn't listed).
    pub tiers: Vec<Tier>,
    /// Delisted, or isolated-only: version 0 trades cross margin only, so the coin counts as removed.
    pub unusable: bool,
}

/// An entry of `HlReads::assets`: `{"meta": ..., "ctx": ..., "tiers": [...] | null}`.
pub fn asset(v: &Value) -> Result<Asset, String> {
    let meta = v.get("meta").unwrap_or(&Value::Null);
    let ctx = v.get("ctx").unwrap_or(&Value::Null);
    let max_leverage = meta
        .get("maxLeverage")
        .and_then(u64_of)
        .filter(|&l| l > 0 && l <= 1000)
        .ok_or("a Hyperliquid asset has no maxLeverage")? as u32;
    let mut tiers = Vec::new();
    for t in v
        .get("tiers")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let lb = t.get("lowerBound").and_then(f64_of);
        let lev = t.get("maxLeverage").and_then(u64_of).filter(|&l| l > 0);
        match (lb, lev) {
            (Some(lower_bound), Some(l)) => tiers.push(Tier {
                lower_bound,
                max_leverage: l as u32,
            }),
            _ => return Err("a Hyperliquid margin tier lacks lowerBound or maxLeverage".into()),
        }
    }
    if tiers.is_empty() {
        tiers.push(Tier {
            lower_bound: 0.0,
            max_leverage,
        });
    }
    // As risk-core sorts the compiled-in tables: by (lower bound, max leverage).
    tiers.sort_by(|a, b| {
        a.lower_bound
            .total_cmp(&b.lower_bound)
            .then(a.max_leverage.cmp(&b.max_leverage))
    });
    let flag = |k: &str| meta.get(k).and_then(Value::as_bool).unwrap_or(false);
    Ok(Asset {
        oracle: ctx.get("oraclePx").and_then(f64_of).filter(|p| *p > 0.0),
        mark: ctx.get("markPx").and_then(f64_of).filter(|p| *p > 0.0),
        max_leverage,
        tiers,
        unusable: flag("isDelisted") || flag("onlyIsolated"),
    })
}

/// From a `metaAndAssetCtxs` answer, the entry `HlReads::assets` keeps for `coin`, if Hyperliquid lists it.
pub fn asset_entry(meta_and_ctxs: &Value, coin: &str) -> Option<Value> {
    let meta = meta_and_ctxs.get(0)?;
    let universe = meta.get("universe")?.as_array()?;
    let i = universe
        .iter()
        .position(|a| a.get("name").and_then(Value::as_str) == Some(coin))?;
    let ctx = meta_and_ctxs.get(1)?.as_array()?.get(i)?.clone();
    let table_id = universe[i].get("marginTableId").and_then(u64_of);
    let tiers = meta
        .get("marginTables")
        .and_then(Value::as_array)
        .and_then(|tables| {
            tables
                .iter()
                .find(|t| t.get(0).and_then(u64_of) == table_id && table_id.is_some())
        })
        .and_then(|t| t.get(1)?.get("marginTiers").cloned())
        .unwrap_or(Value::Null);
    // The index is the coin's asset number in signed orders (it differs between networks, research/day1.md 12).
    Some(json!({"meta": universe[i].clone(), "ctx": ctx, "tiers": tiers, "index": i}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_with_a_short() {
        let state = json!({"marginSummary": {"accountValue": "35100.5"},
            "assetPositions": [{"type": "oneWay", "position": {"coin": "BTC", "szi": "-1.27735",
                "entryPx": "78287.0", "unrealizedPnl": "100.5", "leverage": {"type": "cross", "value": 3}}}]});
        let orders = json!([{"coin": "BTC", "side": "A", "limitPx": "80000", "sz": "0.1", "reduceOnly": false}]);
        let a = account(&state, &orders).unwrap();
        assert_eq!(a.cash, 35000.0);
        assert_eq!(a.perps.get("BTC"), Some(&-1.27735));
        assert_eq!(a.entry.get("BTC"), Some(&78287.0));
        assert_eq!(a.orders[0].size, -0.1);
        assert_eq!(
            account(&Value::Null, &Value::Null).unwrap(),
            HlAccount::default()
        );
        assert!(account(&json!({}), &Value::Null).is_err());
    }

    #[test]
    fn account_modes_decide_where_the_usdc_is() {
        use crate::inputs::HlReads;
        // Measured on testnet, 8 Nov (research/hyperliquid.md): a unified account with a position. Its spot USDC
        // total moves with the open PnL; clearinghouseState's account value is only the margin in use.
        let state = json!({"marginSummary": {"accountValue": "1.50482"},
            "assetPositions": [{"position": {"coin": "BTC", "szi": "0.0002", "entryPx": "75250", "unrealizedPnl": "-0.00201"}}]});
        let spot = json!({"balances": [{"coin": "USDC", "token": 0, "total": "998.994426", "hold": "1.50482", "entryNtl": "0.0"}]});
        let read = |mode: &str| HlReads {
            state: state.clone(),
            abstraction: json!(mode),
            spot: spot.clone(),
            ..HlReads::default()
        };
        let unified = account_of(&read("unifiedAccount")).unwrap();
        assert!((unified.cash - (998.994426 + 0.00201)).abs() < 1e-9);
        // "default" (never chosen) and "disabled" are standard: perp margin only; spot USDC is not margin.
        for m in ["default", "disabled"] {
            assert!(
                (account_of(&read(m)).unwrap().cash - (1.50482 + 0.00201)).abs() < 1e-9,
                "{m}"
            );
        }
        // Inputs from before Phase 3 carry no mode, and read as standard, so their verdicts replay unchanged.
        let old = HlReads {
            state: state.clone(),
            ..HlReads::default()
        };
        assert_eq!(
            account_of(&old).unwrap(),
            account(&state, &Value::Null).unwrap()
        );
        // Modes version 0 can't value.
        for m in ["portfolioMargin", "dexAbstraction", "somethingNew"] {
            assert!(account_of(&read(m)).unwrap_err().contains(m), "{m}");
        }
        assert!(mode(&json!(5)).is_err());
        // No USDC in spot is 0; a spot answer without balances is refused.
        assert_eq!(spot_usdc(&json!({"balances": []})), Ok(0.0));
        assert!(spot_usdc(&json!({})).is_err());
    }

    #[test]
    fn open_orders_keep_their_ids() {
        let orders = json!([
            {"coin": "BTC", "side": "A", "limitPx": "80000", "sz": "0.1", "oid": 7, "reduceOnly": false},
            {"coin": "BTC", "side": "B", "limitPx": "70000", "sz": "0.01", "oid": 8, "reduceOnly": true},
            {"coin": "ETH", "side": "B", "limitPx": "2000", "sz": "1"}]);
        let o = open_orders(&orders);
        assert_eq!(o.len(), 2);
        assert_eq!((o[0].oid, o[0].size, o[1].reduce_only), (7, -0.1, true));
    }

    #[test]
    fn credits_are_read_from_the_ledger() {
        // hedge1's ledger on testnet, 8 Nov: the stand-in's delivery, then the move home.
        let ledger = json!([
            {"time": 1794135720398u64, "hash": "0xa7", "delta": {"type": "internalTransfer", "usdc": "429.602143",
                "user": "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "destination": "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0",
                "fee": "1.0"}},
            {"time": 1794136117562u64, "hash": "0x0e", "delta": {"type": "send", "user": "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0",
                "destination": "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "sourceDex": "", "destinationDex": "",
                "token": "USDC", "amount": "427.651787", "usdcValue": "427.651787", "fee": "0.0"}}]);
        assert_eq!(
            credits(&ledger, "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0"),
            vec![(1794135720398, 429.602143)]
        );
        assert_eq!(
            credits(&ledger, "0xFC9D786B69B900EC51DFE8EBBF19ED47BE59009D"),
            vec![(1794136117562, 427.651787)]
        );
        assert!(credits(&Value::Null, "0x1").is_empty());
    }

    /// Hyperliquid testnet's ledger for one account on 13 Nov: the stand-in's delivery, then the account's own
    /// transfer home, signed with nonce 1794584202071 (`get_state().hl.signed[1]`).
    fn live_ledger() -> (Value, String, u64) {
        let f: Value =
            serde_json::from_str(include_str!("../tests/fixtures/testnet/hl_ledger_send.json")).unwrap();
        (
            f["ledger"].clone(),
            f["address"].as_str().unwrap().to_string(),
            f["nonce"].as_u64().unwrap(),
        )
    }

    #[test]
    fn the_ledger_names_the_open_send_it_shows_as_sent_by_the_account() {
        let (ledger, address, nonce) = live_ledger();
        assert_eq!((address.as_str(), nonce), ("0x303d6eccb884202707872ae95bf36049cd5099aa", 1_794_584_202_071));
        assert_eq!(sent(&ledger, &address, &[nonce]), [nonce]);
        // The case of the address's letters doesn't matter, on either side.
        assert_eq!(sent(&ledger, &address.to_uppercase().replace("0X", "0x"), &[nonce]), [nonce]);
        let mut upper = ledger.clone();
        upper[1]["delta"]["user"] = json!("0x303D6ECCB884202707872AE95BF36049CD5099AA");
        assert_eq!(sent(&upper, &address, &[nonce]), [nonce]);
        // Only what is open is named, in the account's order, each once.
        assert!(sent(&ledger, &address, &[]).is_empty());
        assert_eq!(sent(&ledger, &address, &[5, nonce, 7, nonce]), [nonce]);
        let mut two = ledger.clone();
        two.as_array_mut().unwrap().push(json!({"time": 1794584300000u64, "hash": "0x01",
            "delta": {"type": "send", "user": address, "destination": "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d",
                "token": "USDC", "amount": "1.0", "usdcValue": "1.0", "nonce": 1794584290000u64}}));
        assert_eq!(
            sent(&two, &address, &[nonce, 1_794_584_290_000, 1_794_584_295_000]),
            [nonce, 1_794_584_290_000]
        );
        assert!(sent(&Value::Null, &address, &[nonce]).is_empty());
    }

    #[test]
    fn money_coming_in_is_not_a_transfer_sent() {
        let (ledger, address, nonce) = live_ledger();
        // The delivery alone (an `internalTransfer` to the account) names nothing.
        let delivery = json!([ledger[0].clone()]);
        assert!(sent(&delivery, &address, &[nonce]).is_empty());
        // Not even with the account as its user and the open nonce on it: only a `send` counts.
        let mut odd = delivery.clone();
        odd[0]["delta"]["user"] = json!(address);
        odd[0]["delta"]["nonce"] = json!(nonce);
        assert!(sent(&odd, &address, &[nonce]).is_empty());
        // A `send` to the account, from someone else, with the same number: money coming in, not a match.
        let mut inbound = json!([ledger[1].clone()]);
        inbound[0]["delta"]["user"] = json!("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d");
        inbound[0]["delta"]["destination"] = json!(address);
        assert!(sent(&inbound, &address, &[nonce]).is_empty());
    }

    #[test]
    fn another_address_s_send_is_not_a_match() {
        let (ledger, address, nonce) = live_ledger();
        let mut other = ledger.clone();
        other[1]["delta"]["user"] = json!("0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0");
        assert!(sent(&other, &address, &[nonce]).is_empty());
        // Nor is the live row a match for another account that has the same number open.
        assert!(sent(&ledger, "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0", &[nonce]).is_empty());
        // A row with no sender isn't one either.
        let mut nobody = ledger.clone();
        nobody[1]["delta"].as_object_mut().unwrap().remove("user");
        assert!(sent(&nobody, &address, &[nonce]).is_empty());
    }

    #[test]
    fn a_send_with_another_nonce_is_not_a_match() {
        let (ledger, address, nonce) = live_ledger();
        assert!(sent(&ledger, &address, &[nonce + 1]).is_empty());
        assert!(sent(&ledger, &address, &[nonce - 1, 1_794_584_215_350]).is_empty());
        // A row that carries no nonce, or one that isn't a number, names nothing.
        let mut none = ledger.clone();
        none[1]["delta"].as_object_mut().unwrap().remove("nonce");
        assert!(sent(&none, &address, &[nonce]).is_empty());
        let mut text = ledger.clone();
        text[1]["delta"]["nonce"] = json!("1794584202071");
        assert!(sent(&text, &address, &[nonce]).is_empty());
    }

    #[test]
    fn assets_from_meta_and_asset_ctxs() {
        let m = json!([{"universe": [
                {"szDecimals": 2, "name": "SOL", "maxLeverage": 10, "marginTableId": 10},
                {"szDecimals": 5, "name": "BTC", "maxLeverage": 40, "marginTableId": 54},
                {"szDecimals": 0, "name": "ZEC", "maxLeverage": 3, "marginTableId": 3, "isDelisted": true}],
              "marginTables": [[54, {"description": "tiered 40x", "marginTiers": [
                {"lowerBound": "50000.0", "maxLeverage": 10}, {"lowerBound": "0.0", "maxLeverage": 40},
                {"lowerBound": "10000.0", "maxLeverage": 25}]}]]},
            [{"oraclePx": "89.99", "markPx": "90.02"}, {"oraclePx": "75987.9", "markPx": "75800.0"},
             {"oraclePx": "154.33", "markPx": "138.65"}]]);
        let btc = asset(&asset_entry(&m, "BTC").unwrap()).unwrap();
        assert_eq!(
            (btc.oracle, btc.mark, btc.max_leverage),
            (Some(75987.9), Some(75800.0), 40)
        );
        assert_eq!(
            btc.tiers.iter().map(|t| t.max_leverage).collect::<Vec<_>>(),
            [40, 25, 10]
        );
        assert!(!btc.unusable);
        let sol = asset(&asset_entry(&m, "SOL").unwrap()).unwrap();
        assert_eq!(
            sol.tiers,
            vec![Tier {
                lower_bound: 0.0,
                max_leverage: 10
            }]
        );
        assert!(asset(&asset_entry(&m, "ZEC").unwrap()).unwrap().unusable);
        assert!(asset_entry(&m, "XRP").is_none());
        // The entry keeps the coin's asset number, which signed orders use.
        assert_eq!(asset_entry(&m, "BTC").unwrap()["index"], 1);
    }
}
