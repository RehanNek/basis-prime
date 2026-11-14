"""Fetches the code and the state of deployed testnet contracts, for the upgrade tests (tests/upgrade.rs).

It only reads: RPC `query` requests `view_code` and `view_state` on https://test.rpc.fastnear.com. It signs nothing
and needs no key. Files go to contracts/target/live/, outside the source tree, or to the folder `--out` names:

  <name>.wasm        the deployed code, byte for byte
  <name>.state.json  {"account_id", "block_height", "code_sha256", "values": [{"key", "value"}]}, base64 as the RPC
                     returns them

Run it from anywhere, with the standard library only:

  python3 -I contracts/tests/fetch_live.py              all of them: the drill, the pool, the factory, a Phase 4 account
                                                        and the two test tokens
  python3 -I contracts/tests/fetch_live.py drill        just one of them
  python3 -I contracts/tests/fetch_live.py --out contracts/target/live-stage2 factory pool musdc mnbtc
                                                        into a folder of its own, leaving target/live/ as it is
"""

import base64
import hashlib
import json
import pathlib
import sys
import urllib.request

RPC = "https://test.rpc.fastnear.com"
CONTRACTS = {
    "drill": "drill.pbf-ops.testnet",
    "pool": "pool.pbf.testnet",
    "factory": "pbf.testnet",
    # A client account made by the Phase 4 factory: it runs the account code new accounts get.
    "account": "drill1.pbf.testnet",
    # The test tokens the factory registers each new account on.
    "musdc": "musdc.pbf-ops.testnet",
    "mnbtc": "mnbtc.pbf-ops.testnet",
}
OUT = pathlib.Path(__file__).resolve().parent.parent / "target" / "live"


def query(params):
    body = json.dumps({"jsonrpc": "2.0", "id": "fetch_live", "method": "query", "params": params}).encode()
    request = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        answer = json.load(response)
    if "error" in answer:
        raise SystemExit(f"{params['request_type']} {params['account_id']}: {answer['error']}")
    result = answer["result"]
    if "error" in result:
        raise SystemExit(f"{params['request_type']} {params['account_id']}: {result['error']}")
    return result


def fetch(name, account_id, out):
    code = query({"request_type": "view_code", "finality": "final", "account_id": account_id})
    wasm = base64.b64decode(code["code_base64"])
    state = query({"request_type": "view_state", "finality": "final", "account_id": account_id,
                   "prefix_base64": "", "include_proof": False})
    sha = hashlib.sha256(wasm).hexdigest()
    (out / f"{name}.wasm").write_bytes(wasm)
    record = {"account_id": account_id, "block_height": state["block_height"], "code_sha256": sha,
              "values": [{"key": v["key"], "value": v["value"]} for v in state["values"]]}
    (out / f"{name}.state.json").write_text(json.dumps(record, indent=1) + "\n")
    print(f"{name:8s} {account_id:24s} {len(wasm):7d} bytes  sha256 {sha}  {len(record['values'])} state keys "
          f"at block {state['block_height']}")


def main():
    args, out = sys.argv[1:], OUT
    if args[:1] == ["--out"]:
        if len(args) < 2:
            raise SystemExit("--out needs a folder")
        out, args = pathlib.Path(args[1]).resolve(), args[2:]
    names = args or list(CONTRACTS)
    unknown = [n for n in names if n not in CONTRACTS]
    if unknown:
        raise SystemExit(f"unknown: {', '.join(unknown)}; choose from {', '.join(CONTRACTS)}")
    out.mkdir(parents=True, exist_ok=True)
    for name in names:
        fetch(name, CONTRACTS[name], out)


main()
