// Acceptance tests for liveness + alerts (docs/heartbeat.md §9). Everything runs on a fake monotonic clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Liveness, defaultConfig } from '../liveness.js';
import { Alerts } from '../alerts.js';

const I = 30, TICK = 5;
function rig({ saved = null, alertedThrough = 0 } = {}) {
  const clock = { t: 1_000_000 };
  const live = new Liveness({ now: () => clock.t, wallNow: () => 1793070000000 + clock.t, config: defaultConfig({ HEARTBEAT_INTERVAL_S: I }), saved });
  const transitions = [], fired = [];
  const alerts = new Alerts({ alertedThrough, log: () => {} });
  live.on('transition', tr => { transitions.push(tr); const a = alerts.consume(tr); if (a) fired.push(a); });
  // advance the clock in engine ticks, re-evaluating like the server does
  const run = (seconds, each) => { for (let s = 0; s < seconds; s += TICK) { clock.t += TICK * 1000; each?.(s + TICK); live.evaluate(); } };
  return { clock, live, alerts, transitions, fired, run };
}
const healthyPushAgent = r => { r.live.setPush('forge', true); r.live.probe('forge', true); r.live.beat('forge'); assert.equal(r.live.state('forge'), 'HEALTHY'); };

test('healthy agents remain healthy (30 min, beats every I with ±40% jitter)', () => {
  const r = rig(); healthyPushAgent(r);
  let next = I; const rnd = (() => { let x = 7; return () => (x = (x * 9301 + 49297) % 233280) / 233280; })();
  r.run(1800, s => { if (s >= next) { r.live.beat('forge'); next = s + I * (0.6 + 0.8 * rnd()); } if (s % 30 === 0) r.live.probe('forge', true); });
  assert.equal(r.live.state('forge'), 'HEALTHY');
  assert.equal(r.transitions.filter(t => t.from !== 'UNKNOWN').length, 0);
  assert.equal(r.fired.length, 0);
});

test('missed heartbeats: LATE within 1.5×I(+tick), STALLED by 3×I(+tick) while the gateway still lists it', () => {
  const r = rig(); healthyPushAgent(r);
  let lateAt = null, stalledAt = null;
  r.run(200, s => { r.live.probe('forge', true); const st = r.live.state('forge'); if (st === 'LATE' && lateAt == null) lateAt = s; if (st === 'STALLED' && stalledAt == null) stalledAt = s; });
  assert.ok(lateAt >= 1.5 * I && lateAt <= 1.5 * I + TICK, `LATE at ${lateAt}s`);
  assert.ok(stalledAt >= 3 * I && stalledAt <= 3 * I + TICK, `STALLED at ${stalledAt}s`);
  assert.deepEqual(r.transitions.filter(t => t.from !== 'UNKNOWN').map(t => `${t.from}>${t.to}`), ['HEALTHY>LATE', 'LATE>STALLED']);
});

test('missed heartbeats with the gateway failing → DOWN by 3×I(+tick)', () => {
  const r = rig(); healthyPushAgent(r);
  let downAt = null;
  r.run(200, s => { if (s % 10 === 0) r.live.probe('forge', false); if (r.live.state('forge') === 'DOWN' && downAt == null) downAt = s; });
  assert.ok(downAt <= 3 * I + TICK, `DOWN at ${downAt}s`);
  assert.equal(r.live.state('forge'), 'DOWN');
});

test('alerts fire exactly once per transition (repeated ticks, re-evaluation, restart)', () => {
  const r = rig(); healthyPushAgent(r);
  r.run(600, () => r.live.probe('forge', true));                 // goes STALLED and stays there for minutes
  for (let i = 0; i < 20; i++) r.live.evaluate();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].kind, 'stalled');
  assert.equal(r.fired[0].key, `orb-transition-${r.transitions.at(-1).id}`);
  // the same transition delivered again (e.g. a replayed event) is ignored
  assert.equal(r.alerts.consume(r.transitions.at(-1)), null);
  // restart from persisted state: still STALLED, nothing re-alerted while it stays stalled
  const r2 = rig({ saved: JSON.parse(JSON.stringify(r.live.toJSON())), alertedThrough: r.alerts.alertedThrough });
  assert.equal(r2.live.state('forge'), 'STALLED');
  r2.run(600, () => r2.live.probe('forge', true));
  assert.equal(r2.fired.length, 0);
  assert.equal(r2.live.state('forge'), 'STALLED');
});

test('recovery is automatic and observable: first good beat → HEALTHY + one resolved alert', () => {
  const r = rig(); healthyPushAgent(r);
  r.run(200, () => r.live.probe('forge', true));
  assert.equal(r.live.state('forge'), 'STALLED');
  r.live.beat('forge');
  assert.equal(r.live.state('forge'), 'HEALTHY');
  assert.deepEqual(r.fired.map(a => a.severity), ['critical', 'resolved']);
  assert.equal(r.transitions.at(-1).from, 'STALLED');
  assert.equal(r.live.snapshot().find(s => s.agent === 'forge').heartbeatAgeS, 0);
  r.run(300, s => { if (s % I === 0) r.live.beat('forge'); });
  assert.equal(r.fired.length, 2);
});

test('a restart does not raise alerts on its own, and recovery after it alerts once', () => {
  const r = rig(); healthyPushAgent(r);
  const r2 = rig({ saved: JSON.parse(JSON.stringify(r.live.toJSON())), alertedThrough: r.alerts.alertedThrough });
  r2.live.probe('forge', true);
  r2.run(60, () => {});                                          // inside the window: restored HEALTHY kept, no beats yet
  assert.equal(r2.live.state('forge'), 'HEALTHY');
  assert.equal(r2.fired.length, 0);
  r2.live.beat('forge'); r2.run(60, s => { if (s % I === 0) r2.live.beat('forge'); });
  assert.equal(r2.fired.length, 0);
});

test('stall detection: busy with no progress for STALL_AFTER → STALLED; progress → HEALTHY', () => {
  const r = rig(); healthyPushAgent(r);
  r.run(330, s => { if (s % I === 0) { r.live.beat('forge', { status: 'busy', progress: 7 }); r.live.probe('forge', true); } });
  assert.equal(r.live.state('forge'), 'STALLED');
  assert.equal(r.transitions.at(-1).reason, 'no_progress');
  r.live.beat('forge', { status: 'busy', progress: 8 });
  assert.equal(r.live.state('forge'), 'HEALTHY');
  assert.deepEqual(r.fired.map(a => a.kind), ['stalled', 'recovered']);
});

test('probe blips: one failed probe changes nothing; two → DEGRADED (push agent) / DOWN (probe-only agent)', () => {
  const r = rig(); healthyPushAgent(r);
  r.live.probe('kirk', true); assert.equal(r.live.state('kirk'), 'HEALTHY');
  r.live.probe('forge', false); r.live.probe('kirk', false);
  assert.equal(r.live.state('forge'), 'HEALTHY'); assert.equal(r.live.state('kirk'), 'HEALTHY');
  r.live.probe('forge', false); r.live.probe('kirk', false);
  assert.equal(r.live.state('forge'), 'DEGRADED'); assert.equal(r.live.state('kirk'), 'DOWN');
  r.live.probe('forge', true); r.live.probe('kirk', true);
  assert.equal(r.live.state('forge'), 'HEALTHY'); assert.equal(r.live.state('kirk'), 'HEALTHY');
  assert.deepEqual(r.fired.map(a => `${a.agent}:${a.kind}`).sort(), ['forge:degraded', 'forge:recovered', 'kirk:offline', 'kirk:recovered']);
});

test('a newly registered agent that never beats is not alerted until the full missed window, then once', () => {
  const r = rig();
  r.live.probe('ledger', true); assert.equal(r.live.state('ledger'), 'HEALTHY');
  r.live.setPush('ledger', true);
  r.run(80, () => r.live.probe('ledger', true));
  assert.equal(r.fired.length, 0);
  r.run(20, () => r.live.probe('ledger', true));
  assert.equal(r.live.state('ledger'), 'STALLED');
  assert.equal(r.fired.length, 1);
});

test('server wall-clock jumps do not affect liveness (only the monotonic clock is used)', () => {
  let wall = 1793070000000; const clock = { t: 0 };
  const live = new Liveness({ now: () => clock.t, wallNow: () => wall, config: defaultConfig({ HEARTBEAT_INTERVAL_S: I }) });
  live.setPush('forge', true); live.probe('forge', true); live.beat('forge');
  wall += 6 * 3600 * 1000; clock.t += 10_000; live.evaluate();    // wall clock jumps 6 h forward, 10 s really passed
  assert.equal(live.state('forge'), 'HEALTHY');
  wall -= 12 * 3600 * 1000; clock.t += 10_000; live.evaluate();   // and 12 h back
  assert.equal(live.state('forge'), 'HEALTHY');
});

test('a restart keeps every agent’s state as it was: no transitions before new evidence arrives', () => {
  const r = rig(); healthyPushAgent(r); r.live.probe('kirk', true);
  const r2 = rig({ saved: JSON.parse(JSON.stringify(r.live.toJSON())), alertedThrough: r.alerts.alertedThrough });
  r2.run(60, () => {});
  assert.equal(r2.live.state('kirk'), 'HEALTHY'); assert.equal(r2.live.state('forge'), 'HEALTHY');
  assert.equal(r2.transitions.length, 0);
  r2.live.probe('kirk', true);
  assert.equal(r2.transitions.length, 0);
});
