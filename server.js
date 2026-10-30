// Kira Orb — tiny relay between the browser and the OpenClaw gateway.
// Zero dependencies (Node 22+). The gateway token never leaves this container.
import http from 'node:http';
import { validatePreview, safeMetadata } from './safe-content.js';
import { InboxStore } from './inbox-store.js';
import { actionLink, replay } from './inbox-query.js';
import { readFile, readdir, mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { GatewayLink } from './gateway.js';
import { Liveness, defaultConfig as livenessConfig, NOT_REACHABLE } from './liveness.js';
import { KeyStore, Verifier, tokenFor, MAX_BODY as HEARTBEAT_MAX_BODY } from './heartbeat.js';
import { Alerts } from './alerts.js';
import { HealthRegistry } from './health.js';
import { NotificationCenter } from './notification-center.js';
import { CommandRegistry } from './command-palette.js';
import { VoiceState } from './voice-state.js';
import { VoiceLibrary, VOICE_POLICY } from './voice-management.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 8080);
const healthRegistry = new HealthRegistry({ timeoutMs: Number(process.env.HEALTH_TIMEOUT_MS || 3000) });
const inboxStore = new InboxStore(path.join(process.env.STATE_DIR || '/state', 'inbox.json'));
healthRegistry.register('process', () => ({ status: 'ok', evidence: { pid: process.pid, uptimeS: Math.round(process.uptime()) } }));
healthRegistry.register('gateway-transport', () => ({ status: link?.ready ? 'ok' : 'degraded', evidence: { transport: link?.ready ? 'websocket' : 'http' } }));
const OPENCLAW_URL = (process.env.OPENCLAW_URL || 'http://openclaw-gateway:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_TOKEN || '';
const DEFAULT_AGENT = process.env.DEFAULT_AGENT || 'main';
const commandAudit = [];
const commands = new CommandRegistry({ authorize: (actor, command, action) => action !== 'execute' || !command.roles || command.roles.includes(actor), audit: event => commandAudit.push(event) });
commands.register({ id: 'health.snapshot', title: 'View health', description: 'Show current gateway health', roles: ['operator'], handler: async () => await agentStatus(false) });
// Optional allowlist, e.g. "main,forge". Blank = every agent the gateway lists.
const ALLOW = (process.env.AGENTS || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional display names, e.g. "main=Kira,forge=Forge".
const LABELS = Object.fromEntries(
  (process.env.AGENT_LABELS || '').split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p.length === 2 && p[0])
);
// Optional orb colours, e.g. "main=#ff7ac8,forge=#4da3ff,ledger=#4fe39a".
const COLORS = Object.fromEntries(
  (process.env.AGENT_COLORS || '').split(',').map(p => p.split('=').map(s => s.trim()))
    .filter(p => p.length === 2 && p[0] && /^#[0-9a-fA-F]{6}$/.test(p[1]))
);
// Optional full names behind each acronym, e.g. "main=Kobler Insights Robotic Agent".
const TITLES = Object.fromEntries(
  (process.env.AGENT_TITLES || '').split(',').map(p => { const i = p.indexOf('='); return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : []; })
    .filter(p => p.length === 2 && p[0] && p[1])
);
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'orb';
// OpenClaw's data folder, mounted read-only. The orb only ever opens workspace*/SOUL.md inside it.
const OPENCLAW_DATA = process.env.OPENCLAW_DATA || '/openclaw';
// Pocket TTS voice service (optional). Blank = the orb uses browser voices only.
const VOICE_URL = (process.env.VOICE_URL || '').replace(/\/+$/, '');
const LOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCATION_CONSENT_VERSION = '2026-10-30';
const sessionLocations = new Map();
const locationAudits = [];
const locationWrites = new Map();
const LOCATION_RATE_WINDOW_MS = 60 * 1000;
const LOCATION_RATE_LIMIT = 6;

// ---- voice service status --------------------------------------------------------------------
let voiceCache = { at: 0, info: { enabled: !!VOICE_URL, ready: false, voices: [], error: VOICE_URL ? null : 'Not configured' } };
async function voiceStatus(force = false) {
  if (!VOICE_URL) return voiceCache.info;
  if (!force && Date.now() - voiceCache.at < 20000) return voiceCache.info;
  let info;
  try {
    const r = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    info = { enabled: true, ready: !!j.ready, voices: j.voices || [], error: j.error || (j.ready ? null : 'Loading voice model') };
  } catch { info = { enabled: true, ready: false, voices: [], error: 'Voice service unreachable' }; }
  voiceCache = { at: Date.now(), info };
  return info;
}

// ---- full names from each agent's SOUL.md ----------------------------------------------------
// workspace/ belongs to the default agent, workspace-<id>/ to every other agent.
// Accepts lines like "## K.I.R.A. - Kobler Insights Robotic Agent", "FORGE: Fabrication ..." or
// "... stands for Ledger Entry ...", and only uses words whose initials really spell the acronym.
const SMALL = new Set(['of', 'and', 'the', 'for', 'a', 'an', '&', 'to', 'in', 'on']);
const initials = phrase => phrase.split(/[\s,-]+/).filter(w => w && !SMALL.has(w.toLowerCase())).map(w => w[0]).join('').toUpperCase();
const cleanPhrase = p => p.replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/, '').trim();
function parseSoul(text, label) {
  const want = String(label).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const head = text.slice(0, 6000);
  // 1) an acronym (dotted or capitals) followed by a dash or colon and its expansion
  const re = /((?:[A-Za-z]\.){2,}[A-Za-z]?\.?|\b[A-Z]{3,}\b)\s*(?:[-–—:]|\bis\b)\s*([A-Za-z][A-Za-z'’&,\- ]{3,90})/g;
  for (const m of head.matchAll(re)) {
    const letters = m[1].replace(/[^A-Za-z]/g, '').toUpperCase(), phrase = cleanPhrase(m[2]);
    if (letters === want && initials(phrase) === want) return phrase;
  }
  // 2) "... stands for X"
  for (const m of head.matchAll(/stands\s+for[:\s]+["“']?([A-Za-z][A-Za-z'’&,\- ]{3,90})/gi)) {
    const phrase = cleanPhrase(m[1]);
    if (initials(phrase) === want) return phrase;
  }
  return null;
}
let soulCache = { at: 0, titles: {} };
async function soulTitles(ids) {
  if (Date.now() - soulCache.at < 30000) return soulCache.titles;
  const titles = {};
  let dirs = [];
  try { dirs = (await readdir(OPENCLAW_DATA, { withFileTypes: true })).filter(d => d.isDirectory() && /^workspace(-[A-Za-z0-9._-]+)?$/.test(d.name)).map(d => d.name); }
  catch { soulCache = { at: Date.now(), titles }; return titles; }      // folder not mounted: fall back to AGENT_TITLES
  for (const id of ids) {
    const dir = dirs.includes(`workspace-${id}`) ? `workspace-${id}` : id === DEFAULT_AGENT && dirs.includes('workspace') ? 'workspace' : null;
    if (!dir) continue;
    try {
      const text = await readFile(path.join(OPENCLAW_DATA, dir, 'SOUL.md'), 'utf8');
      const t = parseSoul(text, LABELS[id] || id);
      if (t) titles[id] = t;
    } catch { /* no SOUL.md yet */ }
  }
  soulCache = { at: Date.now(), titles };
  return titles;
}

if (!TOKEN) console.warn('[kira-orb] OPENCLAW_TOKEN is not set — chat requests will fail.');

// ---- full-tools link: the same WebSocket protocol the OpenClaw Control UI uses ------------------
// TRANSPORT=auto (default): use the WebSocket link when it's connected, the HTTP chat endpoint otherwise.
// TRANSPORT=http: never open the WebSocket (old behaviour).
const TRANSPORT = (process.env.TRANSPORT || 'auto').toLowerCase();
const STATE_DIR = process.env.STATE_DIR || '/state';
const notificationAdapters = {
  browser: async () => {},
  webhook: async event => {
    const target = process.env.NOTIFICATION_WEBHOOK_URL;
    if (!target) return;
    const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(`webhook returned ${response.status}`);
  },
};
const notifications = new NotificationCenter({ file: path.join(STATE_DIR, 'notifications.json'), adapters: notificationAdapters, quietHours: process.env.NOTIFICATION_QUIET_HOURS ? process.env.NOTIFICATION_QUIET_HOURS.split(',') : null, rateLimit: Number(process.env.NOTIFICATION_RATE_LIMIT || 0) || null });
await notifications.load();
const voiceState = new VoiceState();
// Voice Manager: uploaded / recorded clips and each agent's voice choice. VOICE_CLIPS_DIR is shared with the voice
// service (read-only there), which uses <agent>.wav in it before the repo's default clips.
const VOICE_CLIPS_DIR = process.env.VOICE_CLIPS_DIR || path.join(STATE_DIR, 'voice-clips');
const voiceLib = await new VoiceLibrary({ file: path.join(STATE_DIR, 'voice-library.json'), dir: VOICE_CLIPS_DIR }).load();
await voiceLib.sync().catch(e => console.warn('[kira-orb] voice clips folder:', e.message));
const link = TRANSPORT === 'http' ? null : new GatewayLink({ url: process.env.OPENCLAW_WS_URL || OPENCLAW_URL, token: TOKEN, stateDir: STATE_DIR });
const linkStatus = () => link ? { ...link.status, transport: link.ready ? 'ws' : 'http' } : { state: 'off', transport: 'http' };
// gateway events → the browser stream waiting on that session
const sessionStreams = new Map();   // sessionKey -> { handler(event, payload), runId }
const pendingAborts = new Map();    // sessionKey -> chat.abort in flight (a new message waits for it)
// Runs the orb started itself; anything else that finishes in an orb conversation (a background image or
// video arriving later, a message sent from OpenClaw's own chat page) is announced to the open orbs.
const orbRuns = new Set();
const rememberRun = id => { orbRuns.add(id); if (orbRuns.size > 500) orbRuns.delete(orbRuns.values().next().value); };
const watchers = new Map();         // sessionKey -> Set of open /api/watch streams
const orbFinished = new Map();      // sessionKey -> when the orb's last reply there ended (its transcript lands just after)
const announce = (() => {   // tell the open orbs, at most about twice a second per conversation
  const timers = new Map();
  return (key, why) => {
    if (timers.has(key)) return;
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      console.log(`[kira-orb] later message in ${key} (${why}), telling ${watchers.get(key)?.size || 0} open orb(s)`);
      for (const out of watchers.get(key) || []) out.emit({ type: 'update', state: why });
    }, 500));
  };
})();
// The same gateway event can reach the orb twice (once as a broadcast, once through the conversation
// subscription); handle each one once, or the reply text doubles.
const seenEvents = new Set();
function seenBefore(event, p) {
  if ((event !== 'chat' && event !== 'agent') || !p.runId || !Number.isInteger(p.seq)) return false;
  const id = `${event}|${p.runId}|${p.seq}|${p.stream || p.state || ''}`;
  if (seenEvents.has(id)) return true;
  seenEvents.add(id);
  if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value);
  return false;
}
link?.on('event', (event, payload) => {
  if (!payload?.sessionKey || seenBefore(event, payload)) return;
  if (event === 'chat' || event === 'agent') sessionStreams.get(payload.sessionKey)?.handler(event, payload);
  if (!watchers.has(payload.sessionKey) || sessionStreams.has(payload.sessionKey)) return;   // the orb's own reply is shown live
  // A finished run the orb didn't start, or a message written straight into the conversation. Generated
  // images, video and music arrive this way: OpenClaw delivers them as a later message, not as a run.
  if (event === 'chat' && ['final', 'error', 'aborted'].includes(payload.state) && !orbRuns.has(payload.runId)) announce(payload.sessionKey, payload.state);
  else if (event === 'session.message' && payload.message?.role !== 'user' && !orbRuns.has(payload.message?.__openclaw?.runId)
    && Date.now() - (orbFinished.get(payload.sessionKey) || 0) > 4000) announce(payload.sessionKey, 'message');
});
// Message-level updates for a conversation need a subscription (OpenClaw's chat page does the same).
const subId = key => 'kira-orb:' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
function subscribeMessages(key) {
  if (!link?.ready) return;
  link.request('sessions.messages.subscribe', { key, subscriptionId: subId(key) }, { timeoutMs: 10000 })
    .catch(e => { if (!/not found/i.test(e.message)) console.warn('[kira-orb] could not follow', key, e.message); });
}
link?.on('closed', () => { for (const s of sessionStreams.values()) s.handler('link-closed', {}); });
function abortRun(sessionKey, runId) {
  const p = link.request('chat.abort', { sessionKey, runId }, { timeoutMs: 8000 }).catch(() => {}).finally(() => { if (pendingAborts.get(sessionKey) === p) pendingAborts.delete(sessionKey); });
  pendingAborts.set(sessionKey, p);
  return p;
}
link?.on('status', () => { statusAt = 0; });
link?.on('ready', () => {   // catch up on anything missed, and follow the open conversations again
  for (const [key, set] of watchers) { subscribeMessages(key); for (const out of set) out.emit({ type: 'update', state: 'reconnected' }); }
});
const sessionKeyFor = (agent, session) => `agent:${agent}:${SESSION_PREFIX}:${session}`;

// ---- one current conversation per agent, shared by every device you sign in on -----------------
const CONV_FILE = path.join(STATE_DIR, 'conversations.json');
let conversations = {};
try { conversations = JSON.parse(await readFile(CONV_FILE, 'utf8')) || {}; } catch { /* none yet */ }
let convSave = Promise.resolve();
function saveConversations() {
  convSave = convSave.then(async () => {
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(CONV_FILE + '.tmp', JSON.stringify(conversations, null, 1)); await rename(CONV_FILE + '.tmp', CONV_FILE); }
    catch (e) { console.warn('[kira-orb] could not save conversations:', e.message); }
  });
}
async function handleConversation(req, res) {
  let j; try { j = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(j.agent || ''), id = String(j.id || '');
  if (!AGENT_RE.test(agent) || !SESSION_RE.test(id)) return send(res, 400, { error: 'Bad request.' });
  // "adopt" only fills in an agent that has no shared conversation yet (a device's existing one); "new" replaces it
  if (j.mode === 'adopt' && conversations[agent]) return send(res, 200, { id: conversations[agent] });
  conversations[agent] = id; saveConversations(); statusAt = 0;
  send(res, 200, { id });
}
// ---- heartbeat monitoring: identity, liveness engine, alerts, metrics (docs/heartbeat.md) -------------------
const LIVE_CFG = livenessConfig(process.env);
const LIVE_FILE = path.join(STATE_DIR, 'liveness.json');
const PROBE_INTERVAL_S = Math.max(10, Number(process.env.PROBE_INTERVAL_S) || 30);
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
let livenessSaved = null;
try { livenessSaved = JSON.parse(await readFile(LIVE_FILE, 'utf8')); } catch { /* first start */ }
const heartbeatKeys = await new KeyStore({ file: path.join(STATE_DIR, 'heartbeat-keys.json'), overlapS: Number(process.env.KEY_OVERLAP_S) || 600 }).load();
const verifier = new Verifier({ keys: heartbeatKeys, maxSkewS: Number(process.env.MAX_SKEW_S) || 60 });
const liveness = new Liveness({ now: () => performance.now(), config: LIVE_CFG, saved: livenessSaved });
// alerts name agents the way the orb shows them (K.I.R.K.); only called once the server is running
const spokenName = id => { const l = String(prettyName(id)).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); return l ? l.split('').join('.') + '.' : id; };
const alerts = new Alerts({ label: spokenName, owner: process.env.HEARTBEAT_ALERT_OWNER || 'operator',
  webhook: process.env.HEARTBEAT_WEBHOOK_URL || '', alertedThrough: Number(livenessSaved?.alertedThrough) || 0 }).attach(liveness);
const transitionCounts = new Map();     // `${agent}|${from}|${to}` -> n
let liveSave = null;
function saveLiveness() {
  if (liveSave) return;
  liveSave = setTimeout(async () => {
    liveSave = null;
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(LIVE_FILE + '.tmp', JSON.stringify({ ...liveness.toJSON(), alertedThrough: alerts.alertedThrough })); await rename(LIVE_FILE + '.tmp', LIVE_FILE); }
    catch (e) { console.warn('[kira-orb] could not save liveness state:', e.message); }
  }, 300);
}
liveness.on('transition', tr => {
  const k = `${tr.agent}|${tr.from}|${tr.to}`; transitionCounts.set(k, (transitionCounts.get(k) || 0) + 1);
  console.log(`[kira-orb] liveness ${tr.agent}: ${tr.from} → ${tr.to} (${tr.reason})`);
  statusAt = 0; saveLiveness();
});
for (const id of heartbeatKeys.agentsWithKeys()) liveness.setPush(id, true);
setInterval(() => liveness.evaluate(), LIVE_CFG.tickS * 1000).unref();
// the gateway probe runs on its own schedule, whether or not anyone has the orb open
let probeLatencyMs = null;
setInterval(() => { agentStatus(true).catch(() => {}); }, PROBE_INTERVAL_S * 1000).unref();

async function handleHeartbeat(req, res) {
  let raw; try { raw = await readBody(req, HEARTBEAT_MAX_BODY, true); } catch { verifier.verify('', ''); return send(res, 400, { error: 'bad_request' }); }
  const v = verifier.verify(req.headers.authorization, raw);
  if (!v.ok) return send(res, v.status, { error: v.reason });
  const state = liveness.beat(v.agent, { status: v.status, progress: v.progress, skewS: v.skewS });
  send(res, 200, { ok: true, state, interval: LIVE_CFG.intervalS });
}
async function handleHeartbeatKeys(req, res, url) {
  if (req.method === 'GET') return send(res, 200, { keys: heartbeatKeys.list() });
  if (req.method === 'DELETE') {
    const agent = url.searchParams.get('agent') || '';
    if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Bad agent.' });
    const n = heartbeatKeys.revoke(agent); liveness.setPush(agent, false); statusAt = 0;
    return send(res, 200, { revoked: n });
  }
  let j; try { j = JSON.parse(await readBody(req, 1024)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(j.agent || '');
  if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Bad agent.' });
  const key = heartbeatKeys.issue(agent); liveness.setPush(agent, true); statusAt = 0;
  console.log(`[kira-orb] heartbeat key ${key.kid} issued for ${agent}`);
  send(res, 200, { agent, kid: key.kid, token: tokenFor(key), interval: LIVE_CFG.intervalS });   // the only time the secret is ever returned
}
function livenessReport() {
  return { config: LIVE_CFG, agents: liveness.snapshot(), transitions: liveness.history.slice(-50), alerts: alerts.recent.slice(-50),
    keys: heartbeatKeys.list(), rejected: Object.fromEntries(verifier.rejected) };
}
function metricsText() {
  const L = [], esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const help = (n, t, h) => L.push(`# HELP ${n} ${h}`, `# TYPE ${n} ${t}`);
  const snap = liveness.snapshot();
  help('orb_liveness_state', 'gauge', '1 for the agent\'s current liveness state');
  for (const a of snap) for (const st of ['UNKNOWN', 'HEALTHY', 'LATE', 'DEGRADED', 'STALLED', 'DOWN']) L.push(`orb_liveness_state{agent="${esc(a.agent)}",state="${st}"} ${a.state === st ? 1 : 0}`);
  help('orb_liveness_heartbeat_age_seconds', 'gauge', 'seconds since the last accepted heartbeat');
  for (const a of snap) if (a.heartbeatAgeS != null) L.push(`orb_liveness_heartbeat_age_seconds{agent="${esc(a.agent)}"} ${a.heartbeatAgeS}`);
  help('orb_liveness_transitions_total', 'counter', 'liveness transitions since the orb started');
  for (const [k, n] of transitionCounts) { const [a, f, t] = k.split('|'); L.push(`orb_liveness_transitions_total{agent="${esc(a)}",from="${f}",to="${t}"} ${n}`); }
  help('orb_heartbeats_accepted_total', 'counter', 'accepted heartbeats');
  for (const a of snap) L.push(`orb_heartbeats_accepted_total{agent="${esc(a.agent)}"} ${a.beats}`);
  help('orb_heartbeats_rejected_total', 'counter', 'rejected heartbeats by reason');
  for (const [r, n] of verifier.rejected) L.push(`orb_heartbeats_rejected_total{reason="${esc(r)}"} ${n}`);
  help('orb_heartbeat_clock_skew_seconds', 'gauge', 'server wall clock minus the sender timestamp on the last accepted beat');
  for (const a of snap) if (a.skewS != null) L.push(`orb_heartbeat_clock_skew_seconds{agent="${esc(a.agent)}"} ${a.skewS}`);
  help('orb_probe_ok', 'gauge', '1 if the last gateway probe listed the agent');
  for (const a of snap) if (a.probe != null) L.push(`orb_probe_ok{agent="${esc(a.agent)}"} ${a.probe ? 1 : 0}`);
  help('orb_probe_latency_ms', 'gauge', 'latency of the last gateway probe');
  if (probeLatencyMs != null) L.push(`orb_probe_latency_ms ${probeLatencyMs}`);
  help('orb_alerts_total', 'counter', 'alerts by severity, sink and result');
  for (const [k, n] of alerts.counts) { const [sev, sink, result] = k.split('|'); L.push(`orb_alerts_total{severity="${sev}",sink="${sink}",result="${result}"} ${n}`); }
  return L.join('\n') + '\n';
}
const bearerOk = req => !!METRICS_TOKEN && (req.headers.authorization || '') === `Bearer ${METRICS_TOKEN}`;

// Media the gateway serves (generated images, files): the browser fetches them through /api/media.
const MEDIA_RE = /^\/(?:api\/chat\/media\/|__openclaw__\/assistant-media)/;
const mediaUrl = u => (typeof u === 'string' && MEDIA_RE.test(u)) ? `/api/media?u=${encodeURIComponent(u)}` : (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// ---- orb colours picked in Settings (per agent id, shared by every device) ---------------------
const COLOR_FILE = path.join(STATE_DIR, 'colors.json');
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
let pickedColors = {};
try { pickedColors = JSON.parse(await readFile(COLOR_FILE, 'utf8')) || {}; } catch { /* none yet */ }
let colorSave = Promise.resolve();
function saveColors() {
  colorSave = colorSave.then(async () => {
    try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(COLOR_FILE + '.tmp', JSON.stringify(pickedColors, null, 1)); await rename(COLOR_FILE + '.tmp', COLOR_FILE); }
    catch (e) { console.warn('[kira-orb] could not save colours:', e.message); }
  });
}
// your own picture beside your messages in the chat (a small data: image, chosen in Settings)
const USER_FILE = path.join(STATE_DIR, 'user.json');
let userProfile = {};
try { userProfile = JSON.parse(await readFile(USER_FILE, 'utf8')) || {}; } catch { /* none yet */ }
async function handleUserIcon(req, res) {
  let j; try { j = JSON.parse(await readBody(req, 300 * 1024)); } catch { return send(res, 400, { error: 'Picture is too large or unreadable.' }); }
  const icon = j.icon == null ? null : String(j.icon);
  if (icon && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)) return send(res, 400, { error: 'Use a PNG, JPEG or WebP picture.' });
  if (icon) userProfile.icon = icon; else delete userProfile.icon;
  try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(USER_FILE + '.tmp', JSON.stringify(userProfile)); await rename(USER_FILE + '.tmp', USER_FILE); }
  catch (e) { console.warn('[kira-orb] could not save your icon:', e.message); }
  statusAt = 0;
  send(res, 200, { icon: userProfile.icon || null });
}
async function handleColors(req, res) {
  let j; try { j = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(j.agent || '');
  if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Bad agent.' });
  if (j.reset) delete pickedColors[agent];
  else {
    const color = j.color == null ? null : String(j.color), accent = j.accent == null ? null : String(j.accent);
    if ((color && !HEX_RE.test(color)) || (accent && !HEX_RE.test(accent))) return send(res, 400, { error: 'Colours must be #rrggbb.' });
    pickedColors[agent] = { ...(pickedColors[agent] || {}), ...(color ? { color } : {}), ...(accent ? { accent } : {}) };
  }
  saveColors(); statusAt = 0;
  send(res, 200, { agent, ...(pickedColors[agent] || {}) });
}
const SESSION_RE = /^[a-zA-Z0-9-]{8,64}$/;

// the version shown on the startup and shutdown screens: package.json's major.minor (1.15.0 → V1.15)
const KORA_VERSION = JSON.parse(await readFile(path.join(__dirname, 'package.json'), 'utf8')).version.split('.').slice(0, 2).join('.');
const SKELETON = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#06112b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
<script>window.__ORB_SERVER__ = true; window.__KORA_VERSION__ = ${JSON.stringify(KORA_VERSION)};</script>
</head><body>
`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self), geolocation=(self)',
};

async function handleLocation(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 8192)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(body.agent || DEFAULT_AGENT), session = String(body.session || '');
  if (!AGENT_RE.test(agent) || !SESSION_RE.test(session)) return send(res, 400, { error: 'Bad agent or session.' });
  const key = `${agent}:${session}`;
  if (req.method === 'DELETE') {
    sessionLocations.delete(key);
    locationAudits.push({ agent, session, action: 'revoked', consentVersion: LOCATION_CONSENT_VERSION, at: Date.now() });
    if (locationAudits.length > 1000) locationAudits.shift();
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  const now = Date.now();
  if (body.consentVersion !== LOCATION_CONSENT_VERSION) return send(res, 403, { error: 'Location consent is required or outdated.' });
  const recent = (locationWrites.get(key) || []).filter(at => now - at < LOCATION_RATE_WINDOW_MS);
  if (recent.length >= LOCATION_RATE_LIMIT) return send(res, 429, { error: 'Location updates are temporarily rate limited.' });
  recent.push(now); locationWrites.set(key, recent);
  const latitude = Number(body.latitude), longitude = Number(body.longitude), accuracy = Number(body.accuracy), capturedAt = Number(body.capturedAt);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000 || !Number.isFinite(capturedAt)) return send(res, 400, { error: 'Invalid location.' });
  if (capturedAt > now + 60 * 1000 || now - capturedAt > LOCATION_RETENTION_MS) return send(res, 400, { error: 'Location is stale.' });
  const expiresAt = now + LOCATION_RETENTION_MS;
  sessionLocations.set(key, { latitude, longitude, accuracy, capturedAt, source: 'browser', expiresAt });
  locationAudits.push({ agent, session, action: 'granted', consentVersion: LOCATION_CONSENT_VERSION, at: now, expiresAt });
  if (locationAudits.length > 1000) locationAudits.shift();
  return send(res, 200, { ok: true, source: 'browser', capturedAt, expiresAt });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024, raw = false) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(raw ? b : b.toString('utf8')); });
    req.on('error', reject);
  });
}

const upstreamHeaders = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

// ---- agent status ----------------------------------------------------------
// OpenClaw has no per-agent "online" flag on this API, so the orb judges it from what it can check:
// the gateway answers, the agent is in the gateway's agent list, and its last request didn't fail.
const failures = new Map();          // agentId -> { at, reason }
let statusCache = null, statusAt = 0;

const gatewayNames = new Map();     // agent id -> name OpenClaw gives it (agents.list)
const prettyName = id => LABELS[id] || gatewayNames.get(id) || id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

async function agentStatus(force = false) {
  if (!force && statusCache && Date.now() - statusAt < 5000) return statusCache;
  let gatewayIds = null, latencyMs = null, gatewayError = null;
  const t0 = Date.now();
  if (link?.ready) {
    // full-tools link is up: ask it directly (also works with the HTTP chat endpoint turned off)
    try {
      const j = await link.request('agents.list', {}, { timeoutMs: 6000 });
      latencyMs = Date.now() - t0;
      gatewayIds = (j.agents || []).map(a => String(a.id));
      for (const a of j.agents || []) {
        if (Array.isArray(a.thinkingOptions)) thinkingOptions.set(String(a.id), a.thinkingOptions.map(String));
        const nm = a.name || a.identity?.name || a.displayName;
        if (typeof nm === 'string' && nm.trim() && nm.length <= 40) gatewayNames.set(String(a.id), nm.trim()); else gatewayNames.delete(String(a.id));
      }
    } catch { /* fall through to HTTP */ }
  }
  if (!gatewayIds) try {
    const r = await fetch(`${OPENCLAW_URL}/v1/models`, { headers: upstreamHeaders(), signal: AbortSignal.timeout(6000) });
    latencyMs = Date.now() - t0;
    if (r.ok) {
      const j = await r.json();
      gatewayIds = (j.data || []).map(m => String(m.id))
        .filter(id => id.startsWith('openclaw/') && id !== 'openclaw/default')
        .map(id => id.slice('openclaw/'.length));
    } else {
      gatewayError = r.status === 404 ? 'Chat endpoint is turned off in OpenClaw' : r.status === 401 ? 'Gateway token rejected' : `Gateway returned ${r.status}`;
    }
  } catch (e) { gatewayError = 'Gateway unreachable'; }

  // Everyone we know about: what the gateway lists plus anyone named in the orb's settings,
  // so a deleted or stopped agent still shows up (greyed out) instead of vanishing.
  const known = new Set([...(gatewayIds || []), ...Object.keys(LABELS), ...Object.keys(COLORS), ...ALLOW, DEFAULT_AGENT]);
  let ids = [...known].filter(id => AGENT_RE.test(id));
  if (ALLOW.length) ids = ids.filter(id => ALLOW.includes(id));
  ids.sort((a, b) => (a === DEFAULT_AGENT ? -1 : b === DEFAULT_AGENT ? 1 : a.localeCompare(b)));

  probeLatencyMs = latencyMs;
  for (const id of ids) liveness.probe(id, !!gatewayIds && gatewayIds.includes(id));
  const [souls, voice] = await Promise.all([soulTitles(ids), voiceStatus(force)]);
  const agents = ids.map(id => {
    let online = true, reason = null;
    if (!gatewayIds) { online = false; reason = gatewayError; }
    else if (!gatewayIds.includes(id)) { online = false; reason = 'Not found in OpenClaw'; }
    // a failed request greys the agent out for a minute only, so one model hiccup can't lock the orb out
    else if (failures.has(id) && Date.now() - failures.get(id).at < 60000) { online = false; reason = failures.get(id).reason; }
    const lv = liveness.snapshot().find(x => x.agent === id) || { state: 'UNKNOWN', mode: 'probe', heartbeatAgeS: null };
    if (online && NOT_REACHABLE.has(lv.state)) { online = false; reason = lv.state === 'STALLED' ? (lv.heartbeatAgeS == null ? 'Stalled: no heartbeat yet' : `Stalled: no heartbeat for ${lv.heartbeatAgeS} s`) : 'Offline: missed heartbeats'; }
    return { id, liveness: { state: lv.state, mode: lv.mode, heartbeatAgeS: lv.heartbeatAgeS }, label: prettyName(id), title: souls[id] || TITLES[id] || null, color: pickedColors[id]?.color || COLORS[id] || null, accent: pickedColors[id]?.accent || null, online, reason,
      voice: agentHasVoice(id, voice), voiceSource: voiceLib.choice(id).source };
  });
  statusCache = { gateway: { online: !!gatewayIds, latencyMs, error: gatewayError }, link: linkStatus(), conversations, voice, user: { icon: userProfile.icon || null }, alerts: alerts.recent.slice(-20), agents, default: DEFAULT_AGENT, checkedAt: new Date().toISOString() };
  statusAt = Date.now();
  return statusCache;
}
const markFailed = (id, reason) => { failures.set(id, { at: Date.now(), reason }); statusAt = 0; };
const markOk = id => { if (failures.delete(id)) statusAt = 0; };

// ---- chat ----------------------------------------------------------------------------------------
// The browser gets one event stream per message (Server-Sent Events, one JSON object per line):
//   {type:'status', phase}            run is starting (preparing workspace, starting model…)
//   {type:'delta', text}              more reply text
//   {type:'tool', id, name, title, status}   a tool started/finished (status: running | completed | failed)
//   {type:'media', items:[{kind, url, name, mime, width, height}]}   images/files the agent produced
//   {type:'error', message}           the run failed
//   {type:'done', transport}          the reply is complete
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });
  let ended = false;
  const ping = setInterval(() => !ended && res.write(': ping\n\n'), 15000);   // keeps Caddy and phones from dropping a long tool run
  return {
    emit(o) { if (!ended) res.write(`data: ${JSON.stringify(o)}\n\n`); },
    end() { if (ended) return; ended = true; clearInterval(ping); res.end(); },
    get ended() { return ended; },
  };
}

async function readChatRequest(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req, 28 * 1024 * 1024)); }
  catch (e) { send(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'Attachments are too large (20 MB of images per message).' : 'Bad request body.' }); return null; }
  const agent = String(payload.agent || DEFAULT_AGENT);
  const session = String(payload.session || '');
  const text = String(payload.text || '').trim();
  // Images ride along with the message (up to 8, 20 MB in total).
  const images = Array.isArray(payload.images) ? payload.images.map(String) : [];
  const IMG_RE = /^data:image\/(png|jpeg|gif|webp|heic|heif);base64,[A-Za-z0-9+/=]+$/;
  const fail = (s, m) => { send(res, s, { error: m }); return null; };
  if (images.length > 8) return fail(400, 'Up to 8 images per message.');
  if (images.some(u => !IMG_RE.test(u))) return fail(400, 'Images must be PNG, JPEG, GIF, WebP or HEIC.');
  if (images.reduce((n, u) => n + u.length * 0.75, 0) > 20 * 1024 * 1024) return fail(413, 'Images add up to more than 20 MB. Send fewer or smaller ones.');
  if (!AGENT_RE.test(agent)) return fail(400, 'Unknown agent.');
  if (ALLOW.length && !ALLOW.includes(agent)) return fail(403, 'That agent is not enabled for the orb.');
  if (!SESSION_RE.test(session)) return fail(400, 'Missing conversation id.');
  if (!text || text.length > 250000) return fail(400, 'The message is empty or too long.');
  const names = Array.isArray(payload.imageNames) ? payload.imageNames.map(n => String(n).slice(0, 120)) : [];
  const speed = ['fast', 'balanced', 'thorough'].includes(payload.speed) ? payload.speed : 'thorough';
  return { agent, session, text, images, names, speed };
}

async function handleChat(req, res) {
  const msg = await readChatRequest(req, res);
  if (!msg) return;
  if (link?.ready) return chatOverLink(msg, req, res);
  return chatOverHttp(msg, req, res);
}

// Full tools: a normal chat turn over the gateway WebSocket, exactly like the OpenClaw Control UI.
// ---- response speed: how long the agent thinks before answering, per orb message ------------------
// Fast = the least thinking the agent's model allows, Balanced = light thinking, Thorough = the agent's
// own setting. Only messages sent from the orb are affected; OpenClaw's chat page, Slack etc. are not.
const thinkingOptions = new Map();   // agent id -> thinking levels its model accepts (from agents.list)
function thinkingFor(agent, speed) {
  if (speed === 'thorough') return undefined;
  const opts = thinkingOptions.get(agent);
  if (!opts?.length) return undefined;               // unknown: leave the agent's own setting
  const prefer = speed === 'fast' ? ['off', 'minimal', 'low'] : ['low', 'minimal', 'medium'];
  return prefer.find(l => opts.includes(l));
}

async function chatOverLink({ agent, session, text, images, names, speed }, req, res) {
  const sessionKey = sessionKeyFor(agent, session);
  let runId = crypto.randomUUID();
  rememberRun(runId);
  // one live reply per conversation: a new message stops the reply still in progress, so it starts a fresh turn
  const prev = sessionStreams.get(sessionKey);
  if (prev) { prev.handler('superseded', {}); abortRun(sessionKey, prev.runId); }
  await pendingAborts.get(sessionKey);
  const out = openStream(res);
  let otherRun = null;   // another run already working in this session (e.g. started from the OpenClaw page)
  let finished = false, streamed = '', sawText = false, expectMedia = false, firstTextAt = 0;
  const startedAt = Date.now();
  // The gateway reports reply text twice: as agent "assistant" events and as chat deltas. Use whichever
  // arrives first for this run and ignore the other, or every word would show (and be spoken) twice.
  let textSource = null;
  // Text can also be replaced, not just extended (a model's draft swapped for its final answer, for
  // example), so keep the whole reply here and send the browser either the new tail or a full reset.
  const segs = new Map();          // agent source: assistant item id -> its text (one paragraph block each)
  let chatText = '';               // chat source: current display text
  // Some model runtimes stream an answer and then publish the same answer again as a new item: keep one copy.
  const flat = t => t.replace(/\s+/g, ' ').trim();
  function currentText() {
    if (textSource === 'chat') return chatText;
    const kept = [];
    for (const t of segs.values()) {
      const f = flat(t); if (!f) continue;
      const i = kept.findIndex(k => flat(k).includes(f) || f.includes(flat(k)));
      if (i < 0) kept.push(t); else if (f.length > flat(kept[i]).length) kept[i] = t;
    }
    return kept.join('\n\n');
  }
  function push() {
    const next = currentText();
    if (next === streamed) return;
    if (!firstTextAt && next) firstTextAt = Date.now();
    if (next.startsWith(streamed)) out.emit({ type: 'delta', text: next.slice(streamed.length) });
    else out.emit({ type: 'reset', text: next });
    streamed = next; if (next) sawText = true;
  }
  const itemTools = new Set();     // tool calls reported by item events (they carry friendly titles)
  const toolsUsed = [];            // tool names, for the log

  const finish = async (kind, detail) => {
    if (finished) return; finished = true;
    if (sessionStreams.get(sessionKey)?.handler === onEvent) sessionStreams.delete(sessionKey);
    orbFinished.set(sessionKey, Date.now());
    if (kind === 'final') {
      markOk(agent);
      // Images and files the agent produced live in the transcript, with gateway media URLs. The transcript
      // also holds the reply text if none came through the live stream. It's written a moment after the
      // final event, so look a few times.
      let recovered = '', mediaCount = 0;
      const finalText = textOf(detail?.message);
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          if (attempt) await new Promise(r => setTimeout(r, 400));
          const h = await link.request('chat.history', { sessionKey, limit: 16 }, { timeoutMs: 8000 });
          const mine = (h?.messages || []).filter(m => (m.role === 'assistant' || m.role === 'toolResult') && m.__openclaw?.runId === runId);
          recovered = mine.filter(m => m.role === 'assistant').map(textOf).filter(Boolean).join('\n\n');
          const items = uniqueMedia(mine.flatMap(mediaOf));
          if (items.length) { mediaCount = items.length; if (!sawText && !streamed && (recovered || finalText)) out.emit({ type: 'delta', text: recovered || finalText }); out.emit({ type: 'media', items }); break; }
          if (!expectMedia && (sawText || streamed || recovered || finalText || attempt >= 3)) break;
        }
      } catch (e) { console.warn('[kira-orb] could not read the run from history:', e.message); }
      if (!mediaCount && !sawText && !streamed && (recovered || finalText)) out.emit({ type: 'delta', text: recovered || finalText });
      const toolNames = toolsUsed.join(', ');
      if (watchers.has(sessionKey)) subscribeMessages(sessionKey);
      console.log(`[kira-orb] ${agent} reply (${speed}${thinking ? ', thinking ' + thinking : ''}, ${((Date.now() - startedAt) / 1000).toFixed(1)} s, first text ${firstTextAt ? ((firstTextAt - startedAt) / 1000).toFixed(1) + ' s' : '–'}): ${streamed.length || (recovered || finalText).length} chars${streamed ? '' : recovered ? ' (from history)' : finalText ? ' (from final)' : ' (none)'}, tools: ${toolNames || 'none'}, media: ${mediaCount}`);
      out.emit({ type: 'done', transport: 'ws' });
    } else if (kind === 'error') {
      out.emit({ type: 'error', message: detail });
    } else {
      out.emit({ type: 'done', transport: 'ws', aborted: true });
    }
    out.end();
  };

  function onEvent(event, p) {
    if (event === 'superseded') return finish('aborted');
    if (event === 'link-closed') return finish('error', 'Lost the connection to OpenClaw while the agent was working. It may still finish: reopen the chat in a moment.');
    if (p.runId !== runId) {
      if (event === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'end') { if (otherRun === p.runId) otherRun = null; }
      else if (p.runId) otherRun = p.runId;
      return;
    }
    if (event === 'agent') {
      const d = p.data || {};
      if (p.stream === 'assistant') {
        if (Array.isArray(d.mediaUrls) && d.mediaUrls.length) expectMedia = true;
        if (textSource === 'chat') return;
        // each assistant item is one stretch of text (text, tool calls, more text…): one paragraph block each
        const id = d.itemId || '_', cur = segs.get(id) ?? '';
        let next = cur;
        if (d.replace === true && typeof d.text === 'string') next = d.text;          // full replacement
        else if (typeof d.delta === 'string' && d.delta) next = cur + d.delta;
        else if (typeof d.text === 'string' && d.text.startsWith(cur)) next = d.text;  // snapshot
        if (next !== cur) { textSource = 'agent'; segs.set(id, next); push(); }
      } else if (p.stream === 'item' && d.kind === 'tool') {
        const id = d.toolCallId || d.itemId;
        if (!itemTools.has(id)) toolsUsed.push(d.name);
        itemTools.add(id);
        out.emit({ type: 'tool', id, name: d.name, title: d.title || d.name, status: d.status || (d.phase === 'end' ? 'completed' : 'running') });
      } else if (p.stream === 'tool' && (d.phase === 'start' || d.phase === 'result') && d.toolCallId && !itemTools.has(d.toolCallId)) {
        // gateways without item events
        if (d.phase === 'start') toolsUsed.push(d.name);
        out.emit({ type: 'tool', id: d.toolCallId, name: d.name, title: d.name, status: d.phase === 'start' ? 'running' : d.isError ? 'failed' : 'completed' });
      }
      return;
    }
    if (event === 'chat') {
      if (p.state === 'status') out.emit({ type: 'status', phase: p.phase });
      else if (p.state === 'delta' && textSource !== 'agent') {
        // a snapshot message is authoritative; an empty replacement only marks a boundary
        const snap = p.message ? textOf(p.message) : null;
        let next = chatText;
        if (snap) next = snap;
        else if (p.replace) { if (p.deltaText) next = p.deltaText; }
        else if (p.deltaText) next = chatText + p.deltaText;
        if (next !== chatText) { textSource = 'chat'; chatText = next; push(); }
      }
      else if (p.state === 'final') {
        // the message was folded into a run that was already working: its answer arrives on that run
        if (!sawText && !streamed && !itemTools.size && !textOf(p.message) && otherRun) { runId = otherRun; rememberRun(runId); otherRun = null; sessionStreams.get(sessionKey).runId = runId; return; }
        if (textSource === 'chat' && textOf(p.message) && textOf(p.message) !== chatText) { chatText = textOf(p.message); push(); }
        finish('final', p);
      }
      else if (p.state === 'aborted') finish('aborted');
      else if (p.state === 'error') { finish('error', p.errorMessage || 'The agent run failed.'); }
    }
  }
  sessionStreams.set(sessionKey, { handler: onEvent, runId });

  res.on('close', () => {   // the user tapped the orb to interrupt → stop the agent run
    if (finished) return;
    finished = true;
    if (sessionStreams.get(sessionKey)?.handler === onEvent) sessionStreams.delete(sessionKey);
    abortRun(sessionKey, runId);
  });

  const attachments = images.map((url, i) => {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { type: 'image', mimeType: m[1], fileName: names[i] || `image-${i + 1}.${ext}`, content: m[2] };
  });
  const thinking = thinkingFor(agent, speed);
  const params = { sessionKey, message: text, deliver: false, idempotencyKey: runId, ...(thinking ? { thinking } : {}), ...(attachments.length ? { attachments } : {}) };
  if (attachments.length && JSON.stringify(params).length > (link.maxPayload || 25 * 1048576) * 0.95) return finish('error', 'Those images are too big to send in one message. Send fewer or smaller ones.');
  try {
    const ack = await link.request('chat.send', params, { timeoutMs: 120000 });
    if (ack?.status === 'error' || ack?.status === 'timeout') await finish('error', 'The agent could not start this message. Try again.');
  } catch (e) {
    console.warn('[kira-orb] chat.send failed:', e.message);
    if (!finished) await finish('error', `OpenClaw refused the message: ${e.message}`);
  }
  function textOf(message) {
    const c = message?.content;
    if (typeof c === 'string') return c;
    return Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n\n') : '';
  }
}

const uniqueMedia = items => { const seen = new Set(); return items.filter(i => !seen.has(i.url) && seen.add(i.url)); };
function mediaOf(message) {
  const items = [];
  for (const b of Array.isArray(message.content) ? message.content : []) {
    if (b?.type === 'image') {
      const url = mediaUrl(b.url || b.openUrl || b.source?.url);
      const data = b.source?.type === 'base64' && b.source.data ? `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` : null;
      if (url || data) items.push({ kind: 'image', url: url || data, open: mediaUrl(b.openUrl) || url || data, name: b.alt || b.fileName || 'image', mime: b.mimeType || null, width: b.width || null, height: b.height || null });
    } else if (b?.type === 'attachment' && b.attachment?.url) {
      const a = b.attachment, url = mediaUrl(a.url);
      if (url) items.push({ kind: a.kind || 'document', url, open: url, name: a.label || 'file', mime: a.mimeType || null, size: a.sizeBytes || null });
    }
  }
  return items;
}

// Fallback while the WebSocket link isn't available (e.g. waiting for device approval): OpenClaw's
// OpenAI-compatible endpoint. Text only, no tool activity or generated images in the stream.
async function chatOverHttp({ agent, session, text, images }, req, res) {
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // user tapped the orb to interrupt → cancel the agent run

  let upstream;
  try {
    upstream = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...upstreamHeaders(), 'x-openclaw-message-channel': 'orb' },
      body: JSON.stringify({
        model: `openclaw/${agent}`,
        user: `${SESSION_PREFIX}:${agent}:${session}`, // stable session per orb conversation
        stream: true,
        messages: [{ role: 'user', content: images.length          // OpenClaw keeps the history server-side
          ? [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
          : text }],
      }),
      signal: abort.signal,
    });
  } catch (e) {
    if (abort.signal.aborted) return;
    statusAt = 0;
    return send(res, 502, { error: `Can't reach OpenClaw at ${OPENCLAW_URL}. Is the gateway running and on the same network?` });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    if (upstream.status >= 401 && upstream.status !== 409) markFailed(agent, upstream.status >= 500 ? 'Model provider error' : `OpenClaw returned ${upstream.status}`);
    const hint = upstream.status === 404 ? ' Turn on gateway.http.endpoints.chatCompletions in the OpenClaw config.'
      : upstream.status === 401 ? ' Check OPENCLAW_TOKEN.' : '';
    return send(res, upstream.status === 401 ? 502 : upstream.status, { error: `OpenClaw returned ${upstream.status}.${hint}`, detail: detail.slice(0, 500) });
  }

  const out = openStream(res);
  let pending = '', sawContent = false;
  const dec = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      pending += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) { if (!sawContent) markFailed(agent, 'Last request failed'); out.emit({ type: 'error', message: j.error.message || 'The agent run failed.' }); continue; }
        const d = j.choices?.[0]?.delta?.content;
        if (d) { if (!sawContent) { sawContent = true; markOk(agent); } out.emit({ type: 'delta', text: d }); }
      }
    }
    out.emit({ type: 'done', transport: 'http' });
  } catch (e) {
    if (!abort.signal.aborted) out.emit({ type: 'error', message: 'The connection to OpenClaw dropped.' });
  }
  out.end();
}

// Live notice of turns the orb didn't start itself (e.g. a generated image arriving a minute later).
function handleWatch(req, res, url) {
  const agent = url.searchParams.get('agent') || '', session = url.searchParams.get('session') || '';
  if (!AGENT_RE.test(agent) || !SESSION_RE.test(session)) return send(res, 400, { error: 'Bad request.' });
  const key = sessionKeyFor(agent, session);
  const out = openStream(res);
  out.emit({ type: 'hello', live: !!link?.ready });
  if (!watchers.has(key)) { watchers.set(key, new Set()); subscribeMessages(key); }
  watchers.get(key).add(out);
  res.on('close', () => {
    out.end(); const set = watchers.get(key); set?.delete(out);
    if (set && !set.size) {
      watchers.delete(key);
      if (link?.ready) link.request('sessions.messages.unsubscribe', { key, subscriptionId: subId(key) }, { timeoutMs: 10000 }).catch(() => {});
    }
  });
}

// Earlier messages of this orb conversation (so the chat window survives a reload).
async function handleHistory(req, res, url) {
  const agent = url.searchParams.get('agent') || '', session = url.searchParams.get('session') || '';
  if (!AGENT_RE.test(agent) || !SESSION_RE.test(session)) return send(res, 400, { error: 'Bad request.' });
  if (!link?.ready) return send(res, 200, { messages: [], available: false });
  try {
    const h = await link.request('chat.history', { sessionKey: sessionKeyFor(agent, session), limit: 60 }, { timeoutMs: 10000 });
    const messages = [];
    const toolTitles = new Map();
    for (const a of h?.activity || []) for (const it of a.items || []) if (it.toolCallId) toolTitles.set(it.toolCallId, { title: it.title || it.name, status: it.status });
    for (const m of h?.messages || []) {
      const c = m.content;
      if (m.role === 'user') {
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
        const media = Array.isArray(c) ? mediaOf(m) : [];
        const files = (m.__openclaw?.media || []).map(x => x.fileName).filter(Boolean);
        if (text || media.length || files.length) messages.push({ role: 'user', text, media, files });
      } else if (m.role === 'toolResult') {
        const media = mediaOf(m), prev = messages.at(-1);
        if (media.length && prev?.role === 'agent') prev.media = uniqueMedia([...prev.media, ...media]);
      } else if (m.role === 'assistant') {
        const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
        const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n\n');
        // (a "MEDIA:/path" line is left in only while the gateway is still attaching that file)
        const tools = blocks.filter(b => b?.type === 'toolCall').map(b => ({ id: b.id, name: b.name, title: toolTitles.get(b.id)?.title || b.name, status: toolTitles.get(b.id)?.status || 'completed' }));
        const media = mediaOf(m);
        const prev = messages.at(-1);
        // one agent turn = consecutive assistant messages (tool calls, then the answer)
        const same = (a, b) => a.replace(/\s+/g, ' ').trim().includes(b.replace(/\s+/g, ' ').trim());
        if (prev?.role === 'agent') { if (text && !same(prev.text, text)) prev.text = prev.text && !same(text, prev.text) ? prev.text + '\n\n' + text : text; prev.tools.push(...tools); prev.media = uniqueMedia([...prev.media, ...media]); }
        else messages.push({ role: 'agent', text, tools, media });
      }
    }
    send(res, 200, { messages: messages.filter(m => m.text || m.media?.length || m.tools?.length), available: true });
  } catch (e) {
    send(res, 200, { messages: [], available: false, error: e.message });
  }
}

// Generated images and files, fetched from the gateway with the token (the browser never sees it).
async function handleMedia(req, res, url) {
  const u = url.searchParams.get('u') || '';
  if (!MEDIA_RE.test(u) || u.includes('..') || /[\r\n]/.test(u)) return send(res, 400, { error: 'Bad media address.' });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const r = await fetch(OPENCLAW_URL + u, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
    if (!r.ok || !r.body) return send(res, r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'That file is no longer available.' : `OpenClaw returned ${r.status}.` });
    const type = r.headers.get('content-type') || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', ...SECURITY_HEADERS };
    const len = r.headers.get('content-length'); if (len) headers['Content-Length'] = len;
    const disp = r.headers.get('content-disposition'); if (disp) headers['Content-Disposition'] = disp;
    // never let an HTML/SVG file run as a page on the orb's own address
    if (/html|svg|xml|javascript/i.test(type)) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Disposition'] = 'attachment'; }
    res.writeHead(200, headers);
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!abort.signal.aborted && !res.headersSent) send(res, 502, { error: "Can't reach OpenClaw for that file." });
  }
}

// ---- files for the agent: saved into its own workspace, in inbox/ ------------------------------
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
async function workspaceFor(id) {
  let dirs = [];
  try { dirs = (await readdir(OPENCLAW_DATA, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { return null; }
  return dirs.includes(`workspace-${id}`) ? `workspace-${id}` : id === DEFAULT_AGENT && dirs.includes('workspace') ? 'workspace' : null;
}
const safeName = n => {
  const base = path.basename(String(n || 'file')).normalize('NFKC').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120);
  return base || 'file';
};
async function handleUpload(req, res, url) {
  const agent = url.searchParams.get('agent') || '';
  if (!AGENT_RE.test(agent) || (ALLOW.length && !ALLOW.includes(agent))) return send(res, 400, { error: 'Unknown agent.' });
  const ws = await workspaceFor(agent);
  if (!ws) return send(res, 404, { error: `No workspace found for ${agent}. Is OpenClaw's data folder mounted into the orb?` });
  let body;
  try { body = await readBody(req, MAX_UPLOAD, true); }
  catch { return send(res, 413, { error: `Files are limited to ${MAX_UPLOAD / 1048576} MB.` }); }
  if (!body.length) return send(res, 400, { error: 'The file is empty.' });
  let name = safeName(url.searchParams.get('name'));
  const inbox = path.join(OPENCLAW_DATA, ws, 'inbox');
  try {
    await mkdir(inbox, { recursive: true });
    // never overwrite: report.pdf → report-2026-10-22T16-44-05.pdf if one already exists
    try { await stat(path.join(inbox, name)); const ext = path.extname(name); name = `${name.slice(0, name.length - ext.length)}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}${ext}`; } catch {}
    const target = path.join(inbox, name);
    if (!target.startsWith(inbox + path.sep)) return send(res, 400, { error: 'Bad file name.' });
    await writeFile(target, body, { flag: 'wx', mode: 0o644 });
  } catch (e) {
    console.error('[kira-orb] upload failed:', e.message);
    return send(res, 500, { error: e.code === 'EROFS' || e.code === 'EACCES' ? "The orb can't write to OpenClaw's data folder. Mount it read-write (see README)." : 'Could not save the file.' });
  }
  send(res, 200, { name, path: `inbox/${name}`, absolutePath: `/home/node/.openclaw/${ws}/inbox/${name}`, bytes: body.length });
}

async function handleTts(req, res) {
  if (!VOICE_URL) return send(res, 404, { error: 'No voice service configured.' });
  let payload;
  try { payload = JSON.parse(await readBody(req, 16 * 1024)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(payload.agent || ''), text = String(payload.text || '').trim();
  if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
  if (!text || text.length > 600) return send(res, 400, { error: 'Text must be 1 to 600 characters.' });
  // the agent's chosen voice, or (Voice Manager "Try") a voice it hasn't been given yet
  let voice;
  try { voice = payload.try ? VoiceLibrary.tryVoice(agent, payload.try) : voiceLib.ttsVoice(agent); } catch (e) { return send(res, 400, { error: e.message }); }
  if (!voice) return send(res, 409, { error: 'This agent is set to the browser voice.' });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const r = await fetch(`${VOICE_URL}/v1/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'pocket-tts', voice, input: text, response_format: 'wav' }),
      signal: abort.signal,
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return send(res, r.status, { error: j.detail || `Voice service returned ${r.status}.` }); }
    const audio = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(audio);
  } catch (e) {
    if (!abort.signal.aborted) send(res, 502, { error: 'Voice service unreachable.' });
  }
}

// ---- Voice Manager ------------------------------------------------------------------------------
function agentHasVoice(id, voice) {
  if (!voice.ready) return false;
  const c = voiceLib.choice(id);
  if (c.source === 'browser') return false;
  if (c.source === 'builtin') return true;
  return voice.voices.includes(id.toLowerCase());
}
async function voiceService(pathname, init = {}, timeoutMs = 5000) {
  if (!VOICE_URL) return { status: 0, error: 'No voice service configured.' };
  try {
    const r = await fetch(`${VOICE_URL}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const type = r.headers.get('content-type') || '';
    if (type.includes('json')) { const j = await r.json().catch(() => ({})); return { status: r.status, json: j, error: r.ok ? null : (typeof j.detail === 'string' ? j.detail : `Voice service returned ${r.status}.`) }; }
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type, error: r.ok ? null : `Voice service returned ${r.status}.` };
  } catch (e) { return { status: 0, error: e.name === 'TimeoutError' ? 'The voice service took too long.' : 'Voice service unreachable.' }; }
}
// Check (and analyse) a voice on the voice service now. ok: true/false, or null when it can't be checked yet.
async function prepareVoice(voice) {
  const r = await voiceService('/v1/voice-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice }) }, 90000);
  if (r.status === 200) return { ok: true, kind: r.json.kind, clipSeconds: r.json.clip_seconds };
  if (r.status === 404 && /Not Found/i.test(r.error || '')) return { ok: null, warning: 'Rebuild the voice service to check voices (docker compose up -d --build voice).' };
  if (r.status === 404 || r.status === 422 || r.status === 413 || r.status === 415) return { ok: false, error: r.error };
  return { ok: null, warning: r.status === 503 ? 'The voice model is still loading; the voice is checked on its first reply.' : r.error };
}
const FOLDER_HINT = "The voice service can't see the orb's voice folder. Mount data/voice-clips into both containers (README → Voice Manager).";
function voicesChanged() { statusAt = 0; voiceCache.at = 0; }

async function handleVoices(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);      // api, voices, …
  const sub = parts[2] || '', id = parts[3] || '';
  const json = async (limit = 8 * 1024) => JSON.parse(await readBody(req, limit));

  if (!sub && req.method === 'GET') {
    const v = await voiceService('/v1/voices');
    const info = await voiceStatus(true);
    const service = { enabled: !!VOICE_URL, ready: !!info.ready, error: info.error || null,
      managed: !!v.json?.builtin, builtin: v.json?.builtin || [], defaults: v.json?.defaults || [], custom: v.json?.custom || [], sharedFolder: v.json?.custom_dir ?? null };
    return send(res, 200, { policy: VOICE_POLICY, service, ...voiceLib.list() });
  }

  if (sub === 'clips' && !id && req.method === 'POST') {
    const agent = url.searchParams.get('agent') || '';
    if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
    let wav; try { wav = await readBody(req, VOICE_POLICY.maxBytes + 1024, true); } catch { return send(res, 413, { error: 'Voice clips must be under 10 MB.' }); }
    let added;
    try { added = await voiceLib.addClip(agent, wav, { name: url.searchParams.get('name'), origin: url.searchParams.get('origin') || 'upload' }); }
    catch (e) { return send(res, /EACCES|EROFS|EPERM/.test(e.code || '') ? 500 : 400, { error: /EACCES|EROFS|EPERM/.test(e.code || '') ? `The orb can't write to its voice folder (${VOICE_CLIPS_DIR}). On the VPS: mkdir -p data/voice-clips && chown 1000:1000 data/voice-clips` : e.message }); }
    const { clip } = added;
    // let the voice service judge it too (it trims silence, so a quiet clip can still come up short)
    const check = await prepareVoice(`clip:${clip.id}`);
    if (check.ok === false) {
      if (!/library|can't see/i.test(check.error || '')) { await voiceLib.deleteClip(clip.id); await voiceLib.save(); return send(res, 422, { error: check.error }); }
      check.warning = FOLDER_HINT;      // the clip is fine as far as the orb can tell; the folder isn't shared yet
    }
    let warning = check.warning || null;
    if (url.searchParams.get('activate') === '1') {
      const r = await selectVoice(agent, { source: 'custom', clipId: clip.id });
      if (r.error) warning = r.error; else warning = r.warning || warning;
    }
    await voiceLib.save(); voicesChanged();
    return send(res, 201, { clip: { ...clip, usedBy: voiceLib.usedBy(clip.id) }, warning, ...voiceLib.list() });
  }

  if (sub === 'clips' && id) {
    const clip = voiceLib.clip(id);
    if (!clip) return send(res, 404, { error: 'Voice clip not found.' });
    if (req.method === 'GET') {
      let audio; try { audio = await readFile(voiceLib.clipPath(id)); } catch { return send(res, 404, { error: 'The clip file is missing.' }); }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(audio);
    }
    if (req.method === 'PATCH') {
      let body; try { body = await json(); } catch { return send(res, 400, { error: 'Bad request body.' }); }
      voiceLib.renameClip(id, body.name); await voiceLib.save();
      return send(res, 200, voiceLib.list());
    }
    if (req.method === 'DELETE') {
      const agents = await voiceLib.deleteClip(id); await voiceLib.save(); voicesChanged();
      for (const a of agents) prepareVoice(a).catch(() => {});        // warm the default voice they went back to
      return send(res, 200, { reverted: agents, ...voiceLib.list() });
    }
  }

  if (sub === 'select' && req.method === 'POST') {
    let body; try { body = await json(); } catch { return send(res, 400, { error: 'Bad request body.' }); }
    const agent = String(body.agent || '');
    if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
    const r = await selectVoice(agent, { source: String(body.source || ''), clipId: body.clipId, builtin: body.builtin });
    await voiceLib.save(); voicesChanged();
    if (r.error) return send(res, r.status || 422, { error: r.error, ...voiceLib.list() });
    return send(res, 200, { warning: r.warning || null, ...voiceLib.list() });
  }

  if (sub === 'sample' && req.method === 'GET') {        // the repo's default clip for an agent, as the model hears it
    const agent = url.searchParams.get('agent') || '';
    if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
    const r = await voiceService('/v1/voice-sample?voice=' + encodeURIComponent(`default:${agent}`), {}, 30000);
    if (r.status !== 200 || !r.body) return send(res, r.status || 502, { error: r.error || 'No sample.' });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.body.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end(r.body);
  }
  return send(res, 405, { error: 'Method not allowed.' });
}

// Pick an agent's voice, check it on the voice service, and put the old one back if the service refuses it.
async function selectVoice(agent, choice) {
  let previous;
  try { previous = await voiceLib.select(agent, choice); } catch (e) { return { status: 400, error: e.message }; }
  if (choice.source === 'browser') return {};
  const check = await prepareVoice(voiceLib.ttsVoice(agent));
  const undo = async () => { try { await voiceLib.select(agent, previous); } catch {} };
  if (check.ok === false) {
    if (choice.source === 'default' && /No voice clip/i.test(check.error || '')) return { warning: 'This agent has no default clip in the repo, so it uses the browser voice.' };
    await undo(); return { error: check.error };
  }
  if (check.ok && choice.source === 'custom' && check.kind !== 'custom') { await undo(); return { error: FOLDER_HINT }; }
  return { warning: check.warning };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  try {
    let data = await readFile(file);
    const ext = path.extname(file);
    if (rel === 'index.html') data = Buffer.from(SKELETON + data.toString('utf8') + '\n</body></html>');
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': rel === 'index.html' ? 'no-store' : 'public, max-age=3600', ...SECURITY_HEADERS });
    res.end(data);
  } catch { send(res, 404, 'Not found', 'text/plain'); }
}

async function handleNotifications(req, res, url) {
  if (req.method === 'GET') return send(res, 200, { events: notifications.list({ severity: url.searchParams.get('severity') || undefined, unreadOnly: url.searchParams.get('unread') === 'true', status: url.searchParams.get('status') || undefined, limit: 100 }), metrics: notifications.metrics() });
  let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  if (req.method === 'POST') return send(res, 201, notifications.enqueue(body));
  if (req.method === 'PATCH') {
    if (body.action === 'read') return send(res, 200, { ok: notifications.markRead(String(body.id)) });
    if (body.action === 'action') return send(res, 200, { ok: notifications.setActionState(String(body.id), String(body.state || '')) });
    if (body.action === 'deliver') return send(res, 200, await notifications.deliver(String(body.id), { force: body.force === true }));
    return send(res, 400, { error: 'Unknown action.' });
  }
  return send(res, 405, { error: 'Method not allowed.' });
}
async function handleCommands(req, res, url) {
  if (req.method === 'GET') return send(res, 200, { commands: commands.search(url.searchParams.get('q') || '', 'operator') });
  let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  try { return send(res, 200, await commands.execute(String(body.id || ''), body.params || {}, { actor: 'operator', confirm: body.confirm === true, requestId: body.requestId })); }
  catch (error) { return send(res, error.message === 'unauthorized' ? 403 : 404, { error: error.message }); }
}

// ---- sign-in: one email + password, a signed session cookie ------------------------------------
const ORB_EMAIL = (process.env.ORB_EMAIL || '').trim().toLowerCase();
const ORB_PASSWORD = process.env.ORB_PASSWORD || '';
const AUTH_ON = !!(ORB_EMAIL && ORB_PASSWORD);
// Sessions are signed with SESSION_SECRET, or a key derived from the gateway token so they survive restarts.
const SESSION_KEY = crypto.createHash('sha256').update('kira-orb-session:' + (process.env.SESSION_SECRET || TOKEN || crypto.randomBytes(32).toString('hex'))).digest();
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
if (!AUTH_ON) console.warn('[kira-orb] ORB_EMAIL / ORB_PASSWORD not set: the sign-in page is OFF.');

const b64u = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');
const credStamp = () => crypto.createHash('sha256').update(ORB_EMAIL + '\0' + ORB_PASSWORD).digest('base64url').slice(0, 12); // changing the password signs everyone out
function makeSession() {
  const body = b64u(JSON.stringify({ e: ORB_EMAIL, x: Date.now() + SESSION_DAYS * 864e5, c: credStamp() }));
  return `${body}.${sign(body)}`;
}
function validSession(req) {
  const m = /(?:^|;\s*)orb_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return false;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  try { const j = JSON.parse(Buffer.from(body, 'base64url').toString()); return j.e === ORB_EMAIL && j.c === credStamp() && j.x > Date.now(); } catch { return false; }
}
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const attempts = new Map();   // ip -> [timestamps]: at most 5 failed sign-ins per 10 minutes
const tooMany = ip => (attempts.get(ip) || []).filter(t => Date.now() - t < 600000).length >= 5;
const cookie = (val, maxAge) => `orb_session=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function loginPage(error = '', email = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#06112b"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg">
<title>Sign in · K.O.R.A.</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>
:root{--void:#06112b;--hi:#0f2350;--lo:#020814;--panel:#0b1a38;--line:#1b3058;--ink:#e2ecf4;--dim:#8ea3c6;--arc:#ff3b4d;--alert:#ff8a8a;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-right)) 24px max(16px,env(safe-area-inset-left));
 background:radial-gradient(ellipse 70% 60% at 50% 40%,var(--hi),var(--void) 60%,var(--lo));color:var(--ink);font:15px/1.5 "IBM Plex Sans","Segoe UI",system-ui,sans-serif}
.card{width:min(380px,100%);display:grid;gap:18px}
.brand{text-align:center;display:grid;gap:8px;text-transform:uppercase;margin-bottom:6px}
.brand b{font:600 15px/1 "Chakra Petch","Segoe UI",sans-serif;letter-spacing:.5em;padding-left:.5em}
.brand span{font:500 10px/1 "Chakra Petch","Segoe UI",sans-serif;letter-spacing:.6em;padding-left:.6em;color:var(--dim)}
.ring{width:84px;height:84px;margin:4px auto 0;border-radius:50%;border:1px solid var(--arc);box-shadow:0 0 24px -6px var(--arc),inset 0 0 18px -8px var(--arc);
 background:radial-gradient(circle,rgba(255,59,77,.32),transparent 62%);animation:b 4s ease-in-out infinite}
@keyframes b{50%{box-shadow:0 0 34px -4px var(--arc),inset 0 0 24px -6px var(--arc)}}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
form{display:grid;gap:14px;background:rgba(11,26,56,.85);border:1px solid var(--line);border-radius:14px;padding:22px}
label{display:grid;gap:6px;font:500 11px/1 "Chakra Petch","Segoe UI",sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
input{font:15px "IBM Plex Sans",system-ui,sans-serif;color:var(--ink);background:var(--void);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-transform:none;letter-spacing:0}
input:focus{outline:none;border-color:var(--arc)}
button{font:600 13px/1 "Chakra Petch","Segoe UI",sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#fff;background:var(--arc);border:0;border-radius:10px;padding:14px;cursor:pointer}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.err{color:var(--alert);font-size:14px;margin:0;text-align:center}
.foot{text-align:center;color:var(--dim);font-size:12px;letter-spacing:.12em;text-transform:uppercase}
</style></head><body><main class="card">
<div class="brand"><b>Finnesey &amp; Kobler</b><span>The Model Shop</span><div class="ring" aria-hidden="true"></div></div>
<form method="post" action="/login">
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<label>Email<input type="email" name="email" autocomplete="username" required autofocus value="${esc(email)}"></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
<div class="foot">K.O.R.A. · Kobler Operational Robotic Agents</div>
</main></body></html>`;
}
async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS }); return res.end(loginPage('Too many attempts. Wait 10 minutes and try again.')); }
  let form;
  try { form = new URLSearchParams(await readBody(req, 4096)); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const email = String(form.get('email') || '').trim().toLowerCase(), pw = String(form.get('password') || '');
  const ok = sameText(email, ORB_EMAIL) & sameText(pw, ORB_PASSWORD);
  if (!ok) {
    attempts.set(ip, [...(attempts.get(ip) || []).filter(t => Date.now() - t < 600000), Date.now()]);
    console.warn(`[kira-orb] failed sign-in from ${ip}`);
    await new Promise(r => setTimeout(r, 600));
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end(loginPage("That email and password don't match.", email));
  }
  attempts.delete(ip);
  // land on /#startup so the startup sequence always plays after signing in
  res.writeHead(303, { Location: '/#startup', 'Set-Cookie': cookie(makeSession(), SESSION_DAYS * 86400), 'Cache-Control': 'no-store' });
  res.end();
}
const PUBLIC_PATHS = new Set(['/healthz', '/login', '/manifest.webmanifest', '/icon.svg']);

async function handlePreview(req,res,url){const input=url.searchParams.get('url')||'';const checked=validatePreview(input);if(!checked.ok)return send(res,400,{ok:false,error:checked.reason});const metadata=safeMetadata({'content-type':url.searchParams.get('mime')||''});return send(res,200,{ok:true,url:checked.url,kind:checked.kind,state:'loading',metadata,safe:true});}
async function handleInbox(req,res,url){const actor=url.searchParams.get('actor')||'*';if(req.method==='GET'){const after=url.searchParams.get('after');const events=inboxStore.list({actor,unreadOnly:url.searchParams.get('unread')==='true',includeArchived:url.searchParams.get('archived')==='true',query:url.searchParams.get('q')||'',limit:Math.min(200,Number(url.searchParams.get('limit')||100))});return send(res,200,{events:after?replay(events,{after,actor}):events,unread:inboxStore.unreadCount(actor)});}let body;try{body=JSON.parse(await readBody(req,64*1024));}catch{return send(res,400,{error:'Bad request body.'});}if(req.method==='POST'){return send(res,201,inboxStore.ingest(body));}if(req.method==='PATCH'){const id=String(body.id||'');if(!id)return send(res,400,{error:'Missing id.'});if(body.action==='acknowledge')inboxStore.acknowledge(id);else if(body.action==='archive')inboxStore.archive(id);else if(body.action==='read')inboxStore.markRead(id);else return send(res,400,{error:'Unknown action.'});return send(res,200,{ok:true,id,action:body.action});}return send(res,405,{error:'Method not allowed.'});}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/healthz') return send(res, 200, { ok: true });
    // agents' heartbeats authenticate with their own signed keys, not the sign-in cookie
    if (pathname === '/api/heartbeat' && req.method === 'POST') return await handleHeartbeat(req, res);
    if (pathname === '/metrics' && bearerOk(req)) return send(res, 200, metricsText(), 'text/plain; version=0.0.4');
    if (AUTH_ON) {
      if (pathname === '/login' && req.method === 'POST') return await handleLogin(req, res);
      if (pathname === '/login') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); return res.end(loginPage()); }
      if (pathname === '/logout') { res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie('', 0) }); return res.end(); }
      if (!PUBLIC_PATHS.has(pathname) && !validSession(req)) {
        if (pathname.startsWith('/api/')) return send(res, 401, { error: 'Signed out. Reload to sign in again.' });
        res.writeHead(303, { Location: '/login' }); return res.end();
      }
    }
    if (pathname === '/metrics' && req.method === 'GET') return send(res, 200, metricsText(), 'text/plain; version=0.0.4');
    if (pathname === '/api/liveness' && req.method === 'GET') return send(res, 200, livenessReport());
    if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, await healthRegistry.snapshot());
    if (pathname === '/api/notifications') return await handleNotifications(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/commands') return await handleCommands(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/voice/state' && req.method === 'GET') return send(res, 200, voiceState.snapshot());
    if (pathname === '/api/preview' && req.method === 'GET') return await handlePreview(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/inbox') return await handleInbox(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/heartbeat/keys') return await handleHeartbeatKeys(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/presence' && req.method === 'GET') { const status = await agentStatus(new URL(req.url, 'http://x').searchParams.has('refresh')); return send(res, 200, { revision: status.checkedAt, agents: status.agents.map(a => ({ ...a, presence: { state: a.online ? (a.liveness?.state === 'HEALTHY' ? 'online' : 'stale') : 'offline', available: a.online, reason: a.reason } })) }); }
    if (pathname === '/api/agents' && req.method === 'GET') return send(res, 200, await agentStatus(new URL(req.url, 'http://x').searchParams.has('refresh')));
    if (pathname === '/api/location' && ['POST', 'DELETE'].includes(req.method)) return await handleLocation(req, res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res);
    if (pathname === '/api/voices' || pathname.startsWith('/api/voices/')) return await handleVoices(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/upload' && req.method === 'POST') return await handleUpload(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/conversation' && req.method === 'POST') return await handleConversation(req, res);
    if (pathname === '/api/colors' && req.method === 'POST') return await handleColors(req, res);
    if (pathname === '/api/user-icon' && req.method === 'POST') return await handleUserIcon(req, res);
    if (pathname === '/api/watch' && req.method === 'GET') return handleWatch(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/history' && req.method === 'GET') return await handleHistory(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/media' && req.method === 'GET') return await handleMedia(req, res, new URL(req.url, 'http://x'));
    if (pathname === '/api/voice/state' && req.method === 'PATCH') { let body; try { body = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { error: 'Bad request body.' }); } try { return send(res, 200, voiceState.transition(String(body.action || ''))); } catch (error) { return send(res, 400, { error: error.message }); } }
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    console.error('[kira-orb]', e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong in the orb relay.' }); else res.end();
  }
}).listen(PORT, () => {
  console.log(`[kira-orb] listening on :${PORT} → ${OPENCLAW_URL}${link ? '' : ' (HTTP chat only)'}`);
  link?.start();
});
