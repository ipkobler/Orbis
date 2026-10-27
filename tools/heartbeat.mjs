#!/usr/bin/env node
// Reference heartbeat sender for the K.I.B.I. orb (docs/heartbeat.md). No dependencies; Node 18+.
//
//   HEARTBEAT_TOKEN=obk_xxxxxxxx_... AGENT=forge ORB_URL=http://kira-orb:8080 node tools/heartbeat.mjs
//   ... node tools/heartbeat.mjs --once        # send one beat, exit 0 if accepted
//
// Optional: STATUS_FILE=/path/status.json — whatever runs the agent's work can write {"status":"busy","progress":12}
// there; the sender reports it, so an agent that is busy but not progressing is detected as STALLED.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ORB_URL = (process.env.ORB_URL || 'http://kira-orb:8080').replace(/\/+$/, '');
const AGENT = process.env.AGENT || '';
const m = /^obk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/.exec((process.env.HEARTBEAT_TOKEN || '').trim());
if (!AGENT || !m) { console.error('Set AGENT=<agent id> and HEARTBEAT_TOKEN=obk_... (from the orb: Settings → Heartbeat monitoring)'); process.exit(2); }
const [, kid, secret] = m;
const once = process.argv.includes('--once');
let interval = Number(process.env.INTERVAL_S) || 30;

async function readStatus() {
  if (!process.env.STATUS_FILE) return {};
  try { const j = JSON.parse(await readFile(process.env.STATUS_FILE, 'utf8')); return { status: j.status === 'busy' ? 'busy' : 'idle', progress: Number.isFinite(j.progress) ? j.progress : undefined }; }
  catch { return {}; }
}

async function beat() {
  const body = JSON.stringify({ agent: AGENT, ts: Date.now(), nonce: crypto.randomBytes(12).toString('hex'), ...(await readStatus()) });
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url');
  const r = await fetch(`${ORB_URL}/api/heartbeat`, { method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `OrbHMAC kid=${kid}, sig=${sig}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  if (j.interval) interval = j.interval;
  return j.state;
}

if (once) {
  try { console.log(`accepted · ${AGENT} is ${await beat()}`); process.exit(0); }
  catch (e) { console.error(`rejected · ${e.message}${e.message === 'clock_skew' ? ' (fix this machine’s clock: it must be within 60 s of the orb server)' : ''}`); process.exit(1); }
}
let failures = 0;
for (;;) {
  try { const st = await beat(); if (failures) console.log(`heartbeat back · ${AGENT} is ${st}`); failures = 0; }
  catch (e) {
    failures++;
    console.error(`heartbeat failed (${failures}) · ${e.message}`);
    if (e.status === 401 && e.message !== 'clock_skew') { console.error('The key was rejected (revoked or rotated?). Stopping.'); process.exit(1); }
  }
  // a little jitter so many senders don't line up; never slower than the interval the orb expects
  await new Promise(res => setTimeout(res, interval * 1000 * (0.85 + Math.random() * 0.15)));
}
