import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile layout uses the visual viewport for the app height', () => {
  assert.match(page, /--app-height/);
  assert.match(page, /window\.visualViewport/);
  assert.match(page, /viewport\?\.addEventListener\('resize'/);
});

test('landscape layout keeps the dock and stage within the reduced viewport', () => {
  assert.match(page, /@media \(orientation: landscape\) and \(max-width: 1000px\)/);
  assert.match(page, /grid-template-rows: auto auto minmax\(0, 1fr\) auto; gap: 6px/);
  assert.doesNotMatch(page, /body \{ overflow: auto; \}/);
  assert.match(page, /form\.ask \{ padding-bottom: env\(safe-area-inset-bottom/);
});

test('keyboard state is represented explicitly for reduced viewport styling', () => {
  assert.match(page, /body\.keyboard-open/);
  assert.match(page, /classList\.toggle\('keyboard-open'/);
  assert.match(page, /height < viewportBaseHeight - 120/);
});
