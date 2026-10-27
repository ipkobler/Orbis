import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from '../command-palette.js';

test('command registry hides unauthorized commands and requires confirmation', async () => {
  const audit = []; const registry = new CommandRegistry({ authorize: (actor, command, action) => action !== 'execute' || command.allow?.includes(actor), audit: event => audit.push(event) });
  registry.register({ id: 'health.snapshot', title: 'Health snapshot', handler: async () => ({ ok: true }), allow: ['operator'] });
  registry.register({ id: 'deploy.run', title: 'Deploy', destructive: true, handler: async () => 'deployed', allow: ['operator'] });
  assert.equal(registry.search('deploy', 'guest').length, 1);
  assert.equal((await registry.execute('deploy.run', {}, { actor: 'operator' })).status, 'confirmation_required');
  assert.equal((await registry.execute('deploy.run', {}, { actor: 'operator', confirm: true })).status, 'completed'); assert.equal(audit.length, 1);
  await assert.rejects(() => registry.execute('health.snapshot', {}, { actor: 'guest' }), /unauthorized/);
});

test('command failures are actionable results', async () => {
  const registry = new CommandRegistry(); registry.register({ id: 'broken.task', title: 'Broken', handler: async () => { throw Error('offline'); } });
  assert.deepEqual((await registry.execute('broken.task')).status, 'failed');
});
