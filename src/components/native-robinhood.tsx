'use client';
import { useState } from 'react';
import { Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { useRentalWallet, type EscrowAction } from '@/wallets';
import type { EscrowIntent, EscrowSnapshot } from '@/finance/robinhood';
import { parseAmount } from '@/domain/assets';
import { Badge, money } from './workspace-panels';

type NativeOperation = {
  id: string;
  walletId: string;
  state: string;
  chainId: 4663;
  escrowAddress: `0x${string}`;
  intent: EscrowIntent;
  action: EscrowAction;
  digest: string;
  expiresAt: string;
  description: string;
  transactionHash: string | null;
  reconciliation: unknown;
  evidence: string;
};
type Observation = {
  agreementId: string | null;
  snapshot: EscrowSnapshot;
  partyWallets: { id: string; address: string; role: string }[];
  planningHints: {
    supply: EscrowIntent | null;
    releaseEarnings: EscrowIntent | null;
    settle: EscrowIntent | null;
  };
  gates: { sponsoredSend: string };
};
export function NativeRobinhood({
  request,
}: {
  request: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const wallet = useRentalWallet();
  const savedOperationKey = `rental:robinhood-operation:${wallet.subject}`;
  const [observation, setObservation] = useState<Observation | null>(null);
  const [operation, setOperation] = useState<NativeOperation | null>(null);
  const [identifier, setIdentifier] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(savedOperationKey) || '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [claimAmount, setClaimAmount] = useState('120');
  const [evidence, setEvidence] = useState('');
  const snapshot = observation?.snapshot;
  const party = observation?.partyWallets[0];
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The native operation is unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setObservation((await request('/api/finance/robinhood')) as Observation);
  }
  async function plan(intent: EscrowIntent) {
    if (!party) throw new Error('Load the verified escrow first.');
    const operationId = crypto.randomUUID();
    // Save the recovery locator before a request whose response could be lost.
    // This ID grants no authority; loading it still requires the verified party.
    window.localStorage.setItem(savedOperationKey, operationId);
    setIdentifier(operationId);
    const next = (await request('/api/finance/robinhood/operations', {
      operationId,
      walletId: party.id,
      intent,
    })) as NativeOperation;
    setOperation(next);
    setIdentifier(next.id);
  }
  async function authorize() {
    if (!operation) return;
    const signature = await wallet.signEvmTypedData({
      operationId: operation.id,
      walletId: operation.walletId,
      chainId: operation.chainId,
      escrowAddress: operation.escrowAddress,
      action: operation.action,
      expiresAt: operation.expiresAt,
      description: operation.description,
    });
    setOperation(
      (await request(`/api/finance/robinhood/operations/${operation.id}/authorize`, {
        signature,
      })) as NativeOperation,
    );
  }
  async function propose() {
    const text = evidence.trim();
    if (text.length < 12 || !observation?.agreementId)
      throw new Error(
        'A linked private agreement and a reason are required before recording a claim or decision.',
      );
    await request(`/api/agreements/${observation.agreementId}`, {
      action: 'record',
      name:
        party?.role === 'landlord' ? 'Proposed claim evidence' : 'Proposed arbitration decision',
      body: text,
    });
    if (party?.role === 'arbitrator') {
      await plan({
        kind: 'resolveClaim',
        landlordAssets: parseAmount(claimAmount),
        minimumAssets: snapshot!.securityValue,
      });
      return;
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    await plan({
      kind: 'proposeClaim',
      assets: parseAmount(claimAmount),
      evidenceHash: `0x${digest}`,
    });
  }
  return (
    <section className="card operation-section">
      <div className="section-heading">
        <h2>Connected Robinhood escrow</h2>
        <Badge tone="neutral">Native authorization</Badge>
      </div>
      <p className="section-copy">
        Read the configured escrow with your verified account. Every action is simulated, reviewed,
        signed and reconciled independently of the demonstration.
      </p>
      <div className="button-row">
        <button
          className="button secondary"
          disabled={busy || !wallet.ready}
          onClick={() => run(refresh)}
        >
          <RefreshCw size={16} />
          Read verified escrow
        </button>
      </div>
      {message && (
        <p className="note" role="status">
          {message}
        </p>
      )}
      {snapshot && (
        <>
          <dl className="detail-list">
            <div>
              <dt>Your on-chain role</dt>
              <dd>{party?.role}</dd>
            </div>
            <div>
              <dt>Security value</dt>
              <dd>{money(snapshot.securityValue)} USDG</dd>
            </div>
            <div>
              <dt>Eligible earnings</dt>
              <dd>{money(snapshot.releasableEarnings)} USDG</dd>
            </div>
            <div>
              <dt>Released earnings</dt>
              <dd>{money(snapshot.releasedEarnings)} USDG</dd>
            </div>
            <div>
              <dt>Fee sponsorship</dt>
              <dd>{observation?.gates.sponsoredSend}</dd>
            </div>
          </dl>
          <div className="button-row">
            {snapshot.state === 0 &&
              ((party?.role === 'tenant' && !snapshot.tenantAccepted) ||
                (party?.role === 'landlord' && !snapshot.landlordAccepted)) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => run(() => plan({ kind: 'acceptAgreement' }))}
                >
                  Review agreement acceptance
                </button>
              )}
            {snapshot.state === 0 &&
              ((party?.role === 'tenant' && snapshot.tenantAccepted) ||
                (party?.role === 'landlord' && snapshot.landlordAccepted)) && (
                <p className="small-copy">Waiting for the other party to accept the agreement.</p>
              )}
            {party?.role === 'tenant' && snapshot.state === 1 && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => run(() => plan({ kind: 'fund' }))}
              >
                Review funding: {money(snapshot.securityRequirement)} USDG security +{' '}
                {money(snapshot.fundingReserve)} USDG rounding reserve, returned to you at settlement
              </button>
            )}
            {party?.role === 'tenant' && observation?.planningHints.supply && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => run(() => plan(observation.planningHints.supply!))}
              >
                Review lending supply
              </button>
            )}
            {party?.role === 'tenant' && observation?.planningHints.releaseEarnings && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => run(() => plan(observation.planningHints.releaseEarnings!))}
              >
                Review eligible earnings release
              </button>
            )}
            {party?.role === 'tenant' && snapshot.state === 3 && (
              <>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    run(() => plan({ kind: 'acceptClaim', minimumAssets: snapshot.securityValue }))
                  }
                >
                  Review claim acceptance
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => run(() => plan({ kind: 'contestClaim' }))}
                >
                  Request assigned arbitration
                </button>
              </>
            )}
            {snapshot.state === 5 && observation?.planningHints.settle && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => run(() => plan(observation.planningHints.settle!))}
              >
                Review recorded settlement
              </button>
            )}
          {party?.role === 'tenant' && observation?.planningHints.supply && (
            <p className="small-copy">
              A small amount stays as cash to cover vault share-rounding and preserve the required
              security.
            </p>
          )}
          </div>
          {((party?.role === 'landlord' && snapshot.state === 2) ||
            (party?.role === 'arbitrator' &&
              (snapshot.state === 4 || (snapshot.state === 5 && snapshot.arbitratedDecision)))) && (
            <form
              className="connection-form operation-section"
              onSubmit={(event) => {
                event.preventDefault();
                void run(propose);
              }}
            >
              <label>
                Landlord allocation (USDG)
                <input
                  value={claimAmount}
                  onChange={(e) => setClaimAmount(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                Reason and supporting evidence
                <input
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  maxLength={3000}
                />
              </label>
              <p className="small-copy">
                Keep the underlying evidence in the private case record. Only the commitment or
                bounded allocation is submitted to the escrow.
              </p>
              <button className="button secondary" disabled={busy}>
                Review {party?.role === 'landlord' ? 'claim proposal' : 'arbitration allocation'}
              </button>
            </form>
          )}
          <details className="operation-section">
            <summary>Verified deployment details</summary>
            <pre className="proof-code">
              {JSON.stringify(
                {
                  address: snapshot.address,
                  agreementHash: snapshot.agreementHash,
                  block: snapshot.blockNumber,
                  nonce: snapshot.nonce,
                  tenant: snapshot.tenant,
                  landlord: snapshot.landlord,
                  arbitrator: snapshot.arbitrator,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      <form
        className="connection-form operation-section"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () =>
            setOperation(
              (await request(
                `/api/finance/robinhood/operations/${encodeURIComponent(identifier)}`,
              )) as NativeOperation,
            ),
          );
        }}
      >
        <label>
          Resume a saved operation
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Operation identifier"
            required
          />
        </label>
        <button className="text-button" disabled={busy}>
          Load recorded status
        </button>
      </form>
      {operation && (
        <section className="operation-section">
          <div className="section-heading">
            <h3>Review {operation.intent.kind}</h3>
            <Badge tone={operation.state === 'completed' ? 'green' : 'neutral'}>
              {operation.state}
            </Badge>
          </div>
          <p className="section-copy">
            Signing authorizes this exact action on the configured escrow. The sponsor pays bounded
            network fees. Confirmation is recorded only from the matching chain receipt.
          </p>
          <dl className="detail-list">
            <div>
              <dt>Operation</dt>
              <dd className="mono">{operation.id}</dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd className="mono">{operation.escrowAddress}</dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>{new Date(operation.expiresAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Amount or allocation</dt>
              <dd>
                {operation.intent.kind === 'fund' && snapshot
                  ? money(snapshot.securityRequirement)
                  : 'assets' in operation.intent
                    ? money(operation.intent.assets)
                    : 'landlordAssets' in operation.intent
                      ? money(operation.intent.landlordAssets)
                      : 'Bounded by the recorded agreement'}
              </dd>
            </div>
            <div>
              <dt>Transaction</dt>
              <dd className="mono">{operation.transactionHash || 'No transaction submitted'}</dd>
            </div>
          </dl>
          <details>
            <summary>Exact authorization and limits</summary>
            <pre className="proof-code">
              {JSON.stringify(
                {
                  intent: operation.intent,
                  action: operation.action,
                  digest: operation.digest,
                  reconciliation: operation.reconciliation,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <div className="button-row">
            {['planned', 'prepared', 'submitted', 'broadcast_unknown'].includes(
              operation.state,
            ) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setOperation(
                      (await request(
                        `/api/finance/robinhood/operations/${operation.id}/retry`,
                        {},
                      )) as NativeOperation,
                    );
                  })
                }
              >
                {operation.state === 'planned'
                  ? 'Recover a previously signed transaction'
                  : 'Retry the same signed transaction'}
              </button>
            )}
            {operation.state === 'planned' && (
              <button
                className="button primary"
                disabled={busy || wallet.busy || observation?.gates.sponsoredSend !== 'enabled'}
                onClick={() => run(authorize)}
              >
                <ShieldCheck size={17} />
                Sign this native instruction
              </button>
            )}
            {operation.transactionHash && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setOperation(
                      (await request(
                        `/api/finance/robinhood/operations/${operation.id}/reconcile`,
                        {},
                      )) as NativeOperation,
                    );
                    await refresh();
                  })
                }
              >
                <Check size={17} />
                Check chain confirmation
              </button>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
