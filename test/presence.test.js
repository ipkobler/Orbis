import assert from 'node:assert/strict';
import {normalizePresence,normalizeRoster} from '../presence.js';
assert.equal(normalizePresence({gatewayOnline:true,liveness:'HEALTHY'}).state,'online');
assert.equal(normalizePresence({gatewayOnline:true,liveness:'HEALTHY',active:true}).state,'busy');
assert.equal(normalizePresence({gatewayOnline:true,liveness:'LATE'}).state,'stale');
assert.equal(normalizePresence({gatewayOnline:false,liveness:'HEALTHY'}).state,'offline');
assert.equal(normalizeRoster([{id:'kirk',gatewayOnline:true,liveness:{state:'HEALTHY'}}])[0].presence.state,'online');
console.log('presence tests: 5 passed');
