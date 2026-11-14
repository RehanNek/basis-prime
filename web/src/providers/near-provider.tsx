import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FailoverRpcProvider, getTransactionLastResult, JsonRpcProvider } from 'near-api-js';
import { NearConnector, type EventMap, type NearConnectorOptions } from '@hot-labs/near-connect';
import { createAccessKeyPlugin } from 'function-call-key-plugin';

import { NetworkId } from '@/config';
import { connectorActions, type Outcome, type Tx } from '@/lib/tx';

type ViewFunctionParams = {
  contractId: string;
  method: string;
  args?: Record<string, unknown>;
};

type CallFunctionParams = ViewFunctionParams & {
  gas?: string;
  deposit?: string;
};

/** What a NEP-413 signature is asked for: the exact message, who it is for, and 32 random bytes. */
export type SignMessageInput = { message: string; recipient: string; nonce: Uint8Array };

/**
 * near-connect 0.11.4's answer (build/types/index.d.ts, SignedMessage). Meteor Wallet's executor fills it as
 * {accountId, publicKey: "ed25519:<base58>", signature: <base64 of the 64 bytes>} (meteor_wallet_sdk,
 * packages/meteor-near-connect/src/meteor-near-connect/nearConnectExecutor.ts). lib/gateway.ts accepts other
 * encodings too, since each wallet writes its own executor.
 */
export type SignedMessageOutput = { accountId: string; publicKey: string; signature: string };

export type NearContextValue = {
  loading: boolean;
  signedAccountId: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  viewFunction: (params: ViewFunctionParams) => Promise<unknown>;
  callFunction: (params: CallFunctionParams) => Promise<unknown>;
  /** Signs and sends one transaction built in lib/tx.ts with the wallet, and returns its outcome. */
  sendTx: (tx: Tx) => Promise<Outcome>;
  /**
   * Several transactions: in one wallet approval when the wallet can sign a batch, else one after another. Only for
   * transactions that don't depend on each other, since a wallet may send a batch in any order.
   */
  sendTxs: (txs: Tx[]) => Promise<Outcome[]>;
  /** Has the wallet sign a NEP-413 message (an order for pb-gateway). Nothing is sent to the chain. */
  signMessage: (input: SignMessageInput) => Promise<SignedMessageOutput>;
};

/** Exported so tests and previews can supply a wallet of their own. */
export const NearContext = createContext<NearContextValue | undefined>(undefined);

const connectorOptions: NearConnectorOptions = {
  network: NetworkId,
  providers: {
    mainnet: ['https://free.rpc.fastnear.com'],
    // FastNEAR's free testnet endpoint first, as since Phase 2, and dRPC's free one behind it (both from
    // docs.near.org/api/rpc/providers). On 13 Nov FastNEAR answered 429 "Rate limits exceeded" for this machine while
    // the wallet, the backend and the keeper all used it.
    testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'],
  },
};

export function NearProvider({ children }: PropsWithChildren) {
  const connector = useMemo(() => new NearConnector(connectorOptions), []);
  // The template's plugin stays registered, but sign-in asks for no function-call key: every owner
  // action on our contracts attaches a deposit (at least 1 yoctoNEAR), which such a key can't do,
  // so the wallet signs each one.
  const accessKeyPlugin = useMemo(
    () => createAccessKeyPlugin({ network: connector.network, providers: connector.providers }),
    [connector],
  );
  const provider = useMemo(
    () => {
      const rpcUrls: string[] =
        NetworkId === 'mainnet' ? connector.providers.mainnet ?? [] : connector.providers.testnet ?? [];
      return new FailoverRpcProvider(rpcUrls.map((url) => new JsonRpcProvider({ url })));
    },
    [connector],
  );

  const [wallet, setWallet] = useState<Awaited<ReturnType<NearConnector['wallet']>> | undefined>();
  const [signedAccountId, setSignedAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const pluginReady = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      pluginReady.current ??= connector.use(accessKeyPlugin);
      await pluginReady.current;

      const connectedWallet = await connector.getConnectedWallet().catch(() => null);
      if (!cancelled && connectedWallet) {
        setWallet(connectedWallet.wallet);
        setSignedAccountId(connectedWallet.accounts[0]?.accountId ?? '');
      }
      if (cancelled) return undefined;

      const handleSignIn = (payload: EventMap['wallet:signIn']) => {
        if (!cancelled) {
          setWallet(payload.wallet);
          setSignedAccountId(payload.accounts[0]?.accountId ?? '');
        }
      };
      const handleSignOut = () => {
        if (!cancelled) {
          setWallet(undefined);
          setSignedAccountId('');
        }
      };

      connector.on('wallet:signIn', handleSignIn);
      connector.on('wallet:signOut', handleSignOut);

      if (!cancelled) {
        setLoading(false);
      }

      return () => {
        connector.off('wallet:signIn', handleSignIn);
        connector.off('wallet:signOut', handleSignOut);
      };
    };

    let cleanup: (() => void) | undefined;
    void initialize().then((removeListeners) => {
      if (cancelled) removeListeners?.();
      else cleanup = removeListeners;
    }).catch((error) => {
      console.error('Unable to initialize wallet', error);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [accessKeyPlugin, connector]);

  const signIn = useCallback(async () => {
    const connectedWallet = await connector.connect();
    setWallet(connectedWallet);
    const accounts = await connectedWallet.getAccounts();
    setSignedAccountId(accounts[0]?.accountId ?? '');
  }, [connector]);

  const signOut = useCallback(async () => {
    if (!wallet) return;
    await connector.disconnect(wallet);
    setWallet(undefined);
    setSignedAccountId('');
  }, [connector, wallet]);

  const viewFunction = useCallback(
    ({ contractId, method, args = {} }: ViewFunctionParams) =>
      provider.callFunction({ contractId, method, args }),
    [provider],
  );

  const callFunction = useCallback(
    async ({ contractId, method, args = {}, gas = '30000000000000', deposit = '0' }: CallFunctionParams) => {
      if (!wallet) throw new Error('Wallet is not connected');

      const result = await wallet.signAndSendTransaction({
        receiverId: contractId,
        actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas, deposit } }],
      });
      return getTransactionLastResult(result);
    },
    [wallet],
  );

  const sendTx = useCallback(
    async (tx: Tx): Promise<Outcome> => {
      if (!wallet) throw new Error('Wallet is not connected');
      return wallet.signAndSendTransaction({ receiverId: tx.receiverId, actions: connectorActions(tx) });
    },
    [wallet],
  );

  const sendTxs = useCallback(
    async (txs: Tx[]): Promise<Outcome[]> => {
      if (!wallet) throw new Error('Wallet is not connected');
      if (txs.length > 1 && wallet.manifest?.features?.signAndSendTransactions) {
        return wallet.signAndSendTransactions({
          transactions: txs.map((tx) => ({ receiverId: tx.receiverId, actions: connectorActions(tx) })),
        });
      }
      const outcomes: Outcome[] = [];
      for (const tx of txs) outcomes.push(await wallet.signAndSendTransaction({ receiverId: tx.receiverId, actions: connectorActions(tx) }));
      return outcomes;
    },
    [wallet],
  );

  // near-connect passes these straight to the wallet's executor in its sandbox (SandboxedWallet/index.js,
  // "wallet:signMessage"), adding the network. The access-key plugin leaves signMessage alone, so the wallet's
  // own full-access key signs, which is what the gateway requires.
  const signMessage = useCallback(
    async ({ message, recipient, nonce }: SignMessageInput): Promise<SignedMessageOutput> => {
      if (!wallet) throw new Error('Wallet is not connected');
      if (wallet.manifest?.features && !wallet.manifest.features.signMessage) {
        throw new Error(`${wallet.manifest.name} can't sign messages; sign in with a wallet that can, such as Meteor`);
      }
      return wallet.signMessage({ message, recipient, nonce, network: NetworkId });
    },
    [wallet],
  );

  const value = useMemo(
    () => ({ loading, signedAccountId, signIn, signOut, viewFunction, callFunction, sendTx, sendTxs, signMessage }),
    [callFunction, loading, sendTx, sendTxs, signIn, signMessage, signOut, signedAccountId, viewFunction],
  );

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}

export function useNearWallet() {
  const context = useContext(NearContext);
  if (!context) throw new Error('useNearWallet must be used within NearProvider');
  return context;
}
