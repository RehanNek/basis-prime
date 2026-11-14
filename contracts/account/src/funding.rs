//! Funding from lenders (FUNDING.md 4; INTERFACES.md 25).
//!
//! - **The funding plan.** The owner's `fund(amount)` stores the held verdict's `fund` steps, at most 6, in a field of
//!   their own, so a later HEALTHY verdict can't clear them as it clears the unwind plan. Its id is `f` and the
//!   verdict's `blk`. It lasts 30 minutes, and its steps run strictly in order.
//! - **The steps.** Five kinds make a loan: `p_borrow` (our pool), `l_supply` and `l_borrow` (a lender), `to_evm` and
//!   `e_home` (moving collateral out and the loan home). Two more, `l_repay` and `l_add`, only come in a top-up plan
//!   (the verdict's `plan`). All seven are read and checked here. The account runs `p_borrow`, and the four lender
//!   steps at Rhea (`lender.rs`) and at Aave (`evm.rs`). `to_evm` and `e_home` are the mainnet path, where the engine
//!   plans a move with 1Click's own quote: that is not built, and `execute_step` answers that the account can't run
//!   them yet. On testnet the owner starts each move (INTERFACES.md 36): `withdraw` with a `to_evm` transfer, and
//!   `evm_withdraw` with `exp`.
//!
//! What the checks hold to, whatever the engine says (FUNDING.md 4.6): a lender step names a lender in the config,
//! a step that makes a loan also needs the owner's permission to name it, and collateral goes only to a lender as
//! one of that lender's listed tokens.
//!
//! Nothing here panics, because the callbacks use it.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

use pb_types::{Config, Permission, AAVE, RHEA};

use crate::hl::parse_address;
use crate::plan::{int, read, step_views, text, Step};
use crate::records::MINUTE_NS;

/// A verdict's `fund` has at most this many steps.
pub const MAX_FUND_STEPS: usize = 6;
/// A verdict's `ext` has at most this many lenders: Aave and Rhea.
pub const MAX_EXT: usize = 2;
/// A funding plan lasts this long: 30 minutes, because moving bitcoin between chains and borrowing there takes a few.
pub const FUNDING_NS: u64 = 30 * MINUTE_NS;

/// The funding plan the account holds. `amount` is what the owner asked for in all (micro-USD); `stored_at` and
/// `expires_at` are block times (ns).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Funding {
    pub pid: String,
    pub amount: u128,
    pub stored_at: u64,
    pub expires_at: u64,
    pub steps: Vec<Step>,
}

/// The funding plan as `get_state().funding` shows it. Each step is its object with `done` added.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FundingView {
    pub pid: String,
    pub amount: U128,
    pub stored_at: U64,
    pub expires_at: U64,
    pub steps: Vec<Value>,
}

impl Funding {
    /// The plan `fund` stores at `now` from a verdict read at block `blk`, none of its steps started.
    pub fn new(blk: u64, amount: u128, now: u64, steps: Vec<Step>) -> Self {
        Self { pid: format!("f{blk}"), amount, stored_at: now, expires_at: now.saturating_add(FUNDING_NS), steps }
    }

    /// Whether a step is still to start.
    pub fn unfinished(&self) -> bool {
        self.steps.iter().any(|s| !s.done)
    }

    pub fn expired(&self, now: u64) -> bool {
        now > self.expires_at
    }

    pub fn view(&self) -> FundingView {
        FundingView {
            pid: self.pid.clone(),
            amount: U128(self.amount),
            stored_at: U64(self.stored_at),
            expires_at: U64(self.expires_at),
            steps: step_views(&self.steps),
        }
    }
}

/// A funding or lender step, with the fields the account uses (FUNDING.md 4.3; INTERFACES.md 25).
/// - `l` is the lender, `"aave"` or `"rhea"`.
/// - `amt` is micro-USD for a loan or a repayment, and the token's own units for collateral.
/// - `tok` is a NEAR token id, or for Aave a `0x` address on its chain.
/// - `dep` is a 1Click deposit address and `exp` its quote's expiry in unix ms.
#[derive(Clone, Debug, PartialEq)]
pub enum FundStep {
    /// Borrow up to `amt` from our pool.
    PBorrow { amt: u128 },
    /// Post `amt` of `tok` at the lender as collateral.
    LSupply { l: &'static str, tok: String, amt: u128 },
    /// Borrow up to `amt` of USDC from the lender.
    LBorrow { l: &'static str, amt: u128 },
    /// Send `amt` of `tok` to `dep`, which delivers at least `min` of wrapped bitcoin to the account's own address on
    /// Aave's chain.
    ToEvm { tok: AccountId, amt: u128, min: u128, dep: AccountId, exp: u64 },
    /// Send `amt` of USDC on Aave's chain to `dep`, a 0x address that pays the account on NEAR.
    EHome { amt: u128, dep: String, exp: u64 },
    /// Repay the lender up to `amt`. Only in a top-up plan.
    LRepay { l: &'static str, amt: u128 },
    /// Add `amt` of `tok` to the collateral at the lender. Only in a top-up plan.
    LAdd { l: &'static str, tok: String, amt: u128 },
}

impl FundStep {
    /// The step's kind, `k`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::PBorrow { .. } => "p_borrow",
            Self::LSupply { .. } => "l_supply",
            Self::LBorrow { .. } => "l_borrow",
            Self::ToEvm { .. } => "to_evm",
            Self::EHome { .. } => "e_home",
            Self::LRepay { .. } => "l_repay",
            Self::LAdd { .. } => "l_add",
        }
    }

    /// Whether a funding plan may hold the step. `l_repay` and `l_add` come only in a top-up plan.
    pub fn makes_a_loan(&self) -> bool {
        !matches!(self, Self::LRepay { .. } | Self::LAdd { .. })
    }

    /// What the step borrows at most, in micro-USD: 0 for a step that isn't a borrow.
    pub fn borrows(&self) -> u128 {
        match self {
            Self::PBorrow { amt } | Self::LBorrow { amt, .. } => *amt,
            _ => 0,
        }
    }

    /// What running a step the account doesn't run answers: a funding plan's two moves between chains, which are
    /// the mainnet path and not built (the owner starts those moves with calls of their own). It ends the sentence
    /// "step <i> …".
    pub fn not_yet(&self) -> String {
        let k = self.kind();
        format!("is a {k} step: the account can't run {k} steps yet")
    }

    /// Checks the step against the account's settings and the owner's permission. The error ends the sentence
    /// "step <i> …".
    /// - A lender step's lender must be in the config.
    /// - A step that makes a loan there (`l_supply`, `l_borrow`, and `to_evm`, which moves collateral towards Aave)
    ///   also needs the permission to name the lender. A top-up (`l_repay`, `l_add`) and `e_home`, which only brings
    ///   USDC back, run whatever the permission says.
    /// - Collateral must be one of that lender's listed tokens, and `to_evm` sends an allow-listed token other than
    ///   USDC.
    pub fn check(&self, config: &Config, permission: Option<&Permission>) -> Result<(), String> {
        let configured = |l: &str| {
            let has = if l == RHEA { config.lenders.rhea.is_some() } else { config.lenders.aave.is_some() };
            if has {
                Ok(())
            } else {
                Err(format!("names {l}, which this account has no settings for"))
            }
        };
        let permitted = |l: &str| {
            if permission.is_some_and(|p| p.allows(l)) {
                Ok(())
            } else {
                Err(format!("names {l}, which the owner's permission doesn't name"))
            }
        };
        let collateral = |l: &str, tok: &str| {
            let listed = if l == RHEA {
                let listed = |id: &AccountId| config.lenders.rhea.as_ref().is_some_and(|r| r.collateral.contains(id));
                tok.parse::<AccountId>().is_ok_and(|id| listed(&id))
            } else {
                config.lenders.aave_collateral(tok).is_some()
            };
            if listed {
                Ok(())
            } else {
                Err(format!("can't run: {tok} is not one of {l}'s collateral tokens in this account's settings"))
            }
        };
        match self {
            Self::PBorrow { .. } => Ok(()),
            Self::LSupply { l, tok, .. } => configured(l).and_then(|()| permitted(l)).and_then(|()| collateral(l, tok)),
            Self::LBorrow { l, .. } => configured(l).and_then(|()| permitted(l)),
            Self::ToEvm { tok, .. } => {
                configured(AAVE)?;
                permitted(AAVE)?;
                if config.token(tok).is_none() || tok == &config.usdc_token {
                    return Err(format!("can't run: {tok} is not an allow-listed token other than USDC"));
                }
                Ok(())
            }
            Self::EHome { .. } => configured(AAVE),
            Self::LRepay { l, .. } => configured(l),
            Self::LAdd { l, tok, .. } => configured(l).and_then(|()| collateral(l, tok)),
        }
    }
}

/// Reads a funding or lender step. The error ends the sentence "step <i> …". Amounts may be JSON integers or strings
/// of digits, as in the unwind plan's steps.
pub fn parse_fund_step(json: &str) -> Result<FundStep, String> {
    let step = read(json);
    let bad = |field: &str| format!("can't run: its {field} is missing or not valid");
    let positive = |field: &str| int(&step, field).filter(|a| *a > 0).ok_or_else(|| bad(field));
    let amt = || positive("amt");
    let exp = || int(&step, "exp").and_then(|e| u64::try_from(e).ok()).ok_or_else(|| bad("exp"));
    let lender = || match text(&step, "l") {
        Some(l) if l == RHEA => Ok(RHEA),
        Some(l) if l == AAVE => Ok(AAVE),
        _ => Err(bad("l")),
    };
    let tok =
        || text(&step, "tok").filter(|t| !t.is_empty() && t.len() <= 64).map(str::to_string).ok_or_else(|| bad("tok"));
    let account = |field: &str| text(&step, field).and_then(|s| s.parse::<AccountId>().ok()).ok_or_else(|| bad(field));
    match step.get("k").and_then(Value::as_str).unwrap_or_default() {
        "p_borrow" => Ok(FundStep::PBorrow { amt: amt()? }),
        "l_supply" => Ok(FundStep::LSupply { l: lender()?, tok: tok()?, amt: amt()? }),
        "l_borrow" => Ok(FundStep::LBorrow { l: lender()?, amt: amt()? }),
        "to_evm" => Ok(FundStep::ToEvm {
            tok: account("tok")?,
            amt: amt()?,
            min: positive("min")?,
            dep: account("dep")?,
            exp: exp()?,
        }),
        "e_home" => {
            let dep = text(&step, "dep").and_then(parse_address).ok_or_else(|| bad("dep"))?;
            Ok(FundStep::EHome { amt: amt()?, dep, exp: exp()? })
        }
        "l_repay" => Ok(FundStep::LRepay { l: lender()?, amt: amt()? }),
        "l_add" => Ok(FundStep::LAdd { l: lender()?, tok: tok()?, amt: amt()? }),
        "" => Err("has no kind, so the account can't run it".into()),
        k => Err(format!("is a {k} step, which is not a funding step")),
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::serde_json::json;
    use pb_types::{AaveLender, EvmToken, Gateway, Lenders, Moves, Program, RheaLender, TokenConfig};

    use super::*;

    const DEP: &str = "2b6f1e0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";
    const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
    const EXP: u64 = 1_794_000_600_000;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn parse(step: Value) -> Result<FundStep, String> {
        parse_fund_step(&step.to_string())
    }

    fn config() -> Config {
        let token = |address: &str, symbol: &str, decimals| EvmToken {
            symbol: symbol.into(),
            address: address.into(),
            decimals,
        };
        Config {
            tokens: vec![
                TokenConfig { id: id("musdc.testnet"), symbol: "USDC".into(), decimals: 6 },
                TokenConfig { id: id("mnbtc.testnet"), symbol: "nBTC".into(), decimals: 8 },
            ],
            pool_id: id("pool.testnet"),
            mpc_id: id("mpc.testnet"),
            outlayer_id: id("outlayer.testnet"),
            risk: Program { project_id: "keeper.testnet/pb-risk".into(), version_key: "ab".repeat(32) },
            hl_chain: "Testnet".into(),
            signature_chain_id: "0x66eee".into(),
            usdc_token: id("musdc.testnet"),
            params_hash: "cd".repeat(32),
            model: "B-0.2".into(),
            drill_id: id("drill.testnet"),
            gateway: Gateway {
                project_id: "keeper.testnet/pb-gateway".into(),
                version_key: String::new(),
                secrets_ref: None,
            },
            hl_usdc_token: "USDC:0xeb62eee3685fc4c43992febcd9e75443".into(),
            lenders: Lenders {
                rhea: Some(RheaLender { contract_id: id("rhea.testnet"), collateral: vec![id("mnbtc.testnet")] }),
                aave: Some(AaveLender {
                    chain_id: 84532,
                    pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27".into(),
                    usdc: token("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "USDC", 6),
                    collateral: vec![token(WBTC, "WBTC", 8)],
                    max_fee_per_gas: U128(5_000_000_000),
                }),
            },
        }
    }

    fn permission(lenders: &[&str]) -> Permission {
        let lenders = lenders.iter().map(|l| l.to_string()).collect();
        Permission { lenders, min_hf_bp: 15_000, max_rate_bp: 2_500, moves: Moves::Any }
    }

    #[test]
    fn all_seven_kinds_are_read_with_their_fields() {
        assert_eq!(
            parse(json!({ "k": "p_borrow", "amt": 43_833_000_000u64 })),
            Ok(FundStep::PBorrow { amt: 43_833_000_000 })
        );
        let supply = parse(json!({ "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet", "amt": "131000000" }));
        assert_eq!(supply, Ok(FundStep::LSupply { l: "rhea", tok: "mnbtc.testnet".into(), amt: 131_000_000 }));
        let borrow = parse(json!({ "k": "l_borrow", "l": "aave", "amt": 56_667_000_000u64 }));
        assert_eq!(borrow, Ok(FundStep::LBorrow { l: "aave", amt: 56_667_000_000 }));
        let to_evm = json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": "131000000", "min": "130000000", "dep": DEP, "exp": EXP });
        let expected =
            FundStep::ToEvm { tok: id("mnbtc.testnet"), amt: 131_000_000, min: 130_000_000, dep: id(DEP), exp: EXP };
        assert_eq!(parse(to_evm), Ok(expected));
        let home = parse(json!({ "k": "e_home", "amt": 56_667_000_000u64, "dep": WBTC, "exp": EXP }));
        assert_eq!(home, Ok(FundStep::EHome { amt: 56_667_000_000, dep: WBTC.to_lowercase(), exp: EXP }));
        let repay = parse(json!({ "k": "l_repay", "l": "rhea", "amt": 10_133_000_000u64 }));
        assert_eq!(repay, Ok(FundStep::LRepay { l: "rhea", amt: 10_133_000_000 }));
        let add = parse(json!({ "k": "l_add", "l": "aave", "tok": WBTC, "amt": "5000000" }));
        assert_eq!(add, Ok(FundStep::LAdd { l: "aave", tok: WBTC.into(), amt: 5_000_000 }));
    }

    #[test]
    fn each_kind_names_itself_and_only_the_two_borrows_count_as_borrowing() {
        let steps = [
            json!({ "k": "p_borrow", "amt": 7 }),
            json!({ "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet", "amt": 9 }),
            json!({ "k": "l_borrow", "l": "rhea", "amt": 5 }),
            json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 9, "min": 8, "dep": DEP, "exp": EXP }),
            json!({ "k": "e_home", "amt": 9, "dep": WBTC, "exp": EXP }),
            json!({ "k": "l_repay", "l": "rhea", "amt": 9 }),
            json!({ "k": "l_add", "l": "rhea", "tok": "mnbtc.testnet", "amt": 9 }),
        ];
        let read: Vec<FundStep> = steps.iter().map(|s| parse(s.clone()).unwrap()).collect();
        for (step, json) in read.iter().zip(&steps) {
            assert_eq!(step.kind(), json["k"].as_str().unwrap());
        }
        assert_eq!(read.iter().map(FundStep::borrows).collect::<Vec<_>>(), vec![7, 0, 5, 0, 0, 0, 0]);
        let loans: Vec<bool> = read.iter().map(FundStep::makes_a_loan).collect();
        assert_eq!(loans, vec![true, true, true, true, true, false, false]);
        assert_eq!(read[3].not_yet(), "is a to_evm step: the account can't run to_evm steps yet");
        assert_eq!(read[4].not_yet(), "is a e_home step: the account can't run e_home steps yet");
    }

    #[test]
    fn a_funding_step_with_a_missing_or_bad_field_is_refused() {
        let cases = [
            (json!({ "k": "p_borrow" }), "amt"),
            (json!({ "k": "p_borrow", "amt": 0 }), "amt"),
            (json!({ "k": "p_borrow", "amt": 1.5 }), "amt"),
            (json!({ "k": "l_borrow", "amt": 5 }), "l"),
            (json!({ "k": "l_borrow", "l": "compound", "amt": 5 }), "l"),
            (json!({ "k": "l_borrow", "l": "Rhea", "amt": 5 }), "l"),
            (json!({ "k": "l_supply", "l": "rhea", "amt": 5 }), "tok"),
            (json!({ "k": "l_supply", "l": "rhea", "tok": "", "amt": 5 }), "tok"),
            (json!({ "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet" }), "amt"),
            (json!({ "k": "to_evm", "tok": "Not A Token", "amt": 5, "min": 4, "dep": DEP, "exp": 1 }), "tok"),
            (json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 5, "dep": DEP, "exp": 1 }), "min"),
            (json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 5, "min": 4, "exp": 1 }), "dep"),
            (json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 5, "min": 4, "dep": DEP }), "exp"),
            (json!({ "k": "e_home", "amt": 5, "dep": DEP, "exp": 1 }), "dep"),
            (json!({ "k": "e_home", "amt": 5, "dep": WBTC }), "exp"),
            (json!({ "k": "l_repay", "l": "rhea" }), "amt"),
            (json!({ "k": "l_add", "l": "aave", "amt": 5 }), "tok"),
        ];
        for (step, field) in cases {
            let expected = format!("can't run: its {field} is missing or not valid");
            assert_eq!(parse(step.clone()), Err(expected), "{step}");
        }
    }

    #[test]
    fn an_unwind_step_or_an_unknown_kind_is_not_a_funding_step() {
        assert_eq!(
            parse(json!({ "k": "repay", "amt": 5 })),
            Err("is a repay step, which is not a funding step".into())
        );
        assert_eq!(parse(json!({ "k": "perp" })), Err("is a perp step, which is not a funding step".into()));
        assert_eq!(parse(json!({ "step": "text" })), Err("has no kind, so the account can't run it".into()));
        assert_eq!(parse(json!("p_borrow")), Err("has no kind, so the account can't run it".into()));
    }

    #[test]
    fn a_lender_step_needs_its_lender_in_the_config() {
        let mut c = config();
        c.lenders.aave = None;
        let both = permission(&["aave", "rhea"]);
        let no_settings = Err("names aave, which this account has no settings for".to_string());
        let steps = [
            json!({ "k": "l_supply", "l": "aave", "tok": WBTC, "amt": 5 }),
            json!({ "k": "l_borrow", "l": "aave", "amt": 5 }),
            json!({ "k": "l_repay", "l": "aave", "amt": 5 }),
            json!({ "k": "l_add", "l": "aave", "tok": WBTC, "amt": 5 }),
            json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 5, "min": 4, "dep": DEP, "exp": EXP }),
            json!({ "k": "e_home", "amt": 5, "dep": WBTC, "exp": EXP }),
        ];
        for step in steps {
            assert_eq!(parse(step.clone()).unwrap().check(&c, Some(&both)), no_settings, "{step}");
        }
        // Rhea is still there, and our pool's step needs no lender at all.
        assert_eq!(parse(json!({ "k": "l_borrow", "l": "rhea", "amt": 5 })).unwrap().check(&c, Some(&both)), Ok(()));
        assert_eq!(FundStep::PBorrow { amt: 5 }.check(&Config { lenders: Lenders::default(), ..c }, None), Ok(()));
    }

    #[test]
    fn a_step_that_makes_a_loan_needs_the_permission_to_name_its_lender_and_a_top_up_does_not() {
        let c = config();
        let only_rhea = permission(&["rhea"]);
        let not_named = Err("names aave, which the owner's permission doesn't name".to_string());
        let loans = [
            json!({ "k": "l_supply", "l": "aave", "tok": WBTC, "amt": 5 }),
            json!({ "k": "l_borrow", "l": "aave", "amt": 5 }),
            json!({ "k": "to_evm", "tok": "mnbtc.testnet", "amt": 5, "min": 4, "dep": DEP, "exp": EXP }),
        ];
        for step in loans {
            let step = parse(step).unwrap();
            assert_eq!(step.check(&c, Some(&only_rhea)), not_named, "{step:?}");
            assert_eq!(step.check(&c, None), not_named, "{step:?} with no permission");
            assert_eq!(step.check(&c, Some(&permission(&["aave"]))), Ok(()), "{step:?}");
        }
        // Top-ups and bringing USDC home run whatever the permission says (FUNDING.md 6.5).
        let always = [
            json!({ "k": "l_repay", "l": "aave", "amt": 5 }),
            json!({ "k": "l_add", "l": "aave", "tok": WBTC, "amt": 5 }),
            json!({ "k": "e_home", "amt": 5, "dep": WBTC, "exp": EXP }),
        ];
        for step in always {
            assert_eq!(parse(step.clone()).unwrap().check(&c, None), Ok(()), "{step}");
        }
    }

    #[test]
    fn collateral_goes_only_to_a_lender_as_one_of_its_listed_tokens() {
        let c = config();
        let both = permission(&["aave", "rhea"]);
        let check = |step: Value| parse(step).unwrap().check(&c, Some(&both));
        // Rhea takes its listed NEAR tokens, Aave its listed addresses in any case.
        assert_eq!(check(json!({ "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet", "amt": 5 })), Ok(()));
        assert_eq!(check(json!({ "k": "l_add", "l": "aave", "tok": WBTC.to_lowercase(), "amt": 5 })), Ok(()));
        let cases = [
            ("l_supply", "rhea", "musdc.testnet"),
            ("l_supply", "rhea", WBTC),
            ("l_supply", "aave", "mnbtc.testnet"),
            ("l_add", "aave", "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
            ("l_add", "rhea", "other.testnet"),
        ];
        for (k, l, tok) in cases {
            let refused = check(json!({ "k": k, "l": l, "tok": tok, "amt": 5 }));
            let expected = format!("can't run: {tok} is not one of {l}'s collateral tokens in this account's settings");
            assert_eq!(refused, Err(expected));
        }
        // Moving collateral to Aave's chain sends a listed token, never USDC.
        let to_evm =
            |tok: &str| check(json!({ "k": "to_evm", "tok": tok, "amt": 5, "min": 4, "dep": DEP, "exp": EXP }));
        assert_eq!(to_evm("mnbtc.testnet"), Ok(()));
        for tok in ["musdc.testnet", "other.testnet"] {
            assert_eq!(to_evm(tok), Err(format!("can't run: {tok} is not an allow-listed token other than USDC")));
        }
    }

    #[test]
    fn a_funding_plan_has_an_f_id_lasts_30_minutes_and_shows_each_step_with_done() {
        let steps = crate::plan::steps_from(&[
            json!({ "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet", "amt": "131000000" }),
            json!({ "k": "l_borrow", "l": "rhea", "amt": 50_667_000_000u64 }),
            json!({ "k": "p_borrow", "amt": 43_833_000_000u64 }),
        ]);
        let mut plan = Funding::new(276_800_123, 94_500_000_000, 7, steps);
        plan.steps[0].done = true;
        assert!(plan.unfinished());
        assert!(!plan.expired(7 + FUNDING_NS) && plan.expired(8 + FUNDING_NS));
        let view = near_sdk::serde_json::to_value(plan.view()).unwrap();
        let expected = json!({
            "pid": "f276800123", "amount": "94500000000", "stored_at": "7", "expires_at": (7 + FUNDING_NS).to_string(),
            "steps": [
                { "k": "l_supply", "l": "rhea", "tok": "mnbtc.testnet", "amt": "131000000", "done": true },
                { "k": "l_borrow", "l": "rhea", "amt": 50_667_000_000u64, "done": false },
                { "k": "p_borrow", "amt": 43_833_000_000u64, "done": false },
            ],
        });
        assert_eq!(view, expected);
        plan.steps.iter_mut().for_each(|s| s.done = true);
        assert!(!plan.unfinished());
    }
}
