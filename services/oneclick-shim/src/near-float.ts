// The shim's NEAR testnet float: it reads deposit addresses and sends test tokens.
// The deposit addresses are random implicit accounts that nobody holds a key for, so tokens
// sent there stay there; every delivery and refund comes out of the float instead.
import { Account, actions, getTransactionLastResult, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

export interface FtTransfer {
  token: string;
  receiverId: string;
  amount: bigint;
  /** With a msg the transfer is ft_transfer_call (the receiver's ft_on_transfer runs), as 1Click does. */
  msg?: string;
  memo?: string;
}

export interface FtTransferResult {
  txHash: string;
  /** How much the receiver kept. ft_transfer_call returns what ft_on_transfer did not use. */
  usedAmount: bigint;
}

export interface NearFloat {
  readonly accountId: string;
  balanceOf(token: string, accountId: string): Promise<bigint>;
  transfer(transfer: FtTransfer): Promise<FtTransferResult>;
  /**
   * Stage 4: the test token's own faucet mints `amount` to the float (contracts/testnet/token: `mint(account_id,
   * amount)` is open to anyone and has no limit). The float delivers mNBTC on the way home from Aave's chain, and
   * nothing ever pays it mNBTC: deposits on NEAR stay at their deposit addresses. Section 49: the same for every
   * NEAR test token it delivers or refunds (test ETH, wNEAR and USDT too).
   */
  mint?(token: string, amount: bigint): Promise<{ txHash: string }>;
}

export function nearFloat(rpcUrl: string, accountId: string, privateKey: string): NearFloat {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(accountId, provider, privateKey as KeyPairString);

  return {
    accountId,

    async balanceOf(token, holder) {
      const balance = await provider.callFunction<string>({
        contractId: token,
        method: "ft_balance_of",
        args: { account_id: holder },
      });
      return BigInt(balance ?? "0");
    },

    async transfer({ token, receiverId, amount, msg, memo }) {
      // NEP-141 transfers need exactly 1 yoctoNEAR. ft_transfer_call needs gas for the receiver too.
      const action =
        msg === undefined
          ? actions.functionCall("ft_transfer", { receiver_id: receiverId, amount: amount.toString(), memo }, teraToGas("30"), 1n)
          : actions.functionCall(
              "ft_transfer_call",
              { receiver_id: receiverId, amount: amount.toString(), msg, memo },
              teraToGas("100"),
              1n,
            );
      const result = await account.signAndSendTransaction({ receiverId: token, actions: [action] });
      const used = msg === undefined ? amount : BigInt(String(getTransactionLastResult(result) ?? "0"));
      return { txHash: result.transaction.hash, usedAmount: used };
    },

    async mint(token, amount) {
      // The float is registered on the test tokens already, so the deposit comes straight back; it is attached in
      // case it isn't (the token asks for its storage_balance_bounds().min, 0.00125 NEAR).
      const action = actions.functionCall("mint", { account_id: accountId, amount: amount.toString() }, teraToGas("30"), 1_250_000_000_000_000_000_000n);
      const result = await account.signAndSendTransaction({ receiverId: token, actions: [action] });
      return { txHash: result.transaction.hash };
    },
  };
}
