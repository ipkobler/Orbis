// Identity and clock safety for heartbeat requests (docs/heartbeat.md §2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { KeyStore, Verifier, authHeader, parseToken, tokenFor } from '../heartbeat.js';

function rig() {
  const clock = { wall: 1793070000000, mono: 0 };
  const keys = new KeyStore({ now: () => clock.wall, overlapS: 600 });
  const v = new Verifier({ keys, wallNow: () => clock.wall, monoNow: () => clock.mono });
  const forge = keys.issue('forge'), ledger = keys.issue('ledger');
  const body = (o = {}) => JSON.stringify({ agent: 'forge', ts: clock.wall, nonce: crypto.randomBytes(8).toString('hex'), ...o });
  return { clock, keys, v, forge, ledger, body };
}

test('a correctly signed heartbeat is accepted', () => {
  const r = rig(); const b = r.body({ status: 'busy', progress: 3 });
  const out = r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), b);
  assert.equal(out.ok, true); assert.equal(out.agent, 'forge'); assert.equal(out.status, 'busy'); assert.equal(out.progress, 3);
});

test('the token round-trips and never exposes more than kid + secret', () => {
  const r = rig(); const p = parseToken(tokenFor(r.forge));
  assert.deepEqual(p, { kid: r.forge.kid, secret: r.forge.secret });
  assert.equal(parseToken('obk_zz_bad'), null);
  assert.ok(r.keys.list().every(k => !('secret' in k)));
});

test('identity: unknown key, bad signature and another agent’s key are rejected', () => {
  const r = rig(); const b = r.body();
  assert.equal(r.v.verify(authHeader('deadbeef', r.forge.secret, b), b).reason, 'unknown_key');
  assert.equal(r.v.verify(authHeader(r.forge.kid, r.ledger.secret, b), b).reason, 'bad_signature');
  assert.equal(r.v.verify(authHeader(r.ledger.kid, r.ledger.secret, b), b).reason, 'wrong_agent');   // Ledger's key reporting for Forge
  const tampered = b.replace('"forge"', '"forgf"');
  assert.equal(r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), tampered).reason, 'bad_signature');
  assert.equal(r.v.verify('', b).reason, 'unknown_key');
});

test('clock: more than 60 s of skew either way is rejected; within it is accepted and reported', () => {
  const r = rig();
  for (const off of [61_000, -61_000]) { const b = r.body({ ts: r.clock.wall + off }); assert.equal(r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), b).reason, 'clock_skew'); }
  const b = r.body({ ts: r.clock.wall - 45_000 });
  const out = r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), b);
  assert.equal(out.ok, true); assert.equal(out.skewS, 45);
});

test('replay of an accepted heartbeat is rejected; heartbeats faster than 2 s are rejected', () => {
  const r = rig(); const b = r.body(); const h = authHeader(r.forge.kid, r.forge.secret, b);
  assert.equal(r.v.verify(h, b).ok, true);
  const b2 = r.body(); r.clock.mono += 500;                       // a new beat 0.5 s after the last accepted one
  assert.equal(r.v.verify(authHeader(r.forge.kid, r.forge.secret, b2), b2).reason, 'too_fast');
  r.clock.mono += 2000;
  assert.equal(r.v.verify(authHeader(r.forge.kid, r.forge.secret, b2), b2).ok, true);
  r.clock.mono += 5000;                                           // the first beat sent again, captured and replayed
  assert.equal(r.v.verify(h, b).reason, 'replay');
});

test('malformed bodies are rejected before they can matter', () => {
  const r = rig();
  for (const b of ['', '{', JSON.stringify({ agent: 'forge', ts: 'now', nonce: 'aa' }), 'x'.repeat(3000), r.body({ status: 'sleeping' })]) {
    assert.equal(r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), b).ok, false);
  }
});

test('rotation: the old key keeps working for the overlap window, then stops; revoke removes all keys at once', () => {
  const r = rig(); const old = r.forge, fresh = r.keys.issue('forge');
  const b1 = r.body(); assert.equal(r.v.verify(authHeader(old.kid, old.secret, b1), b1).ok, true);
  r.clock.wall += 601_000; r.clock.mono += 601_000;
  const b2 = r.body(); assert.equal(r.v.verify(authHeader(old.kid, old.secret, b2), b2).reason, 'unknown_key');
  const b3 = r.body(); assert.equal(r.v.verify(authHeader(fresh.kid, fresh.secret, b3), b3).ok, true);
  assert.equal(r.keys.revoke('forge'), 1);
  r.clock.mono += 3000;
  const b4 = r.body(); assert.equal(r.v.verify(authHeader(fresh.kid, fresh.secret, b4), b4).reason, 'unknown_key');
});

test('rejections are counted by reason', () => {
  const r = rig(); const b = r.body({ ts: r.clock.wall + 999_999 });
  r.v.verify(authHeader(r.forge.kid, r.forge.secret, b), b);
  r.v.verify('junk', b);
  assert.equal(r.v.rejected.get('clock_skew'), 1);
  assert.equal(r.v.rejected.get('unknown_key'), 1);
});
