#!/usr/bin/env bash
# Builds every contract's wasm into contracts/target/near/<crate>/ with cargo-near 0.22.0 (PLAN.md 9).
#
# The order matters: the factory embeds the account's wasm with include_bytes!, so the account is built first.
# The sandbox tests (contracts/tests) load these files.
#
#   ./build.sh            build everything
#   ./build.sh --sizes    build, then list each wasm's size and sha256
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

crates=(
  account            # first: the factory carries it
  factory
  pool
  testnet/drill
  testnet/token
  testnet/outlayer-mock
  testnet/mpc-mock
  testnet/borrower
)

for crate in "${crates[@]}"; do
  echo "==> $crate"
  (cd "$crate" && cargo near build non-reproducible-wasm --locked)
done

if [[ "${1:-}" == "--sizes" ]]; then
  for wasm in target/near/*/*.wasm; do
    printf '%8d  %s  %s\n' "$(wc -c < "$wasm")" "$(shasum -a 256 "$wasm" | cut -c1-64)" "$wasm"
  done
fi
