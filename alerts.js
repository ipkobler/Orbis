// Alerts: the only producer of liveness alerts, and its only input is the liveness engine's transitions.
// It never looks at heartbeat ages, probes or timers. One alert per alerting transition, keyed by the transition id,
// remembered across restarts (alertedThrough). See docs/heartbeat.md §5.

const CRITICAL = new Set(['STALLED', 'DOWN']);
const PROBLEM = new Set(['STALLED', 'DOWN', 'DEGRADED']);

/** Which transitions alert, and how. Returns null for transitions that don't alert. */
export function classify(tr) {
  if (tr.from === 'UNKNOWN' && !PROBLEM.has(tr.to)) return null;
  if (CRITICAL.has(tr.to)) return { severity: 'critical', kind: tr.to === 'DOWN' ? 'offline' : 'stalled' };
  if (tr.to === 'DEGRADED') return { severity: 'warning', kind: 'degraded' };
  if (tr.to === 'HEALTHY' && PROBLEM.has(tr.from)) return { severity: 'resolved', kind: 'recovered' };
  return null;
}

const WORDS = { offline: 'is offline', stalled: 'has stalled', degraded: 'is degraded (gateway can’t reach it)', recovered: 'has recovered' };
const REASONS = { missed_heartbeats: 'missed heartbeats', no_heartbeat: 'no heartbeat received', no_progress: 'busy with no progress',
  probe_failing: 'gateway probe failing', heartbeat_ok: 'heartbeats back', probe_ok: 'gateway probe OK' };

export class Alerts {
  /**
   * @param {object} o
   * @param {(id: string) => string} [o.label]   display name for an agent id
   * @param {string} [o.owner]                   who owns these alerts (HEARTBEAT_ALERT_OWNER)
   * @param {string} [o.webhook]                 optional URL; each alert is POSTed with Idempotency-Key
   * @param {number} [o.alertedThrough]          highest transition id already alerted (persisted)
   * @param {(fn: Function, ms: number) => any} [o.setTimer]
   * @param {typeof fetch} [o.fetch]
   * @param {(line: string) => void} [o.log]
   */
  constructor({ label = id => id, owner = 'operator', webhook = '', alertedThrough = 0, setTimer = setTimeout, fetch: f = globalThis.fetch, log = l => console.log(l) } = {}) {
    Object.assign(this, { label, owner, webhook, alertedThrough, setTimer, fetch: f, log });
    this.recent = [];            // newest last, for the orb UI
    this.counts = new Map();     // `${severity}|${sink}|${result}` -> n
    this.onChange = null;
  }
  #count(severity, sink, result) { const k = `${severity}|${sink}|${result}`; this.counts.set(k, (this.counts.get(k) || 0) + 1); }

  /** Subscribe to a liveness engine. */
  attach(engine) { engine.on('transition', tr => this.consume(tr)); return this; }

  /** Feed one transition. Returns the alert it produced, or null. */
  consume(tr) {
    if (tr.id <= this.alertedThrough) return null;          // already alerted (or deliberately skipped) before
    this.alertedThrough = tr.id;
    const c = classify(tr);
    this.onChange?.();
    if (!c) return null;
    const name = this.label(tr.agent);
    const alert = { key: `orb-transition-${tr.id}`, transition: tr.id, agent: tr.agent, name, owner: this.owner,
      severity: c.severity, kind: c.kind, from: tr.from, to: tr.to, reason: tr.reason, at: tr.at,
      message: `${name} ${WORDS[c.kind]}${REASONS[tr.reason] ? ' — ' + REASONS[tr.reason] : ''}` };
    this.recent.push(alert); if (this.recent.length > 50) this.recent.shift();
    this.log(`[kira-orb] ALERT ${alert.severity.toUpperCase()} ${alert.message} (transition ${tr.id}: ${tr.from} → ${tr.to}, owner ${this.owner})`);
    this.#count(c.severity, 'ui', 'ok'); this.#count(c.severity, 'log', 'ok');
    if (this.webhook) this.#deliver(alert, 0);
    return alert;
  }

  #deliver(alert, attempt) {
    Promise.resolve().then(() => this.fetch(this.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': alert.key },
      body: JSON.stringify(alert), signal: AbortSignal.timeout(8000),
    })).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.#count(alert.severity, 'webhook', 'ok');
    }).catch(e => {
      if (attempt < 3) { this.setTimer(() => this.#deliver(alert, attempt + 1), [2000, 10000, 60000][attempt]); return; }
      this.#count(alert.severity, 'webhook', 'failed');
      this.log(`[kira-orb] alert webhook failed for ${alert.key}: ${e.message}`);
    });
  }
}
