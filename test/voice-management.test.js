import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VoiceLibrary, VOICE_POLICY, parseWav, cleanWav } from '../voice-management.js';

// a mono 16-bit WAV of `seconds` (a quiet tone), optionally with an extra chunk before the audio like real recorders write
function wav(seconds, { rate = 24000, channels = 1, extraChunk = false } = {}) {
  const frames = Math.round(seconds * rate), data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), (i * channels + c) * 2);
  const list = extraChunk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]) : Buffer.alloc(0);
  const h = Buffer.alloc(36);
  h.write('RIFF', 0); h.writeUInt32LE(28 + list.length + 8 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, list, dh, data]);
}
async function lib() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kora-voice-'));
  return new VoiceLibrary({ file: path.join(dir, 'state', 'voice-library.json'), dir: path.join(dir, 'clips') }).load();
}
const exists = p => stat(p).then(() => true, () => false);

test('policy: 5–15 s WAV clips under 10 MB, four voice sources', () => {
  assert.equal(VOICE_POLICY.minSeconds, 5);
  assert.equal(VOICE_POLICY.maxSeconds, 15);
  assert.equal(VOICE_POLICY.maxBytes, 10 * 1024 * 1024);
  assert.deepEqual(VOICE_POLICY.sources, ['default', 'custom', 'builtin', 'browser']);
});

test('parseWav reads real durations, skips extra chunks, and refuses other files', () => {
  assert.equal(parseWav(wav(6)).durationSeconds, 6);
  assert.equal(parseWav(wav(6, { channels: 2, rate: 48000, extraChunk: true })).durationSeconds, 6);
  assert.throws(() => parseWav(Buffer.from('ID3' + 'x'.repeat(100))), /WAV/);
  const eight = wav(6); eight.writeUInt16LE(8, 34);
  assert.throws(() => parseWav(eight), /16-bit/);
  const trimmed = cleanWav(wav(20), parseWav(wav(20)), 15);
  assert.equal(parseWav(trimmed).durationSeconds, 15);
});

test('clips under 5 s are refused; over 15 s are trimmed to 15 s', async () => {
  const v = await lib();
  await assert.rejects(v.addClip('main', wav(4.2)), /at least 5 seconds/);
  const { clip } = await v.addClip('main', wav(19), { name: 'Long take' });
  assert.equal(clip.durationSeconds, 15);
  assert.equal(parseWav(await readFile(v.clipPath(clip.id))).durationSeconds, 15);
  assert.equal(clip.name, 'Long take');
  await assert.rejects(v.addClip('../etc', wav(6)), /Unknown agent/);
});

test('picking a custom clip writes <agent>.wav for the voice service; other sources remove it', async () => {
  const v = await lib();
  const { clip } = await v.addClip('forge', wav(8), { origin: 'recording' });
  assert.equal(clip.origin, 'recording');
  assert.equal(v.ttsVoice('forge'), 'forge');                         // default: the repo clip, by agent id
  await v.select('forge', { source: 'custom', clipId: clip.id });
  const active = path.join(v.dir, 'forge.wav');
  assert.ok(await exists(active));
  assert.deepEqual(await readFile(active), await readFile(v.clipPath(clip.id)));
  assert.equal(v.ttsVoice('forge'), 'forge');
  assert.deepEqual(v.list().clips[0].usedBy, ['forge']);

  await v.select('forge', { source: 'builtin', builtin: 'alba' });
  assert.equal(v.ttsVoice('forge'), 'builtin:alba');
  assert.equal(await exists(active), false);

  await v.select('forge', { source: 'browser' });
  assert.equal(v.ttsVoice('forge'), null);

  const prev = await v.select('forge', { source: 'default' });
  assert.equal(prev.source, 'browser');
  assert.equal(v.choice('forge').source, 'default');
  await assert.rejects(v.select('forge', { source: 'custom', clipId: 'ffffffffffff' }), /not found/);
  await assert.rejects(v.select('forge', { source: 'builtin', builtin: '../x' }), /built-in/);
});

test('trying a voice before picking it', () => {
  assert.equal(VoiceLibrary.tryVoice('main', { source: 'custom', clipId: 'abcdef012345' }), 'clip:abcdef012345');
  assert.equal(VoiceLibrary.tryVoice('main', { source: 'builtin', builtin: 'jane' }), 'builtin:jane');
  assert.equal(VoiceLibrary.tryVoice('main', { source: 'default' }), 'default:main');
  assert.throws(() => VoiceLibrary.tryVoice('main', { source: 'custom', clipId: '../../x' }));
});

test('deleting the clip an agent uses puts that agent back on its default voice', async () => {
  const v = await lib();
  const { clip } = await v.addClip('ledger', wav(7));
  await v.select('ledger', { source: 'custom', clipId: clip.id });
  assert.deepEqual(await v.deleteClip(clip.id), ['ledger']);
  assert.equal(v.choice('ledger').source, 'default');
  assert.equal(await exists(path.join(v.dir, 'ledger.wav')), false);
  assert.equal(await exists(v.clipPath(clip.id)), false);
  assert.equal(v.list().clips.length, 0);
});

test('rename, persistence across restarts, and the per-agent clip limit', async () => {
  const v = await lib();
  const first = (await v.addClip('main', wav(6))).clip;
  await v.select('main', { source: 'custom', clipId: first.id });
  v.renameClip(first.id, '  Studio   take <1>  ');
  assert.equal(v.clip(first.id).name, 'Studio take 1');
  for (let i = 0; i < VOICE_POLICY.maxClipsPerAgent + 2; i++) await v.addClip('main', wav(5.5));
  const mine = v.list().clips.filter(c => c.agent === 'main');
  assert.equal(mine.length, VOICE_POLICY.maxClipsPerAgent);
  assert.ok(mine.some(c => c.id === first.id), 'the clip in use is never removed');
  assert.equal((await readdir(v.libDir)).length, VOICE_POLICY.maxClipsPerAgent);
  await v.save();
  const again = await new VoiceLibrary({ file: v.file, dir: v.dir }).load();
  assert.equal(again.choice('main').clipId, first.id);
  assert.equal(again.list().clips.length, VOICE_POLICY.maxClipsPerAgent);
});

test('sync restores the active file and drops choices whose clip is gone', async () => {
  const v = await lib();
  const { clip } = await v.addClip('main', wav(6));
  await v.select('main', { source: 'custom', clipId: clip.id });
  v.data.agents.forge = { source: 'custom', clipId: 'aaaaaaaaaaaa' };
  const { rm } = await import('node:fs/promises');
  await rm(path.join(v.dir, 'main.wav'));
  await v.sync();
  assert.ok(await exists(path.join(v.dir, 'main.wav')));
  assert.equal(v.choice('forge').source, 'default');
});
