'use client';
import { useState, type FormEvent } from 'react';
import type { PublicAdapterConfig } from '@/server/adapters';
import type { AuthorizedRequest } from './use-city-signals';
import { ADAPTER_CONFIG_CHANGED, type useAdapterConfig } from './use-adapter-config';

type AdapterKind = 'homeAssistant' | 'validator';
type Change = (kind: AdapterKind, body: Record<string, unknown>) => Promise<PublicAdapterConfig>;

function HomeAssistantForm({ saved, disabled, change }: {
  saved: PublicAdapterConfig['homeAssistant']; disabled: boolean; change: Change;
}) {
  const [form, setForm] = useState({
    url: saved?.url ?? 'http://homeassistant.local:8123', token: '',
    entity: saved?.entity ?? '', pricePerKwh: String(saved?.pricePerKwh ?? 0.3),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const config = await change('homeAssistant', body);
      setForm({ url: config.homeAssistant?.url ?? 'http://homeassistant.local:8123', token: '',
        entity: config.homeAssistant?.entity ?? '', pricePerKwh: String(config.homeAssistant?.pricePerKwh ?? 0.3) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update Home Assistant.');
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({ url: form.url, token: form.token, entity: form.entity, pricePerKwh: Number(form.pricePerKwh) });
  }
  return <form className="inline-form" onSubmit={save}>
    <label>Home Assistant address<input type="url" required value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} autoComplete="url" disabled={disabled || busy} /></label>
    <p className="small-copy">The token is not limited to reading. It has its Home Assistant creator&apos;s permissions and is stored as plain data; the app operator can read and use it. Create it under a dedicated low-privilege Home Assistant user.</p>
    <label>Long-lived access token<input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} placeholder={saved ? 'Leave blank to keep saved token' : 'Profile → Security → create token'} autoComplete="off" disabled={disabled || busy} /></label>
    {saved && <p className="small-copy">Leave the token blank to keep the saved token for this connection. Enter a new token to replace it; it is never displayed here.</p>}
    <label>Sensor (optional)<input value={form.entity} onChange={(event) => setForm({ ...form, entity: event.target.value })} placeholder="sensor.solar_energy_today" disabled={disabled || busy} /></label>
    <label>Assumed value per kWh (€)<input type="number" inputMode="decimal" min="0.01" max="4.99" step="any" value={form.pricePerKwh} onChange={(event) => setForm({ ...form, pricePerKwh: event.target.value })} disabled={disabled || busy} /></label>
    <button className="button primary" disabled={disabled || busy}>{busy ? 'Saving…' : 'Save Home Assistant'}</button>
    {saved && <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void submit({ remove: true })}>Remove Home Assistant</button>}
    {error && <p role="alert">{error}</p>}
  </form>;
}

function ValidatorForm({ saved, disabled, change }: {
  saved: PublicAdapterConfig['validator']; disabled: boolean; change: Change;
}) {
  const [form, setForm] = useState({ chain: saved?.chain ?? 'gnosis', id: saved?.id ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const config = await change('validator', body);
      setForm({ chain: config.validator?.chain ?? 'gnosis', id: config.validator?.id ?? '' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the validator.');
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(form);
  }
  return <form className="inline-form" onSubmit={save}>
    <label>Network<select value={form.chain} onChange={(event) => { const chain = event.target.value; if (chain === 'gnosis' || chain === 'ethereum' || chain === 'solana') setForm({ ...form, chain }); }} disabled={disabled || busy}><option value="gnosis">Gnosis</option><option value="ethereum">Ethereum</option><option value="solana">Solana</option></select></label>
    <label>{form.chain === 'solana' ? 'Vote account' : 'Validator index or public key'}<input required value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} disabled={disabled || busy} /></label>
    <button className="button primary" disabled={disabled || busy}>{busy ? 'Saving…' : 'Save validator'}</button>
    {saved && <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void submit({ remove: true })}>Remove validator</button>}
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function AdapterSettings({ request, connection }: { request: AuthorizedRequest; connection: ReturnType<typeof useAdapterConfig> }) {
  const { config, homeAssistantPull, loading, error, refresh } = connection;
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState({ homeAssistant: '', validator: '' });
  const change: Change = async (kind, body) => {
    if (pending || loading || error || !config) throw new Error('Read your current adapter settings before changing them.');
    setPending(true);
    setMessages((previous) => ({ ...previous, [kind]: '' }));
    try {
      const result = await request<{ adapters: PublicAdapterConfig }>('/api/adapters', { kind, ...body });
      setMessages((previous) => ({ ...previous, [kind]: kind === 'homeAssistant'
        ? body.remove === true ? 'Connection removed from this ledger. Revoke the token in Home Assistant if it is no longer needed.' : 'Home Assistant settings saved.'
        : body.remove === true ? 'Validator removed.' : 'Validator settings saved.' }));
      window.dispatchEvent(new Event(ADAPTER_CONFIG_CHANGED));
      return result.adapters;
    } finally {
      setPending(false);
    }
  };
  const unavailable = Boolean(error) || (!loading && !config);
  const status = unavailable ? 'Configuration unavailable' : loading && !config ? 'Loading…' : '';
  const canEdit = Boolean(config);
  return <section id="adapter-settings" tabIndex={-1} aria-label="Adapter settings">
    {error && <p role="alert">Could not load adapter settings: {error} <button type="button" className="text-button" onClick={() => void refresh()}>Retry</button></p>}
    <details className="asset-tile">
      <summary id="adapter-home-assistant" tabIndex={0}>Home Assistant · {status || (!homeAssistantPull ? 'Unavailable on this host' : config?.homeAssistant ? 'Configured' : 'Not configured')}</summary>
      {homeAssistantPull && <p className="small-copy">This app only reads your solar and consumption sensors. The access token you paste is <strong>not limited to reading</strong>: it can do whatever the Home Assistant user who created it can do. It is kept on the server as plain data, so the host of this app can read and use it. Create a dedicated low-privilege Home Assistant user for it, and delete the token in Home Assistant (Profile → Security) when you remove it here. Tariff-derived amounts are estimates, not bills.</p>}
      {canEdit && (homeAssistantPull
        ? <HomeAssistantForm key={JSON.stringify(config!.homeAssistant) ?? 'none'} saved={config!.homeAssistant} disabled={loading || pending || Boolean(error)} change={change} />
        : config!.homeAssistant
          ? <div><p className="small-copy">Saved address: {config!.homeAssistant.url}. This host does not connect to Home Assistant. The saved connection cannot be used here.</p>
            <button type="button" className="text-button" disabled={loading || pending || Boolean(error)} onClick={() => void change('homeAssistant', { remove: true }).catch((cause) => setMessages((previous) => ({ ...previous, homeAssistant: cause instanceof Error ? cause.message : 'Could not remove Home Assistant.' })))}>Remove Home Assistant</button></div>
          : <p className="small-copy">This host does not connect to Home Assistant, because that would let this server reach into a home network. Run Ledger of Life on your own network to connect it.</p>)}
      {messages.homeAssistant && <p role="status">{messages.homeAssistant}</p>}
    </details>
    <details className="asset-tile">
      <summary id="adapter-validator" tabIndex={0}>Validator · {status || (config?.validator ? 'Configured' : 'Not configured')}</summary>
      <p className="small-copy">Read-only public validator information. A supplied identifier is not proof of ownership; saving it does not verify current status or rewards.</p>
      {canEdit && <ValidatorForm key={JSON.stringify(config!.validator) ?? 'none'} saved={config!.validator} disabled={loading || pending || Boolean(error)} change={change} />}
      {messages.validator && <p role="status">{messages.validator}</p>}
    </details>
  </section>;
}
