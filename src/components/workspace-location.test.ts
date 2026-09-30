import test from 'node:test';
import assert from 'node:assert/strict';
import { areaFromSearch, tabFromSearch, withArea, withTab } from './workspace-location.ts';

test('a linked area survives URL parsing while unknown areas return to Today', () => {
  assert.equal(areaFromSearch('?area=money&tab=money-shares'), 'money');
  assert.equal(areaFromSearch('?area=unrecognized'), 'overview');
  assert.equal(areaFromSearch('?area=__proto__'), 'overview');
});

test('navigation preserves an invitation hash and unrelated query parameters', () => {
  const url = 'https://example.org/?source=share#invitation=secret';
  const money = withArea(url, 'money');
  assert.equal(money, '/?source=share&area=money#invitation=secret');
  assert.equal(withTab(`https://example.org${money}`, 'money-shares'), '/?source=share&area=money&tab=money-shares#invitation=secret');
  assert.equal(withArea(`https://example.org${money}`, 'overview'), '/?source=share#invitation=secret');
});

test('a tab stays with its area: leaving the area drops it, staying keeps it', () => {
  assert.equal(withArea('https://example.org/?area=money&tab=money-devices', 'places'), '/?area=places');
  assert.equal(withArea('https://example.org/?area=money&tab=money-devices', 'overview'), '/');
  assert.equal(withArea('https://example.org/?area=money&tab=money-shares', 'money'), '/?area=money&tab=money-shares');
});

test('invalid Money tabs fall back to Holdings', () => {
  assert.equal(tabFromSearch('?tab=money-shares', ['money-holdings', 'money-shares']), 'money-shares');
  assert.equal(tabFromSearch('?tab=other', ['money-holdings', 'money-shares']), 'money-holdings');
});
