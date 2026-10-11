import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { classifyDocumentOrigin as classifyOrigin, type DocumentOriginOptions } from '../src/document-origin.ts';
import { DocumentOriginSchema, DOCUMENT_ORIGIN_CLASSIFIER_VERSION, type DocumentOriginInput } from '../src/document-origin-contract.ts';
import { MAX_DOCUMENT_BYTES, type DocumentCommand } from '../src/district-document.ts';
import { mkdtemp, rm, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { provisionCivicPolicyAuthority, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import type { CivicPolicyAuthorityReceipt } from '../src/civic-opt-out.ts';

let testDirectory: string;
let fixtureAuthority: CivicPolicyAuthorityReceipt;
before(async () => {
  testDirectory = await realpath(await mkdtemp(join(tmpdir(), 'document-origin-test-')));
  fixtureAuthority = await provisionCivicPolicyAuthority({ stateDir: join(testDirectory, 'policy-state'), authorityId: `fixture:${randomUUID()}` });
});
after(async () => { if (testDirectory) await rm(testDirectory, { recursive: true, force: true }); });

// Every PDF test enters a real managed scratch lease under an explicitly provisioned test authority.
async function classifyDocumentOrigin(source: DocumentOriginInput, options: DocumentOriginOptions = {}) {
  return classifyOrigin(source, {
    ...options,
    scratch: options.scratch ?? {
      root: join(testDirectory, 'fetch'), kind: 'fetch', decisionId: CIVIC_ACQUISITION_DECISION_ID,
      stateDir: join(testDirectory, 'policy-state'), authorityId: fixtureAuthority.authorityId, authoritySha256: fixtureAuthority.authoritySha256,
      bindings: [{ phase: 'pre-admission', url: source.url, sourceSha256: createHash('sha256').update(source.bytes).digest('hex') }],
    },
  });
}

const url = 'https://www.beispielstadt.de/rat/vorlage.pdf';
const neutral = 'Informationen zur Entwicklung des Quartiers und zur weiteren Beratung in der kommenden Sitzung.';
const official = `Stadtverwaltung Beispielstadt\nBeschlussvorlage\n${neutral}`;
const input = (text: string, extra: Partial<DocumentOriginInput> = {}): DocumentOriginInput => ({ url, mimeType: 'text/plain', bytes: Buffer.from(text), ...extra });

/** Real PDF objects, compressed first-page text, and separate Info author/producer fields. */
function originPdf(text: string, metadata: { author?: string; producer?: string; title?: string } = {}): Buffer {
  const literal = (value: string) => value.replace(/[\\()]/g, '\\$&');
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 40 760 Td 16 TL\n${text.split('\n').map(line => `(${literal(line)}) Tj T*`).join('\n')}\nET`, 'latin1'));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from(`<< ${Object.entries(metadata).map(([key, value]) => `/${key[0].toUpperCase() + key.slice(1)} (${literal(value)})`).join(' ')} >>`, 'latin1'),
  ];
  const chunks = [Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'latin1')], offsets: number[] = [];
  let offset = chunks[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('formal administrative work is URL/source-SHA bound with safe versioned evidence', async () => {
  const source = input(official);
  const result = await classifyDocumentOrigin(source);
  assert.equal(result.classification, 'official_work');
  assert.equal(result.method, 'rules');
  assert.equal(result.classifierVersion, DOCUMENT_ORIGIN_CLASSIFIER_VERSION);
  assert.equal(result.url, url);
  assert.equal(result.sha256, createHash('sha256').update(source.bytes).digest('hex'));
  assert.ok(Number.isFinite(Date.parse(result.classifiedAt)));
  assert.deepEqual(DocumentOriginSchema.parse(result), result);
  assert.ok(result.evidence.some(item => item.value === 'explicit_administrative_origin'));
  assert.equal(JSON.stringify(result.evidence).includes('Beispielstadt'), false);
  const otherUrl = await classifyDocumentOrigin({ ...source, url: 'https://www.beispielstadt.de/other.pdf' });
  const otherBytes = await classifyDocumentOrigin(input(`${official}\nBeschlossen.`));
  assert.equal(otherUrl.sha256, result.sha256);
  assert.notEqual(otherUrl.url, result.url);
  assert.notEqual(otherBytes.sha256, result.sha256);
});

test('official host, city name, generic labels and commission alone do not establish official origin', async () => {
  for (const source of [
    input(neutral, { title: 'Beschlussvorlage', municipalityName: 'Beispielstadt' }),
    input(`Stadt Beispielstadt\nBeschlussvorlage\n${neutral}`),
    input(`Im Auftrag der Stadtverwaltung Beispielstadt\nBeschlussvorlage\n${neutral}`),
    input(neutral, { title: 'Stadtverwaltung Beispielstadt Beschlussvorlage' }),
    input(neutral, { title: 'Satzung', administrativeOriginEvidence: 'https://www.beispielstadt.de' }),
    input(`Stadtverwaltung Beispielstadt\n${neutral}`),
  ]) assert.equal((await classifyDocumentOrigin(source)).classification, 'unknown');
});

test('formal link titles need inspected issuer evidence, not unbound administrative context', async () => {
  for (const administrativeOriginEvidence of ['Stadt Beispielstadt', ['Herausgeber: Stadt Beispielstadt']]) {
    const result = await classifyDocumentOrigin(input(neutral, { linkText: 'Satzung', administrativeOriginEvidence }));
    assert.equal(result.classification, 'unknown');
  }
  assert.equal((await classifyDocumentOrigin(input(`Herausgeber: Stadt Beispielstadt\n${neutral}`, { linkText: 'Satzung' }))).classification, 'official_work');
  assert.equal((await classifyDocumentOrigin(input(`Herausgeber: Gemeinde Beispielort\nAmtliche Bekanntmachung\n${neutral}`))).classification, 'official_work');
});

test('third-party titles, copyright, press, photographs and vendor maps remain third-party', async () => {
  for (const title of ['Gutachten zur Stadtentwicklung', 'Machbarkeitsstudie', 'Presseartikel', 'Pressemitteilung', 'Pressefoto', 'Stadtplan Google Maps', 'Karte ESRI', 'Projekt Plan GmbH']) {
    assert.equal((await classifyDocumentOrigin(input(neutral, { title }))).classification, 'third_party', title);
  }
  for (const notice of ['© Plan GmbH 2026', 'Copyright 2026', 'Alle Rechte vorbehalten', 'Verfasser: Plan GmbH', 'Ingenieurbüro Beispiel', 'Foto: Fotografin Beispiel', 'Kartengrundlage: OpenStreetMap']) {
    assert.equal((await classifyDocumentOrigin(input(`${neutral}\n${notice}`))).classification, 'third_party', notice);
  }
});

test('commissioned consultant study is not upgraded by the municipal commissioner', async () => {
  const result = await classifyDocumentOrigin(input(`Gutachten\nIm Auftrag der Stadtverwaltung Beispielstadt\nVerfasser: Plan GmbH\n${neutral}`));
  assert.equal(result.classification, 'third_party');
});

test('formal official material with third-party attachments or rights indicators is mixed', async () => {
  for (const attachment of ['Anlage: Gutachten', '© Plan GmbH 2026', 'Foto: Bildagentur Beispiel', 'Karte OpenStreetMap']) {
    assert.equal((await classifyDocumentOrigin(input(`${official}\n${attachment}`))).classification, 'mixed');
  }
});

test('HTML content is classified without treating navigation/footer boilerplate as authorship', async () => {
  const boilerplate = `<html><head><title>Beschlussvorlage</title></head><body><header>Stadtverwaltung Beispielstadt</header><main><p>${neutral}</p></main><footer>Herausgeber: Stadt Beispielstadt</footer></body></html>`;
  assert.equal((await classifyDocumentOrigin(input(boilerplate, { mimeType: 'text/html; charset=utf-8' }))).classification, 'unknown');
  const municipal = `<html><title>Satzung</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>${neutral}</p></main></html>`;
  assert.equal((await classifyDocumentOrigin(input(municipal, { mimeType: 'application/xhtml+xml' }))).classification, 'official_work');
  assert.equal((await classifyDocumentOrigin(input(`<html><main>${neutral}<p>&copy; Plan GmbH</p></main></html>`, { mimeType: 'text/html' }))).classification, 'third_party');
});

test('real administration PDFs retain official origin despite commercial software Producer', async () => {
  for (const producer of ['Adobe PDF Library 17.0', 'Microsoft Word', 'PDF-XChange Core API SDK by Tracker Software Products Ltd']) {
    const bytes = originPdf(official, { author: 'Stadt Beispielstadt', producer });
    assert.equal(bytes.includes(Buffer.from('Beschlussvorlage')), false);
    const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes });
    assert.equal(result.classification, 'official_work', producer);
    assert.ok(result.evidence.some(item => item.locator === 'pdf.producer' && item.value === 'producer_present_not_authorship'));
    assert.equal(JSON.stringify(result.evidence).includes(producer), false);
  }
});

test('real PDF Author and Title metadata identify external authors independently of producer', async () => {
  for (const metadata of [{ author: 'Plan GmbH' }, { title: 'Gutachten zum Stadtquartier' }, { author: 'Ingenieurbuero Beispiel GmbH', producer: 'Microsoft Word' }]) {
    const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(neutral, metadata) });
    assert.equal(result.classification, 'third_party');
  }
  const mixed = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(official, { author: 'Plan GmbH' }) });
  assert.equal(mixed.classification, 'mixed');
  const copyright = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(`${neutral}\n© Plan GmbH 2026`) });
  assert.equal(copyright.classification, 'third_party');
});

test('unknown personal PDF authors never become public evidence or unsupported official assertions', async () => {
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(official, { author: 'Private Person private@example.org', producer: 'Vendor Software' }) });
  assert.equal(result.classification, 'unknown');
  const published = JSON.stringify(result);
  for (const privateValue of ['Private Person', 'private@example.org', 'Vendor Software', neutral]) assert.equal(published.includes(privateValue), false);
});

test('PDF inspection calls existing local utilities for metadata and only page one', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const command: DocumentCommand = async (file, args) => {
    calls.push({ file, args });
    if (file === 'pdfinfo') return 'Pages: 12\nAuthor: Stadt Beispielstadt\nProducer: Plan GmbH Software\n';
    if (file === 'pdftotext') return `${official}\f`;
    throw Error('Unexpected command');
  };
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(official) }, { command });
  assert.equal(result.classification, 'official_work');
  assert.deepEqual(calls.map(call => call.file), ['pdfinfo', 'pdftotext']);
  assert.deepEqual(calls[1].args.slice(0, 6), ['-f', '1', '-l', '1', '-enc', 'UTF-8']);
});

test('empty PDF metadata fields do not consume the next metadata line', async () => {
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(official) }, { command: async file => file === 'pdfinfo' ? 'Pages: 1\nAuthor:   \nProducer: Vendor Software GmbH\nTitle: \n' : official });
  assert.equal(result.classification, 'official_work');
  assert.equal(result.evidence.some(item => item.locator === 'pdf.author'), false);
});

test('PDF parse/page/metadata limits fail explicitly unknown even with official caller context', async () => {
  const source: DocumentOriginInput = { url, mimeType: 'application/pdf', bytes: originPdf(official), title: 'Satzung', administrativeOriginEvidence: 'Stadt Beispielstadt' };
  const cases: [string, DocumentCommand][] = [
    ['parse_or_tool_failure', async () => { throw Error('secret source text parser stderr'); }],
    ['page_count_unavailable', async () => 'Pages: invalid'],
    ['page_count_limit', async () => 'Pages: 81'],
    ['encrypted_pdf', async () => 'Pages: 1\nEncrypted: yes'],
    ['metadata_size_limit', async () => 'x'.repeat(64 * 1024 + 1)],
    ['metadata_field_limit', async file => file === 'pdfinfo' ? `Pages: 1\nAuthor: ${'x'.repeat(4097)}` : official],
    ['first_page_size_limit', async file => file === 'pdfinfo' ? 'Pages: 1' : 'x'.repeat(32 * 1024 + 1)],
    ['first_page_insufficient_text', async file => file === 'pdfinfo' ? 'Pages: 1' : ''],
  ];
  for (const [reason, command] of cases) {
    const result = await classifyDocumentOrigin(source, { command });
    assert.equal(result.classification, 'unknown', reason);
    assert.ok(result.evidence.some(item => item.value === reason), reason);
    assert.equal(JSON.stringify(result).includes('secret source text'), false);
  }
});

test('actual malformed PDFs fail closed rather than trusting a caller title', async () => {
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: Buffer.from('%PDF-invalid'), title: 'Satzung', administrativeOriginEvidence: 'Stadt Beispielstadt' });
  assert.equal(result.classification, 'unknown');
  assert.ok(result.evidence.some(item => item.value === 'parse_or_tool_failure'));
});

test('byte, text, HTML, context, decoding and unsupported format failures remain explicit unknown', async () => {
  const cases: [DocumentOriginInput, string][] = [
    [input(''), 'source_size_limit'],
    [input('', { bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }), 'source_size_limit'],
    [input('x'.repeat(32 * 1024 + 1)), 'first_page_size_limit'],
    [input('x'.repeat(128 * 1024 + 1), { mimeType: 'text/html' }), 'html_size_limit'],
    [input(neutral, { title: 'x'.repeat(4097) }), 'context_size_limit'],
    [input(neutral, { administrativeOriginEvidence: Array(9).fill('Stadt Beispielstadt') }), 'context_size_limit'],
    [input('tiny'), 'first_page_insufficient_text'],
    [input(neutral, { mimeType: 'application/zip' }), 'unsupported_mime_type'],
    [input('', { bytes: Buffer.from([0xc3, 0x28]) }), 'parse_or_tool_failure'],
  ];
  for (const [source, reason] of cases) {
    const result = await classifyDocumentOrigin(source);
    assert.equal(result.classification, 'unknown', reason);
    assert.deepEqual(result.evidence, [{ locator: 'inspection', value: reason }]);
  }
});

test('first-page scope is explicit and later-page text is not treated as inspected evidence', async () => {
  const result = await classifyDocumentOrigin(input(`${neutral}\f${official}`));
  assert.equal(result.classification, 'unknown');
  assert.equal(result.evidence.some(item => item.value === 'explicit_administrative_origin'), false);
});

test('repeated context cannot inflate or leak the public evidence payload', async () => {
  const context = 'Herausgeber: Stadt Beispielstadt\nGutachten © Consultant GmbH\nFoto: Private Person private@example.org\nKarte Google Maps';
  const result = await classifyDocumentOrigin(input(official, { title: context, linkText: context, administrativeOriginEvidence: Array(8).fill(context) }));
  assert.equal(result.classification, 'mixed');
  assert.ok(result.evidence.length <= 64);
  assert.equal(new Set(result.evidence.map(item => JSON.stringify(item))).size, result.evidence.length);
  assert.equal(JSON.stringify(result.evidence).includes('private@example.org'), false);
  for (const item of result.evidence) { assert.ok(item.value.length <= 160); assert.ok(item.locator.length <= 100); }
  assert.equal(DocumentOriginSchema.safeParse({ ...result, method: 'model' }).success, false);
  assert.equal(DocumentOriginSchema.safeParse({ ...result, sha256: 'unbound' }).success, false);
  assert.equal(DocumentOriginSchema.safeParse({ ...result, rawText: official }).success, false);
});

test('administrative HTML navigation needs its own institutional publisher or explicitly named service', async () => {
  for (const html of [
    `<html><title>Sitzungskalender</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>${neutral}</p></main></html>`,
    `<html><head><title>Ratsinformationssystem</title><meta name="publisher" content="Stadt Beispielstadt"></head><body><main>${neutral}</main></body></html>`,
    `<html><title>Ratsinformationssystem der Stadt Beispielstadt</title><main>${neutral}</main></html>`,
    `<html><main><h1>Sitzungstermine</h1><p>Stadtverwaltung Beispielstadt</p><p>${neutral}</p></main></html>`,
  ]) {
    const result = await classifyDocumentOrigin(input(html, { mimeType: 'text/html' }));
    assert.equal(result.classification, 'official_work');
    assert.ok(result.evidence.some(item => item.value === 'administrative_navigation_container'));
  }
  for (const source of [
    input(`<html><title>Sitzungskalender</title><main>${neutral}</main></html>`, { mimeType: 'text/html', municipalityName: 'Beispielstadt' }),
    input(`<html><title>Sitzungskalender</title><main>${neutral}</main><footer>Herausgeber: Stadt Beispielstadt</footer></html>`, { mimeType: 'text/html' }),
    input(`<html><main>${neutral}</main></html>`, { mimeType: 'text/html', title: 'Ratsinformationssystem der Stadt Beispielstadt' }),
  ]) assert.equal((await classifyDocumentOrigin(source)).classification, 'unknown');
});

test('OParl administrative containers require typed structure plus actual institution evidence', async () => {
  const body = { id: 'https://www.beispielstadt.de/oparl/body/1', type: 'https://schema.oparl.org/1.1/Body', name: 'Stadt Beispielstadt' };
  for (const data of [body, { data: [body], links: { self: 'https://www.beispielstadt.de/oparl/bodies' } }]) {
    const result = await classifyDocumentOrigin(input(JSON.stringify(data), { mimeType: 'application/json' }));
    assert.equal(result.classification, 'official_work');
    assert.ok(result.evidence.some(item => item.locator === 'oparl.publisher'));
    assert.equal(JSON.stringify(result.evidence).includes(body.name), false);
  }
  const meeting = { id: 'https://www.beispielstadt.de/oparl/meeting/1', type: 'https://schema.oparl.org/1.0/Meeting', name: 'Beratung des Hauptausschusses', body: body.id };
  const withoutIssuer = await classifyDocumentOrigin(input(JSON.stringify(meeting), { mimeType: 'application/json', municipalityName: 'Beispielstadt' }));
  assert.equal(withoutIssuer.classification, 'unknown');
  const withIssuer = await classifyDocumentOrigin(input(JSON.stringify({ data: [meeting] }), { mimeType: 'application/ld+json', administrativeOriginEvidence: body.name }));
  assert.equal(withIssuer.classification, 'unknown');
  const system = { id: 'https://www.beispielstadt.de/oparl', type: 'https://schema.oparl.org/1.1/System', name: 'Kommunale Ratsinformation', body: body.id };
  assert.equal((await classifyDocumentOrigin(input(JSON.stringify(system), { mimeType: 'application/json' }))).classification, 'unknown');
  assert.equal((await classifyDocumentOrigin(input(JSON.stringify({ ...system, publisher: body.name }), { mimeType: 'application/json' }))).classification, 'official_work');
});

test('container origin never upgrades consultant attachments, external publishers or arbitrary JSON', async () => {
  const publisher = 'Stadt Beispielstadt';
  const meeting = { id: 'https://www.beispielstadt.de/oparl/meeting/1', type: 'https://schema.oparl.org/1.1/Meeting', publisher, name: 'Beratung im Hauptausschuss' };
  assert.equal((await classifyDocumentOrigin(input(JSON.stringify(meeting), { mimeType: 'application/json' }))).classification, 'official_work');
  const attachment = await classifyDocumentOrigin(input(`${neutral}\nVerfasser: Plan GmbH`, { title: 'Gutachten', administrativeOriginEvidence: publisher }));
  assert.equal(attachment.classification, 'third_party');
  const mixed = await classifyDocumentOrigin(input(JSON.stringify({ ...meeting, name: 'Beratung zum Gutachten', copyright: '© Plan GmbH' }), { mimeType: 'application/json' }));
  assert.equal(mixed.classification, 'mixed');
  const external = await classifyDocumentOrigin(input(JSON.stringify({ ...meeting, publisher: 'Plan GmbH' }), { mimeType: 'application/json' }));
  assert.equal(external.classification, 'third_party');
  for (const data of [
    { ...meeting, type: 'https://schema.oparl.org/1.1/File', name: 'Anlage' },
    { ...meeting, type: 'https://untrusted.example/1.1/Meeting' },
    { name: publisher, description: 'Sitzungskalender' },
    { ...meeting, publisher: undefined, auxiliaryFile: { author: 'Stadtverwaltung Beispielstadt' } },
    { data: [meeting, { ...meeting, publisher: undefined }] },
  ]) assert.equal((await classifyDocumentOrigin(input(JSON.stringify(data), { mimeType: 'application/json' }))).classification, 'unknown');
});

test('JSON parse, byte and nesting limits remain explicit unknown', async () => {
  const base = { id: 'https://www.beispielstadt.de/oparl/body/1', type: 'https://schema.oparl.org/1.1/Body', name: 'Stadt Beispielstadt' };
  let nested: unknown = 'value';
  for (let index = 0; index < 18; index++) nested = { nested };
  for (const [text, reason] of [
    ['{invalid', 'parse_or_tool_failure'],
    [JSON.stringify({ ...base, description: 'x'.repeat(32 * 1024) }), 'json_size_limit'],
    [JSON.stringify({ ...base, nested }), 'json_structure_limit'],
  ]) {
    const result = await classifyDocumentOrigin(input(text, { mimeType: 'application/json' }));
    assert.equal(result.classification, 'unknown');
    assert.ok(result.evidence.some(item => item.value === reason));
  }
});

test('inherited Body strings cannot upgrade unrelated non-JSON formal documents', async () => {
  const bodyName = 'Stadt Beispielstadt';
  for (const administrativeOriginEvidence of [bodyName, [`Herausgeber: ${bodyName}`]]) {
    for (const source of [
      input(`Beschluss\n${neutral}`, { administrativeOriginEvidence }),
      input(`<html><title>Beschluss</title><main>${neutral}</main></html>`, { mimeType: 'text/html', administrativeOriginEvidence }),
      input('', { mimeType: 'application/pdf', bytes: originPdf(`Beschluss\n${neutral}`), administrativeOriginEvidence }),
      input(`Beschluss\n${neutral}`, { url: 'https://unrelated.example/document', administrativeOriginEvidence }),
    ]) {
      const result = await classifyDocumentOrigin(source);
      assert.equal(result.classification, 'unknown');
      assert.equal(result.evidence.some(item => item.value === 'explicit_administrative_origin'), false);
    }
  }
});

test('typed OParl context authorizes only the selected Body and final API representation', async () => {
  const bodyId = 'https://www.beispielstadt.de/oparl/body/1';
  const meeting = { id: 'https://www.beispielstadt.de/oparl/meeting/1', type: 'https://schema.oparl.org/1.1/Meeting', name: 'Beratung im Hauptausschuss', body: bodyId };
  const oparlContext = { bodyId, bodyName: 'Stadt Beispielstadt', apiUrl: meeting.id };
  const accepted = await classifyDocumentOrigin(input(JSON.stringify(meeting), { url: meeting.id, mimeType: 'application/json', oparlContext }));
  assert.equal(accepted.classification, 'official_work');
  assert.ok(accepted.evidence.some(item => item.value === 'body_and_final_api_bound_administrative_origin'));
  assert.equal(JSON.stringify(accepted.evidence).includes(bodyId), false);
  const listUrl = 'https://www.beispielstadt.de/oparl/meetings?page=1';
  const listContext = { ...oparlContext, apiUrl: listUrl };
  assert.equal((await classifyDocumentOrigin(input(JSON.stringify({ data: [meeting], links: { self: listUrl } }), {
    url: listUrl, mimeType: 'application/ld+json', oparlContext: listContext,
  }))).classification, 'official_work');
  const canonical = await classifyDocumentOrigin(input(JSON.stringify(meeting), {
    url: meeting.id, mimeType: 'application/json', oparlContext: { ...oparlContext, apiUrl: 'https://WWW.BEISPIELSTADT.DE:443/oparl/meeting/1' },
  }));
  assert.equal(canonical.classification, 'official_work');
  for (const source of [
    input(JSON.stringify(meeting), { url: 'https://elsewhere.example/oparl/meeting/1', mimeType: 'application/json', oparlContext }),
    input(JSON.stringify(meeting), { url: 'https://www.beispielstadt.de/download/1', mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ ...meeting, id: 'https://elsewhere.example/oparl/meeting/1' }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ ...meeting, id: 'https://www.beispielstadt.de/oparl/meeting/2' }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ ...meeting, body: 'https://www.beispielstadt.de/oparl/body/2' }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ ...meeting, body: undefined }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify(meeting), { url: meeting.id, mimeType: 'application/json', oparlContext: { ...oparlContext, bodyName: 'Beispielstadt' } }),
    input(JSON.stringify(meeting), { url: meeting.id, mimeType: 'application/json', oparlContext: { ...oparlContext, apiUrl: `${meeting.id}#attachment` } }),
    input(JSON.stringify(meeting), { url: meeting.id, mimeType: 'application/json', oparlContext: { ...oparlContext, bodyId: 'https://elsewhere.example/oparl/body/1' } }),
    input(JSON.stringify({ data: [meeting, { ...meeting, body: 'https://www.beispielstadt.de/oparl/body/2' }] }), { url: listUrl, mimeType: 'application/json', oparlContext: listContext }),
    input(JSON.stringify({ data: [meeting], links: { self: 'https://elsewhere.example/list' } }), { url: listUrl, mimeType: 'application/json', oparlContext: listContext }),
    input(JSON.stringify({ ...meeting, type: 'https://schema.oparl.org/1.1/System' }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ ...meeting, type: 'https://schema.oparl.org/1.1/AgendaItem' }), { url: meeting.id, mimeType: 'application/json', oparlContext }),
  ]) {
    const result = await classifyDocumentOrigin(source);
    assert.equal(result.classification, 'unknown');
    assert.ok(result.evidence.some(item => item.value === 'context_binding_rejected'));
  }
});

test('typed API issuer context cannot authorize non-JSON, attachments or forged generic JSON', async () => {
  const apiUrl = 'https://www.beispielstadt.de/oparl/meeting/1';
  const oparlContext = { bodyId: 'https://www.beispielstadt.de/oparl/body/1', bodyName: 'Stadt Beispielstadt', apiUrl };
  for (const source of [
    input(`Beschluss\n${neutral}`, { url: apiUrl, oparlContext }),
    input(`<html><title>Beschluss</title><main>${neutral}</main></html>`, { url: apiUrl, mimeType: 'text/html', oparlContext }),
    input('', { url: apiUrl, mimeType: 'application/pdf', bytes: originPdf(`Beschluss\n${neutral}`), oparlContext }),
    input(JSON.stringify({ name: 'Beschluss', description: neutral }), { url: apiUrl, mimeType: 'application/json', oparlContext }),
    input(JSON.stringify({ id: apiUrl, type: 'https://schema.oparl.org/1.1/File', body: oparlContext.bodyId, name: 'Beschluss' }), { url: apiUrl, mimeType: 'application/json', oparlContext }),
  ]) {
    const result = await classifyDocumentOrigin(source);
    assert.equal(result.classification, 'unknown');
    assert.equal(result.evidence.some(item => item.value === 'body_and_final_api_bound_administrative_origin'), false);
  }
  const consultant = await classifyDocumentOrigin(input(`Gutachten\n${neutral}`, { url: apiUrl, oparlContext }));
  assert.equal(consultant.classification, 'third_party');
  const ownIssuer = await classifyDocumentOrigin(input(official, { url: 'https://other.example/document', oparlContext }));
  assert.equal(ownIssuer.classification, 'official_work');
});

test('PDF classifier requires matching managed source context before any parser work', async () => {
  const source = input('', { mimeType: 'application/pdf', bytes: originPdf(official) });
  let calls = 0;
  const command: DocumentCommand = async () => { calls++; return official; };
  await assert.rejects(classifyOrigin(source, { command }), { name: 'CivicPolicyStateError', code: 'MANAGED_SCRATCH_REQUIRED' });
  for (const binding of [
    { phase: 'pre-admission' as const, url: source.url, sourceSha256: '0'.repeat(64) },
    { phase: 'pre-admission' as const, url: 'https://other.example/source.pdf', sourceSha256: createHash('sha256').update(source.bytes).digest('hex') },
  ]) {
    await assert.rejects(classifyOrigin(source, {
      command,
      scratch: {
        root: join(testDirectory, 'mismatch'), stateDir: join(testDirectory, 'policy-state'),
        authorityId: fixtureAuthority.authorityId, authoritySha256: fixtureAuthority.authoritySha256,
        kind: 'fetch', decisionId: CIVIC_ACQUISITION_DECISION_ID, bindings: [binding],
      },
    }), { name: 'CivicPolicyStateError', code: 'SCRATCH_SOURCE_BINDING_REQUIRED' });
  }
  assert.equal(calls, 0);
  await assert.rejects(lstat(join(testDirectory, 'mismatch')), { code: 'ENOENT' });
});

test('PDF source bytes and both native command seams stay inside the same managed scratch scope', async () => {
  const bytes = originPdf(official), calls: string[] = [];
  let directory = '';
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes }, {
    command: async (file, args, scope) => {
      assert.ok(scope);
      await scope.assertActive();
      const scoped = relative(join(testDirectory, 'fetch'), scope.directory);
      assert.ok(scoped && !isAbsolute(scoped) && !scoped.startsWith('..'));
      if (directory) assert.equal(scope.directory, directory);
      directory = scope.directory;
      assert.equal(scope.signal.aborted, false);
      const path = join(scope.directory, 'source.pdf');
      assert.ok(args.includes(path));
      assert.deepEqual(await readFile(path), bytes);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      calls.push(file);
      return file === 'pdfinfo' ? 'Pages: 1\nAuthor: Stadt Beispielstadt\n' : official;
    },
  });
  assert.equal(result.classification, 'official_work');
  assert.deepEqual(calls, ['pdfinfo', 'pdftotext']);
  assert.ok(directory);
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('parser failure cleans managed raw scratch without exposing diagnostics', async () => {
  let directory = '';
  const result = await classifyDocumentOrigin({ url, mimeType: 'application/pdf', bytes: originPdf(official) }, {
    command: async (_file, _args, scope) => {
      directory = scope.directory;
      assert.equal((await readFile(join(directory, 'source.pdf'))).length > 0, true);
      throw Error('private parser diagnostics and source body');
    },
  });
  assert.equal(result.classification, 'unknown');
  assert.ok(result.evidence.some(item => item.value === 'parse_or_tool_failure'));
  assert.equal(JSON.stringify(result).includes('private parser'), false);
  assert.ok(directory);
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('unprovisioned authority aborts PDF classification rather than returning unknown', async () => {
  const source = input('', { mimeType: 'application/pdf', bytes: originPdf(official) });
  let calls = 0;
  const root = join(testDirectory, 'unprovisioned-fetch');
  await assert.rejects(classifyOrigin(source, {
    command: async () => { calls++; return official; },
    scratch: {
      root, kind: 'fetch', decisionId: CIVIC_ACQUISITION_DECISION_ID, stateDir: join(testDirectory, 'unprovisioned-authority'),
      authorityId: fixtureAuthority.authorityId, authoritySha256: fixtureAuthority.authoritySha256,
      bindings: [{ phase: 'pre-admission', url: source.url, sourceSha256: createHash('sha256').update(source.bytes).digest('hex') }],
    },
  }), { name: 'CivicPolicyStateError' });
  assert.equal(calls, 0);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});
