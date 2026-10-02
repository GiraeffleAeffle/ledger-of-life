'use client';
import { useState } from 'react';
import type { HandoverRecord, MeterReading } from '../server/move-in';
import { RegistrationConfirmation } from './registration-confirmation';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export function MoveInHandover({ agreementId, role, initial, request }: { agreementId: string; role: 'tenant' | 'landlord'; initial?: HandoverRecord; request: Request }) {
  const [record, setRecord] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [date, setDate] = useState(() => initial?.readings[0]?.date ?? new Date().toISOString().slice(0, 10));
  const [values, setValues] = useState<Record<MeterReading['meter'], string>>(() => ({ electricity: String(initial?.readings.find((r) => r.meter === 'electricity')?.value ?? ''), gas: String(initial?.readings.find((r) => r.meter === 'gas')?.value ?? ''), water: String(initial?.readings.find((r) => r.meter === 'water')?.value ?? '') }));
  const [gasUnit, setGasUnit] = useState<'m³' | 'kWh'>(() => initial?.readings.find((r) => r.meter === 'gas')?.unit ?? 'm³');
  const [rooms, setRooms] = useState(() => initial?.rooms ?? [{ room: 'Living room', note: '' }]);
  async function submit(action: 'handover_save' | 'handover_confirm') {
    setBusy(true); setError('');
    try {
      const readings = (Object.entries(values) as [MeterReading['meter'], string][]).filter(([, value]) => value.trim()).map(([meter, value]) => ({ meter, value: Number(value), unit: meter === 'electricity' ? 'kWh' : meter === 'gas' ? gasUnit : 'm³', date }));
      const { agreement } = await request<{ agreement: { handover: HandoverRecord } }>(`/api/agreements/${encodeURIComponent(agreementId)}`, { action, revision: record?.revision, ...(action === 'handover_save' ? { readings, rooms: rooms.filter((row) => row.note.trim()) } : {}) });
      setRecord(agreement.handover); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Handover could not be saved.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError('');
    try {
      const { agreement } = await request<{ agreement: { handover?: HandoverRecord } }>(`/api/agreements/${encodeURIComponent(agreementId)}`);
      setRecord(agreement.handover); setEditing(!agreement.handover);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Handover could not be read.'); }
    finally { setBusy(false); }
  }
  if (record?.confirmed.tenant && record.confirmed.landlord) return <>
    <p className="handover-status" role="status">Move-in handover · confirmed by both parties</p>
    {role === 'landlord' && <RegistrationConfirmation />}
  </>;
  return <section className="move-in-handover" aria-label="Move-in handover">
    <h3>Move-in handover · readings &amp; room notes</h3>
    <p>Shared with this agreement’s parties. Record only meter numbers, units, dates and short room notes. No names, addresses, photos or documents. These are entered by the parties, not verified sensor readings.</p>
    <button className="button secondary" type="button" disabled={busy} onClick={() => { if (!editing || window.confirm('Discard your unsaved edits and read the latest shared handover?')) void refresh(); }}>Read latest shared handover</button>
    {record && <>
      <p role="status"><strong>{record.confirmed.tenant && record.confirmed.landlord ? 'Confirmed by both parties' : 'Waiting for both parties to confirm'}</strong> · Tenant: {record.confirmed.tenant ? 'confirmed' : 'waiting'} · Landlord: {record.confirmed.landlord ? 'confirmed' : 'waiting'}</p>
      <ul>{record.readings.map((row) => <li key={row.meter}>{row.meter}: {row.value} {row.unit} · {row.date}</li>)}{record.rooms.map((row, index) => <li key={index}><strong>{row.room}</strong>: {row.note}</li>)}</ul>
      {!editing && <div className="move-in-actions"><button className="button secondary" type="button" disabled={busy || Boolean(record.confirmed[role])} onClick={() => void submit('handover_confirm')}>Confirm this handover as {role}</button><button className="button secondary" type="button" onClick={() => { setValues({ electricity: String(record.readings.find((r) => r.meter === 'electricity')?.value ?? ''), gas: String(record.readings.find((r) => r.meter === 'gas')?.value ?? ''), water: String(record.readings.find((r) => r.meter === 'water')?.value ?? '') }); setDate(record.readings[0]?.date ?? new Date().toISOString().slice(0, 10)); setGasUnit(record.readings.find((r) => r.meter === 'gas')?.unit ?? 'm³'); setRooms(record.rooms); setEditing(true); }}>Revise readings or notes</button></div>}
    </>}
    {editing && <form className="listing-form" onSubmit={(event) => { event.preventDefault(); void submit('handover_save'); }}>
      <p className="wide small-copy">Saving a revision clears both confirmations. Each party must review and confirm the same new record. Leave absent meters blank.</p>
      <label>Reading date<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
      {(['electricity', 'gas', 'water'] as const).map((meter) => <label key={meter}>{meter} ({meter === 'electricity' ? 'kWh' : meter === 'gas' ? gasUnit : 'm³'})<input type="number" min="0" max="1000000000" step="any" value={values[meter]} onChange={(event) => setValues({ ...values, [meter]: event.target.value })} /></label>)}
      <label>Gas unit<select value={gasUnit} onChange={(event) => setGasUnit(event.target.value as 'm³' | 'kWh')}><option>m³</option><option>kWh</option></select></label>
      {rooms.map((row, index) => <div className="wide handover-room" key={index}><label>Room<input maxLength={60} value={row.room} onChange={(event) => setRooms(rooms.map((item, i) => i === index ? { ...item, room: event.target.value } : item))} /></label><label>Short note<textarea maxLength={500} rows={2} value={row.note} onChange={(event) => setRooms(rooms.map((item, i) => i === index ? { ...item, note: event.target.value } : item))} /></label><button type="button" className="text-button" onClick={() => setRooms(rooms.filter((_, i) => i !== index))}>Remove room</button></div>)}
      <div className="wide move-in-actions"><button type="button" className="button secondary" disabled={rooms.length >= 12} onClick={() => setRooms([...rooms, { room: '', note: '' }])}>Add room note</button><button className="button primary" disabled={busy}>Save shared handover</button></div>
    </form>}
    {error && <p className="note" role="alert">{error}</p>}
    {role === 'landlord' && <RegistrationConfirmation />}
  </section>;
}
