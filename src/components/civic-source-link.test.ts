import assert from 'node:assert/strict';
import test from 'node:test';
import { civicSourceDraftHref } from './civic-source-link.ts';

test('source handoff opens a native reviewable draft without publishing or changing saved city', () => {
  const href = civicSourceDraftHref('strausberg', 'Published plan & alternatives', 'https://www.stadt-strausberg.de/');
  assert.ok(href);
  const url = new URL(href, 'https://ledger.stadtstack.eu');
  assert.equal(url.origin, 'https://ledger.stadtstack.eu');
  assert.equal(url.searchParams.get('area'), 'places');
  assert.equal(url.searchParams.get('tab'), 'places-say');
  assert.equal(url.searchParams.get('civicCity'), 'strausberg');
  assert.equal(url.searchParams.get('civicTitle'), 'Published plan & alternatives');
  assert.equal(url.searchParams.get('civicSource'), 'https://www.stadt-strausberg.de/');
  assert.equal(url.searchParams.has('action'), false);
});

test('unsafe or unsupported source drafts do not create links', () => {
  for (const value of ['javascript:alert(1)', 'http://example.org', 'https://user:secret@example.org', 'not-a-url']) assert.equal(civicSourceDraftHref('strausberg', 'Title', value), null);
  assert.equal(civicSourceDraftHref('not-a-city', 'Title', 'https://example.org'), null);
  assert.equal(civicSourceDraftHref('strausberg', ' ', 'https://example.org'), null);
  assert.equal(civicSourceDraftHref('strausberg', 'x'.repeat(513), 'https://example.org'), null);
});
