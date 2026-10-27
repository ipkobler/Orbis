import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SEVERITIES = ['info', 'success', 'warning', 'error', 'approval'];
export const CHANNELS = ['inbox', 'browser', 'webhook'];
const clone = value => JSON.parse(JSON.stringify(value));
const stableKey = input => input.idempotencyKey || input.correlationId || crypto.createHash('sha256')
  .update(JSON.stringify([input.type, input.actor, input.payload, input.title, input.message])).digest('hex');

export function normalizeNotification(input) {
  if (!input || typeof input !== 'object') throw new TypeError('notification must be an object');
  const severity = input.severity || 'info';
  if (!SEVERITIES.includes(severity)) throw new RangeError('invalid severity');
  const channels = [...new Set(input.channels || ['inbox'])];
  if (channels.some(channel => !CHANNELS.includes(channel))) throw new RangeError('invalid channel');
  return {
    id: input.id || crypto.randomUUID(), type: String(input.type || 'system.notice'), severity,
    title: String(input.title || 'Notification').slice(0, 160), message: String(input.message || '').slice(0, 4000),
    actor: String(input.actor || 'system'), correlationId: input.correlationId || null, action: input.action || null,
    channels, createdAt: input.createdAt || new Date().toISOString(), idempotencyKey: stableKey(input),
    status: 'pending', attempts: 0,
  };
}

export class NotificationCenter {
  constructor({ file, send = async () => {}, now = () => Date.now(), quietHours = null, store = [] } = {}) {
    this.file = file; this.send = send; this.now = now; this.quietHours = quietHours;
    this.events = new Map(store.map(event => [event.id, event]));
    this.save = Promise.resolve();
  }
  async load() { if (!this.file) return this; try { this.events = new Map(JSON.parse(await readFile(this.file, 'utf8')).map(e => [e.id, e])); } catch {} return this; }
  async persist() {
    if (!this.file) return;
    this.save = this.save.then(async () => { await mkdir(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; await writeFile(tmp, JSON.stringify(this.snapshot())); await rename(tmp, this.file); });
    return this.save;
  }
  isQuiet(date = new Date(this.now())) {
    if (!this.quietHours) return false;
    const [from, to] = this.quietHours; const value = date.getHours() * 60 + date.getMinutes();
    const parse = x => { const [h, m] = x.split(':').map(Number); return h * 60 + m; };
    const a = parse(from), b = parse(to); return a <= b ? value >= a && value < b : value >= a || value < b;
  }
  enqueue(input) { const event = normalizeNotification(input); const old = [...this.events.values()].find(e => e.idempotencyKey === event.idempotencyKey); if (old) return { event: clone(old), duplicate: true }; this.events.set(event.id, event); void this.persist(); return { event: clone(event), duplicate: false }; }
  list({ severity, type, unreadOnly = false, status, limit = 100 } = {}) { return [...this.events.values()].filter(e => (!severity || e.severity === severity) && (!type || e.type === type) && (!status || e.status === status) && (!unreadOnly || e.status !== 'read')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone); }
  markRead(id) { const event = this.events.get(id); if (!event) return false; event.status = 'read'; event.readAt = new Date(this.now()).toISOString(); void this.persist(); return true; }
  async deliver(id, { force = false } = {}) { const event = this.events.get(id); if (!event) throw Error('notification not found'); if (event.status === 'delivered') return clone(event); if (this.isQuiet() && !force) { event.status = 'quiet'; await this.persist(); return clone(event); } event.attempts++; try { await this.send(clone(event)); event.status = 'delivered'; event.deliveredAt = new Date(this.now()).toISOString(); } catch (error) { event.status = event.attempts >= 3 ? 'dead-letter' : 'retry'; event.lastError = String(error.message || error); } await this.persist(); return clone(event); }
  retryable() { return this.list({ status: 'retry', limit: 1000 }); }
  metrics() { const values = [...this.events.values()]; return Object.fromEntries(['pending', 'delivered', 'read', 'retry', 'dead-letter', 'quiet'].map(s => [s, values.filter(e => e.status === s).length])); }
  snapshot() { return [...this.events.values()].map(clone); }
}
