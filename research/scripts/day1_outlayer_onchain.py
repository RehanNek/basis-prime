"""Phase 0 checks 1 and the callback gas (PLAN.md 11.1, W2): OutLayer called on-chain from a contract, on testnet.

Usage: python3 -I day1_outlayer_onchain.py <out.json> '<source JSON>' [hello_runs] [big sizes, comma-separated]

Each run asks `probe.pbf-ops.testnet.outlayer_probe` to call `outlayer.testnet.request_execution` with the probe
program, the way the account contract will ask for a verdict. The probe's callback parses the verdict, hashes it and
stores the hash, and returns the bytes it received, the block heights and the gas it used. The contract pays OutLayer's
deposit (0.01 NEAR per run) from its own balance and gets the unused part back.

Transactions are signed by the near CLI with pbf-keeper.testnet's key from the macOS keychain; no key is read here.
"""
import base64
import json
import re
import subprocess
import sys
import time
import urllib.request

OUT, SOURCE = sys.argv[1], json.loads(sys.argv[2])
HELLO_RUNS = int(sys.argv[3]) if len(sys.argv) > 3 else 20
BIG = [int(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else [256, 900, 1024, 2048]
RPC = "https://test.rpc.fastnear.com"
PROBE, CALLER = "probe.pbf-ops.testnet", "pbf-keeper.testnet"
LIMITS = {"max_instructions": 1_000_000_000, "max_memory_mb": 128, "max_execution_seconds": 30}
DEPOSIT = str(10**22)   # 0.01 NEAR; research/outlayer.md 1 puts the estimate at about 0.004 NEAR for these limits


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": "pb-research/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def balance():
    return int(rpc("query", {"request_type": "view_account", "finality": "final", "account_id": PROBE})["result"]["amount"])


def one_run(label, program_input):
    args = json.dumps({"source": SOURCE, "resource_limits": LIMITS, "input": json.dumps(program_input), "deposit": DEPOSIT})
    cmd = ["near", "contract", "call-function", "as-transaction", PROBE, "outlayer_probe", "json-args", args,
           "prepaid-gas", "300 Tgas", "attached-deposit", "0 NEAR", "sign-as", CALLER, "network-config", "testnet",
           "sign-with-keychain", "send"]
    before = balance()
    t0 = time.time()
    p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    wall = round(time.time() - t0, 2)
    text = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
    m = re.search(r"Transaction ID: (\w+)", text)
    row = {"label": label, "input": program_input, "wall_seconds": wall, "tx": m.group(1) if m else None, "cli_exit": p.returncode}
    if not m:
        row["error"] = text[-800:]
        return row
    st = rpc("tx", {"tx_hash": m.group(1), "sender_account_id": CALLER, "wait_until": "FINAL"})["result"]
    val = st["status"].get("SuccessValue")
    res = json.loads(base64.b64decode(val).decode()) if val else None
    outcomes = [st["transaction_outcome"]] + st["receipts_outcome"]
    probe_receipts = [o for o in st["receipts_outcome"] if o["outcome"]["executor_id"] == PROBE]
    row.update({"result": res, "status": list(st["status"].keys())[0],
                "blocks": (res["end_height"] - res["start_height"]) if res and "end_height" in res else None,
                "callback_receipt_gas_tgas": round(probe_receipts[-1]["outcome"]["gas_burnt"] / 1e12, 3) if probe_receipts else None,
                "gas_burnt_tgas": round(sum(o["outcome"]["gas_burnt"] for o in outcomes) / 1e12, 3),
                "tokens_burnt_near": sum(int(o["outcome"]["tokens_burnt"]) for o in outcomes) / 1e24,
                "probe_balance_change_near": (balance() - before) / 1e24})
    if not val:
        row["failure"] = json.dumps(st["status"])[:600]
    return row


def main():
    out = {"generated_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()), "source": SOURCE, "limits": LIMITS,
           "deposit_yocto": DEPOSIT, "runs": []}
    plan = [(f"hello {i}", {"mode": "hello"}) for i in range(1, HELLO_RUNS + 1)] + [(f"big {n}", {"mode": "big", "bytes": n}) for n in BIG]
    for label, program_input in plan:
        row = one_run(label, program_input)
        out["runs"].append(row)
        r = row.get("result") or {}
        print(f"{label}: wall {row['wall_seconds']} s, blocks {row.get('blocks')}, ok {r.get('ok')}, bytes {r.get('bytes')}, "
              f"callback gas {r.get('callback_gas_used')}, receipt {row.get('callback_receipt_gas_tgas')} Tgas, "
              f"total {row.get('gas_burnt_tgas')} Tgas, net cost {-(row.get('probe_balance_change_near') or 0):.5f} NEAR"
              + (f", reason {r.get('reason')}" if r.get("reason") else "") + (f", error {row['error'][-300:]}" if "error" in row else ""),
              flush=True)
        json.dump(out, open(OUT, "w"), indent=1)
    hello = [r for r in out["runs"] if r["label"].startswith("hello")]
    good = [r for r in hello if (r.get("result") or {}).get("ok")]
    walls = sorted(r["wall_seconds"] for r in good)
    blocks = sorted(r["blocks"] for r in good if r.get("blocks") is not None)
    out["summary"] = {"hello_runs": len(hello), "hello_ok": len(good),
                      "wall_seconds_min_median_max": [walls[0], walls[len(walls) // 2], walls[-1]] if walls else None,
                      "blocks_min_median_max": [blocks[0], blocks[len(blocks) // 2], blocks[-1]] if blocks else None,
                      "big": {r["label"]: {"ok": (r.get("result") or {}).get("ok"), "bytes": (r.get("result") or {}).get("bytes"),
                                           "callback_gas_used": (r.get("result") or {}).get("callback_gas_used")}
                              for r in out["runs"] if r["label"].startswith("big")}}
    json.dump(out, open(OUT, "w"), indent=1)
    print("summary:", json.dumps(out["summary"]))


main()
