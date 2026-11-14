//! Ethereum transactions for Aave, signed through Chain Signatures (FUNDING.md 4.5; INTERFACES.md 33).
//!
//! The account's Ethereum address is its Hyperliquid address: the same key and path. It signs one shape of
//! transaction, Ethereum's type 2 (EIP-1559), and the backend sends it.
//!
//! - **The transaction.** `0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to,
//!   value, data, access_list])`, with value 0 and an empty access list. The signer signs the keccak256 of that. The
//!   sent transaction adds `y_parity`, `r` and `s` to the list, and its hash is the keccak256 of the whole. The RLP
//!   encoder here writes this one shape and nothing else.
//! - **The calls.** Six, and nothing else: ERC-20 `approve` and `transfer`, and Aave's Pool `supply`, `borrow`,
//!   `repay` and `withdraw` (research/aave.md has their signatures, from `IPool.sol`). The tests recompute each
//!   selector from its signature.
//! - **Gas.** A limit per kind, at most 500,000 (`EvmKind::gas_limit`). A first try offers half the config's
//!   `max_fee_per_gas`, which leaves room to bump it, and a tip of the smaller of 1,000,000 wei and that.
//! - **Nonces.** The account counts its own: `Evm::nonce` is the next one. A nonce is used only once its
//!   transaction is signed, and one transaction is signed at a time, so no two different transactions share one.
//! - **The stale-signature rule.** A signed transaction never expires, and anyone can send it. So a signed borrow,
//!   collateral withdrawal or transfer is listed in `pending` from the moment the signer is asked (`lender.rs`), and
//!   nothing else that adds risk runs until a verdict shows the chain has used its nonce.
//!
//! The encoder is checked against transactions built in Node with the `@noble` packages
//! (`contracts/account/evm-vectors.mjs` writes `src/evm_vectors.json`).
//!
//! Nothing here panics, because the callbacks use it.
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near};

use crate::hl::{hex, parse_address, HlSignature};

/// An Ethereum address: 20 bytes.
pub type Address = [u8; 20];

/// `evm.signed` keeps the newest transactions, at most this many.
pub const MAX_EVM_SIGNED: usize = 20;
/// The tip a transaction first offers: 1,000,000 wei a gas, or the fee it offers if that is lower.
pub const TIP_WEI: u128 = 1_000_000;
/// The signer answers or times out within 200 blocks. After this many, a signature that was asked for and never
/// came back no longer holds up the next one.
pub const SIGNING_BLOCKS: u64 = 250;

// The selectors: the first 4 bytes of the keccak256 of each signature.
/// `approve(address,uint256)`
pub const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `transfer(address,uint256)`
pub const TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// `supply(address,uint256,address,uint16)`
pub const SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37];
/// `borrow(address,uint256,uint256,uint16,address)`
pub const BORROW: [u8; 4] = [0xa4, 0x15, 0xbc, 0xad];
/// `repay(address,uint256,uint256,address)`
pub const REPAY: [u8; 4] = [0x57, 0x3a, 0xde, 0x81];
/// `withdraw(address,uint256,address)`
pub const WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec];
/// Aave's variable interest rate mode, the only one its markets lend at.
const VARIABLE_RATE: u128 = 2;

/// What a signed transaction does.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvmKind {
    Approve,
    Supply,
    Borrow,
    Repay,
    Withdraw,
    Transfer,
}

impl EvmKind {
    /// The gas limit the account signs for this kind, at most 500,000. A transaction pays only for the gas it uses,
    /// so each has room to spare; the address must hold `gas_limit × max_fee_per_gas` of ETH for it to be sent.
    ///
    /// Gas used in a live round trip on Aave's test market on Base Sepolia (11 Nov; INTERFACES.md 33,
    /// `research/data/aave_spike_weth.json`): approve 46,584; supply 185,866; borrow 259,935; repay 162,260;
    /// withdraw 173,127. Aave's own gas snapshots agree (`aave-dao/aave-v3-origin`, `snapshots/Pool.Operations.json`):
    /// the dearest case of each is a first borrow at 251,664 and a withdrawal with a loan open at 220,789, before
    /// the 21,000 every transaction adds. So each limit is at least a third above what was used.
    pub fn gas_limit(self) -> u64 {
        match self {
            Self::Approve | Self::Transfer => 100_000,
            Self::Supply | Self::Repay | Self::Withdraw => 300_000,
            Self::Borrow => 400_000,
        }
    }

    /// The kind as `get_state().evm.signed` and the `evm_signed` event write it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Supply => "supply",
            Self::Borrow => "borrow",
            Self::Repay => "repay",
            Self::Withdraw => "withdraw",
            Self::Transfer => "transfer",
        }
    }
}

/// The 20 bytes of a `0x` address with 40 hex digits, in any case.
pub fn parse_evm_address(address: &str) -> Option<Address> {
    let lower = parse_address(address)?;
    let mut out = [0u8; 20];
    for (byte, pair) in out.iter_mut().zip(lower.as_bytes()[2..].chunks(2)) {
        *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

/// `0x` and the 40 hex digits of an address, in lower case.
pub fn address_text(address: &Address) -> String {
    format!("0x{}", hex(address))
}

fn nibble(c: u8) -> Option<u8> {
    char::from(c).to_digit(16).map(|d| d as u8)
}

/// The 32 bytes of 64 hex digits after `0x`.
fn word_from_hex(text: &str) -> Option<[u8; 32]> {
    let digits = text.strip_prefix("0x").filter(|d| d.len() == 64)?;
    let mut out = [0u8; 32];
    for (byte, pair) in out.iter_mut().zip(digits.as_bytes().chunks(2)) {
        *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

// The calls' data: the selector, then each argument as a 32-byte word.

fn address_word(address: &Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn uint_word(n: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&n.to_be_bytes());
    word
}

/// An amount, or with none the largest uint256, which Aave reads as "all of it".
fn amount_word(amount: Option<u128>) -> [u8; 32] {
    amount.map_or([0xff; 32], uint_word)
}

fn call(selector: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32 * words.len());
    data.extend_from_slice(&selector);
    words.iter().for_each(|word| data.extend_from_slice(word));
    data
}

/// `approve(spender, 2^256 - 1)`: lets Aave's Pool take the token from the address when the account supplies or
/// repays. The Pool only ever takes it from whoever calls it.
pub fn approve_data(spender: &Address) -> Vec<u8> {
    call(APPROVE, &[address_word(spender), [0xff; 32]])
}

/// `transfer(to, amount)`.
pub fn transfer_data(to: &Address, amount: u128) -> Vec<u8> {
    call(TRANSFER, &[address_word(to), uint_word(amount)])
}

/// `supply(asset, amount, onBehalfOf, 0)`: posts `amount` of `asset` as `me`'s own collateral.
pub fn supply_data(asset: &Address, amount: u128, me: &Address) -> Vec<u8> {
    call(SUPPLY, &[address_word(asset), uint_word(amount), address_word(me), uint_word(0)])
}

/// `borrow(asset, amount, 2, 0, onBehalfOf)`: borrows `amount` of `asset` at the variable rate, as `me`'s own debt.
pub fn borrow_data(asset: &Address, amount: u128, me: &Address) -> Vec<u8> {
    call(BORROW, &[address_word(asset), uint_word(amount), uint_word(VARIABLE_RATE), uint_word(0), address_word(me)])
}

/// `repay(asset, amount, 2, onBehalfOf)`: repays `amount` of `me`'s own debt, of which Aave takes at most the debt.
/// With no amount it repays the whole debt as it stands when the transaction runs, so no dust is left; the address
/// must then hold that much.
pub fn repay_data(asset: &Address, amount: Option<u128>, me: &Address) -> Vec<u8> {
    call(REPAY, &[address_word(asset), amount_word(amount), uint_word(VARIABLE_RATE), address_word(me)])
}

/// `withdraw(asset, amount, to)`: takes `amount` of `asset` out of the collateral, to `me`. With no amount it takes
/// all of it, which Aave allows once nothing is owed.
pub fn withdraw_data(asset: &Address, amount: Option<u128>, me: &Address) -> Vec<u8> {
    call(WITHDRAW, &[address_word(asset), amount_word(amount), address_word(me)])
}

// RLP, for the one shape.

/// The length prefix of a string (`offset` 0x80) or a list (`offset` 0xc0) of `len` bytes.
fn rlp_head(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![offset + len as u8];
    }
    let bytes = minimal(&(len as u64).to_be_bytes()).to_vec();
    let mut head = vec![offset + 55 + bytes.len() as u8];
    head.extend_from_slice(&bytes);
    head
}

/// A byte string: itself if it is one byte under 0x80, else its length prefix and itself.
fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    let mut out = rlp_head(bytes.len(), 0x80);
    out.extend_from_slice(bytes);
    out
}

/// Big-endian bytes with no leading zeros: empty for 0, as RLP writes a number.
fn minimal(bytes: &[u8]) -> &[u8] {
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    &bytes[zeros..]
}

fn rlp_uint(n: u128) -> Vec<u8> {
    rlp_bytes(minimal(&n.to_be_bytes()))
}

/// A list whose items, already encoded, are `payload`.
fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = rlp_head(payload.len(), 0xc0);
    out.extend_from_slice(payload);
    out
}

/// One type 2 transaction before it is signed. Fees are in wei a gas.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub tip: u128,
    pub max_fee: u128,
    pub gas_limit: u64,
    pub to: Address,
    pub data: Vec<u8>,
}

/// A signature as a transaction carries it: `y_parity` is the signer's `recovery_id`, and `r` and `s` are 32-byte
/// big-endian numbers.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSignature {
    pub y_parity: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

impl EvmSignature {
    /// From the signer's answer as `hl_signature` reads it: `r` and `s` as `0x` and 64 hex digits, `v` 27 or 28.
    pub fn from_signer(signature: &HlSignature) -> Option<Self> {
        let y_parity = signature.v.checked_sub(27).filter(|y| *y <= 1)?;
        Some(Self { y_parity, r: word_from_hex(&signature.r)?, s: word_from_hex(&signature.s)? })
    }
}

impl EvmTx {
    /// The nine items every type 2 transaction starts with, each encoded: the value is 0 and the access list empty.
    fn items(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.data.len());
        for n in [u128::from(self.chain_id), u128::from(self.nonce), self.tip, self.max_fee, u128::from(self.gas_limit)]
        {
            out.extend_from_slice(&rlp_uint(n));
        }
        out.extend_from_slice(&rlp_bytes(&self.to));
        out.extend_from_slice(&rlp_uint(0));
        out.extend_from_slice(&rlp_bytes(&self.data));
        out.extend_from_slice(&rlp_list(&[]));
        out
    }

    /// What the signer signs: keccak256(0x02 || rlp(the nine items)).
    pub fn signing_hash(&self) -> [u8; 32] {
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&rlp_list(&self.items()));
        env::keccak256_array(&bytes)
    }

    /// The signed transaction as a node takes it: 0x02 || rlp(the nine items, y_parity, r, s).
    pub fn raw(&self, signature: &EvmSignature) -> Vec<u8> {
        let mut items = self.items();
        items.extend_from_slice(&rlp_uint(u128::from(signature.y_parity)));
        items.extend_from_slice(&rlp_bytes(minimal(&signature.r)));
        items.extend_from_slice(&rlp_bytes(minimal(&signature.s)));
        let mut raw = vec![0x02];
        raw.extend_from_slice(&rlp_list(&items));
        raw
    }
}

/// A sent transaction's hash: the keccak256 of its raw bytes.
pub fn tx_hash(raw: &[u8]) -> [u8; 32] {
    env::keccak256_array(raw)
}

/// One signed transaction the account keeps. The raw bytes and the hash are worked out from it when they are shown.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSigned {
    pub tx: EvmTx,
    pub kind: EvmKind,
    /// The token the call is about. For an approval and a transfer it is also where the transaction goes.
    pub token: Address,
    /// In the token's own units. An approval has no amount: it is 0.
    pub amount: u128,
    pub signature: EvmSignature,
    /// `<pid>:<i>` for a plan step.
    pub step: Option<String>,
    /// The block time the signature arrived (ns).
    pub signed_at: u64,
}

impl EvmSigned {
    pub fn raw(&self) -> Vec<u8> {
        self.tx.raw(&self.signature)
    }

    /// `0x` and the transaction's hash.
    pub fn hash(&self) -> String {
        format!("0x{}", hex(&tx_hash(&self.raw())))
    }

    pub fn view(&self) -> EvmSignedView {
        EvmSignedView {
            nonce: self.tx.nonce,
            kind: self.kind,
            token: address_text(&self.token),
            amount: U128(self.amount),
            to: address_text(&self.tx.to),
            raw: format!("0x{}", hex(&self.raw())),
            hash: self.hash(),
            step: self.step.clone(),
            signed_at: U64(self.signed_at),
        }
    }
}

/// A signed transaction as `get_state().evm.signed` shows it (INTERFACES.md 33). `to` is where the transaction goes:
/// the token for an approval or a transfer, else Aave's Pool. `raw` is what `eth_sendRawTransaction` takes.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSignedView {
    pub nonce: u64,
    pub kind: EvmKind,
    pub token: String,
    pub amount: U128,
    pub to: String,
    pub raw: String,
    pub hash: String,
    pub step: Option<String>,
    pub signed_at: U64,
}

/// The transaction the signer is signing now.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSigning {
    pub tx: EvmTx,
    pub kind: EvmKind,
    pub token: Address,
    pub amount: u128,
    pub step: Option<String>,
    /// The 1Click transfer this transaction sends its token to (`evm_withdraw` with `exp`), which is dropped again if
    /// nothing is signed.
    pub transfer: Option<String>,
    /// Whether this signs a kept transaction again with higher fees (`evm_bump`), which uses no new nonce.
    pub bump: bool,
    /// After this block the signer has answered or timed out, and the next transaction may be signed.
    pub until_block: u64,
}

/// The account's Ethereum side.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Evm {
    /// The nonce the next transaction gets.
    pub nonce: u64,
    /// The newest signed transactions, oldest first.
    pub signed: Vec<EvmSigned>,
    pub signing: Option<EvmSigning>,
    /// The tokens whose approval for Aave's Pool has been signed.
    pub approved: Vec<Address>,
}

/// `get_state().evm`: the next nonce, the kept transactions, oldest first, and the tokens the account has signed an
/// approval of for Aave's Pool, as `0x` addresses in lower case and in the order they were signed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmView {
    pub nonce: u64,
    pub signed: Vec<EvmSignedView>,
    pub approved: Vec<String>,
}

impl Evm {
    pub fn view(&self) -> EvmView {
        EvmView {
            nonce: self.nonce,
            signed: self.signed.iter().map(EvmSigned::view).collect(),
            approved: self.approved.iter().map(address_text).collect(),
        }
    }

    /// Keeps the transaction the signer has just signed, and returns it. A new one takes the next nonce; a bumped
    /// one replaces the kept transaction with its nonce. The newest `MAX_EVM_SIGNED` stay.
    pub fn record(&mut self, signing: EvmSigning, signature: EvmSignature, now: u64) -> EvmSigned {
        let EvmSigning { tx, kind, token, amount, step, bump, .. } = signing;
        let entry = EvmSigned { tx, kind, token, amount, signature, step, signed_at: now };
        let kept = self.signed.iter_mut().find(|old| bump && old.tx.nonce == entry.tx.nonce);
        match kept {
            Some(old) => *old = entry.clone(),
            None => self.signed.push(entry.clone()),
        }
        if !bump {
            self.nonce = self.nonce.max(entry.tx.nonce.saturating_add(1));
            if kind == EvmKind::Approve && !self.approved.contains(&token) {
                self.approved.push(token);
            }
        }
        let excess = self.signed.len().saturating_sub(MAX_EVM_SIGNED);
        self.signed.drain(..excess);
        entry
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::serde_json::{self, json, Value};

    use super::*;

    const POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
    const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
    const USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";

    fn address(text: &str) -> Address {
        parse_evm_address(text).unwrap()
    }

    fn unhex(text: &str) -> Vec<u8> {
        let digits = text.strip_prefix("0x").unwrap_or(text);
        digits.as_bytes().chunks(2).map(|pair| (nibble(pair[0]).unwrap() << 4) | nibble(pair[1]).unwrap()).collect()
    }

    fn selector(signature: &str) -> [u8; 4] {
        let hash = env::keccak256_array(signature.as_bytes());
        [hash[0], hash[1], hash[2], hash[3]]
    }

    #[test]
    fn each_selector_is_the_start_of_its_signatures_hash() {
        assert_eq!(selector("approve(address,uint256)"), APPROVE);
        assert_eq!(selector("transfer(address,uint256)"), TRANSFER);
        assert_eq!(selector("supply(address,uint256,address,uint16)"), SUPPLY);
        assert_eq!(selector("borrow(address,uint256,uint256,uint16,address)"), BORROW);
        assert_eq!(selector("repay(address,uint256,uint256,address)"), REPAY);
        assert_eq!(selector("withdraw(address,uint256,address)"), WITHDRAW);
        // As research/aave.md and FUNDING.md 4.5 write them.
        let written = [APPROVE, TRANSFER, SUPPLY, BORROW, REPAY, WITHDRAW].map(|s| hex(&s));
        assert_eq!(written, ["095ea7b3", "a9059cbb", "617ba037", "a415bcad", "573ade81", "69328dec"]);
    }

    #[test]
    fn each_calls_data_is_its_selector_and_its_arguments_as_words() {
        let (pool, wbtc, usdc) = (address(POOL), address(WBTC), address(USDC));
        let me = address("0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c");
        let word = |text: &str| format!("{:0>64}", text.trim_start_matches("0x").to_lowercase());
        let (pool_w, wbtc_w, usdc_w) = (word(POOL), word(WBTC), word(USDC));
        let me_w = word("d7f35513286b7a0c2a7d8648c72588751ce0dd7c");
        // 0.01 WBTC is 1,000,000 units (0xf4240); $100 is 100,000,000 units (0x5f5e100).
        let cases = [
            (approve_data(&pool), format!("095ea7b3{pool_w}{}", "f".repeat(64))),
            (transfer_data(&me, 1_000_000), format!("a9059cbb{me_w}{}", word("f4240"))),
            (supply_data(&wbtc, 1_000_000, &me), format!("617ba037{wbtc_w}{}{me_w}{}", word("f4240"), word("0"))),
            (
                borrow_data(&usdc, 100_000_000, &me),
                format!("a415bcad{usdc_w}{}{}{}{me_w}", word("5f5e100"), word("2"), word("0")),
            ),
            (
                repay_data(&usdc, Some(100_000_000), &me),
                format!("573ade81{usdc_w}{}{}{me_w}", word("5f5e100"), word("2")),
            ),
            (repay_data(&usdc, None, &me), format!("573ade81{usdc_w}{}{}{me_w}", "f".repeat(64), word("2"))),
            (withdraw_data(&wbtc, Some(1_000_000), &me), format!("69328dec{wbtc_w}{}{me_w}", word("f4240"))),
            (withdraw_data(&wbtc, None, &me), format!("69328dec{wbtc_w}{}{me_w}", "f".repeat(64))),
        ];
        for (data, expected) in cases {
            assert_eq!(hex(&data), expected);
        }
    }

    #[test]
    fn the_calls_data_is_what_aaves_test_market_took_in_a_live_round_trip() {
        // The gas wallet's round trip of 11 Nov on Base Sepolia: each step's `to` and `data` as sent and mined.
        let spike: Value = serde_json::from_str(include_str!("../../../research/data/aave_spike_weth.json")).unwrap();
        let (pool, usdc) = (address(POOL), address(USDC));
        let weth = address("0x4200000000000000000000000000000000000006");
        let me = address(spike["wallet"].as_str().unwrap());
        // 0.01 WETH is 10^16 units, with WETH's 18 decimals; $10 is 10,000,000 units.
        let built = [
            ("approve WETH", weth, approve_data(&pool)),
            ("supply WETH", pool, supply_data(&weth, 10_000_000_000_000_000, &me)),
            ("borrow USDC", pool, borrow_data(&usdc, 10_000_000, &me)),
            ("approve USDC", usdc, approve_data(&pool)),
            ("repay USDC (all)", pool, repay_data(&usdc, None, &me)),
            ("withdraw WETH (all)", pool, withdraw_data(&weth, None, &me)),
        ];
        let steps = spike["steps"].as_array().unwrap();
        for (label, to, data) in built {
            let sent = steps.iter().find(|s| s["label"] == label).unwrap_or_else(|| panic!("no step {label}"));
            assert_eq!(address(sent["to"].as_str().unwrap()), to, "{label}: to");
            assert_eq!(format!("0x{}", hex(&data)), sent["data"], "{label}: data");
        }
    }

    #[test]
    fn rlp_writes_numbers_strings_and_lists_as_ethereum_does() {
        // The examples of Ethereum's own RLP page: 0 is the empty string, 15 is itself, 1024 is two bytes.
        assert_eq!(rlp_uint(0), vec![0x80]);
        assert_eq!(rlp_uint(15), vec![0x0f]);
        assert_eq!(rlp_uint(127), vec![0x7f]);
        assert_eq!(rlp_uint(128), vec![0x81, 0x80]);
        assert_eq!(rlp_uint(1024), vec![0x82, 0x04, 0x00]);
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_bytes(&[]), vec![0x80]);
        assert_eq!(rlp_list(&[]), vec![0xc0]);
        // 55 bytes take a one-byte prefix, 56 a length of the length.
        assert_eq!(rlp_bytes(&[7; 55])[..1], [0xb7]);
        assert_eq!(rlp_bytes(&[7; 56])[..2], [0xb8, 56]);
        assert_eq!(rlp_bytes(&[7; 300])[..3], [0xb9, 0x01, 0x2c]);
        assert_eq!(rlp_list(&[7; 55])[..1], [0xf7]);
        assert_eq!(rlp_list(&[7; 56])[..2], [0xf8, 56]);
        assert_eq!(rlp_list(&[7; 300])[..3], [0xf9, 0x01, 0x2c]);
    }

    #[test]
    fn addresses_are_read_in_any_case_and_written_in_lower_case() {
        assert_eq!(address_text(&address(WBTC)), WBTC.to_lowercase());
        assert_eq!(address(&WBTC.to_lowercase()), address(WBTC));
        for bad in
            ["", "0x5411", "54114591963CF60EF3aA63bEfD6eC263D98145a4", "0xZZ114591963CF60EF3aA63bEfD6eC263D98145a4"]
        {
            assert_eq!(parse_evm_address(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_gas_limit_of_every_kind_is_at_most_500_000() {
        let kinds =
            [EvmKind::Approve, EvmKind::Supply, EvmKind::Borrow, EvmKind::Repay, EvmKind::Withdraw, EvmKind::Transfer];
        let limits: Vec<u64> = kinds.iter().map(|k| k.gas_limit()).collect();
        assert_eq!(limits, vec![100_000, 300_000, 400_000, 300_000, 300_000, 100_000]);
        let names: Vec<Value> = kinds.iter().map(|k| serde_json::to_value(k).unwrap()).collect();
        assert_eq!(names, vec!["approve", "supply", "borrow", "repay", "withdraw", "transfer"]);
        assert!(kinds.iter().all(|k| json!(k.name()) == serde_json::to_value(k).unwrap()));
    }

    /// The vectors `contracts/account/evm-vectors.mjs` wrote: transactions built and signed in Node, with the
    /// `@noble` packages and its own RLP, by a throwaway key.
    fn vectors() -> Value {
        serde_json::from_str(include_str!("evm_vectors.json")).unwrap()
    }

    fn tx_of(v: &Value) -> EvmTx {
        let number = |field: &str| v[field].as_str().unwrap().parse::<u128>().unwrap();
        EvmTx {
            chain_id: number("chain_id") as u64,
            nonce: number("nonce") as u64,
            tip: number("max_priority_fee_per_gas"),
            max_fee: number("max_fee_per_gas"),
            gas_limit: number("gas_limit") as u64,
            to: address(v["to"].as_str().unwrap()),
            data: unhex(v["data"].as_str().unwrap()),
        }
    }

    fn signature_of(v: &Value) -> EvmSignature {
        let word = |field: &str| word_from_hex(v[field].as_str().unwrap()).unwrap();
        EvmSignature { y_parity: v["y_parity"].as_u64().unwrap() as u8, r: word("r"), s: word("s") }
    }

    #[test]
    fn the_encoder_matches_transactions_built_and_signed_in_node() {
        let vectors = vectors();
        // The second list is the sandbox test's (`contracts/tests/tests/aave.rs`), signed by the same key.
        let lists = [&vectors["transactions"], &vectors["sandbox"]["transactions"]];
        let cases: Vec<&Value> = lists.iter().flat_map(|list| list.as_array().unwrap()).collect();
        assert!(cases.len() >= 11, "only {} vectors", cases.len());
        let signer = address(vectors["address"].as_str().unwrap());
        for v in cases {
            let (name, tx, signature) = (v["name"].as_str().unwrap(), tx_of(v), signature_of(v));
            // The hash the signer signs, the raw transaction and its hash, byte for byte.
            assert_eq!(format!("0x{}", hex(&tx.signing_hash())), v["signing_hash"], "{name}: signing hash");
            let raw = tx.raw(&signature);
            assert_eq!(format!("0x{}", hex(&raw)), v["raw"], "{name}: raw transaction");
            assert_eq!(format!("0x{}", hex(&tx_hash(&raw))), v["hash"], "{name}: hash");
            // The signature recovers to the key's address over the hash the encoder made, so a node would take the
            // transaction as that address's.
            let mut both = signature.r.to_vec();
            both.extend_from_slice(&signature.s);
            let key = env::ecrecover(&tx.signing_hash(), &both, signature.y_parity, true).expect("no key recovered");
            assert_eq!(env::keccak256_array(key)[12..], signer, "{name}: recovered address");
        }
    }

    #[test]
    fn the_vectors_cover_every_call_and_the_encodings_edges() {
        let vectors = vectors();
        let cases = vectors["transactions"].as_array().unwrap();
        // Every call's data in the vectors is the data this module builds for it.
        let (pool, wbtc, usdc) = (address(POOL), address(WBTC), address(USDC));
        let me = address(vectors["address"].as_str().unwrap());
        let other = address("0x2031181d63507368232579af4c64a1c3428407ff");
        let built = [
            ("approve", approve_data(&pool)),
            ("supply", supply_data(&wbtc, 1_000_000, &me)),
            ("borrow", borrow_data(&usdc, 100_000_000, &me)),
            ("repay", repay_data(&usdc, Some(100_500_000), &me)),
            ("repay_all", repay_data(&usdc, None, &me)),
            ("withdraw", withdraw_data(&wbtc, Some(1_000_000), &me)),
            ("transfer", transfer_data(&other, 99_000_000)),
        ];
        for (name, data) in built {
            let v = cases.iter().find(|v| v["name"] == name).unwrap_or_else(|| panic!("no {name} vector"));
            assert_eq!(format!("0x{}", hex(&data)), v["data"], "{name}: data");
        }
        // A nonce of 0 (an empty string), one of 128 and one above 255, an `r` and an `s` with a leading zero byte,
        // both parities, and a raw transaction on each side of 256 bytes.
        let nonces: Vec<&str> = cases.iter().map(|v| v["nonce"].as_str().unwrap()).collect();
        assert!(["0", "128", "300"].iter().all(|n| nonces.contains(n)), "{nonces:?}");
        assert!(cases.iter().any(|v| v["r"].as_str().unwrap().starts_with("0x00")));
        assert!(cases.iter().any(|v| v["s"].as_str().unwrap().starts_with("0x00")));
        assert!(cases.iter().any(|v| v["y_parity"] == 0) && cases.iter().any(|v| v["y_parity"] == 1));
        let lengths: Vec<usize> = cases.iter().map(|v| (v["raw"].as_str().unwrap().len() - 2) / 2).collect();
        assert!(lengths.iter().any(|l| *l < 256) && lengths.iter().any(|l| *l >= 256), "{lengths:?}");
    }

    #[test]
    fn a_signature_is_read_from_the_signers_answer() {
        let signature =
            HlSignature { r: format!("0x{}", "ab".repeat(32)), s: format!("0x00{}", "cd".repeat(31)), v: 28 };
        let read = EvmSignature::from_signer(&signature).unwrap();
        assert_eq!((read.y_parity, read.r, read.s[0], read.s[1]), (1, [0xab; 32], 0, 0xcd));
        assert_eq!(EvmSignature::from_signer(&HlSignature { v: 27, ..signature.clone() }).unwrap().y_parity, 0);
        // Anything else is not a signature a transaction can carry.
        assert_eq!(EvmSignature::from_signer(&HlSignature { v: 29, ..signature.clone() }), None);
        assert_eq!(EvmSignature::from_signer(&HlSignature { v: 0, ..signature.clone() }), None);
        assert_eq!(EvmSignature::from_signer(&HlSignature { r: "0xab".into(), ..signature }), None);
    }

    fn signing(nonce: u64, kind: EvmKind, bump: bool) -> EvmSigning {
        let tx = EvmTx {
            chain_id: 84532,
            nonce,
            tip: TIP_WEI,
            max_fee: 1_000_000_000,
            gas_limit: kind.gas_limit(),
            to: address(POOL),
            data: vec![1, 2, 3],
        };
        let step = Some("f1005:0".to_string());
        EvmSigning { tx, kind, token: address(WBTC), amount: 5, step, transfer: None, bump, until_block: 9 }
    }

    fn signature(byte: u8) -> EvmSignature {
        EvmSignature { y_parity: 1, r: [byte; 32], s: [byte; 32] }
    }

    #[test]
    fn a_signed_transaction_takes_the_next_nonce_and_shows_its_raw_bytes_and_hash() {
        let mut evm = Evm::default();
        let entry = evm.record(signing(0, EvmKind::Supply, false), signature(7), 42);
        assert_eq!((evm.nonce, evm.signed.len(), evm.approved.len()), (1, 1, 0));
        let view = serde_json::to_value(evm.view()).unwrap();
        let raw = format!("0x{}", hex(&entry.raw()));
        let expected = json!({ "nonce": 1, "signed": [{
            "nonce": 0, "kind": "supply", "token": WBTC.to_lowercase(), "amount": "5", "to": POOL.to_lowercase(),
            "raw": raw, "hash": format!("0x{}", hex(&tx_hash(&entry.raw()))), "step": "f1005:0", "signed_at": "42",
        }], "approved": [] });
        assert_eq!(view, expected);
        assert!(raw.starts_with("0x02f8"), "{raw}");
        // An approval is noted, so that it is signed once per token, and the view shows it.
        evm.record(signing(1, EvmKind::Approve, false), signature(7), 43);
        assert_eq!((evm.nonce, evm.approved.clone()), (2, vec![address(WBTC)]));
        assert_eq!(serde_json::to_value(evm.view()).unwrap()["approved"], json!([WBTC.to_lowercase()]));
    }

    #[test]
    fn a_bumped_transaction_replaces_the_kept_one_and_uses_no_new_nonce() {
        let mut evm = Evm::default();
        evm.record(signing(0, EvmKind::Supply, false), signature(7), 42);
        evm.record(signing(1, EvmKind::Borrow, false), signature(7), 43);
        let mut again = signing(0, EvmKind::Supply, true);
        again.tx.tip = 2 * TIP_WEI;
        let entry = evm.record(again, signature(9), 50);
        assert_eq!((evm.nonce, evm.signed.len()), (2, 2));
        assert_eq!((evm.signed[0].clone(), evm.signed[0].tx.tip, evm.signed[0].signed_at), (entry, 2 * TIP_WEI, 50));
        assert_eq!(evm.signed[1].tx.nonce, 1);
    }

    #[test]
    fn only_the_newest_20_signed_transactions_are_kept() {
        let mut evm = Evm::default();
        for nonce in 0..25 {
            evm.record(signing(nonce, EvmKind::Repay, false), signature(7), nonce);
        }
        assert_eq!((evm.nonce, evm.signed.len()), (25, MAX_EVM_SIGNED));
        assert_eq!((evm.signed[0].tx.nonce, evm.signed[19].tx.nonce), (5, 24));
    }
}
