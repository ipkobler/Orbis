// Liveness engine: the one place that decides whether an agent is UNKNOWN, HEALTHY, LATE, DEGRADED, STALLED or DOWN.
// It is fed accepted push heartbeats and gateway probe results, and emits a transition every time an agent's state
// changes. Timing uses only an injected monotonic clock (milliseconds), never wall-clock time. See docs/heartbeat.md.
import { EventEmitter } from 'node:events';

export const STATES = ['UNKNOWN', 'HEALTHY', 'LATE', 'DEGRADED', 'STALLED', 'DOWN'];
export const NOT_REACHABLE = new Set(['STALLED', 'DOWN']);   // the orb greys these agents out

export function defaultConfig(env = {}) {
  const I = Math.max(5, Number(env.HEARTBEAT_INTERVAL_S) || 30);
  return {
    intervalS: I,
    lateAfterS: 1.5 * I,
    missedAfterS: 3 * I,
    stallAfterS: Math.max(30, Number(env.STALL_AFTER_S) || 300),
    probeFails: Math.max(1, Number(env.PROBE_FAILS) || 2),
    startupGraceS: 3 * I,
    tickS: 5,
  };
}

export class Liveness extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => number} o.now        monotonic milliseconds (performance.now in production, a fake clock in tests)
   * @param {() => number} [o.wallNow]  wall-clock ms, only used to stamp transitions for people to read
   * @param {object} [o.config]
   * @param {object} [o.saved]          what toJSON() returned before a restart
   */
  constructor({ now, wallNow = Date.now, config = defaultConfig(), saved = null } = {}) {
    super();
    this.now = now; this.wallNow = wallNow; this.cfg = config;
    this.startedAt = now();
    this.agents = new Map();          // id -> record
    this.nextId = 1;
    this.history = [];                // recent transitions, newest last
    if (saved) {
      this.nextId = Math.max(1, Number(saved.nextTransitionId) || 1);
      for (const [id, s] of Object.entries(saved.agents || {})) {
        const r = this.#record(id);
        if (STATES.includes(s.state)) r.state = s.state;
        r.push = !!s.push;
        r.since = this.startedAt;
      }
      this.history = Array.isArray(saved.history) ? saved.history.slice(-50) : [];
    }
  }

  #record(id) {
    let r = this.agents.get(id);
    if (!r) {
      r = { id, state: 'UNKNOWN', since: this.now(), push: false, registeredAt: this.now(),
        lastBeat: null, status: 'idle', progress: null, progressAt: null,
        probe: null, probeFails: 0, probeOkAt: null, skewS: null, beats: 0 };
      this.agents.set(id, r);
    }
    return r;
  }

  /** The agent has (or no longer has) a heartbeat key. Push agents are judged on beats; others on the probe only. */
  setPush(id, on) {
    const r = this.#record(id);
    if (r.push === !!on) return;
    r.push = !!on; r.registeredAt = this.now(); r.lastBeat = null; r.progress = null; r.progressAt = null;
    this.evaluate(id);
  }

  /** An accepted, authenticated heartbeat. */
  beat(id, { status = 'idle', progress = null, skewS = null } = {}) {
    const r = this.#record(id), t = this.now();
    r.lastBeat = t; r.beats++;
    r.skewS = skewS;
    r.status = status === 'busy' ? 'busy' : 'idle';
    if (progress == null || r.status !== 'busy') { r.progress = progress; r.progressAt = t; }
    else if (progress !== r.progress || r.progressAt == null) { r.progress = progress; r.progressAt = t; }
    return this.evaluate(id);
  }

  /** A gateway probe result for the agent (ok = the gateway answered and lists it). */
  probe(id, ok) {
    const r = this.#record(id);
    r.probe = !!ok;
    if (ok) { r.probeFails = 0; r.probeOkAt = this.now(); } else r.probeFails++;
    return this.evaluate(id);
  }

  forget(id) { this.agents.delete(id); }

  /** What the state should be right now, and why. Pure: reads the record and the clock, changes nothing. */
  desired(r) {
    const t = this.now(), c = this.cfg;
    const probeFailing = r.probe === false && r.probeFails >= c.probeFails;
    if (!r.push) {
      if (r.probe == null) return [r.state, 'no_probe_yet'];      // UNKNOWN for a new agent; the restored state after a restart
      if (probeFailing) return ['DOWN', 'probe_failing'];
      if (r.probe === false) return [r.state === 'UNKNOWN' ? 'UNKNOWN' : r.state, 'probe_blip'];   // one blip: no change
      return ['HEALTHY', 'probe_ok'];
    }
    // the reference point for "how long since we heard from it": last beat, or (never seen) startup / registration
    const ref = r.lastBeat ?? Math.max(this.startedAt, r.registeredAt);
    const ageS = (t - ref) / 1000;
    // nothing heard yet since startup or registration: keep the state we had (UNKNOWN for a new agent, the restored
    // state after a restart) until the full missed-heartbeat window has passed, so a restart can't raise alerts
    if (r.lastBeat == null && ageS < c.missedAfterS) return [r.state, 'waiting_first_beat'];
    if (r.status === 'busy' && r.progressAt != null && (t - r.progressAt) / 1000 >= c.stallAfterS && ageS < c.missedAfterS) return ['STALLED', 'no_progress'];
    if (ageS >= c.missedAfterS) return [probeFailing ? 'DOWN' : 'STALLED', r.lastBeat == null ? 'no_heartbeat' : 'missed_heartbeats'];
    if (ageS >= c.lateAfterS) return ['LATE', 'heartbeat_late'];
    if (probeFailing) return ['DEGRADED', 'probe_failing'];
    return ['HEALTHY', 'heartbeat_ok'];
  }

  /** Re-evaluate one agent (or all); emits 'transition' for each change. Returns the agent's state. */
  evaluate(id) {
    if (id == null) { for (const k of this.agents.keys()) this.evaluate(k); return null; }
    const r = this.agents.get(id); if (!r) return null;
    const [to, reason] = this.desired(r);
    if (to !== r.state) {
      const from = r.state;
      r.state = to; r.since = this.now();
      const ref = r.lastBeat ?? null;
      const tr = { id: this.nextId++, agent: id, from, to, reason, at: new Date(this.wallNow()).toISOString(),
        heartbeatAgeS: ref == null ? null : Math.round((this.now() - ref) / 1000) };
      this.history.push(tr); if (this.history.length > 50) this.history.shift();
      this.emit('transition', tr);
    }
    return r.state;
  }

  state(id) { return this.agents.get(id)?.state ?? 'UNKNOWN'; }

  snapshot() {
    const t = this.now();
    return [...this.agents.values()].map(r => ({
      agent: r.id, state: r.state, mode: r.push ? 'push+probe' : 'probe',
      sinceS: Math.round((t - r.since) / 1000),
      heartbeatAgeS: r.lastBeat == null ? null : Math.round((t - r.lastBeat) / 1000),
      status: r.status, progress: r.progress, probe: r.probe, skewS: r.skewS, beats: r.beats,
    }));
  }

  toJSON() {
    const agents = {};
    for (const r of this.agents.values()) agents[r.id] = { state: r.state, push: r.push };
    return { nextTransitionId: this.nextId, agents, history: this.history.slice(-50) };
  }
}
