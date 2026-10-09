import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_GAME_EDITIONS, cityGameDestination } from './stadtstack-services.ts';

test('only confirmed city IDs open their exact game edition', () => {
  assert.deepEqual(CITY_GAME_EDITIONS.map(({ cityId, href }) => ({ cityId, href })), [
    { cityId: 'strausberg', href: 'https://spiel.stadtstack.eu/strausberg' },
  ]);
  for (const edition of CITY_GAME_EDITIONS) {
    const destination = cityGameDestination(edition.cityId);
    assert.equal(destination, edition);
    assert.equal(destination.kind, 'edition');
    assert.match(destination.status, /external browser game/);
  }
});

test('other snapshot cities and unknown or absent cities explicitly open the chooser', () => {
  const unsupported = ['koeln', 'muenster', 'wuppertal', 'castrop-rauxel', 'duesseldorf', 'dresden', 'freiburg'];
  const unconfirmed = ['roebel', 'Röbel/Müritz', 'Strausberg', 'strausberg/', 'constructor', '__proto__', 'https://example.com', '', null, undefined];
  for (const cityId of [...unsupported, ...unconfirmed]) {
    const destination = cityGameDestination(cityId);
    assert.equal(destination.kind, 'chooser', String(cityId));
    assert.equal(destination.href, 'https://spiel.stadtstack.eu/');
    assert.match(destination.status, /No confirmed edition/);
    assert.match(destination.status, /choose an edition/);
    assert.equal('cityId' in destination, false);
  }
});


test('external destinations carry no Ledger account, city pins or redirect parameters', () => {
  for (const href of [cityGameDestination(null).href, ...CITY_GAME_EDITIONS.map((edition) => edition.href)]) {
    const url = new URL(href);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
  }
});
