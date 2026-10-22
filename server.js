// Kira Orb — tiny relay between the browser and the OpenClaw gateway.
// Zero dependencies (Node 22+). The gateway token never leaves this container.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 8080);
const OPENCLAW_URL = (process.env.OPENCLAW_URL || 'http://openclaw-gateway:18789').replace(/\/+$/, '');
const TOKEN = process.env.OPENCLAW_TOKEN || '';
const DEFAULT_AGENT = process.env.DEFAULT_AGENT || 'main';
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
// Chatterbox Nano voice service (optional). Blank = the orb uses browser voices only.
const VOICE_URL = (process.env.VOICE_URL || '').replace(/\/+$/, '');

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

const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SESSION_RE = /^[a-zA-Z0-9-]{8,64}$/;

const SKELETON = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#061227">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
<script>window.__ORB_SERVER__ = true;</script>
</head><body>
`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self)',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const upstreamHeaders = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

// ---- agent status ----------------------------------------------------------
// OpenClaw has no per-agent "online" flag on this API, so the orb judges it from what it can check:
// the gateway answers, the agent is in the gateway's agent list, and its last request didn't fail.
const failures = new Map();          // agentId -> { at, reason }
let statusCache = null, statusAt = 0;

const prettyName = id => LABELS[id] || id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

async function agentStatus(force = false) {
  if (!force && statusCache && Date.now() - statusAt < 5000) return statusCache;
  let gatewayIds = null, latencyMs = null, gatewayError = null;
  const t0 = Date.now();
  try {
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

  const [souls, voice] = await Promise.all([soulTitles(ids), voiceStatus(force)]);
  const agents = ids.map(id => {
    let online = true, reason = null;
    if (!gatewayIds) { online = false; reason = gatewayError; }
    else if (!gatewayIds.includes(id)) { online = false; reason = 'Not found in OpenClaw'; }
    else if (failures.has(id)) { online = false; reason = failures.get(id).reason; }
    return { id, label: prettyName(id), title: souls[id] || TITLES[id] || null, color: COLORS[id] || null, online, reason,
      voice: voice.ready && voice.voices.includes(id) };
  });
  statusCache = { gateway: { online: !!gatewayIds, latencyMs, error: gatewayError }, voice, agents, default: DEFAULT_AGENT, checkedAt: new Date().toISOString() };
  statusAt = Date.now();
  return statusCache;
}
const markFailed = (id, reason) => { failures.set(id, { at: Date.now(), reason }); statusAt = 0; };
const markOk = id => { if (failures.delete(id)) statusAt = 0; };

async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(payload.agent || DEFAULT_AGENT);
  const session = String(payload.session || '');
  const text = String(payload.text || '').trim();
  if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
  if (ALLOW.length && !ALLOW.includes(agent)) return send(res, 403, { error: 'That agent is not enabled for the orb.' });
  if (!SESSION_RE.test(session)) return send(res, 400, { error: 'Missing conversation id.' });
  if (!text || text.length > 8000) return send(res, 400, { error: 'Say something between 1 and 8000 characters.' });

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
        messages: [{ role: 'user', content: text }],      // OpenClaw keeps the history server-side
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });
  const stream = Readable.fromWeb(upstream.body);
  let sawContent = false;
  stream.on('data', chunk => {
    const s = chunk.toString('utf8');
    if (!sawContent && s.includes('"content"')) { sawContent = true; markOk(agent); }
    if (s.includes('"error"') && !sawContent) markFailed(agent, 'Last request failed');
  });
  stream.on('error', () => res.end()).pipe(res);
}

async function handleTts(req, res) {
  if (!VOICE_URL) return send(res, 404, { error: 'No voice service configured.' });
  let payload;
  try { payload = JSON.parse(await readBody(req, 16 * 1024)); } catch { return send(res, 400, { error: 'Bad request body.' }); }
  const agent = String(payload.agent || ''), text = String(payload.text || '').trim();
  if (!AGENT_RE.test(agent)) return send(res, 400, { error: 'Unknown agent.' });
  if (!text || text.length > 600) return send(res, 400, { error: 'Text must be 1 to 600 characters.' });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const r = await fetch(`${VOICE_URL}/v1/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'chatterbox-nano', voice: agent, input: text, response_format: 'wav' }),
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

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/healthz') return send(res, 200, { ok: true });
    if (pathname === '/api/agents' && req.method === 'GET') return send(res, 200, await agentStatus(new URL(req.url, 'http://x').searchParams.has('refresh')));
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res);
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    console.error('[kira-orb]', e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong in the orb relay.' }); else res.end();
  }
}).listen(PORT, () => console.log(`[kira-orb] listening on :${PORT} → ${OPENCLAW_URL}`));
