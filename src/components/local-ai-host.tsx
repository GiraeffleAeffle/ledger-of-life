'use client';
import { useEffect, useRef, useState } from 'react';
import { BarChart3, Cpu, Library, Loader2, Wallet } from 'lucide-react';
import type { LocalAiServiceStatus, LocalAiUsageSummary } from '../server/local-ai-types';
import { DEFAULT_HOST_SCENARIO, hostEconomics, type HostScenario } from './local-ai-economics';
import { useRentalWallet } from '@/wallets';

const euros = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(value);
const fields: { key: keyof HostScenario; label: string; min: number; max?: number; step: number }[] = [
  { key: 'hardwareEuro', label: 'Hardware allocation (€)', min: 0, step: 50 },
  { key: 'amortizationMonths', label: 'Spread hardware over (months)', min: 1, step: 1 },
  { key: 'averageWatts', label: 'Average whole-host power (W)', min: 0, step: 10 },
  { key: 'hoursPerDay', label: 'Online hours / day', min: 0, max: 24, step: 1 },
  { key: 'electricityEuroPerKwh', label: 'Electricity (€ / kWh)', min: 0, step: 0.01 },
  { key: 'otherMonthlyEuro', label: 'Other monthly costs (€)', min: 0, step: 1 },
  { key: 'priceEuroPerAnswer', label: 'Assumed price / paid answer (€)', min: 0, step: 0.01 },
  { key: 'paidAnswersPerDay', label: 'Paid answers / day', min: 0, step: 1 },
  { key: 'freeAnswersPerDay', label: 'Free answers / day', min: 0, step: 1 },
];

type HostRequest = <T,>(path: string, body?: object) => Promise<T>;

export function LocalAiHost({ usage, error, service, request, refresh }: {
  usage: LocalAiUsageSummary | null; error: string; service: LocalAiServiceStatus | null;
  request: HostRequest; refresh: () => Promise<void>;
}) {
  const wallet = useRentalWallet();
  const [distributor, setDistributor] = useState<string | null>(null);
  const ownAddress = wallet.wallets.find((item) => item.chainType === 'ethereum' && item.connected)?.address;
  const [inputs, setInputs] = useState<HostScenario>(DEFAULT_HOST_SCENARIO);
  const [invitation, setInvitation] = useState<{ code: string; expiresAt: string } | null>(null);
  const [payoutWallet, setPayoutWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [hostError, setHostError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const action = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const active = mounted;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    let live = true;
    void fetch('/api/building', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return;
      const value = await response.json() as { building: { configured: boolean; distributor: string | null } };
      if (live) setDistributor(value.building.configured ? value.building.distributor : null);
    }).catch(() => { /* Unavailable configuration never enables payout changes. */ });
    return () => { live = false; };
  }, []);
  const hosts = service?.hosts?.filter((host) => host.own && host.state === 'active') ?? [];
  async function manageHost(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true; setBusy(true); setHostError(''); setNotice('');
    try { await operation(); if (mounted.current) await refresh(); }
    catch (cause) { if (mounted.current) setHostError(cause instanceof Error ? cause.message : 'The host could not be updated.'); }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  function createInvitation() {
    void manageHost(async () => {
      const next = await request<{ code: string; expiresAt: string }>('/api/local-ai/hosts/invitations', { ...(payoutWallet.trim() ? { payoutWallet: payoutWallet.trim() } : {}) });
      if (mounted.current) { setInvitation(next); setPayoutWallet(''); }
    });
  }
  function copyInvitation() {
    if (!invitation) return;
    void manageHost(async () => {
      await navigator.clipboard.writeText(invitation.code);
      if (mounted.current) setNotice('Invitation copied. Keep it private and paste it only into your own connector configuration.');
    });
  }
  function revokeHost(hostId: string) {
    void manageHost(async () => {
      await request('/api/local-ai/hosts/revoke', { hostId });
      if (mounted.current) setNotice('Host revoked. This connector can no longer collect new questions.');
    });
  }
  function setFreePublicAnswers(hostId: string, enabled: boolean) {
    void manageHost(async () => {
      await request('/api/local-ai/hosts/settings', { hostId, freePublicAnswers: enabled });
      if (mounted.current) setNotice(enabled ? 'This host now offers free public answers within the shared allowance. No payment or payout.' : 'Free public answers disabled. Paid and own-compute access are unchanged.');
    });
  }
  function setBuildingPayout(hostId: string, enabled: boolean) {
    const address = enabled ? distributor : ownAddress;
    if (!address) return;
    void manageHost(async () => {
      await request('/api/local-ai/hosts/settings', { hostId, payoutWallet: address });
      if (mounted.current) setNotice(enabled ? 'Future paid GPU answers pay the building distributor, for staked fictional tHOME units. No value, no rights. Existing receipts are unchanged.' : 'Future paid GPU answers pay your own verified wallet again. Existing building earnings are unchanged.');
    });
  }
  const plan = hostEconomics(inputs, usage?.meanWallMs ?? null);
  return <div className="local-ai-host">
    <div className="local-ai-pairing">
      <div className="local-ai-section-title"><span className="eyebrow">YOUR DEVICES</span><h3>Connect a host you run.</h3><p>The outbound connector runs beside Ollama on your device. No public Ollama port is needed. Create a private invitation here, then put it in your connector configuration as pairingCode.</p></div>
      {service?.mode !== 'direct' && service?.hostPairingAllowed ? invitation ? <div className="local-ai-invitation" role="status">
        <strong>Keep this invitation private. It is shown only once.</strong>
        <code>{invitation.code}</code>
        <p>Paste it into <code>pairingCode</code> on a device you control. It expires at {new Date(invitation.expiresAt).toLocaleTimeString()} and can be used once. Pairing gives that device access to questions assigned to your host, not permission to spend from your wallet.</p>
        <div><button type="button" className="primary-btn" disabled={busy} onClick={copyInvitation}>Copy invitation</button><button type="button" className="text-button" disabled={busy} onClick={() => { setInvitation(null); setNotice(''); }}>Hide &amp; reset invitation</button></div>
        <small>This code is not saved in this browser. Leaving this view hides it permanently.</small>
      </div> : <form className="local-ai-pairing-form" onSubmit={(event) => { event.preventDefault(); createInvitation(); }}>
        <label>Payout wallet (optional)<input value={payoutWallet} maxLength={42} autoComplete="off" spellCheck={false} disabled={busy} placeholder="Verified 0x address" onChange={(event) => setPayoutWallet(event.target.value)} /><small>Use an address verified for your account to receive paid-answer receipts. Leave blank to use your verified allowlisted EVM wallet.</small></label>
        <p className="local-ai-meta">Invitations expire after 10 minutes and bind your account and payout wallet to one connector. Only share the code with a device you control.</p>
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : <Cpu size={16} />}Create private host invitation</button>
      </form> : <p className="local-ai-meta">{service ? 'Host pairing is not enabled for this account. Existing hosts are shown below.' : 'Checking whether this account can pair a host…'}</p>}
      <div className="local-ai-host-directory"><h4>Your connector hosts</h4>{hosts.length ? <ul>{hosts.map((host) => <li key={host.id}><div><strong>{host.name}</strong><small>{host.models.join(', ') || 'No models reported'}</small><small>Payout: {host.payoutWallet ? <code>{host.payoutWallet}</code> : 'Not configured'}</small><small>Last heartbeat: {host.lastHeartbeat ? new Date(host.lastHeartbeat).toLocaleString() : 'Not yet received'}</small><label className="local-ai-consent"><input type="checkbox" checked={host.freePublicAnswers === true} disabled={busy} onChange={(event) => setFreePublicAnswers(host.id, event.target.checked)} /><span>Offer free public answers · no payout</span></label><small>Off by default. Anyone may use the shared allowance: 30 attempts per day, up to 3 per visitor. You cover the compute; residence is not checked.</small><label className="local-ai-consent"><input type="checkbox" checked={Boolean(distributor && host.payoutWallet?.toLowerCase() === distributor.toLowerCase())} disabled={busy || !distributor || !ownAddress} onChange={(event) => setBuildingPayout(host.id, event.target.checked)} /><span>Opt in: pay future GPU revenue to the tHOME building</span></label><small>Explicit testnet opt-in only. Paid answers send tUSDG to the pinned building distributor; income streams to stakers over 7 days, not as an instant payout. Only staked fictional tHOME units earn. Fictional test units, no value, no rights. Uncheck to restore your verified wallet. {distributor ? `Distributor: ${distributor}` : 'Building distributor not configured.'}</small></div><span className={`local-ai-node-state ${host.availability}`}><span />{host.availability}{host.availability === 'asleep' && host.canWake ? ' · wakes on request' : ''}</span><button type="button" className="text-button" disabled={busy} onClick={() => revokeHost(host.id)}>Revoke host</button></li>)}</ul> : <p className="local-ai-meta">No connector hosts belong to this account yet.</p>}</div>
      {notice && <p className="local-ai-meta" role="status">{notice}</p>}
      {hostError && <p className="local-ai-alert" role="alert">{hostError}</p>}
    </div>
    <div className="local-ai-section-title"><span className="eyebrow">RECORDED ON THIS APP</span><h3>Useful work, recorded payments.</h3><p>Completed answers and confirmed x402 transfers across all hosts on this app, not your personal earnings or a forecast. Connector usage is reported by the host.</p></div>
    {error && <p className="local-ai-alert" role="alert">Usage unavailable: {error}</p>}
    <div className="local-ai-metrics" aria-label="Recorded app inference usage">
      <div><Wallet size={19} /><strong>{usage ? `${Number(BigInt(usage.settledAtomic)) / 1e6} tUSDG` : '—'}</strong><span>Settled receipts</span></div>
      <div><BarChart3 size={19} /><strong>{usage?.successfulPaidRequests ?? '—'}</strong><span>Paid answers</span></div>
      <div><Library size={19} /><strong>{usage?.successfulLibraryRequests ?? '—'}</strong><span>Free answers</span></div>
      <div><Cpu size={19} /><strong>{usage?.meanTokensPerSecond != null ? `${usage.meanTokensPerSecond.toFixed(1)} tok/s` : '—'}</strong><span>Measured mean decode rate</span></div>
    </div>
    {usage && <p className="local-ai-meta">{usage.knownInputTokens.toLocaleString()} known input tokens · {usage.knownOutputTokens.toLocaleString()} known output tokens · {usage.successfulOwnRequests ?? 0} own-compute answers · {usage.pendingPayments} pending payments · {usage.failedRequests} unsuccessful requests{usage.requestsWithoutUsage > 0 ? ` · ${usage.requestsWithoutUsage} requests without token counts` : ''}{usage.lastSuccessAt ? ` · Last answer ${new Date(usage.lastSuccessAt).toLocaleString()}` : ''}</p>}
    <div className="local-ai-planner">
      <div className="local-ai-section-title"><span className="eyebrow">EDITABLE EURO SCENARIO</span><h3>Could the hardware pay its way?</h3><p>Plan paid access, a free library service, or both. Euro prices below are assumptions—not a conversion of the receipt ledger.</p></div>
      <div className="local-ai-plan-layout">
        <div className="local-ai-assumptions">{fields.map(({ key, label, ...limits }) => <label key={key}>{label}<input type="number" {...limits} value={Number.isFinite(inputs[key]) ? inputs[key] : ''} onChange={(event) => { const value = event.currentTarget.valueAsNumber; setInputs((current) => ({ ...current, [key]: value })); }} /></label>)}</div>
        <div className="local-ai-plan-result" aria-live="polite">
          {plan ? <><span>Illustrative 30-day operating margin</span><strong className={plan.marginEuro < 0 ? 'negative' : ''}>{euros(plan.marginEuro)}</strong>
            <dl><div><dt>Gross service income</dt><dd>{euros(plan.grossEuro)}</dd></div><div><dt>Electricity · {plan.electricityKwh.toFixed(1)} kWh</dt><dd>−{euros(plan.electricityEuro)}</dd></div><div><dt>Hardware allocation</dt><dd>−{euros(plan.hardwareEuro)}</dd></div><div><dt>Other entered costs</dt><dd>−{euros(inputs.otherMonthlyEuro)}</dd></div></dl>
            <p>{plan.breakEvenPaidAnswersPerDay === null ? 'Free access needs a host budget; there is no paid break-even at a zero price.' : `${plan.breakEvenPaidAnswersPerDay.toLocaleString()} paid answers a day to cover these costs.`}</p>
            {plan.computeHoursPerDay !== null ? <p className={plan.exceedsObservedCapacity ? 'local-ai-capacity-warning' : ''}>{plan.computeHoursPerDay.toFixed(2)} compute hours/day at the observed mean request time.{plan.exceedsObservedCapacity ? ' This exceeds the entered online hours.' : ''}</p> : <p>Run an answer to add a measured inference-time capacity check.</p>}
            {plan.allocatedCostEuroPerAnswer !== null && <small>{euros(plan.allocatedCostEuroPerAnswer)} allocated cost per paid or free answer at this demand.</small>}
          </> : <p>Enter finite, non-negative assumptions, at least one month, whole answer counts, and no more than 24 online hours a day.</p>}
        </div>
      </div>
      <details className="local-ai-method"><summary>What the calculation includes</summary><p>Power is a whole-host assumption, not a GPU power measurement. Electricity covers all online hours, including idle time. Hardware is allocated over the entered months. Add hosting, financing, maintenance and transaction costs to other monthly costs; tax is not calculated.</p><p>Observed request time depends on model, prompt length, output and cold starts. The capacity check excludes wallet review, payment settlement and queue overhead. It is an upper-bound compute check, not a prediction of customers or continuous throughput. Free answers use the same node without a payment.</p></details>
    </div>
  </div>;
}
