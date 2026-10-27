import crypto from 'node:crypto';
export const EVENT_VERSION=1;
export function createEvent(input={}){
 const now=input.createdAt||new Date().toISOString(), payload=input.payload??{};
 return Object.freeze({version:EVENT_VERSION,id:input.id||crypto.randomUUID(),type:String(input.type||'agent.update'),actor:input.actor||{id:'system',role:'system'},createdAt:now,correlationId:input.correlationId||crypto.randomUUID(),idempotencyKey:input.idempotencyKey||crypto.createHash('sha256').update(JSON.stringify([input.type,payload,now])).digest('hex'),payload,permissions:input.permissions||{read:['*'],act:[]},source:input.source||'gateway'});
}
export function validateEvent(e){return !!e&&e.version===EVENT_VERSION&&typeof e.id==='string'&&typeof e.type==='string'&&typeof e.createdAt==='string'&&typeof e.correlationId==='string'&&typeof e.idempotencyKey==='string'&&e.payload!==undefined&&e.permissions&&Array.isArray(e.permissions.read);}