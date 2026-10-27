// Snapshot/replay state for reconnect-safe presence updates.
export class PresenceStream {
  constructor(){this.revision=0;this.entries=new Map();this.seen=new Set();}
  snapshot(entries=[]){this.entries=new Map(entries.map(e=>[String(e.id),e]));this.revision++;this.seen.clear();return this.value();}
  apply(event){const id=String(event.id||'');const rev=Number(event.revision||0);if(!id||!rev||this.seen.has(rev))return {accepted:false,reason:'duplicate',...this.value()};if(rev<=this.revision)return {accepted:false,reason:'stale',...this.value()};this.seen.add(rev);this.revision=rev;if(event.type==='remove')this.entries.delete(id);else this.entries.set(id,{...this.entries.get(id),...event.agent,id});return {accepted:true,...this.value()};}
  value(){return {revision:this.revision,agents:[...this.entries.values()]};}
}
