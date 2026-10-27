import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VOICE_POLICY = Object.freeze({ formats: ['wav', 'mp3'], minSeconds: 10, maxSeconds: 15, maxBytes: 10 * 1024 * 1024, retentionDays: 30 });

export class VoiceProfiles {
  constructor(file) { this.file = file; this.data = { profiles: {}, history: [] }; }
  async load() { try { this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8')) }; } catch {} return this; }
  async save() { await mkdir(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; await writeFile(tmp, JSON.stringify(this.data, null, 2)); await rename(tmp, this.file); }
  prune(now = Date.now()) { const cutoff = now - VOICE_POLICY.retentionDays * 864e5; this.data.history = this.data.history.filter(x => Date.parse(x.createdAt) >= cutoff); }
  list() { const out = {}; for (const [agent, p] of Object.entries(this.data.profiles)) out[agent] = { ...p, effectiveSource: p.local ? 'local' : p.imported ? 'imported' : null }; return out; }
  upsert(agent, source, clip, now = new Date()) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent)) throw new Error('Invalid agent.');
    if (!['local', 'imported'].includes(source)) throw new Error('Source must be local or imported.');
    const ext = String(clip.extension || '').replace(/^\./, '').toLowerCase();
    if (!VOICE_POLICY.formats.includes(ext)) throw new Error('Voice clips must be .wav or .mp3.');
    if (!Number.isFinite(clip.bytes) || clip.bytes < 1 || clip.bytes > VOICE_POLICY.maxBytes) throw new Error('Voice clip exceeds the 10 MB limit.');
    if (!Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 10 || clip.durationSeconds > 15) throw new Error('Voice clips must be 10–15 seconds.');
    const p = this.data.profiles[agent] || {};
    this.data.history.push({ agent, source, clip: p[source] || null, createdAt: now.toISOString() });
    p[source] = { ...clip, extension: ext, createdAt: now.toISOString(), active: source === 'local' || !p.local };
    this.data.profiles[agent] = p; this.prune(now.getTime()); return this.list()[agent];
  }
  action(agent, action) {
    const p = this.data.profiles[agent]; if (!p) throw new Error('Voice profile not found.');
    if (action === 'reset') delete p.local;
    else if (action === 'rollback') { const prior = [...this.data.history].reverse().find(x => x.agent === agent && x.clip); if (!prior) throw new Error('No retained voice version to roll back to.'); p[prior.source] = prior.clip; }
    else if (action !== 'activate') throw new Error('Unknown voice action.');
    this.data.profiles[agent] = p; return this.list()[agent];
  }
}
