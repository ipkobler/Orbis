import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { VoiceProfiles, VOICE_POLICY } from '../voice-management.js';

const clip = (extension = 'wav', durationSeconds = 12) => ({ extension, bytes: 1024, durationSeconds });

async function profiles() {
  const dir = await mkdtemp('/tmp/kira-voice-test-');
  return new VoiceProfiles(path.join(dir, 'profiles.json')).load();
}

test('exposes the approved voice policy', () => {
  assert.deepEqual(VOICE_POLICY.formats, ['wav', 'mp3']);
  assert.equal(VOICE_POLICY.minSeconds, 10);
  assert.equal(VOICE_POLICY.maxSeconds, 15);
  assert.equal(VOICE_POLICY.retentionDays, 30);
});

test('local profiles take precedence over imported profiles', async () => {
  const v = await profiles();
  v.upsert('main', 'imported', clip('mp3'));
  assert.equal(v.list().main.effectiveSource, 'imported');
  v.upsert('main', 'local', clip());
  assert.equal(v.list().main.effectiveSource, 'local');
});

test('rejects unsupported, oversized, and out-of-range clips', async () => {
  const v = await profiles();
  assert.throws(() => v.upsert('main', 'local', clip('ogg')));
  assert.throws(() => v.upsert('main', 'local', { ...clip(), bytes: VOICE_POLICY.maxBytes + 1 }));
  assert.throws(() => v.upsert('main', 'local', clip('wav', 9)));
  assert.throws(() => v.upsert('main', 'local', clip('wav', 16)));
});

test('reset removes local override and rollback restores retained version', async () => {
  const v = await profiles();
  v.upsert('main', 'imported', clip('mp3'));
  v.upsert('main', 'local', clip());
  v.upsert('main', 'local', clip());
  assert.equal(v.action('main', 'rollback').effectiveSource, 'local');
  assert.equal(v.action('main', 'reset').effectiveSource, 'imported');
});

test('prunes history older than the 30-day retention window', async () => {
  const v = await profiles();
  const old = new Date(Date.now() - 31 * 864e5);
  v.upsert('main', 'imported', clip('mp3'), old);
  v.prune();
  assert.equal(v.data.history.length, 0);
});
