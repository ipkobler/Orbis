import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';

const port = 8097;
const secret = 'endpoint-test-secret';
const email = 'test@example.com';
const password = 'pass';
const stateDir = `state/endpoint-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), STATE_DIR: stateDir, ORB_EMAIL: email, ORB_PASSWORD: password, SESSION_SECRET: secret, OPENCLAW_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = new Promise(resolve => child.once('exit', resolve));
await wait(700);
const body = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 86400000, c: crypto.createHash('sha256').update(email + '\0' + password).digest('base64url').slice(0, 12) })).toString('base64url');
const cookie = 'orb_session=' + body + '.' + crypto.createHmac('sha256', crypto.createHash('sha256').update('kira-orb-session:' + secret).digest()).update(body).digest('base64url');

try {
  let r = await fetch('http://127.0.0.1:' + port + '/api/preview?url=' + encodeURIComponent('https://example.com'), { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);

  r = await fetch('http://127.0.0.1:' + port + '/api/inbox?actor=operator', { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).events));

  r = await fetch('http://127.0.0.1:' + port + '/api/inbox', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'task.update', payload: { text: 'smoke' }, permissions: { read: ['*'], act: [] }, idempotencyKey: 'smoke-' + Date.now() }) });
  assert.equal(r.status, 201);
  const created = await r.json();
  assert.equal(created.duplicate, false);

  r = await fetch('http://127.0.0.1:' + port + '/api/inbox', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: created.event.id, action: 'acknowledge' }) });
  assert.equal(r.status, 200);
  console.log('endpoint smoke: preview + inbox passed');
} finally {
  child.kill();
  await exited;
  await rm(stateDir, { recursive: true, force: true });
}
