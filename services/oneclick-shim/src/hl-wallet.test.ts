// The float's Hyperliquid signer, checked against the official Python SDK's test vectors
// (hyperliquid-python-sdk, tests/signing_test.py: the same key, actions and expected signatures).
import assert from "node:assert/strict";
import { test } from "node:test";

import { UsdSendTypes, Withdraw3Types } from "@nktkas/hyperliquid/api/exchange";
import { signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import { addressOf, hashTypedData, localWallet } from "./hl-wallet.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const wallet = localWallet(KEY);

/** The Python SDK prints r and s as integers, so a leading zero is dropped: compare numerically. */
function sameNumber(actual: string, expected: string): void {
  assert.equal(BigInt(actual), BigInt(expected));
}

test("usdSend: matches the Python SDK's test_sign_usd_transfer_action (testnet)", async () => {
  const action = {
    type: "usdSend",
    signatureChainId: "0x66eee" as const,
    hyperliquidChain: "Testnet",
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
    amount: "1",
    time: 1687816341423,
  };
  const signature = await signUserSignedAction({ wallet, action, types: UsdSendTypes });
  sameNumber(signature.r, "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073");
  sameNumber(signature.s, "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7");
  assert.equal(signature.v, 27);
});

test("withdraw3: matches the Python SDK's test_sign_withdraw_from_bridge_action (testnet)", async () => {
  const action = {
    type: "withdraw3",
    signatureChainId: "0x66eee" as const,
    hyperliquidChain: "Testnet",
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
    amount: "1",
    time: 1687816341423,
  };
  const signature = await signUserSignedAction({ wallet, action, types: Withdraw3Types });
  sameNumber(signature.r, "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9");
  sameNumber(signature.s, "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881");
  assert.equal(signature.v, 28);
});

test("L1 action (the bytes32 Agent struct): matches test_l1_action_signing_matches on both networks", async () => {
  const action = { type: "dummy", num: 100_000_000_000 }; // float_to_int_for_hashing(1000)
  const mainnet = await signL1Action({ wallet, action, nonce: 0, isTestnet: false });
  sameNumber(mainnet.r, "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298");
  sameNumber(mainnet.s, "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8");
  assert.equal(mainnet.v, 27);

  const testnet = await signL1Action({ wallet, action, nonce: 0, isTestnet: true });
  sameNumber(testnet.r, "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510");
  sameNumber(testnet.s, "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613");
  assert.equal(testnet.v, 28);
});

test("the wallet's address is the one its signatures recover to", async () => {
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { "HyperliquidTransaction:UsdSend": UsdSendTypes["HyperliquidTransaction:UsdSend"] },
    primaryType: "HyperliquidTransaction:UsdSend",
    message: { hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 },
  };
  const rsv = hexToBytes((await wallet.signTypedData(typed)).slice(2));
  const recovered = secp256k1.recoverPublicKey(
    Uint8Array.of((rsv[64] ?? 27) - 27, ...rsv.slice(0, 64)),
    hashTypedData(typed),
    { prehash: false },
  );
  assert.equal(addressOf(secp256k1.Point.fromBytes(recovered).toBytes(false)), wallet.address);
  assert.match(wallet.address, /^0x[0-9a-f]{40}$/);
});

test("a key of the wrong length is refused", () => {
  assert.throws(() => localWallet("0x1234"), /32 bytes/);
});
