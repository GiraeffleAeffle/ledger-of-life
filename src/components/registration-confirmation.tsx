'use client';
import { useState } from 'react';
import { MoreRow } from './blocks';
import './move-in.css';

/** Required registration particulars exist only in component memory and the browser print document. */
export function RegistrationConfirmation() {
  const [fields, setFields] = useState({ landlord: '', landlordAddress: '', owner: '', homeAddress: '', tenants: '', movedIn: '' });
  const labels: Record<keyof typeof fields, string> = { landlord: 'Landlord / housing provider name', landlordAddress: 'Housing provider address', owner: 'Owner name (if different from the housing provider)', homeAddress: 'Dwelling address (include floor / flat where needed)', tenants: 'Names of all people moving in', movedIn: 'Move-in date' };
  function print(event: React.FormEvent) {
    event.preventDefault();
    const frame = document.createElement('iframe');
    frame.title = 'Browser-only registration confirmation';
    frame.style.display = 'none';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const heading = doc.createElement('h1');
    heading.textContent = 'Wohnungsgeberbestätigung · §19 BMG';
    doc.body.append(heading);
    for (const [key, value] of Object.entries(fields)) {
      const row = doc.createElement('p');
      row.textContent = `${labels[key as keyof typeof fields]}: ${value || 'Not supplied'}`;
      doc.body.append(row);
    }
    const declaration = doc.createElement('p');
    declaration.textContent = 'The housing provider confirms the move-in of the people listed above into the dwelling listed above on the stated date.';
    doc.body.append(declaration);
    const signature = doc.createElement('p');
    signature.style.marginTop = '4em';
    signature.textContent = 'Place, date and housing provider signature: __________________________________';
    doc.body.append(signature);
    const note = doc.createElement('p');
    note.textContent = 'Take the signed confirmation to the Bürgeramt for registration, generally within two weeks of moving in. Check the local authority’s requirements. This sample is not legal advice or an official municipal form.';
    doc.body.append(note);
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
  }
  return <MoreRow title="Print registration confirmation" meta="Landlord · browser only">
    <section className="registration-confirmation" aria-label="Registration confirmation">
    <p className="small-copy">Wohnungsgeberbestätigung (§19 BMG), for the landlord to print and sign. Nothing is saved or sent to the server. Clear form erases these fields.</p>
    <p className="small-copy">Take the signed form to the Bürgeramt, generally within two weeks. Check the local authority’s requirements; this sample is not legal advice.</p>
    <form className="listing-form" onSubmit={print} autoComplete="off">
      {Object.entries(labels).map(([key, label]) => <label className="wide" key={key}>{label}<input type={key === 'movedIn' ? 'date' : 'text'} required={key !== 'owner'} maxLength={500} value={fields[key as keyof typeof fields]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>)}
      <button className="button secondary" type="submit">Print confirmation in this browser</button>
      <button className="button secondary" type="button" onClick={() => setFields({ landlord: '', landlordAddress: '', owner: '', homeAddress: '', tenants: '', movedIn: '' })}>Clear form</button>
    </form>
    </section>
  </MoreRow>;
}
