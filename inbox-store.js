import fs from 'node:fs';import path from 'node:path';import {createEvent} from './event-envelope.js';
export class InboxStore{
 constructor(file='state/inbox.json',{retentionDays=30}={}){this.file=file;this.retentionDays=retentionDays;this.state={events:[],read:[],archived:[],acknowledged:[]};this.load();}
 load(){try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{}}
 persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const t=this.file+'.tmp';fs.writeFileSync(t,JSON.stringify(this.state,null,2));fs.renameSync(t,this.file);}
 ingest(input){const e=createEvent(input),old=this.state.events.find(x=>x.idempotencyKey===e.idempotencyKey);if(old)return {event:old,duplicate:true};this.state.events.push(e);this.persist();return {event:e,duplicate:false};}
 list({actor='*',unreadOnly=false,includeArchived=false,query='',limit=100}={}){const q=String(query).toLowerCase();return this.state.events.filter(e=>(includeArchived||!this.state.archived.includes(e.id))&&(e.permissions.read.includes('*')||e.permissions.read.includes(actor))&&(!unreadOnly||!this.state.read.includes(e.id))&&(!q||JSON.stringify(e).toLowerCase().includes(q))).slice(-limit).reverse();}
 markRead(id){if(!this.state.read.includes(id))this.state.read.push(id);this.persist();return true;}
 acknowledge(id){if(!this.state.acknowledged.includes(id))this.state.acknowledged.push(id);return this.markRead(id);}
 archive(id){if(this.state.events.some(e=>e.id===id)&&!this.state.archived.includes(id))this.state.archived.push(id);this.persist();return true;}
 unreadCount(actor='*'){return this.list({actor,unreadOnly:true}).length;}
 prune(now=Date.now()){const cut=now-this.retentionDays*86400000;this.state.events=this.state.events.filter(e=>Date.parse(e.createdAt)>=cut);this.persist();}
}