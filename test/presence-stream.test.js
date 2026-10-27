import assert from 'node:assert/strict';
import {PresenceStream} from '../presence-stream.js';
const s=new PresenceStream();
assert.equal(s.snapshot([{id:'kirk',state:'online'}]).revision,1);
assert.equal(s.apply({revision:2,type:'update',id:'forge',agent:{state:'busy'}}).accepted,true);
assert.equal(s.apply({revision:2,type:'update',id:'forge',agent:{state:'busy'}}).reason,'duplicate');
assert.equal(s.apply({revision:1,type:'update',id:'ledger',agent:{state:'offline'}}).reason,'stale');
assert.equal(s.apply({revision:3,type:'remove',id:'forge'}).agents.some(a=>a.id==='forge'),false);
console.log('presence stream tests: 5 passed');
