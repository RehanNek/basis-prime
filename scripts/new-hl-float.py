"""Makes a fresh wallet for the Hyperliquid testnet float and saves it in .env, without showing the private key.

Usage: python3 -I scripts/new-hl-float.py [--force]
       python3 -I scripts/new-hl-float.py --gas [--force]   the Base Sepolia gas wallet instead (FUNDING.md 9)

The float is a testnet-only wallet. It receives the test USDC claimed from Hyperliquid's faucet, pays the 1Click
shim's deliveries on Hyperliquid testnet, and posts the other side of the demo's trades (PLAN.md 5.4 and 12).
It must never hold real money, and it is never used on mainnet.

The private key goes into .env as HL_FLOAT_PRIVATE_KEY through scripts/set-env.sh, and the address as HL_FLOAT_ADDRESS.
Only the address is printed. Without --force, it refuses to replace a float that is already saved.

With --gas it makes the testnet gas wallet for Aave's test market on Base Sepolia: the backend uses it to send a
little test ETH to a client account's Ethereum address, so that address can pay for its own transactions. Its key
goes into .env as EVM_GAS_PRIVATE_KEY and its address as EVM_GAS_ADDRESS, the same way. Testnet only, never real money.
Standard library only: the key comes from `secrets`, and the address is worked out here (secp256k1 and Keccak-256),
with a self-test against known values first.
"""
import pathlib
import re
import secrets
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# ---------- Keccak-256 (Ethereum's padding) ----------
RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
      0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
      0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
      0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
      0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M64 = (1 << 64) - 1


def _rol(v, n):
    return ((v << n) | (v >> (64 - n))) & M64 if n else v


def keccak256(data):
    msg = bytearray(data) + b"\x01"
    while len(msg) % 136:
        msg += b"\x00"
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), 136):
        for i in range(17):
            a[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
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
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


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


def address_of(key: int) -> str:
    """EIP-55 address of a private key: the last 20 bytes of keccak(x || y), with the checksum's capitals."""
    x, y = _mul(key, G)
    raw = keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))[12:].hex()
    check = keccak256(raw.encode()).hex()
    return "0x" + "".join(ch.upper() if ch.isalpha() and int(check[i], 16) >= 8 else ch for i, ch in enumerate(raw))


def self_test():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    # Well-known keys: 1 and 2 give these Ethereum addresses.
    assert address_of(1) == "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
    assert address_of(2) == "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF"


def main():
    self_test()
    gas = "--gas" in sys.argv
    key_name, addr_name = ("EVM_GAS_PRIVATE_KEY", "EVM_GAS_ADDRESS") if gas else ("HL_FLOAT_PRIVATE_KEY", "HL_FLOAT_ADDRESS")
    what = "Base Sepolia gas wallet" if gas else "Hyperliquid testnet float"
    env = ROOT / ".env"
    saved = env.read_text(encoding="utf-8") if env.exists() else ""
    if re.search(rf"^{key_name}=0x", saved, re.M) and "--force" not in sys.argv:
        addr = re.search(rf"^{addr_name}=(\S+)", saved, re.M)
        print(f"A {what} is already saved ({addr.group(1) if addr else 'address not saved'}). Use --force to replace it.")
        return
    while True:
        key = secrets.randbits(256)
        if 0 < key < N:
            break
    addr = address_of(key)
    for name, value in ((key_name, "0x" + key.to_bytes(32, "big").hex()), (addr_name, addr)):
        subprocess.run(["bash", str(ROOT / "scripts" / "set-env.sh"), name], input=value + "\n", text=True,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"New {what}: {addr}")
    print(f"Its private key is in .env as {key_name}. It was not shown.")


main()
