import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceState } from '../voice-state.js';

test('voice state is deterministic and text remains available', () => {
  const voice = new VoiceState(); assert.equal(voice.transition('disable').state, 'silent'); assert.equal(voice.transition('speak').speechActive, true); assert.equal(voice.transition('stop').state, 'silent'); assert.equal(voice.transition('restore').state, 'restoring'); assert.equal(voice.transition('ready').state, 'enabled'); assert.equal(voice.snapshot().textAvailable, true);
});

test('unavailable voice does not disable text', () => { const voice = new VoiceState(); assert.equal(voice.transition('unavailable').state, 'unavailable'); assert.equal(voice.snapshot().textAvailable, true); });
