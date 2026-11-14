"""Phase 2's gate on testnet (PLAN.md 11.3): the first loan, end to end, from the command line.

Usage: python3 -I scripts/first-loan.py [--name demo1] [--owner pbf-keeper.testnet] [--borrow 5000] [--skip-stale]

1. Creates `<name>.pbf.testnet` through the factory, unless it exists; the owner pays the 6 NEAR deposit.
2. Mints mUSDC and mNBTC to the owner from the public test faucets, and deposits both into the account.
3. Asks pb-risk for a preview over OutLayer's HTTPS API with a snapshot of every input it read, and replays it
   natively with `backtest verdict`: the attested verdict must equal risk-core's on the same inputs.
4. Asks for an on-chain check, then for a borrow verdict, and borrows.
5. Tries the refusals: the same verdict used twice, and a verdict past 120 blocks (skip with --skip-stale).
6. Repays everything, then withdraws both tokens with no loan and no verdict.

Transactions are signed by the near CLI with the owner's key from the macOS keychain. The OutLayer payment key is read
from .env inside this process and sent only to OutLayer's testnet API; it is never printed or saved.
Everything is recorded in research/data/phase2_first_loan.json.
"""
import argparse
import base64
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RPC = "https://test.rpc.fastnear.com"
FACTORY, POOL = "pbf.testnet", "pool.pbf.testnet"
OUTLAYER_API = "https://testnet-api.outlayer.ai/call/pbf-keeper.testnet/pb-risk"
OUT = ROOT / "research" / "data" / "phase2_first_loan.json"

ap = argparse.ArgumentParser()
ap.add_argument("--name", default="demo1")
ap.add_argument("--owner", default="pbf-keeper.testnet")
ap.add_argument("--borrow", type=float, default=5_000.0, help="USD to borrow")
ap.add_argument("--skip-stale", action="store_true")
args = ap.parse_args()
ACCOUNT = f"{args.name}.{FACTORY}"
record = {"account": ACCOUNT, "owner": args.owner, "started_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
          "steps": []}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def save():
    OUT.write_text(json.dumps(record, indent=1))


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(5):
        try:
            req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": "pb-e2e/0.1"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 4:
                raise
            time.sleep(2 + attempt * 2)


def view(contract, method, a=None):
    d = rpc("query", {"request_type": "call_function", "finality": "optimistic", "account_id": contract, "method_name": method,
                      "args_base64": base64.b64encode(json.dumps(a or {}).encode()).decode()})
    if "result" not in d or "result" not in d["result"]:
        return None
    return json.loads(bytes(d["result"]["result"]).decode() or "null")


def exists(account):
    d = rpc("query", {"request_type": "view_account", "finality": "optimistic", "account_id": account})
    return "result" in d


def block_height():
    return rpc("block", {"finality": "optimistic"})["result"]["header"]["height"]


def call(contract, method, a, gas="300 Tgas", deposit="0 NEAR", expect_fail=False, label=None):
    """Signs and sends one call with the near CLI. Returns (ok, tx hash, return value or error text)."""
    cmd = ["near", "contract", "call-function", "as-transaction", contract, method, "json-args", json.dumps(a),
           "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", args.owner, "network-config", "testnet",
           "sign-with-keychain", "send"]
    t0 = time.time()
    p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    text = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
    tx = (re.search(r"Transaction ID: (\w+)", text) or re.search(r"transactions/(\w+)", text))
    ok = p.returncode == 0 and "Error" not in text.split("Here is your console command")[0]
    m = re.search(r"Function execution return value \(printed to stdout\):\s*\n(.*?)\n\n", text, re.S)
    detail = (m.group(1).strip() if m else "") if ok else (re.findall(r"(?:Smart contract panicked|ExecutionError|panicked|Error)[^\n]*", text)[:3] or [text[-400:]])
    step = {"step": label or f"{contract}.{method}", "args": a, "ok": ok, "expect_fail": expect_fail,
            "tx": tx.group(1) if tx else None, "seconds": round(time.time() - t0, 1), "detail": detail}
    record["steps"].append(step)
    save()
    mark = ("refused, as expected" if not ok else "WENT THROUGH, NOT EXPECTED") if expect_fail else ("ok" if ok else "FAILED")
    log(f"{step['step']}: {mark} ({step['seconds']} s, tx {step['tx']})" + ("" if ok else f" | {str(detail)[:300]}"))
    return ok, step["tx"], detail


def wait_for_verdict(after_block, timeout=180):
    """Polls get_state until a verdict received after `after_block` is held."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = view(ACCOUNT, "get_state")
        held = st and st.get("verdict")
        if held and held.get("received_block", 0) > after_block:
            return st, round(time.time() - t0, 1)
        time.sleep(3)
    return view(ACCOUNT, "get_state"), None


def summary(v):
    return {k: v.get(k) for k in ("ok", "state", "action", "tier", "score", "rate_bp", "allow", "credit", "eq", "eq_allow",
                                  "mm", "im", "nonce", "blk", "top", "reason")}


def payment_key():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("OUTLAYER_PAYMENT_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("OUTLAYER_PAYMENT_KEY is not in .env")


def preview_and_replay(version_key):
    body = {"input": {"mode": "preview", "account": ACCOUNT, "intent": {"check": {}}, "network": "testnet", "snapshot": True},
            "resource_limits": {"max_instructions": 2_000_000_000, "max_memory_mb": 256, "max_execution_seconds": 20},
            "version_key": version_key}
    req = urllib.request.Request(OUTLAYER_API, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "X-Payment-Key": payment_key(), "X-Compute-Limit": "20000"})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read().decode())
    out = resp.get("output")
    snap = ROOT / "research" / "data" / "phase2_preview_snapshot.json"
    snap.write_text(json.dumps(out if isinstance(out, dict) else json.loads(out)))
    rep = subprocess.run(["cargo", "run", "-q", "-p", "backtest", "--release", "--", "verdict", str(snap)],
                         cwd=ROOT / "risk", capture_output=True, text=True, timeout=900)
    result = {"call_id": resp.get("call_id"), "status": resp.get("status"), "time_ms": resp.get("time_ms"),
              "instructions": resp.get("instructions"), "compute_cost": resp.get("compute_cost"),
              "attestation_url": resp.get("attestation_url"), "replay_exit": rep.returncode,
              "replay_says": (rep.stdout + rep.stderr).strip().splitlines()[-3:]}
    record["preview_replay"] = result
    save()
    log(f"preview in the enclave: {resp.get('status')}, {resp.get('time_ms')} ms; native replay exit {rep.returncode}: "
        f"{result['replay_says']}")
    return out


def main():
    cfg = view(FACTORY, "get_config")
    if not cfg["risk"]["version_key"]:
        raise SystemExit("the factory has no pinned pb-risk version yet")
    musdc, mnbtc = cfg["usdc_token"], next(t["id"] for t in cfg["tokens"] if t["symbol"] == "nBTC")
    if not exists(ACCOUNT):
        call(FACTORY, "create_account", {"name": args.name, "owner": args.owner}, deposit="6 NEAR", label="create account")
    st = view(ACCOUNT, "get_state")
    record["created_state"] = {"owner": st["owner"], "counter": st["counter"]}
    log(f"{ACCOUNT}: owner {st['owner']}, counter {st['counter']}, pinned pb-risk {view(ACCOUNT, 'get_config')['risk']['version_key'][:12]}...")

    # Deposits: $20,000 of mUSDC and 0.25 mNBTC (about $19k).
    for token, amount in ((musdc, 20_000 * 10**6), (mnbtc, 25_000_000)):
        call(token, "mint", {"account_id": args.owner, "amount": str(amount)}, gas="30 Tgas", deposit="0.00125 NEAR",
             label=f"mint {token.split('.')[0]} to the owner")
        call(token, "ft_transfer_call", {"receiver_id": ACCOUNT, "amount": str(amount), "msg": ""}, gas="100 Tgas",
             deposit="1 yoctoNEAR", label=f"deposit {token.split('.')[0]}")
    record["balances_after_deposit"] = {t: view(t, "ft_balance_of", {"account_id": ACCOUNT}) for t in (musdc, mnbtc)}

    # The attested verdict against risk-core on the same inputs.
    preview_and_replay(cfg["risk"]["version_key"])

    # An on-chain check.
    h = block_height()
    call(ACCOUNT, "request_check", {"intent": {"check": {}}}, deposit="0.01 NEAR", label="request_check (check)")
    st, waited = wait_for_verdict(h)
    v = st["verdict"]["verdict"] if st.get("verdict") else {}
    record["check_verdict"] = summary(v)
    log(f"check verdict after {waited} s: {json.dumps(summary(v))[:400]}")

    # Borrow.
    want = int(args.borrow * 10**6)
    h = block_height()
    call(ACCOUNT, "request_check", {"intent": {"borrow": {"amount": str(want)}}}, deposit="0.01 NEAR", label="request_check (borrow)")
    st, waited = wait_for_verdict(h)
    v = st["verdict"]["verdict"]
    record["borrow_verdict"] = summary(v)
    allow = int((v.get("allow") or {}).get("borrow") or 0)
    log(f"borrow verdict after {waited} s: allow.borrow ${allow / 1e6:,.2f}, tier {v.get('tier')}, state {v.get('state')}")
    amount = min(want, allow)
    if amount <= 0:
        raise SystemExit("the verdict allows no borrowing; see the record")
    ok, _, _ = call(ACCOUNT, "borrow", {"amount": str(amount)}, deposit="1 yoctoNEAR", label="borrow")
    time.sleep(4)
    debt = int(view(POOL, "debt_of", {"account_id": ACCOUNT}) or 0)
    record["after_borrow"] = {"debt": debt, "musdc": view(musdc, "ft_balance_of", {"account_id": ACCOUNT})}
    log(f"after borrow: pool debt ${debt / 1e6:,.6f}, account mUSDC {int(record['after_borrow']['musdc']) / 1e6:,.2f}")

    # Refusal 1: the same verdict used twice.
    call(ACCOUNT, "borrow", {"amount": str(min(amount, 1_000_000))}, deposit="1 yoctoNEAR", expect_fail=True,
         label="borrow again with the used verdict")

    # Refusal 2: a verdict past 120 blocks.
    if not args.skip_stale:
        h = block_height()
        call(ACCOUNT, "request_check", {"intent": {"borrow": {"amount": "1000000"}}}, deposit="0.01 NEAR",
             label="request_check (borrow, to let it go stale)")
        st, _ = wait_for_verdict(h)
        blk = st["verdict"]["verdict"]["blk"]
        log(f"waiting until block {blk + 125} so the verdict is more than 120 blocks old...")
        while block_height() <= blk + 125:
            time.sleep(5)
        call(ACCOUNT, "borrow", {"amount": "1000000"}, deposit="1 yoctoNEAR", expect_fail=True, label="borrow with a stale verdict")

    # Repay everything; the pool sends back what it doesn't need.
    debt = int(view(POOL, "debt_of", {"account_id": ACCOUNT}) or 0)
    call(ACCOUNT, "repay", {"amount": str(debt + 1_000_000)}, deposit="1 yoctoNEAR", label="repay")
    time.sleep(4)
    record["after_repay"] = {"debt": view(POOL, "debt_of", {"account_id": ACCOUNT}), "loan": view(ACCOUNT, "get_state")["loan"]}
    log(f"after repay: pool debt {record['after_repay']['debt']}, account loan {record['after_repay']['loan']}")

    # With no loan, withdrawals need no verdict.
    for token in (mnbtc, musdc):
        bal = view(token, "ft_balance_of", {"account_id": ACCOUNT})
        call(ACCOUNT, "withdraw", {"token": token, "amount": bal, "receiver": args.owner}, deposit="1 yoctoNEAR",
             label=f"withdraw all {token.split('.')[0]} with no loan, no verdict")
    record["final"] = {"balances": {t: view(t, "ft_balance_of", {"account_id": ACCOUNT}) for t in (musdc, mnbtc)},
                       "state": view(ACCOUNT, "get_state"), "pool": view(POOL, "get_pool")}
    record["finished_utc"] = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    save()
    bad = [s["step"] for s in record["steps"] if s["ok"] == s["expect_fail"]]
    log("ALL STEPS AS EXPECTED" if not bad else f"UNEXPECTED: {bad}")
    sys.exit(1 if bad else 0)


main()
