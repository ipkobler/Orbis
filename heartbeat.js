// Heartbeat identity and request checks. Each agent gets its own secret; a heartbeat is accepted only if it is signed
// with a key issued to that same agent, its timestamp is within the allowed skew, its nonce hasn't been seen, and it
// isn't arriving faster than allowed. Rejections never touch liveness state. See docs/heartbeat.md §2.
import crypto from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

const KID_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-fA-F]{16,64}$/;
const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;
export const MAX_BODY = 2048;

export const tokenFor = k => `obk_${k.kid}_${k.secret}`;
export function parseToken(tok) {
  const m = /^obk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/.exec(String(tok || '').trim());
  return m ? { kid: m[1], secret: m[2] } : null;
}
export const sign = (secret, body) => crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url');
export const authHeader = (kid, secret, body) => `OrbHMAC kid=${kid}, sig=${sign(secret, body)}`;

export class KeyStore {
  /** @param {object} o  file: where keys live (mode 600); now: wall-clock ms; overlapS: how long a rotated key still works */
  constructor({ file = null, now = Date.now, overlapS = 600 } = {}) {
    this.file = file; this.now = now; this.overlapMs = overlapS * 1000;
    this.keys = [];                       // { kid, agent, secret, created, expires|null }
    this.saving = Promise.resolve();
  }
  async load() {
    if (!this.file) return this;
    try { const j = JSON.parse(await readFile(this.file, 'utf8')); this.keys = Array.isArray(j.keys) ? j.keys.filter(k => KID_RE.test(k.kid) && AGENT_RE.test(k.agent) && k.secret) : []; } catch { /* none yet */ }
    this.prune(); return this;
  }
  save() {
    if (!this.file) return this.saving;
    const file = this.file, data = JSON.stringify({ keys: this.keys }, null, 1);
    this.saving = this.saving.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + '.tmp', data, { mode: 0o600 }); await rename(file + '.tmp', file);
      try { await chmod(file, 0o600); } catch { /* not supported on this filesystem */ }
    }).catch(e => console.warn('[kira-orb] could not save heartbeat keys:', e.message));
    return this.saving;
  }
  prune() { const t = this.now(); this.keys = this.keys.filter(k => !k.expires || k.expires > t); }
  /** Issue a key for an agent. Existing keys for it keep working for the overlap window (rotation). */
  issue(agent) {
    if (!AGENT_RE.test(agent)) throw new Error('bad agent id');
    this.prune();
    const t = this.now();
    for (const k of this.keys) if (k.agent === agent && !k.expires) k.expires = t + this.overlapMs;
    let kid; do kid = crypto.randomBytes(4).toString('hex'); while (this.keys.some(k => k.kid === kid));
    const key = { kid, agent, secret: crypto.randomBytes(32).toString('base64url'), created: t, expires: null };
    this.keys.push(key); this.save();
    return key;
  }
  revoke(agent) { const n = this.keys.length; this.keys = this.keys.filter(k => k.agent !== agent); this.save(); return n - this.keys.length; }
  find(kid) { this.prune(); return this.keys.find(k => k.kid === kid) || null; }
  agentsWithKeys() { this.prune(); return new Set(this.keys.map(k => k.agent)); }
  /** what the UI may see: never the secret */
  list() { this.prune(); return this.keys.map(({ kid, agent, created, expires }) => ({ kid, agent, created, expires })); }
}

export class Verifier {
  /**
   * @param {object} o
   * @param {KeyStore} o.keys
   * @param {() => number} o.wallNow   wall-clock ms (only for the skew window)
   * @param {() => number} o.monoNow   monotonic ms (nonce memory and rate limiting)
   */
  constructor({ keys, wallNow = Date.now, monoNow = () => performance.now(), maxSkewS = 60, minGapS = 2 } = {}) {
    Object.assign(this, { keys, wallNow, monoNow, maxSkewMs: maxSkewS * 1000, minGapMs: minGapS * 1000 });
    this.nonces = new Map();     // nonce -> mono time seen
    this.lastAccepted = new Map();
    this.rejected = new Map();   // reason -> count
  }
  #reject(reason, status) { this.rejected.set(reason, (this.rejected.get(reason) || 0) + 1); return { ok: false, reason, status }; }
  /**
   * @param {string} authorization  the Authorization header
   * @param {Buffer|string} raw     the exact body bytes that were signed
   * @returns {{ok:true, agent, ts, status, progress, skewS} | {ok:false, reason, status}}
   */
  verify(authorization, raw) {
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    if (body.length === 0 || body.length > MAX_BODY) return this.#reject('bad_request', 400);
    const m = /^OrbHMAC\s+kid=([0-9a-f]{8}),\s*sig=([A-Za-z0-9_-]{43})$/.exec(String(authorization || '').trim());
    if (!m) return this.#reject('unknown_key', 401);
    const key = this.keys.find(m[1]);
    if (!key) return this.#reject('unknown_key', 401);
    const want = Buffer.from(sign(key.secret, body)), got = Buffer.from(m[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return this.#reject('bad_signature', 401);
    let j; try { j = JSON.parse(body.toString('utf8')); } catch { return this.#reject('bad_request', 400); }
    if (!j || typeof j !== 'object' || !AGENT_RE.test(String(j.agent)) || !Number.isFinite(j.ts) || !NONCE_RE.test(String(j.nonce))) return this.#reject('bad_request', 400);
    if (j.status != null && !['idle', 'busy'].includes(j.status)) return this.#reject('bad_request', 400);
    if (j.progress != null && !Number.isFinite(j.progress)) return this.#reject('bad_request', 400);
    if (j.agent !== key.agent) return this.#reject('wrong_agent', 403);
    const skewMs = this.wallNow() - j.ts;
    if (Math.abs(skewMs) > this.maxSkewMs) return this.#reject('clock_skew', 401);
    const t = this.monoNow();
    for (const [n, at] of this.nonces) if (t - at > 2 * this.maxSkewMs) this.nonces.delete(n); else break;   // oldest first
    const nonceKey = `${key.agent}:${j.nonce}`;
    if (this.nonces.has(nonceKey)) return this.#reject('replay', 409);
    const last = this.lastAccepted.get(key.agent);
    if (last != null && t - last < this.minGapMs) return this.#reject('too_fast', 429);
    this.nonces.set(nonceKey, t); this.lastAccepted.set(key.agent, t);
    return { ok: true, agent: key.agent, ts: j.ts, status: j.status || 'idle', progress: j.progress ?? null, skewS: Math.round(skewMs / 100) / 10 };
  }
}
