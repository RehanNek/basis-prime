#!/usr/bin/env bash
# DRAFT, written on 11 Nov from the sandbox run and never run on testnet. Read it through before the first run.
#
# Sets up our copy of Rhea on NEAR testnet (FUNDING.md 9; research/rhea.md, "Our copy in the sandbox"). Testnet only.
#
#   bash scripts/rhea-setup.sh                        shows what is done and what is left; changes nothing
#   BTC_USD=103000 bash scripts/rhea-setup.sh --go    does what is left, one step at a time
#
# 1. Creates rhea.pbf-ops.testnet with 11 NEAR from pbf-ops.testnet; its key goes to the Mac's keychain. Rhea's file
#    is 1,015,136 bytes, so the account locks 10.18 NEAR for as long as it holds the code. The rest pays the deploy.
# 2. Deploys vendor/burrowland/burrowland_release.wasm there with `new`, signed by the new account, then checks that
#    the chain shows code hash DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g and version 0.15.7. It stops if the
#    account holds any other code.
# 3. Registers the copy on mUSDC and mNBTC, so it can hold them.
# 4. Lists mUSDC and mNBTC with mainnet's ratios and rate curves, and gives each a fixed price: $1, and BTC_USD
#    dollars for 1 nBTC. BTC_USD is needed only while nBTC has no price yet. After that the keeper keeps it up to
#    date. Three of mainnet's caps are lifted, since anyone can mint our test tokens and fill them, and nBTC can't
#    be borrowed, so that nobody can borrow the clients' collateral away.
# 5. Registers pbf-ops.testnet with the copy (0.1 NEAR), mints it test USDC and supplies LEND_USDC of it to lend out
#    (1,000,000 unless LEND_USDC says otherwise).
# 6. Makes the copy charge what mainnet charges. A loan's rate follows how much of the USDC is lent out, so with
#    nothing lent it would be about 0%. pbf-ops.testnet turns its deposit into collateral, which stays lendable, and
#    borrows 85.15% of it (851,500 of 1,000,000): the share mainnet had lent out on 10 Nov. Borrowing then costs
#    15.91% a year, a deposit earns 10.16%, and 148,500 mUSDC are left for clients.
#
# pbf-ops.testnet stays the copy's owner: the keeper changes BTC's price with the operator's key.
#
# All of it costs pbf-ops.testnet about 11.15 NEAR. Every step that is already done is skipped, so the script can be
# run again. It stops at the first error, and after each step it reads the chain to check that the step took.
# It needs the near CLI (~/.cargo/bin) and the keychain key of pbf-ops.testnet. It reads no .env.
#
# The JSON below is what contracts/tests/tests/rhea.rs sends in the sandbox; a test there compares the two.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

PARENT=pbf-ops.testnet
COPY=rhea.pbf-ops.testnet
MUSDC=musdc.pbf-ops.testnet
MNBTC=mnbtc.pbf-ops.testnet
RPC=https://test.rpc.fastnear.com
WASM=vendor/burrowland/burrowland_release.wasm
WASM_SHA256=bdd286fece512c3def8119f58063e9d42571069cfa221ee32ec488d0fe395055
CODE_HASH=DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g
NO_CODE=11111111111111111111111111111111
FUND_NEAR=11
LEND_USDC=${LEND_USDC:-1000000}
LENT_OUT_BP=8515
BTC_USD=${BTC_USD:-}

GO=0
case "${1:-}" in
  "") ;;
  --go) GO=1 ;;
  *) echo "Usage: [BTC_USD=<dollars>] bash scripts/rhea-setup.sh [--go]" >&2; exit 1 ;;
esac

# ---------- What is sent. Rhea's own shapes: github.com/ref-finance/burrowland at a479b83, contracts/contract/src ----------

# `new`: mainnet's config values (contract.main.burrow.near.get_config, 11 Nov) where they mean something here. The
# five accounts it names besides the owner don't exist, and only the copy's own key could create them.
new_args() {
  cat <<JSON
{"config": {
  "oracle_account_id": "no-price-oracle.${COPY}",
  "pyth_oracle_account_id": "no-pyth-oracle.${COPY}",
  "ref_exchange_id": "no-ref-exchange.${COPY}",
  "owner_id": "${PARENT}",
  "booster_token_id": "no-booster.${COPY}",
  "booster_decimals": 18,
  "max_num_assets": 20,
  "maximum_recency_duration_sec": 90,
  "maximum_staleness_duration_sec": 90,
  "lp_tokens_info_valid_duration_sec": 600,
  "pyth_price_valid_duration_sec": 60,
  "minimum_staking_duration_sec": 2592000,
  "maximum_staking_duration_sec": 7776000,
  "x_booster_multiplier_at_maximum_staking_duration": 30000,
  "force_closing_enabled": true,
  "enable_price_oracle": false,
  "enable_pyth_oracle": true,
  "boost_suppress_factor": 1000,
  "dcl_id": "no-dcl.${COPY}"
}}
JSON
}

# USDC on mainnet (get_assets, 11 Nov): ratio 9500, 6% a year at 80% lent out, 50% at 100%. Not mainnet's: no fee
# beneficiary, and no caps (mainnet has 60M supplied and 25M borrowed). The figure is the largest Rhea can hold.
usdc_asset_config() {
  cat <<JSON
{
  "reserve_ratio": 2500,
  "beneficiaries": {},
  "target_utilization": 8000,
  "target_utilization_rate": "1000000000001847694955734069",
  "max_utilization_rate": "1000000000012857214234867166",
  "holding_position_fee_rate": "1000000000000000000000000000",
  "volatility_ratio": 9500,
  "extra_decimals": 12,
  "can_deposit": true,
  "can_withdraw": true,
  "can_use_as_collateral": true,
  "can_borrow": true,
  "net_tvl_multiplier": 10000,
  "max_change_rate": null,
  "supplied_limit": "340282366920938463463374607431768211455",
  "borrowed_limit": "340282366920938463463374607431768211455",
  "min_borrowed_amount": "1000000000"
}
JSON
}

# nBTC on mainnet: ratio 8000. Not mainnet's: no fee beneficiary; no cap on what is supplied, which is the cap on
# collateral (mainnet has 20 nBTC); and nBTC can't be borrowed. No client of ours borrows it, and otherwise a stranger
# with faucet USDC could borrow the clients' collateral away and block their withdrawals.
nbtc_asset_config() {
  cat <<JSON
{
  "reserve_ratio": 2500,
  "beneficiaries": {},
  "target_utilization": 8000,
  "target_utilization_rate": "1000000000001547125956667610",
  "max_utilization_rate": "1000000000039724853136740579",
  "holding_position_fee_rate": "1000000000000000000000000000",
  "volatility_ratio": 8000,
  "extra_decimals": 10,
  "can_deposit": true,
  "can_withdraw": true,
  "can_use_as_collateral": true,
  "can_borrow": false,
  "net_tvl_multiplier": 0,
  "max_change_rate": null,
  "supplied_limit": "340282366920938463463374607431768211455",
  "borrowed_limit": "4000000000000000000",
  "min_borrowed_amount": "1000000000"
}
JSON
}

# USDC's price, fixed at $1.0000.
usdc_price_info() {
  cat <<JSON
{
  "decimals": 6,
  "fraction_digits": 4,
  "price_identifier": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "extra_call": null,
  "default_price": {"multiplier": "10000", "decimals": 10}
}
JSON
}

# nBTC's price, fixed at BTC_CENTS hundredths of a dollar for one whole nBTC.
nbtc_price_info() {
  cat <<JSON
{
  "decimals": 8,
  "fraction_digits": 2,
  "price_identifier": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "extra_call": null,
  "default_price": {"multiplier": "${BTC_CENTS}", "decimals": 10}
}
JSON
}

# ---------- Reading the chain ----------

die() { echo "STOPPED: $*" >&2; exit 1; }

# rpc REQUEST_TYPE ACCOUNT [METHOD ARGS_JSON]: prints the view's JSON result, or "null" if there is none: no such
# account, no code on it, or a view that fails.
rpc() {
  local params
  if [ "$1" = view_account ]; then
    params="{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$2\"}"
  else
    params="{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$2\",\"method_name\":\"$3\",\"args_base64\":\"$(printf '%s' "$4" | base64 | tr -d '\n')\"}"
  fi
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$params}" |
    python3 -I -c 'import json, sys
r = json.load(sys.stdin).get("result")
if r is None or "error" in r: print("null")
elif "result" in r: print(bytes(r["result"]).decode() or "null")
else: print(json.dumps(r))'
}

# ask REQUEST_TYPE ACCOUNT [METHOD ARGS_JSON]: as rpc, into $answer. It stops the script if testnet can't be read, so
# that a failed read is never taken for "done already".
ask() {
  answer=$(rpc "$@") || die "couldn't read $2 on testnet ($RPC)"
  [ -n "$answer" ] || die "testnet gave no answer about $2"
}

# field JSON_PATH...: prints one field of the JSON on stdin, or "none".
field() {
  python3 -I -c 'import json, sys
v = json.load(sys.stdin)
for key in sys.argv[1:]:
    v = v.get(key) if isinstance(v, dict) else None
print("none" if v is None else v)' "$@"
}

exists() { ask view_account "$1"; [ "$answer" != null ]; }
code_hash() { rpc view_account "$1" | field code_hash; }
has_rheas_code() { [ "$(code_hash "$COPY")" = "$CODE_HASH" ]; }
near_held() { rpc view_account "$1" | python3 -I -c 'import json, sys; print(int(json.load(sys.stdin)["amount"]) // 10**24)'; }
copy_view() { rpc call "$COPY" "$1" "$2"; }
# registered CONTRACT ACCOUNT: whether ACCOUNT has storage on a token, or on the copy.
registered() { ask call "$1" storage_balance_of "{\"account_id\":\"$2\"}"; [ "$answer" != null ]; }
listed() { ask call "$COPY" get_asset "{\"token_id\":\"$1\"}"; [ "$answer" != null ]; }
priced() { ask call "$COPY" get_token_pyth_info "{\"token_id\":\"$1\"}"; [ "$answer" != null ]; }
owner() { copy_view get_config '{}' | field owner_id; }
# held_at_copy LIST: what PARENT has at the copy in mUSDC in one of get_account's lists (supplied, collateral or
# borrowed), in mUSDC's own units, rounded down. The copy counts 10^12 inner units for each.
held_at_copy() {
  copy_view get_account "{\"account_id\":\"$PARENT\"}" | python3 -I -c 'import json, sys
a = json.load(sys.stdin) or {}
print(sum(int(r["balance"]) for r in a.get(sys.argv[1], []) if r["token_id"] == sys.argv[2]) // 10**12)' "$1" "$MUSDC"
}
# Whether PARENT's mUSDC at the copy is all collateral: none of it is a plain deposit any more.
is_collateral() { [ "$(held_at_copy supplied)" -eq 0 ] && [ "$(held_at_copy collateral)" -ge 1 ]; }
owes_enough() { [ "$(held_at_copy borrowed)" -ge "$OWN_LOAN_UNITS" ]; }
owned_by() { [ "$(owner)" = "$1" ]; }
token_balance() { rpc call "$1" ft_balance_of "{\"account_id\":\"$2\"}" | tr -d '"'; }
# What PARENT has at the copy in mUSDC, lendable either way: its deposit plus any it posted as collateral. In mUSDC's
# own units (the copy counts 10^12 inner units for each).
lent() {
  copy_view get_account "{\"account_id\":\"$PARENT\"}" | python3 -I -c 'import json, sys
a = json.load(sys.stdin) or {}
rows = a.get("supplied", []) + a.get("collateral", [])
print(sum(int(r["balance"]) for r in rows if r["token_id"] == sys.argv[1]) // 10**12)' "$MUSDC"
}
has_lent() { [ "$(lent)" -ge "$LEND_UNITS" ]; }
holds() { [ "$(token_balance "$1" "$2")" -ge "$3" ]; }

# ---------- Doing one step ----------

n=0
left=0
skip() { n=$((n + 1)); echo "[$n] done already: $1"; }
# todo WHAT: says what the step is about to do. Succeeds only with --go, so the step's commands run only then.
todo() {
  n=$((n + 1))
  if [ "$GO" = 1 ]; then echo "[$n] now: $1"; return 0; fi
  left=$((left + 1)); echo "[$n] to do: $1"; return 1
}
# confirm WHAT CHECK...: waits up to a minute for the chain to show the step, and stops if it never does. The near
# CLI can end without an error when a call failed inside, so this reading is what counts.
confirm() {
  local what=$1; shift
  for _ in $(seq 1 30); do
    if "$@"; then return 0; fi
    sleep 2
  done
  die "$what"
}
# send SIGNER CONTRACT METHOD ARGS_JSON DEPOSIT GAS
send() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "$6" \
    attached-deposit "$5" sign-as "$1" network-config testnet sign-with-keychain send </dev/null
}

# ---------- Before anything: the tools, the file, the accounts it builds on ----------
command -v near >/dev/null || die "the near CLI isn't on the PATH (expected in ~/.cargo/bin)"
[ -f "$WASM" ] || die "$WASM is missing"
[ "$(shasum -a 256 "$WASM" | cut -d' ' -f1)" = "$WASM_SHA256" ] || die "$WASM isn't Rhea's 0.15.7 release file (sha256 differs)"
for account in "$PARENT" "$MUSDC" "$MNBTC"; do
  exists "$account" || die "$account doesn't exist on testnet"
done
case "$LEND_USDC" in "" | *[!0-9]*) die "LEND_USDC must be whole mUSDC, for example 1000000" ;; esac
case "$BTC_USD" in *[!0-9]*) die "BTC_USD must be whole dollars, for example 103000" ;; esac
LEND_UNITS=$((LEND_USDC * 1000000))
OWN_LOAN_UNITS=$((LEND_UNITS * LENT_OUT_BP / 10000))
BTC_CENTS=$([ -n "$BTC_USD" ] && echo $((BTC_USD * 100)) || echo "<BTC_USD x 100>")
[ "$GO" = 1 ] && echo "Setting up $COPY on testnet." || echo "Showing what is left to do for $COPY on testnet. Nothing is sent without --go."

# ---------- 1. The account ----------
if exists "$COPY"; then
  skip "$COPY exists"
else
  [ "$(near_held "$PARENT")" -ge $((FUND_NEAR + 1)) ] || die "$PARENT holds $(near_held "$PARENT") NEAR; creating $COPY takes $FUND_NEAR, and the later steps a little more"
  if todo "create $COPY with $FUND_NEAR NEAR from $PARENT, its key saved in the keychain"; then
    near account create-account fund-myself "$COPY" "$FUND_NEAR NEAR" \
      autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
      sign-as "$PARENT" network-config testnet sign-with-keychain send </dev/null
    confirm "$COPY wasn't created" exists "$COPY"
  fi
fi

# ---------- 2. Rhea's file ----------
hash=$(code_hash "$COPY")
if [ "$hash" = "$CODE_HASH" ]; then
  skip "$COPY holds Rhea's file (code hash $CODE_HASH)"
elif [ "$hash" != none ] && [ "$hash" != "$NO_CODE" ]; then
  die "$COPY holds other code (code hash $hash). This script won't replace it."
elif todo "deploy $WASM to $COPY and call new, with $PARENT as the first owner"; then
  near contract deploy "$COPY" use-file "$WASM" with-init-call new json-args "$(new_args)" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send </dev/null
  confirm "$COPY doesn't show code hash $CODE_HASH after the deploy" has_rheas_code
fi
if has_rheas_code; then
  [ "$(copy_view get_version '{}')" = '"0.15.7"' ] || die "$COPY doesn't answer get_version with 0.15.7: it holds the file but new didn't run"
fi

# ---------- 3. The copy's storage on both tokens ----------
for token in "$MUSDC" "$MNBTC"; do
  if registered "$token" "$COPY"; then
    skip "$COPY is registered on $token"
  elif todo "register $COPY on $token, paid by $PARENT"; then
    min=$(rpc call "$token" storage_balance_bounds '{}' | python3 -I -c 'import json, sys; print(int(json.load(sys.stdin)["min"]) / 1e24)')
    send "$PARENT" "$token" storage_deposit "{\"account_id\":\"$COPY\",\"registration_only\":true}" "$min NEAR" '30 Tgas'
    confirm "$COPY isn't registered on $token" registered "$token" "$COPY"
  fi
done

# ---------- 4. Listing and prices. Each call is the owner's, with 1 yoctoNEAR ----------
for token in "$MUSDC" "$MNBTC"; do
  if [ "$token" = "$MUSDC" ]; then name=mUSDC; else name=mNBTC; fi
  if listed "$token"; then
    skip "$name is listed"
  elif todo "list $name with mainnet's settings (add_asset)"; then
    owned_by "$PARENT" || die "$COPY's owner is $(owner), not $PARENT, so $PARENT can't list $name"
    if [ "$token" = "$MUSDC" ]; then config=$(usdc_asset_config); else config=$(nbtc_asset_config); fi
    send "$PARENT" "$COPY" add_asset "{\"token_id\":\"$token\",\"asset_config\":$config}" '1 yoctoNEAR' '30 Tgas'
    confirm "$name isn't listed" listed "$token"
  fi
  if [ "$token" = "$MUSDC" ]; then price="\$1"; else price="\$${BTC_USD:-<BTC_USD>}"; fi
  if priced "$token"; then
    skip "$name has a fixed price"
  elif todo "give $name its fixed price of $price (add_token_pyth_info)"; then
    owned_by "$PARENT" || die "$COPY's owner is $(owner), not $PARENT, so $PARENT can't price $name"
    if [ "$token" = "$MUSDC" ]; then
      info=$(usdc_price_info)
    else
      [ -n "$BTC_USD" ] && [ "$BTC_USD" -gt 0 ] || die "nBTC has no price yet: run again with BTC_USD=<today's price in whole dollars>"
      info=$(nbtc_price_info)
    fi
    send "$PARENT" "$COPY" add_token_pyth_info "{\"token_id\":\"$token\",\"token_pyth_info\":$info}" '1 yoctoNEAR' '30 Tgas'
    confirm "$name has no price" priced "$token"
  fi
done

# ---------- 5. USDC to lend ----------
if registered "$COPY" "$PARENT"; then
  skip "$PARENT is registered with $COPY"
elif todo "register $PARENT with $COPY (0.1 NEAR)"; then
  send "$PARENT" "$COPY" storage_deposit "{\"account_id\":\"$PARENT\",\"registration_only\":true}" '0.1 NEAR' '30 Tgas'
  confirm "$PARENT isn't registered with $COPY" registered "$COPY" "$PARENT"
fi
have=$(lent)
if [ "$have" -ge "$LEND_UNITS" ]; then
  skip "$PARENT has supplied $((have / 1000000)) mUSDC to $COPY"
elif todo "supply $(((LEND_UNITS - have) / 1000000)) mUSDC from $PARENT to $COPY, minting what $PARENT is short of"; then
  need=$((LEND_UNITS - have))
  if ! registered "$MUSDC" "$PARENT"; then
    min=$(rpc call "$MUSDC" storage_balance_bounds '{}' | python3 -I -c 'import json, sys; print(int(json.load(sys.stdin)["min"]) / 1e24)')
    send "$PARENT" "$MUSDC" storage_deposit "{\"account_id\":\"$PARENT\",\"registration_only\":true}" "$min NEAR" '30 Tgas'
    confirm "$PARENT isn't registered on $MUSDC" registered "$MUSDC" "$PARENT"
  fi
  held=$(token_balance "$MUSDC" "$PARENT")
  if [ "$held" -lt "$need" ]; then
    send "$PARENT" "$MUSDC" mint "{\"account_id\":\"$PARENT\",\"amount\":\"$((need - held))\"}" '0 NEAR' '30 Tgas'
    confirm "$PARENT holds less than $need units of mUSDC after the mint" holds "$MUSDC" "$PARENT" "$need"
  fi
  send "$PARENT" "$MUSDC" ft_transfer_call "{\"receiver_id\":\"$COPY\",\"amount\":\"$need\",\"msg\":\"\"}" '1 yoctoNEAR' '100 Tgas'
  confirm "$COPY doesn't show $LEND_USDC mUSDC supplied by $PARENT" has_lent
fi

# ---------- 6. Mainnet's rate: the operator borrows most of its own deposit back ----------
owed=$(held_at_copy borrowed)
if [ "$owed" -ge "$OWN_LOAN_UNITS" ]; then
  skip "$PARENT has borrowed $((owed / 1000000)) mUSDC of its own, so $COPY charges mainnet's rate"
else
  if is_collateral; then
    skip "$PARENT's mUSDC at $COPY is collateral"
  elif todo "turn $PARENT's mUSDC deposit at $COPY into collateral, which stays lendable (execute, IncreaseCollateral)"; then
    send "$PARENT" "$COPY" execute "{\"actions\":[{\"IncreaseCollateral\":{\"token_id\":\"$MUSDC\"}}]}" '1 yoctoNEAR' '100 Tgas'
    confirm "$PARENT's mUSDC at $COPY isn't collateral" is_collateral
  fi
  need=$((OWN_LOAN_UNITS - owed))
  if todo "borrow $((need / 1000000)) mUSDC from $COPY as $PARENT, so that $((LENT_OUT_BP / 100)).$((LENT_OUT_BP % 100))% is lent out as on mainnet"; then
    # Inner units are the token's units times 10^12: too big for the shell's arithmetic, so the zeros are appended.
    inner="${need}000000000000"
    send "$PARENT" "$COPY" execute_with_pyth "{\"actions\":[{\"Borrow\":{\"token_id\":\"$MUSDC\",\"amount\":\"$inner\"}},{\"Withdraw\":{\"token_id\":\"$MUSDC\",\"max_amount\":\"$inner\"}}]}" '1 yoctoNEAR' '150 Tgas'
    confirm "$COPY doesn't show $PARENT's own loan" owes_enough
  fi
fi

# ---------- What stands ----------
if [ "$GO" = 0 ] && [ "$left" -gt 0 ]; then
  echo "$left steps left. Run again with --go to do them."
  exit 0
fi
echo "$COPY: code hash $(code_hash "$COPY"), owner $(owner), $(near_held "$COPY") NEAR."
echo "It holds $(($(token_balance "$MUSDC" "$COPY") / 1000000)) mUSDC, and 1 nBTC is priced at $(copy_view get_token_pyth_info "{\"token_id\":\"$MNBTC\"}" | field default_price multiplier) cents."
echo "Borrowing mUSDC costs $(copy_view get_asset "{\"token_id\":\"$MUSDC\"}" | field borrow_apr) a year now (0.159 is 15.9%)."
echo "To switch it on for the backend: printf '%s\n' $COPY | bash scripts/set-env.sh RHEA_ACCOUNT_ID"
