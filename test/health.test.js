import assert from 'node:assert/strict';import {HealthRegistry,redact} from '../health.js';
assert.equal(redact({token:'abc',nested:{password:'xyz'},safe:'ok'}).token,'[REDACTED]');
const h=new HealthRegistry({timeoutMs:20});h.register('ok',async()=>({status:'ok',evidence:{url:'http://gateway'}})).register('bad',async()=>{throw new Error('unreachable')}).register('slow',()=>new Promise(r=>setTimeout(r,40)));
const s=await h.snapshot();assert.equal(s.version,1);assert.equal(s.state,'unknown');assert.equal(s.collectors.length,3);assert.equal(s.collectors.find(x=>x.name==='slow').status,'degraded');console.log('health tests: 3 passed');
