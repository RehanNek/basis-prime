# Funding from Aave and Rhea, with our own pricing: implementation plan

**Status: a plan, written on Tue 10 Nov 2026 at 21:30 UTC. Nothing here is built.** It waits for the go-ahead and the approvals in section 14. The submission closes on Sat 14 Nov at 23:59 UTC.

> **In simple words.** Today every dollar we lend is our own. This plan lets a client's account also borrow from two outside lenders, Aave and Rhea, in its own name. A lender looks only at the bitcoin it holds, so it lends only part of the loan. Our pool lends the rest: the extra amount our engine allows because it also sees the hedge. The client signs one permission when the account is opened, then asks for one amount. The engine picks the cheapest safe source, keeps each lender's safety cushion topped up, and we charge the client whatever rate we choose: our pool pays or keeps the difference.

The numbers behind this plan are in `research/rhea.md` section 11 and `research/aave.md`.

## Contents

1. What we are building
2. One loan, start to finish
3. The parts and what changes in each
4. The account contract
5. The pool contract: pricing
6. The risk engine
7. The keeper and the backend
8. The web app
9. Testnet setup
10. Tests and gates
11. Schedule, stages and cut rules
12. Risks
13. How a client could try to cheat us, and what stops it
14. What I need from you
15. Choices I made, for you to veto
16. Left out on purpose

---

## 1. What we are building

**Decided in our talks of 10 and 11 Nov:**

| Decision | What it means here |
|---|---|
| Self-custody stays | Each client's bitcoin and each lender loan sit in that client's own account. We never hold the assets and re-pledge nothing |
| One position per client | No shared pot. Our own lending money stays pooled, as it is today |
| A managed account | The client signs one permission, in the same step that opens the account. After that the engine picks and changes the funding mix inside its limits |
| Two lenders | Aave v3, reached through Chain Signatures, and Rhea on NEAR. Each is a plug, so a third can follow |
| Cheapest safe source first | Aave before our pool while Aave is cheaper than our rate. Our pool before Rhea while Rhea is dearer |
| A cushion per lender | We never borrow a lender's maximum. Rhea and Aave both sell the moment their line is crossed |
| Our own pricing | The client pays the rate we set, on the whole loan. Our pool settles the difference with the lender's real cost, as a fee or a subsidy |

**Why two lenders:**

| | Aave v3 | Rhea |
|---|---|---|
| USDC borrow rate on 10 Nov | 5.3% on Ethereum, 4.0% on Arbitrum | 15.9% |
| Room before our own borrowing hurts | About $19.5M on each of those chains | About $250k |
| Most it lends against bitcoin | 81%, and it liquidates at 85% | 76%, which is also where it liquidates |
| Penalty if liquidated | 5% to 7.5%, on up to half the loan at once | About 0.3%, in small slices |
| Where the bitcoin must sit | On Aave's chain, as WBTC. 1Click turns nBTC into it in about 30 seconds, for 0.4% to 0.6% at $100,000 | On NEAR, as nBTC |
| Its job | The main outside source | The NEAR-native source, and overflow |

## 2. One loan, start to finish

The worked example: $100,000 of bitcoin, a $100,000 short on Hyperliquid with $35,000 of margin, and a $94,500 credit line.

1. **Open.** The client opens an account, and the same signature stores the funding permission (4.2). They add collateral as today.
2. **Ask.** The client types $94,500 and clicks Borrow. The app has already shown the rate.
3. **Check.** The account asks the engine for a check with the new intent `fund`. The engine reads the whole book, including what the account already has at each lender.
4. **Split.** The engine answers with a funding plan of at most six steps. With Aave as the cheaper source and a cushion of 1.5:
   - move the bitcoin to Aave's chain as WBTC, through 1Click, if it is still nBTC on NEAR;
   - post it at Aave and borrow $56,667 there;
   - bring that USDC back to the account on NEAR, through 1Click;
   - borrow $37,833 from our pool.
5. **Approve.** The client's wallet signs `fund`. That one signature approves the whole plan.
6. **Run.** The keeper runs the steps over a few minutes, because some cross chains. The app shows each one going from waiting to done.
7. **Watch.** Each check reports every lender's cushion. If one falls under 1.35, the engine stores a plan that tops it up, and the keeper runs it. No signature is needed, because it only lowers risk.
8. **Price.** Once an hour the keeper settles pricing (5.2). The client's debt to our pool moves up by a fee or down by a subsidy, so their whole loan costs the rate we set.
9. **Leave.** The client can always repay a lender and take collateral back by themselves. Repaying needs no check.

## 3. The parts and what changes in each

| Part | Change | Size |
|---|---|---|
| Account contract | The permission, the `fund` plan, the Rhea calls, Ethereum transactions for Aave, pricing settlement | Large |
| Pool contract | Pricing policies and settlement, and a state migration | Medium |
| Factory and shared types | Lender settings in `Config`, and a migration | Small |
| `pb-read` | Reads each lender position and builds the book with it | Large |
| `pb-risk` | The cushion rule, the split, new plan steps, new verdict fields | Large |
| `risk-core` | A `WBTC` token, and nothing else: the checked maths stays as it is | Small |
| `pb-gateway` | A rebuild, so it sees outside loans and knows the new step kinds | Small |
| `backtest` | A replay of each lender's cushion over the crash days | Small |
| Backend | Lender terms, lender positions, a relay for Ethereum transactions, a gas helper | Medium |
| Keeper | Watches cushions, runs the new steps, settles pricing, keeps the Rhea copy's price fresh | Medium |
| Web app | The permission step, one loan with its split, lender cards, pricing controls | Medium |
| Testnet | Our copy of Rhea, Aave's own test market, gas and test tokens, and two new routes in the 1Click stand-in | Medium |

**The safety rule for the build:** new code reaches new accounts only. An account's code, engine and gateway are fixed when it is made, so today's accounts and demos keep working untouched.

## 4. The account contract

Files: `contracts/account/src/`, with new modules `permission.rs`, `lender.rs` and `evm.rs`. The shared `Config` is in `contracts/types/src/lib.rs`.

### 4.1 Settings

`Config` gains one field, `lenders`, filled by the factory for new accounts:

```rust
pub struct Lenders {
    pub rhea: Option<RheaLender>,
    pub aave: Option<AaveLender>,
}
pub struct RheaLender {
    pub contract_id: AccountId,        // our copy on testnet; contract.main.burrow.near on mainnet
    pub collateral: Vec<AccountId>,    // tokens the account may post: nBTC
}
pub struct AaveLender {
    pub chain_id: u64,                 // 84532 on testnet (Base Sepolia)
    pub pool: String,                  // 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27 on testnet
    pub usdc: EvmToken,
    pub collateral: Vec<EvmToken>,     // WBTC
    pub max_fee_per_gas: U128,         // wei: the account signs nothing dearer
}
pub struct EvmToken { pub symbol: String, pub address: String, pub decimals: u8 }
```

The factory needs a second migration, like its Phase 3 one, because its stored `Config` changes shape.

### 4.2 The permission

```rust
pub struct Permission {
    pub lenders: Vec<String>,   // "rhea", "aave"
    pub min_hf_bp: u32,         // the smallest cushion the client accepts, such as 15000 for 1.5
    pub max_rate_bp: u32,       // the dearest lender rate the client accepts
    pub moves: Moves,           // Off | LowerCostOnly | Any: may the engine move the loan between sources?
}
```

- **Stored at opening.** The factory's `create_account` takes the permission and hands it to the new account, so opening and permitting are one signature. The app shows its terms before the client signs.
- **`set_permission(permission)`:** the owner only, with 1 yoctoNEAR. It bumps the counter, so a check made under the old permission backs nothing. The owner can cancel the permission this way: no new lender borrowing then happens, and what is already borrowed stays until it is repaid. Cancelling never stops a top-up.
- **Shown in** `get_state().permission`. The engine reads it there.
- **An account with no permission** uses our pool only. That is the case for accounts made before this change.

### 4.3 Asking for a loan

Two new intents join `check`, `borrow` and `withdraw`:

| Intent | JSON | Used for |
|---|---|---|
| Fund | `{"fund":{"amount":"<micro-USD>"}}` | "I want this much in total. Pick the sources." |
| Lender withdraw | `{"lender_withdraw":{"lender":"rhea","token":"<id>","amount":"<units>"}}` | Taking collateral back from a lender while any loan is open |

- **`fund(amount)`:** the owner only, with 1 yoctoNEAR. It needs a fresh, HEALTHY verdict that answers `fund` for this amount.
  - It stores the verdict's `fund` steps as a **funding plan**, in a field of its own, so a later check can't clear it. Its id is `f` and the verdict's block number, which keeps it apart from an unwind plan.
  - It bumps the counter, so the verdict backs nothing else.
- **`execute_step`** runs funding steps too. Anyone may call it, as today, on an account that isn't blocked and has no overdue transfer. Funding steps run strictly in the plan's order.
  - **The plan lasts 30 minutes,** because moving bitcoin between chains and borrowing there takes a few minutes.
  - **Every step that adds debt is checked again.** A lender borrow and our pool's borrow each need a fresh verdict at the moment they run, which the keeper asks for. Each borrows at most what that verdict allows: the lender's room for a lender step, our pool's allowance for the pool's. So no money is lent on an old reading, and the plan itself is never counted as debt.
  - **Our pool's step comes last.**

| Step | JSON | What the account does |
|---|---|---|
| Pool borrow | `{"k":"p_borrow","amt":37833000000}` | Borrows from our pool: this amount, or what the fresh verdict allows if that is less |
| Lender supply | `{"k":"l_supply","l":"rhea","tok":"<id>","amt":"<units>"}` | Posts collateral at the lender |
| Lender borrow | `{"k":"l_borrow","l":"aave","amt":56667000000}` | Borrows USDC from the lender |
| Move collateral | `{"k":"to_evm","tok":"<id>","amt":"<units>","dep":"<deposit address>","exp":<ms>}` | Sends the token to a 1Click deposit address, which delivers wrapped bitcoin to the account's own Ethereum address. It works like today's `sell` step |
| Bring the loan home | `{"k":"e_home","amt":56667000000,"dep":"0x…","exp":<ms>}` | Signs a USDC transfer on Aave's chain to a 1Click deposit address, which delivers USDC to the account on NEAR |
| Lender repay | `{"k":"l_repay","l":"rhea","amt":10133000000}` | Repays the lender. Only in a top-up plan (6.5) |
| Lender add | `{"k":"l_add","l":"rhea","tok":"<id>","amt":"<units>"}` | Adds spare collateral. Only in a top-up plan |

- **Direct calls for leaving.** The client must never depend on us to get out:
  - `lender_repay(lender, amount)`: the owner at any time, and anyone under the rules that already open `repay` to everyone.
  - `lender_withdraw(lender, token, amount)`: the owner. It needs a verdict only while the account owes our pool.

### 4.4 Rhea

Rhea is on NEAR, so these are plain calls to the Burrow contract (`research/rhea.md` 2):

| Action | Call |
|---|---|
| Register, once | `storage_deposit({"account_id", "registration_only": true})` with 0.1 NEAR from the account's own balance |
| Supply | `<token>.ft_transfer_call` to Rhea with msg `"\"OnlyIncreaseCollateral\""` |
| Borrow | `execute_with_pyth({"actions":[{"Borrow":{"token_id","amount"}},{"Withdraw":{"token_id","max_amount"}}]})` with 1 yoctoNEAR. The `Withdraw` must say `max_amount`: with `amount` it fails once the token has earned interest. The borrower can receive one unit less than it borrowed |
| Repay | `<usdc>.ft_transfer_call` to Rhea with msg `"\"OnlyRepay\""` |
| Withdraw | `execute_with_pyth` with `DecreaseCollateral`, then `Withdraw` |

- **Amounts** use Rhea's inner decimals: 18 for both USDC and nBTC.
- **Rhea doesn't always report failure.** On mainnet `execute_with_pyth` returns success even when its own callback fails. On our copy, with fixed prices, a refused borrow fails the call; but a transfer that can't land still reports success, and Rhea keeps the money as the borrower's deposit. So the account never books a Rhea loan itself. The engine reads the real position at every check, and that reading is the truth.
- **A Rhea action counts as done for 20 blocks.** Rhea finishes a borrow or a withdrawal a block or two after our call returns. Until then the account lists it as pending, the engine adds it to the debt, and nothing else that adds risk runs. The account bumps its counter when the wait ends.
- **Gas:** 150 TGas for a priced action. On our copy a borrow burns 12 TGas and needs 30 attached; mainnet measured 43 to 64.

### 4.5 Aave

Aave is on an Ethereum-style chain. The account already owns an address there: the one Chain Signatures gave it for Hyperliquid, which is the same on every such chain. It signs Ethereum transactions the way it signs Hyperliquid actions today, and the backend sends them.

- **The transaction** is Ethereum's type 2 (EIP-1559). The account builds it in `evm.rs`: a small RLP encoder written for this one shape, with no new dependency.
  - The hash to sign is `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, to, 0, data, []]))`.
  - The signer's `recovery_id` is the transaction's `y_parity`.
- **The calls** it can build, and nothing else:

| Call | To | Selector |
|---|---|---|
| `approve(pool, max)` | The token. Not a plan step: `evm_approve(token)` is a call of its own that anyone may make, once per token | `0x095ea7b3` |
| `supply(asset, amount, self, 0)` | Aave's Pool | `0x617ba037` |
| `borrow(usdc, amount, 2, 0, self)` | Aave's Pool | `0xa415bcad` |
| `repay(usdc, amount, 2, self)` | Aave's Pool | `0x573ade81` |
| `withdraw(asset, amount, self)` | Aave's Pool | `0x69328dec` |
| `transfer(deposit address, amount)` | USDC, and only inside an `e_home` step | `0xa9059cbb` |
| `transfer(to, amount)` | Any listed token, through `evm_withdraw` | `0xa9059cbb` |

  The tests recompute every selector from its signature.
- **Signing** reuses today's path: the signer's `sign` with the digest, then a callback that stores the finished transaction in `evm.signed` (the newest 20) and logs an `evm_signed` event. The backend reads it from the chain and sends it.
- **Nonces.** The account counts its own Ethereum nonce. `evm_bump(index, fees)` re-signs a stuck transaction with a higher fee, never above the config's limit.
- **The stale-signature rule.** A signed Ethereum transaction never expires, and anyone can send it. So a signed borrow or withdrawal counts as done from the moment it is signed:
  - the engine counts it as debt already;
  - nothing else that adds risk runs until the chain shows it mined.

  This is the rule the account already applies to a signed Hyperliquid transfer.
- **Leaving.** `evm_withdraw(token, amount, to)` sends a token from the Ethereum address to any address. The owner only. While the account owes our pool, it needs a verdict for that withdrawal, exactly as `withdraw` does on NEAR.
- **Gas.** The address needs a little of that chain's ETH. On testnet the backend's gas wallet sends it (7.2), with a daily limit per account. On mainnet the account buys its own through 1Click.

### 4.6 What the contract enforces itself

These hold even if the engine is wrong:

- Assets leave only to the pool, to a lender named in the config (as the account's own position), to the account's own Hyperliquid or Ethereum address, or to a 1Click deposit address inside a plan step, which the pool checks as it checks an unwind's sale today.
- New debt needs the owner's `fund` signature and never exceeds the amount they asked for.
- A lender outside the permission is never used.
- Repaying is never blocked.

The cushion and the rate ceiling are checked by the engine inside the enclave, and each verdict carries them.

### 4.7 Pricing

- **`settle()`:** anyone may call it. It needs a fresh verdict and passes the verdict's lender report to the pool's `settle` (5.2).

## 5. The pool contract: pricing

Files: `contracts/pool/src/`, with a new module `pricing.rs`.

### 5.1 Policies

The operator sets what a client pays, for one account or for a whole tier:

```rust
pub enum Pricing {
    PassThrough,                                       // today: each source at its own price
    Lender { margin_bp: i32, cap_bp: Option<u32> },    // the lender's rate plus a margin, capped
    Fixed { rate_bp: u32 },                            // one rate on the whole loan
}
```

| Policy | The client pays | We earn or pay |
|---|---|---|
| `PassThrough` | The lender's rate on the lender's part, our rate on ours | Nothing extra |
| `Lender { margin_bp: 120 }` | The lender's rate plus 1.2 points | We keep the margin |
| `Lender { margin_bp: 0, cap_bp: 800 }` | The lender's rate, but never above 8% | We pay whatever is above 8% |
| `Fixed { rate_bp: 650 }` | 6.5% on everything | The whole difference, either way |

- **`set_pricing(target, pricing)`:** the operator only. `target` is an account or a tier. A public event records every change.
- **The pool's own curve and tier spreads** stay under `set_rates`, as today.

### 5.2 Settlement

`settle(report)` is called by an account contract with its verdict's lender report: for each lender, the debt and the lender's rate. At a borrow from a lender the account passes two reports: `closes`, the debts just before the borrow, and `report`, the debts with it.

1. The pool accrues its own interest, as on every call.
2. For the time since the last settlement it works out:
   - **the target:** what the policy says the client should have paid;
   - **the actual:** our pool's own interest on its part, plus the lender's rate on the lender's part, using the previous report.
3. The difference is the **adjustment**:
   - **positive, a fee:** it is added to the client's debt to our pool. A fee is owed for all the time since the last settlement, however long that was;
   - **negative, a subsidy:** it is taken off that debt. If the debt reaches zero, the rest is kept as a credit that the account can claim in USDC. A subsidy is paid for 48 hours of that time at most.
4. The pool stores the new report for the next period. At a borrow, the period closes on `closes` and the next one starts from `report`.

**Three rules keep a client from gaming this** (section 13, cases 1 to 3):
- **A settlement runs at every lender borrow,** not only once an hour, and at a lender repayment when the account holds a fresh verdict. The account calls it as part of the step, so the debt can't be large between settlements and small at them. A repayment with no fresh verdict is covered by the next hourly settlement, under the next rule.
- **For a period, the pool takes the figure that favours it:** the smaller of the two reported debts when it pays a subsidy, and the larger when it charges a fee.
- **A subsidy never takes the client's rate below what the same lender pays depositors.** Otherwise a client could borrow through us and lend the money straight back for a profit.

**A borrow reports both ends of the period.** A client who repaid a lender and borrows there again owed it nothing in between. With one figure for both ends, the pool would see $50,000 on each side of the gap: it would pay a subsidy for interest nobody paid, or charge its margin on a loan that wasn't there. So the borrow says what was owed just before it ($0) and what is owed now ($50,000). The gap closes on the $0, and the next period starts from the $50,000.

No cash moves in the usual case. The lender's interest keeps growing at the lender, and our side moves the other way. Together the client's whole debt grows at the rate we set.

### 5.3 Limits

A wrong report can't cost the pool or a client more than these:

- the lender's rate is counted at no more than its average over the last 7 days plus 5 points, and never above 60% a year, so a rate pushed up for a few hours earns no subsidy;
- a lender's debt is counted at no more than $1,000,000, at both ends of the period. A report that shows $17.5 trillion owed at Aave is priced as $1,000,000;
- a pool-wide subsidy budget per 24 hours, kept like the daily lending budget: 0.05% of the pool's capital;
- a subsidy cap per account per 24 hours: $100;
- the same two budgets for fees: at most $1,000 a day per account, and 0.5% of the pool's capital a day for all accounts together. What a budget cuts is not owed later. So one wrong report can add $1,000 to a client's debt, not $4 million, and the pool's capital, its daily lending budget and its rates barely move;
- the operator can take a wrong fee back (`reverse_fee`). It comes off the client's debt, up to the fees that client was charged. No cash moves;
- only accounts made by our factory can call `settle`.

The operator can change each figure (`set_pricing_limits`), and the pause stops settlements altogether.

### 5.4 State and migration

- Pricing lives in maps of its own, so no borrower record changes shape.
- The pool's root state gains fields, so the upgrade needs a `migrate` call. Our sandbox tests already load the live pool's saved state, and the migration is tested against it before it touches testnet.
- **Fallback:** a fresh pool for new accounts, if the migration fails that test.

### 5.5 Views and events

- `get_pricing(account_id)`, and the borrower view gains `pricing`, `fees_charged`, `subsidy_paid` and `credit`.
- `get_pool` gains the totals and what is left of the subsidy budget.
- Events: `SetPricing` and `Settle`.

## 6. The risk engine

Files: `risk/pb-read/`, `risk/pb-risk/`, `risk/backtest/`, and constants in `risk/risk-core/`.

### 6.1 New reads

Every read goes into `Inputs`, so a verdict stays a pure function of what was read. New fields are left out when empty, so today's saved runs replay to the byte.

| Read | How | Calls |
|---|---|---|
| The permission and the lender settings | Already in `get_state` and `get_config` | 0 |
| The Rhea position | `get_account` on the Rhea contract | 1 |
| Rhea's ratios and USDC rate | `get_assets`, as the credit check does | 1 |
| The Aave position | `eth_call` of `getUserAccountData`, and the data provider's read for the WBTC and USDC amounts | 2 |
| Aave's USDC rate | `eth_call` on the data provider | 1 |
| USDC at the Ethereum address | `eth_call` of `balanceOf` | 1 |
| The address's Ethereum nonce | `eth_getTransactionCount` | 1 |

- `read::rpc` already posts JSON-RPC over https, so `eth_call` works as it is. A small hex and ABI decoder is new.
- A check makes 23 to 28 calls today. This adds up to 7, well inside the 20 seconds.
- **If a lender can't be read** for an account that uses it, the engine refuses to answer. The account keeps its last verdict, and nothing that adds risk can run.

### 6.2 The book with lenders

In `book::build_with`:

- **Debt:** each lender's loan is added to the account's debt. Every credit rule and state then sees the whole debt. Leaving it out would be unsafe: an account with no pool debt always reads as healthy.
- **Collateral:** tokens posted at a lender count toward the account's value. They are also marked **locked**, with USDC sitting at the Ethereum address, so no step tries to sell or move them from NEAR.
- **Prices:** `held_coins` must price a coin that is held only at a lender.
- **WBTC** becomes a sixth token, with nBTC's risk settings: the same depeg sizes and the same kind of cap. It touches `TOKENS`, `check_snapshot`, `TOKEN_NAMES` and three places that list the bridged tokens by name.

**Using the checked maths unchanged.** `risk-core`'s credit functions are checked against the Python reference, and they treat all debt as our pool's. So `pb-risk` calls them twice and takes the smaller answer:

| Call | Debt passed | Pool limits passed | Gives |
|---|---|---|---|
| Risk room | Pool and lenders together | None | How much more the book can carry at all |
| Pool room | Our pool's only | The real ones | How much more our pool's own caps allow |

- `allow.borrow`, which the pool trusts, is the smaller of the two.
- `credit.line` becomes the whole debt plus that room.
- A week of the gap between the lender's rate and ours is added to debt first, because the stress test charges our pool's rate on everything.

### 6.3 The cushion rule

For each lender the engine computes the health factor the way the lender does:

- **Rhea:** collateral × 0.80 ÷ (debt ÷ 0.95), with nBTC priced as BTC. I confirmed on 10 Nov that Rhea prices it that way.
- **Aave:** the health factor comes back with the position.

| Level | Cushion | What happens |
|---|---|---|
| Target | 1.5, or the permission's if higher | New lender borrowing stops here |
| Act | 1.35 | A REBALANCE plan tops the lender up (6.5) |
| Now | 1.2 | REBALANCE_NOW: the same plan, acted on at once |

The backtest set the final numbers (6.8). Act and Now were 1.3 and 1.15 until 11 Nov: the worst crash on record leaves about 4 minutes at 1.15 and 20 at 1.2, and 45 minutes at 1.3 against over two and a half hours at 1.35. A permission's own cushion must be 1.2 or more.

### 6.4 The split

For a `fund` intent of amount X:

1. **Total room** = the smaller of X and the risk room.
2. **Each allowed lender's room** = collateral there × its liquidation ratio ÷ the target cushion, less its debt. It is zero when the lender's rate is above the permission's ceiling, and it is cut to what the lender has free.
3. **Order:** sources are sorted by what they cost us, the lender's rate against our pool's rate for the client's tier. The operator can force our pool first or the lender first with a pool setting (`funding.order`).
4. **Fill** in that order, using one lender at most per request, then our pool up to the pool room.
5. **Answer:** the `fund` steps, at most six. If collateral has to be posted first, an `l_supply` step comes before the `l_borrow`.

**Moving the bitcoin.** A client who bought bitcoin through us holds nBTC on NEAR, which Aave can't take. 1Click turns it into WBTC at the account's own Ethereum address (`research/aave.md`).
- **The move has a price:** about 0.4% to 0.6% each way at $100,000 on 10 Nov, and nothing was quoted at $500,000.
- **So the engine counts it against Aave.** It moves bitcoin only when the saving over the loan's expected life beats the cost of the move, there and back (your decision of 11 Nov; until stage 3 it counted the trip there only). The operator sets that life; the default is 90 days.
- **A client who arrives with USDC** can have the bitcoin bought in the right form from the start, which saves one move.
- **On testnet the engine can't plan these moves,** because it can't reach our 1Click stand-in from inside the enclave. The client starts them from the app instead, the way they move USDC to Hyperliquid today.

### 6.5 Topping up a lender

When a cushion is under the act level, the engine adds REBALANCE with steps in this order:

1. `l_add`: spare collateral from the account, which takes seconds.
2. `l_repay`: from USDC the account holds on that lender's chain.
3. `home`, then `l_repay`: bring the short's winnings back from Hyperliquid. This needs 1Click, so on testnet the plan says so and stops, as it does today for margin moves.

It reuses REBALANCE, so the account stores the plan at once and needs no new action type. **Top-ups run whatever the permission says,** even after the client cancels it: they only lower risk, and a client must not be able to switch them off (section 13, case 5).

### 6.6 New verdict fields

All are left out when empty. A verdict stays under 2,000 bytes; today's are about 900.

| Field | Example | Read by |
|---|---|---|
| `ext` | `[{"l":"aave","c":100000000000,"d":56667000000,"hf_bp":15000,"r_bp":533,"s_bp":410,"room":0,"liq_bp":8500}]`: per lender, the collateral, the debt, the cushion, the lender's borrow and deposit rates, how much more it can lend this account, and where it liquidates | The account for `settle` and for a lender borrow step, the keeper, the app |
| `fund` | The funding steps (4.3) | The account's `fund` |
| `allow.fund` | What those steps borrow in all | The app |
| `evm` | `{"nonce":7}` | The account, to clear mined transactions |

### 6.7 The gateway

`pb-gateway` uses the same reader, so a rebuild makes it see lender debt in every pre-trade check. Two things need care:

- **Its plan reader refuses a plan with a step kind it doesn't know.** `PlanStep` gains the new kinds, and new accounts pin the new build.
- **Its "live allowance" rule** must count a stored funding plan as debt about to arrive, as it counts a fresh borrow verdict today.

Publishing a new gateway build also means adding its hash to the seed's access rule.

### 6.8 The backtest

A new subcommand, `backtest lender`, replays the ten crash windows minute by minute. For each lender and each cushion (1.2, 1.3, 1.5, 1.75, 2.0) it reports:

- the lowest health factor reached, and the first minute under 1.0;
- with top-ups arriving 2, 15 or 60 minutes late: how much the lender would sell, what the penalty costs, and how far the hedge is left lopsided.

It runs beside the existing simulator, so the pinned simulator output doesn't change. Its table sets the cushion levels of 6.3.

## 7. The keeper and the backend

### 7.1 Keeper (`services/keeper`)

- **Watch:** `Seen` gains the lenders' health factors from the last verdict. `decide()` asks for a check when BTC has moved enough to bring a cushion near the act level.
- **Run:** `EXECUTE_KINDS` gains `p_borrow`, `l_supply`, `l_borrow`, `l_repay`, `l_add`, `to_evm` and `e_home`. The keeper runs a funding plan's steps the moment `fund` stores it, and asks for the fresh check that the pool's step needs.
- **Send:** it sends newly signed Ethereum transactions, as a backup to the backend, the way `SignedPoster` backs up Hyperliquid posts.
- **Settle:** once an hour, after its hourly check, it calls `settle` for each account with a lender loan.
- **Rhea's price on testnet:** it keeps our copy's BTC price within 0.25% of Hyperliquid's oracle.
- **Demo:** `pnpm --filter @pb/keeper funding:demo -- --lender rhea|aave` runs the gate of section 10 and writes `research/data/phase6_funding_<lender>.json`.

### 7.2 Backend (`services/api`)

| Endpoint | What |
|---|---|
| `GET /api/lenders` | Each lender's live terms: rate, what is free, the most it lends, where it liquidates, the penalty. Kept 5 minutes, like `/api/rhea` |
| `GET /api/lender/:account` | The account's position at each lender, and its signed Ethereum transactions with their status |
| `POST /api/evm/submit` | `{account, index}`: reads that signed transaction from the chain, checks it, and sends it with `eth_sendRawTransaction`. Copied from `postHlSubmit` |
| `POST /api/funding-plan` | The split for an account or a sample book, from a free preview run |
| `POST /api/quote` | Two new moves beside `to_hl` and `home`: `to_evm` (bitcoin to the account's Ethereum address) and `e_home` (USDC back to NEAR) |
| `POST /api/evm/gas` | Testnet: sends a little gas to an account's Ethereum address, and mints test WBTC to it from Aave's faucet. Rate-limited |

New settings (names only): `EVM_RPC_URL`, `EVM_CHAIN_ID`, `AAVE_POOL_ADDRESS`, `AAVE_FAUCET_ADDRESS`, `EVM_GAS_PRIVATE_KEY`, `RHEA_ACCOUNT_ID`.

## 8. The web app

| Where | Change |
|---|---|
| Setup checklist | "Open your account" now shows the permission of 4.2 and its terms, and one signature does both. A testnet step, "Move bitcoin to Aave", starts the move of 6.4 |
| Borrow panel | One amount and one rate. Under it, "where it comes from": each source, its amount and its cost. The button runs check, `fund`, then shows the steps as the keeper runs them |
| Home | One loan total. A card per lender with a cushion bar like the health bar: safe, thin, selling. Repay pays the dearest source first |
| Book page, for the operator | Pricing controls per account and per tier, the fees earned and subsidies paid, and what is lent through each lender |
| Credit check | "How this loan would be funded", with live Aave and Rhea terms. No wallet needed |
| Preview page | New sample states for the lender cards |

## 9. Testnet setup

| What | How |
|---|---|
| **Rhea** | Rhea runs no testnet. We deploy Rhea's own published contract file, `burrowland_release.wasm` (version 0.15.7), to `rhea.pbf-ops.testnet`. Mainnet runs 0.16.2, whose health-factor and liquidation code is the same (`research/rhea.md` 1). We list our test USDC and test nBTC with mainnet's ratios (9500 and 8000) and rate curve, and lend it test USDC to lend out. The copy's account needs 11 NEAR, because the file locks 10.18. The operator owns it. The operator also borrows part of its own deposit there, so that the copy charges about mainnet's rate (15.9% to borrow, 10.2% for deposits) and not 0%. Its caps are raised, so that a stranger with faucet tokens can't fill them. Sandbox-tested on 11 Nov (`research/rhea.md` 12) |
| **Rhea's prices** | Each token gets a fixed price in the contract, which Rhea's code uses in place of a live feed. The keeper updates BTC's as it moves |
| **Aave** | Aave's own test market on Base Sepolia. Test WBTC is collateral there at a live BTC price, and test USDC can be borrowed |
| **Test WBTC** | Aave's faucet is open to anyone: up to 1 WBTC per call, once an hour per address |
| **Gas** | A gas wallet for Base Sepolia, funded from a public faucet (section 14) |
| **New versions** | New `pb-risk` and `pb-gateway` builds, pinned in the factory's config. The factory and pool are migrated |
| **Accounts** | Fresh accounts for every demo. 6 NEAR each, because the account's code grew to 471,865 bytes with Rhea's steps (it locks 4.73 NEAR) |

**The moves between NEAR and Base Sepolia.** No bridge joins the two testnets, and 1Click has no testnet. So our stand-in, which already plays 1Click, plays these two routes as well (stage 4):
- it takes test nBTC on NEAR and hands out test WBTC on Base Sepolia, or wrapped test ETH of the same dollar value while Aave's test WBTC pool is full (your go-ahead of 11 Nov);
- it takes test USDC on Base Sepolia and hands out test USDC on NEAR;
- and the two ways back, so a client can repay Aave from NEAR and bring the bitcoin home (INTERFACES.md 36).

Its float on Base Sepolia is the gas wallet, which holds about 0.048 test ETH. One move brings at most 0.02 wrapped test ETH (about $40), and the test ETH goes round: it is wrapped for a delivery and unwrapped when it comes back.

If stage 4 is cut, the demo's WBTC comes straight from Aave's faucet, and the borrowed USDC stays on Base Sepolia, where it counts as the account's cash and can repay Aave.

## 10. Tests and gates

| Part | Tests |
|---|---|
| Account | Unit tests for every new method and refusal. The Ethereum encoder against transactions built independently in Node, with signatures recovered to the right address |
| Account and Rhea | Sandbox tests against Rhea's real contract file: supply, borrow, repay, withdraw, and a borrow that fails inside Rhea |
| Pool | Unit tests for each policy, both signs of the adjustment, each limit, and the migration from the saved live state |
| Engine | Reader tests from recorded answers. The split and the cushion rule. The existing reference cases must still pass, unchanged |
| Services and web | Tests beside each new handler and helper, as today |
| Everything | The full suites: contracts 376, risk 199, JavaScript 296 today |
| Security | A pass with the `near-contract-audit` checklist over the new contract code, added to `research/audit.md` |

**Gates.** Each stage ends with a script that must pass on live testnet:

| Gate | Passes when |
|---|---|
| 1. The brain | For a sample book, a preview run returns the split and each lender's cushion. `backtest lender` prints its table. No contract has changed |
| 2. Rhea and pricing | A fresh account signs the permission and one `fund`. It ends with a Rhea loan and a pool loan. A settlement books a fee, and another books a subsidy. Dropping the Rhea copy's BTC price makes the keeper top Rhea up. The client then repays everything and withdraws |
| 3. Aave | The same account, or another, borrows on Aave's test market through Chain Signatures. The engine reads the position, and the app shows it. It repays and withdraws |
| 4. The moves | An account holding only test nBTC moves it to Base Sepolia through the stand-in, borrows on Aave against it, and the borrowed USDC arrives in the account on NEAR |

## 11. Schedule, stages and cut rules

All times are UTC. Four helpers work in parallel, as in Phase 5, and I hold the interfaces, the testnet setup and the integration.

| When | Stage | Work |
|---|---|---|
| **Tue 10 evening** | 0. Spikes | Load Rhea's contract file in the sandbox and get one borrow through. Check Aave's faucet and gas with a real mint. **Not done yet:** both wait for section 14's items |
| **Tue 10 evening, done** | 1. The brain | Engine: readers, the book, the cushion rule, the split, the new fields. Pool: pricing maths as plain functions. Account: the permission and the funding plan. Backend and app: lender terms and the funding-plan view. **Gate 1 passed on Tue 10 at 22:50** (INTERFACES.md 30) |
| **Wed 11, done** | 2. Rhea and pricing | The Rhea calls. Pool pricing and its migration. New engine and gateway versions published and pinned. The permission step and the one-loan view. In parallel, the account's Ethereum encoder. **Gate 2 passed on Wed 11 at 15:55** (INTERFACES.md 31 and 32) |
| **Wed 11, done** | 3. Aave | The Aave steps, the relay, the gas helper, the Aave reader live. **Gate 3 passed on Wed 11 at 21:17**, two days early (INTERFACES.md 34 and 35). Aave's test WBTC pool was full, so the collateral was wrapped test ETH |
| **Thu 12, done** | 4. The moves | Four routes in the stand-in between NEAR and Base Sepolia, and the account's two calls that start a move (INTERFACES.md 36). The client starts each move, as section 6.4 says for testnet; the funding plan's own move steps are the mainnet path and aren't built. The code part was finished on Wed 11 at about 22:50 (INTERFACES.md 37); the deploy steps are `research/stage4_deploy.md`. **Gate 4 passed on Thu 12 at 08:42**, a day early, on its first run (INTERFACES.md 38): test nBTC moved to Base Sepolia, an Aave loan against it, the loan home on NEAR, then everything repaid and brought home. Aave's test WBTC pool was still full, so the bitcoin arrived as wrapped test ETH |
| **Thu 12, done** | The security pass | The `near-contract-audit` checklist over the Phase 6 code (`research/audit.md`, second pass): two High, three Medium, ten Low. On your "Fix both now", the two High (A7, A8), A9 and five small ones were fixed the same day (INTERFACES.md 40), deployed at 12:38, and **gate 4 passed again on the fixed code at 12:46** (INTERFACES.md 41). The Rhea gate's hedge was first refused, because Hyperliquid testnet's price stood 2% from its oracle; on your word the gateway's price band became 3% on testnet only (INTERFACES.md 42, live 14:35), a timing gap in the keeper's top-up watch was fixed (44), and **gate 2 passed in full on the final code at 19:38** (44.3) |
| **Thu 12 night, done** | The pool's three audit fixes | On your "Pool too": a limit on a settlement's fee (P3), a fee that covers all the time since the last settlement (P5), and a borrow that tells the pool the debt before and after (the rest of P4). Rules in INTERFACES.md 45. **The pool was migrated on testnet at 21:40 and the factory redeployed at 21:42** (46); every pool view of all 13 accounts read the same afterwards but for the three new limits. **Gate 4 passed on the new code at 22:36** (46.1). **Gate 2 passed in full on the new code at 23:12** (46.2): its lending, fee, subsidy, top-up and repayment steps at 22:03, and its test hedge's close an hour later, once Hyperliquid testnet's price was back inside Hyperliquid's own limit |
| **Thu 12 night built; Fri 13 morning live, done** | The account's Low audit findings | On your word: A10, the rest of A12, A13, A15, A16 and A17's two items that needed a change are fixed in the account's code, with small changes in the keeper, the backend and the app (INTERFACES.md 47). A11 is not: its fix needs the engine too. The pool, the engine and the gateway don't change. **Live since Fri 13, 09:53 UTC** for accounts made from then on (the factory's redeploy and a step price on the pool, with your keychain). Gate 2 passed at 10:30 UTC and gate 4 at 10:55 UTC, each in one run on a new account (INTERFACES.md 47.11; `research/low_fixes_deploy.md`) |
| **Fri 13 midday, built and checked live; the user's click-through to come** | Privacy level 1, "hide who" | On your word: the app and its backend show a client account only to its owner and to us (one free signed message from the wallet), the Book page's per-client lines only to the operator, and new accounts get a random name. No contract change, nothing deployed. 716 JavaScript tests pass; real sign-ins with two test wallets behaved as the rules say. **Gate 2 passed on the final code through the guarded backend at 13:21 UTC** (three starts: OutLayer's testnet was slow in spells all afternoon). Two fixes came out of it: the backend counts a transfer Hyperliquid already took as posted, and the keeper asks again after a run of failed checks. 718 tests pass (INTERFACES.md 48, 48.9 to 48.11; `research/privacy_level1_plan.md`) |
| **Fri 13** | Freeze | **Freeze at 18:00.** Before it: the full test run, your click-through and the docs |
| **Sat 14** | Ship | The README, your video, the hosted demo if you say go, and the submission by 18:00 |

**Cut rules, agreed now so nobody argues later:**

1. If gate 2 isn't passed by Fri 02:00, Aave is cut to the funding-plan view with live numbers, and Friday finishes Rhea and pricing.
2. If Rhea's contract file can't be made to work in the sandbox within three hours, we write a stand-in with the same calls, and the README says so.
3. If the pool's migration fails against the saved live state, new accounts get a fresh pool.
4. If settlement isn't passing by the freeze, the app shows the client's rate as worked out, the pool charges nothing extra, and the README says so.
5. If gate 4 isn't passed by the freeze, the demo's WBTC comes from Aave's faucet, the borrowed USDC stays on Base Sepolia, and the README says the moves are designed but not shown.
6. The README claims only what passed its gate.

## 12. Risks

| Risk | What we do about it |
|---|---|
| Three days is tight for this much | Stages that each stand alone, the cut rules, and four helpers in parallel |
| A change breaks what works today | New code reaches new accounts only. The full suites run before the freeze |
| Rhea reports success when a borrow failed | The account books nothing itself. The engine's reading is the truth |
| A signed Ethereum transaction is sent late | It counts as done from the moment it is signed (4.5) |
| The public Base Sepolia RPC is slow or rate-limited | A failed lender read means no answer, never a guess. Two timeouts abort a run, so the read comes last |
| The checked maths treats all debt as our pool's | The two-call method of 6.2, which is conservative. The reference cases stay untouched |
| A lender sells before our top-up lands | The cushion levels, which the backtest sets. On testnet, top-ups use money already on that chain |
| A wrong report drains the pool through subsidies | The limits of 5.3 |
| The automatic unwind can't pull collateral out of a lender | Known limit for now. A deleverage plan repays our pool and trims the hedge, as today. The README will say so |
| Moving bitcoin to Aave's chain costs money and has a size limit | The engine moves it only when the saving beats the cost, and in parts of about $100,000. The bitcoin also changes wrapper, from nBTC to WBTC, which has its own cap |
| Our pool is second in line behind the lender | The engine counts the lender's loan as debt in every rule. A stricter rule for our pool's part is listed for later |

## 13. How a client could try to cheat us, and what stops it

The owner can call the account directly, at any moment they choose. The account's code is ours and fixed, so the owner can only do what it offers. These are the cases I looked for.

| # | The trick | What it would cost us | What stops it |
|---|---|---|---|
| 1 | **Borrow cheap through us and lend it straight back.** We subsidise a dear lender down to a low rate. The client withdraws the USDC and deposits it at that same lender, which pays more | The subsidy: about $4,770 a year on the example's Rhea part. The client pockets about $1,930 of it | A subsidy never takes the client's rate below the lender's deposit rate (5.2). Subsidy budgets per account and for the whole pool (5.3) |
| 2 | **Push a small lender's rate up** for a few hours while holding a loan we subsidise. Rhea is small enough for one large depositor to do it | The excess for as long as it lasts | The rate counted is capped at the 7-day average plus 5 points (5.3) |
| 3 | **Time the settlement.** Show a large lender debt when a subsidy is settled and a small one in between, or the reverse for a fee | Subsidies paid on debt that wasn't there, or fees avoided | A settlement at every lender borrow and repay, and the figure that favours the pool (5.2) |
| 4 | **Borrow twice in the gap.** A Rhea borrow takes a block or two to show, and an Aave borrow is signed before it is mined. A check made in that gap doesn't see the new debt | A loan above the credit line | A lender action counts as done from the moment it is sent or signed, and nothing else that adds risk runs until it shows (4.4, 4.5) |
| 5 | **Liquidate yourself at Aave.** Aave pays whoever liquidates a position 5% to 7.5% of the collateral taken. A client could cancel the permission to stop our top-ups, wait for a fall, and liquidate their own account from another wallet | Collateral leaves the account without a check: about $1,400 per liquidation on the example. It is the client's own equity first, and ours only if their equity runs out | Top-ups run whatever the permission says (6.5). With the cushion, bitcoin must fall by a third first |
| 6 | **Hold back a signed Ethereum transaction** and send it later, when conditions have changed | A borrow or a withdrawal we no longer allow | It counts as done from signing, and the keeper and the backend both send it at once (4.5) |
| 7 | **Make us pay for gas.** Each Aave step costs gas, which our wallet sends on testnet | Gas | A daily limit per account on testnet. On mainnet the account buys its own (4.5) |
| 8 | **Walk away when the book is worth less than the debt** | The shortfall | This is the ordinary credit risk. The engine's limits, margin calls and unwind exist for it, and the lender's loan counts as debt in all of them |

**What the owner can't do at all:**
- make the account call anything outside its fixed list;
- touch the lender position from their own wallet, since only the account can;
- borrow at a lender in an asset or on a chain the engine doesn't read;
- take collateral out, on NEAR or on Aave's chain, while the account owes our pool, without a check that allows it;
- withdraw from Hyperliquid through the trading agent.

**Two cases the plan doesn't close:**
- **A liquidation at a lender still moves value out** when our top-up arrives too late. It goes to whoever liquidates. The backtest of 6.8 measures how often that happens.
- **Subsidies stay the most dangerous setting.** The rules above bound the loss; they don't remove it. A margin on a cheap lender has no such problem.

## 14. What I need from you

1. **A go-ahead** for this scope and these dates.
2. ~~**A yes to download one file:**~~ **Done on 11 Nov.** `burrowland_release.wasm`, 1,015,136 bytes, from Rhea's repository at `github.com/ref-finance/burrowland`, in its `releases` folder, is now at `vendor/burrowland/burrowland_release.wasm`. It matches GitHub's own hash for the file, and it is version 0.15.7 (INTERFACES.md section 30 has the hashes). Rust 1.79 is no longer needed.
3. ~~**About 30 test NEAR**~~ **Done on 11 Nov:** `pbf-ops.testnet` holds 30.51 NEAR (three faucet accounts, `pbf-fund2` to `pbf-fund4`, sent 9.9 each). It was for: about 11 for the Rhea copy, about 3 for the larger factory and pool, and 5 for each fresh account (a new account's code grew, so it now needs 5 NEAR, not 4).
4. **A little Base Sepolia gas:** 0.05 test ETH from a faucet, which needs your sign-in at Coinbase's or Alchemy's, sent to the gas wallet `0x2031181d63507368232579AF4c64a1c3428407fF`. I made it on 10 Nov; its key is in `.env`, unseen, the way the Hyperliquid float's is. **Done on 11 Nov:** the wallet holds 0.05 test ETH on Base Sepolia. You sent 0.0531 on Sepolia, Ethereum's test network, and at your word I moved 0.05 of it across with Base's own bridge (`scripts/bridge-gas.mjs`; Sepolia transactions `0xc7efdb34…a2e8` and `0x93607007…6417`). About 0.003 is left on Sepolia.
5. **Your keychain approvals** for the testnet deploys, as before.
6. **A click-through on Friday,** and the video on Saturday.

## 15. Choices I made, for you to veto

| Choice | My default |
|---|---|
| Cushions | Stop borrowing at 1.5, top up at 1.35, act at once at 1.2. You chose these on 11 Nov, after the backtest; they were 1.3 and 1.15 |
| Sources per request | One lender plus our pool |
| Routing | Cheapest safe source first. Today that is Aave, then our pool, then Rhea |
| Pricing by default | `PassThrough`. The demo sets a 1.2-point margin on Aave and an 8% cap on Rhea, to show both directions |
| A change of rate | Takes effect at once, with a public event. A notice period for increases can come later |
| Aave's address | The same address as the account's Hyperliquid account |
| WBTC's risk settings | The same as nBTC's |
| The Rhea copy | Rhea's own published contract file, not a rewrite |
| The permission | Signed with account opening, on terms we set. The client can cancel it, not narrow it in the app |
| When to move bitcoin to Aave's chain | When the saving over 90 days beats the cost of the move |
| Old accounts | They keep today's code and never use a lender |

## 16. Left out on purpose

- **Moving a running loan between sources** by itself, including our pool taking over a lender's loan. The permission has the switch; the engine doesn't use it yet.
- **Unwinding through a lender:** paying the lender bit by bit to free collateral and sell it.
- **Engine-planned moves on testnet.** The engine can't reach our stand-in from the enclave, so on testnet the client starts each move from the app. On mainnet the engine plans them with 1Click.
- **Sending Aave's USDC straight to Hyperliquid.** It comes home to NEAR first.
- **Lenders on mainnet.** The tiny mainnet run of Phase 6 doesn't use them.
- **A stricter rule for our pool as the junior lender,** and the lender's liquidation inside the engine's stress test.
- **A notice period for rate rises.**
- **The custody tier, pooled accounts and the privacy levels** (PLAN.md section 14).
