//! What the account has at the outside lenders, as the engine counts it (FUNDING.md 6.1 and 6.2, INTERFACES.md 26).
//!
//! `book::build_with` fills a [`LenderBook`] from the lender reads and puts it in `Book::lenders`. pb-risk's cushion
//! rule, split and top-up plan, and pb-gateway's pre-trade checks, all work from it. An account whose config names no
//! lender gets the empty book, and its verdict is what it was before lenders existed, to the byte.
//!
//! How the book counts a lender position:
//! - **Debt.** `Book::account.debt` is the whole debt: our pool's, each lender's, and lender borrows under way
//!   (below). `Book::debt_micro` stays our pool's alone.
//! - **Collateral.** Tokens posted at a lender, and tokens and USDC at the account's Ethereum address, are added to
//!   `Book::account.near` under their engine names, so every rule values them. `Book::locked` says how much of each
//!   is not on NEAR, so no plan step tries to sell or move it from there.
//! - **Actions under way** (`get_state().pending`'s lender entries, and what the account signed for Ethereum).
//!   The account can't see a lender finish an action, so it lists it for a while: Rhea's until a NEAR block has
//!   passed, Aave's until the chain has used the signed transaction's nonce ([`evm_under_way`]). For that while
//!   the lender may or may not show it. The engine counts it as done:
//!   - **A borrow** is debt at that lender ([`LenderPos::pending_micro`]), and its USDC is in the book as money on
//!     its way, marked as not on NEAR. So equity is what it will be once the loan lands, and never looks lower.
//!   - **A withdrawal** is collateral already gone from the lender: out of [`LenderPos::posted_micro`], so the
//!     cushion and the room are worked out without it. The token stays the account's own (it is on its way to the
//!     account), so the book's holdings don't change.
//!   - **A transfer** away from the account's Ethereum address is a token already gone from the book.
//! - **Aave's tokens** (stage 3) are WBTC and wrapped ether, which is the engine's ETH token. Each is valued at
//!   Aave's own oracle price. Aave caps how much of a token its pool takes: what sits at the address counts as
//!   spare collateral only as far as the cap has room, and the rest is held but can't be posted
//!   ([`LenderPos::stuck`]).
//!
//!   Once the lender shows the action and its block hasn't passed, the action counts twice: the debt and its USDC
//!   both too high by the borrow, the cushion's collateral too low by the withdrawal. That errs toward less new
//!   risk, and the account allows none meanwhile. A top-up goes by what the lender itself shows
//!   (`pb_risk::lenders::top_ups`), so a loan counted twice is never repaid by mistake.
use crate::steps::PlanStep;
use std::collections::BTreeMap;

/// The lenders' names, as the permission, the steps and the verdict's `ext` write them.
pub const AAVE: &str = "aave";
pub const RHEA: &str = "rhea";

/// An amount of one token at a lender or beside it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Holding {
    /// The engine's name for the token: `nBTC`, `WBTC`.
    pub engine: String,
    /// The token's id where it sits: a NEAR account id for Rhea, a `0x` address (lower case) for Aave.
    pub id: String,
    pub decimals: u32,
    /// In the token's own units.
    pub raw: u128,
}

/// The account's position at one lender, and that lender's terms now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LenderPos {
    /// `aave` or `rhea`.
    pub lender: String,
    /// Whether the account's permission names this lender now. A cancelled permission leaves the position readable
    /// and its top-ups running, but allows no new borrowing there.
    pub permitted: bool,
    /// Collateral posted at the lender.
    pub posted: Vec<Holding>,
    /// Collateral the account holds on the lender's chain but hasn't posted, which an `l_supply` or `l_add` step can
    /// post: for Rhea, the config's Rhea collateral tokens on NEAR; for Aave, its collateral tokens at the account's
    /// Ethereum address, as far as Aave's supply cap for each still has room.
    pub spare: Vec<Holding>,
    /// Aave only: collateral tokens at the account's Ethereum address that Aave's pool has no room for now (its
    /// supply cap is reached). They count in the book and can be withdrawn, but no step posts them.
    pub stuck: Vec<Holding>,
    /// The symbols of the tokens in `stuck`, for the words: "Aave's pool for WBTC is full".
    pub full: Vec<String>,
    /// USDC the account holds on the lender's chain, which an `l_repay` step can use (micro-USD): its NEAR USDC for
    /// Rhea, the USDC at its Ethereum address for Aave.
    pub cash_micro: u128,
    /// The posted and the spare collateral's value, as the lender counts collateral (micro-USD): at the lender's own
    /// price where it publishes one, else at the engine's reference price, with no depeg ratio. `posted_micro` is
    /// less what is on its way back to the account (`leaving_micro`).
    pub posted_micro: u128,
    pub spare_micro: u128,
    /// Posted collateral the account has asked back (`pending`'s withdrawals whose block hasn't passed), valued the
    /// same way. The lender may still show it, so `posted_micro + leaving_micro` is at most what the lender shows.
    pub leaving_micro: u128,
    /// The USDC debt at the lender, with interest (micro-USD).
    pub debt_micro: u128,
    /// Lender borrows under way (micro-USD): `pending`'s borrows whose block hasn't passed, which the lender may or
    /// may not show yet, and Ethereum borrows the account signed that the chain hasn't mined.
    pub pending_micro: u128,
    /// The lender liquidates when debt passes this share of the collateral's value, in bp: for Rhea 7600 (nBTC's 0.80
    /// times USDC's 0.95); for Aave, the collateral's liquidation threshold.
    pub liq_bp: u32,
    /// The health factor in bp, the lender's own figure where it gives one: what the lender shows now, with no
    /// action under way counted. `None` with no debt.
    pub hf_bp: Option<u32>,
    /// The lender's USDC borrow and deposit rates now, in bp a year.
    pub rate_bp: u32,
    pub supply_bp: u32,
    /// The USDC the lender has free to lend now (micro-USD).
    pub free_micro: u128,
}

impl LenderPos {
    /// Everything the book counts as owed to this lender (micro-USD).
    pub fn owed_micro(&self) -> u128 {
        self.debt_micro.saturating_add(self.pending_micro)
    }

    /// The posted collateral's value as the lender shows it now, withdrawals under way included (micro-USD).
    pub fn shown_micro(&self) -> u128 {
        self.posted_micro.saturating_add(self.leaving_micro)
    }
}

/// The funding plan the account holds (`get_state().funding`, INTERFACES.md 25), while it has unfinished steps and
/// hasn't expired.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredFunding {
    /// `f` and the `blk` of the verdict it came from.
    pub pid: String,
    /// What the owner asked for in all (micro-USD).
    pub amount_micro: u128,
    pub expires_ns: u64,
    /// Each step, and whether the account has started it.
    pub steps: Vec<(PlanStep, bool)>,
}

/// Every lender position of one account. Empty when the account's config names no lender.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LenderBook {
    /// One entry per lender in the account's config, `aave` before `rhea`.
    pub positions: Vec<LenderPos>,
    /// The permission's smallest cushion and dearest lender rate, in bp. `None` when the account has no permission.
    pub min_hf_bp: Option<u32>,
    pub max_rate_bp: Option<u32>,
    /// The account's Ethereum nonce on Aave's chain, when Aave is in the config.
    pub evm_nonce: Option<u64>,
    pub funding: Option<StoredFunding>,
    /// Engine token name -> the units of `Book::account.near` that are not on NEAR (posted at a lender, or at the
    /// account's Ethereum address), in the token's smallest units where it sits: 8 decimals for nBTC and WBTC, 18
    /// for wrapped ether, micro-USD for USDC.
    pub locked: BTreeMap<String, u128>,
}

impl LenderBook {
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    pub fn get(&self, lender: &str) -> Option<&LenderPos> {
        self.positions.iter().find(|p| p.lender == lender)
    }

    /// Everything the book counts as owed to lenders (micro-USD).
    pub fn owed_micro(&self) -> u128 {
        self.positions.iter().fold(0u128, |sum, p| sum.saturating_add(p.owed_micro()))
    }
}

// ---------------------------------------------------------------------------------- what the lender reads say

use crate::evm;
use crate::inputs::{AaveReads, RheaReads};
use crate::near::{AaveConf, ClientState, Config, RheaConf};
use crate::util::{bp, f64_of, pow10, u128_of, u64_of};
use serde_json::Value;

/// How a lender prices one of its collateral tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LenderPrice {
    /// Aave's oracle: dollars with 8 decimals for one whole token.
    Aave(u128),
    /// Rhea's `default_price` for the token: one of its smallest units is worth `multiplier / 10^decimals` dollars
    /// (`Price` in burrowland's `common` crate; `BigDecimal::from_balance_price`).
    Rhea { multiplier: u128, decimals: u32 },
    /// The lender publishes no price the engine can read (Rhea takes it from Pyth when it acts): the engine's
    /// reference price is used.
    Engine,
}

impl LenderPrice {
    /// `h` valued as the lender counts collateral, in micro-USD, rounded down. `engine_px` is the engine's reference
    /// price for one whole token, with no depeg ratio.
    pub fn value_micro(&self, h: &Holding, engine_px: f64) -> u128 {
        match *self {
            LenderPrice::Aave(base) => evm::value_micro(h.raw, h.decimals, base),
            LenderPrice::Rhea { multiplier, decimals } => {
                let (num, scale) = (h.raw.saturating_mul(multiplier), decimals.saturating_sub(6));
                let num = num.saturating_mul(10u128.pow(6u32.saturating_sub(decimals)));
                num / 10u128.saturating_pow(scale).max(1)
            }
            LenderPrice::Engine => {
                let x = (h.raw as f64 / pow10(h.decimals) * engine_px * 1e6).floor();
                if x.is_finite() && x > 0.0 {
                    x as u128
                } else {
                    0
                }
            }
        }
    }
}

/// One lender position as read, before the book's prices: the units, the lender's own figures, and how it prices
/// each collateral token (by engine name).
#[derive(Clone, Debug, PartialEq)]
pub struct ReadPos {
    /// Units, debt, rates and what is free are filled; `posted_micro`, `spare_micro`, `leaving_micro` and (for Rhea)
    /// `liq_bp` and `hf_bp` wait for [`ReadPos::priced`].
    pub pos: LenderPos,
    /// What the account has asked back of each posted holding ([`leaving`]), in the token's units.
    pub leaving: Vec<Holding>,
    pub prices: BTreeMap<String, LenderPrice>,
    /// Rhea only: each collateral token's volatility ratio in bp (by engine name), and USDC's.
    pub ratios: BTreeMap<String, u32>,
    pub usdc_ratio_bp: u32,
}

impl ReadPos {
    /// The finished position: collateral valued as the lender counts it, and for Rhea the liquidation share and the
    /// health factor computed its way (collateral times its ratio, rounded down, over debt divided by USDC's ratio,
    /// rounded up; `position.rs` in burrowland). `engine_px` gives the engine's reference price of an engine token.
    pub fn priced(mut self, engine_px: &dyn Fn(&str) -> f64) -> LenderPos {
        let value = |h: &Holding| {
            self.prices
                .get(&h.engine)
                .copied()
                .unwrap_or(LenderPrice::Engine)
                .value_micro(h, engine_px(&h.engine))
        };
        // What the lender shows, and of that, what is on its way back to the account.
        let shown = self.pos.posted.iter().map(&value).fold(0, u128::saturating_add);
        self.pos.leaving_micro = self.leaving.iter().map(&value).fold(0, u128::saturating_add).min(shown);
        self.pos.posted_micro = shown - self.pos.leaving_micro;
        self.pos.spare_micro = self.pos.spare.iter().map(&value).fold(0, u128::saturating_add);
        if self.pos.lender == RHEA {
            let usdc = u128::from(self.usdc_ratio_bp);
            let share = |ratio: u32| (u128::from(ratio) * usdc / 10_000) as u32;
            // Posted collateral at each token's own ratio.
            let adjusted = self
                .pos
                .posted
                .iter()
                .map(|h| value(h).saturating_mul(u128::from(self.ratios.get(&h.engine).copied().unwrap_or(0))) / 10_000)
                .fold(0, u128::saturating_add);
            self.pos.liq_bp = if shown > 0 {
                // The posted tokens' ratios, weighted by value, times USDC's. With one collateral token this is
                // exactly its ratio times USDC's (7600 for nBTC).
                let weighted = self
                    .pos
                    .posted
                    .iter()
                    .map(|h| value(h).saturating_mul(u128::from(self.ratios.get(&h.engine).copied().unwrap_or(0))))
                    .fold(0, u128::saturating_add);
                (weighted.saturating_mul(usdc) / shown.saturating_mul(10_000)) as u32
            } else {
                // Nothing posted yet: the lowest of the tokens it could post.
                self.ratios.values().copied().map(share).min().unwrap_or(0)
            };
            self.pos.hf_bp = (self.pos.debt_micro > 0 && usdc > 0).then(|| {
                let owed = self.pos.debt_micro.saturating_mul(10_000).div_ceil(usdc);
                u32::try_from(adjusted.saturating_mul(10_000) / owed).unwrap_or(u32::MAX)
            });
        }
        self.pos
    }
}

/// Borrows from `lender` the account has sent that the lender may not show yet: `pending`'s lender entries whose
/// block hasn't passed at `height` (micro-USD).
fn pending_borrows(client: &ClientState, lender: &str, height: u64) -> u128 {
    client
        .lender_pending
        .iter()
        .filter(|p| p.lender == lender && p.kind == "borrow" && p.waits_at_block(height))
        .fold(0u128, |sum, p| sum.saturating_add(p.amount))
}

/// Counts `amount` units of posted collateral as on their way back: of the posted holding `token` names, and with
/// no token named, of the one holding posted (with several posted, of each of them, which is the strict reading).
/// Never more than is posted.
fn take_back(leaving: &mut Vec<Holding>, posted: &[Holding], token: Option<&str>, amount: u128) {
    if amount == 0 {
        return;
    }
    for h in posted.iter().filter(|h| token.is_none_or(|t| h.id.eq_ignore_ascii_case(t))) {
        match leaving.iter_mut().find(|l| l.id == h.id) {
            Some(l) => l.raw = l.raw.saturating_add(amount).min(h.raw),
            None => leaving.push(Holding { raw: amount.min(h.raw), ..h.clone() }),
        }
    }
}

/// Collateral the account has asked back from `lender` that the lender may still show: the units of `pending`'s
/// withdrawals whose block hasn't passed at `height`, per posted holding ([`take_back`]).
fn leaving(client: &ClientState, lender: &str, posted: &[Holding], height: u64) -> Vec<Holding> {
    let mut out = Vec::new();
    let waiting = client
        .lender_pending
        .iter()
        .filter(|p| p.lender == lender && p.kind == "withdraw" && p.waits_at_block(height));
    for p in waiting {
        take_back(&mut out, posted, p.token.as_deref(), p.amount);
    }
    out
}

/// What an Ethereum transaction the account signed does, while the chain hasn't used its nonce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvmKind {
    /// A borrow at Aave: debt there, and its USDC on its way to the address.
    Borrow,
    /// Aave's `withdraw`: collateral leaves Aave for the account's own address.
    Withdraw,
    /// A token's `transfer`: it leaves the address, and the book.
    Transfer,
}

/// One action under way on Ethereum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmAction {
    pub nonce: u64,
    pub kind: EvmKind,
    /// The token's 0x address in lower case, when known.
    pub token: Option<String>,
    /// In the token's own units.
    pub amount: u128,
}

/// The stale-signature rule (FUNDING.md 4.5; INTERFACES.md 33): a signed Ethereum transaction never expires and
/// anyone can send it, so a borrow, a withdrawal or a transfer the account signed counts as done while the chain's
/// count of the address's transactions, `chain_nonce`, is at most its nonce. Once the chain has used the nonce,
/// mined or reverted, the chain's own reading is the truth.
///
/// One action per nonce, from the two places the account shows it: the transactions it signed (`evm.signed`, the
/// newest 20), and `pending`'s Aave entries (`evm_nonce`), which are never trimmed and whose `kind` is `borrow`,
/// `withdraw` or `transfer`. Either place is enough by itself. The same transaction in both counts once, and so
/// does one signed again with a higher fee.
pub fn evm_under_way(client: &ClientState, chain_nonce: u64) -> Vec<EvmAction> {
    let mut by_nonce: BTreeMap<u64, EvmAction> = BTreeMap::new();
    let signed = client.evm.as_ref().map_or(&[][..], |e| e.signed.as_slice());
    for s in signed.iter().filter(|s| s.nonce >= chain_nonce) {
        let kind = match s.kind.as_str() {
            "borrow" => EvmKind::Borrow,
            "withdraw" => EvmKind::Withdraw,
            "transfer" => EvmKind::Transfer,
            _ => continue, // approve, supply, repay: they add no risk
        };
        let token = Some(s.token.clone()).filter(|t| !t.is_empty());
        let action = by_nonce.entry(s.nonce).or_insert(EvmAction { nonce: s.nonce, kind, token, amount: 0 });
        action.amount = action.amount.max(s.amount);
    }
    for p in client.lender_pending.iter().filter(|p| p.lender == AAVE) {
        let crate::near::Wait::EvmNonce(nonce) = p.until else {
            continue;
        };
        let kind = match p.kind.as_str() {
            "borrow" => EvmKind::Borrow,
            "withdraw" => EvmKind::Withdraw,
            "transfer" => EvmKind::Transfer,
            _ => continue,
        };
        if nonce < chain_nonce {
            continue;
        }
        let action = by_nonce.entry(nonce).or_insert(EvmAction { nonce, kind, token: p.token.clone(), amount: 0 });
        action.amount = action.amount.max(p.amount);
    }
    by_nonce.into_values().collect()
}

fn permitted(client: &ClientState, lender: &str) -> bool {
    client
        .permission
        .as_ref()
        .is_some_and(|p| p.lenders.iter().any(|l| l == lender))
}

/// A Rhea amount (a decimal string in the asset's inner decimals: the token's plus `extra`) in the token's own units.
fn rhea_units(v: Option<&Value>, extra: u32, up: bool) -> Option<u128> {
    let inner = v.and_then(u128_of)?;
    let d = 10u128.checked_pow(extra)?;
    Some(if up { inner.div_ceil(d) } else { inner / d })
}

/// The Rhea position (FUNDING.md 6.1): `get_account`, `get_assets` and each token's price setting, as burrowland's
/// views return them (`account_view.rs`, `asset_view.rs`, `pyth.rs`; the fields used are the same in 0.15.7 and in
/// mainnet's 0.16.2). `raw_balance` is the account's NEAR balance per token id.
pub fn rhea_position(
    reads: &RheaReads,
    rhea: &RheaConf,
    conf: &Config,
    client: &ClientState,
    raw_balance: &BTreeMap<String, u128>,
    height: u64,
) -> Result<ReadPos, String> {
    let usdc = conf
        .tokens
        .iter()
        .find(|t| t.name == "USDC")
        .ok_or("the account's config names Rhea but lists no USDC token")?;
    let asset = |id: &str| -> Result<&Value, String> {
        reads
            .assets
            .as_array()
            .and_then(|list| list.iter().find(|a| a.get("token_id").and_then(Value::as_str) == Some(id)))
            .ok_or_else(|| format!("Rhea's get_assets has no asset {id}"))
    };
    let field = |a: &Value, path: &str, id: &str| -> Result<u64, String> {
        a.pointer(path)
            .and_then(u64_of)
            .ok_or_else(|| format!("Rhea's asset {id} has no {}", path.trim_start_matches('/').replace('/', ".")))
    };
    let extra_of = |id: &str| -> Result<u32, String> {
        Ok(field(asset(id)?, "/config/extra_decimals", id)?.min(38) as u32)
    };
    let mut out = ReadPos {
        pos: LenderPos {
            lender: RHEA.to_string(),
            permitted: permitted(client, RHEA),
            ..LenderPos::default()
        },
        leaving: Vec::new(),
        prices: BTreeMap::new(),
        ratios: BTreeMap::new(),
        usdc_ratio_bp: 0,
    };
    // USDC: its ratio, rates and what is free (`Asset::available_amount`).
    let u = asset(&usdc.id)?;
    let usdc_extra = extra_of(&usdc.id)?;
    out.usdc_ratio_bp = field(u, "/config/volatility_ratio", &usdc.id)? as u32;
    let rate = |k: &str| {
        u.get(k)
            .and_then(f64_of)
            .map(|x| bp(x) as u32)
            .ok_or_else(|| format!("Rhea's USDC asset has no {k}"))
    };
    out.pos.rate_bp = rate("borrow_apr")?;
    out.pos.supply_bp = rate("supply_apr")?;
    let amount = |path: &str| -> Result<u128, String> {
        u.pointer(path)
            .and_then(u128_of)
            .ok_or_else(|| format!("Rhea's USDC asset has no {}", path.trim_start_matches('/').replace('/', ".")))
    };
    let free_inner = (amount("/supplied/balance")? + amount("/reserved")? + amount("/prot_fee")?)
        .saturating_sub(amount("/borrowed/balance")?)
        // Margin trading's claims on the asset; versions without it leave the fields out.
        .saturating_sub(u.pointer("/margin_debt/balance").and_then(u128_of).unwrap_or(0))
        .saturating_sub(u.get("margin_pending_debt").and_then(u128_of).unwrap_or(0));
    out.pos.free_micro = evm::to_micro(free_inner, usdc.decimals + usdc_extra, false);
    out.pos.cash_micro = evm::to_micro(raw_balance.get(&usdc.id).copied().unwrap_or(0), usdc.decimals, false);

    // The collateral tokens: ratio, price setting, what is posted and what is spare on NEAR.
    let list = |k: &str| -> Result<&[Value], String> {
        match reads.account.get(k) {
            Some(Value::Array(a)) => Ok(a.as_slice()),
            _ if reads.account.is_null() => Ok(&[]), // never used Rhea
            _ => Err(format!("Rhea's get_account has no {k} list")),
        }
    };
    let entry_of = |entries: &[Value], id: &str| -> Option<Value> {
        entries
            .iter()
            .find(|e| e.get("token_id").and_then(Value::as_str) == Some(id))
            .cloned()
    };
    let collateral = list("collateral")?;
    for id in &rhea.collateral {
        let t = conf
            .tokens
            .iter()
            .find(|t| &t.id == id)
            .ok_or_else(|| format!("the Rhea collateral {id} is not one of the account's tokens"))?;
        let a = asset(id)?;
        out.ratios
            .insert(t.engine.to_string(), field(a, "/config/volatility_ratio", id)? as u32);
        let price = match reads.prices.get(id).map(|p| p.get("default_price")) {
            Some(Some(d)) if !d.is_null() => {
                let multiplier = d.get("multiplier").and_then(u128_of);
                let decimals = d.get("decimals").and_then(u64_of).filter(|x| *x <= 60);
                match (multiplier, decimals) {
                    (Some(m), Some(dec)) if m > 0 => LenderPrice::Rhea { multiplier: m, decimals: dec as u32 },
                    _ => return Err(format!("Rhea's default price for {id} is not a price")),
                }
            }
            Some(_) => LenderPrice::Engine,
            None => return Err(format!("Rhea's price setting for {id} wasn't read")),
        };
        out.prices.insert(t.engine.to_string(), price);
        let holding = |raw: u128| Holding {
            engine: t.engine.to_string(),
            id: id.clone(),
            decimals: t.decimals,
            raw,
        };
        if let Some(e) = entry_of(collateral, id) {
            let raw = rhea_units(e.get("balance"), extra_of(id)?, false)
                .ok_or_else(|| format!("Rhea's get_account has no balance for {id}"))?;
            if raw > 0 {
                out.pos.posted.push(holding(raw));
            }
        }
        match raw_balance.get(id).copied().unwrap_or(0) {
            0 => {}
            raw => out.pos.spare.push(holding(raw)),
        }
    }
    // The debt: USDC only. Anything else owed there is a loan the engine can't count, so it refuses.
    for e in list("borrowed")? {
        let id = e.get("token_id").and_then(Value::as_str).unwrap_or("?");
        if id != usdc.id {
            return Err(format!(
                "the account owes {id} at Rhea, and the engine counts only USDC debt there: repay it first"
            ));
        }
        let raw = rhea_units(e.get("balance"), usdc_extra, true)
            .ok_or("Rhea's get_account has no balance for the USDC debt")?;
        out.pos.debt_micro = evm::to_micro(raw, usdc.decimals, true);
    }
    out.pos.pending_micro = pending_borrows(client, RHEA, height);
    out.leaving = leaving(client, RHEA, &out.pos.posted, height);
    Ok(out)
}

/// The Aave position (FUNDING.md 6.1) from the calls' hex answers, and the account's nonce on that chain. The
/// account's own figures are zero when it has no Ethereum address yet.
pub fn aave_position(reads: &AaveReads, aave: &AaveConf, client: &ClientState, height: u64) -> Result<(ReadPos, Option<u64>), String> {
    if reads.chain_id != aave.chain_id {
        return Err(format!(
            "Aave was read on chain {}, but the account's config names chain {}",
            reads.chain_id, aave.chain_id
        ));
    }
    let call = |key: &str| -> Result<&str, String> {
        reads
            .calls
            .get(key)
            .map(String::as_str)
            .ok_or_else(|| format!("Aave's {key} wasn't read"))
    };
    let mut out = ReadPos {
        pos: LenderPos {
            lender: AAVE.to_string(),
            permitted: permitted(client, AAVE),
            ..LenderPos::default()
        },
        leaving: Vec::new(),
        prices: BTreeMap::new(),
        ratios: BTreeMap::new(),
        usdc_ratio_bp: 0,
    };
    let rates = evm::reserve_rates(call("reserve")?)?;
    out.pos.rate_bp = rates.borrow_bp;
    out.pos.supply_bp = rates.supply_bp;
    out.pos.free_micro = evm::to_micro(
        evm::single(call("free")?, "getVirtualUnderlyingBalance")?,
        aave.usdc.decimals,
        false,
    );
    // What the account signed that the chain hasn't used yet counts as done ([`evm_under_way`]).
    let has_address = reads.address.is_some();
    let mut nonce = None;
    let mut under_way = Vec::new();
    if has_address {
        let n = evm::quantity(call("nonce")?).ok_or("the Ethereum nonce read is not a number")?;
        nonce = Some(n);
        under_way = evm_under_way(client, n);
    }
    // Units of a token that are on their way out of the address: its transfers under way. One that names no token
    // counts against each collateral token, never against USDC.
    let leaving_address = |token: &str, is_usdc: bool| {
        under_way
            .iter()
            .filter(|a| a.kind == EvmKind::Transfer)
            .filter(|a| a.token.as_deref().map_or(!is_usdc, |t| t == token))
            .fold(0u128, |sum, a| sum.saturating_add(a.amount))
    };
    // With no position yet, the cushion is the collateral's own threshold: the lowest of those it could post.
    let mut threshold = None::<u32>;
    for t in &aave.collateral {
        let c = evm::reserve_config(call(&format!("config:{}", t.address))?)?;
        if c.decimals != t.decimals {
            return Err(format!(
                "Aave says {} has {} decimals, but the account's config says {}",
                t.symbol, c.decimals, t.decimals
            ));
        }
        threshold = Some(threshold.map_or(c.liq_threshold_bp, |x| x.min(c.liq_threshold_bp)));
        let price = evm::single(call(&format!("price:{}", t.address))?, "getAssetPrice")?;
        if price == 0 {
            return Err(format!("Aave's oracle has no price for {}", t.symbol));
        }
        out.prices.insert(t.engine.to_string(), LenderPrice::Aave(price));
        // How much more of the token the pool takes before its supply cap. None: it has no cap.
        let room = evm::supply_room(
            call(&format!("caps:{}", t.address))?,
            call(&format!("supplied:{}", t.address))?,
            t.decimals,
        )?;
        if !has_address {
            continue;
        }
        let holding = |raw: u128| Holding {
            engine: t.engine.to_string(),
            id: t.address.clone(),
            decimals: t.decimals,
            raw,
        };
        let posted = evm::user_reserve(call(&format!("posted:{}", t.address))?)?.posted;
        if posted > 0 {
            out.pos.posted.push(holding(posted));
        }
        // What sits at the address, less what is leaving it. A step can post it as far as the cap has room.
        let held = evm::single(call(&format!("balance:{}", t.address))?, "balanceOf")?
            .saturating_sub(leaving_address(&t.address, false));
        let can_post = room.map_or(held, |r| held.min(r));
        if can_post > 0 {
            out.pos.spare.push(holding(can_post));
        }
        if held > can_post {
            out.pos.stuck.push(holding(held - can_post));
            out.pos.full.push(t.symbol.clone());
        }
    }
    out.pos.liq_bp = threshold.unwrap_or(0);
    if has_address {
        let account = evm::user_account_data(call("account")?)?;
        if account.collateral_base > 0 {
            out.pos.liq_bp = account.liq_threshold_bp;
        }
        out.pos.hf_bp = account.hf_bp();
        // The USDC owed, and never less than everything Aave says the address owes (dollars with 8 decimals).
        let usdc_debt = evm::to_micro(evm::user_reserve(call("debt")?)?.debt, aave.usdc.decimals, true);
        out.pos.debt_micro = usdc_debt.max(evm::to_micro(account.debt_base, evm::BASE_DECIMALS, true));
        let cash = evm::single(call(&format!("balance:{}", aave.usdc.address))?, "balanceOf")?
            .saturating_sub(leaving_address(&aave.usdc.address, true));
        out.pos.cash_micro = evm::to_micro(cash, aave.usdc.decimals, false);
    }
    out.pos.pending_micro = pending_borrows(client, AAVE, height);
    out.leaving = leaving(client, AAVE, &out.pos.posted, height);
    for action in &under_way {
        let token = action.token.as_deref();
        match action.kind {
            // The account borrows USDC and nothing else, so the amount is USDC's.
            EvmKind::Borrow => {
                let micro = evm::to_micro(action.amount, aave.usdc.decimals, true);
                out.pos.pending_micro = out.pos.pending_micro.saturating_add(micro);
            }
            // Collateral on its way from Aave to the address: gone from the cushion, still the account's.
            EvmKind::Withdraw if token != Some(aave.usdc.address.as_str()) => {
                take_back(&mut out.leaving, &out.pos.posted, token, action.amount);
            }
            _ => {}
        }
    }
    Ok((out, nonce))
}
