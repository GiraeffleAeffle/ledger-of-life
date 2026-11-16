import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPLAINER_CAPTIONS, EXPLAINER_SOURCES, SOLAR_REFERENCE } from '../data/topic-explainer.ts';
import { nextExplainerCaption, solarScenario } from './topic-explainer-model.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7);

test('solar example converts MWp to kWp and uses the captured official reference', () => {
  const result = solarScenario(10, true);
  assert.equal(result.capacityKwp, 10000);
  close(result.annualKwh, 9956300);
  close(result.annualMwh, 9956.3);
  close(result.householdEquivalents, 9956300 / 3383);
  close(result.maximumGrossMunicipalEuro, 19912.6);
  assert.equal(SOLAR_REFERENCE.maximumEuroPerEligibleKwh, 0.2 / 100);
});

test('an absent voluntary offer gives no §6 payment without changing generation', () => {
  const without = solarScenario(10, false);
  const withOffer = solarScenario(10, true);
  assert.equal(without.maximumGrossMunicipalEuro, 0);
  assert.equal(without.annualKwh, withOffer.annualKwh);
  assert.equal(without.householdEquivalents, withOffer.householdEquivalents);
});

test('every slider capacity scales reference energy and payment linearly', () => {
  const unit = solarScenario(1, true);
  for (let mwp = SOLAR_REFERENCE.minimumMwp; mwp <= SOLAR_REFERENCE.maximumMwp; mwp++) {
    const result = solarScenario(mwp, true);
    close(result.annualKwh, unit.annualKwh * mwp);
    close(result.householdEquivalents, unit.householdEquivalents * mwp);
    close(result.maximumGrossMunicipalEuro, unit.maximumGrossMunicipalEuro * mwp);
  }
});

test('four captions reach a stable ending rather than loop automatically', () => {
  assert.equal(EXPLAINER_CAPTIONS.length, 4);
  assert.equal(EXPLAINER_CAPTIONS.length * SOLAR_REFERENCE.captionMilliseconds, 18000);
  assert.equal(nextExplainerCaption(0), 1);
  assert.equal(nextExplainerCaption(2), 3);
  assert.equal(nextExplainerCaption(3), 3);
});

test('official reference URL exposes all material model assumptions', () => {
  const url = new URL(EXPLAINER_SOURCES.yield.url);
  assert.equal(url.hostname, 're.jrc.ec.europa.eu');
  for (const [key, value] of Object.entries({ lat: '53.480926', lon: '10.616482', peakpower: '1', loss: '14', angle: '35', aspect: '0', mountingplace: 'free', pvtechchoice: 'crystSi', raddatabase: 'PVGIS-SARAH3' })) {
    assert.equal(url.searchParams.get(key), value);
  }
  assert.match(EXPLAINER_SOURCES.households.detail, /2021.*3\.383/);
  assert.match(EXPLAINER_SOURCES.households.detail, /Raumwärme.*Warmwasser.*Beleuchtung.*Elektrogeräten/);
  assert.match(EXPLAINER_SOURCES.law.detail, /keinen automatischen Zahlungsanspruch/);
});

test('UI keeps scenario caveats, playback controls and reduced motion accessible', () => {
  const component = readFileSync(new URL('./topic-explainer.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./topic-explainer.css', import.meta.url), 'utf8');
  assert.match(component, /export function TopicExplainer\(\)/);
  assert.match(component, /Beispielrechnung, keine B70-Prognose/);
  assert.match(component, /tatsächliche Leistung von B70 ist hier unbekannt/);
  assert.match(component, /kein Anspruch, kein Nettovorteil/);
  assert.match(component, /Mengenvergleich, keine Versorgung/);
  assert.match(component, /'Pause' : 'Abspielen'/);
  assert.match(component, /Von vorn/);
  assert.match(component, /Ohne Animation/);
  assert.match(component, /query\.removeEventListener/);
  assert.match(component, /window\.clearTimeout/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /type="range"/);
  assert.match(component, /<details/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(component, /fetch\(|<video|autoPlay/);
});
