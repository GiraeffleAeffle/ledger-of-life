'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useRentalWallet } from '@/wallets';
import type { SolanaOperation } from '@/server/solana-service';
import type { SolanaSnapshot } from '@/server/solana-rpc';
import { parseAmount, displayAmount } from '@/domain/assets';
import { Badge, money } from './workspace-panels';
import { sameEconomicReview, settlementPayouts } from './solana-review';

type Operation = Omit<SolanaOperation, 'signedTxBase64' | 'subject' | 'fingerprint'>;
type Observation = SolanaSnapshot & {
  available: true;
  cluster: 'devnet' | 'localnet';
  walletChain: 'solana:devnet' | null;
  agreementId: string;
  role: 'tenant' | 'landlord' | 'arbitrator';
  walletId: string;
  escrowVersion?: 'direct-v1' | 'pull-v2';
  feePayer: string;
  operations: Operation[];
};
type Action =
  | { kind: 'fund' | 'settle' | 'fund_and_supply' | 'accept_and_settle' | 'redeem_and_settle' }
  | {
      kind: 'supply' | 'release_earnings' | 'propose_claim' | 'resolve_claim' | 'resolve_and_settle';
      amountAtomic: string;
    }
  | { kind: 'respond_to_claim'; accept: boolean }
  | { kind: 'payout'; landlord: boolean }
  | { kind: 'redeem'; receiptAtomic: string; minimumReceivedAtomic: string };
const titles: Record<Action['kind'], string> = {
  fund: 'Fund the fixed rental security',
  supply: 'Supply security to the configured reserve',
  redeem: 'Redeem lending receipts into rental security',
  release_earnings: 'Release eligible earnings to your personal wallet',
  propose_claim: 'Propose a landlord claim',
  respond_to_claim: 'Record the tenant’s claim response',
  resolve_claim: 'Record the assigned arbitration decision',
  settle: 'Pay the recorded security allocation',
  payout: 'Pay an owed deposit allocation',
  fund_and_supply: 'Secure the deposit and start lending',
  accept_and_settle: 'Accept the claim and settle the deposit',
  resolve_and_settle: 'Decide the claim and settle the deposit',
  redeem_and_settle: 'Settle the deposit',
};
function actionForReview(action: Operation['action']): Action {
  switch (action.kind) {
    case 'fund':
    case 'settle':
    case 'fund_and_supply':
    case 'accept_and_settle':
    case 'redeem_and_settle':
      return { kind: action.kind };
    case 'supply':
    case 'release_earnings':
    case 'propose_claim':
    case 'resolve_claim':
    case 'resolve_and_settle':
      return { kind: action.kind, amountAtomic: action.amountAtomic };
    case 'redeem':
      return {
        kind: 'redeem',
        receiptAtomic: action.receiptAtomic,
        minimumReceivedAtomic: action.minimumReceivedAtomic,
      };
    case 'respond_to_claim':
      return { kind: 'respond_to_claim', accept: action.accept };
    case 'payout':
      return { kind: 'payout', landlord: action.landlord };
  }
}

type NextStep = { label: string; action?: Action; form?: 'claim' | 'decision'; waiting?: string };
function nextStep(snapshot: Observation): NextStep {
  const { tenancy, role } = snapshot;
  switch (tenancy.phase) {
    case 'awaiting-funding':
      return role === 'tenant'
        ? { label: `Deposit ${money(tenancy.requiredSecurityAtomic)} test USDC`, action: { kind: 'fund' } }
        : { label: 'Deposit not yet funded', waiting: 'Waiting for the tenant to fund the deposit.' };
    case 'active':
      if (role === 'landlord')
        return { label: 'Propose a claim or confirm no claim', form: 'claim' };
      if (role === 'tenant' && BigInt(tenancy.accountedIdleAtomic) > 0n)
        return { label: 'Put the deposit to work', action: { kind: 'supply', amountAtomic: tenancy.accountedIdleAtomic } };
      return {
        label: role === 'tenant' ? 'Deposit is active' : 'No dispute to decide',
        waiting: role === 'tenant'
          ? 'Waiting for the landlord to propose a claim or confirm no claim.'
          : 'Waiting for a claim to be disputed before the arbitrator can decide.',
      };
    case 'claim-proposed':
      return role === 'tenant'
        ? { label: tenancy.claimAtomic === '0' ? 'Accept no deduction' : 'Accept the claim', action: { kind: 'respond_to_claim', accept: true } }
        : { label: 'Claim awaiting response', waiting: 'Waiting for the tenant to accept or dispute the claim.' };
    case 'disputed':
      return role === 'arbitrator'
        ? { label: 'Decide the disputed claim', form: 'decision' }
        : { label: 'Claim under review', waiting: 'Waiting for the assigned arbitrator to decide the claim.' };
    case 'settling':
      return BigInt(tenancy.accountedReceiptsAtomic) > 0n
        ? {
            label: 'Return lending assets to the deposit',
            action: {
              kind: 'redeem',
              receiptAtomic: tenancy.accountedReceiptsAtomic,
              minimumReceivedAtomic: snapshot.receiptValueAtomic,
            },
          }
        : { label: 'Complete the deposit settlement', action: { kind: 'settle' } };
    case 'closed':
      if (snapshot.escrowVersion === 'pull-v2') {
        const tenantOwed = BigInt(tenancy.tenantOwedAtomic);
        const landlordOwed = BigInt(tenancy.landlordOwedAtomic);
        if (role === 'tenant' && tenantOwed > 0n)
          return { label: `Collect your ${money(tenancy.tenantOwedAtomic)} test USDC payout`, action: { kind: 'payout', landlord: false } };
        if (role === 'landlord' && landlordOwed > 0n)
          return { label: `Collect your ${money(tenancy.landlordOwedAtomic)} test USDC payout`, action: { kind: 'payout', landlord: true } };
        if (tenantOwed > 0n || landlordOwed > 0n)
          return {
            label: 'Settlement recorded; payouts outstanding',
            waiting: tenantOwed > 0n
              ? 'Waiting for the tenant to collect the owed allocation.'
              : 'Waiting for the landlord to collect the owed allocation.',
          };
      }
      return { label: 'Deposit settlement completed' };
  }
}
const pendingStates = ['prepared', 'signed', 'broadcast', 'unknown'] as const;
function latestPending(snapshot: Observation): Operation | undefined {
  return snapshot.operations.findLast(
    (item) => item.walletId === snapshot.walletId && pendingStates.some((state) => item.state === state),
  );
}

export function NativeSolana({
  request,
}: {
  request: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const wallet = useRentalWallet();
  const initialRequest = useRef(request);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [amount, setAmount] = useState('10');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [expiredReviewId, setExpiredReviewId] = useState<string | null>(null);
  const tenancy = observation?.tenancy;
  const phase = tenancy?.phase;
  const role = observation?.role;
  const settlement = operation && tenancy ? settlementPayouts(operation, tenancy) : null;
  const step = observation ? nextStep(observation) : null;
  const pending = observation ? latestPending(observation) : null;
  const settledOperation = observation?.operations.findLast(
    (item) => item.state === 'finalized' && item.action.kind === 'settle',
  );
  const settledPayouts = settledOperation && tenancy ? settlementPayouts(settledOperation, tenancy) : null;
  const paidFromPayouts = observation && tenancy && observation.escrowVersion === 'pull-v2'
    ? (['tenant', 'landlord'] as const).map((side) => observation.operations
        .filter((item) => item.state === 'finalized' && item.action.kind === 'payout')
        .flatMap((item) => item.expectedDeltas)
        .filter((delta) => delta.account === tenancy[`${side}Destination`] &&
          delta.owner === tenancy[side] && delta.mint === tenancy.depositMint &&
          delta.direction === 'credit' && delta.minimumAtomic === delta.maximumAtomic)
        .reduce((sum, delta) => sum + BigInt(delta.minimumAtomic), 0n).toString())
    : null;
  useEffect(() => {
    if (!wallet.ready) return;
    let active = true;
    void initialRequest.current('/api/finance/solana')
      .then((result) => {
        if (!active) return;
        const next = result as Observation;
        if (!next.available) return;
        setObservation(next);
        setOperation(latestPending(next) ?? null);
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : 'Solana escrow is unavailable.');
      });
    return () => { active = false; };
  }, [wallet.ready]);
  useEffect(() => {
    if (operation?.state !== 'prepared') return;
    const delay = Math.max(0, Date.parse(operation.expiresAt) - Date.now());
    const timeout = window.setTimeout(() => setExpiredReviewId(operation.id), delay);
    return () => window.clearTimeout(timeout);
  }, [operation]);
  const reviewExpired = operation?.state === 'prepared' &&
    (expiredReviewId === operation.id ||
      /(?:blockhash|operation) expired/i.test(message));
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Solana escrow is unavailable.';
      if (/nonce_reserved|already reserves this tenancy nonce/i.test(detail)) {
        try {
          const current = await refresh();
          setMessage(latestPending(current)
            ? 'Another action is already pending. Resume it in the banner below before preparing a new one.'
            : 'A pending action reserves this tenancy. Wait for its signer to check the result before preparing another.');
        } catch {
          setMessage(detail);
        }
      } else setMessage(detail);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const next = (await request('/api/finance/solana')) as
      Observation | { available: false; reason: string };
    if (!next.available) {
      setObservation(null);
      setOperation(null);
      throw new Error(next.reason);
    }
    setObservation(next);
    const latest = latestPending(next);
    setOperation((selected) =>
      latest ?? next.operations.find((item) => item.id === selected?.id) ?? selected,
    );
    window.dispatchEvent(new Event('solana-tenancy-updated'));
    return next;
  }
  async function plan(action: Action) {
    if (!observation) throw new Error('Read the verified test escrow first.');
    const needsEvidence =
      action.kind === 'propose_claim' ||
      action.kind === 'resolve_claim' ||
      (action.kind === 'respond_to_claim' && !action.accept);
    if (needsEvidence && evidence.trim().length < 12)
      throw new Error('Provide a reason and supporting evidence before continuing.');
    const result = (await request('/api/finance/solana/operations', {
      requestId: crypto.randomUUID(),
      action,
    })) as { operation: Operation };
    setOperation(result.operation);
    await refresh();
    if (needsEvidence) {
      await request(`/api/agreements/${observation.agreementId}`, {
        action: 'record',
        name: `Evidence for prepared ${titles[action.kind]} (not confirmed)`,
        body: `Prepared Solana operation ${result.operation.id}; this is a review, not an on-chain result.\n\n${evidence.trim()}`,
      });
      setEvidence('');
    }
  }
  async function authorize(now: () => number) {
    if (!operation || !observation?.walletChain)
      throw new Error('Browser signing is available only for a configured devnet escrow.');
    let current = operation;
    if (Date.parse(current.expiresAt) <= now() ||
        /(?:blockhash|operation) expired/i.test(message)) {
      const result = (await request('/api/finance/solana/operations', {
        requestId: crypto.randomUUID(),
        action: actionForReview(current.action),
      })) as { operation: Operation };
      setOperation(result.operation);
      if (!sameEconomicReview(current, result.operation, now()))
        throw new Error('The renewed review changed. Check its details before signing.');
      current = result.operation;
    }
    const signed = await wallet.signSolanaTransaction({
      operationId: current.id,
      walletId: current.walletId,
      chain: observation.walletChain,
      feePayer: observation.feePayer,
      expiresAt: current.expiresAt,
      transaction: Uint8Array.from(atob(current.transactionBase64), (character) =>
        character.charCodeAt(0),
      ),
      description: titles[current.action.kind],
    });
    const signedTxBase64 = btoa(Array.from(signed, (byte) => String.fromCharCode(byte)).join(''));
    try {
      const result = (await request(`/api/finance/solana/operations/${current.id}/authorize`, {
        signedTxBase64,
      })) as { operation: Operation };
      setOperation(result.operation);
    } catch (error) {
      try {
        await refresh();
      } catch {
        // Keep the original authorization error if the snapshot is also unavailable.
      }
      throw error;
    }
    await refresh();
  }
  async function reconcile(target: Operation | null = operation) {
    if (!target) return;
    const result = (await request(
      `/api/finance/solana/operations/${target.id}/reconcile`,
      {},
    )) as { operation: Operation };
    setOperation(result.operation);
    await refresh();
  }
  async function retry(target: Operation) {
    const result = (await request(
      `/api/finance/solana/operations/${target.id}/retry`,
      {},
    )) as { operation: Operation };
    setOperation(result.operation);
    await refresh();
  }
  function evidenceForm(
    kind: 'propose_claim' | 'respond_to_claim' | 'resolve_claim' | 'release_earnings',
    primary: boolean,
  ) {
    const hasAmount = kind !== 'respond_to_claim';
    const hasEvidence = kind !== 'release_earnings';
    return (
      <form
        className="connection-form operation-section"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => plan(kind === 'respond_to_claim'
            ? { kind, accept: false }
            : { kind, amountAtomic: parseAmount(amount) }));
        }}
      >
        {hasAmount && (
          <label>
            {kind === 'release_earnings' ? 'Earnings to release' : 'Landlord allocation'} (test USDC)
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          </label>
        )}
        {hasEvidence && (
          <label>
            Reason and supporting evidence
            <textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={3000} />
          </label>
        )}
        <p className="small-copy">
          {hasEvidence
            ? 'Evidence is attached to a prepared review, not recorded as a completed on-chain claim or decision. Only a finalized result changes the tenancy.'
            : 'Only observed, permitted surplus can be released; the security remains in the escrow.'}
        </p>
        <button className={primary ? 'button primary' : 'button secondary'} disabled={busy || Boolean(pending)}>
          Review {kind === 'propose_claim' ? 'claim proposal'
            : kind === 'respond_to_claim' ? 'dispute'
              : kind === 'resolve_claim' ? 'arbitration decision' : 'earnings release'}
        </button>
      </form>
    );
  }
  return (
    <section className="card operation-section" id="connected-solana-escrow">
      <div className="section-heading">
        <h2>Connected Solana escrow</h2>
        <Badge tone="neutral">Test deployment</Badge>
      </div>
      <p className="section-copy">
        Read the configured tenancy and review each native action before signing. Finalized receipts
        establish results independently of the demonstration.
      </p>
      <button
        className="button secondary"
        disabled={busy || !wallet.ready}
        onClick={() => run(refresh)}
      >
        <RefreshCw size={16} /> Read verified test escrow
      </button>
      {message && (
        <p className="note" role="status">
          {message}
        </p>
      )}
      {observation && tenancy && (
        <>
          <div className="section-heading">
            <h3>{step?.label}</h3>
            <Badge tone={phase === 'closed' ? 'green' : 'neutral'}>
              {phase?.replaceAll('-', ' ')}
            </Badge>
          </div>
          <p className="section-copy">
            {step?.waiting ?? (
              phase === 'closed'
                ? 'The on-chain settlement is closed. Check the payout status below.'
                : `Your assigned role: ${role}. Security required: ${money(tenancy.requiredSecurityAtomic)} test USDC.`
            )}
          </p>
          {phase === 'closed' && (
            <div className="solana-completion" role="status">
              {observation.escrowVersion === 'pull-v2' ? (
                <>
                  <p>Settlement fixed the allocations. Each unpaid amount needs a separate payout transaction.</p>
                  <dl className="detail-list">
                    <div><dt>Tenant payout still owed</dt><dd>{money(tenancy.tenantOwedAtomic)} test USDC</dd></div>
                    <div><dt>Landlord payout still owed</dt><dd>{money(tenancy.landlordOwedAtomic)} test USDC</dd></div>
                    <div><dt>Finalized tenant payouts in this history</dt><dd>{money(paidFromPayouts?.[0] ?? '0')} test USDC</dd></div>
                    <div><dt>Finalized landlord payouts in this history</dt><dd>{money(paidFromPayouts?.[1] ?? '0')} test USDC</dd></div>
                  </dl>
                </>
              ) : settledPayouts ? (
                <>
                  <p>The finalized settlement credited the fixed payout accounts.</p>
                  <dl className="detail-list">
                    <div><dt>Returned to tenant</dt><dd>{money(settledPayouts.tenantAtomic)} test USDC</dd></div>
                    <div><dt>Paid to landlord</dt><dd>{money(settledPayouts.landlordAtomic)} test USDC</dd></div>
                  </dl>
                </>
              ) : (
                <p>The tenancy is closed. No finalized payout breakdown is available in this operation history; do not infer a payment from the closed phase alone.</p>
              )}
            </div>
          )}
          {pending && (
            <div className="solana-pending" role="status">
              <strong>Pending action: {titles[pending.action.kind]}</strong>
              <p>
                {pending.state === 'prepared'
                  ? 'A review already reserves the next action. Open it rather than preparing another.'
                  : 'A signed transaction may already be on-chain. Check this exact operation before attempting a new action.'}
              </p>
              <div className="button-row">
                <button className="button secondary" disabled={busy} onClick={() => setOperation(pending)}>
                  Open pending review
                </button>
                {pending.state !== 'prepared' && (
                  <>
                    <button className="button primary" disabled={busy} onClick={() => run(() => reconcile(pending))}>
                      <RefreshCw size={16} /> Check result
                    </button>
                    <button className="button secondary" disabled={busy} onClick={() => run(() => retry(pending))}>
                      Retry same signed transaction
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {!observation.walletChain && (
            <p className="note">
              Localnet is available for operator tests. This wallet integration does not support
              browser signing on localnet.
            </p>
          )}
          {observation.requiresRefresh && (
            <p className="note">
              The reserve observation needs refresh. Exact transaction simulation must succeed
              before authorization.
            </p>
          )}
          {!pending && step?.action && (
            <button className="button primary" disabled={busy} onClick={() => run(() => plan(step.action!))}>
              Review: {step.label}
            </button>
          )}
          {!pending && step?.form === 'claim' && evidenceForm('propose_claim', true)}
          {!pending && step?.form === 'decision' && evidenceForm('resolve_claim', true)}
          {(phase === 'active' && role === 'tenant' && tenancy.releasePermitted ||
            phase === 'claim-proposed' && role === 'tenant' ||
            phase === 'active' && role === 'tenant' && BigInt(tenancy.accountedReceiptsAtomic) > 0n) && (
            <details className="operation-section">
              <summary>Other available actions</summary>
              {phase === 'active' && role === 'tenant' && tenancy.releasePermitted &&
                evidenceForm('release_earnings', false)}
              {phase === 'claim-proposed' && role === 'tenant' &&
                evidenceForm('respond_to_claim', false)}
              {phase === 'active' && role === 'tenant' && BigInt(tenancy.accountedReceiptsAtomic) > 0n && (
                <button className="button secondary" disabled={busy || Boolean(pending)} onClick={() => run(() => plan({
                  kind: 'redeem',
                  receiptAtomic: tenancy.accountedReceiptsAtomic,
                  minimumReceivedAtomic: observation.receiptValueAtomic,
                }))}>Review full lending redemption</button>
              )}
            </details>
          )}
          <details className="operation-section">
            <summary>Operation history and deployment</summary>
            <p className="small-copy">
              Tenancy: {tenancy.address}
              <br />
              Finalized slot: {observation.slot}
              <br />
              Fee payer: {observation.feePayer}
            </p>
            <div className="button-row">
              {observation.operations
                .slice()
                .reverse()
                .map((item) => (
                  <button
                    className="button secondary"
                    disabled={busy}
                    key={item.id}
                    onClick={() => setOperation(item)}
                  >
                    {titles[item.action.kind]} · {item.state}
                  </button>
                ))}
            </div>
          </details>
        </>
      )}
      {operation && (
        <section className="operation-section" id="solana-operation-review">
          <div className="section-heading">
            <h3>{titles[operation.action.kind]}</h3>
            <Badge tone={operation.state === 'finalized' ? 'green' : 'neutral'}>
              {operation.state}
            </Badge>
          </div>
          <dl className="detail-list">
            {'amountAtomic' in operation.action && (
              <div>
                <dt>Amount</dt>
                <dd>{money(operation.action.amountAtomic)} USDC</dd>
              </div>
            )}
            {operation.action.kind === 'fund' && tenancy && (
              <div>
                <dt>Amount</dt>
                <dd>{money(tenancy.requiredSecurityAtomic)} USDC</dd>
              </div>
            )}
            {operation.action.kind === 'redeem' && (
              <div>
                <dt>Minimum returned to escrow</dt>
                <dd>{money(operation.action.minimumReceivedAtomic)} test USDC</dd>
              </div>
            )}
            {operation.action.kind === 'respond_to_claim' && (
              <div>
                <dt>Response</dt>
                <dd>
                  {operation.action.accept
                    ? tenancy?.claimAtomic === '0'
                      ? 'Confirm no deduction'
                      : 'Accept the claim'
                    : 'Request assigned arbitration'}
                </dd>
              </div>
            )}
            {operation.action.kind === 'payout' && tenancy && (
              <div>
                <dt>Fixed recipient</dt>
                <dd>{operation.action.landlord ? 'Landlord' : 'Tenant'} payout account</dd>
              </div>
            )}
            {operation.action.kind === 'settle' && settlement && (
              <>
                <div>
                  <dt>Return to tenant</dt>
                  <dd>{money(settlement.tenantAtomic)} USDC</dd>
                </div>
                <div>
                  <dt>Pay to landlord</dt>
                  <dd>{money(settlement.landlordAtomic)} USDC</dd>
                </div>
              </>
            )}
            {operation.action.kind === 'settle' && observation?.escrowVersion === 'pull-v2' && tenancy && (
              <>
                <div><dt>Recorded as owed to tenant</dt><dd>{money((BigInt(tenancy.accountedIdleAtomic) - BigInt(tenancy.approvedClaimAtomic)).toString())} test USDC</dd></div>
                <div><dt>Recorded as owed to landlord</dt><dd>{money(tenancy.approvedClaimAtomic)} test USDC</dd></div>
              </>
            )}
            <div>
              <dt>Review expires</dt>
              <dd>{new Date(operation.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          {operation.action.kind === 'settle' && observation?.escrowVersion !== 'pull-v2' && !settlement && (
            <p className="note" role="status">
              The fixed-recipient settlement amounts could not be verified. Do not sign this review.
            </p>
          )}
          {operation.lastError && (
            <p className="note" role="status">
              {operation.lastError}
            </p>
          )}
          {reviewExpired && (
            <p className="note" role="status">
              This review expired before signing. Renewing will keep the same action, token movements and fee ceiling, or stop for a new review if they changed.
            </p>
          )}
          <div className="button-row">
            {['signed', 'broadcast', 'unknown'].includes(operation.state) &&
              operation.walletId === observation?.walletId && pending?.id !== operation.id && (
                <button className="button secondary" disabled={busy} onClick={() => run(() => retry(operation))}>
                  Retry the same signed transaction
                </button>
              )}
            {operation.state === 'prepared' && operation.walletId === observation?.walletId && (
              <button
                className="button primary"
                disabled={busy || wallet.busy || !observation?.walletChain ||
                  (operation.action.kind === 'settle' && observation?.escrowVersion !== 'pull-v2' && !settlement)}
                onClick={() => run(() => authorize(Date.now))}
              >
                <ShieldCheck size={16} /> {reviewExpired ? 'Renew and sign reviewed devnet action' : 'Sign reviewed devnet action'}
              </button>
            )}
            {pending?.id !== operation.id && operation.state !== 'prepared' && (
              <button className="button secondary" disabled={busy} onClick={() => run(() => reconcile())}>
                <RefreshCw size={16} /> Check finalized result
              </button>
            )}
          </div>
          <details className="operation-section">
            <summary>Exact authorization and receipt</summary>
            <p className="small-copy">
              Sponsor debit ceiling: {displayAmount(operation.simulation.sponsorDebitCeilingLamports, 9, 9)} test SOL.
              {operation.action.kind === 'redeem' && ` Lending receipts: ${operation.action.receiptAtomic} atomic units.`}
            </p>
            <pre className="proof-code">
              {JSON.stringify(
                {
                  id: operation.id,
                  action: operation.action,
                  actor: operation.actor,
                  nonce: operation.nonce,
                  messageSha256: operation.messageSha256,
                  signature: operation.signature,
                  expectedDeltas: operation.expectedDeltas,
                  receipt: operation.receipt,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </section>
      )}
    </section>
  );
}
