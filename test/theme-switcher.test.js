import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('theme switcher exposes system, light, and dark modes', () => {
  assert.match(page, /id="themeMode"/);
  assert.match(page, /value="system"/);
  assert.match(page, /value="light"/);
  assert.match(page, /value="dark"/);
});

test('theme preference persists and system changes are observed', () => {
  assert.match(page, /store\.get\('themeMode', 'system'\)/);
  assert.match(page, /store\.set\('themeMode', e\.target\.value\)/);
  assert.match(page, /prefers-color-scheme: light/);
  assert.match(page, /themeQuery\.addEventListener/);
});

test('light mode uses shared semantic tokens and preserves dark defaults', () => {
  assert.match(page, /:root\[data-theme="light"\]/);
  assert.match(page, /--void: #f2f6fb/);
  assert.match(page, /color-scheme: dark/);
});

test('boot console keeps its dark palette in light mode', () => {
  assert.match(page, /:root\[data-theme="light"\] \.boot \{[^}]*--void-lo: #020814/);
  assert.doesNotMatch(page, /\[data-theme="light"\] \.kh-name \{ color: var\(--ink\)/);
});
