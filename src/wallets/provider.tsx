'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PrivyProvider,
  useCreateWallet,
  useLinkWithPasskey,
  useLoginWithPasskey,
  usePrivy,
  useSignTransaction,
  useSignTypedData,
  useSignupWithPasskey,
  useUnlinkEmail,
  useWallets,
} from '@privy-io/react-auth';
import {
  useCreateWallet as useCreateSolanaWallet,
  useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { StyleSheetManager } from 'styled-components';
import { defineChain } from 'viem';
import {
  assertUnchangedSolanaMessage,
  privyTransaction,
  validateEvmSigningRequest,
  validateSolanaSigningRequest,
} from './signing-policy.ts';
import type { RentalWallet, RentalWalletAccess } from './types.ts';
import { prepareEscrowTypedData } from './escrow-signing.ts';
import { prepareInferencePayment } from './inference-signing.ts';

const DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const SHOW_WALLET_UIS = true;

const unavailable = async (): Promise<never> => {
  throw new Error('Account access is not configured yet.');
};

/** A distinct label per account in the device's passkey chooser, independent of tenancy roles. */
function passkeyLabel() {
  const stamp = new Date().toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Ledger of Life · ${stamp}`;
}

/**
 * Privy's sign-up sets the WebAuthn user name/displayName server-side (the app name). Those fields are
 * display labels only (not part of the signed attestation), so relabel them for this one creation.
 */
async function withPasskeyLabel<T>(label: string, work: () => Promise<T>): Promise<T> {
  const credentials = typeof navigator === 'undefined' ? undefined : navigator.credentials;
  if (!credentials?.create) return work();
  const original = credentials.create.bind(credentials);
  credentials.create = (options?: CredentialCreationOptions) => {
    const user = options?.publicKey?.user;
    if (user) {
      user.name = label;
      user.displayName = label;
    }
    return original(options);
  };
  try {
    return await work();
  } finally {
    credentials.create = original;
  }
}

function walletActionError(cause: unknown, action: 'passkey' | 'wallet') {
  const name = cause instanceof Error ? cause.name : '';
  const rawCode =
    cause && typeof cause === 'object' && 'privyErrorCode' in cause
      ? cause.privyErrorCode
      : undefined;
  const code =
    typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(rawCode) ? rawCode : undefined;
  if (name === 'NotAllowedError' || code === 'passkey_not_allowed')
    return action === 'passkey'
      ? 'Request cancelled. You can try again.'
      : 'Request cancelled. You can try again.';
  if (action === 'passkey') {
    if (code === 'disallowed_login_method')
      return 'Passkey sign-up is disabled in the Privy app settings. Ask the app operator to enable it.';
    if (name === 'SecurityError' || name === 'NotSupportedError' || code === 'not_supported')
      return `This browser or address cannot create a passkey. Open ${typeof window !== 'undefined' ? window.location.origin : 'this web address'} in a supported browser.`;
    if (code === 'client_request_timeout')
      return 'The passkey service timed out. Check your connection and try again.';
    return `Passkey setup did not complete${code ? ` (${code})` : ''}. Open ${typeof window !== 'undefined' ? window.location.origin : 'this web address'} in a supported browser and try again.`;
  }
  return 'The wallet request was not completed. Check your connection and try again.';
}

const inactiveAccess: RentalWalletAccess = {
  configured: false,
  ready: true,
  authenticated: false,
  subject: null,
  wallets: [],
  passkeyCount: 0,
  hasLinkedEmail: false,
  busy: false,
  error: null,
  loginWithPasskey: unavailable,
  signupWithPasskey: unavailable,
  addPasskey: unavailable,
  removeEmail: unavailable,
  createMissingWallets: unavailable,
  logout: async () => undefined,
  getAccessToken: async () => null,
  signEvmTransaction: unavailable,
  signSolanaTransaction: unavailable,
  signEvmTypedData: unavailable,
  signInferencePayment: unavailable,
};

const WalletContext = createContext<RentalWalletAccess>(inactiveAccess);

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});
const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  testnet: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  // Optional: a Privy app client carries its own allowed origins, so the hosted build and local development can share
  // one app (and its users) while each is restricted to its own domain.
  const clientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim() || undefined;
  if (!appId)
    return <WalletContext.Provider value={inactiveAccess}>{children}</WalletContext.Provider>;

  return (
    <StyleSheetManager
      shouldForwardProp={(prop, target) => !(prop === 'stacked' && typeof target === 'string')}
    >
      <PrivyProvider
        appId={appId}
        clientId={clientId}
        config={{
          loginMethods: ['passkey'],
          appearance: {
            theme: 'light',
            accentColor: '#245B4A',
            walletChainType: 'ethereum-and-solana',
          },
          defaultChain: robinhoodTestnet,
          supportedChains: [robinhoodTestnet, robinhood],
          embeddedWallets: {
            ethereum: { createOnLogin: 'off' },
            solana: { createOnLogin: 'off' },
            showWalletUIs: SHOW_WALLET_UIS,
          },
          solana: {
            rpcs: {
              'solana:mainnet': {
                rpc: createSolanaRpc('https://api.mainnet-beta.solana.com'),
                rpcSubscriptions: createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com'),
              },
              'solana:devnet': {
                rpc: createSolanaRpc(DEVNET_RPC),
                rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_RPC.replace(/^http/, 'ws')),
              },
            },
          },
        }}
      >
        <ActiveWalletAccess>{children}</ActiveWalletAccess>
      </PrivyProvider>
    </StyleSheetManager>
  );
}

function ActiveWalletAccess({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const evm = useWallets();
  const solana = useSolanaWallets();
  const { createWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();
  const { signTransaction } = useSignTransaction();
  const { signTransaction: signSolanaTransaction } = useSignSolanaTransaction();
  const { signTypedData } = useSignTypedData();
  const { loginWithPasskey } = useLoginWithPasskey();
  const { signupWithPasskey } = useSignupWithPasskey();
  const { unlink: unlinkEmail } = useUnlinkEmail();
  const { linkWithPasskey } = useLinkWithPasskey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // A non-secret rendering hint only; every API still requires authorization.
  useEffect(() => {
    if (!ready) return;
    document.cookie = authenticated
      ? 'ledger-session=1; Path=/; SameSite=Lax; Max-Age=31536000'
      : 'ledger-session=; Path=/; SameSite=Lax; Max-Age=0';
  }, [ready, authenticated]);

  const linkedAccounts = authenticated ? (user?.linkedAccounts ?? []) : [];
  const passkeyCount = linkedAccounts.filter((account) => account.type === 'passkey').length;
  const linkedEmail = linkedAccounts.find((account) => account.type === 'email')?.address ?? null;
  const wallets: RentalWallet[] = [];
  for (const account of linkedAccounts) {
    if (
      account.type !== 'wallet' ||
      !account.id ||
      !['privy', 'privy-v2'].includes(account.walletClientType ?? '') ||
      account.connectorType !== 'embedded' ||
      account.delegated ||
      account.imported ||
      (account.chainType !== 'ethereum' && account.chainType !== 'solana')
    )
      continue;
    const connected =
      account.chainType === 'solana'
        ? solana.wallets.some((wallet) => wallet.address === account.address)
        : evm.wallets.some(
            (wallet) =>
              ['privy', 'privy-v2'].includes(wallet.walletClientType) &&
              wallet.address.toLowerCase() === account.address.toLowerCase(),
          );
    wallets.push({
      id: account.id,
      address: account.address,
      chainType: account.chainType,
      connected,
    });
  }

  async function runAction<T>(
    action: () => Promise<T>,
    kind: 'passkey' | 'wallet' = 'wallet',
  ): Promise<T> {
    if (inFlight.current) throw new Error('Finish the current wallet request first.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(walletActionError(cause, kind));
      throw cause;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function requireSession() {
    if (!ready || !authenticated || !user) throw new Error('Sign in before using your wallet.');
  }

  const value: RentalWalletAccess = {
    configured: true,
    // Account setup must remain available before either wallet connector exists.
    ready,
    authenticated,
    subject: authenticated ? (user?.id ?? null) : null,
    wallets,
    passkeyCount,
    hasLinkedEmail: linkedEmail !== null,
    busy,
    error,
    loginWithPasskey: () => runAction(() => loginWithPasskey(), 'passkey'),
    signupWithPasskey: () => runAction(() => withPasskeyLabel(passkeyLabel(), () => signupWithPasskey()), 'passkey'),
    addPasskey: () =>
      runAction(async () => {
        requireSession();
        const label = passkeyLabel();
        await withPasskeyLabel(label, () => linkWithPasskey({ name: label }));
      }, 'passkey'),
    removeEmail: () => runAction(async () => {
      requireSession();
      if (passkeyCount < 1) throw new Error('Keep at least one passkey before removing your email.');
      if (linkedEmail) await unlinkEmail({ address: linkedEmail });
    }),
    createMissingWallets: () =>
      runAction(async () => {
        requireSession();
        if (passkeyCount === 0) throw new Error('Add a passkey before creating wallets.');
        // Direct passkey hooks do not run Privy's automatic wallet creation.
        // Existing linked wallets, including unsupported legacy ones, are never replaced.
        const hasWallet = (chain: string) =>
          linkedAccounts.some(
            (account) =>
              account.type === 'wallet' &&
              account.chainType === chain &&
              ['privy', 'privy-v2'].includes(account.walletClientType ?? ''),
          );
        if (!hasWallet('ethereum')) await createWallet();
        if (!hasWallet('solana')) await createSolanaWallet();
      }),
    logout: () => runAction(() => logout()),
    getAccessToken,
    signEvmTransaction: (request) =>
      runAction(async () => {
        requireSession();
        const transaction = privyTransaction(structuredClone(request.transaction));
        const wallet = validateEvmSigningRequest(
          { ...request, transaction },
          wallets.find((item) => item.id === request.walletId),
        );
        const result = await signTransaction(
          { ...transaction, from: wallet.address },
          {
            address: wallet.address,
            uiOptions: {
              showWalletUIs: SHOW_WALLET_UIS,
              isCancellable: true,
              description: request.description,
              buttonText: 'Authorize signature',
            },
          },
        );
        return result.signature;
      }),
    signSolanaTransaction: (request) =>
      runAction(async () => {
        requireSession();
        const transaction = request.transaction.slice();
        const reviewed = validateSolanaSigningRequest(
          { ...request, transaction },
          wallets.find((item) => item.id === request.walletId),
        );
        const reviewedMessage = new Uint8Array(reviewed.messageBytes);
        const wallet = solana.wallets.find((item) => item.address === reviewed.wallet.address);
        if (!wallet) throw new Error('Your Solana wallet is not available.');
        const { signedTransaction } = await signSolanaTransaction({
          transaction,
          chain: request.chain,
          wallet,
          options: {
            uiOptions: {
              showWalletUIs: SHOW_WALLET_UIS,
              isCancellable: true,
              description: request.description,
              buttonText: 'Authorize signature',
            },
          },
        });
        assertUnchangedSolanaMessage(reviewedMessage, signedTransaction);
        return signedTransaction;
      }),
    signEvmTypedData: (request) =>
      runAction(async () => {
        requireSession();
        const wallet = wallets.find((item) => item.id === request.walletId);
        const typedData = prepareEscrowTypedData(request, wallet);
        const { signature } = await signTypedData(typedData, {
          address: wallet!.address,
          uiOptions: {
            showWalletUIs: SHOW_WALLET_UIS,
            isCancellable: true,
            title: 'Authorize this rental action',
            description: request.description,
            buttonText: 'Authorize rental action',
          },
        });
        return signature;
      }),
    signInferencePayment: (request) =>
      runAction(async () => {
        requireSession();
        const typedData = prepareInferencePayment(request, wallets.find((wallet) => wallet.id === request.walletId));
        const { signature } = await signTypedData(typedData, {
          address: wallets.find((wallet) => wallet.id === request.walletId)!.address,
          uiOptions: {
            showWalletUIs: SHOW_WALLET_UIS, isCancellable: true,
            title: 'Authorize one local AI answer',
            description: `Pay per token: 0.0001 tUSDG per generated token, at most ${Number(BigInt(request.amountAtomic)) / 1e6} tUSDG for this answer`,
            buttonText: 'Authorize per-token payment',
          },
        });
        return signature as `0x${string}`;
      }),
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useRentalWallet() {
  return useContext(WalletContext);
}
