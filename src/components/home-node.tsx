'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSectionTabActive } from './section-tabs';
import { atomicDollars, gpuPayoutSummary, installCommand, mcpConfig, pairingStatus, readingFresh, solarSummary, solarAssignmentPayload, solarApprovalAllowed, operatorSolarApprovalAllowed, type HomeDevicesResponse, type OperatorSolarAssignmentFields } from './home-node-logic';
import './home-node.css';
import { HostKindBadge } from './home-node-host-badge';
import { MoreList, MoreRow } from './blocks';
type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type OperatorDevice = OperatorSolarAssignmentFields & { hostId: string; name: string; state: string; kind: 'operator' | 'community'; availability: string; canSuspend: boolean; assignSolarToBuilding: boolean };
export function HomeNode({ request }: { request: Request }) {
  const active = useSectionTabActive();
  const [data, setData] = useState<HomeDevicesResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [invitation, setInvitation] = useState<{ code: string; expiresAt: string } | null>(null);
  const [pairPayout, setPairPayout] = useState<'own' | 'building'>('own');
  const [pairBaseline, setPairBaseline] = useState<string[]>([]);
  const [operatorDevices, setOperatorDevices] = useState<OperatorDevice[]>([]);
  const [capacities, setCapacities] = useState<Record<string, string>>({});
  const [checksum, setChecksum] = useState('');
  const [origin, setOrigin] = useState('');
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  const action = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await request<HomeDevicesResponse>('/api/home-node/devices');
      if (revision.current === current) { setData(result); setError(''); }
      if (result.isOperator) {
        const moderation = await request<{ devices: OperatorDevice[] }>('/api/home-node/operators');
        if (revision.current === current) setOperatorDevices(moderation.devices.filter((device) => !result.devices.some((owned) => owned.hostId === device.hostId)));
      }
    } catch (cause) { if (revision.current === current) setError(cause instanceof Error ? cause.message : 'Devices unavailable.'); }
  }, [request]);
  useEffect(() => {
    if (!active) return;
    const update = () => { if (document.visibilityState === 'visible') void refresh(); };
    const initial = setTimeout(update, 0);
    const interval = setInterval(update, invitation ? 5000 : 30000);
    document.addEventListener('visibilitychange', update);
    const invalidate = () => { revision.current++; };
    return () => { invalidate(); clearTimeout(initial); clearInterval(interval); document.removeEventListener('visibilitychange', update); };
  }, [active, refresh, invitation]);
  useEffect(() => {
    let live = true;
    const initial = setTimeout(() => { if (live) setOrigin(window.location.origin); }, 0);
    void fetch('/api/home-node/download', { method: 'HEAD' }).then((response) => { if (live && response.ok) setChecksum(response.headers.get('x-content-sha256') ?? ''); }).catch(() => {});
    return () => { live = false; clearTimeout(initial); };
  }, []);
  async function manage(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Device update failed.'); }
    finally { action.current = false; setBusy(false); }
  }
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setNotice(`${label} copied.`); }
    catch { setError('Clipboard unavailable. Select and copy the text manually.'); }
  }
  const command = installCommand(origin, checksum);
  function assignSolar(hostId: string, enabled: boolean, capacity: string) {
    const payload = solarAssignmentPayload(hostId, enabled, capacity);
    if (!payload) { setError('Declare a finite peak solar capacity above 0 and at most 1,000 kWp before opting in.'); return; }
    void manage(async () => { await request('/api/home-node/assignment', payload); });
  }
  return <section className="card home-node" id="home-node" tabIndex={-1}>
    <header className="home-node-heading"><h2>Your devices</h2><button type="button" className="button primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Close setup' : 'Add a device'}</button></header>
    {error && <p role="alert">{error} <button className="text-button" type="button" onClick={() => void refresh()}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
    {adding && <div className="home-node-setup">
      <h3>Add your Home Node</h3><p>A small Node.js 22+ app runs inside your home network. It connects your GPU through Ollama, reads solar sensors locally and reports public validator IDs. Connections are outbound; your Home Assistant token and signing key stay on your device. Up to two active devices per account, subject to the shared 50-host cap.</p>
      <h4>1 · Install and verify</h4><p>On your own computer with Node.js 22 or newer, run this command. It checks the downloaded file before you run it.</p>
      {command ? <><pre><code>{command}</code></pre><button className="text-button" type="button" onClick={() => void copy(command, 'Install command')}>Copy install command</button><details><summary>SHA-256 checksum</summary><code className="home-node-hash">{checksum}</code></details></> : <p role="status">Verified download is not available yet. Setup commands will appear when its checksum is available.</p>}
      <h4>2 · Create a private pairing code</h4>
      {invitation ? <><p>One use only · expires {new Date(invitation.expiresAt).toLocaleTimeString()}. Keep this code private; it lets your device receive assigned work, not spend from your wallet.</p><pre><code>{invitation.code}</code></pre><button type="button" className="text-button" onClick={() => void copy(invitation.code, 'Pairing code')}>Copy pairing code</button><button type="button" className="text-button" onClick={() => setInvitation(null)}>Hide code</button></> : <>
        <p>Choose where this device&apos;s future paid GPU answers go before creating its code.</p>
        <fieldset className="home-node-payout-choice" disabled={busy}><legend>GPU income goes to</legend>
          <label><input type="radio" name="pair-payout" value="own" checked={pairPayout === 'own'} disabled={!data?.ownPayoutAvailable} onChange={() => setPairPayout('own')} />My wallet</label>
          <label><input type="radio" name="pair-payout" value="building" checked={pairPayout === 'building'} disabled={!data?.buildingPayoutAvailable} onChange={() => setPairPayout('building')} />The building (tHOME stakers)</label>
        </fieldset>
        {data && !data.ownPayoutAvailable && <p>My wallet requires one verified Shares wallet on your account.</p>}
        {data && !data.buildingPayoutAvailable && <p>The building payout is unavailable until its test-network distributor is deployed.</p>}
        <button type="button" className="button primary" disabled={busy || !data?.canPair || !(pairPayout === 'own' ? data.ownPayoutAvailable : data.buildingPayoutAvailable)} onClick={() => void manage(async () => { setPairBaseline(data?.devices.map((device) => device.hostId) ?? []); setInvitation(await request('/api/local-ai/hosts/invitations', { payoutTarget: pairPayout })); })}>Create pairing code</button>
        {data && !data.canPair && <p>Pairing unavailable: verify your Shares wallet in Me.</p>}
      </>}
      <h4>3 · Connect by CLI or your AI assistant</h4><pre><code>node home-node.mjs setup</code></pre><p>The setup wizard asks for this site ({origin}), your private pairing code and local connections. Then run <code>node home-node.mjs run</code>.</p>
      <p className="small-copy">For solar, choose a daily energy sensor that resets at local midnight. Set the Home Node computer&apos;s timezone to match Home Assistant so daily production and simulated feed-in use the same local day.</p>
      <details><summary>Connect your AI assistant · MCP stdio configuration</summary><p>Replace the absolute path with your downloaded file. Add this to your assistant&apos;s MCP configuration; do not put tokens or keys in it.</p><pre><code>{mcpConfig()}</code></pre><button type="button" className="text-button" onClick={() => void copy(mcpConfig(), 'MCP configuration')}>Copy MCP configuration</button><p>Ask: “Set up my Ledger Home Node for {origin}. Pair my device, then help me configure local Ollama, solar sensors or public validator IDs.” Supply the private pairing code only to a trusted assistant.</p></details>
      {invitation && <p role="status">{pairingStatus(data?.devices ?? [], pairBaseline, invitation.expiresAt)}</p>}
    </div>}
    {data && !data.devices.length && <p>No devices connected.</p>}
    {!!data?.devices.length && <MoreList>{data.devices.map((device) => <MoreRow key={device.hostId} title={device.name} meta={`${device.solarAnomaly || device.solarAssignmentState === 'rejected' || (device.solarAssignmentState === 'pending' && data.isOperator) ? 'Needs you · ' : device.solarAssignmentState === 'pending' ? 'Waiting for approval · ' : ''}${device.state === 'active' ? device.availability : device.state}${device.state === 'revoked' ? '' : ` · ${device.payoutTarget === 'building' ? 'pays the building' : device.payoutTarget === 'own' ? 'pays your wallet' : 'pays another wallet'}`}`}>
      <HostKindBadge kind={device.kind} />
      <p><strong>GPU</strong> · {(device.capabilities?.gpuModels.length ? device.capabilities.gpuModels : device.models).join(', ') || 'No GPU models reported'}</p>
      <p><strong>{atomicDollars(device.earnings.amountAtomic)}</strong> · {device.earnings.settledAnswers} settled paid answers for this host</p>
      <p className="home-node-hash">{gpuPayoutSummary(device)}</p>
      <p className="small-copy">This choice is saved on the server until you change it or remove the device. Restarting the node or the site does not change it. Payments already reviewed keep their original payee.</p>
      {!!device.earnings.receipts?.length && <details><summary>Paid-answer receipts</summary><ul>{device.earnings.receipts.map((receipt) => <li key={receipt.txHash}><HostKindBadge kind={device.kind} /><a href={`https://explorer.testnet.chain.robinhood.com/tx/${receipt.txHash}`} target="_blank" rel="noreferrer">{atomicDollars(receipt.amountAtomic)} · {receipt.settledAt ? new Date(receipt.settledAt).toLocaleString() : 'Settlement time unavailable'}</a></li>)}</ul></details>}
      {device.latestReading ? <p><strong>Solar · {solarSummary(device.latestReading)}</strong><br /><span className="small-copy">{readingFresh(device.latestReading.timestamp) ? 'Recent signed reading' : 'Stale reading — not live'} · {new Date(device.latestReading.timestamp).toLocaleString()}</span></p> : <p className="small-copy">Solar: {device.capabilities?.solarSensors.length ? 'Waiting for a signed sensor reading' : 'No solar sensors reported'}</p>}
      <p><strong>Solar assignment · {device.solarAssignmentState}</strong>{device.peakCapacityKwp !== null && <> · declared {device.peakCapacityKwp} kWp</>}{device.dailyProductionCeilingKwh !== null && <> · ceiling {device.dailyProductionCeilingKwh} kWh/day</>}</p>
      {device.solarAssignmentState === 'pending' && <p className="small-copy">Awaiting operator approval. No simulated feed-in is paid while pending.</p>}
      {device.solarAssignmentState === 'rejected' && <p className="small-copy">Operator rejected this assignment. Revise the declaration to request a new review.</p>}
      {device.solarAnomaly && <p role="status">Production anomaly: {device.solarAnomaly.energyKwh} kWh on {device.solarAnomaly.day}, above the recorded {device.solarAnomaly.ceilingKwh} kWh ceiling. Simulated feed-in is paused; revise the capacity for operator review. Days above 100 kWh cannot be approved.</p>}
      {!!device.capabilities?.validatorIds.length && <p className="home-node-hash"><strong>Validator IDs</strong> · {device.capabilities.validatorIds.join(', ')}<br /><span className="small-copy">Public identifiers, not proof of stake ownership or verified rewards.</span></p>}
      {device.state !== 'revoked' && <div className="home-node-controls">
        <label><input type="checkbox" checked={device.payoutTarget === 'building'} disabled={busy || (device.payoutTarget === 'building' ? !data.ownPayoutAvailable : !data.buildingPayoutAvailable)} onChange={(event) => { const payoutTarget = event.target.checked ? 'building' : 'own'; void manage(async () => { await request('/api/local-ai/hosts/settings', { hostId: device.hostId, payoutTarget }); }); }} />GPU payouts to the building</label>
        <label>Declared solar peak capacity (kWp)<input type="number" inputMode="decimal" min="0.001" max="1000" step="any" value={capacities[device.hostId] ?? device.peakCapacityKwp?.toString() ?? ''} disabled={busy} onChange={(event) => setCapacities((previous) => ({ ...previous, [device.hostId]: event.target.value }))} /></label>
        <label><input type="checkbox" checked={device.assignSolarToBuilding} disabled={busy} onChange={(event) => assignSolar(device.hostId, event.target.checked, capacities[device.hostId] ?? device.peakCapacityKwp?.toString() ?? '')} />Solar income to the building · simulated feed-in</label>
        {device.assignSolarToBuilding && <button type="button" className="text-button" disabled={busy} onClick={() => assignSolar(device.hostId, true, capacities[device.hostId] ?? device.peakCapacityKwp?.toString() ?? '')}>Submit revised capacity for approval</button>}
        <p className="small-copy">Your declaration is not verified production or proof of ownership. New opt-ins and capacity changes require operator approval; income above the capacity-based ceiling is paused for review.</p>
        {data.isOperator && device.assignSolarToBuilding && <div><button type="button" className="text-button" disabled={busy || !solarApprovalAllowed(device)} onClick={() => void manage(async () => { await request('/api/home-node/approval', { hostId: device.hostId, approved: true }); })}>Approve solar assignment</button><button type="button" className="text-button" disabled={busy} onClick={() => void manage(async () => { await request('/api/home-node/approval', { hostId: device.hostId, approved: false }); })}>Reject solar assignment</button></div>}
        <label><input type="checkbox" checked={device.freePublicAnswers === true} disabled={busy} onChange={(event) => void manage(async () => { await request('/api/local-ai/hosts/settings', { hostId: device.hostId, freePublicAnswers: event.target.checked }); })} />Offer free public answers · no payout</label>
        <p className="small-copy">Off by default. Free answers share the app&apos;s rate-limited public allowance; only enable this for a model you are comfortable making public.</p>
        <p className="small-copy">Opt-ins affect future income only. Lower bound of measured production; simulated feed-in paid by this site after a completed local day with enough fresh samples. This is not a real electricity sale. Building receipts stream to staked fictional tHOME over seven days.</p>
        {(device.canSuspend || (data.isOperator && device.kind === 'community')) && <button type="button" className="text-button" disabled={busy} onClick={() => void manage(async () => { await request('/api/local-ai/hosts/suspend', { hostId: device.hostId, suspended: device.state !== 'suspended' }); })}>{device.state === 'suspended' ? 'Resume host' : 'Suspend host'}</button>}
        <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${device.name}? Its signing key will no longer work. Recorded receipts remain.`)) void manage(async () => { await request('/api/local-ai/hosts/revoke', { hostId: device.hostId }); }); }}>Remove device</button>
      </div>}
      {!!device.solarIncome.length && <details><summary>Simulated solar income receipts</summary><ul>{device.solarIncome.map((income) => <li key={income.day}>{income.day} · {income.energyKwh} kWh · {atomicDollars(income.amountAtomic)} · {income.state}{income.txHash && <> · <a href={`https://explorer.testnet.chain.robinhood.com/tx/${income.txHash}`} target="_blank" rel="noreferrer">Receipt</a></>}</li>)}</ul></details>}
    </MoreRow>)}</MoreList>}
    {data?.isOperator && <details><summary>Operator controls · other hosts &amp; solar approvals</summary>{operatorDevices.length ? operatorDevices.map((device) => <div key={device.hostId}><strong>{device.name}</strong><HostKindBadge kind={device.kind} /> · {device.state} · {device.availability}<p>Solar assignment · {device.solarAssignmentState} · declared {device.peakCapacityKwp ?? '—'} kWp</p>{device.aboveCeiling ? <p>Above declared capacity — paused for review</p> : device.pausedForReview && <p>Paused for operator review. The revised declaration is within the ceiling.</p>}{device.assignSolarToBuilding && <><button className="text-button" type="button" disabled={busy || !operatorSolarApprovalAllowed(device)} onClick={() => void manage(async () => { await request('/api/home-node/approval', { hostId: device.hostId, approved: true }); })}>Approve solar assignment</button><button className="text-button" type="button" disabled={busy} onClick={() => void manage(async () => { await request('/api/home-node/approval', { hostId: device.hostId, approved: false }); })}>Reject solar assignment</button></>}{device.canSuspend && <button className="text-button" type="button" disabled={busy} onClick={() => void manage(async () => { await request('/api/local-ai/hosts/suspend', { hostId: device.hostId, suspended: device.state !== 'suspended' }); })}>{device.state === 'suspended' ? 'Resume community host' : 'Suspend community host'}</button>}</div>) : <p>No other hosts to manage. Your own hosts&apos; approvals are on their cards above.</p>}</details>}
  </section>;
}
