import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARRIVAL_PHASES } from './types.ts';
import { arrivalGuideCityIds, arrivalGuideFor } from './index.ts';

// A step may claim to be official only when its source is the city, the district, the state or the federal government.
// Adding a host here is a deliberate decision that the new source really is one of those.
const officialHosts = ['stadt-strausberg.de', 'strausberg.de', 'maerkisch-oderland.de', 'lkmol.de', 'brandenburg.de', 'gesetze-im-internet.de', 'gesund.bund.de'];
const onHost = (url: string, hosts: readonly string[]) => hosts.some((host) => new URL(url).hostname === host || new URL(url).hostname.endsWith(`.${host}`));

for (const cityId of arrivalGuideCityIds) {
  const guide = arrivalGuideFor(cityId)!;
  const sources = [...guide.steps.map((item) => item.source), ...guide.contacts.map((item) => item.source), ...guide.groups.map((item) => item.source)];

  test(`${cityId}: every claim cites a page and the date it was read, never after the guide was prepared`, () => {
    assert.ok(sources.length > 0);
    for (const source of sources) {
      assert.match(source.url, /^https?:\/\//, source.label);
      assert.match(source.checkedOn, /^\d{4}-\d{2}-\d{2}$/, source.label);
      assert.ok(source.checkedOn <= guide.preparedOn, `${source.label} was checked after the guide was prepared`);
    }
  });

  test(`${cityId}: a step is official only when its source is a government host`, () => {
    for (const step of guide.steps.filter((item) => item.official))
      assert.ok(onHost(step.source.url, officialHosts), `${step.id} is marked official but cites ${step.source.url}`);
  });

  test(`${cityId}: no private person's phone number or email is published`, () => {
    const text = JSON.stringify(guide);
    assert.deepEqual(text.match(/\b0\d{3,5}[ /-]?\d{3,}/g) ?? [], []);
    assert.deepEqual(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [], []);
  });

  test(`${cityId}: ids are unique inside each list, and every phase has at least one step`, () => {
    for (const list of [guide.steps, guide.contacts, guide.groups]) assert.equal(new Set(list.map((item) => item.id)).size, list.length);
    for (const phase of ARRIVAL_PHASES) assert.ok(guide.steps.some((step) => step.phase === phase), `no step in ${phase}`);
  });
}

test('a city without a written guide has none', () => {
  assert.equal(arrivalGuideFor('nowhere'), null);
  assert.equal(arrivalGuideFor('__proto__'), null);
});
