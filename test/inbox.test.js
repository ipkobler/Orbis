import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createEvent,validateEvent} from '../event-envelope.js';
import {InboxStore} from '../inbox-store.js';
import {actionLink,replay} from '../inbox-query.js';
const file='state/test-inbox.json';try{fs.unlinkSync(file);}catch{}
const s=new InboxStore(file);
const e=createEvent({type:'approval.requested',payload:{actionUrl:'/approve/1'},permissions:{read:['*'],act:['operator']},idempotencyKey:'k1',createdAt:'2026-01-01T00:00:00.000Z'});
assert.equal(validateEvent(e),true);assert.equal(s.ingest(e).duplicate,false);assert.equal(s.ingest(e).duplicate,true);
assert.equal(s.unreadCount('operator'),1);assert.equal(s.list({actor:'operator',query:'approval'}).length,1);
assert.equal(actionLink(e,'operator'),'/approve/1');assert.equal(actionLink(e,'guest'),null);
s.acknowledge(e.id);assert.equal(s.unreadCount('operator'),0);s.archive(e.id);assert.equal(s.list({actor:'operator'}).length,0);
const a=createEvent({idempotencyKey:'a',createdAt:'2026-01-01T00:00:01.000Z'});const b=createEvent({idempotencyKey:'b',createdAt:'2026-01-01T00:00:02.000Z'});assert.deepEqual(replay([b,a],{after:'2026-01-01T00:00:00.500Z'}).map(x=>x.id),[a.id,b.id]);
console.log('inbox tests: 12 passed');