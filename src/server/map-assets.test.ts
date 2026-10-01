import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedMapPath, rewriteMapAssets } from './map-assets.ts';

test('map proxy limits requests to published asset paths and tile coordinates', () => {
  assert.equal(allowedMapPath('/planet/20260927_080001_pt/15/17647/10739.pbf'), true);
  assert.equal(allowedMapPath('/fonts/Noto Sans Regular/0-255.pbf'), true);
  for (const path of ['/planet/20260927_080001_pt/0/1/0.pbf', '/planet/20260927_080001_pt/23/0/0.pbf', '/styles/../../private', '/styles/liberty?url=https://example.org', '//example.org/a', '/fonts/a\\b/0-255.pbf', '/planet/20260927_080001_pt/{z}/{x}/{y}.pbf']) {
    assert.equal(allowedMapPath(path), false, path);
  }
});

test('style and tile manifests stay same-origin while attribution metadata survives', () => {
  const manifest = { sources: { osm: { url: 'https://tiles.openfreemap.org/planet' } }, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm', tiles: ['https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf'], description: 'https://openfreemap.org', attribution: '<a href="https://openstreetmap.org">OpenStreetMap</a>' };
  assert.deepEqual(rewriteMapAssets(manifest, '', 'https://ledger.example'), { sources: { osm: { url: '/api/map/planet' } }, glyphs: '/api/map/fonts/{fontstack}/{range}.pbf', sprite: 'https://ledger.example/api/map/sprites/ofm_f384/ofm', tiles: ['/api/map/planet/20260927_080001_pt/{z}/{x}/{y}.pbf'], description: manifest.description, attribution: manifest.attribution });
  for (const url of ['https://evil.example/planet', 'https://tiles.openfreemap.org@evil.example/planet', 'https://tiles.openfreemap.org/planet?secret=1', 'https://tiles.openfreemap.org/private']) assert.throws(() => rewriteMapAssets({ tiles: [url] }));
});
