#!/usr/bin/env python3
"""Reads what is live on NEAR testnet, with no key and no wallet (README, "Read the live deployment").

    python3 -I scripts/live-check.py

It only reads: NEAR testnet's public RPC (view calls) and Hyperliquid testnet's public info endpoint. It prints the
code that is deployed, the settings every new client account gets, the pool's money, and what our Rhea copy counts
a bitcoin and an ether at next to Hyperliquid testnet's oracle price. Standard library only.

    NEAR_RPC_URL   another NEAR testnet RPC (default: https://test.rpc.fastnear.com, the services' own default)
    FACTORY_ACCOUNT_ID, POOL_ACCOUNT_ID, RHEA_ACCOUNT_ID   other accounts than ours
"""
import base64
import json
import os
import sys
import urllib.request

RPC = os.environ.get("NEAR_RPC_URL", "https://test.rpc.fastnear.com")
HL = "https://api.hyperliquid-testnet.xyz/info"
FACTORY = os.environ.get("FACTORY_ACCOUNT_ID", "pbf.testnet")
POOL = os.environ.get("POOL_ACCOUNT_ID", "pool.pbf.testnet")
RHEA = os.environ.get("RHEA_ACCOUNT_ID", "rhea.pbf-ops.testnet")
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def post(url, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "pb-live-check"})
    with urllib.request.urlopen(request, timeout=30) as answer:
        return json.load(answer)


def query(params):
    answer = post(RPC, {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"finality": "final", **params}})
    if "result" not in answer or "error" in answer.get("result", {}):
        raise RuntimeError(json.dumps(answer.get("error") or answer["result"].get("error"))[:300])
    return answer["result"]


def view(account, method, args=None):
    """A view call's answer, parsed, and the block it was read at."""
    result = query({"request_type": "call_function", "account_id": account, "method_name": method, "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode()})
    return json.loads(bytes(result["result"]).decode()), result["block_height"]


def code_hash(account):
    """The sha256 of the account's deployed code, in hex (the RPC gives it in base58)."""
    n = 0
    for ch in query({"request_type": "view_account", "account_id": account})["code_hash"]:
        n = n * 58 + B58.index(ch)
    return n.to_bytes(32, "big").hex()


def usd(micro):
    return f"${int(micro) / 1e6:,.2f}"


def main():
    config, block = view(FACTORY, "get_config")
    count, _ = view(FACTORY, "accounts_count")
    paused, _ = view(FACTORY, "is_paused")
    account_code, _ = view(FACTORY, "account_code_hash")
    symbol = {t["id"]: t["symbol"] for t in config["tokens"]}
    print(f"NEAR testnet at block {block}, read through {RPC.split('//')[-1]}")
    print()
    print(f"factory {FACTORY}")
    print(f"  code                      {code_hash(FACTORY)}")
    print(f"  client accounts made      {count}; paused: {str(paused).lower()}")
    print("  every new client account gets:")
    print(f"    account code            {account_code}")
    print(f"    risk engine             {config['risk']['project_id']} at {config['risk']['version_key']}")
    print(f"    order gateway           {config['gateway']['project_id']} at {config['gateway']['version_key']}")
    print(f"    parameters              model {config['model']}, hash {config['params_hash']}")
    print(f"    Chain Signatures        {config['mpc_id']}; OutLayer {config['outlayer_id']}")
    print(f"    tokens                  {', '.join(t['symbol'] for t in config['tokens'])}")
    lenders = config.get("lenders") or {}
    rhea, aave = lenders.get("rhea"), lenders.get("aave")
    if rhea:
        print(f"    Rhea                    {rhea['contract_id']}, collateral: {', '.join(symbol.get(t, t) for t in rhea['collateral'])}")
    if aave:
        print(f"    Aave                    chain {aave['chain_id']}, Pool {aave['pool']}, collateral: {', '.join(t['symbol'] for t in aave['collateral'])}")
    print()

    pool, _ = view(POOL, "get_pool")
    print(f"pool {POOL}")
    print(f"  code                      {code_hash(POOL)}")
    print(f"  cash {usd(pool['cash'])}, lent out {usd(pool['loans'])}, written off {usd(pool['written_off'])}; paused: {str(pool['paused']).lower()}")
    print()

    if not rhea:
        return
    meta, ctxs = post(HL, {"type": "metaAndAssetCtxs"})
    names = [u["name"] for u in meta["universe"]]
    print(f"our Rhea copy {RHEA} (Rhea's own release file; code {code_hash(RHEA)})")
    for token in rhea["collateral"]:
        coin = {"nBTC": "BTC", "ETH": "ETH"}.get(symbol.get(token, ""))
        info, _ = view(RHEA, "get_token_pyth_info", {"token_id": token})
        fixed = (info or {}).get("default_price")
        if not coin or not fixed:
            print(f"  {token}: no fixed price to compare")
            continue
        price = int(fixed["multiplier"]) / 10 ** (fixed["decimals"] - info["decimals"])
        oracle = float(ctxs[names.index(coin)]["oraclePx"])
        print(f"  {symbol[token]:<5} counted at ${price:,.2f}; Hyperliquid testnet's {coin} oracle ${oracle:,.2f}; {abs(price / oracle - 1) * 100:.2f}% apart")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # a public endpoint that doesn't answer is said in one line
        print(f"could not read: {error}", file=sys.stderr)
        sys.exit(1)
