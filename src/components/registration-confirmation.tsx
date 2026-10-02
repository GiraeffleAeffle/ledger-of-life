'use client';
import { useState } from 'react';

/** Required registration particulars exist only in component memory and the browser print document. */
export function RegistrationConfirmation() {
  const [open, setOpen] = useState(false);
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
  return <section className="registration-confirmation" aria-label="Registration confirmation">
    <button className="button secondary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Print registration confirmation</button>
    {open && <>
    <p>Wohnungsgeberbestätigung (§19 BMG). The landlord fills this in and prints it for signing. Nothing in this form is saved, uploaded or sent to the server. Use Clear form to erase the fields.</p>
    <p>The tenant takes the signed confirmation to the Bürgeramt, generally within two weeks of moving in. Check the authority’s requirements; this sample is not legal advice.</p>
    <form className="listing-form" onSubmit={print} autoComplete="off">
      {Object.entries(labels).map(([key, label]) => <label className="wide" key={key}>{label}<input type={key === 'movedIn' ? 'date' : 'text'} required={key !== 'owner'} maxLength={500} value={fields[key as keyof typeof fields]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>)}
      <button className="button secondary" type="submit">Print confirmation in this browser</button>
      <button className="button secondary" type="button" onClick={() => setFields({ landlord: '', landlordAddress: '', owner: '', homeAddress: '', tenants: '', movedIn: '' })}>Clear form</button>
    </form>
    </>}
  </section>;
}
