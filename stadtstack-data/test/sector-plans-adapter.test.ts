import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest, ObservationSchema} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope} from '../src/district-adapter-contract.ts';
import {discoverSectorPlans, parseSectorPlans, SECTOR_PLAN_SOURCES, sectorPlansCapabilityReceipt} from '../src/adapters/sector-plans.ts';

// Synthetic bounded native HTML, not downloaded plans or normalized parser envelopes.
// These fixtures establish mapping behavior, not that source PDF schemas are verified.
function scope(sourceId = 'sep-mol'): AdapterScope {
  const ags = sourceId.includes('lup') ? '13076090' : sourceId.includes('rz') ? '01053100' : '12064472';
  return {publisherId: 'district-fixture', sourceId, municipalityId: 'fixture-town', ags, tenant: null, observationWindow: '2026-10-11'};
}
function snapshot(html: string, options: Partial<AdmittedSnapshot> = {}): AdmittedSnapshot {
  const bytes = new TextEncoder().encode(html);
  return {bytes, sourceSha256: digest(bytes), url: 'https://example.org/plans', mimeType: 'text/html; charset=utf-8', retrievedAt: '2026-10-11T00:00:00Z', policyReceiptSha256: digest('fixture-only-admission'), sourceVersion: 'fixture-representation-v1', ...options};
}
const school = `<table><caption>Schulentwicklungsplan 2025/26–2029/30</caption><tr><th>Schulnummer</th><th>AGS</th><th>Schuljahr</th><th>Plätze (Prognose)</th><th>Schülerprognose</th><th>Schuleinzugsbereich</th></tr><tr><td>00123</td><td>12064472</td><td>2029/30</td><td> 240 </td><td>215</td><td>Strausberg Nord</td></tr></table>`;
const transport = `<table><caption>Regionaler Nahverkehrsplan Teil B</caption><tr><th>Linie</th><th>AGS</th><th>Planungszeitraum</th><th>Zielangebot</th><th>Zieltakt (Minuten)</th><th>Mindestbedienung</th></tr><tr><td>001</td><td>01053100</td><td>2022–2026</td><td>werktags</td><td>60</td><td>zwei Fahrtenpaare</td></tr></table>`;

test('school forecasts and catchments retain native fields, leading zero IDs and no implemented seats', () => {
  const input = snapshot(school);
  const result = parseSectorPlans(input, scope());
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.observations.length, 3);
  const seats = result.observations.find(row => row.predicate === 'forecast_capacity')!;
  assert.equal(seats.value, 240);
  assert.equal(seats.unit, 'seats');
  assert.equal(seats.date, '2029/30');
  assert.equal(seats.dateRole, 'planning_period');
  assert.equal(seats.evidence[0].rawValue, ' 240 ');
  assert.equal(seats.geography.ags, '12064472');
  assert.ok(seats.nativeId.includes('00123'));
  for (const row of result.observations) {
    assert.ok(ObservationSchema.safeParse(row).success);
    assert.equal(row.financialRole, 'none');
    assert.equal(row.evidence[0].sourceSha256, input.sourceSha256);
    assert.ok(!/implements|opened|actual|paid|adopts/.test(row.predicate));
  }
  assert.deepEqual(result, parseSectorPlans(input, scope()));
});
test('transport service standards remain targets and source-explicit geography preserves SH zero', () => {
  const result = parseSectorPlans(snapshot(transport), scope('rnvp-rz'));
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.every(row => row.predicate.startsWith('target_service')));
  assert.ok(result.observations.every(row => row.geography.ags === '01053100'));
  assert.equal(result.observations.find(row => row.unit === 'minutes')!.value, 60);
});
test('explicit locally linked Kreistag adoption is distinct from title, forecast and planning horizon', () => {
  const html = '<p>Der <a href="/media/custom/3150_1536_1.PDF?1678701703=">5. Regionaler Nahverkehrsplan 2022–2026</a> wurde vom Kreistag am 22.09.2022 beschlossen.</p>';
  const result = parseSectorPlans(snapshot(html), scope('rnvp-rz'));
  const adoption = result.observations.find(row => row.predicate === 'adopts_plan')!;
  assert.equal(adoption.date, '2022-09-22');
  assert.equal(adoption.dateRole, 'adoption');
  assert.equal(adoption.value, 'https://example.org/media/custom/3150_1536_1.PDF?1678701703=');
  assert.equal(adoption.geography.basis, 'unknown');
  assert.ok(adoption.evidence.some(field => field.rawValue === '/media/custom/3150_1536_1.PDF?1678701703='));
  assert.ok(result.observations.some(row => row.predicate === 'planning_horizon'));
  assert.ok(!result.observations.some(row => row.predicate === 'implements'));
});
test('draft, conditional, invalid date and multiple-plan context never become adoption', () => {
  for (const text of ['Entwurf, vom Kreistag am 22.09.2022 beschlossen', 'vom Kreistag am 31.02.2022 beschlossen', 'vom Kreistag am 22.09.2022 beschlossen werden soll', 'nicht vom Kreistag am 22.09.2022 beschlossen']) {
    const result = parseSectorPlans(snapshot(`<p><a href="/plan.pdf">Nahverkehrsplan 2022–2026</a> ${text}</p>`), scope('rnvp-rz'));
    assert.ok(!result.observations.some(row => row.predicate === 'adopts_plan'));
  }
  const multiple = snapshot('<p><a href="/a.pdf">Nahverkehrsplan A</a><a href="/b.pdf">Nahverkehrsplan B</a> vom Kreistag am 22.09.2022 beschlossen.</p>');
  assert.ok(!parseSectorPlans(multiple, scope('rnvp-rz')).observations.some(row => row.predicate === 'adopts_plan'));
});
test('native download.php fid and revision query identity are preserved in discovery', () => {
  const input = snapshot('<a href="/output/download.php?fid=3378.10751.1.PDF">Schulentwicklungsplan 2022/23–2026/27</a>');
  const result = discoverSectorPlans(input, scope('sep-lup'));
  assert.equal(result.resources[0].url, 'https://example.org/output/download.php?fid=3378.10751.1.PDF');
  assert.equal(result.resources[0].format, 'pdf');
  assert.equal(result.resources[0].nativeId, result.resources[0].url);
  assert.equal(result.coverage.state, 'partial');
});
test('pagination exposes next admitted-page cursor without performing network or inferring completeness', () => {
  const input = snapshot('<a href="/a.pdf">Nahverkehrsplan 2025–2029</a><a rel="next" href="?page=2">Weiter</a>');
  const result = discoverSectorPlans(input, scope('nvp-mol'));
  assert.equal(result.coverage.nextCursor, 'https://example.org/plans?page=2');
  assert.equal(result.resources.length, 2);
  assert.equal(parseSectorPlans(input, scope('nvp-mol')).coverage.state, 'partial');
  const page = snapshot('<p>Ende</p>', {url: result.coverage.nextCursor!});
  assert.equal(discoverSectorPlans(page, scope('nvp-mol'), page.url).coverage.state, 'empty');
  assert.equal(discoverSectorPlans(page, scope('nvp-mol'), '?page=99').coverage.state, 'held_quality');
});
test('empty is page-local and distinct from unlocated RZ school', () => {
  assert.equal(parseSectorPlans(snapshot('<p>Keine Downloads</p>'), scope()).coverage.state, 'empty');
  const rz = snapshot('<h1>Schulamt</h1><a href="/agenda-2007.pdf">Schulentwicklungsplan 2007</a>');
  assert.equal(parseSectorPlans(rz, scope('sep-rz-gap')).coverage.state, 'not_checked');
  assert.deepEqual(discoverSectorPlans(rz, scope('sep-rz-gap')).resources, []);
});
test('changed schema, ambiguous cells and invalid native geography are held, not zero capacity', () => {
  for (const html of [school.replace('Plätze (Prognose)', 'Kapazität neu').replace('Schülerprognose', 'neuer Wert').replace('Schuleinzugsbereich', 'anderer Wert'), school.replace('<td> 240 </td>', '<td colspan="2">240</td>'), school.replace('12064472</td>', '12064</td>'), school.replace(' 240 ', '240*')]) {
    const result = parseSectorPlans(snapshot(html), scope());
    assert.equal(result.coverage.state, 'held_quality');
    assert.equal(result.observations.length, 0);
  }
});
test('German dotted thousands preserve integer seats and pupils; fractional or ambiguous counts are held', () => {
  const result = parseSectorPlans(snapshot(school.replace(' 240 ', '1.050').replace('<td>215</td>', '<td>2.345</td>')), scope());
  assert.equal(result.coverage.state, 'partial');
  assert.equal(result.observations.find(row => row.predicate === 'forecast_capacity')!.value, 1050);
  assert.equal(result.observations.find(row => row.predicate === 'forecast_pupils')!.value, 2345);
  assert.equal(result.observations.find(row => row.predicate === 'forecast_capacity')!.evidence[0].rawValue, '1.050');
  for (const value of ['1.234,5', '240,5', '240.5', '1.23', '1,050', '9007199254740992']) {
    const invalidSeats = parseSectorPlans(snapshot(school.replace(' 240 ', value)), scope());
    assert.equal(invalidSeats.coverage.state, 'held_quality', value);
    assert.equal(invalidSeats.observations.length, 0, value);
    const invalidPupils = parseSectorPlans(snapshot(school.replace('<td>215</td>', `<td>${value}</td>`)), scope());
    assert.equal(invalidPupils.coverage.state, 'held_quality', value);
    assert.equal(invalidPupils.observations.length, 0, value);
  }
});
test('missing suppression marker is not numeric zero and municipality is never inherited from requested scope', () => {
  const missing = school.replace(' 240 ', '–').replace('<th>AGS</th>', '').replace('<td>12064472</td>', '');
  const result = parseSectorPlans(snapshot(missing), scope());
  assert.ok(!result.observations.some(row => row.predicate === 'forecast_capacity'));
  assert.ok(result.observations.every(row => row.geography.ags === null));
});
test('explicit withdrawn document emits only withdrawal metadata; omission is not a tombstone', () => {
  const input = snapshot('<p><a href="/old.pdf">Schulentwicklungsplan 2022/23–2026/27 (zurückgezogen)</a></p>');
  assert.equal(discoverSectorPlans(input, scope('sep-lup')).resources.length, 0);
  const result = parseSectorPlans(input, scope('sep-lup'));
  assert.deepEqual(result.observations.map(row => row.predicate), ['document_withdrawn']);
  assert.equal(parseSectorPlans(snapshot('<p>Leer</p>'), scope('sep-lup')).observations.length, 0);
});
test('access-control snapshots are blocked and never empty', () => {
  for (const html of ['<h1>Access denied</h1>', '<form><input type="password"></form>', '<title>CAPTCHA</title>']) {
    assert.equal(discoverSectorPlans(snapshot(html), scope()).coverage.state, 'blocked_access');
    assert.equal(parseSectorPlans(snapshot(html), scope()).coverage.state, 'blocked_access');
  }
});
test('native PDF reference is discoverable, but bytes cannot masquerade as HTML table evidence', () => {
  const input = snapshot('%PDF-1.7\nfixture', {mimeType: 'application/pdf', url: 'https://example.org/native.pdf'});
  assert.equal(discoverSectorPlans(input, scope('sep-lup')).resources[0].format, 'pdf');
  const result = parseSectorPlans(input, scope('sep-lup'));
  assert.equal(result.coverage.state, 'held_quality');
  assert.equal(result.observations.length, 0);
});
test('byte binding and receipt are prerequisites, bounds hold without truncation', () => {
  assert.throws(() => parseSectorPlans(snapshot(school, {sourceSha256: digest('wrong bytes')}), scope()), /byte binding/);
  assert.throws(() => parseSectorPlans(snapshot(school, {policyReceiptSha256: 'not-a-receipt'}), scope()));
  const many = '<a href="/a.pdf">Schulentwicklungsplan</a>'.repeat(257);
  assert.equal(discoverSectorPlans(snapshot(many), scope()).coverage.state, 'held_quality');
  assert.equal(parseSectorPlans(snapshot('x'.repeat(4_000_001)), scope()).coverage.state, 'held_quality');
});
test('all six family distributions have explicit non-operational source coverage', () => {
  assert.equal(Object.keys(SECTOR_PLAN_SOURCES).length, 6);
  assert.deepEqual(sectorPlansCapabilityReceipt.implementedFormats, ['html']);
  for (const id of Object.keys(SECTOR_PLAN_SOURCES)) {
    const result = parseSectorPlans(snapshot('<p>Index</p>'), scope(id));
    assert.equal(result.coverage.state, id === 'sep-rz-gap' ? 'not_checked' : 'empty');
  }
  assert.equal(parseSectorPlans(snapshot(school), {...scope(), ags: '01053100'}).coverage.state, 'not_applicable');
});
