"""Phase 0 check: do 1Click's dry quotes leave out its fee, and do its NEAR deposit addresses need storage? (day1.md 4-6)

Usage: python3 -I day1_oneclick_real.py <path to .env> <out.json>

For each route it asks three quotes back to back: dry with our key, real (dry: false) with our key, and real without a
key. A real quote only creates a deposit address that expires in minutes: nothing moves unless someone deposits, and
this script never deposits. For routes that start on NEAR, it then asks the token contract (mainnet RPC, read-only)
whether that deposit address already has storage, which decides if a plain ft_transfer to it would work.

The key is read from .env inside this process and sent only as X-API-Key to 1click.chaindefuser.com. It is never printed.
Stops at the first 403 or 429 rather than retrying.
"""
import base64
import datetime
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

ENV_PATH, OUT = sys.argv[1], sys.argv[2]
KEY = ""
for line in open(ENV_PATH, encoding="utf-8"):
    m = re.match(r"^ONECLICK_JWT=(\S+)", line)
    if m and not m.group(1).startswith("#"):
        KEY = m.group(1)
if not KEY:
    raise SystemExit("ONECLICK_JWT is not set in .env")

API = "https://1click.chaindefuser.com/v0"
RPC = "https://rpc.mainnet.fastnear.com"
UA = "pb-research/0.1"
HL_USDC = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054"   # 8 decimals
NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"   # 6 decimals
NBTC, ETHB, USDT = "nep141:nbtc.bridge.near", "nep141:eth.bridge.near", "nep141:usdt.tether-token.near"
NEAR_ACCT, HL_ADDR = "aurora", "0x" + secrets.token_hex(20)


def call(url, body=None, keyed=True):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if keyed:
        headers["X-API-Key"] = KEY
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode(errors="replace")
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw[:300]


def view(contract, method, args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "query",
            "params": {"request_type": "call_function", "finality": "final", "account_id": contract,
                       "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    req = urllib.request.Request(RPC, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode())
    res = d.get("result", {})
    if "result" not in res:
        return {"error": res.get("error") or d.get("error")}
    return json.loads(bytes(res["result"]).decode() or "null")


status, tokens = call(f"{API}/tokens", keyed=False)
if status != 200:
    raise SystemExit(f"/v0/tokens answered HTTP {status}")
tok = {t["assetId"]: t for t in tokens}


def units(asset, usd):
    return str(int(round(usd / float(tok[asset]["price"]) * 10 ** tok[asset]["decimals"])))


def body(origin, dest, usd, recipient, refund, dry):
    deadline = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)
    return {"dry": dry, "originAsset": origin, "destinationAsset": dest, "amount": units(origin, usd),
            "recipient": recipient, "refundTo": refund, "deadline": deadline.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "slippageTolerance": 100, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN",
            "recipientType": "DESTINATION_CHAIN", "refundType": "ORIGIN_CHAIN"}


ROUTES = [
    ("nBTC -> NEAR USDC", NBTC, NEAR_USDC, 10_000, NEAR_ACCT, NEAR_ACCT),
    ("nBTC -> NEAR USDC", NBTC, NEAR_USDC, 50_000, NEAR_ACCT, NEAR_ACCT),
    ("ETH (bridged) -> NEAR USDC", ETHB, NEAR_USDC, 10_000, NEAR_ACCT, NEAR_ACCT),
    ("USDT -> NEAR USDC", USDT, NEAR_USDC, 10_000, NEAR_ACCT, NEAR_ACCT),
    ("NEAR USDC -> Hyperliquid USDC", NEAR_USDC, HL_USDC, 1_000, HL_ADDR, NEAR_ACCT),
    ("Hyperliquid USDC -> NEAR USDC", HL_USDC, NEAR_USDC, 1_000, NEAR_ACCT, HL_ADDR),
]

out = {"generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "rows": []}
stop = False
for name, origin, dest, usd, rcpt, refund in ROUTES:
    row = {"route": name, "usd": usd}
    for label, dry, keyed in (("dry_keyed", True, True), ("real_keyed", False, True), ("real_keyless", False, False)):
        b = body(origin, dest, usd, rcpt, refund, dry)
        s, d = call(f"{API}/quote", b, keyed=keyed)
        q = d.get("quote") if isinstance(d, dict) else None
        row[label] = {"http": s, "amountIn": (q or {}).get("amountIn"), "amountOut": (q or {}).get("amountOut"),
                      "depositAddress": (q or {}).get("depositAddress"), "timeEstimate": (q or {}).get("timeEstimate"),
                      "error": None if q else (d if isinstance(d, (str, type(None))) else d.get("message", d))}
        if s in (403, 429):
            stop = True
            break
        time.sleep(1.5)
    base = row.get("dry_keyed", {}).get("amountOut")
    for label in ("real_keyed", "real_keyless"):
        o = row.get(label, {}).get("amountOut")
        row[f"{label}_vs_dry_bp"] = round((int(o) - int(base)) / int(base) * 1e4, 1) if o and base else None
    dep = row.get("real_keyed", {}).get("depositAddress")
    if dep and origin.startswith("nep141:"):
        contract = origin.split(":", 1)[1]
        row["deposit_storage"] = {"contract": contract,
                                  "storage_balance_of": view(contract, "storage_balance_of", {"account_id": dep}),
                                  "address_kind": "implicit (64 hex)" if re.fullmatch(r"[0-9a-f]{64}", dep) else "named"}
    out["rows"].append(row)
    st = row.get("deposit_storage", {}).get("storage_balance_of")
    print(f"{name:30} ${usd:>7,}: dry {row['dry_keyed']['http']} out {base} | real keyed "
          f"{row.get('real_keyed', {}).get('http')} {row.get('real_keyed_vs_dry_bp')} bp | real keyless "
          f"{row.get('real_keyless', {}).get('http')} {row.get('real_keyless_vs_dry_bp')} bp"
          + (f" | deposit address storage: {st}" if "deposit_storage" in row else ""), flush=True)
    if stop:
        print("stopping: the API refused us; not retrying")
        break
json.dump(out, open(OUT, "w"), indent=1)
