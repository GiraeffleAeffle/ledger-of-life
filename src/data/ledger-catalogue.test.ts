import test from 'node:test';
import assert from 'node:assert/strict';
import { IDEAS, LEDGER_ADAPTERS, LEDGER_TOPICS } from './ledger-catalogue.ts';
import { SECTIONS } from './sections.ts';

test('capabilities and adapters belong to catalogue topics', () => {
  const topics = new Set(LEDGER_TOPICS.map((topic) => topic.id));
  const ideas = new Set(IDEAS.map((idea) => idea.id));
  assert.equal(ideas.size, IDEAS.length, 'idea ids must be unique');
  for (const idea of IDEAS) assert.ok(topics.has(idea.topic), `unknown topic on ${idea.id}`);
  for (const adapter of LEDGER_ADAPTERS) {
    assert.ok(topics.has(adapter.topic), `unknown topic on ${adapter.id}`);
    for (const id of adapter.capabilities) assert.ok(ideas.has(id), `unknown capability ${id} on ${adapter.id}`);
  }
  for (const topic of LEDGER_TOPICS) {
    assert.ok(IDEAS.some((idea) => idea.topic === topic.id), `no capability in ${topic.id}`);
    assert.ok(LEDGER_ADAPTERS.some((adapter) => adapter.topic === topic.id), `no adapter in ${topic.id}`);
  }
});

test('capability destinations and adapter actions target their section owner', () => {
  for (const idea of IDEAS) {
    if (idea.destination?.section) assert.equal(SECTIONS[idea.destination.section], idea.destination.area, `destination on ${idea.id}`);
  }
  for (const adapter of LEDGER_ADAPTERS) {
    for (const action of [adapter.action, adapter.secondaryAction]) {
      if (action?.kind === 'area' && action.section) assert.equal(SECTIONS[action.section], action.area, `action on ${adapter.id}`);
    }
  }
});

test('an adapter is operated in the area that owns its topic', () => {
  // A topic is subject matter; its area is the one place its adapters are operated (Energy & devices -> Money).
  for (const adapter of LEDGER_ADAPTERS) {
    const owner = LEDGER_TOPICS.find((topic) => topic.id === adapter.topic)!.area;
    if (adapter.action.kind === 'area') assert.equal(adapter.action.area, owner, `${adapter.id} opens ${adapter.action.area}, its topic is owned by ${owner}`);
    if (adapter.action.kind === 'share') assert.equal(owner, 'money', `${adapter.id} opens the share workflows in Money`);
  }
});

test('only a roadmap adapter claims to be unavailable, and a live one never claims to be roadmap', () => {
  for (const adapter of LEDGER_ADAPTERS) {
    const roadmap = adapter.connection === 'future';
    assert.equal(adapter.explain.effort === 'not available yet', roadmap, `${adapter.id} effort`);
    assert.equal(adapter.explain.reality === 'roadmap', roadmap, `${adapter.id} reality`);
    assert.equal(adapter.maturity === 'planned', roadmap, `${adapter.id} maturity`);
  }
});

test('deposit availability does not send a person into a different hosted money product', () => {
  const deposit = IDEAS.find((idea) => idea.id === 'rental-deposit')!;
  assert.equal(deposit.availability, 'Available on this site');
  assert.equal(deposit.destination?.area, 'home');
  const rehearsal = IDEAS.find((idea) => idea.id === 'rental-earnings')!;
  assert.equal(rehearsal.availability, 'Needs a local setup');
  assert.equal(rehearsal.destination, undefined, 'local rehearsal must not open a hosted operation');
  const loan = IDEAS.find((idea) => idea.id === 'borrow-against-shares')!;
  assert.equal(loan.availability, 'Available on this site');
});

test('planned capabilities are information, not unfinished setup destinations', () => {
  for (const idea of IDEAS.filter((item) => item.availability === 'Planned')) {
    assert.equal(idea.status, 'planned');
    assert.equal(idea.destination, undefined, `${idea.id} must not offer an operating destination`);
  }
});
