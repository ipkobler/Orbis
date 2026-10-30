import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('public/index.html', 'utf8');

test('speech pipeline contains the approved pronunciation lexicon', () => {
  assert.match(page, /PRONUNCIATION_LEXICON/);
  assert.match(page, /ready/);
  assert.match(page, /agent/);
  assert.match(page, /'reh-dee'/);
  assert.match(page, /'ay-jent'/);
  assert.match(page, /'K O R A'/);
});

test('pronunciation normalization is applied after speech formatting', () => {
  assert.match(page, /return applyPronunciationLexicon\(t\);/);
  assert.match(page, /const t = speakable\(speechify\(text\)\);/);
});

test('pronunciation overrides are isolated from visible transcript rendering', () => {
  const lexiconStart = page.indexOf('const PRONUNCIATION_LEXICON');
  const speechStart = page.indexOf('function speechify');
  assert.ok(lexiconStart > 0 && speechStart > lexiconStart);
  assert.doesNotMatch(page.slice(lexiconStart, speechStart), /textContent|innerHTML/);
});
