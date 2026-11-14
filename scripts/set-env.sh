#!/usr/bin/env bash
# Saves one value into .env without showing it on screen.
#
#   bash scripts/set-env.sh NAME              then paste the value and press Enter
#   some-command | bash scripts/set-env.sh NAME   saves the command's output instead
#
# NAME must be one of the variables in .env.example. Nothing is shown or printed.
# For a NEAR private key, the ed25519:... part is picked out of whatever comes in, so the
# output of `near account export-account ... using-private-key ...` can be piped straight in.
# .env is gitignored and stays readable by you only (chmod 600). Running it again replaces the value.
set -euo pipefail

cd "$(dirname "$0")/.."

name="${1:-}"
case "$name" in
  "" | *[!A-Z0-9_]*)
    echo "Usage: bash scripts/set-env.sh NAME   (for example: bash scripts/set-env.sh ONECLICK_JWT)" >&2
    exit 1
    ;;
esac
if ! grep -q "^${name}=" .env.example; then
  echo "$name is not in .env.example. Check the spelling." >&2
  exit 1
fi

umask 077
[ -f .env ] || cp .env.example .env
chmod 600 .env

if [ -t 0 ]; then
  printf 'Paste the value for %s and press Enter (it will not show): ' "$name" >&2
  IFS= read -r -s value || true
  echo >&2
else
  value="$(cat)"
fi

is_near_key=0
case "$name" in
  HL_FLOAT_PRIVATE_KEY | EVM_GAS_PRIVATE_KEY) ;;
  *_PRIVATE_KEY) is_near_key=1 ;;
esac

# Pick the key out of a longer line ("Here is the private key for account <...>: ed25519:...").
near_re='(ed25519:[1-9A-HJ-NP-Za-km-z]+)'
if [ "$is_near_key" = 1 ] && [[ $value =~ $near_re ]]; then
  value="${BASH_REMATCH[1]}"
fi

# Drop pasted carriage returns and any spaces around the value.
value="${value//$'\r'/}"
value="${value#"${value%%[![:space:]]*}"}"
value="${value%"${value##*[![:space:]]}"}"

if [ -z "$value" ]; then
  echo "Nothing came in, so .env is unchanged." >&2
  exit 1
fi
case "$value" in
  *[[:space:]]*)
    echo "The value has a space or line break inside it, and none of these keys do. .env is unchanged." >&2
    exit 1
    ;;
esac

# A light check of the shape, to catch a paste of the wrong thing.
hint=""
case "$name" in
  HL_FLOAT_PRIVATE_KEY | EVM_GAS_PRIVATE_KEY)
    re='^0x[0-9a-fA-F]{64}$'
    [[ $value =~ $re ]] || hint="an Ethereum-style private key is 0x followed by 64 hex characters"
    ;;
  *_PRIVATE_KEY)
    re='^ed25519:[1-9A-HJ-NP-Za-km-z]+$'
    [[ $value =~ $re ]] || hint="a NEAR private key starts with ed25519:"
    ;;
  OUTLAYER_PAYMENT_KEY)
    re='^[^:]+:[0-9]+:[^:]+$'
    [[ $value =~ $re ]] || hint="an OutLayer payment key looks like account:number:secret"
    ;;
  ONECLICK_JWT)
    re='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    [[ $value =~ $re ]] || hint="a 1Click key is usually three parts joined by dots"
    ;;
esac
if [ -n "$hint" ]; then
  printf "That doesn't look right: %s.\nSave it anyway? [y/N] " "$hint" >&2
  answer=""
  if [ -t 0 ]; then
    read -r answer || true
  else
    { read -r answer </dev/tty; } 2>/dev/null || true
  fi
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo ".env is unchanged." >&2
      exit 1
      ;;
  esac
fi

# Rewrite .env with the new line in place of the old one.
tmp="$(mktemp .env.tmp.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
found=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "$name="*)
      printf '%s=%s\n' "$name" "$value" >>"$tmp"
      found=1
      ;;
    *) printf '%s\n' "$line" >>"$tmp" ;;
  esac
done <.env
[ "$found" = 1 ] || printf '%s=%s\n' "$name" "$value" >>"$tmp"
chmod 600 "$tmp"
mv "$tmp" .env

echo "Saved $name in .env (${#value} characters). It was not shown." >&2
