// Voice Manager: the voice each agent speaks with, and a library of uploaded / recorded voice clips.
//
// Each agent has one choice:
//   default  the agent's clip in the Orbis repo (voices/<agent>.mp3), or the browser voice if there is none
//   custom   one of the clips in the library (uploaded or recorded in the orb)
//   builtin  one of Pocket TTS's built-in voices (alba, marius, jane …)
//   browser  the browser's own speech voice (picked per device in Settings)
//
// Clips live in VOICE_CLIPS_DIR/library/<id>.wav (mono 16-bit WAV, made by the browser, checked here). The clip an agent
// uses is copied to VOICE_CLIPS_DIR/<agent>.wav, which the voice service reads before the repo's clips. Picking any
// other source removes that copy. Choices and clip details are kept in voice-library.json in the orb's state folder.
import crypto from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VOICE_POLICY = Object.freeze({
  formats: ['wav'],            // what the server stores; the browser converts anything it can play (mp3, m4a, ogg, webm…)
  minSeconds: 5, maxSeconds: 15, maxBytes: 10 * 1024 * 1024,
  maxClipsPerAgent: 12,        // the oldest unused clip is removed when an agent goes past this
  sources: ['default', 'custom', 'builtin', 'browser'],
});
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^[a-f0-9]{12}$/;
const BUILTIN_RE = /^[a-z0-9_]{1,40}$/;

/** Read a PCM WAV header. Returns { sampleRate, channels, bits, dataOffset, dataBytes, durationSeconds }. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('That isn’t a WAV file.');
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Damaged WAV header.');
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('Damaged WAV header.');
      if (![1, 0xfffe].includes(fmt.format) || fmt.bits !== 16) throw new Error('Voice clips must be 16-bit PCM WAV.');
      if (fmt.channels < 1 || fmt.channels > 2 || fmt.sampleRate < 8000 || fmt.sampleRate > 96000) throw new Error('Unsupported WAV format.');
      const dataBytes = Math.min(size, buf.length - body);
      return { ...fmt, dataOffset: body, dataBytes, durationSeconds: dataBytes / (fmt.sampleRate * fmt.channels * 2) };
    }
    off = body + size + (size & 1);
  }
  throw new Error('Damaged WAV file (no audio data).');
}

/** A clean 44-byte-header WAV with at most `seconds` of audio. */
export function cleanWav(buf, info, seconds) {
  const frame = info.channels * 2;
  let bytes = Math.min(info.dataBytes, Math.floor(seconds * info.sampleRate) * frame);
  bytes -= bytes % frame;
  const out = Buffer.alloc(44 + bytes);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + bytes, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(info.channels, 22);
  out.writeUInt32LE(info.sampleRate, 24); out.writeUInt32LE(info.sampleRate * frame, 28); out.writeUInt16LE(frame, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(bytes, 40);
  buf.copy(out, 44, info.dataOffset, info.dataOffset + bytes);
  return out;
}

const cleanName = (s, fallback) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;

export class VoiceLibrary {
  /** @param {{ file: string, dir: string }} o  file: the JSON state; dir: VOICE_CLIPS_DIR */
  constructor({ file, dir }) {
    this.file = file; this.dir = dir; this.libDir = path.join(dir, 'library');
    this.data = { version: 2, agents: {}, clips: [] };
  }
  async load() {
    try { const j = JSON.parse(await readFile(this.file, 'utf8')); if (j && j.version === 2) this.data = { ...this.data, ...j }; } catch {}
    return this;
  }
  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`; await writeFile(tmp, JSON.stringify(this.data, null, 2)); await rename(tmp, this.file);
  }

  choice(agent) { return this.data.agents[agent] || { source: 'default' }; }
  clip(id) { return this.data.clips.find(c => c.id === id) || null; }
  clipPath(id) { if (!ID_RE.test(id)) throw new Error('Bad clip id.'); return path.join(this.libDir, `${id}.wav`); }
  usedBy(id) { return Object.entries(this.data.agents).filter(([, c]) => c.source === 'custom' && c.clipId === id).map(([a]) => a); }
  list() { return { agents: { ...this.data.agents }, clips: this.data.clips.map(c => ({ ...c, usedBy: this.usedBy(c.id) })) }; }

  /** The voice name to send to the voice service for this agent (null = the browser speaks). */
  ttsVoice(agent) {
    const c = this.choice(agent);
    if (c.source === 'browser') return null;
    if (c.source === 'builtin') return `builtin:${c.builtin}`;
    return agent;                                  // custom (the copy in VOICE_CLIPS_DIR) or the repo's default clip
  }
  /** Voice name for trying a voice before picking it. */
  static tryVoice(agent, { source, clipId, builtin } = {}) {
    if (source === 'custom') { if (!ID_RE.test(String(clipId))) throw new Error('Bad clip id.'); return `clip:${clipId}`; }
    if (source === 'builtin') { if (!BUILTIN_RE.test(String(builtin))) throw new Error('Unknown built-in voice.'); return `builtin:${builtin}`; }
    if (source === 'default') return `default:${agent}`;
    throw new Error('Unknown voice source.');
  }

  /** Store a WAV clip for an agent. Longer than maxSeconds is trimmed; shorter than minSeconds is refused. */
  async addClip(agent, wav, { name, origin = 'upload', now = new Date() } = {}) {
    if (!AGENT_RE.test(agent)) throw new Error('Unknown agent.');
    if (!Buffer.isBuffer(wav) || !wav.length) throw new Error('No audio received.');
    if (wav.length > VOICE_POLICY.maxBytes) throw new Error('Voice clips must be under 10 MB.');
    const info = parseWav(wav);
    if (info.durationSeconds < VOICE_POLICY.minSeconds) throw new Error(`That clip is ${info.durationSeconds.toFixed(1)} s. Voice clips need at least ${VOICE_POLICY.minSeconds} seconds of speech.`);
    const out = cleanWav(wav, info, VOICE_POLICY.maxSeconds);
    const durationSeconds = Math.round(Math.min(info.durationSeconds, VOICE_POLICY.maxSeconds) * 100) / 100;
    const id = crypto.randomBytes(6).toString('hex');
    await mkdir(this.libDir, { recursive: true });
    await writeFile(this.clipPath(id), out, { mode: 0o644 });
    const n = this.data.clips.filter(c => c.agent === agent).length + 1;
    const clip = { id, agent, name: cleanName(name, `${origin === 'recording' ? 'Recording' : 'Upload'} ${n}`), origin: origin === 'recording' ? 'recording' : 'upload',
      durationSeconds, bytes: out.length, sampleRate: info.sampleRate, createdAt: now.toISOString() };
    this.data.clips.push(clip);
    // keep the library tidy: past the limit, the oldest clip this agent isn't using goes
    const mine = this.data.clips.filter(c => c.agent === agent);
    let extra = mine.length - VOICE_POLICY.maxClipsPerAgent;
    const removed = [];
    for (const old of mine) {
      if (extra <= 0) break;
      if (old.id === id || this.usedBy(old.id).length) continue;
      await this.deleteClip(old.id); removed.push(old.id); extra--;
    }
    return { clip, removed };
  }

  renameClip(id, name) {
    const c = this.clip(id); if (!c) throw new Error('Voice clip not found.');
    c.name = cleanName(name, c.name); return c;
  }

  /** Delete a clip. Agents that were using it go back to their default voice. Returns those agents. */
  async deleteClip(id) {
    const c = this.clip(id); if (!c) throw new Error('Voice clip not found.');
    const agents = this.usedBy(id);
    for (const a of agents) await this.select(a, { source: 'default' });
    this.data.clips = this.data.clips.filter(x => x.id !== id);
    await rm(this.clipPath(id), { force: true });
    return agents;
  }

  /** Pick the voice an agent speaks with. Returns the previous choice (so a failed check can put it back). */
  async select(agent, { source, clipId, builtin } = {}) {
    if (!AGENT_RE.test(agent)) throw new Error('Unknown agent.');
    if (!VOICE_POLICY.sources.includes(source)) throw new Error('Unknown voice source.');
    const previous = this.choice(agent);
    let next;
    if (source === 'custom') {
      const c = this.clip(String(clipId)); if (!c) throw new Error('Voice clip not found.');
      next = { source, clipId: c.id };
    } else if (source === 'builtin') {
      if (!BUILTIN_RE.test(String(builtin))) throw new Error('Unknown built-in voice.');
      next = { source, builtin: String(builtin) };
    } else next = { source };
    await this.#applyFile(agent, next);
    if (source === 'default') delete this.data.agents[agent]; else this.data.agents[agent] = { ...next, at: new Date().toISOString() };
    return previous;
  }

  async #applyFile(agent, choice) {
    const active = path.join(this.dir, `${agent}.wav`);
    if (choice.source === 'custom') {
      await mkdir(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `.${agent}.wav.tmp`);
      await copyFile(this.clipPath(choice.clipId), tmp);
      await rename(tmp, active);                    // atomic: the voice service never reads half a file
    } else await rm(active, { force: true });
  }

  /** Make the files on disk match the saved choices (after a restart, or if someone cleaned the folder). */
  async sync() {
    for (const [agent, c] of Object.entries(this.data.agents)) {
      if (c.source === 'custom' && !this.clip(c.clipId)) { delete this.data.agents[agent]; await this.#applyFile(agent, { source: 'default' }); continue; }
      try { await this.#applyFile(agent, c); } catch (e) { console.warn(`[kira-orb] voice for ${agent}: ${e.message}`); }
    }
  }
}
