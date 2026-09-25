'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { SolanaInitialization } from '@/server/solana-initialization';
import type { SolanaSnapshot } from '@/server/solana-rpc';
import { Badge, money } from './workspace-panels';

type Role = 'tenant' | 'landlord' | 'arbitrator';
type Initialization = Omit<SolanaInitialization, 'signatures' | 'signedTxBase64'> & {
  signedRoles: ('tenant' | 'landlord')[];
  role: Role;
  walletId: string;
  feePayer: string;
  cluster: 'devnet' | 'localnet';
  walletChain: 'solana:devnet' | null;
};
type Setup = {
  available: true;
  agreementId: string;
  tenancyAddress: string;
  role: Role;
  walletId: string;
  feePayer: string;
  cluster: 'devnet' | 'localnet';
  setupMode: 'joint' | 'staged';
  walletChain: 'solana:devnet' | null;
  initialization: Initialization | null;
};
export function SolanaInitializationPanel({
  request,
}: {
  request: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const wallet = useRentalWallet();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [tenancyPhase, setTenancyPhase] = useState<SolanaSnapshot['tenancy']['phase'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const initialRequest = useRef(request);
  const initialization = setup?.initialization;
  const role = setup?.role;
  const signed = Boolean(role && initialization?.signedRoles.includes(role as 'tenant' | 'landlord'));
  const signingWallet = wallet.wallets.find((item) => item.id === setup?.walletId);
  const walletConnected = signingWallet?.chainType === 'solana' && signingWallet.connected;
  const awaitingSignature =
    initialization?.state === 'prepared' &&
    (setup?.setupMode === 'staged' ? role === 'landlord' : role !== 'arbitrator') &&
    !signed;
  useEffect(() => {
    if (!wallet.ready) return;
    let active = true;
    void initialRequest.current('/api/finance/solana/initialize')
      .then((result) => { if (active) setSetup(result as Setup); })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : 'Tenancy setup is unavailable.');
      });
    return () => { active = false; };
  }, [wallet.ready]);
  useEffect(() => {
    if (setup?.setupMode !== 'staged' || setup.initialization?.state !== 'finalized') return;
    let active = true;
    const readPhase = () => {
      void initialRequest.current('/api/finance/solana')
        .then((result) => {
          if (active) setTenancyPhase((result as SolanaSnapshot).tenancy.phase);
        })
        .catch(() => {
          if (active) setTenancyPhase(null);
        });
    };
    readPhase();
    window.addEventListener('solana-tenancy-updated', readPhase);
    window.addEventListener('focus', readPhase);
    return () => {
      active = false;
      window.removeEventListener('solana-tenancy-updated', readPhase);
      window.removeEventListener('focus', readPhase);
    };
  }, [setup?.setupMode, setup?.initialization?.state]);
  useEffect(() => {
    if (setup?.setupMode !== 'staged' ||
        !setup.initialization?.signature ||
        !['signed', 'broadcast'].includes(setup.initialization.state)) return;
    const timer = window.setTimeout(() => {
      void initialRequest.current('/api/finance/solana/initialize', { action: 'reconcile' })
        .then((result) => setSetup((current) => current && {
          ...current,
          initialization: (result as { initialization: Initialization }).initialization,
        }))
        .catch((error) => setMessage(error instanceof Error ? error.message : 'Setup confirmation is pending.'));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [setup?.setupMode, setup?.initialization?.state, setup?.initialization?.signature]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Solana setup is unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = (await request('/api/finance/solana/initialize')) as Setup;
    setSetup(result);
    if (result.setupMode === 'staged' && result.initialization?.state === 'finalized') {
      const snapshot = (await request('/api/finance/solana')) as SolanaSnapshot;
      setTenancyPhase(snapshot.tenancy.phase);
    } else setTenancyPhase(null);
  }
  async function change(action: 'prepare' | 'reconcile' | 'retry', notice: string) {
    const result = (await request('/api/finance/solana/initialize', { action })) as {
      initialization: Initialization;
    };
    setSetup((current) => current && { ...current, initialization: result.initialization });
    setMessage(
      action === 'prepare' && result.initialization.state !== 'prepared'
        ? 'The previous signed transaction is still being checked. No new signing window opened.'
        : notice,
    );
  }
  async function sign(plan: Initialization | null = initialization ?? null) {
    if (!plan || !setup?.walletChain ||
        (setup.setupMode === 'staged' ? role !== 'landlord' : !awaitingSignature))
      throw new Error('Refresh the current initialization before signing.');
    if (!walletConnected)
      throw new Error('This Solana wallet is linked but not connected in this browser. Use a browser where Wallet and control details says Ready to request your signature.');
    if (Date.parse(plan.expiresAt) <= Date.now())
      throw new Error(setup.setupMode === 'staged'
        ? 'This review expired. Choose Create deposit space again.'
        : 'The signing window expired. Prepare a fresh one with both parties ready.');
    const transaction = Uint8Array.from(atob(plan.transactionBase64), (item) =>
      item.charCodeAt(0),
    );
    const signedBytes = await wallet.signSolanaTransaction({
      operationId: `initialize:${plan.agreementId}`,
      walletId: setup.walletId,
      chain: setup.walletChain,
      feePayer: setup.feePayer,
      expiresAt: plan.expiresAt,
      transaction,
      description: setup.setupMode === 'staged'
        ? `Create an empty rental deposit space for ${money(plan.requiredSecurityAtomic)} test USDC. This fixes the parties and terms but does not move the tenant's funds.`
        : `Initialize the ${money(plan.requiredSecurityAtomic)} test-USDC rental security for agreement ${plan.agreementId}. This does not fund it.`,
    });
    const signedTxBase64 = btoa(
      Array.from(signedBytes, (byte) => String.fromCharCode(byte)).join(''),
    );
    const result = (await request('/api/finance/solana/initialize', {
      action: 'sign',
      signedTxBase64,
    })) as { initialization: Initialization };
    setSetup((current) => current && { ...current, initialization: result.initialization });
    setMessage(setup.setupMode === 'staged'
      ? 'Your setup was submitted. We will confirm the empty deposit space before the tenant can fund it.'
      : result.initialization.state === 'prepared'
        ? 'Your signature is recorded. The other party must review and sign these same bytes before expiry.'
        : 'Both parties signed. The fee sponsor submitted the exact initialization transaction.',
    );
  }
  async function createDepositSpace() {
    if (!setup || setup.setupMode !== 'staged' || setup.role !== 'landlord')
      throw new Error('Only the landlord can create the empty deposit space.');
    if (!walletConnected)
      throw new Error('Connect your Solana wallet in this browser before creating the deposit space.');
    const result = (await request('/api/finance/solana/initialize', { action: 'prepare' })) as {
      initialization: Initialization;
    };
    setSetup((current) => current && { ...current, initialization: result.initialization });
    if (result.initialization.state === 'prepared') await sign(result.initialization);
    else setMessage('The previous setup is being checked. Refresh its result before trying again.');
  }
  if (setup?.setupMode === 'staged') {
    const ready = initialization?.state === 'finalized';
    const pending = Boolean(initialization?.signature &&
      ['signed', 'broadcast', 'unknown'].includes(initialization.state));
    const canResume = initialization?.state === 'unknown';
    return (
      <section className="card operation-section" id="solana-setup">
        <div className="section-heading">
          <h2>Rental deposit setup</h2>
          <Badge tone={ready ? 'green' : 'neutral'}>{ready ? 'Deposit space ready' : 'Next step'}</Badge>
        </div>
        <p className="section-copy">
          {ready
            ? tenancyPhase === 'awaiting-funding'
              ? 'The agreed terms are fixed on devnet. The deposit space holds no security until the tenant funds it.'
              : tenancyPhase === 'closed'
                ? 'Setup was completed, and the on-chain tenancy is now closed. See the connected escrow for its final result.'
                : tenancyPhase
                  ? `Setup was completed. The on-chain tenancy is now ${tenancyPhase.replaceAll('-', ' ')}; funding is no longer the next step.`
                  : 'Setup was completed. Checking the current on-chain tenancy phase before showing a next action.'
            : role === 'landlord'
              ? 'Create the empty deposit space for the agreed terms. The tenant can add the security later, on their own time.'
              : role === 'tenant'
                ? 'The landlord prepares the empty deposit space. You will review its terms before depositing your test USDC.'
                : 'The landlord prepares the empty deposit space; the tenant chooses when to fund it.'}
        </p>
        {initialization && (
          <p className="note">
            Required security: <strong>{money(initialization.requiredSecurityAtomic)} test USDC</strong>.
            {ready ? ' Setup is confirmed; see the connected escrow for current security.' : ' No security has been deposited by this setup.'}
          </p>
        )}
        <div className="button-row">
          {role === 'landlord' && ((!ready && !pending) || canResume) && (
            <button className="button primary" disabled={busy || !walletConnected} onClick={() => run(createDepositSpace)}>
              <ShieldCheck size={16} /> {canResume ? 'Resume deposit setup' : 'Create deposit space'}
            </button>
          )}
          {pending && (
            <button className="button secondary" disabled={busy} onClick={() => run(() => change('reconcile', 'Checked the latest on-chain result.'))}>
              <RefreshCw size={16} /> Check setup status
            </button>
          )}
          <button className="button secondary" disabled={busy} onClick={() => run(refresh)}>
            <RefreshCw size={16} /> Refresh
          </button>
          {ready && tenancyPhase === 'awaiting-funding' && role === 'tenant' && (
            <a className="button primary" href="#connected-solana-escrow">Review and fund deposit</a>
          )}
        </div>
        {role === 'landlord' && !ready && !walletConnected && (
          <p className="note" role="status">Connect the Solana wallet linked to this agreement to continue.</p>
        )}
        {message && <p className="note" role="status">{message}</p>}
        {initialization?.lastError && <p className="note">{initialization.lastError}</p>}
        <details className="operation-section">
          <summary>Technical proof</summary>
          <dl className="detail-list">
            <div><dt>Agreement</dt><dd className="mono">{setup.agreementId}</dd></div>
            <div><dt>Network</dt><dd>{setup.cluster}</dd></div>
            <div><dt>Escrow</dt><dd className="mono">{setup.tenancyAddress}</dd></div>
            <div><dt>Setup state</dt><dd>{initialization?.state ?? 'Not created'}</dd></div>
            {initialization?.signature && <div><dt>Transaction</dt><dd className="mono">{initialization.signature}</dd></div>}
          </dl>
        </details>
      </section>
    );
  }
  return (
    <section className="card operation-section" id="solana-setup">
      <div className="section-heading">
        <h2>Initialize the Solana tenancy</h2>
        <Badge tone="neutral">Agreement setup</Badge>
      </div>
      <p className="section-copy">
        This step fixes the three participants, test-USDC payout accounts, security amount and release
        rule on devnet. Tenant and landlord sign the same message; a separate sponsor pays only native
        fees and account rent. Funding is a later tenant action.
      </p>
      <button className="button secondary" disabled={busy || !wallet.ready} onClick={() => run(refresh)}>
        <RefreshCw size={16} /> Read setup
      </button>
      {!setup && message && <p className="note" role="status">{message}</p>}
      {setup && (
        <>
          <p className="section-copy">Your role: {setup.role}. {initialization
            ? `Setup ${initialization.state}; required security ${money(initialization.requiredSecurityAtomic)} test USDC.`
            : 'Waiting for the parties to prepare the agreement.'}</p>
          {!initialization ? (
            <p className="note">
              No initialization is prepared. Both parties must accept the agreement, and the operator
              must configure its derived tenancy, verified deployment, payout token accounts and fee sponsor.
            </p>
          ) : (
            <>
              <dl className="detail-list">
                <div><dt>State</dt><dd>{initialization.state}</dd></div>
                <div><dt>Required security</dt><dd>{money(initialization.requiredSecurityAtomic)} test USDC</dd></div>
                <div><dt>Earnings release</dt><dd>{initialization.releasePermitted ? 'Permitted above security' : 'Retained until settlement'}</dd></div>
                <div><dt>Signed by</dt><dd>{initialization.signedRoles.join(' and ') || 'Neither party yet'}</dd></div>
                {initialization.state === 'prepared' && (
                  <div><dt>Sign before</dt><dd>{new Date(initialization.expiresAt).toLocaleTimeString()}</dd></div>
                )}
              </dl>
              {initialization.lastError && <p className="note">{initialization.lastError}</p>}
              {initialization.state === 'prepared' && initialization.signedRoles.length === 2 && !initialization.signature && (
                <p className="note" role="status">
                  Both wallet signatures were recorded, but no transaction was submitted. If this
                  signing window has expired, prepare a fresh one and both parties must sign again.
                </p>
              )}
            </>
          )}
          <details className="operation-section">
            <summary>Technical setup proof</summary>
            <dl className="detail-list">
              <div><dt>Agreement</dt><dd className="mono">{setup.agreementId}</dd></div>
              <div><dt>Network</dt><dd>{setup.cluster}</dd></div>
              <div><dt>Tenancy address</dt><dd className="mono">{setup.tenancyAddress}</dd></div>
              {initialization && (
                <>
                  <div><dt>Tenant</dt><dd className="mono">{initialization.tenant}</dd></div>
                  <div><dt>Landlord</dt><dd className="mono">{initialization.landlord}</dd></div>
                  <div><dt>Arbitrator</dt><dd className="mono">{initialization.arbitrator}</dd></div>
                  <div><dt>Policy hash</dt><dd className="mono">{initialization.policyHash}</dd></div>
                  <div><dt>Tenant payout</dt><dd className="mono">{initialization.tenantDestination}</dd></div>
                  <div><dt>Landlord payout</dt><dd className="mono">{initialization.landlordDestination}</dd></div>
                  {initialization.signature && <div><dt>Transaction</dt><dd className="mono">{initialization.signature}</dd></div>}
                </>
              )}
            </dl>
          </details>
          <div className="button-row">
            {role !== 'arbitrator' &&
              (!initialization || initialization.state === 'failed' || initialization.state === 'prepared' || initialization.state === 'unknown') && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => run(() => change('prepare', 'Initialization is ready for both signatures.'))}
                >
                  Prepare or refresh signing window
                </button>
              )}
            {awaitingSignature && (
              <button className="button primary" disabled={busy || !walletConnected} onClick={() => run(() => sign())}>
                <ShieldCheck size={16} /> Review and sign setup
              </button>
            )}
            {initialization?.signature && initialization.state !== 'finalized' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => run(() => change('reconcile', 'Checked the finalized on-chain receipt.'))}
              >
                Check finality
              </button>
            )}
            {initialization?.state === 'unknown' && role !== 'arbitrator' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => run(() => change('retry', 'Checked whether the same signed transaction can be resent.'))}
              >
                Retry same signed transaction
              </button>
            )}
          </div>
          {awaitingSignature && !walletConnected && (
            <p className="note" role="status">
              This Solana wallet is linked but not connected in this browser. Open this agreement in a
              browser where Wallet and control details says Ready to request your signature.
            </p>
          )}
          {message && <p className="note" role="status">{message}</p>}
          {initialization?.state === 'finalized' && (
            <p className="note">
              The initialized tenancy matches the accepted agreement.{' '}
              <a href="#connected-solana-escrow">Open the connected escrow</a> to inspect its current
              funding and lending state.
            </p>
          )}
        </>
      )}
    </section>
  );
}
