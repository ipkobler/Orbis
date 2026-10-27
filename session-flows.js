export function authorize(session,tenant){return !!session&&session.meta?.tenant===tenant;}
export function provenance(message,source){return {...message,provenance:{source:String(source),recordedAt:new Date().toISOString()}};}
export function recall(messages,tenant){return messages.filter(m=>authorize({meta:{tenant}},tenant)&&m.provenance?.source).map(m=>({text:m.text,source:m.provenance.source}));}
export function retention(sessions,maxAgeMs,now=Date.now()){return sessions.filter(s=>now-Date.parse(s.updatedAt)<=maxAgeMs);}
