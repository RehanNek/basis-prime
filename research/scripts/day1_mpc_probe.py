"""Phase 0 check 3 (PLAN.md 11.1, W1): Chain Signatures from a contract, timed and verified, on testnet.

Usage: python3 -I day1_mpc_probe.py <out.json> [runs]

Each run builds a real Hyperliquid testnet `ApproveAgent` EIP-712 digest (a random agent address, so nothing is ever
approved), asks `probe.pbf-ops.testnet.sign_probe` to have the MPC signer sign it under the path `hyperliquid-1`, and
then checks the signature the way Hyperliquid would: ecrecover with v = recovery_id + 27 must give the address the
signer derives for (probe.pbf-ops.testnet, hyperliquid-1).

Before the runs it tests its own pieces: Keccak-256 against known vectors and against hashlib's SHA3 (same
permutation), the EIP-712 encoder against the spec's "Ether Mail" example, and the key derivation against both the
signer's `derived_public_key` view and the PLAN.md test vector (client1.pb.testnet -> 0xd7f3...dd7c).

Transactions are signed by the near CLI with pbf-ops.testnet's key from the macOS keychain; no key is read here.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

OUT = sys.argv[1]
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 10
RPC = "https://test.rpc.fastnear.com"
SIGNER, PROBE, CALLER, PATH = "v1.signer-prod.testnet", "probe.pbf-ops.testnet", "pbf-ops.testnet", "hyperliquid-1"

# ---------- Keccak-256 (Ethereum's, not NIST SHA3: same permutation, different padding byte) ----------
RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
      0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
      0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
      0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
      0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M64 = (1 << 64) - 1


def _rol(v, n):
    return ((v << n) | (v >> (64 - n))) & M64 if n else v


def _keccak_f(a):
    for rc in RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def _sponge256(data, pad):
    rate = 136
    msg = bytearray(data) + bytes([pad])
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        a = _keccak_f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def keccak256(data):
    return _sponge256(data, 0x01)


# ---------- secp256k1 ----------
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    lam = (3 * x1 * x1 * pow(2 * y1, -1, P) if p1 == p2 else (y2 - y1) * pow(x2 - x1, -1, P)) % P
    x3 = (lam * lam - x1 - x2) % P
    return x3, (lam * (x1 - x3) - y1) % P


def _mul(k, pt):
    r = None
    while k:
        if k & 1:
            r = _add(r, pt)
        pt, k = _add(pt, pt), k >> 1
    return r


def ecrecover(digest, rid, r, s):
    """What Hyperliquid does with v = rid + 27: the public key that produced (r, s) over digest."""
    x = r
    y = pow((x ** 3 + 7) % P, (P + 1) // 4, P)
    if y % 2 != rid % 2:
        y = P - y
    e = int.from_bytes(digest, "big") % N
    return _mul(pow(r, -1, N), _add(_mul(s, (x, y)), _mul((-e) % N, G)))


def address(pt):
    return "0x" + keccak256(pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big"))[12:].hex()


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def secp_key(s):
    """'secp256k1:<base58 of x||y>' -> (x, y)."""
    n = 0
    for ch in s.split(":", 1)[1]:
        n = n * 58 + B58.index(ch)
    raw = n.to_bytes(64, "big")
    return int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")


# ---------- EIP-712 ----------
def _word(v):
    return v.to_bytes(32, "big")


def _addr_word(a):
    return bytes(12) + bytes.fromhex(a[2:])


def _kh(s):
    return keccak256(s.encode())


def eip712_digest(domain_sep, struct_hash):
    return keccak256(b"\x19\x01" + domain_sep + struct_hash)


def hl_domain_separator(chain_id=0x66EEE):
    th = _kh("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    return keccak256(th + _kh("HyperliquidSignTransaction") + _kh("1") + _word(chain_id) + bytes(32))


def approve_agent_digest(agent, agent_name, nonce, chain="Testnet"):
    th = _kh("HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)")
    return eip712_digest(hl_domain_separator(), keccak256(th + _kh(chain) + _addr_word(agent) + _kh(agent_name) + _word(nonce)))


# ---------- RPC and CLI ----------
def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": "pb-research/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def view(contract, method, args):
    d = rpc("query", {"request_type": "call_function", "finality": "final", "account_id": contract, "method_name": method,
                      "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
    return json.loads(bytes(d["result"]["result"]).decode())


def self_tests():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    for n in (0, 1, 135, 136, 137, 271, 272, 300, 1000):
        data = os.urandom(n)
        assert _sponge256(data, 0x06) == hashlib.sha3_256(data).digest(), n
    # EIP-712 spec example ("Ether Mail"): known domain separator and digest.
    th_dom = _kh("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    dom = keccak256(th_dom + _kh("Ether Mail") + _kh("1") + _word(1) + _addr_word("0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"))
    assert dom.hex() == "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
    th_person = _kh("Person(string name,address wallet)")
    th_mail = _kh("Mail(Person from,Person to,string contents)Person(string name,address wallet)")

    def person(name, wallet):
        return keccak256(th_person + _kh(name) + _addr_word(wallet))
    mail = keccak256(th_mail + person("Cow", "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826")
                     + person("Bob", "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB") + _kh("Hello, Bob!"))
    assert eip712_digest(dom, mail).hex() == "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
    # Key derivation: local formula vs the signer's view vs the PLAN.md test vector.
    root = secp_key(view(SIGNER, "public_key", {"domain_id": 0}))
    for pred, path, expect in (("client1.pb.testnet", "hyperliquid-1", "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c"),
                               (PROBE, PATH, None)):
        tweak = int.from_bytes(hashlib.sha3_256(f"near-mpc-recovery v0.1.0 epsilon derivation:{pred},{path}".encode()).digest(), "big") % N
        local = _add(root, _mul(tweak, G))
        remote = secp_key(view(SIGNER, "derived_public_key", {"path": path, "predecessor": pred, "domain_id": 0}))
        assert local == remote, f"derivation differs for {pred}"
        if expect:
            assert address(remote) == expect, address(remote)
    return {"root_key": view(SIGNER, "public_key", {"domain_id": 0}), "signer_version": view(SIGNER, "version", {})}


def one_run(i, expected):
    agent = "0x" + os.urandom(20).hex()
    nonce = int(time.time() * 1000)
    digest = approve_agent_digest(agent, "pb probe", nonce)
    args = json.dumps({"payload_hex": digest.hex(), "path": PATH})
    cmd = ["near", "contract", "call-function", "as-transaction", PROBE, "sign_probe", "json-args", args, "prepaid-gas",
           "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", CALLER, "network-config", "testnet",
           "sign-with-keychain", "send"]
    t0 = time.time()
    p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
    wall = round(time.time() - t0, 2)
    text = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
    m = re.search(r"Transaction ID: (\w+)", text)
    row = {"run": i, "wall_seconds": wall, "agent": agent, "nonce": nonce, "digest": digest.hex(),
           "tx": m.group(1) if m else None, "cli_exit": p.returncode}
    if not m:
        row["error"] = text[-600:]
        return row
    st = rpc("tx", {"tx_hash": m.group(1), "sender_account_id": CALLER, "wait_until": "FINAL"})["result"]
    val = st["status"].get("SuccessValue")
    res = json.loads(base64.b64decode(val).decode()) if val else None
    outcomes = [st["transaction_outcome"]] + st["receipts_outcome"]
    row.update({"result_ok": bool(res and res.get("ok")),
                "blocks": (res["end_height"] - res["start_height"]) if res else None,
                "gas_burnt_tgas": round(sum(o["outcome"]["gas_burnt"] for o in outcomes) / 1e12, 3),
                "tokens_burnt_near": sum(int(o["outcome"]["tokens_burnt"]) for o in outcomes) / 1e24})
    if res and res.get("ok"):
        sig = res["signature"]
        big_r = bytes.fromhex(sig["big_r"]["affine_point"])
        r, s, rid = int.from_bytes(big_r[1:], "big"), int(sig["s"]["scalar"], 16), sig["recovery_id"]
        rec = ecrecover(digest, rid, r, s)
        # big_r is the signer's R before it flips s to the low form, so its prefix can disagree with recovery_id.
        # Hyperliquid only sees r (the x coordinate, the same either way), s and v = recovery_id + 27.
        row.update({"recovery_id": rid, "big_r_prefix_parity_equals_recovery_id": (big_r[0] - 2) == (rid & 1), "low_s": s <= N // 2,
                    "recovered_address": address(rec), "recovers_to_derived": rec == expected})
    return row


def main():
    info = self_tests()
    expected = secp_key(view(SIGNER, "derived_public_key", {"path": PATH, "predecessor": PROBE, "domain_id": 0}))
    out = {"generated_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()), "self_tests": "passed", **info,
           "probe": PROBE, "path": PATH, "derived_address": address(expected), "runs": []}
    print(f"self-tests passed; signer version {info['signer_version']}; derived address {address(expected)}", flush=True)
    for i in range(1, RUNS + 1):
        row = one_run(i, expected)
        out["runs"].append(row)
        print(f"run {i}: wall {row['wall_seconds']} s, blocks {row.get('blocks')}, ok {row.get('result_ok')}, "
              f"recovers {row.get('recovers_to_derived')}, gas {row.get('gas_burnt_tgas')} Tgas, "
              f"burnt {row.get('tokens_burnt_near')} NEAR" + (f", error {row['error'][-200:]}" if "error" in row else ""), flush=True)
        json.dump(out, open(OUT, "w"), indent=1)
    ok = [r for r in out["runs"] if r.get("recovers_to_derived")]
    walls = sorted(r["wall_seconds"] for r in ok)
    blocks = sorted(r["blocks"] for r in ok)
    out["summary"] = {"runs": RUNS, "verified": len(ok),
                      "wall_seconds_min_median_max": [walls[0], walls[len(walls) // 2], walls[-1]] if walls else None,
                      "blocks_min_median_max": [blocks[0], blocks[len(blocks) // 2], blocks[-1]] if blocks else None}
    json.dump(out, open(OUT, "w"), indent=1)
    print("summary:", json.dumps(out["summary"]))


main()
