import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest, type AdmittedSnapshot, type AdapterScope} from '../src/district-adapter-contract.ts';
import {createGenesisAdapter, genesisAdapter, GENESIS_BASE, GENESIS_TABLES} from '../src/adapters/genesis.ts';

// Existing synthetic fixtures are native-shaped examples, not observed town values.
// The response fixture below is the real admitted Strausberg payload, with only
// server-masked username/password normalized to "****"; content/trailers are intact.
const strausbergResponse = readFileSync(new URL('./fixtures/genesis-strausberg-datencsv.json', import.meta.url), 'utf8');
const scope: AdapterScope = {publisherId: 'statistische-aemter-bund-laender', sourceId: 'regionalstatistik-genesis', municipalityId: 'ratzeburg', ags: '01053100', tenant: null, observationWindow: '2024'};
function snapshot(content: string, path = 'data/tablefile'): AdmittedSnapshot {
  const bytes = new TextEncoder().encode(content);
  return {bytes, sourceSha256: digest(bytes), url: GENESIS_BASE + path, mimeType: path === 'data/tablefile' ? 'text/csv' : 'application/json', retrievedAt: '2026-10-11T00:00:00Z', policyReceiptSha256: 'a'.repeat(64), sourceVersion: 'fixture-v1'};
}
function table(tableId = '12411-06-01', values = '01053100;Ratzeburg;7;3;4', date = '2024'): string {
  return `GENESIS-Tabelle: ${tableId}\nBevölkerung (Anzahl);;;;\n;;${date};${date};${date}\n;;Insgesamt;männlich;weiblich\n${values}\n__________\n© Statistische Ämter des Bundes und der Länder\n`;
}
const wadl = `<application xmlns="http://wadl.dev.java.net/2009/02"><resources base="${GENESIS_BASE}"><resource path="/metadata"><resource path="/table"><method name="POST"/></resource></resource><resource path="/data"><resource path="/table"><method name="POST"/></resource><resource path="/tablefile"><method name="POST"/></resource></resource></resources></application>`;
function metadata(code = '12411-06-01', geography = 'Gemeinden', variable = 'GEMEIN'): string {
  return JSON.stringify({Ident: {Service: 'metadata', Method: 'table'}, Status: {Code: 0, Type: 'Information', Content: 'erfolgreich'}, Object: {Code: code, Structure: {Rows: [{Code: variable, Content: geography, Selected: null}]}}});
}
function jsonTable(content: string, front = 2, selection = '01053100', variable = 'GEMEIN'): string {
  return JSON.stringify({Ident: {Service: 'data', Method: 'table'}, Status: {Code: 0, Type: 'Information', Content: 'erfolgreich'}, Parameter: {name: '12411-06-01', regionalkey: selection, regionalvariable: variable}, Object: {Content: content, TableLayout: {FrontColumnsNumber: String(front)}, Structure: {Rows: [{Code: variable, Content: variable === 'GEMEIN' ? 'Gemeinden' : 'Kreise', Selected: '1'}]}}});
}
test('GENESIS WADL discovery paginates catalog-backed metadata requests without network or credential invention', () => {
  const input = snapshot(wadl, 'application.wadl');
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = genesisAdapter.discover(input, scope, cursor);
    assert.equal(result.coverage.state, 'partial');
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].method, 'POST');
    assert.equal(new URLSearchParams(result.resources[0].body!).has('username'), false);
    ids.push(new URLSearchParams(result.resources[0].body!).get('name')!);
    cursor = result.coverage.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, Object.keys(GENESIS_TABLES).map(id => id === '12411-02-03' ? '12411-02-03-5' : id));
  assert.ok(genesisAdapter.discover(input, scope, null).coverage.limitations.some(value => value.includes('not exercised')));
});
test('native metadata drives the regional variable and bounded REST table/tablefile POST form bodies', () => {
  const input = snapshot(metadata(), 'metadata/table');
  const first = genesisAdapter.discover(input, scope, null);
  const body = new URLSearchParams(first.resources[0].body!);
  assert.equal(body.get('regionalkey'), '01053100');
  assert.equal(body.get('regionalvariable'), 'GEMEIN');
  assert.equal(body.get('startyear'), '2024');
  assert.equal(body.get('endyear'), '2024');
  assert.equal(body.get('job'), 'false');
  assert.equal(first.resources[0].url, GENESIS_BASE + 'data/table');
  const second = genesisAdapter.discover(input, scope, first.coverage.nextCursor);
  assert.equal(second.resources[0].url, GENESIS_BASE + 'data/tablefile');
  assert.equal(new URLSearchParams(second.resources[0].body!).get('format'), 'datencsv');
  assert.equal(second.coverage.nextCursor, null);
});
test('municipal age-table metadata builds the exact mapped Strausberg request without changing catalog identity', () => {
  const townScope = {...scope, municipalityId: 'strausberg', ags: '12064472'};
  for (const name of ['12411-02-03', '12411-02-03-5']) {
    const input = snapshot(metadata(name), 'metadata/table');
    const first = genesisAdapter.discover(input, townScope, null);
    assert.equal(first.resources[0].body, 'name=12411-02-03-5&area=free&language=de&regionalvariable=GEMEIN&regionalkey=12064472&startyear=2024&endyear=2024&compress=false&transpose=false&job=false');
    assert.equal(first.resources[0].parentId, '12411-02-03:metadata/table');
    const second = genesisAdapter.discover(input, townScope, first.coverage.nextCursor);
    assert.equal(second.resources[0].body, first.resources[0].body + '&format=datencsv&quality=on');
  }
});
test('cursor binds source bytes and municipal scope and never reports complete coverage', () => {
  const input = snapshot(wadl, 'application.wadl');
  const cursor = genesisAdapter.discover(input, scope, null).coverage.nextCursor;
  assert.equal(genesisAdapter.discover(input, {...scope, ags: '01053090'}, cursor).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.discover(snapshot(wadl + ' ', 'application.wadl'), scope, cursor).coverage.state, 'held_quality');
});
test('population cells retain leading-zero GE identity, units, sex dimensions and 30 June reference date', () => {
  const input = snapshot(table());
  const result = genesisAdapter.parse(input, scope);
  assert.equal(result.coverage.state, 'partial');
  assert.deepEqual(result.observations.map(row => row.value), [7, 3, 4]);
  for (const row of result.observations) {
    assert.equal(row.geography.ags, '01053100');
    assert.equal(row.date, '2024-06-30');
    assert.equal(row.dateRole, 'statistical_reference_date');
    assert.equal(row.unit, 'Anzahl');
    assert.equal(row.kind, 'StatisticalObservation');
    assert.equal(row.financialRole, 'none');
    assert.equal(row.publishedAt, null);
    assert.equal(row.evidence[0].sourceSha256, input.sourceSha256);
    assert.ok(row.limitations.some(value => value.includes('never evidence of project completion')));
  }
  assert.equal(new Set(result.observations.map(row => row.nativeId)).size, 3);
  assert.ok(result.observations[1].evidence.some(locator => locator.rawValue === 'männlich' && locator.path === 'r4c4'));
  assert.deepEqual(genesisAdapter.parse(input, scope), result);
});
test('suppression and missing signs survive unchanged; exact-zero sign alone maps to zero', () => {
  const result = genesisAdapter.parse(snapshot(table('12411-06-01', '01053100;Ratzeburg;.;/;-')), scope);
  assert.deepEqual(result.observations.map(row => row.value), [null, null, 0]);
  assert.deepEqual(result.observations.map(row => row.evidence[0].rawValue), ['.', '/', '-']);
  for (const sign of ['...', 'x', '']) {
    const parsed = genesisAdapter.parse(snapshot(table('12411-06-01', `01053100;Ratzeburg;${sign};3;4`)), scope);
    assert.equal(parsed.observations[0].value, null);
    assert.equal(parsed.observations[0].evidence[0].rawValue, sign);
  }
});
test('KR cells remain district observations with null town AGS and no fabricated GE values', () => {
  const result = genesisAdapter.parse(snapshot(table('12411-06-01', '01053;Herzogtum Lauenburg;70;30;40')), scope);
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.every(row => row.subject === 'regionalstatistik:KR:01053' && row.geography.ags === null));
  assert.ok(result.observations[0].limitations.includes('native_geography_level=KR;native_region_code=01053'));
});
test('other-town cells and native terminated empty slices are empty, not withdrawn or complete', () => {
  const other = genesisAdapter.parse(snapshot(table('12411-06-01', '01053090;Mölln;8;4;4')), scope);
  assert.equal(other.coverage.state, 'empty');
  assert.equal(other.coverage.observedRows, 1);
  const empty = table().replace(';;Insgesamt;männlich;weiblich\n01053100;Ratzeburg;7;3;4\n', '');
  assert.equal(genesisAdapter.parse(snapshot(empty), scope).coverage.state, 'empty');
});
test('age table keeps row age group as identity and year-end reference, never totals inferred', () => {
  const content = 'GENESIS-Tabelle: 12411-02-03\nBevölkerung (Anzahl);;;\n;;;2024\n01053100;Ratzeburg;unter 3;2\n01053100;Ratzeburg;3 bis unter 6;3\n__________\n';
  const result = genesisAdapter.parse(snapshot(JSON.stringify({Ident: {Service: 'data', Method: 'table'}, Status: {Code: 0, Type: 'Information'}, Parameter: {name: '12411-02-03'}, Object: {Content: content, TableLayout: {FrontColumnsNumber: '3'}}}), 'data/table'), scope);
  assert.equal(result.observations.length, 2);
  assert.ok(result.observations.every(row => row.date === '2024-12-31'));
  assert.notEqual(result.observations[0].nativeId, result.observations[1].nativeId);
  assert.ok(result.observations[0].evidence[0].rowKey!.includes('unter 3'));
});
test('mapped municipal datencsv accepts exact catalog/request identities and preserves native selection gates', () => {
  const townScope = {...scope, municipalityId: 'strausberg', ags: '12064472'};
  const fixture = (contentName: string, parameterName: string, key = '12064472', variable = 'GEMEIN', selected = '1') => JSON.stringify({
    Ident: {Service: 'data', Method: 'table'}, Status: {Code: 0, Type: 'Information'},
    Parameter: {name: parameterName, regionalkey: key, regionalvariable: variable},
    Object: {
      Content: `GENESIS-Tabelle: ${contentName}\nBevölkerung (Anzahl);;\n;;2024\nStrausberg;unter 3;2\nStrausberg;3 bis unter 6;3\n__________\n`,
      TableLayout: {FrontColumnsNumber: '2'},
      Structure: {Rows: [{Code: 'GEMEIN', Content: 'Gemeinden', Selected: selected}]},
    },
  });
  for (const contentName of ['12411-02-03', '12411-02-03-5']) {
    for (const parameterName of ['12411-02-03', '12411-02-03-5']) {
      const result = genesisAdapter.parse(snapshot(fixture(contentName, parameterName), 'data/table'), townScope);
      assert.equal(result.coverage.state, 'partial');
      assert.equal(result.coverage.observedRows, 2);
      assert.deepEqual(result.observations.map(row => row.value), [2, 3]);
      assert.ok(result.observations.every(row => row.nativeId.startsWith('12411-02-03:GE:12064472:') && row.geography.ags === '12064472' && row.date === '2024-12-31' && row.predicate === 'describes:population_by_age'));
      assert.ok(result.observations[0].evidence.some(row => row.path === '$.Parameter.regionalkey' && row.rawValue === '12064472'));
    }
  }
  const bare = genesisAdapter.parse(snapshot(table('12411-02-03-5', '12064472;Strausberg;7;3;4')), townScope);
  assert.deepEqual(bare.observations.map(row => row.value), [7, 3, 4]);
  assert.ok(bare.observations.every(row => row.date === '2024-12-31'));
  assert.equal(genesisAdapter.parse(snapshot(fixture('12411-02-03-5', '12411-02-03-5', '12064227'), 'data/table'), townScope).coverage.state, 'empty');
  for (const source of [
    fixture('12411-02-03-5', '12411-02-03-5', '12064472', 'KREISE'),
    fixture('12411-02-03-5', '12411-02-03-5', '12064472', 'GEMEIN', '0'),
    fixture('12411-02-03-5', '31231-02-01'),
    fixture('12411-02-03-4', '12411-02-03-5'),
    fixture('12411-02-03-5', '12411-02-03-5-extra'),
  ]) {
    const result = genesisAdapter.parse(snapshot(source, 'data/table'), townScope);
    assert.equal(result.coverage.state, 'held_quality');
    assert.deepEqual(result.observations, []);
  }
  for (const name of ['99999-00-00', '12411-02-03-4', '12411-02-03-55', '12411-02-03-5-extra', '12411-06-01-5', '31231-02-01-5']) {
    assert.equal(genesisAdapter.parse(snapshot(table(name)), scope).coverage.state, 'held_quality');
    assert.equal(genesisAdapter.discover(snapshot(metadata(name), 'metadata/table'), scope, null).coverage.state, 'held_quality');
  }
});
test('real municipal datencsv parses 18 source rows and 54 sex/age cells with exact literals', () => {
  const townScope = {...scope, municipalityId: 'strausberg', ags: '12064472'};
  const input = snapshot(strausbergResponse, 'data/table');
  const result = genesisAdapter.parse(input, townScope);
  assert.equal(result.coverage.state, 'partial', result.coverage.reason);
  assert.equal(result.coverage.observedRows, 18);
  assert.equal(result.observations.length, 54);
  assert.equal(new Set(result.observations.map(row => row.nativeId)).size, 54);
  assert.deepEqual(result.observations.slice(0, 3).map(row => row.value), [572, 289, 283]);
  assert.deepEqual(result.observations.slice(-3).map(row => row.value), [27719, 13211, 14508]);
  for (const row of result.observations) {
    assert.ok(row.nativeId.startsWith('12411-02-03:GE:12064472:'));
    assert.equal(row.subject, 'regionalstatistik:GE:12064472');
    assert.equal(row.geography.ags, '12064472');
    assert.equal(row.predicate, 'describes:population_by_age');
    assert.equal(row.date, '2024-12-31');
    assert.equal(row.sourceReferenceDate, '2024-12-31');
    assert.equal(row.dateRole, 'statistical_reference_date');
    assert.equal(row.unit, 'Anzahl');
    assert.equal(row.publishedAt, null);
    assert.equal(row.evidence[0].sourceSha256, input.sourceSha256);
    assert.ok(row.evidence.some(cell => cell.path.endsWith('c3') && cell.rawValue === '        Strausberg, Stadt'));
  }
  const first = result.observations[0];
  assert.equal(first.evidence[0].path, '$.Object.Content/r7c5');
  assert.equal(first.evidence[0].rawValue, '572');
  for (const [path, rawValue] of [
    ['r7c1', '31.12.2024'], ['r7c2', '12064472'], ['r7c4', 'unter 3 Jahre'],
    ['r6c5', 'Insgesamt'], ['r5c1', 'Bevölkerungsstand (Anzahl)'],
  ]) assert.ok(first.evidence.some(cell => cell.path === '$.Object.Content/' + path && cell.rawValue === rawValue));
  assert.ok(result.observations[1].evidence.some(cell => cell.path === '$.Object.Content/r6c6' && cell.rawValue === 'männlich'));
  assert.ok(result.observations[2].evidence.some(cell => cell.path === '$.Object.Content/r6c7' && cell.rawValue === 'weiblich'));
  const native = JSON.parse(strausbergResponse);
  assert.equal(native.Parameter.username, '****');
  assert.equal(native.Parameter.password, '****');
  for (const content of [native.Object.Content, native.Object.Content.replace(/\n/g, '\r\n')]) {
    const bare = genesisAdapter.parse(snapshot(content), townScope);
    assert.equal(bare.coverage.state, 'partial', bare.coverage.reason);
    assert.equal(bare.coverage.observedRows, 18);
    assert.deepEqual(bare.observations.map(row => row.value), result.observations.map(row => row.value));
  }
});
test('real municipal datencsv retains native special signs without deriving totals or trailer dates', () => {
  const townScope = {...scope, municipalityId: 'strausberg', ags: '12064472'};
  for (const [sign, expected] of [['-', 0], ['.', null], ['x', null], ['…', null], ['...', null], ['/', null], ['', null]] as const) {
    const native = JSON.parse(strausbergResponse);
    native.Object.Content = native.Object.Content.replace(';572;289;283', `;${sign};289;283`);
    const result = genesisAdapter.parse(snapshot(JSON.stringify(native), 'data/table'), townScope);
    assert.equal(result.coverage.state, 'partial', result.coverage.reason);
    assert.equal(result.coverage.observedRows, 18);
    assert.equal(result.observations.length, 54);
    assert.equal(result.observations[0].value, expected);
    assert.equal(result.observations[0].evidence[0].rawValue, sign);
    assert.equal(result.observations[51].value, 27719);
    assert.ok(result.observations.every(row => row.date === '2024-12-31'));
  }
});
test('real municipal datencsv refuses changed headers, dimensions, selection and failed native status', () => {
  const townScope = {...scope, municipalityId: 'strausberg', ags: '12064472'};
  const nativeResponse = JSON.parse(strausbergResponse);
  const mutations: ((native: typeof nativeResponse) => void)[] = [
    native => { native.Object.Content = native.Object.Content.replace(';;;;Insgesamt;männlich;weiblich', ';;;;Insgesamt;weiblich;männlich'); },
    native => { native.Object.Content = native.Object.Content.replace(';;;;Insgesamt', ';;;Insgesamt'); },
    native => { native.Object.Content = native.Object.Content.replace('Bevölkerungsstand (Anzahl)', 'Bevölkerungsstand'); },
    native => { native.Object.Content = native.Object.Content.replace(';572;289;283', ';572;289'); },
    native => { native.Object.Content = native.Object.Content.replace(';572;289;283', ';unknown;289;283'); },
    native => { native.Object.Content = native.Object.Content.replace('31.12.2024;', '30.06.2024;'); },
    native => { native.Object.Content = native.Object.Content.replace('12064472;', '12064;'); },
    native => { native.Object.Content = native.Object.Content.replace('unter 3 Jahre;', 'unknown dimension;'); },
    native => { native.Object.Content = native.Object.Content.replace('__________', ''); },
    native => { native.Object.Content = native.Object.Content.replace('Tabelle: 12411-02-03-5', 'Tabelle: 12411-02-03-4'); },
    native => { native.Parameter.regionalkey = '12064227'; },
    native => { native.Parameter.regionalvariable = 'KREISE'; },
    native => { delete native.Parameter.regionalkey; },
    native => { native.Object.Structure.Rows[0].Selected = '0'; },
    native => { native.Object.Structure.Rows[0].Code = 'KREISE'; },
    native => { delete native.Object.Structure; },
    native => { native.Object.TableLayout = {FrontColumnsNumber: '2'}; },
    native => { native.Status.Code = 104; native.Status.Content = 'Keine Objekte'; },
    native => { native.Status.Type = 'Error'; },
  ];
  for (const mutate of mutations) {
    const native = JSON.parse(strausbergResponse);
    mutate(native);
    const result = genesisAdapter.parse(snapshot(JSON.stringify(native), 'data/table'), townScope);
    assert.equal(result.coverage.state, 'held_quality', String(mutate));
    assert.deepEqual(result.observations, []);
  }
  const other = genesisAdapter.parse(snapshot(strausbergResponse, 'data/table'), scope);
  assert.equal(other.coverage.state, 'empty');
  assert.equal(other.coverage.observedRows, 18);
});
test('housing-stock table preserves area units and decimals, not construction completion', () => {
  const content = 'GENESIS-Tabelle: 31231-02-01\nWohnungsbestand;;;;\n;;Wohngebäude (Anzahl);Wohnungen (Anzahl);Wohnfläche (1000 m²)\n;;2024;2024;2024\n01053100;Ratzeburg;2;3;1,25\n__________\n';
  const result = genesisAdapter.parse(snapshot(content), scope);
  assert.deepEqual(result.observations.map(row => [row.value, row.unit, row.date]), [[2, 'Anzahl', '2024-12-31'], [3, 'Anzahl', '2024-12-31'], [1.25, '1000 m²', '2024-12-31']]);
  assert.ok(result.observations.every(row => row.predicate === 'describes:housing_stock'));
});
test('JSON Object.Content can bind name-only geography only through corrected native single selection', () => {
  const content = 'GENESIS-Tabelle: 12411-06-01\nBevölkerung (Anzahl);;\n;2024;2024\n;Insgesamt;männlich\nRatzeburg;7;3\n__________\n';
  const result = genesisAdapter.parse(snapshot(jsonTable(content, 1), 'data/table'), scope);
  assert.equal(result.observations.length, 2);
  assert.ok(result.observations[0].evidence.some(row => row.path === '$.Parameter.regionalkey' && row.rawValue === '01053100'));
  assert.equal(genesisAdapter.parse(snapshot(content), scope).coverage.state, 'held_quality');
  const corrected = genesisAdapter.parse(snapshot(jsonTable(content, 1, '01053090'), 'data/table'), scope);
  assert.equal(corrected.coverage.state, 'empty');
});
test('schema changes, truncated exports, mismatched table IDs and unknown value encodings fail closed', () => {
  for (const content of [table().replace('GENESIS-Tabelle: 12411-06-01', 'GENESIS-Tabelle: 99999-00-00'), table().replace('__________', ''), table().replace(';7;3;4', ';seven;3;4'), table().replace('Bevölkerung (Anzahl)', 'Bevölkerung'), table().replace(';7;3;4', ';7;3')]) {
    const result = genesisAdapter.parse(snapshot(content), scope);
    assert.equal(result.coverage.state, 'held_quality');
    assert.deepEqual(result.observations, []);
  }
  assert.equal(genesisAdapter.parse(snapshot(jsonTable(table('31231-02-01')), 'data/table'), scope).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.discover(snapshot(metadata('12411-06-01', 'Kreise', 'KREISE'), 'metadata/table'), scope, null).coverage.state, 'held_quality');
});
test('withdrawn/unavailable native object is held, not an inferred retraction; auth failure is blocked', () => {
  for (const [Content, state] of [['Es gibt keine Objekte zum angegebenen Selektionskriterium', 'held_quality'], ['Anmeldung fehlgeschlagen', 'blocked_access']] as const) {
    for (const name of ['12411-02-03', '12411-02-03-5']) {
      const input = snapshot(JSON.stringify({Ident: {Service: 'data', Method: 'table'}, Status: {Code: 104, Type: 'Information', Content}, Parameter: {name, regionalkey: '12064472', regionalvariable: 'GEMEIN'}, Object: null}), 'data/table');
      const result = genesisAdapter.parse(input, {...scope, municipalityId: 'strausberg', ags: '12064472'});
      assert.equal(result.coverage.state, state);
      assert.equal(result.coverage.observedRows, 0);
      assert.equal(result.coverage.reason, Content);
      assert.deepEqual(result.observations, []);
      assert.equal(genesisAdapter.discover(input, scope, null).coverage.state, state);
    }
  }
});
test('byte, publisher, DTD and input-size failures are held without parsing or fetching', () => {
  const input = snapshot(table());
  assert.equal(genesisAdapter.parse({...input, sourceSha256: 'b'.repeat(64)}, scope).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.parse({...input, url: 'https://example.org/data'}, scope).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.parse(snapshot('x'.repeat(4 * 1024 * 1024 + 1)), scope).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.discover(snapshot('<!DOCTYPE x>' + wadl, 'application.wadl'), scope, null).coverage.state, 'held_quality');
  assert.equal(genesisAdapter.parse(snapshot(table('12411-06-01', undefined, '31.12.2024')), scope).coverage.state, 'held_quality');
});
test('shared factory retains KR-native metadata for education without altering the baseline map', () => {
  const adapter = createGenesisAdapter('kita-regional-statistics', {'22541-01-04': {level: 'KR', referenceDay: '03-01', statistic: 'approved_places'}});
  const result = adapter.discover(snapshot(metadata('22541-01-04', 'Kreise', 'KREISE'), 'metadata/table'), {...scope, sourceId: 'kita-regional-statistics'}, null);
  assert.equal(new URLSearchParams(result.resources[0].body!).get('regionalkey'), '01053');
  assert.equal(Object.hasOwn(GENESIS_TABLES, '22541-01-04'), false);
});

function storedZip(name: string, content: string): Uint8Array {
  const filename = Buffer.from(name), payload = Buffer.from(content);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + payload.length, 16);
  return Buffer.concat([local, filename, payload, central, filename, end]);
}
test('ZIP tablefile binds evidence to the original archive hash and exact native member; traversal stays held', () => {
  const bytes = storedZip('12411-06-01.csv', table());
  const input = {...snapshot(''), bytes, sourceSha256: digest(bytes), mimeType: 'application/zip'};
  const result = genesisAdapter.parse(input, scope);
  assert.deepEqual(result.observations.map(row => row.value), [7, 3, 4]);
  assert.equal(result.observations[0].evidence[0].sourceSha256, digest(bytes));
  assert.equal(result.observations[0].evidence[0].sheet, '12411-06-01.csv');
  assert.equal(result.observations[0].evidence[0].path, 'archive/12411-06-01.csv/r5c3');
  const unsafe = storedZip('../12411-06-01.csv', table());
  assert.equal(genesisAdapter.parse({...input, bytes: unsafe, sourceSha256: digest(unsafe)}, scope).coverage.state, 'held_quality');
});
