import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('location capture is explicitly initiated and privacy-scoped', () => {
  assert.match(page, /Allow Location Permission\?/);
  assert.match(page, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(page, /source: 'browser'/);
  assert.match(page, /locationState === 'shared'/);
});

test('location endpoint validates and limits session coordinates', () => {
  assert.match(server, /LOCATION_RETENTION_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(server, /latitude < -90 \|\| latitude > 90/);
  assert.match(server, /longitude < -180 \|\| longitude > 180/);
  assert.match(server, /sessionLocations\.delete\(key\)/);
  assert.match(server, /geolocation=\(self\)/);
});
