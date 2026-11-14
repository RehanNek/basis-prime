//! Types the factory and the account contract share (INTERFACES.md 3): the config the factory copies into each
//! account it creates. The factory's `set_config` changes it for new accounts only.
use near_sdk::json_types::U128;
use near_sdk::{near, require, AccountId};

/// At most this many tokens on the allow-list.
pub const MAX_TOKENS: usize = 8;
/// At most this many collateral tokens per lender.
pub const MAX_LENDER_TOKENS: usize = 4;
/// The lenders' names, as permissions, steps and verdicts write them.
pub const RHEA: &str = "rhea";
pub const AAVE: &str = "aave";
/// A permission's smallest cushion is between the act-now level (1.2) and 5.0, in bp of a health factor.
pub const MIN_HF_BP: u32 = 12_000;
pub const MAX_HF_BP: u32 = 50_000;
/// A permission's dearest lender rate is at most 100% a year.
pub const MAX_RATE_BP: u32 = 10_000;
/// Longest project id, version key or model name.
pub const MAX_FIELD: usize = 128;

/// One allow-listed NEP-141 token: its contract, the pool's name for it (`USDC`, `nBTC`, …) and its decimals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenConfig {
    pub id: AccountId,
    pub symbol: String,
    pub decimals: u8,
}

/// The pinned `pb-risk`: its OutLayer project and version (the sha256 of its wasm). An empty `version_key` means no
/// version is pinned yet, and the account refuses to run the program until one is.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    pub project_id: String,
    pub version_key: String,
}

/// The pinned `pb-gateway` (Phase 3): its project and version, as for `pb-risk`, and the secrets reference OutLayer
/// needs to give the run its agent seed, if it needs one. `secrets_ref` may be left out of the JSON; it is then null.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Gateway {
    pub project_id: String,
    pub version_key: String,
    #[serde(default)]
    pub secrets_ref: Option<SecretsRef>,
}

/// OutLayer's `secrets_ref`: the profile the secrets were stored under, and the account that stored them. The account
/// passes it to `request_execution` as it is.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: AccountId,
}

/// Copied into each account at creation (PLAN.md 5.1).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub tokens: Vec<TokenConfig>,
    pub pool_id: AccountId,
    pub mpc_id: AccountId,
    pub outlayer_id: AccountId,
    pub risk: Program,
    /// "Testnet" or "Mainnet".
    pub hl_chain: String,
    /// Hyperliquid's `signatureChainId`, such as "0x66eee".
    pub signature_chain_id: String,
    /// The pool's lending token (6 decimals, so one unit is one micro-USD).
    pub usdc_token: AccountId,
    /// The sha256 of the parameter file (`universe_v0.json`), as 64 hex characters. Every verdict must carry it.
    pub params_hash: String,
    /// The model version every verdict must carry, such as "B-0.2".
    pub model: String,
    pub drill_id: AccountId,
    /// The pinned `pb-gateway`, which names the account's Hyperliquid agent (Phase 3).
    pub gateway: Gateway,
    /// Hyperliquid's name for USDC, as `spotMeta` gives it: `USDC:0x` and the 32 hex digits of its token id.
    /// `hl_withdraw` sends this token (Phase 3).
    pub hl_usdc_token: String,
    /// The outside lenders an account may use (FUNDING.md 4.1). Left out of the JSON, there are none.
    #[serde(default)]
    pub lenders: Lenders,
}

/// The outside lenders (FUNDING.md 4.1). An account uses one only if its permission names it too.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lenders {
    #[serde(default)]
    pub rhea: Option<RheaLender>,
    #[serde(default)]
    pub aave: Option<AaveLender>,
}

/// Rhea (Burrow) on NEAR: its contract, and the listed tokens the account may post there as collateral.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RheaLender {
    pub contract_id: AccountId,
    pub collateral: Vec<AccountId>,
}

/// Aave v3 on one Ethereum-style chain, reached through Chain Signatures. Addresses are `0x` and 40 hex digits.
/// `max_fee_per_gas` is in wei: the account signs no transaction that offers more.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AaveLender {
    pub chain_id: u64,
    pub pool: String,
    pub usdc: EvmToken,
    pub collateral: Vec<EvmToken>,
    pub max_fee_per_gas: U128,
}

/// A token on Aave's chain: the engine's name for it (`USDC`, `WBTC`), its contract and its decimals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmToken {
    pub symbol: String,
    pub address: String,
    pub decimals: u8,
}

/// May the engine move a running loan between sources? (The engine doesn't yet; FUNDING.md 16.)
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moves {
    Off,
    LowerCostOnly,
    Any,
}

/// The funding permission the owner signs when the account is opened (FUNDING.md 4.2).
/// - `lenders`: the lenders the engine may borrow from for this account: `"rhea"`, `"aave"`.
/// - `min_hf_bp`: the smallest cushion (health factor, in bp) a new lender loan may leave, such as 15000 for 1.5.
/// - `max_rate_bp`: the dearest lender rate, in bp a year, at which the engine may still borrow there.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Permission {
    pub lenders: Vec<String>,
    pub min_hf_bp: u32,
    pub max_rate_bp: u32,
    pub moves: Moves,
}

impl Permission {
    /// Whether the permission names this lender.
    pub fn allows(&self, lender: &str) -> bool {
        self.lenders.iter().any(|l| l == lender)
    }

    /// What is wrong with the permission for an account with these lenders, if anything.
    pub fn problem(&self, lenders: &Lenders) -> Option<String> {
        for (i, l) in self.lenders.iter().enumerate() {
            let configured = match l.as_str() {
                RHEA => lenders.rhea.is_some(),
                AAVE => lenders.aave.is_some(),
                _ => return Some(format!(r#"the permission names {l:?}: the lenders are "rhea" and "aave""#)),
            };
            if !configured {
                return Some(format!("the permission names {l}, which this account has no settings for"));
            }
            if self.lenders[..i].contains(l) {
                return Some(format!("the permission names {l} twice"));
            }
        }
        if !(MIN_HF_BP..=MAX_HF_BP).contains(&self.min_hf_bp) {
            return Some("the permission's min_hf_bp must be 12000 to 50000 (a cushion of 1.2 to 5.0)".into());
        }
        if !(1..=MAX_RATE_BP).contains(&self.max_rate_bp) {
            return Some("the permission's max_rate_bp must be 1 to 10000 (at most 100% a year)".into());
        }
        None
    }
}

/// One lender's line in a verdict's `ext`, as the account passes it to the pool's `settle` (FUNDING.md 5.2):
/// the debt there in micro-USD, and the lender's USDC borrow and deposit rates now, in bp a year.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LenderReport {
    pub lender: String,
    pub debt: U128,
    pub rate_bp: u32,
    pub supply_bp: u32,
}

impl Lenders {
    pub fn is_empty(&self) -> bool {
        self.rhea.is_none() && self.aave.is_none()
    }

    /// The Aave collateral token with this address (any case), if any.
    pub fn aave_collateral(&self, address: &str) -> Option<&EvmToken> {
        self.aave.as_ref()?.collateral.iter().find(|t| t.address.eq_ignore_ascii_case(address))
    }
}

impl Config {
    /// The allow-listed token with this contract id, if any.
    pub fn token(&self, id: &AccountId) -> Option<&TokenConfig> {
        self.tokens.iter().find(|t| &t.id == id)
    }

    /// `signature_chain_id` as a number, for the EIP-712 domain. A valid config always has one.
    pub fn signature_chain(&self) -> Option<u64> {
        let digits = self.signature_chain_id.strip_prefix("0x")?;
        u64::from_str_radix(digits, 16).ok()
    }

    pub fn assert_valid(&self) {
        let n = self.tokens.len();
        require!((1..=MAX_TOKENS).contains(&n), "the config needs 1 to 8 tokens");
        for (i, t) in self.tokens.iter().enumerate() {
            require!(!t.symbol.is_empty() && t.symbol.len() <= 16, "token symbols must be 1 to 16 bytes");
            require!(t.decimals <= 24, "token decimals must be at most 24");
            require!(self.tokens[..i].iter().all(|other| other.id != t.id), "a token is listed twice");
        }
        let usdc = self.token(&self.usdc_token);
        require!(usdc.is_some_and(|t| t.decimals == 6), "usdc_token must be a listed token with 6 decimals");
        assert_program("risk", &self.risk.project_id, &self.risk.version_key);
        let chain = self.hl_chain.as_str();
        require!(chain == "Testnet" || chain == "Mainnet", r#"hl_chain must be "Testnet" or "Mainnet""#);
        let chain_id = &self.signature_chain_id;
        require!(
            chain_id.len() > 2 && chain_id.len() <= 18 && chain_id.starts_with("0x") && is_hex(&chain_id[2..]),
            "signature_chain_id must be 0x and 1 to 16 hex digits"
        );
        require!(self.params_hash.len() == 64 && is_hex(&self.params_hash), "params_hash must be 64 hex characters");
        require!(!self.model.is_empty() && self.model.len() <= MAX_FIELD, "model must be 1 to 128 bytes");
        let gateway = &self.gateway;
        assert_program("gateway", &gateway.project_id, &gateway.version_key);
        if let Some(secrets) = &gateway.secrets_ref {
            let profile = secrets.profile.len();
            require!((1..=MAX_FIELD).contains(&profile), "gateway.secrets_ref.profile must be 1 to 128 bytes");
        }
        require!(
            is_hl_token(&self.hl_usdc_token),
            "hl_usdc_token must be a name, :0x and 32 hex digits, as Hyperliquid's spotMeta gives it"
        );
        if let Some(rhea) = &self.lenders.rhea {
            let n = rhea.collateral.len();
            require!((1..=MAX_LENDER_TOKENS).contains(&n), "lenders.rhea needs 1 to 4 collateral tokens");
            for (i, id) in rhea.collateral.iter().enumerate() {
                require!(
                    self.token(id).is_some() && id != &self.usdc_token,
                    "lenders.rhea.collateral must be listed tokens other than usdc_token"
                );
                require!(!rhea.collateral[..i].contains(id), "lenders.rhea.collateral lists a token twice");
                // Rhea counts every token in 18 decimals: one with more could be posted there and never taken back
                // (research/audit.md, X2).
                require!(
                    self.token(id).is_some_and(|t| t.decimals <= 18),
                    "lenders.rhea.collateral tokens have at most 18 decimals"
                );
            }
        }
        if let Some(aave) = &self.lenders.aave {
            require!(aave.chain_id > 0, "lenders.aave.chain_id must be above 0");
            require!(is_evm_address(&aave.pool), "lenders.aave.pool must be 0x and 40 hex digits");
            assert_evm_token("lenders.aave.usdc", &aave.usdc);
            require!(aave.usdc.decimals == 6, "lenders.aave.usdc must have 6 decimals");
            let n = aave.collateral.len();
            require!((1..=MAX_LENDER_TOKENS).contains(&n), "lenders.aave needs 1 to 4 collateral tokens");
            for (i, t) in aave.collateral.iter().enumerate() {
                assert_evm_token("lenders.aave.collateral", t);
                let twice = |o: &EvmToken| o.address.eq_ignore_ascii_case(&t.address);
                require!(
                    !aave.collateral[..i].iter().any(twice) && !twice(&aave.usdc),
                    "lenders.aave lists a token twice"
                );
            }
            require!(aave.max_fee_per_gas.0 > 0, "lenders.aave.max_fee_per_gas must be above 0");
        }
    }
}

fn assert_evm_token(name: &str, t: &EvmToken) {
    require!(!t.symbol.is_empty() && t.symbol.len() <= 16, format!("{name}: symbols must be 1 to 16 bytes"));
    require!(is_evm_address(&t.address), format!("{name}: the address must be 0x and 40 hex digits"));
    require!(t.decimals <= 18, format!("{name}: decimals must be at most 18"));
}

/// `0x` and 40 hex digits, in any case.
pub fn is_evm_address(s: &str) -> bool {
    s.strip_prefix("0x").is_some_and(|hex| hex.len() == 40 && is_hex(hex))
}

/// A program needs a project id of 1 to 128 bytes. Its version key may be empty until a version is published.
fn assert_program(name: &str, project_id: &str, version_key: &str) {
    require!(
        !project_id.is_empty() && project_id.len() <= MAX_FIELD,
        format!("{name}.project_id must be 1 to 128 bytes")
    );
    require!(version_key.len() <= MAX_FIELD, format!("{name}.version_key must be at most 128 bytes"));
}

/// A Hyperliquid token string: a name of 1 to 16 letters and digits, `:0x`, and the 32 hex digits of its token id.
fn is_hl_token(token: &str) -> bool {
    let Some((name, id)) = token.split_once(":0x") else { return false };
    let name_ok = !name.is_empty() && name.len() <= 16 && name.bytes().all(|b| b.is_ascii_alphanumeric());
    name_ok && id.len() == 32 && is_hex(id)
}

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn config() -> Config {
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
                version_key: "ef".repeat(32),
                secrets_ref: None,
            },
            hl_usdc_token: "USDC:0xeb62eee3685fc4c43992febcd9e75443".into(),
            lenders: Lenders::default(),
        }
    }

    fn lenders() -> Lenders {
        Lenders {
            rhea: Some(RheaLender { contract_id: id("rhea.testnet"), collateral: vec![id("mnbtc.testnet")] }),
            aave: Some(AaveLender {
                chain_id: 84532,
                pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27".into(),
                usdc: EvmToken {
                    symbol: "USDC".into(),
                    address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f".into(),
                    decimals: 6,
                },
                collateral: vec![EvmToken {
                    symbol: "WBTC".into(),
                    address: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4".into(),
                    decimals: 8,
                }],
                max_fee_per_gas: U128(5_000_000_000),
            }),
        }
    }

    fn permission() -> Permission {
        Permission {
            lenders: vec!["aave".into(), "rhea".into()],
            min_hf_bp: 15_000,
            max_rate_bp: 2_500,
            moves: Moves::Any,
        }
    }

    #[test]
    fn a_config_with_lenders_passes_and_one_without_them_reads_as_none() {
        let mut c = config();
        c.lenders = lenders();
        c.assert_valid();
        assert!(c.lenders.aave_collateral("0x54114591963cf60ef3aa63befd6ec263d98145a4").is_some());
        let mut json = near_sdk::serde_json::to_value(&c).unwrap();
        assert_eq!(json["lenders"]["aave"]["chain_id"], 84532);
        assert_eq!(json["lenders"]["aave"]["max_fee_per_gas"], "5000000000");
        assert_eq!(json["lenders"]["rhea"]["collateral"][0], "mnbtc.testnet");
        json.as_object_mut().unwrap().remove("lenders");
        let old: Config = near_sdk::serde_json::from_value(json).unwrap();
        assert!(old.lenders.is_empty());
        old.assert_valid();
    }

    #[test]
    #[should_panic(expected = "lenders.rhea.collateral must be listed tokens other than usdc_token")]
    fn rheas_collateral_must_be_a_listed_token() {
        let mut c = config();
        c.lenders = lenders();
        c.lenders.rhea.as_mut().unwrap().collateral = vec![id("musdc.testnet")];
        c.assert_valid();
    }

    #[test]
    fn a_rhea_collateral_token_has_at_most_18_decimals() {
        // Rhea counts every token in 18 decimals: one with more could be posted there and never taken back
        // (research/audit.md, X2). 18 is fine; the token list itself allows up to 24.
        let with_decimals = |decimals: u8| {
            let mut c = config();
            c.lenders = lenders();
            c.tokens[1].decimals = decimals;
            c
        };
        with_decimals(18).assert_valid();
        let refused = std::panic::catch_unwind(|| with_decimals(19).assert_valid());
        let words = refused.expect_err("a Rhea collateral token with 19 decimals passed");
        let words = words.downcast_ref::<String>().cloned().unwrap_or_default();
        assert_eq!(words, "lenders.rhea.collateral tokens have at most 18 decimals");
        // A token Rhea doesn't take may still have more.
        let mut c = with_decimals(19);
        c.lenders.rhea = None;
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "lenders.aave.pool must be 0x and 40 hex digits")]
    fn aaves_pool_is_an_address() {
        let mut c = config();
        c.lenders = lenders();
        c.lenders.aave.as_mut().unwrap().pool = "0x8bAB".into();
        c.assert_valid();
    }

    #[test]
    fn a_permission_is_checked_against_the_accounts_lenders() {
        let all = lenders();
        assert_eq!(permission().problem(&all), None);
        assert!(permission().allows("aave") && !permission().allows("compound"));
        let json = near_sdk::serde_json::to_value(permission()).unwrap();
        let expected = near_sdk::serde_json::json!({
            "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any",
        });
        assert_eq!(json, expected);
        let only_rhea = Lenders { aave: None, ..all.clone() };
        assert!(permission().problem(&only_rhea).unwrap().contains("names aave, which this account has no settings"));
        let cases: [(fn(&mut Permission), &str); 5] = [
            (|p| p.lenders.push("compound".into()), "the lenders are"),
            (|p| p.lenders.push("rhea".into()), "names rhea twice"),
            (|p| p.min_hf_bp = 11_999, "min_hf_bp"),
            (|p| p.max_rate_bp = 0, "max_rate_bp"),
            (|p| p.max_rate_bp = 10_001, "max_rate_bp"),
        ];
        for (change, words) in cases {
            let mut p = permission();
            change(&mut p);
            let problem = p.problem(&all).unwrap_or_default();
            assert!(problem.contains(words), "{problem:?} lacks {words:?}");
        }
        // No lenders at all is a valid permission: the pool alone.
        let none = Permission { lenders: vec![], ..permission() };
        assert_eq!(none.problem(&Lenders::default()), None);
        let moves: Moves = near_sdk::serde_json::from_str(r#""lower_cost_only""#).unwrap();
        assert_eq!(moves, Moves::LowerCostOnly);
    }

    #[test]
    fn a_good_config_passes_and_finds_its_tokens() {
        let c = config();
        c.assert_valid();
        assert_eq!(c.token(&id("mnbtc.testnet")).unwrap().symbol, "nBTC");
        assert!(c.token(&id("other.testnet")).is_none());
    }

    #[test]
    fn an_empty_version_key_is_allowed_until_one_is_published() {
        let mut c = config();
        c.risk.version_key = String::new();
        c.gateway.version_key = String::new();
        c.assert_valid();
    }

    #[test]
    fn the_config_has_the_interfaces_json_shape() {
        let json = near_sdk::serde_json::to_value(config()).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys.len(), 14);
        for key in ["risk", "hl_chain", "signature_chain_id", "drill_id", "gateway", "hl_usdc_token", "lenders"] {
            assert!(keys.contains(&key), "no {key} in {json}");
        }
        let gateway = near_sdk::serde_json::json!({
            "project_id": "keeper.testnet/pb-gateway", "version_key": "ef".repeat(32), "secrets_ref": null,
        });
        assert_eq!(json["gateway"], gateway);
        // `risk` has no secrets_ref.
        assert_eq!(json["risk"].as_object().unwrap().len(), 2);
        assert_eq!(json["hl_usdc_token"], "USDC:0xeb62eee3685fc4c43992febcd9e75443");
    }

    #[test]
    fn the_gateways_secrets_ref_is_null_when_left_out_and_kept_when_given() {
        let mut json = near_sdk::serde_json::to_value(config()).unwrap();
        json["gateway"].as_object_mut().unwrap().remove("secrets_ref");
        let c: Config = near_sdk::serde_json::from_value(json.clone()).unwrap();
        assert_eq!(c.gateway.secrets_ref, None);
        json["gateway"]["secrets_ref"] =
            near_sdk::serde_json::json!({ "profile": "pb", "account_id": "keeper.testnet" });
        let c: Config = near_sdk::serde_json::from_value(json).unwrap();
        c.assert_valid();
        assert_eq!(c.gateway.secrets_ref, Some(SecretsRef { profile: "pb".into(), account_id: id("keeper.testnet") }));
    }

    #[test]
    #[should_panic(expected = "gateway.secrets_ref.profile must be 1 to 128 bytes")]
    fn a_secrets_ref_needs_a_profile() {
        let mut c = config();
        c.gateway.secrets_ref = Some(SecretsRef { profile: String::new(), account_id: id("keeper.testnet") });
        c.assert_valid();
    }

    #[test]
    fn the_signature_chain_id_is_read_as_a_number() {
        assert_eq!(config().signature_chain(), Some(0x66eee));
        let mut c = config();
        c.signature_chain_id = "0x1".into();
        assert_eq!(c.signature_chain(), Some(1));
    }

    #[test]
    #[should_panic(expected = "usdc_token must be a listed token with 6 decimals")]
    fn the_usdc_token_must_be_listed() {
        let mut c = config();
        c.usdc_token = id("other.testnet");
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "usdc_token must be a listed token with 6 decimals")]
    fn the_usdc_token_must_have_6_decimals() {
        let mut c = config();
        c.tokens[0].decimals = 18;
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "a token is listed twice")]
    fn tokens_are_unique() {
        let mut c = config();
        c.tokens[1].id = id("musdc.testnet");
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "params_hash must be 64 hex characters")]
    fn the_params_hash_is_a_sha256() {
        let mut c = config();
        c.params_hash = "not a hash".into();
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "hl_chain must be")]
    fn the_hyperliquid_chain_is_testnet_or_mainnet() {
        let mut c = config();
        c.hl_chain = "testnet".into();
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "signature_chain_id must be 0x")]
    fn the_signature_chain_id_is_hex() {
        let mut c = config();
        c.signature_chain_id = "66eee".into();
        c.assert_valid();
    }

    #[test]
    #[should_panic(expected = "gateway.project_id must be 1 to 128 bytes")]
    fn the_gateway_needs_a_project() {
        let mut c = config();
        c.gateway.project_id = String::new();
        c.assert_valid();
    }

    #[test]
    fn the_hyperliquid_usdc_token_is_a_name_and_a_32_digit_id() {
        let mut c = config();
        c.hl_usdc_token = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054".into();
        c.assert_valid();
        for bad in
            ["", "USDC", "USDC:eb62eee3685fc4c43992febcd9e75443", "USDC:0xeb62", ":0xeb62eee3685fc4c43992febcd9e75443"]
        {
            assert!(!is_hl_token(bad), "{bad:?} passed");
        }
        assert!(!is_hl_token("US\"DC:0xeb62eee3685fc4c43992febcd9e75443"));
        assert!(!is_hl_token("USDC:0xeb62eee3685fc4c43992febcd9e7544z"));
    }

    #[test]
    #[should_panic(expected = "hl_usdc_token must be a name, :0x and 32 hex digits")]
    fn a_bad_hyperliquid_usdc_token_is_refused() {
        let mut c = config();
        c.hl_usdc_token = "USDC".into();
        c.assert_valid();
    }
}
