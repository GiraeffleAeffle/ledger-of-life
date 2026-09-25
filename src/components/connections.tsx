'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleHelp, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';
import { WalletAccessPanel, useRentalWallet } from '@/wallets';
import { Badge, PageHeading } from './workspace-panels';
import type { connectionStatus } from '@/server/configuration';
import { ConnectedAgreements } from './connected-agreements';
import { recoveryInstructions, useRecovery, type AuthorizedRequest } from './use-recovery';
import { NativeRobinhood } from './native-robinhood';
import { NativeSolana } from './native-solana';
import { SolanaInitializationPanel } from './solana-initialization';
import { MarketPrices } from './market-prices';

type Status = ReturnType<typeof connectionStatus> & { storeAvailable: boolean };
export function Connections() {
  const wallet = useRentalWallet();
  const accountScope = JSON.stringify([
    wallet.authenticated ? wallet.subject : null,
    wallet.passkeyCount,
    wallet.backupLoginLinked,
    wallet.wallets.map(({ id, chainType, address }) => [id, chainType, address]).sort(),
  ]);
  // A different account or wallet inventory must not inherit identity or tenancy UI state.
  return <AccountConnections key={accountScope} />;
}
function AccountConnections() {
  const wallet = useRentalWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [requestReady, setRequestReady] = useState(false);
  const requests = useRef<AbortController | null>(null);
  const authorized = useCallback(
    async (path: string, body?: unknown) => {
      const controller = requests.current;
      if (!controller || controller.signal.aborted)
        throw new Error('Account access changed. Check the current account before continuing.');
      const token = await wallet.getAccessToken();
      controller.signal.throwIfAborted();
      if (!token) throw new Error('Sign in before continuing.');
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await response.json();
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(data.error || 'Account verification is unavailable.');
      return data;
    },
    [wallet],
  );
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    fetch('/api/status', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Connection status could not be loaded.');
        return response.json();
      })
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setError('Connection status could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRequestReady(true);
      });
    return () => {
      controller.abort();
      requests.current = null;
    };
  }, []);
  const recovery = useRecovery(authorized as AuthorizedRequest);
  const identity = recovery.identity;
  const disabled = recovery.busy || wallet.busy || !wallet.ready;
  const inspectIdentity = () => !disabled && recovery.inspect();
  const enroll = () => !disabled && recovery.enroll();
  const verifyRecovery = () => !disabled && recovery.verify();
  return (
    <>
      <PageHeading
        eyebrow="FROM DEMONSTRATION TO CONNECTED PROOF"
        title="Know what is connected."
        text="The walkthrough and native finance proofs are separate. This page shows account access and the remaining integration steps."
      />
      {(error || recovery.error) && (
        <div className="notice is-error" role="alert">
          <CircleHelp size={18} />
          {error || recovery.error}
        </div>
      )}
      <WalletAccessPanel recoveryProof={identity?.recoveryProof ?? undefined} />
      {wallet.authenticated && (
        <section className="card operation-section">
          <h2>Verify access to the same wallets</h2>
          <p className="section-copy">
            Record your original wallet identities here. Then sign in with backup access in another
            browser and sign a recovery challenge for each wallet.
          </p>
          <div className="button-row">
            <button className="button secondary" disabled={disabled} onClick={inspectIdentity}>
              <RefreshCw size={16} />
              Check verified account
            </button>
            {identity?.recovery.status === 'needs_baseline' && (
              <button className="button primary" disabled={disabled} onClick={enroll}>
                Record original wallets
              </button>
            )}
            {identity?.recovery.eligibleForChallenge &&
              identity.baseline?.wallets.some(
                (original) => !identity.recovery.verifiedWalletIds.includes(original.id),
              ) && (
                <button className="button primary" disabled={disabled} onClick={verifyRecovery}>
                  Verify same-wallet access <ShieldCheck size={17} />
                </button>
              )}
          </div>
          {identity && (
            <p className="small-copy" role="status">
              {identity.baseline &&
                `Original wallets recorded ${new Date(identity.baseline.enrolledAt).toLocaleString()}. `}
              {recoveryInstructions[identity.recovery.status]}
            </p>
          )}
        </section>
      )}
      {wallet.authenticated && requestReady && <ConnectedAgreements request={authorized} />}
      {wallet.authenticated && requestReady && <SolanaInitializationPanel request={authorized} />}
      <div className="connection-grid">
        <section className="card">
          <span className="eyebrow">SHARED APPLICATION</span>
          <h2>Persistence and account access</h2>
          <ul className="connection-list">
            <StatusItem
              ready={Boolean(status?.storeAvailable)}
              title="Persistent tenancy records"
              detail={
                status?.storeAvailable
                  ? status.persistence === 'postgres'
                    ? 'PostgreSQL is connected.'
                    : 'Local SQLite is available for this computer.'
                  : 'A database connection is needed.'
              }
            />
            <StatusItem
              ready={Boolean(status?.identity)}
              title="Privy passkey provider"
              detail={
                status?.identity
                  ? 'Credentials are configured. Verify login and wallet recovery on each deployment origin before funding.'
                  : wallet.configured
                    ? 'Browser access is configured. Add the server secret to verify accounts for connected finance.'
                    : 'Create a Privy app, add the application origin and configure its credentials.'
              }
            />
            <StatusItem
              ready={Boolean(status?.reconciliation)}
              title="Background reconciliation"
              detail={
                status?.reconciliation
                  ? 'Worker authentication is configured. Check the operator guide for scheduling.'
                  : 'The manual result check works. Schedule the authenticated worker for unattended reconciliation.'
              }
            />
          </ul>
          <a
            className="button secondary"
            href="https://dashboard.privy.io/"
            target="_blank"
            rel="noreferrer"
          >
            Open Privy setup <ArrowUpRight size={16} />
          </a>
        </section>
        <section className="card">
          <span className="eyebrow">EVIDENCE YOU CAN INSPECT</span>
          <h2>Two independent native implementations</h2>
          <ul className="connection-list">
            <StatusItem
              ready
              title="Robinhood: actual Morpho contracts on a local fork"
              detail="Escrow funding, supply, earnings release and settlement pass against pinned mainnet protocol code. Earnings time travel is a local fixture."
            />
            <StatusItem
              ready
              title="Solana: escrow and Kamino integration"
              detail={
                status?.solana.deployment
                  ? 'The local SVM proof passes, and a pinned devnet escrow is configured. Read the connected escrow below for this tenancy’s current state and finalized receipts.'
                  : 'The compiled escrow and actual KLend program pass local SVM funding, lending, release and settlement checks. A deployed test escrow remains to be configured.'
              }
            />
            <StatusItem
              ready={false}
              title="Personal investment orders"
              detail="Jupiter and 0x adapters validate routes and keep raw holdings distinct from accumulated exposure. Real orders need provider access and a verified eligible non-US profile."
            />
          </ul>
          <Badge tone="neutral">A local proof is not a production deployment</Badge>
        </section>
      </div>
      <div className="connection-grid">
        <section className="card">
          <span className="eyebrow">ROBINHOOD CHAIN</span>
          <h2>USDG → Morpho → personal holdings</h2>
          <p className="section-copy">
            A restricted escrow fixes the tenancy parties and spending rules. Signed instructions
            can be relayed without giving the sponsor access to funds.
          </p>
          <ul className="connection-list">
            <StatusItem
              ready={Boolean(status?.robinhood.escrow)}
              title="Application escrow"
              detail={
                status?.robinhood.escrow
                  ? 'A deployment address is configured; verify its identity before authorization.'
                  : 'No application deployment is configured.'
              }
            />
            <StatusItem
              ready={Boolean(status?.robinhood.sponsor)}
              title="Bounded transaction sponsor"
              detail="A sponsor pays network fees only. Initial USDG approval still needs a proven sponsorship route."
            />
            <StatusItem
              ready={Boolean(status?.robinhood.trading)}
              title="Stock-token route access"
              detail="0x RWA access and instrument eligibility must be granted before an executable order."
            />
          </ul>
          <a
            className="text-button"
            href="https://dashboard.0x.org/"
            target="_blank"
            rel="noreferrer"
          >
            0x developer access <ArrowUpRight size={15} />
          </a>
        </section>
        <section className="card">
          <span className="eyebrow">SOLANA</span>
          <h2>USDC → Kamino → personal holdings</h2>
          <p className="section-copy">
            A tenancy PDA holds security. The tenant’s separate wallet holds personal cash and
            investments; a fee sponsor has no spending authority.
          </p>
          <ul className="connection-list">
            <StatusItem
              ready={Boolean(status?.solana.deployment)}
              title="Verified test deployment"
              detail="A manifest must pin the program, cluster, reserve and token accounts. Devnet does not provide an issuer SPYx market."
            />
            <StatusItem
              ready={Boolean(status?.solana.sponsor)}
              title="Separate fee payer"
              detail="The complete signed message and simulation are checked before a sponsor may add its signature."
            />
            <StatusItem
              ready={Boolean(status?.solana.trading)}
              title="Jupiter route access"
              detail="Price-only quotes work without a key. Transaction builds require configured access, an eligible instrument and a reviewed route."
            />
          </ul>
          <a
            className="text-button"
            href="https://developers.jup.ag/portal"
            target="_blank"
            rel="noreferrer"
          >
            Jupiter developer access <ArrowUpRight size={15} />
          </a>
        </section>
      </div>
      <MarketPrices />
      {wallet.authenticated && (
        <>
          <NativeRobinhood request={authorized} />
          <NativeSolana request={authorized} />
        </>
      )}
    </>
  );
}
function StatusItem({ ready, title, detail }: { ready: boolean; title: string; detail: string }) {
  return (
    <li>
      {ready ? <Check size={18} /> : <Clock3 size={18} />}
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </li>
  );
}
