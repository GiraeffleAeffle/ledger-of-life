import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest, ObservationSchema, type AdmittedSnapshot, type AdapterScope} from '../src/district-adapter-contract.ts';
import {discoverMastr, parseMastr, MASTR_LIMITS, mastrAdapter} from '../src/adapters/mastr.ts';

// Synthetic native-format fixtures based on inspected public German headers, not collected register entries.
const scope: AdapterScope = {publisherId: 'bundesnetzagentur', sourceId: 'mastr', municipalityId: 'ratzeburg', ags: '01053100', tenant: null, observationWindow: '2026-10'};
const headers = ['MaStR-Nr. der Einheit', 'Gemeindeschlüssel', 'Betriebs-Status', 'Energieträger', 'Bruttoleistung der Einheit', 'Nettonennleistung der Einheit', 'Inbetriebnahmedatum der Einheit', 'Registrierungsdatum der Einheit', 'Letzte Aktualisierung', 'Datum der endgültigen Stilllegung', 'Datum der geplanten Inbetriebnahme', 'MaStR-Nr. des Anlagenbetreibers', 'Name des Anlagenbetreibers (nur Org.)', 'Nutzbare Speicherkapazität in kWh'];
const positive = ['SEE100000000001', '01053100', 'In Betrieb', 'Solare Strahlungsenergie', '1.234,50', '1.000,25', '29.02.2024', '15.03.2024', '10.10.2026', '', '', 'ABR100000000001', 'Fixture Energie GmbH', '12,75'];
function csv(rows: string[][] = [positive], columns = headers): string {
  return [columns, ...rows].map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(';')).join('\r\n');
}
function snapshot(content: string | Uint8Array, mimeType = 'text/csv; charset=utf-8', file = 'fixture.csv'): AdmittedSnapshot {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {bytes, sourceSha256: digest(bytes), policyReceiptSha256: digest('synthetic-policy-receipt'), url: `https://www.marktstammdatenregister.de/MaStR/${file}`, mimeType, retrievedAt: '2026-10-11T00:00:00Z', sourceVersion: null};
}

test('native CSV retains source cells, AGS, date roles, capacity units and disclosed organization role', () => {
  const input = snapshot(csv());
  const result = parseMastr(input, scope);
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.coverage.observedRows, 1);
  for (const item of result.observations) {
    assert.ok(ObservationSchema.safeParse(item).success);
    assert.equal(item.geography.ags, '01053100');
    assert.equal(item.sourceReferenceDate, '2026-10-10');
    assert.equal(item.publishedAt, null);
    assert.ok(item.evidence.every(cell => cell.sourceSha256 === input.sourceSha256 && cell.rowKey === positive[0]));
  }
  const gross = result.observations.find(item => item.predicate === 'gross_rated_capacity')!;
  assert.equal(gross.value, 1234.5);
  assert.equal(gross.unit, 'kWp');
  assert.ok(gross.evidence.some(cell => cell.rawValue === '1.234,50'));
  assert.ok(gross.evidence.some(cell => cell.rawValue === 'Solare Strahlungsenergie'));
  assert.equal(result.observations.find(item => item.predicate === 'net_rated_capacity')!.unit, 'kW');
  assert.equal(result.observations.find(item => item.predicate === 'usable_storage_capacity')!.unit, 'kWh');
  const commissioned = result.observations.find(item => item.predicate === 'commissioning_date')!;
  assert.equal(commissioned.date, '2024-02-29');
  assert.equal(commissioned.dateRole, 'commissioning');
  assert.equal(result.observations.find(item => item.predicate === 'registration_date')!.dateRole, 'registration');
  const relation = result.observations.find(item => item.predicate === 'operates')!;
  assert.equal(relation.subject, 'mastr:actor:ABR100000000001');
  assert.equal(relation.value, 'mastr:unit:SEE100000000001');
  assert.ok(relation.evidence.some(cell => cell.rawValue === 'Fixture Energie GmbH'));
  assert.ok(result.observations.every(item => !/ownership|generation|municipal_owner/u.test(item.predicate)));
  assert.deepEqual(result, mastrAdapter.parse(input, scope));
});

test('all nine pilot AGS are exact strings and never inferred from names or postcode', () => {
  for (const ags of ['12064472', '12064227', '12064428', '01053100', '01053090', '01053116', '13076090', '13076108', '13076060']) {
    const row = [...positive]; row[1] = ags;
    const result = parseMastr(snapshot(csv([row])), {...scope, ags});
    assert.equal(result.coverage.state, 'partial');
    assert.ok(result.observations.every(item => item.geography.ags === ags));
  }
  const unknown = [...positive]; unknown[1] = '';
  assert.equal(parseMastr(snapshot(csv([unknown])), scope).observations.length, 0);
  const other = [...positive]; other[1] = '13076060';
  assert.equal(parseMastr(snapshot(csv([other])), scope).observations.length, 0);
});

test('empty bytes, valid empty exports and disappearance remain distinct', () => {
  const empty = parseMastr(snapshot(csv([])), scope);
  assert.equal(empty.coverage.state, 'empty');
  assert.equal(empty.observations.length, 0);
  assert.match(empty.coverage.reason, /these bytes/u);
  assert.equal(parseMastr(snapshot(''), scope).coverage.state, 'held_quality');
  assert.ok(!empty.observations.some(item => /deleted|withdrawn/u.test(item.predicate)));
});

test('redacted operators and names without IDs never produce organizations or operates edges', () => {
  for (const redaction of ['', '-', 'Nicht öffentlich', 'Vertraulich']) {
    const row = [...positive]; row[11] = redaction;
    const result = parseMastr(snapshot(csv([row])), scope);
    assert.equal(result.coverage.state, 'partial');
    assert.equal(result.observations.find(item => item.predicate === 'operator_disclosure')!.value, null);
    assert.ok(!result.observations.some(item => item.predicate === 'operates' || item.kind === 'OrganizationObservation'));
  }
  for (const name of ['', '-', 'Nicht öffentlich', 'Vertraulich', 'natürliche Person']) {
    const idOnly = [...positive]; idOnly[12] = name;
    const result = parseMastr(snapshot(csv([idOnly])), scope);
    assert.equal(result.coverage.state, 'partial');
    assert.equal(result.observations.find(item => item.predicate === 'operator_disclosure')!.value, null);
    assert.ok(!result.observations.some(item => item.predicate === 'registered_operator_identifier' || item.predicate === 'operates' || item.kind === 'OrganizationObservation'));
    assert.ok(!JSON.stringify(result).includes('ABR100000000001'));
  }
});

test('withdrawn status, permanent decommissioning and planned commissioning are separate native roles', () => {
  const row = [...positive]; row[2] = 'Endgültig stillgelegt'; row[9] = '01.09.2026'; row[10] = '01.01.2024';
  const result = parseMastr(snapshot(csv([row])), scope);
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.observations.find(item => item.predicate === 'registered_operating_status')!.value, 'Endgültig stillgelegt');
  assert.equal(result.observations.find(item => item.predicate === 'decommissioning_date')!.dateRole, 'permanent_decommissioning');
  assert.equal(result.observations.find(item => item.predicate === 'planned_commissioning_date')!.dateRole, 'planned_commissioning');
  const nativeWithdrawn = csv([['SEE100000000001', 'Stromerzeugung', 'Solareinheit', 'In Betrieb', 'Gelöscht', '10.10.2026', 'Doppelt registriert']], ['MaStR-Nr. der Einheit', 'Einheiten-Typ', 'Einheiten-Art', 'Letzter Betriebsstatus', 'System-Status', 'Letzte Aktualisierung', 'Löschgrund']);
  const withdrawn = parseMastr(snapshot(nativeWithdrawn), scope);
  assert.equal(withdrawn.coverage.state, 'partial');
  assert.equal(withdrawn.observations.length, 0);
  assert.match(withdrawn.coverage.limitations.join(' '), /prior-version join/u);
});

test('changed required schema, bad dates, ambiguous units, malformed IDs and duplicate units fail closed', () => {
  assert.equal(parseMastr(snapshot(csv([positive], headers.map(header => header === 'Gemeindeschlüssel' ? 'AGS-neu' : header))), scope).coverage.state, 'held_quality');
  for (const [column, value] of [[0, '100000000001'], [1, '1053100'], [4, '1.234,5 MW'], [6, '29.02.2025'], [11, 'SNB100000000001']] as const) {
    const row = [...positive]; row[column] = value;
    const result = parseMastr(snapshot(csv([row])), scope);
    assert.equal(result.coverage.state, 'held_quality');
    assert.deepEqual(result.observations, []);
  }
  assert.equal(parseMastr(snapshot(csv([positive, positive])), scope).coverage.state, 'held_quality');
  const invalid = snapshot(csv()); invalid.sourceSha256 = digest('different');
  assert.throws(() => parseMastr(invalid, scope), /byte binding/u);
});

test('discovery pages only advertised links and binds cursors to exact scope and snapshot', () => {
  const links = Array.from({length: MASTR_LIMITS.resources + 3}, (_, index) => `<a href="/MaStR/observed-export-${index}.csv?filter=01053100">CSV</a>`).join('');
  const input = snapshot(`<html><body>${links}<a href="https://third-party.example/data.csv">external</a><a href="/MaStR/Datendownload/full.zip">bulk</a><a href="/MaStRApi">SOAP</a></body></html>`, 'text/html', 'Datendownload');
  const first = discoverMastr(input, scope, null);
  assert.equal(first.resources.length, MASTR_LIMITS.resources);
  assert.equal(first.coverage.state, 'partial');
  assert.ok(first.coverage.nextCursor);
  const second = discoverMastr(input, scope, first.coverage.nextCursor);
  assert.equal(second.resources.length, 3);
  assert.equal(second.coverage.nextCursor, null);
  assert.ok([...first.resources, ...second.resources].every(resource => resource.url.includes('filter=01053100') && resource.method === 'GET'));
  assert.throws(() => discoverMastr(input, {...scope, ags: '01053090'}, first.coverage.nextCursor), /foreign/u);
  assert.throws(() => discoverMastr(snapshot('<html></html>', 'text/html', 'Datendownload'), scope, first.coverage.nextCursor), /foreign/u);
  const interactive = snapshot('<a href="#" class="js-show-csv-modal">CSV-Export</a>', 'text/html', 'Einheit/Einheiten/ErweiterteOeffentlicheEinheitenuebersicht');
  assert.equal(discoverMastr(interactive, scope, null).coverage.state, 'not_checked');
});

test('login, authenticated SOAP and unresolved bulk rights cannot enter parsing', () => {
  const blocked = snapshot('<form><input type="password"></form>', 'text/html', 'blocked');
  assert.equal(discoverMastr(blocked, scope, null).coverage.state, 'blocked_access');
  assert.equal(parseMastr(blocked, scope).coverage.state, 'blocked_access');
  const soap = {...snapshot('<Envelope/>', 'text/xml'), url: 'https://www.marktstammdatenregister.de/MaStRApi/soap'};
  assert.equal(parseMastr(soap, scope).coverage.state, 'blocked_access');
  assert.equal(parseMastr(snapshot('<Einheiten/>', 'text/xml', 'bulk.xml'), scope).coverage.state, 'held_origin');
  assert.equal(parseMastr(snapshot(new Uint8Array([0x50, 0x4b]), 'application/zip', 'bulk.zip'), scope).coverage.state, 'held_origin');
  assert.throws(() => parseMastr(snapshot(new Uint8Array(MASTR_LIMITS.bytes + 1)), scope), /byte bound/u);
});

test('SpreadsheetML XLS retains native string IDs and typed capacity cells; binary BIFF stays held', () => {
  const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const row = [...positive]; row[4] = '1234.5'; row[5] = '1000.25'; row[13] = '12.75';
  const workbook = '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Stromerzeuger"><Table>' + [headers, row].map((values, ri) => '<Row>' + values.map((value, ci) => `<Cell><Data ss:Type="${ri === 1 && [4, 5, 13].includes(ci) ? 'Number' : 'String'}">${xmlEscape(value)}</Data></Cell>`).join('') + '</Row>').join('') + '</Table></Worksheet></Workbook>';
  const result = parseMastr(snapshot(workbook, 'application/vnd.ms-excel', 'fixture.xls'), scope);
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.observations.find(item => item.predicate === 'gross_rated_capacity')!.value, 1234.5);
  assert.ok(result.observations.every(item => item.evidence.every(cell => cell.format === 'xls' && cell.sheet === 'Stromerzeuger')));
  const nativeDate = workbook.replace('<Data ss:Type="String">29.02.2024</Data>', '<Data ss:Type="DateTime">2024-02-29T00:00:00.000</Data>');
  const dated = parseMastr(snapshot(nativeDate, 'application/vnd.ms-excel', 'fixture.xls'), scope);
  assert.equal(dated.observations.find(item => item.predicate === 'commissioning_date')!.date, '2024-02-29');
  const serialDate = workbook.replace('<Data ss:Type="String">29.02.2024</Data>', '<Data ss:Type="Number">45351</Data>');
  assert.equal(parseMastr(snapshot(serialDate, 'application/vnd.ms-excel', 'fixture.xls'), scope).coverage.state, 'held_quality');
  const styledSerialDate = serialDate.replace('<Worksheet ', '<Styles><Style ss:ID="date"><NumberFormat ss:Format="Short Date"/></Style></Styles><Worksheet ').replace('<Cell><Data ss:Type="Number">45351</Data>', '<Cell ss:StyleID="date"><Data ss:Type="Number">45351</Data>');
  const heldDate = parseMastr(snapshot(styledSerialDate, 'application/vnd.ms-excel', 'fixture.xls'), scope);
  assert.equal(heldDate.coverage.state, 'held_quality');
  assert.deepEqual(heldDate.observations, []);
  const numericAgs = workbook.replace('<Data ss:Type="String">01053100</Data>', '<Data ss:Type="Number">1053100</Data>');
  assert.equal(parseMastr(snapshot(numericAgs, 'application/vnd.ms-excel', 'fixture.xls'), scope).coverage.state, 'held_quality');
  assert.equal(parseMastr(snapshot(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'application/vnd.ms-excel', 'legacy.xls'), scope).coverage.state, 'held_quality');
});
