#!/usr/bin/env bash
# Sets up the 1Click shim's NEAR testnet float (PLAN.md 5.4, Phase 1). Testnet only.
#
#   bash scripts/shim-setup.sh
#
# 1. Creates shim.pbf-ops.testnet with 1 NEAR from pbf-ops.testnet; its key goes to the Mac's keychain.
# 2. Saves SHIM_NEAR_ACCOUNT_ID and SHIM_NEAR_PRIVATE_KEY in .env (the key is never shown), and a fresh
#    random SHIM_ADMIN_TOKEN. Only right after creating the account, so a second run changes nothing.
# 3. Registers the float on mUSDC and mNBTC and mints test tokens into it with the tokens' public faucet,
#    so it can deliver and refund. Skipped, with a note, while the token contracts don't exist yet.
#
# Every step that is already done is skipped. It needs the near CLI (~/.cargo/bin) and the keychain keys.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

PARENT=pbf-ops.testnet
FLOAT=shim.pbf-ops.testnet
MUSDC=musdc.pbf-ops.testnet
MNBTC=mnbtc.pbf-ops.testnet
RPC=https://test.rpc.fastnear.com
# What the float holds after a top-up: 1,000,000 mUSDC (6 decimals) and 10 mNBTC (8 decimals).
MUSDC_TARGET=1000000000000
MNBTC_TARGET=1000000000

# rpc REQUEST_TYPE ACCOUNT [METHOD ARGS_JSON]: prints the view's JSON result, or "null" if there is none.
rpc() {
  local params
  if [ "$1" = view_account ]; then
    params="{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$2\"}"
  else
    params="{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$2\",\"method_name\":\"$3\",\"args_base64\":\"$(printf '%s' "$4" | base64)\"}"
  fi
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$params}" |
    python3 -c 'import json, sys
r = json.load(sys.stdin).get("result")
if r is None: print("null")
elif "result" in r: print(bytes(r["result"]).decode() or "null")
else: print(json.dumps(r))'
}

exists() { [ "$(rpc view_account "$1")" != null ]; }

call() { # call CONTRACT METHOD ARGS_JSON DEPOSIT_NEAR
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas '30 Tgas' \
    attached-deposit "$4 NEAR" sign-as "$FLOAT" network-config testnet sign-with-keychain send </dev/null
}

# ---------- 1-2. The float account and its .env values ----------
if exists "$FLOAT"; then
  echo "$FLOAT exists already: leaving it and .env as they are."
else
  echo "Creating $FLOAT with 1 NEAR from $PARENT..."
  near account create-account fund-myself "$FLOAT" '1 NEAR' \
    autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain \
    sign-as "$PARENT" network-config testnet sign-with-keychain send </dev/null
  printf '%s\n' "$FLOAT" | bash scripts/set-env.sh SHIM_NEAR_ACCOUNT_ID
  near account export-account "$FLOAT" using-private-key network-config testnet </dev/null 2>/dev/null |
    bash scripts/set-env.sh SHIM_NEAR_PRIVATE_KEY
  openssl rand -hex 32 | bash scripts/set-env.sh SHIM_ADMIN_TOKEN
fi

# ---------- 3. Fill the float with test tokens ----------
for pair in "$MUSDC:$MUSDC_TARGET" "$MNBTC:$MNBTC_TARGET"; do
  token=${pair%%:*}
  target=${pair##*:}
  if ! exists "$token"; then
    echo "$token doesn't exist yet (W1 deploys it): skipping its storage and mint."
    continue
  fi
  if [ "$(rpc call "$token" storage_balance_of "{\"account_id\":\"$FLOAT\"}")" = null ]; then
    min=$(rpc call "$token" storage_balance_bounds '{}' | python3 -c 'import json, sys; print(int(json.load(sys.stdin)["min"]) / 1e24)')
    echo "Registering $FLOAT on $token ($min NEAR of storage)..."
    call "$token" storage_deposit "{\"account_id\":\"$FLOAT\",\"registration_only\":true}" "$min"
  fi
  balance=$(rpc call "$token" ft_balance_of "{\"account_id\":\"$FLOAT\"}" | tr -d '"')
  if python3 -c "import sys; sys.exit(0 if int('$balance') < int('$target') else 1)"; then
    need=$(python3 -c "print(int('$target') - int('$balance'))")
    echo "Minting $need units of $token into $FLOAT..."
    call "$token" mint "{\"account_id\":\"$FLOAT\",\"amount\":\"$need\"}" 0
  fi
  echo "$token: $FLOAT holds $(rpc call "$token" ft_balance_of "{\"account_id\":\"$FLOAT\"}") units."
done
