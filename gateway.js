// OpenClaw gateway link: one WebSocket from the orb container to the gateway, the same protocol the
// OpenClaw Control UI uses. Messages sent this way run as normal chat turns with the agent's full
// tool set (browser, image generation, files…), and the gateway streams back text, tool activity
// and any images or files the agent produces.
//
// The orb signs in with the gateway token plus its own device key (Ed25519, kept in STATE_DIR).
// The first time, the gateway asks you to approve the new device once:
//   docker compose exec openclaw-gateway openclaw devices list
//   docker compose exec openclaw-gateway openclaw devices approve <requestId>
// Zero dependencies: Node 22's built-in WebSocket and crypto.
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const PROTOCOL = 4;
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
// operator.admin makes the orb's messages owner turns, exactly like OpenClaw's own chat page (and like the HTTP
// endpoint with the gateway token, which the orb already holds): the agent gets its full, owner-level tool set.
const SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
const VERSION = '2.0.0';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const b64url = buf => Buffer.from(buf).toString('base64url');

async function loadIdentity(dir) {
  const file = path.join(dir, 'device.json');
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    if (j.privateKeyPem && j.publicKeyPem && j.deviceId) return j;
  } catch { /* first run */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
  const id = {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    createdAt: new Date().toISOString(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(id, null, 2), { mode: 0o600 });
  await rename(file + '.tmp', file);
  return id;
}
const rawPublicKey = pem => b64url(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length));

export class GatewayLink extends EventEmitter {
  constructor({ url, token, stateDir, log = console }) {
    super();
    this.url = url.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.token = token;
    this.stateDir = stateDir;
    this.log = log;
    this.ws = null;
    this.ready = false;
    this.status = { state: 'starting', detail: null, pairing: null, server: null, deviceId: null };
    this.pending = new Map();      // request id -> { resolve, reject, timer }
    this.backoff = 1000;
    this.stopped = false;
    this.lastTick = 0;
  }

  async start() {
    try { this.identity = await loadIdentity(this.stateDir); }
    catch (e) {
      this.setStatus('error', `Can't save the orb's device key in ${this.stateDir} (${e.code || e.message}). Mount a writable folder there.`);
      this.log.error('[gateway] device key:', e.message);
      return;
    }
    this.status.deviceId = this.identity.deviceId;
    this.connect();
    setInterval(() => {   // the gateway ticks every ~15 s; a silent socket is a dead socket
      if (this.ready && this.lastTick && Date.now() - this.lastTick > 75000) { this.log.warn('[gateway] no tick for 75 s, reconnecting'); this.retire(this.ws, 'Gateway went quiet'); }
    }, 15000).unref();
  }

  setStatus(state, detail = null, extra = {}) {
    this.status = { ...this.status, state, detail, ...extra };
    this.emit('status', this.status);
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { this.setStatus('error', `Bad gateway address ${this.url}`); return; }
    this.ws = ws;
    this.ready = false;
    let challenged = false;
    const challengeTimer = setTimeout(() => { if (!challenged) { this.log.warn('[gateway] no connect challenge, retrying'); this.retire(ws, 'Gateway did not answer'); } }, 30000);
    ws.__retire = () => clearTimeout(challengeTimer);

    ws.addEventListener('message', ev => {
      if (ws !== this.ws) return;
      let f; try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (f.type === 'event' && f.event === 'connect.challenge' && !challenged) {
        challenged = true; clearTimeout(challengeTimer);
        this.handshake(ws, f.payload || {});
        return;
      }
      if (f.type === 'res') {
        const p = this.pending.get(f.id); if (!p) return;
        this.pending.delete(f.id); clearTimeout(p.timer);
        if (f.ok) p.resolve(f.payload); else p.reject(Object.assign(new Error(f.error?.message || 'Gateway error'), { code: f.error?.code, details: f.error?.details }));
        return;
      }
      if (f.type === 'event') {
        if (f.event === 'tick') { this.lastTick = Date.now(); return; }
        if (f.event === 'shutdown') { this.setStatus('restarting', 'Gateway is restarting'); return; }
        this.emit('event', f.event, f.payload);
      }
    });
    ws.addEventListener('close', ev => this.retire(ws, ev.reason));
    ws.addEventListener('error', () => this.retire(ws));
  }

  // Drop a socket (closed, silent or refused) and schedule exactly one reconnect for it.
  retire(ws, reason, keepStatus = false) {
    if (ws.__retired) return;
    ws.__retired = true;
    ws.__retire?.();
    try { ws.close(); } catch {}
    if (ws !== this.ws) return;
    const wasReady = this.ready;
    this.ready = false;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Gateway connection closed')); }
    this.pending.clear();
    this.emit('closed');
    if (this.stopped) return;
    if (!keepStatus && this.status.state !== 'pairing' && this.status.state !== 'rejected') this.setStatus('connecting', reason || (wasReady ? 'Connection dropped' : 'Gateway unreachable'));
    // waiting for approval: check back every 10 s; otherwise back off from 1 s up to 30 s
    const delay = this.status.state === 'pairing' ? 10000 : this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => this.connect(), delay + Math.random() * 500);
  }

  async handshake(ws, challenge) {
    const nonce = String(challenge.nonce || '');
    const signedAt = Number.isInteger(challenge.ts) ? challenge.ts : Date.now();
    const platform = 'linux';
    const payload = ['v3', this.identity.deviceId, CLIENT_ID, CLIENT_MODE, ROLE, SCOPES.join(','), String(signedAt), this.token || '', nonce, platform, ''].join('|');
    const signature = b64url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(this.identity.privateKeyPem)));
    const params = {
      minProtocol: PROTOCOL, maxProtocol: PROTOCOL,
      client: { id: CLIENT_ID, displayName: 'Kira Orb', version: VERSION, platform, mode: CLIENT_MODE },
      role: ROLE, scopes: SCOPES,
      caps: ['tool-events'],
      auth: { token: this.token || '' },
      device: { id: this.identity.deviceId, publicKey: rawPublicKey(this.identity.publicKeyPem), signature, signedAt, nonce },
      userAgent: `kira-orb/${VERSION}`,
    };
    try {
      const hello = await this.request('connect', params, { timeoutMs: 30000, socket: ws });
      this.ready = true; this.backoff = 1000; this.lastTick = Date.now(); this.lastFailCode = null;
      this.methods = new Set(hello?.features?.methods || []);
      this.maxPayload = hello?.policy?.maxPayload || 25 * 1024 * 1024;
      this.setStatus('online', null, { pairing: null, server: hello?.server?.version || null, scopes: hello?.auth?.scopes || [] });
      this.log.log(`[gateway] connected to OpenClaw ${hello?.server?.version || ''} as device ${this.identity.deviceId.slice(0, 12)}…`);
      this.emit('ready');
    } catch (e) {
      const d = e.details || {};
      const code = d.code || e.code;
      if (code === 'PAIRING_REQUIRED' || /pairing required/i.test(e.message)) {
        const requestId = d.requestId || d.pairingRequestId || null;
        if (this.status.state !== 'pairing') this.log.warn(`[gateway] waiting for device approval${requestId ? ` (request ${requestId})` : ''}: openclaw devices approve ${requestId || '<requestId>'}`);
        this.setStatus('pairing', 'Approve the orb as a device in OpenClaw', { pairing: { requestId } });
      } else if (code === 'PAIRING_REJECTED') {
        this.setStatus('rejected', 'The orb device was rejected in OpenClaw. Delete the orb state folder to request again.');
      } else if (/token|unauthor/i.test(e.message) || code === 'UNAUTHORIZED' || code === 'AUTH_FAILED') {
        this.setStatus('error', 'Gateway token rejected. Check OPENCLAW_TOKEN.');
      } else if (/protocol/i.test(e.message)) {
        this.setStatus('error', `Protocol mismatch: ${e.message}. Update OpenClaw.`);
      } else {
        this.setStatus('error', e.message);
      }
      if (code !== 'PAIRING_REQUIRED' || this.lastFailCode !== code) this.log.warn('[gateway] connect failed:', code || '', e.message);
      this.lastFailCode = code;
      this.retire(ws, null, true);
    }
  }

  request(method, params, { timeoutMs = 30000, socket } = {}) {
    const ws = socket || this.ws;
    if (!ws || ws.readyState !== 1 || (!socket && !this.ready)) return Promise.reject(new Error('The orb is not connected to the gateway.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ type: 'req', id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  has(method) { return !this.methods || this.methods.has(method); }
}
