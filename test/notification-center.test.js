import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotificationCenter } from '../notification-center.js';

test('notifications persist, deduplicate, retry, and expose metrics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orb-notifications-')); const file = path.join(dir, 'events.json'); let attempts = 0;
  const center = new NotificationCenter({ file, send: async () => { attempts++; if (attempts < 2) throw Error('temporary'); } });
  const first = center.enqueue({ idempotencyKey: 'same', title: 'Build', message: 'Ready', channels: ['inbox'] });
  assert.equal(center.enqueue({ idempotencyKey: 'same' }).duplicate, true);
  assert.equal((await center.deliver(first.event.id)).status, 'retry');
  assert.equal((await center.deliver(first.event.id)).status, 'delivered');
  assert.equal(center.metrics().delivered, 1); assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
  const restored = await new NotificationCenter({ file }).load(); assert.equal(restored.list()[0].id, first.event.id);
});

test('quiet hours defer delivery unless forced', async () => {
  const center = new NotificationCenter({ quietHours: ['00:00', '23:59'], now: () => new Date('2026-01-01T12:00:00Z').getTime(), send: async () => { throw Error('must not send'); } });
  const event = center.enqueue({ message: 'quiet' }).event; assert.equal((await center.deliver(event.id)).status, 'quiet');
  assert.equal((await center.deliver(event.id, { force: true })).status, 'retry');
});
